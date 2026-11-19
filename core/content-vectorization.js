import { acquireLease } from './leases.js';
import { vhLog } from '../utils/log.js';
/**
 * ============================================================================
 * VECTHARE CONTENT VECTORIZATION
 * ============================================================================
 * Unified vectorization handler for all content types.
 * Uses the same pipeline infrastructure, just with type-appropriate settings.
 *
 * @author Coneja Chibi
 * @version 2.2.0-alpha
 * ============================================================================
 */

import { getContentType, getContentTypeDefaults, hasFeature, LIVE_CHAT_STRATEGIES } from './content-types.js';
import { chunkText } from './chunking.js';
import { DEFAULT_CHUNK_SIZE, DEFAULT_CHUNK_OVERLAP } from './constants.js';
import { insertVectorItems, getSavedHashes, purgeVectorIndex } from './core-vector-api.js';
import {
    setCollectionMeta, getCollectionMeta, getDefaultDecayForType,
    canRecordInitialVectorizationConfig, createInitialVectorizationConfig,
    saveInitialVectorizationConfig,
    requireCollectionOperationSettings, resolveCollectionOperationSettings,
    snapshotCollectionOperationSettings,
    assertCollectionOperationSettingsStable,
} from './collection-metadata.js';
import { registerCollection } from './collection-loader.js';
import { getBackend } from '../backends/backend-manager.js';
// Import from collection-ids.js - single source of truth for collection ID operations
import {
    buildChatCollectionId,
    ensureChatBinding,
    recordChatStore,
    beginChatCollectionWrite,
    endChatCollectionWrite,
    withChatCollectionPurgeGuard,
    buildLorebookCollectionId,
    buildCharacterCollectionId,
    buildDocumentCollectionId,
    COLLECTION_PREFIXES,
} from './collection-ids.js';
import { extractLorebookKeywords, extractTextKeywords, extractChatKeywords, extractBM25Keywords, EXTRACTION_LEVELS, DEFAULT_EXTRACTION_LEVEL, DEFAULT_BASE_WEIGHT } from './keyword-boost.js';
import { cleanText, cleanMessages } from './text-cleaning.js';
import { progressTracker, describeEffectiveSettings } from '../ui/progress-tracker.js';
import { extension_settings, getContext } from '../../../../extensions.js';
import { getStringHash } from '../../../../utils.js';

/** The same effective Content Vectorizer options are used by insertion and pre-purge checks. */
export function getContentVectorizerChunkingConfig(contentType, settings) {
    const type = getContentType(contentType);
    if (!type) throw new Error(`Unknown content type: ${contentType}`);
    const chunkOptions = {
        strategy: settings.strategy || type.defaultStrategy,
        chunkSize: settings.chunkSize || type.defaults.chunkSize,
        chunkOverlap: settings.chunkOverlap || type.defaults.chunkOverlap,
        conversationTurnOrder: settings.conversation_turn_order || 'user_character',
    };
    return {
        pipeline: 'content-vectorizer', contentType, ...chunkOptions,
        chunkSize: chunkOptions.chunkSize === undefined ? DEFAULT_CHUNK_SIZE : chunkOptions.chunkSize,
        chunkOverlap: chunkOptions.chunkOverlap === undefined ? DEFAULT_CHUNK_OVERLAP : chunkOptions.chunkOverlap,
        batchSize: 4,
        ...(contentType === 'character' ? {
            fields: settings.fields || getContentTypeDefaults('character').fields,
        } : {}),
        keywordLevel: settings.keywordLevel || 'balanced',
        keywordBaseWeight: settings.keywordBaseWeight || 1.5,
    };
}

/**
 * Main entry point for content vectorization
 * @param {object} params - Vectorization parameters
 * @param {string} params.contentType - Content type ID
 * @param {object} params.source - Source data
 * @param {object} params.settings - Type-specific settings
 * @returns {Promise<{success: boolean, chunkCount: number, collectionId: string}>}
 */
export async function vectorizeContent({ contentType, source, settings }) {
    settings = snapshotCollectionOperationSettings(settings);
    let vecthareSettings = snapshotCollectionOperationSettings(extension_settings.vecthare);
    const type = getContentType(contentType);
    if (!type) {
        throw new Error(`Unknown content type: ${contentType}`);
    }

    // C14: the live chat may only be written by the Sync pipeline, whose ledger
    // tracks every record. 'adaptive' and 'per_scene' bypass it and used to put
    // un-ledgered records into the chat's own collection (or create it with a
    // saved config Sync cannot use), so they are refused for the live chat.
    // Uploaded transcripts keep every strategy.
    if (contentType === 'chat' && source?.type === 'current' &&
        !LIVE_CHAT_STRATEGIES.includes(settings.strategy || type.defaultStrategy)) {
        throw new Error(`The "${settings.strategy || type.defaultStrategy}" strategy cannot be used on the ` +
            'live chat because Sync Chat could not track those records. Choose Per Message, ' +
            'Conversation Turns or Message Batch, or upload the chat as a transcript to use this strategy.');
    }

    // A live chat must use precisely the same text/hash/group/UID pipeline as
    // Sync Chat and Repair. Uploaded chat transcripts are NOT the live chat;
    // they keep their independent Content Vectorizer pipeline and provenance.
    if (contentType === 'chat' && source.type === 'current' &&
        LIVE_CHAT_STRATEGIES.includes(settings.strategy || type.defaultStrategy)) {
        if (source.content !== getContext()?.chat) {
            throw new Error('The selected chat changed; live chat vectorization cancelled');
        }
        const liveSettings = snapshotCollectionOperationSettings(vecthareSettings);
        liveSettings.chunking_strategy = settings.strategy || type.defaultStrategy;
        liveSettings.conversation_turn_order = settings.conversation_turn_order || 'user_character';
        liveSettings.keyword_extraction_level = settings.keywordLevel || liveSettings.keyword_extraction_level;
        if (liveSettings.chunking_strategy === 'message_batch') {
            liveSettings.batch_size = settings.batchSize || liveSettings.batch_size || 4;
        }
        // N2: before a new collection is created, offer a deleted copy's memories.
        if (settings.rebuildChatCollection !== true) {
            const { offerDeletedChatReattach } = await import('./chat-vectorization.js');
            await offerDeletedChatReattach(vecthareSettings);
        }
        const binding = await ensureChatBinding();
        if (!binding?.writable || !binding.collectionId || source.content !== getContext()?.chat) {
            throw new Error('The selected chat identity changed; live chat vectorization cancelled');
        }
        // A confirmed rebuild writes and verifies a REPLACEMENT collection and
        // only then switches this chat to it. Nothing is purged first, and a
        // failure leaves the existing collection in use.
        if (settings.rebuildChatCollection === true) {
            const { rebuildChatCollection } = await import('./chat-vectorization.js');
            const { getSyncBatchSize } = await import('./chat-vectorization.js');
            const rebuild = await rebuildChatCollection(liveSettings, getSyncBatchSize(liveSettings));
            if (!rebuild.success) throw new Error(rebuild.reason || 'The rebuild did not complete.');
            if (source.content !== getContext()?.chat || String(source.id) !== String(getContext()?.chatId)) {
                // The vectors and the binding are already committed and
                // verified; only the Content Vectorizer's own notes are skipped.
                return { ...rebuild, handledBySyncChat: true, rebuilt: true,
                    chunkCount: rebuild.chunkCount };
            }
            const carried = new Set(rebuild.carriedFields || []);
            setCollectionMeta(rebuild.collectionId, {
                contentType,
                sourceName: source.name || source.filename || source.id || contentType,
                scope: settings.scope || 'global',
                ...(Number.isSafeInteger(rebuild.chunkCount) ? { chunkCount: rebuild.chunkCount } : {}),
                createdAt: new Date().toISOString(),
                settings: {
                    strategy: settings.strategy,
                    conversation_turn_order: settings.conversation_turn_order,
                    chunkSize: settings.chunkSize,
                },
                // A carried-over decay preference is the user's; don't reset it.
                ...(carried.has('temporalDecay') ? {} : {
                    temporalDecay: settings.temporalDecay || getDefaultDecayForType(contentType),
                }),
            });
            return { ...rebuild, handledBySyncChat: true, rebuilt: true,
                chunkCount: rebuild.chunkCount };
        }

        const { vectorizeAll, getSyncBatchSize } = await import('./chat-vectorization.js');
        const result = await vectorizeAll(liveSettings, getSyncBatchSize(liveSettings), true);
        if (!result?.success) throw new Error('Live chat Sync was stopped or could not complete');
        if (source.content !== getContext()?.chat || String(source.id) !== String(getContext()?.chatId)) {
            throw new Error('The selected chat changed; collection metadata was not updated');
        }
        // Sync owns vectors and the ledger. Preserve Content Vectorizer's
        // existing VectHare-only collection metadata for this selected chat.
        const previousMeta = getCollectionMeta(binding.collectionId);
        setCollectionMeta(binding.collectionId, {
            contentType,
            sourceName: source.name || source.filename || source.id || contentType,
            scope: settings.scope || 'global',
            ...(Number.isSafeInteger(result.indexedChunkCount) ? { chunkCount: result.indexedChunkCount } : {}),
            createdAt: previousMeta.createdAt || new Date().toISOString(),
            settings: {
                strategy: settings.strategy,
                conversation_turn_order: settings.conversation_turn_order,
                chunkSize: settings.chunkSize,
            },
            temporalDecay: settings.temporalDecay || getDefaultDecayForType(contentType),
        });
        return { ...result, collectionId: binding.collectionId, handledBySyncChat: true };
    }

    const sourceName = source.name || source.filename || source.id || contentType;
    let initialConfig;
    const panelRunId = progressTracker.show(`Vectorizing ${type.label || contentType}`, 4, 'Steps');
    progressTracker.setRunSettings(
        describeEffectiveSettings(vecthareSettings, { 'Content': type.label || contentType }),
        'as selected for this run');
    progressTracker.updateCurrentItem(sourceName);

    try {
        // #8: only the LIVE chat belongs in this chat's own collection, where
        // Content Vectorizer shares Sync Chat's identity. An uploaded or pasted
        // transcript is separate content and gets its own collection, so it can
        // never be mistaken for this chat's vectors by Sync, Repair or RAG.
        const liveChatSource = contentType === 'chat' && source.type === 'current';
        const chatBinding = liveChatSource ? await ensureChatBinding() : null;
        if (liveChatSource && !chatBinding?.writable) {
            throw new Error('Chat collection identity could not be verified; vectorization cancelled');
        }
        const collectionId = liveChatSource
            ? chatBinding.collectionId
            : generateCollectionId(contentType, source, settings);
        // The collection's own saved preparation settings take precedence over
        // the current Content Vectorizer controls. They are operation-local.
        const resolved = await resolveCollectionOperationSettings(collectionId, vecthareSettings,
            'content-vectorizer', getContentVectorizerChunkingConfig(contentType, settings), { allowNew: true });
        vecthareSettings = resolved.settings;
        if (vecthareSettings.__collectionCleaningPatterns) {
            settings.__collectionCleaningPatterns = vecthareSettings.__collectionCleaningPatterns;
        }
        if (resolved.status === 'compatible') {
            for (const key of ['strategy', 'chunkSize', 'chunkOverlap', 'fields', 'keywordLevel', 'keywordBaseWeight']) {
                if (resolved.chunking[key] !== undefined) settings[key] = resolved.chunking[key];
            }
            if (resolved.chunking.conversationTurnOrder !== undefined) {
                settings.conversation_turn_order = resolved.chunking.conversationTurnOrder;
            }
        }
        initialConfig = createInitialVectorizationConfig(vecthareSettings,
            getContentVectorizerChunkingConfig(contentType, settings));

        // Step 1: Resolve source
        progressTracker.updateProgress(1, 'Loading content...');
        const rawContent = await resolveSource(contentType, source);

        // Keep the original chunkText options unchanged; record effective
        // defaults separately so this metadata change cannot change chunks.
        const chunkOptions = {
            strategy: settings.strategy || type.defaultStrategy,
            chunkSize: settings.chunkSize || type.defaults.chunkSize,
            chunkOverlap: settings.chunkOverlap || type.defaults.chunkOverlap,
            conversationTurnOrder: settings.conversation_turn_order || 'user_character',
        };
        // Step 2: Prepare and chunk
        progressTracker.updateProgress(2, 'Chunking content...');
        const preparedContent = await prepareContent(contentType, rawContent, settings);
        const chunks = await chunkText(preparedContent.text || preparedContent, chunkOptions);

        if (chunks.length === 0) {
            throw new Error('No chunks generated from content');
        }

        // Log chunking results for debugging
        const chunkLengths = chunks.map(c => (typeof c === 'string' ? c : c.text || '').length);
        const maxChunkLen = Math.max(...chunkLengths);
        const avgChunkLen = Math.round(chunkLengths.reduce((a, b) => a + b, 0) / chunkLengths.length);
        vhLog(`VectHare: Chunked "${sourceName}" into ${chunks.length} chunks (avg: ${avgChunkLen} chars, max: ${maxChunkLen} chars)`);

        progressTracker.updateChunks(chunks.length);

        // Step 3: Enrich and hash
        progressTracker.updateProgress(3, 'Processing chunks...');
        // Get full extension settings for keyword extraction (includes custom_stopwords)
        const enrichedChunks = enrichChunks(chunks, contentType, source, settings, preparedContent, vecthareSettings);
        const hashedChunks = enrichedChunks.map(chunk => ({
            ...chunk,
            hash: getStringHash(chunk.text),
        }));

        assertCollectionOperationSettingsStable(initialConfig, vecthareSettings, initialConfig?.chunking);
        // Validate the original collection configuration before any embedding
        // or database write; first-time collections are allowed when empty.
        await requireCollectionOperationSettings(collectionId, vecthareSettings, 'content-vectorizer', {
            ...initialConfig?.chunking,
            pipeline: 'content-vectorizer',
        }, { allowNew: true });

        // Record the existing Content Vectorizer source/strategy only in the
        // outgoing chunk. Never modify SillyTavern source messages or chat files.
        for (const chunk of hashedChunks) {
            chunk.__vecthareProvenanceHint = {
                writer: 'content-vectorizer', sourceType: contentType,
                groupingStrategy: chunk.metadata?.strategy || chunkOptions.strategy,
            };
        }

        // Step 4: Insert into vector store (streaming: embed + write together)
        progressTracker.stats.embeddingBasePercent = Math.round(3 / progressTracker.stats.totalItems * 100);
        progressTracker.updateProgress(3, 'Embedding and saving chunks...');

        // Ensure backend is initialized and healthy before attempting inserts.
        // Some backends (LanceDB/Qdrant) require initialization which may fail
        // if attempted lazily during insert; pre-initializing reduces first-run failures.
        try {
            await getBackend(vecthareSettings);
        } catch (e) {
            console.warn('VectHare: Backend initialization failed before insert, will still attempt insert:', e.message);
            try {
                progressTracker.addError(`Backend init failed: ${e.message}`);
            } catch (_) {}
            try {
                toastr.error('Backend initialization failed: ' + e.message, 'VectHare');
            } catch (_) {}
        }

        // An existing collection without a snapshot is legacy/unknown, not new.
        // A failed read must not block vectorization or imply an empty collection.
        let initiallyEmpty = false;
        if (canRecordInitialVectorizationConfig(collectionId, vecthareSettings)) {
            try {
                initiallyEmpty = (await getSavedHashes(collectionId, vecthareSettings)).length === 0;
            } catch (error) {
                console.warn('VectHare: Could not verify first vectorization settings:', error);
            }
        }

        // The callback runs after each successfully-written batch. Keep its
        // persistence promise so partial success also records first settings.
        let initialConfigSave = null;
        const recordFirstWrite = () => {
            if (initiallyEmpty && !initialConfigSave) {
                initialConfigSave = saveInitialVectorizationConfig(collectionId, initialConfig, vecthareSettings)
                    .then(success => {
                        if (success) setCollectionMeta(collectionId, { verifiedPurgeDestination: null });
                        return success;
                    });
            }
        };

        // 8C: one tab/device at a time writes into this collection.
        const contentLease = await acquireLease(collectionId, { label: 'Content Vectorizer' });
        try {
            if (liveChatSource) {
                // #9: the chat can change while content is prepared and embedded.
                // Re-verify the live chat's identity immediately before the write
                // rather than trusting the binding resolved minutes earlier.
                const current = await ensureChatBinding();
                if (!current?.writable || current.collectionId !== collectionId ||
                    source.content !== getContext()?.chat) {
                    throw new Error('The selected chat changed; nothing was written');
                }
                beginChatCollectionWrite(collectionId);
            }
            try {
                if (liveChatSource) recordChatStore(collectionId, vecthareSettings);
                await insertVectorItems(collectionId, hashedChunks, vecthareSettings, (embedded, total) => {
            // Insert progress is reported after a successful backend write. Record
            // the original settings even if a later batch fails or is stopped.
            if (embedded > 0) recordFirstWrite();
            // Update progress with streaming count
            vhLog(`[Content Vectorization] Processing progress callback: ${embedded}/${total}`);
            progressTracker.updateEmbeddingProgress(embedded, total);

            // Streaming approach: embedding and writing happen together
            progressTracker.updateCurrentItem(`Processing: ${embedded}/${total} chunks (${total - embedded} remaining)`);
                });
            } finally {
                if (liveChatSource) endChatCollectionWrite(collectionId);
            }
        } catch (error) {
            if (initialConfigSave) await initialConfigSave;
            // Surface insert errors to the UI so users see why vectorization may have failed
            console.error('VectHare: insertVectorItems failed', error);
            try {
                progressTracker.addError(error.message || String(error));
            } catch (_) {}
            try {
                toastr.error('Failed to write embeddings: ' + (error.message || String(error)), 'VectHare');
            } catch (_) {}
            // Re-throw so outer handler records completion state and any callers can react
            throw error;
        } finally {
            await contentLease.release();
        }

        // Also cover backends that return success without a progress callback.
        if (initiallyEmpty) {
            recordFirstWrite();
            await initialConfigSave;
        }

        // Save collection metadata
        setCollectionMeta(collectionId, {
            contentType,
            sourceName,
            scope: settings.scope || 'global',
            chunkCount: hashedChunks.length,
            createdAt: new Date().toISOString(),
            settings: {
                strategy: settings.strategy,
                conversation_turn_order: settings.conversation_turn_order,
                chunkSize: settings.chunkSize,
            },
            temporalDecay: hasFeature(contentType, 'temporalDecay')
                ? (settings.temporalDecay || getDefaultDecayForType(contentType))
                : { enabled: false },
        });

        // Register collection in the registry so it's discoverable
        // The registry must match the saved backend/source for later Repair.
        const registryKey = liveChatSource
            ? `${vecthareSettings.vector_backend || 'standard'}:${vecthareSettings.source || 'transformers'}:${collectionId}`
            : collectionId;
        registerCollection(registryKey);
        vhLog(`VectHare: Registered collection ${registryKey}`);

        progressTracker.updateProgress(4, 'Finalizing...');
        progressTracker.complete(true, `Vectorized ${hashedChunks.length} chunks`, panelRunId);

        return {
            success: true,
            chunkCount: hashedChunks.length,
            collectionId,
        };
    } catch (error) {
        progressTracker.addError(error.message);
        progressTracker.complete(false, 'Vectorization failed', panelRunId);
        throw error;
    }
}

/**
 * Resolves and prepares content for preview or chunking
 * Exported for use by the preview functionality
 * @param {string} contentType - Content type ID
 * @param {object} source - Source data from getSourceData()
 * @param {object} settings - Type-specific settings
 * @returns {Promise<{text: string, ...}>} Prepared content with text property
 */
export async function resolveAndPrepareContent(contentType, source, settings) {
    const rawContent = await resolveSource(contentType, source);
    const prepared = await prepareContent(contentType, rawContent, settings);

    // Return as-is - text may be string or array depending on strategy
    return prepared;
}

/**
 * Resolves source data to actual content
 */
async function resolveSource(contentType, source) {
    switch (source.type) {
        case 'paste':
            return { content: source.content, name: source.name };

        case 'file':
            // File uploads may already be parsed by the UI
            // For lorebooks: source.entries contains parsed entries
            // For characters: source.character contains parsed character data
            // For chats: source.messages contains parsed messages
            if (contentType === 'lorebook' && source.entries) {
                return {
                    content: source.entries,
                    name: source.name || source.filename,
                    entries: source.entries,
                };
            }
            if (contentType === 'character' && source.character) {
                return {
                    content: source.character,
                    name: source.name || source.character.name || source.filename,
                    character: source.character,
                };
            }
            if (contentType === 'chat' && source.messages) {
                return {
                    content: source.messages,
                    name: source.name || source.characterName || source.filename,
                    messages: source.messages,
                    metadata: source.metadata,
                };
            }
            // Generic file (plain text)
            return { content: source.content, name: source.filename || source.name };

        case 'url':
            return { content: source.content, name: source.title || source.url, url: source.url };

        case 'wiki':
            // Wiki content already scraped by UI
            return {
                content: source.content,
                name: source.name || 'Wiki',
                wikiType: source.wikiType,
                pages: source.pages,
                pageCount: source.pageCount,
            };

        case 'youtube':
            // YouTube transcript already fetched by UI
            return {
                content: source.content,
                name: source.name || `YouTube-${source.videoId}`,
                videoId: source.videoId,
                url: source.url,
            };

        case 'select':
            return await loadSelectedSource(contentType, source.id);

        case 'current':
            // For chat type - content is passed directly
            return { content: source.content, name: source.name, messages: source.content };

        default:
            if (source.content) {
                return { content: source.content, name: source.name || 'Unknown' };
            }
            throw new Error(`Unknown source type: ${source.type}`);
    }
}

/**
 * Loads content from a selected source (lorebook, character, etc.)
 */
async function loadSelectedSource(contentType, sourceId) {
    const context = getContext();

    switch (contentType) {
        case 'lorebook':
            return await loadLorebookContent(sourceId, context);

        case 'character':
            return await loadCharacterContent(sourceId, context);

        default:
            throw new Error(`Cannot load selected source for type: ${contentType}`);
    }
}

/**
 * Loads lorebook/world info content by name
 */
async function loadLorebookContent(lorebookName, context) {
    try {
        // Import ST's world-info module to load the lorebook
        const worldInfoModule = await import('../../../../world-info.js');
        const loadWorldInfo = worldInfoModule.loadWorldInfo;

        if (!loadWorldInfo) {
            throw new Error('World Info loader not available');
        }

        // Load the lorebook data
        const data = await loadWorldInfo(lorebookName);

        if (!data || !data.entries) {
            throw new Error(`Lorebook "${lorebookName}" has no entries`);
        }

        const entries = Object.values(data.entries).filter(e => e.content);

        vhLog(`VectHare: Loaded lorebook "${lorebookName}" with ${entries.length} entries`);

        return {
            content: entries,
            name: lorebookName,
            entries: entries,
        };

    } catch (e) {
        console.error('VectHare: Failed to load lorebook:', e);
        throw new Error(`Failed to load lorebook "${lorebookName}": ${e.message}`);
    }
}

/**
 * Loads character card content
 */
async function loadCharacterContent(characterId, context) {
    const characters = context?.characters || [];
    const character = characters.find(c => c.avatar === characterId);

    if (!character) {
        throw new Error(`Character not found: ${characterId}`);
    }

    return {
        content: character,
        name: character.name,
        character: character,
    };
}

/**
 * Prepares content for chunking based on content type
 */
async function prepareContent(contentType, rawContent, settings) {
    switch (contentType) {
        case 'lorebook':
            return prepareLorebookContent(rawContent, settings);

        case 'character':
            return prepareCharacterContent(rawContent, settings);

        case 'chat':
            return prepareChatContent(rawContent, settings);

        case 'url':
            return prepareUrlContent(rawContent, settings);

        case 'document':
            return prepareDocumentContent(rawContent, settings);

        case 'wiki':
            return prepareWikiContent(rawContent, settings);

        case 'youtube':
            return prepareYouTubeContent(rawContent, settings);

        default:
            return rawContent.content || rawContent;
    }
}

/**
 * Prepares lorebook content
 * For per_entry: each entry.content becomes one chunk
 * For other strategies: concatenate all entries, then chunk by that strategy
 */
function prepareLorebookContent(rawContent, settings) {
    // Handle both array (from Object.values) and object (raw entries)
    let entries = rawContent.entries || rawContent.content;

    // If entries is an object (not array), convert to array
    if (entries && typeof entries === 'object' && !Array.isArray(entries)) {
        entries = Object.values(entries);
    }

    if (!entries || !Array.isArray(entries) || entries.length === 0) {
        return { text: '', type: 'empty' };
    }

    // Filter to entries that have content, and apply text cleaning
    // World Info marks turned-off entries with disable: true; skip them unless asked
    const validEntries = entries
        .filter(e => e && e.content && (settings.includeDisabled || !e.disable))
        .map(e => ({ ...e, content: cleanText(e.content, settings.__collectionCleaningPatterns) }));

    if (settings.strategy === 'per_entry') {
        // Each entry becomes its own chunk - return array of content strings
        // Also pass entries so enrichChunks can attach keywords
        return {
            text: validEntries.map(e => e.content),
            type: 'per_entry',
            entries: validEntries,
            entryCount: validEntries.length,
        };
    }

    // For other strategies, concatenate all entries with separators
    const combined = validEntries.map(e => {
        const header = e.comment || e.name || e.key?.[0] || '';
        return header ? `# ${header}\n${e.content}` : e.content;
    }).join('\n\n---\n\n');

    return { text: combined, type: 'combined', entryCount: validEntries.length };
}

/**
 * Prepares character content
 */
function prepareCharacterContent(rawContent, settings) {
    const character = rawContent.character || rawContent.content;
    const selectedFields = settings.fields || getContentTypeDefaults('character').fields;

    const FIELD_MAP = {
        description: { key: 'description', label: 'Description' },
        personality: { key: 'personality', label: 'Personality' },
        scenario: { key: 'scenario', label: 'Scenario' },
        first_mes: { key: 'first_mes', label: 'First Message' },
        mes_example: { key: 'mes_example', label: 'Example Messages' },
        system_prompt: { key: 'system_prompt', label: 'System Prompt' },
        post_history_instructions: { key: 'post_history_instructions', label: 'Post-History Instructions' },
        creator_notes: { key: 'creator_notes', label: 'Creator Notes' },
    };

    // Embedded lorebook (card V2/V3 data.character_book): entries as text; disabled entries skipped
    const embeddedBookText = () => {
        const entries = character?.data?.character_book?.entries;
        const list = Array.isArray(entries) ? entries : (entries && typeof entries === 'object' ? Object.values(entries) : []);
        return list
            .filter(e => e && e.content && (settings.includeDisabled || (e.enabled !== false && !e.disable)))
            .map(e => {
                const header = e.comment || e.name || (Array.isArray(e.keys) ? e.keys[0] : '') || '';
                const body = cleanText(e.content, settings.__collectionCleaningPatterns);
                return header ? `${header}: ${body}` : body;
            })
            .join('\n\n');
    };

    // For per_field strategy
    if (settings.strategy === 'per_field') {
        const fields = {};
        for (const [fieldId, enabled] of Object.entries(selectedFields)) {
            if (enabled && FIELD_MAP[fieldId] && character[FIELD_MAP[fieldId].key]) {
                fields[FIELD_MAP[fieldId].label] = cleanText(character[FIELD_MAP[fieldId].key], settings.__collectionCleaningPatterns);
            }
            if (enabled && fieldId === 'character_book') {
                const book = embeddedBookText();
                if (book) fields['Embedded Lorebook'] = book;
            }
        }
        return { text: fields, type: 'fields', character: character };
    }

    // Otherwise, concatenate selected fields
    const combined = Object.entries(selectedFields)
        .filter(([, enabled]) => enabled)
        .map(([fieldId]) => {
            const field = FIELD_MAP[fieldId];
            if (field && character[field.key]) {
                return `## ${field.label}\n${cleanText(character[field.key], settings.__collectionCleaningPatterns)}`;
            }
            if (fieldId === 'character_book') {
                const book = embeddedBookText();
                return book ? `## Embedded Lorebook\n${book}` : null;
            }
            return null;
        })
        .filter(Boolean)
        .join('\n\n');

    return { text: combined, type: 'combined', character: character };
}

/**
 * Prepares chat content for chunking
 * Maps to the unified chunking strategies in chunking.js
 */
function prepareChatContent(rawContent, settings) {
    const messages = rawContent.messages || rawContent.content;

    if (!Array.isArray(messages)) {
        return { text: cleanText(String(messages), settings.__collectionCleaningPatterns), type: 'text' };
    }

    // Keep original source positions when filtering messages: chunk metadata
    // must not refer to the compacted array indices (issue #65).
    const indexedMessages = messages.map((message, sourceIndex) => ({ message, sourceIndex }))
        .filter(({ message }) => message.mes && !message.is_system);
    const validMessages = indexedMessages.map(({ message }) => message);

    // Apply text cleaning without changing source message objects or positions.
    const cleanedMessages = cleanMessages(validMessages, settings.__collectionCleaningPatterns);

    // Normalize messages to have consistent properties for chunking.js
    const normalizedMessages = cleanedMessages.map((m, idx) => ({
        text: m.mes,
        mes: m.mes,
        is_user: m.is_user,
        name: m.name,
        index: indexedMessages[idx].sourceIndex,
        id: m.send_date || m.id || indexedMessages[idx].sourceIndex,
    }));

    // For per_message strategy - return array of messages for chunking.js
    if (settings.strategy === 'per_message') {
        return {
            text: normalizedMessages,
            type: 'messages',
            messages: validMessages,
        };
    }

    // For conversation_turns strategy - return array for chunking.js to pair
    if (settings.strategy === 'conversation_turns') {
        return {
            text: normalizedMessages,
            type: 'messages',
            messages: validMessages,
        };
    }

    // For message_batch strategy - return array for chunking.js to batch
    if (settings.strategy === 'message_batch') {
        return {
            text: normalizedMessages,
            type: 'messages',
            messages: validMessages,
        };
    }

    // For adaptive or other text strategies - combine into single text
    const combined = cleanedMessages.map(m => {
        const speaker = (typeof m.name === 'string' && m.name.trim()) || (m.is_user ? 'User' : 'Character');
        return `[${speaker}]: ${m.mes}`;
    }).join('\n\n');

    return { text: combined, type: 'combined', messages: cleanedMessages };
}

/**
 * Prepares URL/webpage content
 */
function prepareUrlContent(rawContent, settings) {
    let text = rawContent.content || rawContent;

    // Basic text cleaning for web content
    if (typeof text === 'string') {
        // Apply user's cleaning patterns first
        text = cleanText(text, settings.__collectionCleaningPatterns);
        // Remove excessive whitespace
        text = text.replace(/\n{3,}/g, '\n\n');
        // Remove common web artifacts
        text = text.replace(/\[edit\]/gi, '');
        text = text.replace(/\[\d+\]/g, ''); // Remove reference numbers like [1], [2]
        // Trim
        text = text.trim();
    }

    return { text, type: 'url', name: rawContent.name, url: rawContent.url };
}

/**
 * Prepares document content
 */
function prepareDocumentContent(rawContent, settings) {
    let text = rawContent.content || rawContent;

    // Basic text cleaning
    if (typeof text === 'string') {
        // Apply user's cleaning patterns first
        text = cleanText(text, settings.__collectionCleaningPatterns);
        // Remove excessive whitespace
        text = text.replace(/\n{3,}/g, '\n\n');
        // Trim
        text = text.trim();
    }

    return { text, type: 'document', name: rawContent.name };
}

/**
 * Prepares wiki content
 */
function prepareWikiContent(rawContent, settings) {
    let text = rawContent.content || rawContent;

    // Wiki content is already formatted with headers from scraper
    if (typeof text === 'string') {
        // Apply user's cleaning patterns first
        text = cleanText(text, settings.__collectionCleaningPatterns);
        // Remove excessive whitespace
        text = text.replace(/\n{3,}/g, '\n\n');
        // Trim
        text = text.trim();
    }

    // For per_page strategy, split back into individual pages
    if (settings.strategy === 'per_page' && rawContent.pages) {
        return {
            text: rawContent.pages.map(p => ({
                text: cleanText(`# ${p.title}\n\n${p.content}`, settings.__collectionCleaningPatterns),
                metadata: {
                    pageTitle: p.title,
                },
            })),
            type: 'pages',
            pages: rawContent.pages,
            name: rawContent.name,
        };
    }

    return {
        text,
        type: 'wiki',
        name: rawContent.name,
        wikiType: rawContent.wikiType,
        pageCount: rawContent.pageCount,
    };
}

/**
 * Prepares YouTube transcript content
 */
function prepareYouTubeContent(rawContent, settings) {
    let text = rawContent.content || rawContent;

    // Clean up transcript text
    if (typeof text === 'string') {
        // Apply user's cleaning patterns first
        text = cleanText(text, settings.__collectionCleaningPatterns);
        // Remove excessive whitespace
        text = text.replace(/\n{3,}/g, '\n\n');
        // Trim
        text = text.trim();
    }

    return {
        text,
        type: 'youtube',
        name: rawContent.name,
        videoId: rawContent.videoId,
        url: rawContent.url,
    };
}

/**
 * Generates a collection ID for the content
 * Uses the unified builders from collection-ids.js
 */
function generateCollectionId(contentType, source, settings) {
    const sourceName = source.name || source.id || source.filename || contentType;
    const timestamp = Date.now();

    switch (contentType) {
        case 'chat':
            // Only the verified resolver may provide a chat ID, and only for the
            // live chat. Never invent a name-based or UUID-based fallback when the
            // binding is absent. An uploaded/pasted transcript (#8) is its own
            // document collection, never the active chat's.
            if (source.type === 'current') return buildChatCollectionId();
            return buildDocumentCollectionId(sourceName, timestamp);

        case 'lorebook':
            return buildLorebookCollectionId(sourceName, timestamp);

        case 'character':
            return buildCharacterCollectionId(sourceName, timestamp);

        case 'document':
            return buildDocumentCollectionId(sourceName, timestamp);

        case 'url':
            // Use domain from URL or title
            let urlName = sourceName;
            try {
                const url = new URL(source.url || '');
                urlName = source.title || url.hostname || 'webpage';
            } catch {
                urlName = source.title || source.name || 'webpage';
            }
            return buildDocumentCollectionId(urlName, timestamp);

        case 'wiki':
            return buildDocumentCollectionId(source.name || 'wiki', timestamp);

        case 'youtube':
            return buildDocumentCollectionId(source.name || source.videoId || 'youtube', timestamp);
    }

    // Fallback for unknown types or chat fallback
    const scope = settings.scope || 'global';
    const context = getContext();
    const baseName = sourceName;

    // Sanitize name for use in ID
    const sanitizedName = baseName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .substring(0, 50);

    // Add scope prefix
    let scopePrefix = '';
    if (scope === 'character' && context?.characterId) {
        scopePrefix = `char_${context.characterId}_`;
    } else if (scope === 'chat' && context?.chatId) {
        scopePrefix = `chat_${context.chatId}_`;
    }

    return `vecthare_${contentType}_${scopePrefix}${sanitizedName}_${timestamp}`;
}

/**
 * Enriches chunks with metadata and keywords
 * @param {Array} chunks - Array of chunk strings or objects
 * @param {string} contentType - Type of content
 * @param {object} source - Source info
 * @param {object} settings - Vectorization settings including keyword options
 * @param {object} preparedContent - Prepared content data
 * @param {object} vecthareSettings - Full VectHare extension settings (includes custom_stopwords)
 */
function enrichChunks(chunks, contentType, source, settings, preparedContent, vecthareSettings) {
    // Get keyword extraction settings
    const keywordLevel = settings.keywordLevel || 'balanced';
    const keywordBaseWeight = settings.keywordBaseWeight || 1.5;

    return chunks.map((chunk, index) => {
        const chunkText = typeof chunk === 'string' ? chunk : chunk.text;
        let keywords = []; // Will hold {text, weight} objects
        let entryName = null;
        let entryUid = null;

        // For lorebooks with per_entry, get keywords from the entry
        if (contentType === 'lorebook' && preparedContent.entries?.[index]) {
            const entry = preparedContent.entries[index];
            entryName = entry.comment || entry.name || entry.key?.[0] || 'Entry';
            entryUid = entry.uid;

            // Get explicit trigger keys (these are manually set, so use base weight)
            const triggerKeys = extractLorebookKeywords(entry, vecthareSettings);
            keywords = triggerKeys.map(k => ({ text: k, weight: keywordBaseWeight }));

            // Also get auto-extracted keywords with frequency-based weights
            if (keywordLevel !== 'off') {
                const autoKeywords = extractTextKeywords(entry.content || chunkText, {
                    level: keywordLevel,
                    baseWeight: keywordBaseWeight,
                    settings: vecthareSettings,
                });
                keywords = keywords.concat(autoKeywords);
            }
        } else if (contentType === 'chat') {
            // For chat, use BM25/TF-IDF to find most distinctive words
            if (keywordLevel !== 'off') {
                keywords = extractBM25Keywords(chunkText, {
                    level: keywordLevel,
                    baseWeight: keywordBaseWeight,
                    settings: vecthareSettings,
                });
            }
        } else {
            // For other content (url, wiki, document, youtube), use frequency-based extraction
            if (keywordLevel !== 'off') {
                keywords = extractTextKeywords(chunkText, {
                    level: keywordLevel,
                    baseWeight: keywordBaseWeight,
                    settings: vecthareSettings,
                });
            }
        }

        // Add character name as keyword with higher weight (it's the main subject)
        if (contentType === 'character' && preparedContent.character?.name) {
            keywords.push({
                text: preparedContent.character.name.toLowerCase(),
                weight: keywordBaseWeight + 0.5, // Character name gets bonus weight
            });
        }

        // Add speaker name as keyword for chat messages
        if (contentType === 'chat' && chunk.metadata?.speakerName) {
            keywords.push({
                text: chunk.metadata.speakerName.toLowerCase(),
                weight: keywordBaseWeight,
            });
        }

        // Deduplicate keywords (keep highest weight for duplicates)
        const keywordMap = new Map();
        for (const kw of keywords) {
            const existing = keywordMap.get(kw.text);
            if (!existing || kw.weight > existing.weight) {
                keywordMap.set(kw.text, kw);
            }
        }
        const dedupedKeywords = Array.from(keywordMap.values());

        return {
            text: chunkText,
            index: index,
            keywords: dedupedKeywords,
            metadata: {
                contentType,
                sourceName: source.name || source.filename || 'Unknown',
                entryName,
                entryUid,
                keywordLevel,
                keywordBaseWeight,
                ...(chunk.metadata || {}),
            },
        };
    });
}

/**
 * Deletes a content collection
 */
export async function deleteContentCollection(collectionId) {
    const vecthareSettings = extension_settings.vecthare;
    await withChatCollectionPurgeGuard(collectionId, async () => {
        if (!await purgeVectorIndex(collectionId, vecthareSettings)) {
            throw new Error('Backend did not confirm collection purge');
        }
    });
    vhLog(`VectHare: Deleted collection: ${collectionId}`);
}

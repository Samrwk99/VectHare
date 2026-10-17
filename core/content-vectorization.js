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

import { getContentType, getContentTypeDefaults, hasFeature } from './content-types.js';
import { chunkText } from './chunking.js';
import { insertVectorItems, purgeVectorIndex } from './core-vector-api.js';
import { setCollectionMeta, getDefaultDecayForType } from './collection-metadata.js';
import { registerCollection } from './collection-loader.js';
import { bindChatCollection, getChatBinding, getCollectionOwner, resolveChatWriteTarget } from './collection-ownership.js';
import { getChatUUID, parseRegistryKey } from './collection-ids.js';
import { getBackend } from '../backends/backend-manager.js';
// Import from collection-ids.js - single source of truth for collection ID operations
import {
    buildChatCollectionId,
    buildLorebookCollectionId,
    buildCharacterCollectionId,
    buildDocumentCollectionId,
    COLLECTION_PREFIXES,
} from './collection-ids.js';
import { extractLorebookKeywords, extractTextKeywords, extractChatKeywords, extractBM25Keywords, EXTRACTION_LEVELS, DEFAULT_EXTRACTION_LEVEL, DEFAULT_BASE_WEIGHT } from './keyword-boost.js';
import { cleanText, cleanMessages } from './text-cleaning.js';
import { progressTracker } from '../ui/progress-tracker.js';
import { extension_settings, getContext } from '../../../../extensions.js';
import { getStringHash } from '../../../../utils.js';
import { getCollectionProfile, makeCollectionProfile, saveCollectionProfile, applyAndVerifyProfile, saveChatChunkManifest, patchChatChunkManifest, getChatChunkManifest } from './vectorization-profile.js';
import { prepareEmbeddingItems } from './embedding-overflow.js';
import { inspectCollectionChunks, expectedEmbeddedText, chunkMatchesExpected } from './chunk-integrity.js';
import { beginSyncCheckpoint, updateSyncCheckpoint, acknowledgeSyncChunk, finalizeSyncCheckpoint } from './sync-checkpoints.js';
import { createOperationControl, detachOperationControl, hasActiveVectorWrite, OperationStoppedError } from '../ui/operation-controls.js';
import { buildExpectedChatItems } from './chat-vectorization.js';

/**
 * Main entry point for content vectorization
 * @param {object} params - Vectorization parameters
 * @param {string} params.contentType - Content type ID
 * @param {object} params.source - Source data
 * @param {object} params.settings - Type-specific settings
 * @returns {Promise<{success: boolean, chunkCount: number, collectionId: string}>}
 */
let contentVectorizationActive=false;
export async function vectorizeContent({ contentType, source, settings }) {
    // Freeze source/settings for this run; modal edits must not change its inputs.
    source=structuredClone(source);settings=structuredClone(settings);
    const openedChatUUID=contentType==='chat'&&source.type==='current'?getChatUUID():null;
    const chatSignature=()=>JSON.stringify((getContext()?.chat||[]).map(m=>[m.mes,m.swipe_id,m.is_user,m.is_system,m.extra?.fileLength]));
    const originalChatSignature=openedChatUUID?chatSignature():null;
    const assertOriginalChat=()=>{if(openedChatUUID && (openedChatUUID!==getChatUUID() || chatSignature()!==originalChatSignature))throw new Error('Chat changed during vectorisation. Completed chunks remain safe; reopen this chat and scan before continuing.');};
    if(contentVectorizationActive || hasActiveVectorWrite())throw new Error('Another vector-writing operation is running. Use Live Status to control it.');
    const type = getContentType(contentType);
    if (!type) {
        throw new Error(`Unknown content type: ${contentType}`);
    }

    // Per Scene is exclusively marker-driven, not a batch-vectorization strategy.
    // Reject before any collection or vector is changed; other strategies stay intact.
    if (contentType === 'chat' && settings?.strategy === 'per_scene') {
        throw new Error('Per Scene is marker-driven: mark scene boundaries in chat instead of vectorizing the full chat here.');
    }

    const sourceName = source.name || source.filename || source.id || contentType;
    contentVectorizationActive=true;
    progressTracker.show(`Vectorizing ${type.label || contentType}`, 4, 'Steps');
    progressTracker.updateCurrentItem(sourceName);
    const control=createOperationControl(progressTracker.activityId,{pausable:true,stoppable:true,writeOperation:true});
    const originalUUID=contentType==='chat'&&source.type==='current'?getChatUUID():null;
    progressTracker.registerRetry(async()=>{
        if(originalUUID && getChatUUID()!==originalUUID)throw new Error('Open the original chat before retrying');
        await vectorizeContent({contentType,source,settings});
    });
    let journalKey=null,journalChat=null;
    try {
        await control.checkpoint();
        // Step 1: Resolve source
        progressTracker.updateProgress(1, 'Loading content...');
        const rawContent = await resolveSource(contentType, source);

        // Step 2: Prepare and chunk
        progressTracker.updateProgress(2, 'Chunking content...');
        const preparedContent = await prepareContent(contentType, rawContent, settings);
        await control.checkpoint();
        const chunks = await chunkText(preparedContent.text || preparedContent, {
            strategy: settings.strategy || type.defaultStrategy,
            chunkSize: settings.chunkSize || type.defaults.chunkSize,
            chunkOverlap: settings.chunkOverlap || type.defaults.chunkOverlap,
            batchSize: settings.batchSize || 4,
            conversationTurnOrder: settings.conversationTurnOrder || 'user_character',
        });

        if (chunks.length === 0) {
            throw new Error('No chunks generated from content');
        }

        // Log chunking results for debugging
        const chunkLengths = chunks.map(c => (typeof c === 'string' ? c : c.text || '').length);
        const maxChunkLen = Math.max(...chunkLengths);
        const avgChunkLen = Math.round(chunkLengths.reduce((a, b) => a + b, 0) / chunkLengths.length);
        console.log(`VectHare: Chunked "${sourceName}" into ${chunks.length} chunks (avg: ${avgChunkLen} chars, max: ${maxChunkLen} chars)`);

        progressTracker.updateChunks(chunks.length);

        // Step 3: Enrich and hash
        progressTracker.updateProgress(3, 'Processing chunks...');
        // Settings used by the embedding backend, not the modal's chunking options.
        const vecthareSettings = extension_settings.vecthare;
        const isOpenChat = contentType === 'chat' && source.type === 'current';
        const chatUUID = isOpenChat ? getChatUUID() : null;
        const currentBackend = vecthareSettings.vector_backend || 'standard';
        const currentSource = vecthareSettings.source || 'transformers';
        let collectionId = generateCollectionId(contentType, source, settings);
        if (contentType === 'chat' && source.type === 'file') {
            // Uploaded chat has no trustworthy current-chat ownership. Never
            // inherit the chat that happens to be open in SillyTavern.
            const safeName = (source.filename || source.name || 'upload').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 42);
            collectionId = `vecthare_chat_upload_${safeName}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
        } else if (isOpenChat) {
            if (source.replaceExisting) {
                const selectedKey=source.replacedCollectionKey;
                if(selectedKey){
                    const parsed=parseRegistryKey(selectedKey);
                    if(parsed.backend!==currentBackend || parsed.source!==currentSource)
                        throw new Error('Selected replacement source uses a different vector backend or embedding provider');
                    const owner=getCollectionOwner(selectedKey);
                    if(owner && owner!==chatUUID)throw new Error('Selected collection belongs to another chat. Cannot disable or reassign it.');
                }
                // Staged replacement: new physical collection, old one retained.
                // Only switch the chat binding after all vectors are committed.
                collectionId = `${collectionId}_replacement_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
            } else {
                const target = resolveChatWriteTarget(vecthareSettings, chatUUID, collectionId);
                collectionId = target.collectionId;
                if (target.newCollection && extension_settings.vecthare?.vecthare_collection_registry?.some(k => parseRegistryKey(k).collectionId === collectionId)) {
                    throw new Error('Existing unconnected collection found. Connect and verify its settings first, or choose Replace All to create a safe replacement.');
                }
            }
        }
        let collectionKey = `${currentBackend}:${currentSource}:${collectionId}`;

        // Use the same provider settings throughout this operation.
        const enrichedChunks = enrichChunks(chunks, contentType, source, settings, preparedContent, vecthareSettings);
        const originalChunks = enrichedChunks.map(chunk => ({...chunk, hash:getStringHash(chunk.text)}));
        // For the connected current chat, both entry points must produce the
        // same chunk hashes/manifests so Scan & Sync agree on the source of truth.
        const effectiveProfileSettings = {...vecthareSettings, chunking_strategy:settings.strategy || vecthareSettings.chunking_strategy,
            chunk_size:settings.chunkSize || vecthareSettings.chunk_size,
            batch_size:settings.batchSize || vecthareSettings.batch_size,
            conversation_turn_order:settings.conversationTurnOrder || 'user_character'};
        let hashedChunks = isOpenChat && ['per_message','conversation_turns','message_batch','adaptive'].includes(settings.strategy)
            ? await buildExpectedChatItems(getContext().chat,effectiveProfileSettings)
            : await prepareEmbeddingItems(originalChunks,effectiveProfileSettings,getStringHash);
        // Resumable staged replacements: identify source by exact planned hashes
        // and configuration, not just by a filename or the open character.
        // No original text, credentials or embeddings are placed in the journal.
        const pending=extension_settings.vecthare.pendingVectorizations ||= {};
        const sourceFingerprint=JSON.stringify([contentType,source.type,sourceName,chatUUID,
            source.replacedCollectionKey||null,settings.strategy,settings.chunkSize,settings.batchSize,settings.conversationTurnOrder || 'user_character',
            currentBackend,currentSource,hashedChunks.map(c=>String(c.hash))]);
        const pendingKey=String(getStringHash(sourceFingerprint));
        let prior=pending[pendingKey];
        if(!prior){try{prior=JSON.parse(globalThis.localStorage?.getItem(`vecthare:pending-content:v1:${pendingKey}`)||'null');}catch{}}
        if(prior && prior.fingerprint===sourceFingerprint && prior.registryKey &&
           (source.replaceExisting || source.type==='file')) {
            const parsed=parseRegistryKey(prior.registryKey);
            if(parsed.backend!==currentBackend||parsed.source!==currentSource)
                throw new Error('An interrupted collection belongs to a different backend');
            collectionKey=prior.registryKey;collectionId=parsed.collectionId;
        }
        await control.checkpoint();
        assertOriginalChat();
        const alreadyConnected = getChatBinding(chatUUID);
        const activeKey = alreadyConnected?.registryKey;
        let profile;
        if((getCollectionProfile(collectionKey) && !source.replaceExisting) || (prior?.registryKey===collectionKey && getCollectionProfile(collectionKey))) {
            const check = await applyAndVerifyProfile(collectionKey,effectiveProfileSettings);
            profile = check.profile;
            for(const field of ['chunking_strategy','chunk_size','batch_size','conversation_turn_order']) {
                if(profile.chunking?.[field] !== undefined && effectiveProfileSettings[field] !== profile.chunking[field])
                    throw new Error(`Collection was created with ${field}=${profile.chunking[field]}; you selected ${effectiveProfileSettings[field]}. Use safe Re-vectorize instead of mixing strategies.`);
            }
        } else {
            // Existing unbound or externally created collections must not be
            // silently adopted using today's global embedding settings.
            if(!source.replaceExisting && extension_settings.vecthare?.vecthare_collection_registry?.includes(collectionKey) && !getCollectionProfile(collectionKey))
                throw new Error('Existing collection has no verified settings. Connect read-only, restore original settings or Re-vectorize safely.');
            profile = await makeCollectionProfile(effectiveProfileSettings);
            if(!profile.embedding.verified) throw new Error(profile.embedding.reason || 'Embedding model identity unknown. Cannot create a verified collection.');
        }
        if(isOpenChat && chatUUID !== getChatUUID())throw new Error('Chat changed while preparing vectors');

        // Step 4: Insert into vector store (streaming: embed + write together)
        progressTracker.updateProgress(4, 'Processing chunks...');

        // Persist the collection's original profile and recovery intent before
        // the first write. A process crash after an acknowledged insert cannot
        // make this collection an unidentifiable/unverifiable orphan.
        const firstWrite=!getCollectionProfile(collectionKey);
        if(firstWrite)await saveCollectionProfile(collectionKey,profile);
        if(isOpenChat && !source.replaceExisting && !getChatChunkManifest(collectionKey))
            await saveChatChunkManifest(collectionKey,[],chatUUID);
        if(source.replaceExisting || source.type==='file'){
            pending[pendingKey]={fingerprint:sourceFingerprint,registryKey:collectionKey,createdAt:Date.now()};
            try{globalThis.localStorage?.setItem(`vecthare:pending-content:v1:${pendingKey}`,JSON.stringify(pending[pendingKey]));}catch{}
            // This calls saveSettingsDebounced through the recovery journal below.
        }
        journalKey=collectionKey;
        journalChat=chatUUID||`content:${pendingKey}`;
        const backend=await getBackend(effectiveProfileSettings);
        let stored=[];
        try{stored=await inspectCollectionChunks(backend,collectionId,effectiveProfileSettings);}
        catch(e){
            if(/\b404\b/.test(e.message) && (firstWrite || prior?.registryKey===collectionKey || source.replaceExisting))stored=[];
            else if(/\b404\b/.test(e.message) && !getChatChunkManifest(collectionKey))stored=[];
            else throw e;
        }
        const rowMap=new Map();
        for(const row of stored){
            if(rowMap.has(String(row.hash)))throw new Error('Duplicate stored hash; use Scan/Repair before continuing');
            rowMap.set(String(row.hash),row);
        }
        const matches=(storedItem,item)=>{
            if(!storedItem)return false;
            if(isOpenChat)return chunkMatchesExpected(storedItem,item);
            const text=String(storedItem.text??'');
            return text===String(item.text) || text===expectedEmbeddedText(item);
        };
        const confirmed=hashedChunks.filter(item=>matches(rowMap.get(String(item.hash)),item));
        const needed=hashedChunks.filter(item=>!matches(rowMap.get(String(item.hash)),item));
        beginSyncCheckpoint(journalKey,journalChat,hashedChunks.length,confirmed.length);
        if(isOpenChat && confirmed.length){
            const known=new Set((getChatChunkManifest(collectionKey)?.entries||[]).map(e=>String(e.hash)));
            const recovered=confirmed.filter(item=>!known.has(String(item.hash)));
            if(recovered.length)await patchChatChunkManifest(collectionKey,recovered,chatUUID);
        }
        progressTracker.updateVerifiedChunks(confirmed.length,hashedChunks.length,`${confirmed.length} chunks already verified`);
        let written=0;
        for(const chunk of needed){
            await control.checkpoint();
            assertOriginalChat();
            updateSyncCheckpoint(journalKey,journalChat,{phase:'running',activeHash:String(chunk.hash)});
            await insertVectorItems(collectionId,[chunk],effectiveProfileSettings);
            let storedItem=typeof backend.getChunk==='function'?await backend.getChunk(collectionId,chunk.hash,effectiveProfileSettings):null;
            if(!storedItem) {
                const rows=await inspectCollectionChunks(backend,collectionId,effectiveProfileSettings);
                storedItem=rows.find(row=>String(row.hash)===String(chunk.hash));
            }
            if(!matches(storedItem,chunk))throw new Error(`Inserted chunk ${chunk.hash} could not be verified; retry will inspect it before re-embedding`);
            if(isOpenChat)await patchChatChunkManifest(collectionKey,[chunk],chatUUID);
            written++;
            const count=confirmed.length+written;
            acknowledgeSyncChunk(journalKey,journalChat,chunk.hash,count);
            progressTracker.updateVerifiedChunks(count,hashedChunks.length,`Verified ${count}/${hashedChunks.length} chunks`);
        }
        await control.checkpoint();
        assertOriginalChat();
        // Explicitly recheck every chunk before committing a replacement.
        const finalRows=await inspectCollectionChunks(backend,collectionId,effectiveProfileSettings);
        const finalMap=new Map(finalRows.map(row=>[String(row.hash),row]));
        if(hashedChunks.some(item=>!matches(finalMap.get(String(item.hash)),item)))
            throw new Error('Final database verification failed; original collection remains active');
        if(isOpenChat && !source.replaceExisting){
            const wanted=new Set(hashedChunks.map(item=>String(item.hash)));
            const obsolete=finalRows.filter(row=>!wanted.has(String(row.hash))).map(row=>row.hash);
            if(obsolete.length){
                const {deleteVectorItems}=await import('./core-vector-api.js');
                await deleteVectorItems(collectionId,obsolete,effectiveProfileSettings);
                const after=await inspectCollectionChunks(backend,collectionId,effectiveProfileSettings);
                if(after.some(row=>obsolete.map(String).includes(String(row.hash))))throw new Error('Obsolete chat chunks were not fully deleted');
                await patchChatChunkManifest(collectionKey,[],chatUUID,obsolete);
            }
        }
        finalizeSyncCheckpoint(journalKey,journalChat,'completed','All chunks verified');
        // Save collection metadata
        setCollectionMeta(collectionKey, {
            contentType,
            sourceName,
            scope: settings.scope || 'global',
            chunkCount: hashedChunks.length,
            createdAt: new Date().toISOString(),
            settings: {
                strategy: settings.strategy,
                chunkSize: settings.chunkSize,
            },
            temporalDecay: hasFeature(contentType, 'temporalDecay')
                ? (settings.temporalDecay || getDefaultDecayForType(contentType))
                : { enabled: false },
        });

        // Register collection in the registry so it's discoverable
        registerCollection(collectionKey);
        if (isOpenChat) {
            const previous=source.replacedCollectionKey || getChatBinding(chatUUID)?.registryKey;
            bindChatCollection(chatUUID, collectionKey, { replace: !!source.replaceExisting, writeVerified: true });
            if(source.replaceExisting && previous && previous !== collectionKey) {
                // Backup is preserved but disabled to avoid duplicate retrieval.
                setCollectionMeta(previous,{enabled:false,autoSync:false,replacedBy:collectionKey});
            }
        }
        // The replacement connection is now committed; only now discard the
        // recoverable staging pointer. Earlier failure leaves it available.
        delete pending[pendingKey];
        try{globalThis.localStorage?.removeItem(`vecthare:pending-content:v1:${pendingKey}`);}catch{}
        console.log(`VectHare: Registered collection ${collectionKey}`);

        progressTracker.complete(true, `Verified ${hashedChunks.length} chunks (${written} newly written)`);

        return {
            success: true,
            chunkCount: hashedChunks.length,
            collectionId,
        };
    } catch (error) {
        if(journalKey)finalizeSyncCheckpoint(journalKey,journalChat,error instanceof OperationStoppedError?'stopped':'interrupted',error.message);
        progressTracker.addError(error.message);
        progressTracker.complete(error instanceof OperationStoppedError?'stopped':false,error instanceof OperationStoppedError?'Stopped safely; verified chunks preserved':'Vectorization failed');
        throw error;
    }finally{detachOperationControl(control.activityId);contentVectorizationActive=false;}
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

        console.log(`VectHare: Loaded lorebook "${lorebookName}" with ${entries.length} entries`);

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
    const validEntries = entries
        .filter(e => e && e.content)
        .map(e => ({ ...e, content: cleanText(e.content) }));

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

    // For per_field strategy
    if (settings.strategy === 'per_field') {
        const fields = {};
        for (const [fieldId, enabled] of Object.entries(selectedFields)) {
            if (enabled && FIELD_MAP[fieldId] && character[FIELD_MAP[fieldId].key]) {
                fields[FIELD_MAP[fieldId].label] = cleanText(character[FIELD_MAP[fieldId].key]);
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
                return `## ${field.label}\n${cleanText(character[field.key])}`;
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
        return { text: cleanText(String(messages)), type: 'text' };
    }

    // Filter out system messages and empty messages
    const validMessages = messages.map((m, index) => ({...m, index})).filter(m => m.mes && !m.is_system);

    // Apply text cleaning to messages
    const cleanedMessages = cleanMessages(validMessages);

    // Normalize messages to have consistent properties for chunking.js
    const normalizedMessages = cleanedMessages.map((m, idx) => ({
        text: m.mes,
        mes: m.mes,
        is_user: m.is_user,
        name: m.name,
        index: m.index ?? idx,
        id: m.send_date || m.id || idx,
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
        const speaker = m.is_user ? 'User' : (m.name || 'Character');
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
        text = cleanText(text);
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
        text = cleanText(text);
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
        text = cleanText(text);
        // Remove excessive whitespace
        text = text.replace(/\n{3,}/g, '\n\n');
        // Trim
        text = text.trim();
    }

    // For per_page strategy, split back into individual pages
    if (settings.strategy === 'per_page' && rawContent.pages) {
        return {
            text: rawContent.pages.map(p => ({
                text: cleanText(`# ${p.title}\n\n${p.content}`),
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
        text = cleanText(text);
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
            // Use UUID-based ID (single source of truth)
            const chatCollectionId = buildChatCollectionId();
            if (chatCollectionId) {
                return chatCollectionId;
            }
            // Fall through to legacy generation if UUID not available
            console.warn('VectHare: Chat UUID not available, using legacy ID generation');
            break;

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
    if (await purgeVectorIndex(collectionId, vecthareSettings) !== true) {
        throw new Error(`Failed to delete content collection ${collectionId}`);
    }
    console.log(`VectHare: Deleted collection: ${collectionId}`);
}

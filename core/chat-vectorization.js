import {recordId, fingerprint, stampMessageUids, messageReference, groupRecordLocalId, checkCollision, embeddingProfileFingerprint, MESSAGE_UID_FIELD} from '../utils/record-identity.js';
import {hasVerifiedCapability} from '../utils/backend-contracts.js';
import {chatJobs, anyJobSignal,currentChatIdentity} from './chat-job-runtime.js';
import {scopedActivationHistory} from '../utils/activation-history.js';
import {StaleJobError} from './job-context.js';
import {planReplacement} from '../utils/replacement-safety.js';
/**
 * ============================================================================
 * VECTHARE CHAT VECTORIZATION
 * ============================================================================
 * Core logic for vectorizing chat messages and retrieving relevant context
 *
 * @author Coneja Chibi
 * @version 2.2.0-alpha
 * ============================================================================
 */

import { getCurrentChatId, is_send_press, setExtensionPrompt, substituteParams, chat_metadata, extension_prompts } from '../../../../../script.js';
import { getContext } from '../../../../extensions.js';
import { getStringHash as calculateHash, waitUntilCondition, onlyUnique } from '../../../../utils.js';
import { isUnitStrategy, groupConversationTurns } from './chunking.js';
import { extractChatKeywords, extractBM25Keywords, applyKeywordBoost } from './keyword-boost.js';
import { containsLexicalPhrase } from '../utils/lexical-tokenization.js';
import { mergeSemanticWorldInfoChunks } from '../utils/world-info-dedup.js';
import { cleanText } from './text-cleaning.js';
import {
    getSavedHashes,
    insertVectorItems,
    queryCollection,
    queryActiveCollections,
    deleteVectorItems,
    purgeVectorIndex,
} from './core-vector-api.js';
import { isBackendAvailable } from '../backends/backend-manager.js';
import { applyDecayToResults, applyNostalgiaToResults, applySceneAwareDecay } from './temporal-decay.js';
import { isChunkDisabledByScene } from './scenes.js';
import { registerCollection, getCollectionRegistry } from './collection-loader.js';
import {
    isCollectionEnabled,
    filterActiveCollections,
    getChatCollectionPolicy,
    applyChatCollectionPolicy,
} from './collection-metadata.js';
import { progressTracker } from '../ui/progress-tracker.js';
// VectHare+: run control (pause / resume / stop) for vectorization jobs
import {
    pauseVectorization,
    resumeVectorization,
    stopVectorization,
    resetControlState,
    isVectorizationPaused,
    isVectorizationStopped,
    getStopSignal,
} from './vectorization-control.js';
import { buildSearchContext, filterChunksByConditions, processChunkLinks } from './conditional-activation.js';
import { getRequiredConditionDepth } from './condition-rule-compat.js';
import { getChunkMetadata, getCollectionMeta } from './collection-metadata.js';
import { processChunkGroups, mergeVirtualLinks } from './chunk-groups.js';
import { createDebugData, setLastSearchDebug, addTrace, recordChunkFate } from '../ui/search-debug.js';
import { getSemanticWorldInfoEntries } from './world-info-integration.js';
import { Queue, LRUCache } from '../utils/data-structures.js';
import { createReverseSyncThrottle } from '../utils/reverse-sync-throttle.js';
import { getRequestHeaders } from '../../../../../script.js';
import { EXTENSION_PROMPT_TAG, LEGACY_WORLD_INFO_PROMPT_TAG, HASH_CACHE_SIZE } from './constants.js';
// Import from collection-ids.js - single source of truth for collection ID operations
import {
    getChatUUID,
    getVerifiedChatOriginId,
    buildChatCollectionId,
    buildLegacyChatCollectionId,
    getAllChatCollectionIds,
    parseCollectionId,
    parseRegistryKey,
} from './collection-ids.js';

// Hash cache for performance
/** Save stamped UIDs with the chat before considering them durable. If the host has
 * no verified chat ID or save API, preserve legacy positional behavior instead.
 * A failed save rolls back the in-memory stamps rather than implying persistence.
 */
async function ensureDurableMessageUids(chat, context, job) {
    const chatId = getVerifiedChatOriginId();
    if (!chatId || typeof context?.saveChat !== 'function') return false;
    const oldExtras = chat.map(msg => msg && typeof msg === 'object' ? msg.extra : undefined);
    let saveAccepted = false;
    try {
        const result = stampMessageUids(chat);
        if (result.changed) {
            const receipt = await context.saveChat();
            if (receipt === false) throw new Error('Host rejected chat save');
        }
        saveAccepted = true;
    } catch (error) {
        // Do not leave newly created, unpersisted IDs on in-memory messages.
        if (!saveAccepted) {
            for (let i = 0; i < chat.length; i++) {
                if (!chat[i] || typeof chat[i] !== 'object') continue;
                if (oldExtras[i] === undefined) delete chat[i].extra;
                else chat[i].extra = oldExtras[i];
            }
        }
        console.warn('VectHare C07: stable chat identities unavailable; using legacy positions:', error.message);
        return false;
    }
    // The save may have succeeded immediately before a chat switch. Never
    // roll back a potentially persisted UID or continue using a stale chat.
    job.assertCurrent();
    return true;
}

const hashCache = new LRUCache(HASH_CACHE_SIZE);

// Synchronization state
let syncBlocked = false;

// VectHare+ R9: one-time warning flag for auto-sync blocked by config mismatch
let autoSyncFingerprintWarned = false;

/**
 * VectHare+ R10: Forces the NEXT sync pass (auto-sync or Repair Chunks) to run
 * the reverse-sync (ghost cleanup + duplicate healing) pass immediately,
 * instead of waiting out the 5-minute throttle. Called on MESSAGE_EDITED and
 * MESSAGE_DELETED so edited/removed messages get repaired on the very next
 * sync rather than up to 5 minutes later.
 */
function reverseSyncThrottleKey(collectionId, settings = {}) {
    return JSON.stringify([settings.vector_backend || 'standard', settings.source || '', collectionId]);
}

export function flagImmediateReverseSync(collectionId = getChatCollectionId(), settings = {}) {
    if (collectionId) reverseSyncThrottle.force(reverseSyncThrottleKey(collectionId, settings));
}

/**
 * VectHare+ R9: Computes the vectorization configuration fingerprint for the
 * current settings. SINGLE SOURCE OF TRUTH - used by BOTH vectorizeAll (manual
 * runs) and synchronizeChat (auto-sync) so the two can never drift apart.
 * Changed settings => different fingerprint => mixing vectors is detectable.
 *
 * Async because the model-field lookup lives in providers.js (dynamic import;
 * static import would create a circular dependency - providers.js has no
 * dependency on this file, but keeping the pattern consistent with the other
 * lazy imports here is safer).
 * Fingerprinting must degrade, never throw: any failure returns null and
 * callers skip the check (fail-open, same as R7).
 *
 * @param {object} settings VectHare settings
 * @returns {Promise<string|null>} Fingerprint, or null if computation failed
 */
async function computeVectorizationConfigFingerprint(settings) {
    try {
        const { getModelField } = await import('./providers.js');
        const modelField = getModelField(settings.source);
        const currentModel = modelField ? (settings[modelField] || '') : '';
        return String(getStringHash(JSON.stringify({
            source: settings.source,
            model: currentModel,
            chunking_strategy: settings.chunking_strategy,
            batch_size: settings.batch_size,
            ...(settings.chunking_strategy === 'conversation_turns'
                ? { conversation_turn_order: settings.conversation_turn_order || 'user_character' } : {}),
            chunk_size: settings.chunk_size,
        })));
    } catch (error) {
        console.warn('VectHare: Could not compute config fingerprint:', error.message);
        return null;
    }
}

// Keep successful reverse-sync times separately for each collection.
// Failed or metadata-incomplete passes are not treated as completed cleanup.
const reverseSyncThrottle = createReverseSyncThrottle(5 * 60 * 1000);

// VectHare+: guards against concurrent vectorizeAll runs (they share one
// singleton progress panel and would interleave Pause/Stop wiring)
let vectorizeRunActive = false;

// VectHare+ R9: true when the most recently ended run was ended by the user's
// Stop button. Consumed by the resume check (index.js) so a deliberate stop
// isn't followed by an immediate "unfinished vectorization!" toast nag.
let lastRunStoppedByUser = false;

/**
 * R9: Consume-on-read - returns whether the last ended run was user-stopped
 * and resets the flag, so a later natural check (chat change etc.) toasts again.
 * @returns {boolean}
 */
export function consumeWasLastRunStoppedByUser() {
    const value = lastRunStoppedByUser;
    lastRunStoppedByUser = false;
    return value;
}

/**
 * VectHare+: True while a vectorizeAll() run is in progress.
 * Used by index.js to suppress resume popups during an active run.
 * @returns {boolean}
 */
export function isVectorizationActive() {
    return vectorizeRunActive;
}
// A manual edit/delete can invalidate only the current collection's throttle.

/**
 * VectHare+ R12: Shared run acquisition for vectorizeAll AND repairChatVectors.
 * Enforces single-run re-entrancy and recovers a paused run's panel instead of
 * dead-ending the user. Returns true when the caller owns the run.
 * @returns {boolean}
 */
function tryAcquireVectorizationRun() {
    if (vectorizeRunActive) {
        // VectHare+ (R5): a PAUSED run whose panel the user closed would
        // dead-end here ("use the panel" → but the panel with the Resume
        // button was closed and unreachable). Recover by bringing the paused
        // run's panel back instead of rejecting.
        if (isVectorizationPaused()) {
            progressTracker.reveal();
            progressTracker.updateDisplay('⏸ Paused — use Resume or Stop on the panel');
            toastr.info(
                'A vectorization run is paused. Its controls have been brought back - use Resume or Stop on the panel.',
                'VectHare'
            );
        } else {
            toastr.info(
                'A vectorization/repair run is already active. Use Pause / Stop on the progress panel to control it.',
                'VectHare'
            );
        }
        console.warn('VectHare: run start ignored - a run is already active');
        return false;
    }
    vectorizeRunActive = true;
    lastRunStoppedByUser = false; // R9: fresh run clears any prior user-stop
    return true;
}

// ============================================================================
// RE-EXPORTS from collection-ids.js for backwards compatibility
// Other files importing from chat-vectorization.js will still work.
// ============================================================================

// Re-export getChatUUID (already imported above)
export { getChatUUID };

/**
 * Builds chat collection ID using the chat's unique UUID
 * Format: vecthare_chat_{charName}_{uuid}
 * @param {string} [chatUUID] Optional UUID override, otherwise uses current chat
 * @returns {string|null} Collection ID or null if no chat
 */
export function getChatCollectionId(chatUUID) {
    return buildChatCollectionId(chatUUID);
}

/**
 * Gets the legacy format collection ID for backwards compatibility
 * @param {string} [chatId] Optional chatId override, otherwise uses current chat
 * @returns {string|null} Legacy collection ID or null if no chat
 */
export function getLegacyChatCollectionId(chatId) {
    return buildLegacyChatCollectionId(chatId);
}

// Re-export getAllChatCollectionIds with adapted return format for backwards compat
export { getAllChatCollectionIds, parseCollectionId, parseRegistryKey };

/**
 * Gets the hash value for a string (with LRU caching)
 * @param {string} str Input string
 * @returns {number} Hash value
 */
function getStringHash(str) {
    const cached = hashCache.get(str);
    if (cached !== undefined) {
        return cached;
    }
    const hash = calculateHash(str);
    hashCache.set(str, hash);
    return hash;
}

/**
 * Gets message text without file attachments
 * Matches behavior of ST vectors extension for hash compatibility
 * R24: exported - scenes.js must use THIS exact formula for contained-chunk
 * hashes, or scene disable-linkage points at hashes that don't exist in the DB
 * @param {object} message Chat message object
 * @returns {string} Message text without attachment prefix
 */
export function getTextWithoutAttachments(message) {
    const fileLength = message?.extra?.fileLength || 0;
    return String(message?.mes || '').substring(fileLength).trim();
}

/**
 * Prepares items for insertion by adding source metadata
 * @param {object[]} items Array of vector items
 * @returns {object[]} Items with source metadata added
 */
function prepareItemsForInsertion(items) {
    return items.map(item => ({
        ...item,
        metadata: {
            ...item.metadata,
            source: 'chat',
        }
    }));
}

/**
 * Groups messages according to chunking strategy
 *
 * HASH DESIGN NOTE: Hashes are calculated from combined text ONLY (not message indices).
 * This is INTENTIONAL semantic deduplication - identical text produces identical embeddings,
 * so storing duplicates would waste storage and query budget. Individual message IDs are
 * preserved in metadata.messageIds and metadata.messageHashes for injection lookup.
 * DO NOT add message indices to hash calculation - it would break incremental sync and
 * disable deduplication with no functional benefit.
 *
 * @param {object[]} messages Messages to group
 * @param {string} strategy Chunking strategy: 'per_message', 'conversation_turns', 'message_batch'
 * @param {number} batchSize Number of messages per batch (for message_batch strategy)
 * @param {string} keywordLevel Keyword extraction level: 'off', 'minimal', 'balanced', 'aggressive'
 * @returns {object[]} Grouped message items ready for chunking
 */
function groupMessagesByStrategy(messages, strategy, batchSize = 4, keywordLevel = 'balanced', conversationTurnOrder = 'user_character') {
    if (!messages.length) return [];

    // R22: grouped strategies hash the combined RAW text (m.raw), not the
    // substituted display text - same volatile-identity fix as per_message.
    // Display/embedding text (m.text) stays substituted.
    const rawOf = (m) => m.raw ?? m.text;

    // Helper to extract keywords based on level
    const getKeywords = (text) => {
        if (keywordLevel === 'off') return [];
        return extractBM25Keywords(text, { level: keywordLevel });
    };

    switch (strategy) {
        case 'conversation_turns': {
            // Pair logical speaker turns, including consecutive messages.
            const grouped = [];
            for (const pair of groupConversationTurns(messages, conversationTurnOrder)) {
                // Combine texts with speaker labels
                const combinedText = pair.map(m => {
                    const role = m.is_user ? 'User' : 'Character';
                    return `[${role}]: ${m.text}`;
                }).join('\n\n');
                // R22: hash from RAW combined text (stable identity)
                const combinedRaw = pair.map(m => {
                    const role = m.is_user ? 'User' : 'Character';
                    return `[${role}]: ${rawOf(m)}`;
                }).join('\n\n');

                grouped.push({
                    text: combinedText,
                    hash: getStringHash(combinedRaw),
                    raw: combinedRaw,
                    index: pair[0].index,
                    keywords: getKeywords(combinedText),
                    metadata: {
                        strategy: 'conversation_turns',
                        messageIds: pair.map(m => m.index),
                        messageRefs: pair.map(m => m.messageRef).filter(Boolean),
                        speakers: pair.map(m => m.speaker),
                        messageHashes: pair.map(m => m.hash), // Store individual hashes for injection lookup
                        startIndex: pair[0].index,
                        endIndex: pair[pair.length - 1].index
                    }
                });
            }
            return grouped;
        }

        case 'message_batch': {
            // Group N messages together
            const grouped = [];
            for (let i = 0; i < messages.length; i += batchSize) {
                const batch = messages.slice(i, i + batchSize);
                // Combine texts with speaker labels
                const combinedText = batch.map(m => {
                    const role = m.is_user ? 'User' : 'Character';
                    return `[${role}]: ${m.text}`;
                }).join('\n\n');
                // R22: hash from RAW combined text (stable identity)
                const combinedRaw = batch.map(m => {
                    const role = m.is_user ? 'User' : 'Character';
                    return `[${role}]: ${rawOf(m)}`;
                }).join('\n\n');

                grouped.push({
                    text: combinedText,
                    hash: getStringHash(combinedRaw),
                    raw: combinedRaw,
                    index: batch[0].index,
                    keywords: getKeywords(combinedText),
                    metadata: {
                        strategy: 'message_batch',
                        batchSize: batch.length,
                        messageIds: batch.map(m => m.index),
                        messageRefs: batch.map(m => m.messageRef).filter(Boolean),
                        speakers: batch.map(m => m.speaker),
                        messageHashes: batch.map(m => m.hash), // Store individual hashes for injection lookup
                        startIndex: batch[0].index,
                        endIndex: batch[batch.length - 1].index
                    }
                });
            }
            return grouped;
        }

        case 'per_message':
        default:
            // Current behavior - each message is its own item
            return messages.map(m => ({
                text: m.text,
                hash: m.hash,
                raw: rawOf(m),
                index: m.index,
                is_user: m.is_user,
                keywords: getKeywords(m.text),
                metadata: {
                    strategy: 'per_message',
                    messageId: m.index,
                    ...(m.messageRef ? {messageRef:m.messageRef, messageRefs:[m.messageRef]} : {}),
                    speaker: m.speaker,
                    isUser: m.is_user,
                    messageHashes: [m.hash] // Consistent with grouped strategies
                }
            }));
    }
}

/**
 * VectHare+ R12: Gathers chat messages and groups them per the chunking
 * strategy. Extracted from synchronizeChat so repairChatVectors uses the
 * EXACT same grouping/hashing logic - repair and sync must agree on what
 * a "group" is, or their hash diffing diverges.
 * @param {object[]} chat Chat messages
 * @param {object} settings VectHare settings
 * @returns {object[]} Grouped items
 */
function collectGroupedItems(chat, settings, collectionId = null, durableUids = false) {
    const strategy = settings.chunking_strategy || 'per_message';
    const strategyBatchSize = settings.batch_size || 4;
    const keywordLevel = settings.keyword_extraction_level || 'balanced';

    const allMessages = [];
    for (let i = 0; i < chat.length; i++) {
        const msg = chat[i];
        if (msg.is_system) continue;
        const rawText = String(substituteParams(msg.mes));
        const text = cleanText(rawText);
        allMessages.push({
            text,
            raw: getTextWithoutAttachments(msg), // R22: unsubstituted, consumed by grouped strategies' stable hashing
            hash: getStringHash(getTextWithoutAttachments(msg)), // R22: raw text, not substituted - stable identity across reloads
            index: i,
            is_user: msg.is_user,
            speaker: msg.name || (msg.is_user ? 'User' : 'Character'),
            messageRef: durableUids ? messageReference(getVerifiedChatOriginId(), msg) : null
        });
    }

    const items = groupMessagesByStrategy(allMessages, strategy, strategyBatchSize, keywordLevel, settings.conversation_turn_order);
    const collision = checkCollision(items);
    if (!collision.safe) throw new Error('C07: distinct chat content shares a backend hash; write blocked pending safe migration');
    // Standard's physical key is a text hash. Merge same-text records while
    // retaining all message memberships; never send two conflicting writes.
    const merged = new Map();
    const qualifiedKey = collectionId ? `${settings.vector_backend || 'standard'}:${settings.source || 'transformers'}:${collectionId}` : null;
    for (const item of items) {
        const key = String(item.hash);
        if (!merged.has(key)) {
            const refs = item.metadata.messageRefs || [];
            item.metadata = {...item.metadata,
                ...(qualifiedKey ? {recordId: recordId(qualifiedKey, `hash:${key}`)} : {}),
                ...(refs.length ? {logicalGroupIds: [groupRecordLocalId(refs, strategy)]} : {}),
                contentFingerprint: fingerprint(item.raw),
                embeddingProfileFingerprint: embeddingProfileFingerprint(settings),
            };
            merged.set(key, item);
            continue;
        }
        const prior = merged.get(key);
        const combined = [...new Set([...(prior.metadata.messageRefs || []), ...(item.metadata.messageRefs || [])])];
        const indices = [...new Set([...(prior.metadata.messageIds || [prior.metadata.messageId]), ...(item.metadata.messageIds || [item.metadata.messageId])])].filter(Number.isInteger);
        prior.metadata = {...prior.metadata,
            messageRefs: combined, messageIds: indices,
            messageHashes: [...new Set([...(prior.metadata.messageHashes || []), ...(item.metadata.messageHashes || [])])],
            speakers: [...new Set([...(prior.metadata.speakers || [prior.metadata.speaker]), ...(item.metadata.speakers || [item.metadata.speaker])].filter(Boolean))],
            startIndex: Math.min(...indices), endIndex: Math.max(...indices),
            logicalGroupIds: [...new Set([...(prior.metadata.logicalGroupIds || []), ...(item.metadata.messageRefs?.length ? [groupRecordLocalId(item.metadata.messageRefs, strategy)] : [])])],
        };
    }
    return [...merged.values()];
}

/**
 * VectHare+ R14: Unified message-ID extraction from chunk/group metadata.
 * per_message chunks store `messageId` (singular number); grouped strategies
 * store `messageIds` (array). Repair's replacement detection originally read
 * ONLY `messageIds`, so on per_message chats (the default) NO replacements
 * were ever detected - edited messages had their stale vectors deleted but
 * the new text was never re-vectorized. Handles both shapes, numeric strings,
 * and a defensively-nested metadata object.
 * @param {object} meta Chunk or group metadata
 * @returns {number[]} Message indices
 */
function extractMessageIds(meta) {
    if (!meta) return [];
    const nested = meta.metadata || {};
    const raw = Array.isArray(meta.messageIds) ? meta.messageIds
        : Array.isArray(nested.messageIds) ? nested.messageIds
        : (meta.messageId != null) ? [meta.messageId]
        : (nested.messageId != null) ? [nested.messageId]
        : [];
    return raw.map(v => Number(v)).filter(v => Number.isFinite(v));
}

/**
 * Filters out chunks that have been disabled by scene vectorization
 * @param {object[]} chunks Chunks to filter
 * @returns {object[]} Chunks not disabled by scenes
 */
function filterSceneDisabledChunks(chunks) {
    const filtered = chunks.filter(chunk => {
        const isDisabled = isChunkDisabledByScene(chunk.hash);
        if (isDisabled) {
            console.debug(`VectHare: Chunk ${chunk.hash} is disabled by scene`);
        }
        return !isDisabled;
    });

    if (filtered.length !== chunks.length) {
        console.log(`VectHare: Scene filtering: ${chunks.length} → ${filtered.length} chunks (${chunks.length - filtered.length} disabled by scenes)`);
    }

    return filtered;
}

/**
 * Applies chunk-level conditions to filter results
 * @param {object[]} chunks Chunks with metadata
 * @param {object[]} chat Chat messages for context
 * @param {object} settings VectHare settings
 * @returns {Promise<object[]>} Filtered chunks
 */
async function applyChunkConditions(chunks, chat, settings) {
    // First filter out chunks disabled by scenes
    let filtered = filterSceneDisabledChunks(chunks);

    // Check if any chunks have conditions (from chunk metadata)
    const chunksWithConditions = filtered.map(chunk => {
        const chunkMeta = getChunkMetadata(chunk.hash);
        if (chunkMeta?.conditions?.enabled) {
            return { ...chunk, conditions: chunkMeta.conditions };
        }
        return chunk;
    });

    // If no chunks have conditions, return filtered
    const hasAnyConditions = chunksWithConditions.some(c => c.conditions?.enabled);
    if (!hasAnyConditions) {
        return filtered;
    }

    // Chunk conditions can scan farther back than semantic query construction.
    const conditionDepth = chunksWithConditions.reduce((depth, c) =>
        getRequiredConditionDepth(c.conditions, depth), 0);
    const context = buildSearchContext(chat, Math.max(settings.query || 10, conditionDepth), chunksWithConditions, {
        generationType: settings.generationType || 'normal',
        isGroupChat: settings.isGroupChat || false,
        currentCharacter: settings.currentCharacter || null,
        activeLorebookEntries: settings.activeLorebookEntries || [],
        activationHistory: {} // per-item scope is installed before rule evaluation
    });

    // Filter chunks by their conditions
    const chatId = currentChatIdentity().originId || currentChatIdentity().chatId;
    const collectionKeyFor = chunk => chunk.collectionKey || (chunk.collectionId
        ? `${chunk.backend || settings.vector_backend || 'standard'}:${chunk.source || settings.source || 'transformers'}:${chunk.collectionId}` : null);
    const conditionFilteredChunks = chunksWithConditions.flatMap(chunk => {
        const frequencyRule = chunk.conditions?.rules?.find(rule => rule.type === 'frequency');
        const scope = frequencyRule?.settings?.scope === 'session' ? 'session' : 'conversation';
        const activationHistory = scopedActivationHistory.snapshot({chatId,collectionKey:collectionKeyFor(chunk),scope});
        return filterChunksByConditions([chunk], {...context,activationHistory});
    });

    // Track activation for frequency conditions
    conditionFilteredChunks.forEach(chunk => {
        if (chunk.conditions?.enabled) {
            scopedActivationHistory.record({
                chatId,
                collectionKey:collectionKeyFor(chunk),
                scope:chunk.conditions?.rules?.find(rule => rule.type === 'frequency')?.settings?.scope === 'session' ? 'session' : 'conversation',
                hash:chunk.hash,messageCount:chat.length
            });
        }
    });

    console.log(`VectHare: Chunk conditions filtered ${filtered.length} → ${conditionFilteredChunks.length}`);
    return conditionFilteredChunks;
}


/**
 * Rerank chunks using BananaBread's reranking endpoint
 * @param {string} query The search query
 * @param {Array} chunks Array of chunks with text
 * @param {object} settings VectHare settings
 * @returns {Promise<Array>} Chunks with updated scores from reranker
 */
async function rerankWithBananaBread(query, chunks, settings) {
    if (!chunks.length) return chunks;

    const apiUrl = settings.use_alt_endpoint ? settings.alt_endpoint_url : 'http://localhost:8008';
    const documents = chunks.map(c => c.text);

    try {
        const response = await fetch('/api/plugins/similharity/rerank', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                apiUrl,
                apiKey: settings.bananabread_api_key || '', // Include API key for authentication
                query,
                documents,
                top_k: chunks.length
            }),
        });

        if (!response.ok) {
            console.warn('VectHare: Reranking failed, using original scores');
            return chunks;
        }

        const data = await response.json();
        if (!data.results || !Array.isArray(data.results)) {
            return chunks;
        }

        // Apply rerank scores - results are sorted by score desc
        // Each result has { index, score } where index refers to original position
        const rerankedChunks = data.results.map(r => {
            const chunk = { ...chunks[r.index] };
            chunk.rerankScore = r.score;
            chunk.originalScore = chunk.score;
            chunk.score = r.score; // Replace score with rerank score
            return chunk;
        });

        console.log(`VectHare: Reranked ${rerankedChunks.length} chunks with BananaBread`);
        return rerankedChunks;
    } catch (error) {
        console.warn('VectHare: Reranking error:', error.message);
        return chunks;
    }
}

/**
 * Synchronizes chat with vector index using simple FIFO queue
 *
 * How it works:
 * 1. Get all messages, get all vectorized hashes from DB
 * 2. Queue = messages not yet in DB (by hash)
 * 3. Process batch: take message, chunk it, insert chunks, remove from queue
 * 4. Repeat until queue empty
 *
 * @param {object} settings VectHare settings
 * @param {number} batchSize Number of messages to process per call
 * @returns {Promise<object>} Progress info
 */
export async function synchronizeChat(settings, batchSize = 5, bypassAutoSync = false, parentJob = null) {
    // Capture identity BEFORE any asynchronous work; manual runs share their parent's job.
    let job;
    try {
        job = parentJob || chatJobs.startJob({kind:'sync',collectionKey:`${settings.vector_backend || 'standard'}:${settings.source || 'transformers'}:${getChatCollectionId() || ''}`});
        job.assertCurrent();
    } catch (error) {
        if (error instanceof StaleJobError) return {remaining:-1,messagesProcessed:0,chunksCreated:0,stale:true};
        throw error;
    }
    try {
        return await synchronizeChatScoped(settings,batchSize,bypassAutoSync,job);
    } catch (error) {
        if (error instanceof StaleJobError) return {remaining:-1,messagesProcessed:0,chunksCreated:0,stale:true};
        throw error;
    } finally {if(!parentJob) job.finish();}
}

async function synchronizeChatScoped(settings,batchSize,bypassAutoSync,job) {
    job.assertCurrent();
    // Build proper collection ID using chat UUID first
    const collectionId = getChatCollectionId();
    job.assertCurrent();
    console.log(`🔍 VectHare DEBUG: getChatCollectionId() returned: "${collectionId}"`);
    console.log(`🔍 VectHare DEBUG: settings.vector_backend = "${settings.vector_backend}"`);
    console.log(`🔍 VectHare DEBUG: settings.source = "${settings.source}"`);
    if (!collectionId) {
        return { remaining: -1, messagesProcessed: 0, chunksCreated: 0 };
    }

    // Check per-collection autoSync setting instead of global enabled_chats.
    // VectHare+: bypassAutoSync lets an explicitly user-started run (Sync Chat /
    // Continue Vectorization) proceed even when background auto-sync is off.
    const { isCollectionAutoSyncEnabled, getCollectionMeta, setCollectionMeta } = await import('./collection-metadata.js');
    job.assertCurrent();
    if (!bypassAutoSync && !isCollectionAutoSyncEnabled(collectionId)) {
        return { remaining: -1, messagesProcessed: 0, chunksCreated: 0 };
    }

    // VectHare+ R9: config fingerprint gate for AUTO-SYNC. vectorizeAll enforces
    // this for manual runs; without this gate, changed embedding settings +
    // auto-sync enabled would silently embed new messages with vectors
    // incompatible with the existing collection (silent poisoning - exactly
    // what the user flagged as important). On mismatch: refuse to add vectors,
    // warn once, fail-closed. Manual runs bypass via bypassAutoSync because
    // their own (stricter, blocking) check already ran in vectorizeAll.
    if (!bypassAutoSync) {
        try {
            const configFingerprint = await computeVectorizationConfigFingerprint(settings);
            job.assertCurrent();
            if (configFingerprint) {
                const storedFingerprint = getCollectionMeta(collectionId).vectorizationConfigFingerprint;
                if (storedFingerprint && storedFingerprint !== configFingerprint) {
                    if (!autoSyncFingerprintWarned) {
                        autoSyncFingerprintWarned = true;
                        toastr.error(
                            'Auto-sync paused: vectorization settings changed since this collection was created. New messages are NOT being vectorized (mixing incompatible vectors is prevented). Restore the previous settings, or re-vectorize the collection via Content Vectorizer > Replace All.',
                            'VectHare: Auto-sync blocked',
                            { timeOut: 0, closeOnHover: false }
                        );
                    }
                    console.warn('VectHare: Auto-sync blocked - vectorization config fingerprint mismatch');
                    return { remaining: -1, messagesProcessed: 0, chunksCreated: 0 };
                }
                // Record the fingerprint if absent so future manual runs validate
                // against what auto-sync actually used
                if (!storedFingerprint) {
                    setCollectionMeta(collectionId, { vectorizationConfigFingerprint: configFingerprint });
                }
            }
        } catch (fpError) {
            if (fpError instanceof StaleJobError) throw fpError;
            // Fingerprint failures must never block background sync (fail-open)
            console.warn('VectHare: Auto-sync fingerprint check failed (continuing):', fpError.message);
        }
    }

    // Per Scene strategy: don't auto-vectorize on message events
    // Scenes are vectorized when user marks scene end (via createSceneChunk)
    if (settings.chunking_strategy === 'per_scene') {
        return { remaining: 0, messagesProcessed: 0, chunksCreated: 0 };
    }

    // VectHare+: While paused, automatic sync stays idle (resume via panel button
    // or page reload; the pending queue is re-derived from the DB on next run)
    if (isVectorizationPaused()) {
        return { remaining: -1, messagesProcessed: 0, chunksCreated: 0 };
    }

    // VectHare+ R16 FIX (mutual exclusion): background auto-sync previously had
    // NO exclusion against a manual run (repair or Sync Chat) - both could
    // write to the same collection CONCURRENTLY (syncBlocked only guards
    // sync-vs-sync). Two writers racing = reads interleaving with each other's
    // writes = the class of lost/duplicate insert the user hit on Qdrant.
    // Auto-sync now stands down whenever a manual run owns the collection.
    // Manual runs pass bypassAutoSync=true (they ARE the owner).
    if (!bypassAutoSync && vectorizeRunActive) {
        console.debug('VectHare: Auto-sync deferred - a manual vectorization/repair run is active');
        return { remaining: -1, messagesProcessed: 0, chunksCreated: 0 };
    }

    try {
        await waitUntilCondition(() => !syncBlocked && !is_send_press, 1000);
    } catch {
        syncBlocked = false; // VEC-30: Reset flag on timeout
        return { remaining: -1, messagesProcessed: 0, chunksCreated: 0 };
    }

    try {
        syncBlocked = true;
        job.assertCurrent();
        const context = getContext();

        if (!getCurrentChatId() || !Array.isArray(context.chat)) {
            return { remaining: -1, messagesProcessed: 0, chunksCreated: 0 };
        }

        // NOTE: Registration happens AFTER first successful insert to prevent ghosts
        let isRegistered = false;

        // Step 1: What's already vectorized? (source of truth = DB)
        const existingHashes = new Set(await getSavedHashes(collectionId, settings));
        job.assertCurrent();

        // Step 2: Build list of messages NOT in DB
        const strategy = settings.chunking_strategy || 'per_message';

        // R12: gathering extracted to collectGroupedItems (shared with repairChatVectors)
        const durableUids = await ensureDurableMessageUids(context.chat, context, job);
        job.assertCurrent();
        const groupedItems = collectGroupedItems(context.chat, settings, collectionId, durableUids);

        // ========================================================================
        // VectHare+ Step 1.5: Reverse sync (ghost vector cleanup)
        //
        // Forward sync adds missing hashes, but hash-diffing alone never notices
        // history changing behind the DB's back:
        //   Edited message → text changes → hash changes → old hash obsolete
        //   Deleted message → old hash remains = retrievable "ghost vector"
        // This pass deletes stored hashes that no longer correspond to any
        // current chat content.
        //
        // IMPORTANT: the keep-set MUST be built from groupedItems (the same
        // grouped/combined hashes that forward sync compares against), NOT raw
        // per-message hashes - under conversation_turns/message_batch strategies
        // stored hashes are combined-text hashes and would otherwise all look
        // like ghosts.
        //
        // Protected from pruning (chunks that do not map 1:1 to chat messages):
        //   - Scene composite chunks (DB metadata.isScene === true)
        //   - Dual-vector summary chunks (isSummary* flags / parentHash)
        //   - Chunks marked disabled-by-scene in settings-layer chunk metadata
        //
        // Safety: this pass only runs when per-chunk metadata is resolvable from
        // the backend, so special chunks are always detectable. If metadata is
        // unavailable it is skipped entirely rather than guessed.
        //
        // PERFORMANCE (R6 FIX): this pass fetches FULL collection metadata
        // (chunk list up to VECTOR_LIST_LIMIT entries), which is expensive on
        // large chats. synchronizeChat runs on EVERY message event, and before
        // R6 it ran this pass every time - heavy payload per chat message.
        // Now throttled to at most once per 5 minutes across ALL sync passes
        // (event-driven and vectorizeAll iterations alike). Ghost cleanup still
        // happens promptly after edits/deletes; it just stops being a
        // per-message tax on large collections.
        // ========================================================================
        const throttleKey = reverseSyncThrottleKey(collectionId, settings);
        if (existingHashes.size > 0 && reverseSyncThrottle.shouldRun(throttleKey)) {
            try {
                const { getChunkMetadata } = await import('./collection-metadata.js');

                // Keep-set = exactly the hashes forward sync would keep
                const keepHashes = new Set(groupedItems.map(item => String(item.hash)));

                const collectionData = await getSavedHashes(collectionId, settings, true);
                job.assertCurrent();

                const allStoredHashes = Array.isArray(collectionData) ? collectionData : (collectionData?.hashes || []);

                const metaByHash = (collectionData && !Array.isArray(collectionData) && Array.isArray(collectionData.metadata) && collectionData.metadata.length > 0)
                    ? new Map(collectionData.hashes.map((h, i) => [String(h), collectionData.metadata[i] || {}]))
                    : null;

                const isProtectedMeta = (meta) => {
                    if (!meta) return false;
                    if (meta.isScene === true) return true;
                    if (meta.isSummaryChunk === true || meta.isSummary === true || meta.isSummaryVector === true) return true;
                    if (meta.parentHash != null) return true;
                    return false;
                };

                if (metaByHash) {
                    // Check both DB-side metadata and settings-layer chunk metadata
                    const isProtected = (hash, meta) => {
                        if (isProtectedMeta(meta)) return true;
                        const chunkMeta = getChunkMetadata(hash);
                        if (chunkMeta && (isProtectedMeta(chunkMeta) || chunkMeta.disabledByScene != null)) return true;
                        return false;
                    };

                    // R12 FIX: duplicate healing moved here (after the protected-
                    // class check) and now SKIPS protected hashes. Previously a
                    // duplicated scene/summary chunk would have had ALL copies
                    // deleted and never re-added (forward sync cannot recreate
                    // scene/summary chunks) = silent data loss.
                    const dupCounts = new Map();
                    for (const h of allStoredHashes) {
                        const k = String(h);
                        dupCounts.set(k, (dupCounts.get(k) || 0) + 1);
                    }
                    const duplicateHashes = [...dupCounts.entries()]
                        .filter(([h, c]) => c > 1 && !isProtected(h, metaByHash.get(h) || null))
                        .map(([h]) => h);
                    if (duplicateHashes.length > 0 || metaByHash.size > 0) {
                        // No verified complete inventory/tenant ownership is available
                        // from these adapters: preserve originals instead of doing
                        // a pre-insert cleanup (C01/C11 will provide evidence).
                        console.warn('VectHare: Reverse-sync destructive cleanup deferred until backend inventory and ownership can be proven');
                    }
                    // Only a metadata-backed, successfully completed pass is
                    // eligible for throttling. Otherwise the next sync retries.
                    // A clean, metadata-backed pass may throttle; any deferred
                    // cleanup must be retried on the next synchronization.
                    if (duplicateHashes.length === 0 && [...metaByHash].every(([h,meta]) => isProtected(h,meta) || keepHashes.has(h))) {
                        reverseSyncThrottle.markSuccessful(throttleKey);
                    }
                } else {
                    console.debug('VectHare: Reverse sync skipped - chunk metadata unavailable from backend');
                }
            } catch (reverseSyncError) {
                if (reverseSyncError instanceof StaleJobError) throw reverseSyncError;
                // Never block forward vectorization on reverse-sync failure
                console.warn('VectHare: Reverse sync failed (forward vectorization continues):', reverseSyncError.message);
            }
        }

        // Filter out already vectorized items (by their grouped hash)
        const queue = new Queue();
        for (const item of groupedItems) {
            if (!existingHashes.has(item.hash)) {
                queue.enqueue(item);
            }
        }

        if (queue.isEmpty()) {
            return { remaining: 0, messagesProcessed: 0, chunksCreated: 0 };
        }

        // Step 3: Process batch
        let itemsProcessed = 0;
        let chunksCreated = 0;
        let itemsFailed = 0;
        const label = strategy === 'per_message' ? 'Message' : 'Group';

        while (!queue.isEmpty() && itemsProcessed < batchSize) {
            job.assertCurrent();
            // VectHare+: honor Pause/Stop inside the batch loop. The rest of the
            // queue is left untouched (nothing lost) and every already-successful
            // item is already persisted, so any later run continues seamlessly.
            if (isVectorizationStopped() || isVectorizationPaused()) {
                console.log(`VectHare: Sync ${isVectorizationStopped() ? 'stopped' : 'paused'} by user with ${queue.size} item(s) still pending (completed work kept)`);
                break;
            }
            const item = queue.dequeue();

            try {
                // Prepare item for insertion (add source metadata)
                const chunks = prepareItemsForInsertion([item]);

                // Insert chunks (insertVectorItems handles duplicates at DB level)
                // R13: pass the Stop signal - Stop now cancels the in-flight
                // embedding/insert request instead of draining it
                if (chunks.length > 0) {
                    const writeReceipt = await chatJobs.trackWrite(job, () => insertVectorItems(collectionId, chunks, settings, (embedded, total) => {
                        if (job.signal.aborted) return;
                        // R7 FIX: per-item embedding progress is always 1/1 here
                        // (one item per call) and previously clobbered the panel's
                        // chunk counter ("Chunks 1/1"). vectorizeAll now feeds the
                        // panel collection-wide totals instead - this callback only
                        // updates the current-item line.
                        console.log(`[Chat Vectorization] Embedding progress callback: ${embedded}/${total}`);

                        // Determine phase based on progress (0-50% = Embedding, 50-100% = Writing)
                        const progressPercent = (embedded / total) * 100;
                        const phase = progressPercent <= 50 ? 'Embedding' : 'Writing to database';
                        job.assertCurrent();
                        progressTracker.updateCurrentItem(`${label} ${itemsProcessed}/${batchSize} - ${phase}: ${embedded}/${total} chunks`);
                    }, anyJobSignal(job.signal, bypassAutoSync ? getStopSignal() : null)), {collectionKey:job.snapshot.collectionKey});
                    job.assertCurrent();
                    if (writeReceipt?.status === 'uncertain' || writeReceipt?.requiresReconciliation) {
                        itemsFailed++;
                        console.warn('VectHare: Sync insertion requires reconciliation before claiming completion');
                    } else {
                    chunksCreated += chunks.length;

                    // Register on first successful insert (prevents ghost collections)
                    if (!isRegistered) {
                        // Construct proper registry key: backend:source:collectionId
                        const backend = settings.vector_backend || 'standard';
                        const source = settings.source || 'transformers';
                        const registryKey = `${backend}:${source}:${collectionId}`;
                        console.log(`🔍 VectHare DEBUG: Registering collection with key: "${registryKey}"`);
                        console.log(`🔍 VectHare DEBUG: Components: backend="${backend}", source="${source}", collectionId="${collectionId}"`);
                        registerCollection(registryKey);
                        isRegistered = true;
                        console.log(`VectHare: Registered collection ${registryKey} after first successful insert`);
                    }
                    }
                }
            } catch (itemError) {
                // R13: an aborted request (user pressed Stop) is a CLEAN stop,
                // not a failed item - exit the batch loop immediately. The loop
                // top then handles the normal stop bookkeeping.
                if (job.signal.aborted) throw new StaleJobError('chat-changed');
                if (isVectorizationStopped()) {
                    break;
                }
                // Log error but continue processing other items
                console.warn(`VectHare: Failed to process item (hash: ${item.hash}, index: ${item.index}):`, itemError.message);
                itemsFailed++;
                // Don't rethrow - continue with next item
            }

            itemsProcessed++;
            progressTracker.updateCurrentItem(`${label} ${itemsProcessed}/${batchSize}${itemsFailed > 0 ? ` (${itemsFailed} failed)` : ''}`);
        }

        job.assertCurrent();
        progressTracker.updateCurrentItem(null);

        if (itemsFailed > 0) {
            console.warn(`VectHare: Sync completed with ${itemsFailed} failed items out of ${itemsProcessed}`);
        }

        return {
            remaining: queue.size,
            messagesProcessed: itemsProcessed,
            chunksCreated,
            itemsFailed,
            total: groupedItems.length // R7: whole-collection group count for progress display
        };
    } catch (error) {
        console.error('VectHare: Sync failed', error);
        throw error;
    } finally {
        syncBlocked = false;
    }
}

// ============================================================================
// REARRANGE CHAT PIPELINE - Helper Functions
// ============================================================================
// These functions break down the rearrangeChat logic into discrete stages
// for better maintainability and testability.
// ============================================================================

/**
 * Stage 1: Gather all collections that should be queried
 * @param {object} settings VectHare settings
 * @returns {string[]} Array of collection IDs to query
 */
function gatherCollectionsToQuery(settings) {
    const chatCollectionId = getChatCollectionId();
    const currentChatId = getCurrentChatId();
    const chatPolicy = getChatCollectionPolicy(currentChatId);
    const collectionsToQuery = [];

    // Include chat collection if it's enabled AND we have a valid collection ID
    // Uses per-collection enabled state, not global enabled_chats
    if (chatCollectionId && isCollectionEnabled(chatCollectionId)) {
        collectionsToQuery.push(chatCollectionId);
    }

    // Get all other registered collections that are enabled
    const registry = getCollectionRegistry();
    for (const registryKey of registry) {
        // Use proper registry key parser to extract collection ID
        const parsedKey = parseRegistryKey(registryKey);
        const collectionId = parsedKey.collectionId;

        // Skip if this is the current chat collection (already handled above)
        if (collectionId === chatCollectionId) {
            continue;
        }

        // Check if collection is enabled. getCollectionMeta/isCollectionEnabled resolve
        // metadata across bare-id/registry-key/legacy forms internally, so the bare
        // collectionId works for both the enabled check and the actual query.
        if (isCollectionEnabled(collectionId)) {
            collectionsToQuery.push(collectionId);
        }
    }

    // Add explicitly selected/forced collections for this chat. These bypass
    // trigger/condition activation later, but still respect disabled state here.
    for (const selectedId of chatPolicy.selectedCollections || []) {
        const alreadyIncluded = collectionsToQuery.some(id => {
            const parsedExisting = parseRegistryKey(id);
            const parsedSelected = parseRegistryKey(selectedId);
            return id === selectedId || parsedExisting.collectionId === parsedSelected.collectionId;
        });

        if (!alreadyIncluded && isCollectionEnabled(selectedId)) {
            collectionsToQuery.push(selectedId);
        }
    }

    // The UI's only_selected policy applies to lorebooks, not chat/document collections.
    return applyChatCollectionPolicy(collectionsToQuery, currentChatId, { lorebooksOnly: true });
}

/**
 * Stage 2: Build the search query from recent messages
 * @param {object[]} chat Current chat messages
 * @param {object} settings VectHare settings
 * @returns {string} Query text
 */
function buildSearchQuery(chat, settings) {
    const recentMessages = chat
        .filter(x => !x.is_system)
        .slice(-Math.max(1, Number(settings.query) || 3))
        .map(x => substituteParams(x.mes));

    return recentMessages.join('\n').trim();
}

/**
 * Stage 3: Query all active collections and merge results
 * @param {string[]} activeCollections Collections that passed activation filters
 * @param {string} queryText Search query
 * @param {object} settings VectHare settings
 * @param {object[]} chat Current chat messages
 * @param {object} debugData Debug tracking object
 * @returns {Promise<object[]>} Array of chunk objects with scores
 */
async function queryAndMergeCollections(activeCollections, queryText, settings, chat, debugData) {
    let chunksForVisualizer = [];
    const effectiveTopK = settings.top_k ?? settings.insert;

    // PERF: Build hash-to-message Map once for O(1) lookups instead of O(n) find() per chunk
    const chatHashMap = new Map();
    for (const msg of chat) {
        if (msg.mes) {
            // R22: raw-text hash - must match the storage-side formula, or the
            // text-fallback lookup silently misses macro-containing messages
            const hash = getStringHash(getTextWithoutAttachments(msg));
            if (!chatHashMap.has(hash)) {
                chatHashMap.set(hash, msg);
            }
        }
    }

    const queryFailures = [];
    let successfulQueries = 0;
    for (const collectionId of activeCollections) {
        try {
            const queryResults = await queryCollection(collectionId, queryText, effectiveTopK, settings);

            if (queryResults?.error) throw new Error(queryResults.error);
            successfulQueries++;

            // TRACE: Vector query results for this collection
            addTrace(debugData, 'vector_search', `Query completed for ${collectionId}`, {
                hashesReturned: queryResults.hashes.length,
                hashes: queryResults.hashes.slice(0, 5),
                scoreBreakdown: queryResults.metadata.slice(0, 5).map(m => ({
                    finalScore: m.score?.toFixed(3),
                    originalScore: m.originalScore?.toFixed(3),
                    keywordBoost: m.keywordBoost?.toFixed(2) || '1.00',
                    matchedKeywords: m.matchedKeywords || [],
                    keywordBoosted: m.keywordBoosted || false
                }))
            });

            console.log(`VectHare: Retrieved ${queryResults.hashes.length} chunks from ${collectionId}`);

            // Build chunks with text for visualizer
            const collectionChunks = queryResults.metadata.map((meta, idx) => {
                const hash = queryResults.hashes[idx];

                // Prefer text from metadata (stored in vector DB)
                let text = meta.text;
                let textSource = 'metadata';

                // Fallback: try to find in chat messages if not in metadata
                // PERF: Use pre-built Map for O(1) lookup instead of O(n) find()
                if (!text) {
                    const chatMessage = chatHashMap.get(hash);
                    text = chatMessage ? substituteParams(chatMessage.mes) : '(text not found)';
                    textSource = chatMessage ? 'chat_lookup' : 'not_found';

                    // Debug: Log when text is not found
                    if (textSource === 'not_found') {
                        console.warn(`[VectHare] ⚠️ Chunk text not found! hash=${hash}, meta.text=${meta.text ? 'exists' : 'missing'}, chatMessage=${chatMessage ? 'found' : 'not found'}`);
                    }
                }

                // TRACE: Record initial chunk state
                recordChunkFate(debugData, hash, 'vector_search', 'passed', null, {
                    finalScore: meta.score ?? 1.0,
                    originalScore: meta.originalScore,
                    keywordBoost: meta.keywordBoost,
                    matchedKeywords: meta.matchedKeywords,
                    textSource,
                    textLength: text?.length || 0,
                    collectionId,
                    recordId: (typeof meta.recordId === 'string' && meta.recordId.startsWith(`${settings.vector_backend || 'standard'}:${settings.source || 'transformers'}:${collectionId}#`) ? meta.recordId : `${settings.vector_backend || 'standard'}:${settings.source || 'transformers'}:${collectionId}#hash%3A${encodeURIComponent(String(hash))}`)
                });

                return {
                    hash: hash,
                    recordId: (typeof meta.recordId === 'string' && meta.recordId.startsWith(`${settings.vector_backend || 'standard'}:${settings.source || 'transformers'}:${collectionId}#`) ? meta.recordId : `${settings.vector_backend || 'standard'}:${settings.source || 'transformers'}:${collectionId}#hash%3A${encodeURIComponent(String(hash))}`),
                    metadata: meta,
                    score: meta.score ?? 1.0,
                    originalScore: meta.originalScore,
                    keywordBoost: meta.keywordBoost,
                    matchedKeywords: meta.matchedKeywords,
                    matchedKeywordsWithWeights: meta.matchedKeywordsWithWeights,
                    keywordBoosted: meta.keywordBoosted,
                    similarity: meta.score ?? 1.0,
                    text: text,
                    index: meta.messageId || meta.index || 0,
                    collectionId: collectionId,
                    decayApplied: false,
                    // Hybrid search scores
                    vectorScore: meta.vectorScore,
                    textScore: meta.textScore,
                    hybridSearch: meta.hybridSearch
                };
            });

            chunksForVisualizer.push(...collectionChunks);
        } catch (error) {
            console.warn(`VectHare: Failed to query collection ${collectionId}:`, error.message);
            queryFailures.push({ collectionId, error: error.message });
            addTrace(debugData, 'vector_search', `Query failed for ${collectionId}`, {
                error: error.message
            });
        }
    }

    // Keep partial failures in diagnostics and report them to the user.
    debugData.queryFailures = queryFailures;
    if (queryFailures.length > 0) {
        if (successfulQueries === 0) {
            throw new Error(`All ${queryFailures.length} collection queries failed; no memory results are available`);
        }
        console.warn(`VectHare: ${queryFailures.length} of ${activeCollections.length} collection queries failed; using partial results`);
        if (typeof toastr !== 'undefined') {
            toastr.warning(`${queryFailures.length} memory collection(s) could not be searched; results may be incomplete.`, 'VectHare');
        }
    }

    // Sort merged results by score (descending) and limit to topK
    chunksForVisualizer.sort((a, b) => b.score - a.score);
    chunksForVisualizer = chunksForVisualizer.slice(0, effectiveTopK);

    return chunksForVisualizer;
}

/**
 * Stage 3.5: Expand summary chunks to their parent chunks (dual-vector system)
 * When a summary chunk matches a query, we want to inject the full parent text instead.
 * The summary's score is preserved since that's what semantically matched.
 *
 * @param {object[]} chunks Chunks from query results
 * @param {string[]} activeCollections Collections that were queried
 * @param {object} settings VectHare settings
 * @param {object} debugData Debug tracking object
 * @returns {Promise<object[]>} Chunks with summaries expanded to parents
 */
async function expandSummaryChunks(chunks, activeCollections, settings, debugData) {
    const expandedChunks = [];
    const parentHashesNeeded = new Map(); // parentHash -> { summaryChunk, collectionId }

    // First pass: identify which chunks are summaries and need parent expansion
    for (const chunk of chunks) {
        const meta = chunk.metadata || {};
        const isSummary = meta.isSummaryChunk || meta.isSummary || meta.isSummaryVector;
        const parentHash = meta.parentHash;

        if (isSummary && parentHash) {
            // Track this summary for parent lookup
            parentHashesNeeded.set(String(parentHash), {
                summaryChunk: chunk,
                collectionId: chunk.collectionId
            });

            addTrace(debugData, 'summary_expansion', `Summary chunk found, will expand to parent`, {
                summaryHash: chunk.hash,
                parentHash: parentHash,
                summaryScore: chunk.score?.toFixed(3),
                collectionId: chunk.collectionId
            });
        } else {
            // Not a summary, keep as-is
            expandedChunks.push(chunk);
        }
    }

    // If no summaries found, return original chunks
    if (parentHashesNeeded.size === 0) {
        return chunks;
    }

    // Second pass: fetch parent chunks from the vector DB
    // Group by collection for efficiency
    const parentsByCollection = new Map();
    for (const [parentHash, info] of parentHashesNeeded) {
        const collectionId = info.collectionId;
        if (!parentsByCollection.has(collectionId)) {
            parentsByCollection.set(collectionId, []);
        }
        parentsByCollection.get(collectionId).push({ parentHash, summaryChunk: info.summaryChunk });
    }

    // Fetch parents from each collection
    for (const [collectionId, parentInfos] of parentsByCollection) {
        try {
            // Get all chunks from this collection with metadata
            const collectionData = await getSavedHashes(collectionId, settings, true);

            if (collectionData && collectionData.metadata) {
                // Build a lookup map of hash -> chunk data
                const chunkLookup = new Map();
                for (let i = 0; i < collectionData.hashes.length; i++) {
                    const hash = String(collectionData.hashes[i]);
                    chunkLookup.set(hash, collectionData.metadata[i]);
                }

                // Find each parent and create expanded chunk
                for (const { parentHash, summaryChunk } of parentInfos) {
                    const parentData = chunkLookup.get(String(parentHash));

                    if (parentData) {
                        // Found parent - create expanded chunk with parent's text but summary's score
                        const expandedChunk = {
                            ...summaryChunk,
                            hash: parentHash, // Use parent's hash for deduplication
                            text: parentData.text || parentData.mes || '(parent text not found)',
                            metadata: {
                                ...parentData,
                                expandedFromSummary: true,
                                originalSummaryHash: summaryChunk.hash,
                                originalSummaryScore: summaryChunk.score
                            },
                            // Keep summary's score since that's what matched the query
                            score: summaryChunk.score,
                            originalScore: summaryChunk.originalScore,
                            expandedFromSummary: true
                        };

                        expandedChunks.push(expandedChunk);

                        recordChunkFate(debugData, parentHash, 'summary_expansion', 'passed',
                            `Expanded from summary #${summaryChunk.hash}`, {
                                summaryHash: summaryChunk.hash,
                                parentTextLength: expandedChunk.text?.length || 0,
                                inheritedScore: summaryChunk.score?.toFixed(3)
                            });

                        addTrace(debugData, 'summary_expansion', `Parent chunk retrieved`, {
                            parentHash: parentHash,
                            summaryHash: summaryChunk.hash,
                            parentTextLength: expandedChunk.text?.length || 0
                        });
                    } else {
                        // Parent not found - keep the summary chunk as fallback
                        console.warn(`VectHare: Parent chunk ${parentHash} not found for summary ${summaryChunk.hash}, using summary text`);
                        expandedChunks.push(summaryChunk);

                        recordChunkFate(debugData, summaryChunk.hash, 'summary_expansion', 'passed',
                            `Parent not found, using summary text`, {
                                parentHash: parentHash,
                                fallback: true
                            });
                    }
                }
            } else {
                // Couldn't get collection data - keep summaries as-is
                for (const { summaryChunk } of parentInfos) {
                    expandedChunks.push(summaryChunk);
                }
            }
        } catch (error) {
            console.warn(`VectHare: Failed to expand summaries from ${collectionId}:`, error.message);
            // Keep summaries as-is on error
            for (const { summaryChunk } of parentInfos) {
                expandedChunks.push(summaryChunk);
            }
        }
    }

    addTrace(debugData, 'summary_expansion', 'Summary expansion complete', {
        originalCount: chunks.length,
        summariesExpanded: parentHashesNeeded.size,
        finalCount: expandedChunks.length
    });

    return expandedChunks;
}

/**
 * Stage 4: Apply threshold filter to chunks
 * @param {object[]} chunks Chunks to filter
 * @param {number} threshold Score threshold
 * @param {object} debugData Debug tracking object
 * @returns {object[]} Filtered chunks
 */
function applyThresholdFilter(chunks, threshold, debugData) {
    const beforeCount = chunks.length;
    const filtered = chunks.filter(chunk => {
        const passes = chunk.score >= threshold;
        if (!passes) {
            recordChunkFate(debugData, chunk.hash, 'threshold', 'dropped',
                `Score ${chunk.score.toFixed(3)} < threshold ${threshold}`,
                { score: chunk.score, threshold }
            );
        } else {
            recordChunkFate(debugData, chunk.hash, 'threshold', 'passed', null,
                { score: chunk.score, threshold }
            );
        }
        return passes;
    });

    addTrace(debugData, 'threshold', 'Threshold filter applied', {
        threshold,
        before: beforeCount,
        after: filtered.length,
        dropped: beforeCount - filtered.length
    });

    return filtered;
}

/**
 * Stage 5: Apply temporal decay to chunks
 * @param {object[]} chunks Chunks to process
 * @param {object[]} chat Current chat messages
 * @param {object} settings VectHare settings
 * @param {number} threshold Score threshold for re-filtering
 * @param {object} debugData Debug tracking object
 * @returns {object[]} Chunks with decay applied
 */
function applyTemporalDecayStage(chunks, chat, settings, threshold, debugData) {
    if (!settings.temporal_decay || !settings.temporal_decay.enabled) {
        addTrace(debugData, 'decay', 'Temporal decay skipped (disabled)', { enabled: false });
        chunks.forEach(chunk => {
            recordChunkFate(debugData, chunk.hash, 'decay', 'passed', 'Decay disabled', {
                score: chunk.score
            });
        });
        return chunks;
    }

    const beforeCount = chunks.length;
    addTrace(debugData, 'decay', 'Starting temporal decay', {
        enabled: true,
        sceneAware: settings.temporal_decay.sceneAware,
        halfLife: settings.temporal_decay.halfLife || settings.temporal_decay.half_life,
        strength: settings.temporal_decay.strength ?? settings.temporal_decay.rate,
        type: settings.temporal_decay.type ?? 'decay'
    });

    const currentMessageId = chat.length - 1;
    const chunksWithScores = chunks.map(chunk => ({
        hash: chunk.hash,
        metadata: chunk.metadata,
        score: chunk.score
    }));

    let decayedChunks;
    let decayType = 'standard';

    // Nostalgia is mutually exclusive with decay. Scene-aware decay is a decay-
    // only algorithm; do not apply it in nostalgia mode.
    if (settings.temporal_decay.type === 'nostalgia') {
        decayedChunks = applyNostalgiaToResults(chunksWithScores, currentMessageId, settings.temporal_decay);
        decayType = 'nostalgia';
    } else if (settings.temporal_decay.sceneAware) {
        const sceneChunks = chunks.filter(c => c.metadata?.isScene === true);
        const scenes = sceneChunks.map(c => ({
            start: c.metadata.sceneStart,
            end: c.metadata.sceneEnd,
            hash: c.hash,
        }));

        if (scenes.length > 0) {
            decayedChunks = applySceneAwareDecay(chunksWithScores, currentMessageId, scenes, settings.temporal_decay);
            decayType = 'scene_aware';
            console.log('VectHare: Applied scene-aware temporal decay to search results');
        } else {
            decayedChunks = applyDecayToResults(chunksWithScores, currentMessageId, settings.temporal_decay);
            decayType = 'standard_no_scenes';
            console.log('VectHare: Applied temporal decay to search results (no scenes marked)');
        }
    } else {
        decayedChunks = applyDecayToResults(chunksWithScores, currentMessageId, settings.temporal_decay);
        console.log('VectHare: Applied temporal decay to search results');
    }

    decayedChunks.sort((a, b) => b.score - a.score);

    // PERF: Build Map for O(1) lookups instead of O(n) find() per chunk
    const decayedChunksMap = new Map(decayedChunks.map(dc => [dc.hash, dc]));

    // Map decay results back to chunks and record fate
    let result = chunks.map(chunk => {
        const decayedChunk = decayedChunksMap.get(chunk.hash);
        if (decayedChunk && (decayedChunk.decayApplied || decayedChunk.sceneAwareDecay || decayedChunk.nostalgiaApplied)) {
            const decayMultiplier = decayedChunk.originalScore !== 0
                ? decayedChunk.score / decayedChunk.originalScore : 1;
            const newScore = decayedChunk.score;
            const stillAboveThreshold = newScore >= threshold;

            if (stillAboveThreshold) {
                recordChunkFate(debugData, chunk.hash, 'decay', 'passed', null, {
                    originalScore: decayedChunk.originalScore,
                    decayedScore: newScore,
                    decayMultiplier,
                    messageAge: decayedChunk.messageAge ?? decayedChunk.effectiveAge,
                    decayType
                });
            } else {
                recordChunkFate(debugData, chunk.hash, 'decay', 'dropped',
                    `Weighted score ${newScore.toFixed(3)} < threshold ${threshold}`,
                    {
                        originalScore: decayedChunk.originalScore,
                        decayedScore: newScore,
                        decayMultiplier,
                        messageAge: decayedChunk.messageAge ?? decayedChunk.effectiveAge,
                        decayType
                    }
                );
            }

            return {
                ...chunk,
                score: newScore,
                originalScore: decayedChunk.originalScore,
                messageAge: decayedChunk.messageAge ?? decayedChunk.effectiveAge,
                decayApplied: decayedChunk.decayApplied === true,
                nostalgiaApplied: decayedChunk.nostalgiaApplied === true,
                sceneAwareDecay: decayedChunk.sceneAwareDecay || false,
                decayMultiplier
            };
        }

        recordChunkFate(debugData, chunk.hash, 'decay', 'passed', 'No temporal weighting applied', {
            score: chunk.score
        });
        return chunk;
    });

    // Re-filter by threshold after decay
    result = result.filter(c => c.score >= threshold);

    addTrace(debugData, 'decay', 'Temporal decay completed', {
        decayType,
        before: beforeCount,
        after: result.length,
        dropped: beforeCount - result.length
    });

    return result;
}

/**
 * Stage 6: Apply chunk-level conditions
 * @param {object[]} chunks Chunks to filter
 * @param {object[]} chat Current chat messages
 * @param {object} settings VectHare settings
 * @param {object} debugData Debug tracking object
 * @returns {Promise<object[]>} Chunks that passed conditions
 */
async function applyConditionsStage(chunks, chat, settings, debugData) {
    const beforeCount = chunks.length;
    // PERF: Build a Map of hash -> chunk data for tracking instead of copying entire array
    const chunkDataByHash = new Map(chunks.map(c => [c.hash, { score: c.score, conditions: c.metadata?.conditions }]));

    addTrace(debugData, 'conditions', 'Starting condition filtering', {
        chunksToFilter: beforeCount,
        hasConditions: chunks.some(c => c.metadata?.conditions)
    });

    const filtered = await applyChunkConditions(chunks, chat, settings);

    // Record which chunks were dropped by conditions
    const afterConditionsHashes = new Set(filtered.map(c => c.hash));
    for (const [hash, data] of chunkDataByHash) {
        if (afterConditionsHashes.has(hash)) {
            recordChunkFate(debugData, hash, 'conditions', 'passed', null, {
                score: data.score,
                hadConditions: !!data.conditions
            });
        } else {
            recordChunkFate(debugData, hash, 'conditions', 'dropped',
                data.conditions
                    ? `Failed condition: ${JSON.stringify(data.conditions)}`
                    : 'Filtered by condition system',
                {
                    score: data.score,
                    conditions: data.conditions
                }
            );
        }
    }

    addTrace(debugData, 'conditions', 'Condition filtering completed', {
        before: beforeCount,
        after: filtered.length,
        dropped: beforeCount - filtered.length
    });

    return filtered;
}

/**
 * Stage 6.5: Process chunk groups and links
 * - Applies exclusive group filtering (only highest-scoring member passes)
 * - Expands inclusive groups into virtual links
 * - Processes chunk links (both explicit and group-generated)
 * @param {object[]} chunks Chunks to process
 * @param {string[]} activeCollections Active collection IDs
 * @param {object} settings VectHare settings
 * @param {object} debugData Debug tracking object
 * @returns {Promise<object[]>} Processed chunks with links applied
 */
async function applyGroupsAndLinksStage(chunks, activeCollections, settings, debugData) {
    const beforeCount = chunks.length;
    let processedChunks = [...chunks];

    addTrace(debugData, 'groups', 'Starting groups and links processing', {
        chunksCount: beforeCount,
        collectionsToCheck: activeCollections.length
    });

    // Collect groups from all active collections
    // PERF: Count modes during collection instead of separate filter passes
    const allGroups = [];
    let inclusiveCount = 0;
    let exclusiveCount = 0;
    for (const collectionId of activeCollections) {
        const meta = getCollectionMeta(collectionId);
        if (meta.groups && meta.groups.length > 0) {
            for (const group of meta.groups) {
                allGroups.push(group);
                if (group.mode === 'inclusive') inclusiveCount++;
                else if (group.mode === 'exclusive') exclusiveCount++;
            }
        }
    }

    if (allGroups.length === 0) {
        addTrace(debugData, 'groups', 'No groups defined in active collections', {});
        // Still process explicit chunk links even without groups
    } else {
        addTrace(debugData, 'groups', `Found ${allGroups.length} groups across collections`, {
            inclusive: inclusiveCount,
            exclusive: exclusiveCount
        });

        // Build a map of all chunks for mandatory group lookup
        const allChunksMap = new Map(chunks.map(c => [String(c.hash), c]));

        // Process groups
        const groupResult = processChunkGroups(chunks, allGroups, allChunksMap, {
            softBoost: settings.group_soft_boost ?? 0.15
        });

        processedChunks = groupResult.chunks;

        // Log group processing results
        if (groupResult.debug.excluded.length > 0) {
            addTrace(debugData, 'groups', `Exclusive groups filtered ${groupResult.debug.excluded.length} chunks`, {
                excluded: groupResult.debug.excluded.map(e => ({
                    hash: String(e.hash).substring(0, 8),
                    group: e.groupName,
                    beatBy: String(e.beatBy).substring(0, 8)
                }))
            });

            // Record fates for excluded chunks
            for (const ex of groupResult.debug.excluded) {
                recordChunkFate(debugData, ex.hash, 'groups', 'dropped',
                    `Excluded by group "${ex.groupName}" - beaten by chunk #${String(ex.beatBy).substring(0, 8)}`,
                    { score: ex.score, winnerScore: ex.winnerScore }
                );
            }
        }

        if (groupResult.debug.forced.length > 0) {
            addTrace(debugData, 'groups', `Mandatory groups force-included ${groupResult.debug.forced.length} chunks`, {
                forced: groupResult.debug.forced.map(f => ({
                    hash: String(f.hash).substring(0, 8),
                    group: f.groupName
                }))
            });

            // Record fates for forced chunks
            for (const f of groupResult.debug.forced) {
                recordChunkFate(debugData, f.hash, 'groups', 'passed',
                    `Force-included by mandatory group "${f.groupName}"`,
                    { reason: f.reason }
                );
            }
        }

        // PERF: Build chunk metadata map ONCE and reuse for both virtual and explicit links
        const chunkMetadataMap = new Map();
        for (const chunk of processedChunks) {
            const meta = getChunkMetadata(chunk.hash) || {};
            chunkMetadataMap.set(String(chunk.hash), meta);
        }

        // If there are virtual links from inclusive groups, merge them with chunk metadata
        if (groupResult.virtualLinks && groupResult.virtualLinks.size > 0) {
            addTrace(debugData, 'groups', `Inclusive groups generated ${groupResult.debug.virtualLinksCreated} virtual links`, {});

            // Merge virtual links into metadata
            const mergedMetadata = mergeVirtualLinks(chunkMetadataMap, groupResult.virtualLinks);

            // Process links (both explicit and group-generated)
            const linkResult = processChunkLinks(processedChunks, mergedMetadata, settings.group_soft_boost ?? 0.15);
            processedChunks = linkResult.chunks;

            // Handle hard-linked chunks that need to be fetched
            // Note: Fetching missing hard-linked chunks would require additional backend calls
            // and complex deduplication logic. Currently, hard links only boost already-matched chunks.
            if (linkResult.missingHardLinks && linkResult.missingHardLinks.length > 0) {
                addTrace(debugData, 'groups', `Hard links require ${linkResult.missingHardLinks.length} additional chunks (not fetched)`, {
                    hashes: linkResult.missingHardLinks.map(h => String(h).substring(0, 8))
                });
            }

            // Log soft link boosts
            const boostedChunks = processedChunks.filter(c => c.softLinked);
            if (boostedChunks.length > 0) {
                addTrace(debugData, 'groups', `Soft links boosted ${boostedChunks.length} chunks`, {
                    boosted: boostedChunks.map(c => ({
                        hash: String(c.hash).substring(0, 8),
                        boost: c.linkBoost
                    }))
                });
            }
        } else {
            // No virtual links - process explicit chunk links only
            // Filter to only chunks with explicit links
            const chunksWithLinks = new Map();
            for (const [hash, meta] of chunkMetadataMap) {
                if ((meta.links && meta.links.length > 0) || (meta.chunkLinks && meta.chunkLinks.length > 0)) {
                    chunksWithLinks.set(hash, meta);
                }
            }

            if (chunksWithLinks.size > 0) {
                const linkResult = processChunkLinks(processedChunks, chunksWithLinks, settings.group_soft_boost ?? 0.15);
                processedChunks = linkResult.chunks;

                const boostedByExplicitLinks = processedChunks.filter(c => c.softLinked && !c.groupBoosted);
                if (boostedByExplicitLinks.length > 0) {
                    addTrace(debugData, 'links', `Explicit links boosted ${boostedByExplicitLinks.length} chunks`, {});
                }
            }
        }
    }

    // Also process explicit chunk links when there are no groups at all
    // (This handles the case where allGroups.length === 0)
    if (allGroups.length === 0) {
        // PERF: Build metadata map once for chunks with links only
        const chunkMetadataMap = new Map();
        for (const chunk of processedChunks) {
            const meta = getChunkMetadata(chunk.hash) || {};
            if ((meta.links && meta.links.length > 0) || (meta.chunkLinks && meta.chunkLinks.length > 0)) {
                chunkMetadataMap.set(String(chunk.hash), meta);
            }
        }

        if (chunkMetadataMap.size > 0) {
            const linkResult = processChunkLinks(processedChunks, chunkMetadataMap, settings.group_soft_boost ?? 0.15);
            processedChunks = linkResult.chunks;

            const boostedByExplicitLinks = processedChunks.filter(c => c.softLinked && !c.groupBoosted);
            if (boostedByExplicitLinks.length > 0) {
                addTrace(debugData, 'links', `Explicit links boosted ${boostedByExplicitLinks.length} chunks`, {});
            }
        }
    }

    addTrace(debugData, 'groups', 'Groups and links processing complete', {
        before: beforeCount,
        after: processedChunks.length,
        groupsProcessed: allGroups.length
    });

    return processedChunks;
}

/**
 * Stage 7: Deduplicate chunks already in chat context
 * Only checks against recent messages within the context window, not entire chat history.
 * @param {object[]} chunks Chunks to deduplicate
 * @param {object[]} chat Current chat messages
 * @param {object} settings VectHare settings (uses deduplication_depth)
 * @param {object} debugData Debug tracking object
 * @returns {{toInject: object[], skipped: object[]}} Chunks to inject and skipped duplicates
 */
function deduplicateChunks(chunks, chat, settings, debugData) {
    // Determine how far back to check for duplicates
    // Default to 50 messages if not specified (reasonable context window)
    const deduplicationDepth = settings.deduplication_depth ?? 50;

    addTrace(debugData, 'injection', 'Starting deduplication and injection', {
        chunksToInject: chunks.length,
        chatLength: chat.length,
        deduplicationDepth: deduplicationDepth
    });

    // Only check the most recent N messages (within context window)
    const recentMessages = deduplicationDepth > 0 && deduplicationDepth < chat.length
        ? chat.slice(-deduplicationDepth)
        : chat;

    console.log(`[VectHare Dedup] Building hash set from ${recentMessages.length} recent messages (depth: ${deduplicationDepth})`);
    console.log(`[VectHare Dedup] Total chat length: ${chat.length}, checking duplicates in last ${recentMessages.length} messages`);

    // Build set of hashes currently in chat context
    const currentChatHashes = new Set();
    const chatHashMap = new Map(); // For debugging: hash -> message preview

    recentMessages.forEach((msg, idx) => {
        if (msg.mes) {
            const cleanedText = substituteParams(getTextWithoutAttachments(msg));
            // R22: raw-text hash - must match the storage-side formula
            const hash = getStringHash(getTextWithoutAttachments(msg));
            currentChatHashes.add(hash);

            // Store sample for debugging (first occurrence only)
            // Calculate absolute index in full chat
            const absoluteIndex = chat.length - recentMessages.length + idx;
            if (!chatHashMap.has(hash)) {
                chatHashMap.set(hash, {
                    index: absoluteIndex,
                    preview: cleanedText.substring(0, 80),
                    isUser: msg.is_user,
                    name: msg.name
                });
            }
        }
    });

    console.log(`[VectHare Dedup] Built hash set with ${currentChatHashes.size} unique message hashes from recent context`);

    const toInject = [];
    const skipped = [];

    for (const chunk of chunks) {
        const isInChat = currentChatHashes.has(chunk.hash);

        if (isInChat) {
            const matchedMsg = chatHashMap.get(chunk.hash);
            console.debug(`[VectHare Dedup] ❌ SKIPPING chunk (hash: ${chunk.hash})`);
            // Do not log private conversation text.
            console.debug(`  Matches chat message #${matchedMsg.index}`);
            console.debug(`  Score: ${chunk.score?.toFixed(4)}, Collection: ${chunk.collectionId}`);

            skipped.push(chunk);
            recordChunkFate(debugData, chunk.hash, 'injection', 'skipped',
                'Already in current chat context - no injection needed',
                { score: chunk.score }
            );
        } else {
            console.debug(`[VectHare Dedup] ✅ KEEPING chunk (hash: ${chunk.hash}, score: ${chunk.score?.toFixed(4)})`);
            // Do not log private conversation text.

            toInject.push(chunk);
            recordChunkFate(debugData, chunk.hash, 'injection', 'passed',
                'Not in current context - will inject',
                { score: chunk.score, collectionId: chunk.collectionId }
            );
        }
    }

    addTrace(debugData, 'injection', 'Deduplication complete', {
        totalChunks: chunks.length,
        toInject: toInject.length,
        skippedDuplicates: skipped.length
    });

    console.log(`[VectHare Dedup] FINAL: ${toInject.length} will inject, ${skipped.length} skipped as duplicates`);

    return { toInject, skipped };
}

/** Return true only for real retrieved text; unavailable vectors remain visible in debug data. */
function hasInjectableText(chunk) {
    const text = chunk?.text;
    return typeof text === 'string' && text.trim().length > 0
        && !/^\(text not (?:found|available)\)$/i.test(text.trim());
}

/** Clear every prompt tag created by VectHare, including legacy WI injection. */
function clearVectHarePrompts(settings) {
    setExtensionPrompt(EXTENSION_PROMPT_TAG, '', settings?.position ?? 0, settings?.depth ?? 2, false);
    // Enumerate actual registered tags: a previous turn might have created >10 positions.
    const prefix = `${EXTENSION_PROMPT_TAG}_pos`;
    for (const tag of Object.keys(extension_prompts || {})) {
        if (tag.startsWith(prefix) && /^\d+$/.test(tag.slice(prefix.length))) {
            setExtensionPrompt(tag, '', 0, 0, false);
        }
    }
    // The dormant World Info injector uses its own reserved tag, never the RAG tag.
    if (extension_prompts?.[LEGACY_WORLD_INFO_PROMPT_TAG]) {
        setExtensionPrompt(LEGACY_WORLD_INFO_PROMPT_TAG, '', 0, 0, false);
    }
}

/**
 * Builds the nested prompt structure with context and XML tags at each level.
 * Groups chunks by collection and applies wrapping in this order:
 * 1. Global wrapper (outermost)
 * 2. Collection wrapper (groups chunks from same collection)
 * 3. Chunk wrapper (innermost, per-chunk)
 *
 * @param {object[]} chunks Chunks to inject
 * @param {object} settings VectHare settings
 * @returns {string} Formatted injection text
 */
function buildNestedInjectionText(chunks, settings) {
    // Group chunks by collection
    const byCollection = new Map();
    for (const chunk of chunks) {
        if (!hasInjectableText(chunk)) continue;
        const collId = chunk.collectionId || 'unknown';
        if (!byCollection.has(collId)) {
            byCollection.set(collId, []);
        }
        byCollection.get(collId).push(chunk);
    }

    // Build collection blocks
    const collectionBlocks = [];

    for (const [collectionId, collChunks] of byCollection) {
        // Get collection metadata for context/xmlTag
        const collMeta = getCollectionMeta(collectionId) || {};
        const collContext = collMeta.context ? substituteParams(collMeta.context) : '';
        const collXmlTag = collMeta.xmlTag || '';

        // Build chunk texts with per-chunk wrapping
        const chunkTexts = collChunks.map(chunk => {
            const chunkMeta = getChunkMetadata(chunk.hash) || {};
            const chunkContext = chunkMeta.context ? substituteParams(chunkMeta.context) : '';
            const chunkXmlTag = chunkMeta.xmlTag || '';
            const text = chunk.text;

            // Build chunk with optional wrapping
            let chunkBlock = '';

            if (chunkContext) {
                chunkBlock += chunkContext + '\n';
            }

            if (chunkXmlTag) {
                chunkBlock += `<${chunkXmlTag}>\n${text}\n</${chunkXmlTag}>`;
            } else {
                chunkBlock += text;
            }

            return chunkBlock;
        });

        // Join chunks within this collection
        let collectionBlock = chunkTexts.join('\n\n');

        // Apply collection-level wrapping
        if (collContext) {
            collectionBlock = collContext + '\n\n' + collectionBlock;
        }

        if (collXmlTag) {
            collectionBlock = `<${collXmlTag}>\n${collectionBlock}\n</${collXmlTag}>`;
        }

        collectionBlocks.push(collectionBlock);
    }

    // Join all collection blocks
    let fullText = collectionBlocks.join('\n\n');

    // Apply global-level wrapping
    const globalContext = settings.rag_context ? substituteParams(settings.rag_context) : '';
    const globalXmlTag = settings.rag_xml_tag || '';

    if (globalContext) {
        fullText = globalContext + '\n\n' + fullText;
    }

    if (globalXmlTag) {
        fullText = `<${globalXmlTag}>\n${fullText}\n</${globalXmlTag}>`;
    }

    return fullText;
}

/**
 * Resolves the effective injection position for a chunk using cascade:
 * chunk → collection → global
 * @param {object} chunk Chunk with collectionId
 * @param {object} settings VectHare settings
 * @returns {{position: number, depth: number}} Resolved position and depth
 */
function resolveChunkInjectionPosition(chunk, settings) {
    const chunkMeta = getChunkMetadata(chunk.hash) || {};
    const collMeta = getCollectionMeta(chunk.collectionId) || {};

    // Cascade: chunk → collection → global
    const position = chunkMeta.position ?? collMeta.position ?? settings.position ?? 0;
    const depth = chunkMeta.depth ?? collMeta.depth ?? settings.depth ?? 2;

    return { position, depth };
}

/**
 * Stage 8: Format and inject chunks into prompt
 * Supports per-chunk/per-collection injection positions via cascade resolution.
 * Groups chunks by their resolved position+depth and creates separate injections.
 *
 * @param {object[]} chunksToInject Chunks to inject
 * @param {object} settings VectHare settings
 * @param {object} debugData Debug tracking object
 * @returns {{verified: boolean, text: string}} Injection result
 */
function injectChunksIntoPrompt(chunksToInject, settings, debugData) {
    // Defence in depth: a caller must never inject an absent-text placeholder.
    chunksToInject = chunksToInject.filter(hasInjectableText);
    if (chunksToInject.length === 0) {
        clearVectHarePrompts(settings);
        return { verified: false, text: '', groups: [] };
    }
    // Control print: Log chunks QUEUED for injection (not yet injected)
    console.log(`[VectHare Injection Control] Preparing to inject ${chunksToInject.length} chunks`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    let emptyTextCount = 0;
    chunksToInject.forEach((chunk, idx) => {
        const textLength = chunk.text?.length || 0;
        const hasValidText = textLength > 0 && chunk.text !== '(text not found)' && chunk.text !== '(text not available)';
        if (!hasValidText) emptyTextCount++;

        console.log(`  [${idx + 1}/${chunksToInject.length}] CHUNK QUEUED FOR INJECTION ${!hasValidText ? '⚠️ EMPTY/INVALID TEXT' : ''}`);
        console.log(`      Hash: ${chunk.hash}`);
        console.log(`      Score: ${chunk.score?.toFixed(4)}`);
        console.log(`      Collection: ${chunk.collectionId}`);
        console.log(`      Text length: ${textLength} chars ${!hasValidText ? '⚠️' : '✓'}`);
        // Do not log private chunk text.
        console.log('      ─────────────────────────────────────────────────────────────────');
    });
    if (emptyTextCount > 0) {
        console.warn(`[VectHare Injection Control] ⚠️ WARNING: ${emptyTextCount}/${chunksToInject.length} chunks have empty or placeholder text!`);
    }
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    // Group chunks by resolved injection position+depth
    const positionGroups = new Map(); // "position:depth" → chunks[]

    for (const chunk of chunksToInject) {
        const { position, depth } = resolveChunkInjectionPosition(chunk, settings);
        const key = `${position}:${depth}`;

        if (!positionGroups.has(key)) {
            positionGroups.set(key, { position, depth, chunks: [] });
        }
        positionGroups.get(key).chunks.push(chunk);
    }

    // If all chunks go to the same position, use the simple single-injection path
    if (positionGroups.size === 1) {
        const [_, group] = [...positionGroups.entries()][0];
        const insertedText = buildNestedInjectionText(group.chunks, settings);

        console.log(`[VectHare Injection Control] Single position injection: position="${group.position}", depth=${group.depth}, chunks=${group.chunks.length}, textLength=${insertedText.length}`);
        // Do not log prompt contents.

        setExtensionPrompt(EXTENSION_PROMPT_TAG, insertedText, group.position, group.depth, false);

        // Verify injection
        const verifiedPrompt = extension_prompts[EXTENSION_PROMPT_TAG];
        const injectionVerified = verifiedPrompt && verifiedPrompt.value === insertedText;

        console.log(`[VectHare Injection Control] Injection verification: ${injectionVerified ? '✓ PASSED' : '✗ FAILED'}`);
        console.log(`[VectHare Injection Control] extension_prompts[${EXTENSION_PROMPT_TAG}]:`, {
            exists: !!verifiedPrompt,
            valueLength: verifiedPrompt?.value?.length,
            position: verifiedPrompt?.position,
            depth: verifiedPrompt?.depth,
        });

        if (!injectionVerified) {
            console.warn('VectHare: ⚠️ Injection verification failed!', {
                expectedLength: insertedText.length,
                actualLength: verifiedPrompt?.value?.length,
                promptExists: !!verifiedPrompt
            });
        }

        // Record final fate for injected chunks
        group.chunks.forEach(chunk => {
            recordChunkFate(debugData, chunk.hash, 'final', 'injected', null, {
                score: chunk.score,
                collectionId: chunk.collectionId
            });
        });

        return {
            verified: Boolean(injectionVerified),
            text: insertedText,
            groups: [{
                tag: EXTENSION_PROMPT_TAG,
                position: group.position,
                depth: group.depth,
                text: insertedText,
                charCount: insertedText.length,
                chunkHashes: group.chunks.map(chunk => chunk.hash),
                verified: Boolean(injectionVerified)
            }]
        };
    }

    // Multiple injection positions - create separate extension prompts for each
    console.log(`[VectHare Injection Control] Multiple position injection: ${positionGroups.size} different positions`);

    // Clear the main tag first (will be unused when multi-position)
    setExtensionPrompt(EXTENSION_PROMPT_TAG, '', settings.position, settings.depth, false);

    let allVerified = true;
    const allTexts = [];
    const registeredGroups = [];
    let groupIndex = 0;

    for (const [key, group] of positionGroups) {
        // Build text for this position group (no global wrapper - that goes on outermost only)
        // Each position group is a separate prompt block and needs its own global wrappers.
        const groupText = buildNestedInjectionText(group.chunks, settings);

        console.log(`[VectHare Injection Control] Position group ${groupIndex + 1}/${positionGroups.size}: key="${key}", chunks=${group.chunks.length}, textLength=${groupText.length}`);
        group.chunks.forEach((chunk, idx) => {
            console.log(`    [${idx + 1}/${group.chunks.length}] Hash: ${chunk.hash}, Score: ${chunk.score?.toFixed(4)}`);
        });

        // Use unique tag per position group
        const tag = `${EXTENSION_PROMPT_TAG}_pos${groupIndex}`;

        setExtensionPrompt(tag, groupText, group.position, group.depth, false);

        // Verify
        const verifiedPrompt = extension_prompts[tag];
        const verified = verifiedPrompt && verifiedPrompt.value === groupText;

        console.log(`[VectHare Injection Control] Position group ${groupIndex + 1} verification: ${verified ? '✓ PASSED' : '✗ FAILED'}`);

        if (!verified) {
            console.warn(`VectHare: ⚠️ Injection verification failed for position ${key}`, {
                tag,
                expectedLength: groupText.length,
                actualLength: verifiedPrompt?.value?.length
            });
            allVerified = false;
        }

        // Record fates
        group.chunks.forEach(chunk => {
            recordChunkFate(debugData, chunk.hash, 'final', 'injected', null, {
                score: chunk.score,
                collectionId: chunk.collectionId,
                position: group.position,
                depth: group.depth
            });
        });

        allTexts.push(groupText);
        registeredGroups.push({
            tag,
            position: group.position,
            depth: group.depth,
            text: groupText,
            charCount: groupText.length,
            chunkHashes: group.chunks.map(chunk => chunk.hash),
            verified: Boolean(verified)
        });
        groupIndex++;
    }

    console.log(`[VectHare Injection Control] Injection complete: ${allVerified ? '✓ All verified' : '✗ Some failed'}, ${allTexts.length} groups`);

    return {
        verified: allVerified,
        groups: registeredGroups,
        text: allTexts.join('\n\n---\n\n') // Combine for debug output
    };
}

// ============================================================================
// MAIN ORCHESTRATOR
// ============================================================================

/**
 * Searches for and injects relevant past messages from ALL enabled collections
 * This includes chat collections (if enabled_chats is true) AND any other
 * enabled collections like lorebooks, documents, character files, etc.
 *
 * @param {object[]} chat Current chat messages
 * @param {object} settings VectHare settings
 * @param {string} type Generation type
 */
export async function rearrangeChat(chat, settings, type) {
    let job;
    try { job = chatJobs.startJob({kind:'retrieval',generationScoped:true}); }
    catch (error) { if(error instanceof StaleJobError) return; throw error; }
    console.log(`🐰 VectHare: rearrangeChat called (type: ${type}, chat length: ${chat?.length || 0})`);

    try {
        // Clear stale prompt tags even if this run is quiet or exits before searching.
        job.assertCurrent();
        clearVectHarePrompts(settings);
        // === EARLY EXITS ===
        if (type === 'quiet') {
            console.debug('VectHare: Skipping quiet prompt');
            return;
        }

        if (!getCurrentChatId() || !Array.isArray(chat)) {
            console.debug('VectHare: No chat selected');
            return;
        }

        const minChatLength = settings.min_chat_length ?? 0;
        if (minChatLength > 0 && chat.length < minChatLength) {
            console.warn(`⚠️ VectHare: Not enough messages to inject chunks (${chat.length} < ${minChatLength})`);
            console.log(`   💡 You need at least ${minChatLength} messages before chunk injection starts`);
            return;
        }

        // === STAGE 1: Gather collections to query ===
        const collectionsToQuery = gatherCollectionsToQuery(settings);
        // Allow continuing with WI-only mode if enabled_world_info is set
        const hasCollections = collectionsToQuery.length > 0;
        const canQueryWI = settings.enabled_world_info;

        if (!hasCollections && !canQueryWI) {
            console.warn('⚠️ VectHare: No enabled collections to query and World Info disabled - chunks cannot be injected!');
            console.log('   💡 Make sure you have enabled at least one collection in VectHare settings, or enable World Info');
            const noEnabledDebug = createDebugData();
            noEnabledDebug.query = buildSearchQuery(chat, settings);
            noEnabledDebug.collectionId = 'none';
            noEnabledDebug.settings = {
                threshold: settings.score_threshold,
                topK: settings.top_k ?? settings.insert,
                temporal_decay: settings.temporal_decay,
                chatLength: chat.length
            };
            noEnabledDebug.stopReason = 'no_active_collections';
            addTrace(noEnabledDebug, 'activation', 'No enabled collections; vector search skipped');
            job.assertCurrent();
            setLastSearchDebug(noEnabledDebug);
            return;
        }
        if (hasCollections) {
            console.log(`VectHare: Will query ${collectionsToQuery.length} collections:`, collectionsToQuery);
        } else {
            console.log('VectHare: No regular collections enabled, but World Info is enabled - will query lorebooks only');
        }

        // === STAGE 2: Build search query ===
        const queryText = buildSearchQuery(chat, settings);
        if (queryText.length === 0) {
            console.debug('VectHare: No text to query');
            return;
        }

        // === STAGE 2.5: Extract keywords from query message ===
        const extractionLevel = settings.keyword_extraction_level || 'balanced';
        const queryKeywords = extractChatKeywords(queryText, {
            level: extractionLevel,
            baseWeight: settings.keyword_boost_base_weight || 1.5
        });
        const queryKeywordTexts = queryKeywords.map(kw => kw.text.toLowerCase());
        console.log(`VectHare: Extracted ${queryKeywords.length} keywords from query`);

        // === STAGE 3: Filter by activation conditions ===
        let activeCollections = [];
        const collectionDecisions = [];
        if (hasCollections) {
            // Include configured collection trigger/pattern windows even if query depth is small.
            const activationDepth = collectionsToQuery.reduce((depth, id) => {
                const meta = getCollectionMeta(id);
                return Math.max(depth, Number(meta?.triggerScanDepth) || 0, getRequiredConditionDepth(meta?.conditions));
            }, settings.query || 10);
            const searchContext = buildSearchContext(chat, activationDepth, [], {
                generationType: type || 'normal',
                isGroupChat: getContext().groupId != null,
                currentCharacter: getContext().name2 || null,
                activeLorebookEntries: [],
                currentChatId: getCurrentChatId(),
                currentCharacterId: getContext().characterId || null,
                collectionDecisions
            });
            searchContext.collectionDecisions = collectionDecisions;
            activeCollections = await filterActiveCollections(collectionsToQuery, searchContext);
        job.assertCurrent();
        }

        // Allow WI-only mode even if no regular collections pass filters
        if (activeCollections.length === 0 && !canQueryWI) {
            console.log('⚠️ VectHare: No collections passed activation conditions and World Info disabled - chunks cannot be injected!');
            console.log('   💡 Check your collection activation conditions in VectHare settings');
            // A search was attempted, but every candidate was rejected by activation.
            // Do not leave the debugger showing the previous generation's results.
            const noActiveDebug = createDebugData();
            noActiveDebug.query = queryText;
            noActiveDebug.queryKeywords = queryKeywordTexts;
            noActiveDebug.collectionId = 'none';
            noActiveDebug.collectionsQueried = [];
            noActiveDebug.collectionDecisions = collectionDecisions;
            noActiveDebug.settings = {
                threshold: settings.score_threshold,
                topK: settings.top_k ?? settings.insert,
                temporal_decay: settings.temporal_decay,
                chatLength: chat.length
            };
            noActiveDebug.stopReason = 'no_active_collections';
            addTrace(noActiveDebug, 'activation', 'No collections passed activation; vector search skipped', {
                candidates: collectionsToQuery.length,
                rejected: collectionDecisions.length
            });
            job.assertCurrent();
            setLastSearchDebug(noActiveDebug);
            return;
        }
        if (activeCollections.length > 0) {
            console.log(`✅ VectHare: ${activeCollections.length} collections passed activation filters:`, activeCollections);
        }

        // === INITIALIZE DEBUG DATA ===
        const debugData = createDebugData();
        debugData.query = queryText;
        debugData.queryKeywords = queryKeywordTexts;
        debugData.collectionId = activeCollections.length > 0 ? activeCollections.join(', ') : 'world_info_only';
        debugData.collectionsQueried = activeCollections;
        debugData.collectionDecisions = collectionDecisions;
        const effectiveTopK = settings.top_k ?? settings.insert;
        debugData.settings = {
            threshold: settings.score_threshold,
            topK: effectiveTopK,
            temporal_decay: settings.temporal_decay,
            protect: settings.protect,
            chatLength: chat.length
        };

        addTrace(debugData, 'init', 'Pipeline started', {
            collectionsQueried: activeCollections,
            queryLength: queryText.length,
            threshold: settings.score_threshold,
            topK: effectiveTopK,
            protect: settings.protect
        });

        // === STAGE 4: Query all collections and merge results ===
        let chunks = await queryAndMergeCollections(activeCollections, queryText, settings, chat, debugData);
        job.assertCurrent();
        // Keep the actual vector-query results before any filtering, keyword boost
        // or semantic World Info merge. Keyword boosts mutate chunk objects.
        debugData.stages.initial = chunks.map(chunk => ({ ...chunk }));
        debugData.stats.retrievedFromVector = chunks.length;

        // === STAGE 4.1: Filter disabled chunks ===
        const beforeDisabledFilter = chunks.length;
        chunks = chunks.filter(chunk => {
            const meta = getChunkMetadata(chunk.hash);
            if (meta?.disabled === true || meta?.enabled === false) {
                recordChunkFate(debugData, chunk.hash, 'disabled_filter', 'dropped',
                                'Chunk is disabled', { hash: chunk.hash });
                return false;
            }
            return true;
        });
        if (chunks.length !== beforeDisabledFilter) {
            console.log(`VectHare: Disabled filter: ${beforeDisabledFilter} → ${chunks.length} chunks (${beforeDisabledFilter - chunks.length} disabled chunks removed)`);
            addTrace(debugData, 'disabled_filter', 'Disabled chunks removed', {
                before: beforeDisabledFilter,
                after: chunks.length,
                removed: beforeDisabledFilter - chunks.length
            });
        }

        // === STAGE 4.3: Boost chunks with matching query keywords ===
        if (chunks.length > 0) {
            let keywordMatchCount = 0;
            // FIX: Match chunk keywords against BOTH auto-extracted query keywords AND
            // the full raw query text. The extraction cap (e.g. balanced = max 8 keywords)
            // previously silently dropped names beyond the cap, preventing their boost.
            const queryLower = queryText.toLowerCase();

            for (const chunk of chunks) {
                // Get chunk keywords from metadata
                const chunkKeywords = (chunk.metadata?.keywords || [])
                .map(kw => (typeof kw === 'object' ? kw.text : kw)?.toLowerCase())
                .filter(Boolean);

                // Check chunk keywords against extracted list OR raw query text
                // Word-boundary match to avoid partial hits (e.g. "mel" inside "melody")
                const matchedKeywords = chunkKeywords.filter(ck => {
                    if (queryKeywordTexts.includes(ck)) return true;
                    return containsLexicalPhrase(queryLower, ck);
                });

                if (matchedKeywords.length > 0) {
                    // Reuse configured per-keyword weights and bounded boosting;
                    // keyword overlap must not override semantic relevance to 1.0.
                    const oldScore = chunk.score;
                    const weighted = (chunk.metadata?.keywords || [])
                        .filter(kw => matchedKeywords.includes(String(typeof kw === 'object' ? kw.text : kw).toLowerCase()));
                    const boosted = applyKeywordBoost([{ ...chunk, keywords: weighted }], queryText)[0];
                    chunk.keywordMatched = true;
                    chunk.matchedQueryKeywords = matchedKeywords;
                    chunk.score = boosted?.score ?? oldScore;
                    chunk.keywordBoost = boosted?.keywordBoost ?? 1;
                    chunk.originalScore = oldScore;
                    keywordMatchCount++;

                    addTrace(debugData, 'keyword_boost', `Chunk boosted by ${matchedKeywords.length} keyword(s)`, {
                        hash: chunk.hash,
                        matchedKeywords,
                        newScore: chunk.score,
                        oldScore
                    });
                }
            }

            if (keywordMatchCount > 0) {
                console.log(`VectHare: Applied bounded keyword boosts to ${keywordMatchCount}/${chunks.length} chunks`);
                debugData.stats.keywordBoosted = keywordMatchCount;
                addTrace(debugData, 'keyword_boost', `Boosted ${keywordMatchCount} chunks with keyword matches`, {
                    totalChunks: chunks.length,
                    boostedCount: keywordMatchCount
                });
            } else {
                console.log(`VectHare: No chunks matched query keywords, all ${chunks.length} chunks keep original scores`);
            }
        }

        // Distinguish post-keyword collection hits from raw vector results.
        // Record this stage even when no keyword matched.
        debugData.stages.afterKeywordBoost = chunks.map(chunk => ({ ...chunk }));
        debugData.stats.afterKeywordBoost = chunks.length;

        // === WORLD INFO: Semantic WI entries ===
        try {
            if (settings.enabled_world_info) {
                // Build recentMessages array for WI query
                const recentMessages = chat
                    .filter(x => !x.is_system)
                    .slice(-Math.max(1, Number(settings.world_info_query_depth || settings.query) || 3))
                    .map(x => substituteParams(x.mes));

                const wiEntries = await getSemanticWorldInfoEntries(recentMessages, [], settings);
        job.assertCurrent();
                if (Array.isArray(wiEntries) && wiEntries.length > 0) {
                    addTrace(debugData, 'world_info', `Found ${wiEntries.length} semantic WI entries`, { entries: wiEntries.map(e => ({ uid: e.uid, score: e.score })) });

                    // Convert WI entries into chunk-like objects and merge
                    const wiChunks = wiEntries.map(e => {
                        const hash = String(e.metadata?.hash ?? e.uid ?? getStringHash(e.content || e.key || ''));
                        return {
                            hash,
                            metadata: e.metadata || {},
                            score: e.score ?? 1.0,
                            originalScore: e.score ?? 1.0,
                            similarity: e.score ?? 1.0,
                            text: e.content || (Array.isArray(e.key) ? e.key.join(' ') : e.key || ''),
                            index: 0,
                            collectionId: e.collectionId || `vecthare_wi:${e.lorebookName || 'lorebook'}`,
                            decayApplied: false
                        };
                    });

                    // WI semantic lookup and ordinary collection lookup may return
                    // the same vector. Retain the ordinary hit instead of injecting
                    // its content twice (collection-qualified to avoid cross-chat merges).
                    const mergedWI = mergeSemanticWorldInfoChunks(chunks, wiChunks);
                    chunks = mergedWI.chunks;
                    debugData.stages.worldInfo = mergedWI.uniqueWIChunks;
                }
            }
        } catch (wiError) {
            console.warn('VectHare: WorldInfo semantic integration failed', wiError.message);
            addTrace(debugData, 'world_info', 'WorldInfo query failed', { error: wiError.message });
        }
        console.log(`VectHare: Retrieved ${chunks.length} total chunks from ${activeCollections.length} collections`);
        // This is the combined retrieval stage, not the raw vector stage.
        debugData.stages.afterWorldInfo = chunks.map(chunk => ({ ...chunk }));
        debugData.stats.afterWorldInfo = chunks.length;

        // === STAGE 4.5: Expand summary chunks to parent chunks (dual-vector) ===
        const chunksBeforeExpansion = chunks.length;
        chunks = await expandSummaryChunks(chunks, activeCollections, settings, debugData);
        job.assertCurrent();
        if (chunks.length !== chunksBeforeExpansion || chunks.some(c => c.expandedFromSummary)) {
            const expandedCount = chunks.filter(c => c.expandedFromSummary).length;
            console.log(`VectHare: Expanded ${expandedCount} summary chunks to parent text`);
            debugData.stages.afterSummaryExpansion = [...chunks];
            debugData.stats.summariesExpanded = expandedCount;
        }

        // === STAGE 5: BananaBread reranking (optional) ===
        if (settings.source === 'bananabread' && settings.bananabread_rerank && chunks.length > 0) {
            addTrace(debugData, 'rerank', 'Starting BananaBread reranking', {
                chunks: chunks.length,
                query: queryText.substring(0, 100)
            });
            chunks = await rerankWithBananaBread(queryText, chunks, settings);
            job.assertCurrent();
            debugData.stages.afterRerank = [...chunks];
            addTrace(debugData, 'rerank', 'Reranking complete', { rerankedCount: chunks.length });
        }

        // === STAGE 6: Threshold filter ===
        const threshold = settings.score_threshold || 0;
        chunks = applyThresholdFilter(chunks, threshold, debugData);
        debugData.stages.afterThreshold = [...chunks];

        // === STAGE 7: Temporal decay ===
        chunks = applyTemporalDecayStage(chunks, chat, settings, threshold, debugData);
        debugData.stages.afterDecay = [...chunks];
        debugData.stats.afterDecay = chunks.length;

        // === STAGE 8: Chunk conditions ===
        job.assertCurrent();
        chunks = await applyConditionsStage(chunks, chat, {
            ...settings,
            generationType: type || 'normal',
            isGroupChat: getContext().groupId != null,
            currentCharacter: getContext().name2 || null,
        }, debugData);
        job.assertCurrent();
        debugData.stages.afterConditions = [...chunks];
        debugData.stats.afterConditions = chunks.length;

        // === STAGE 8.5: Chunk Groups and Links ===
        chunks = await applyGroupsAndLinksStage(chunks, activeCollections, settings, debugData);
        job.assertCurrent();
        debugData.stages.afterGroups = [...chunks];
        debugData.stats.afterGroups = chunks.length;

        // Store for legacy visualizer
        window.VectHare_LastSearch = {
            chunks: chunks,
            query: queryText,
            timestamp: Date.now(),
            settings: { threshold: settings.score_threshold, topK: (settings.top_k ?? settings.insert), temporal_decay: settings.temporal_decay }
        };
        console.log(`VectHare: Stored ${chunks.length} chunks for visualizer`);

        // Reject unavailable record bodies instead of formatting literal placeholders.
        const unavailableChunks = chunks.filter(chunk => !hasInjectableText(chunk));
        for (const chunk of unavailableChunks) {
            recordChunkFate(debugData, chunk.hash, 'injection', 'skipped',
                'Retrieved chunk has no available text', { collectionId: chunk.collectionId });
        }
        if (unavailableChunks.length) {
            console.warn(`VectHare: Skipping ${unavailableChunks.length} retrieved chunks with unavailable text`);
        }
        chunks = chunks.filter(hasInjectableText);

        // === STAGE 9: Deduplicate ===
        console.log(`[VectHare Deduplication] Starting with ${chunks.length} chunks before deduplication`);
        console.log(`[VectHare Deduplication] Current chat has ${chat.length} messages`);

        const { toInject: chunksToInject, skipped: skippedDuplicates } = deduplicateChunks(chunks, chat, settings, debugData);

        console.log(`[VectHare Deduplication] After deduplication: ${chunksToInject.length} to inject, ${skippedDuplicates.length} skipped`);
        if (skippedDuplicates.length > 0) {
            console.log(`[VectHare Deduplication] Skipped chunks (already in chat):`);
            skippedDuplicates.forEach((chunk, idx) => {
                console.log(`  [${idx + 1}] Hash: ${chunk.hash}, Score: ${chunk.score?.toFixed(4)}, Text: "${chunk.text?.substring(0, 80)}..."`);
            });
        }

        if (chunksToInject.length === 0) {
            console.log('ℹ️ VectHare: All retrieved chunks already in context, nothing to inject');
            console.log(`   ${skippedDuplicates.length} chunks were skipped (already in current chat)`);
            console.info('[VectHare] Injection blocked: All retrieved chunks are already present in the current chat context. Adjust temporal decay or query depth if you want older messages.');
            debugData.stages.injected = [];
            debugData.stats.actuallyInjected = 0;
            debugData.stats.skippedDuplicates = skippedDuplicates.length;
            addTrace(debugData, 'injection', 'PIPELINE COMPLETE - NO INJECTION NEEDED', {
                reason: 'All chunks already in current context',
                skippedCount: skippedDuplicates.length
            });
            job.assertCurrent();
            setLastSearchDebug(debugData);
            return;
        }

        console.log(`[VectHare Deduplication] ✅ ${chunksToInject.length} chunks will proceed to injection`);

        // === STAGE 10: Inject into prompt ===
        job.assertCurrent();
        const injection = injectChunksIntoPrompt(chunksToInject, settings, debugData);

        console.log(`\n✅ VectHare: Successfully injected ${chunksToInject.length} chunk(s) into prompt`);
        console.log(`   Verification: ${injection.verified ? '✓ PASSED' : '✗ FAILED'}`);
        console.log(`   Total characters injected: ${injection.text.length}\n`);

        // Finalize debug data
        debugData.stages.injected = chunksToInject;
        debugData.stats.actuallyInjected = chunksToInject.length;
        debugData.stats.skippedDuplicates = skippedDuplicates.length;
        debugData.injection = {
            verified: injection.verified,
            text: injection.text,
            position: settings.position,
            depth: settings.depth,
            promptTag: injection.groups?.length === 1 ? injection.groups[0].tag : null,
            groups: injection.groups || [],
            charCount: injection.text.length
        };

        addTrace(debugData, 'final', 'PIPELINE COMPLETE - SUCCESS', {
            injectedCount: chunksToInject.length,
            skippedDuplicates: skippedDuplicates.length,
            injectedHashes: chunksToInject.map(c => c.hash),
            totalTokens: injection.text.length,
            position: settings.position,
            depth: settings.depth,
            verified: injection.verified
        });
        job.assertCurrent();

        job.assertCurrent();
            setLastSearchDebug(debugData);
        console.log(`VectHare: ✅ Injected ${chunksToInject.length} chunks (${skippedDuplicates.length} skipped - already in context)`);

    } catch (error) {
        if (error instanceof StaleJobError) return;
        toastr.error(`Generation interceptor aborted: ${error.message}`, 'VectHare');
        console.error('VectHare: Failed to rearrange chat', error);
    } finally { job.finish(); }
}

/**
 * Vectorizes entire chat
 * @param {object} settings VectHare settings
 * @param {number} batchSize Batch size
 */
export async function vectorizeAll(settings, batchSize) {
    let job = null;
    try {
        // VectHare+: Manual Sync Chat / Continue always runs, regardless of the
        // per-collection auto-sync toggle - auto-sync gating applies ONLY to
        // event-driven background sync inside synchronizeChat (see the
        // bypassAutoSync flag). Round 2 wrongly warned users here, which made
        // the manual "Continue Vectorization" button demand auto-sync.

        // VectHare+ re-entrancy guard: a second run while one is active would
        // interleave batches, fight over the (singleton) progress panel, and
        // re-wire Pause/Stop callbacks under the first run. Exactly the kind
        // of weird behavior seen in testing.
        // R12: shared acquisition guard (identical behavior for sync and repair)
        if (!tryAcquireVectorizationRun()) {
            return false;
        }

        job = chatJobs.startJob({kind:'vectorize',collectionKey:`${settings.vector_backend || 'standard'}:${settings.source || 'transformers'}:${getChatCollectionId() || ''}`});
        const chatId = getCurrentChatId();
        if (!chatId) {
            toastr.info('No chat selected', 'Vectorization aborted');
            vectorizeRunActive = false;
            return false;
        }

        // Pre-flight check: verify backend is available before starting
        const backendName = settings.vector_backend || 'standard';
        const backendAvailable = await isBackendAvailable(backendName, settings);
        job.assertCurrent();
        if (!backendAvailable) {
            toastr.error(
                `Backend "${backendName}" is not available. Check your settings or start the backend service.`,
                'Vectorization aborted'
            );
            console.error(`VectHare: Backend ${backendName} failed health check before vectorization`);
            vectorizeRunActive = false;
            return false;
        }

        // Calculate total messages to vectorize
        const context = getContext();
        const totalMessages = context.chat ? context.chat.filter(x => !x.is_system).length : 0;

        // VectHare+ FIX: empty chat previously ran a full "cycle" and produced a
        // nonsense success ("Vectorized 0 messages") plus a progress panel with
        // 0/0 - now short-circuits with an honest info toast.
        if (totalMessages === 0) {
            progressTracker.hide();
            toastr.info('This chat has no messages to vectorize.', 'VectHare');
            console.log('VectHare: Vectorization skipped - chat has no vectorizable messages');
            vectorizeRunActive = false;
            resetControlState();
            return false;
        }

        // VectHare+ FIX: per_scene messages are vectorized via scene markers
        // (createSceneChunk), not by chat sync. Previously this path ran a
        // pointless cycle and toasted fake success ("Vectorized 0 messages").
        if (settings.chunking_strategy === 'per_scene') {
            progressTracker.hide();
            toastr.info(
                'Per-scene strategy is active: scenes are vectorized from scene markers on messages, not via Sync Chat.',
                'VectHare',
                { timeOut: 10000 }
            );
            console.log('VectHare: Vectorization skipped - per_scene strategy uses scene markers');
            vectorizeRunActive = false;
            resetControlState();
            return false;
        }

        // ====================================================================
        // VectHare+ R7: Vectorization configuration fingerprint
        // Continuing a run MUST use the same settings that produced the
        // existing vectors (embedding provider/model determines dimensions;
        // chunking strategy/batch size determine content). A mismatch would
        // mix incompatible vectors in one collection and poison retrieval.
        // The fingerprint is persisted on the collection's metadata and
        // compared at the start of every run.
        // ====================================================================
        {
            const fpCollectionId = getChatCollectionId();
            if (fpCollectionId) {
                try {
                    const { getCollectionMeta, setCollectionMeta } = await import('./collection-metadata.js');

                    // R9: shared computation (same function the auto-sync gate uses)
                    const configFingerprint = await computeVectorizationConfigFingerprint(settings);

                    const storedFingerprint = getCollectionMeta(fpCollectionId).vectorizationConfigFingerprint;

                    // R9: null fingerprint = computation failed -> fail-open (never block)
                    if (configFingerprint && storedFingerprint && storedFingerprint !== configFingerprint) {
                        // Only a problem if the collection actually has vectors
                        let existingVectorCount = 0;
                        try {
                            existingVectorCount = (await getSavedHashes(fpCollectionId, settings)).length || 0;
                        } catch { /* backend read failed - treat as unknown, allow with persist */ }

                        if (existingVectorCount > 0) {
                            toastr.error(
                                'Vectorization settings changed since this collection was created (embedding model, provider, or chunking strategy). Continuing would mix incompatible vectors. Either restore the previous settings, or re-vectorize the collection from the Content Vectorizer (purges and rebuilds it with the new settings).',
                                'VectHare: Settings mismatch',
                                { timeOut: 0, closeOnHover: false }
                            );
                            console.error('VectHare: Run blocked - vectorization config fingerprint mismatch', { storedFingerprint, configFingerprint });
                            vectorizeRunActive = false;
                            resetControlState();
                            return false;
                        }
                    }

                    // Persist the fingerprint so future runs can verify continuity
                    if (configFingerprint) {
                        setCollectionMeta(fpCollectionId, { vectorizationConfigFingerprint: configFingerprint });
                    }
                } catch (fpError) {
                    // Fingerprint failures must never block vectorization
                    console.warn('VectHare: Config fingerprint check failed (continuing without it):', fpError.message);
                }
            }
        }

        // Show progress panel
        progressTracker.show('Vectorizing Chat', totalMessages, 'Messages');

        let finished = false;
        let iteration = 0;
        let processedCount = 0;
        let totalChunks = 0;
        let transientBlockCount = 0; // VectHare+: consecutive transient-block counter
        let consecutiveFailingIterations = 0; // VectHare+ R6: all-fail loop guard
        let totalFailedItems = 0; // I04: partial insertion failures must not yield success

        // VectHare+: wire Pause/Resume/Stop controls into the progress panel
        resetControlState();
        progressTracker.setControls({
            onPause: () => {
                pauseVectorization();
                progressTracker.markPaused(`Paused after ${processedCount} processed — all completed vectors are saved`);
                // R9: remember when we paused so ETA/elapsed stay honest on resume
                progressTracker._pausedAt = Date.now();
                console.log('VectHare: Vectorization paused');
            },
            onResume: () => {
                resumeVectorization();
                // R9 FIX (ETA inflation): shift the run clock forward by the pause
                // duration - otherwise paused minutes counted against the average
                // and the ETA showed garbage after every long break.
                if (progressTracker._pausedAt && progressTracker.stats?.startTime) {
                    const pausedMs = Date.now() - progressTracker._pausedAt;
                    progressTracker.stats.startTime += pausedMs;
                    if (progressTracker.stats.lastBatchStartTime) {
                        progressTracker.stats.lastBatchStartTime += pausedMs;
                    }
                    progressTracker._pausedAt = null;
                }
                progressTracker.isComplete = false;
                progressTracker.isPaused = false;
                progressTracker.terminalStatus = '';
                progressTracker.startTimeUpdater();
                if (progressTracker.elements?.pauseBtn) progressTracker.elements.pauseBtn.style.display = 'inline-block';
                if (progressTracker.elements?.resumeBtn) progressTracker.elements.resumeBtn.style.display = 'none';
                if (progressTracker.elements?.stopBtn) progressTracker.elements.stopBtn.style.display = 'inline-block';
                progressTracker.updateDisplay();
                console.log('VectHare: Vectorization resumed — continuing from last completed item');
            },
            onStop: () => {
                stopVectorization();
                // R7 (user feedback): stopping must DRAIN the in-flight embedding
                // request before the run ends, so there is an unavoidable short
                // delay - but it was previously silent, looking like a dead button.
                // Immediate feedback: panel status + toast, then the normal
                // completion message arrives once the drain finishes.
                // R10: swap the ETA for "stopping…" and hold it there (tracker
                // computes ETA each tick; isStopping overrides it).
                progressTracker.isStopping = true;
                // R13: the in-flight request is now CANCELLED (AbortSignal), not
                // drained - stop is effectively instant.
                progressTracker.updateDisplay('⏹ Stopping - cancelling the in-flight request...');
                // R13 wording: request is aborted; for server-side sources the
                // server MAY still finish that single request in the background,
                // which is harmless - it writes a valid chunk the next sync's
                // hash diff reconciles. Nothing partial can ever be written.
                toastr.info('Stopping - the in-flight request is being cancelled. Everything completed is saved. The run ends immediately.', 'VectHare');
                console.log('VectHare: Vectorization stop requested (in-flight request aborted)');
            },
        });

        while (!finished) {
            job.assertCurrent();
            if (is_send_press) {
                // VectHare+: wait out the generation instead of aborting the run.
                // R6 FIX: honor Stop while waiting - previously a hung generation
                // made the Stop button unresponsive for exactly the window the
                // user would most want it.
                while (is_send_press && !isVectorizationStopped() && !isVectorizationPaused()) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
                if (!isVectorizationStopped() && !isVectorizationPaused()) {
                    progressTracker.updateProgress(processedCount, 'Resumed after message generation');
                }
            }

            // VectHare+: honor Pause — wait (without burning CPU) until resumed;
            // nothing is lost meanwhile, every completed item is already persisted
            while (isVectorizationPaused() && !isVectorizationStopped()) {
                await new Promise(resolve => setTimeout(resolve, 300));
            }

            // VectHare+: honor Stop — end cleanly, keep everything completed so far.
            // The next sync (manual, auto-sync, or resume-on-load) continues from here.
            if (isVectorizationStopped()) {
                lastRunStoppedByUser = true; // R9: suppress the follow-up resume nag
                progressTracker.complete(true, `Stopped after ${processedCount} processed — work kept, continue anytime via Vectorize Chat`);
                toastr.info('Vectorization stopped. Every completed vector is saved and syncing will continue from this point.', 'VectHare');
                vectorizeRunActive = false;
                resetControlState();
                return false;
            }

            // VectHare+: bypassAutoSync=true - the run was explicitly started by
            // the user (Sync Chat / Continue button); synchronizeChat's autoSync
            // gate must not block a manual run.
            // VectHare+ (restored + improved): bypassAutoSync=true - the run was
            // explicitly started by the user (Sync Chat / Continue button), so
            // synchronizeChat's autoSync gate must not block a manual run.
            const result = await synchronizeChat(settings, batchSize, true, job);
            job.assertCurrent();

            // VectHare+ BUG FIX (infinite failure loop): items that permanently
            // fail to embed are never written to the DB, so they re-enter the
            // queue on EVERY iteration and are retried forever - "remaining"
            // never reaches 0 and the run never ends. Detect consecutive
            // iterations that produced attempts but ZERO successful chunks and
            // bail out after 10 of them (work completed elsewhere is kept).
            totalFailedItems += result.itemsFailed || 0;
            const iterationAttempts = result.messagesProcessed || 0;
            const iterationSuccesses = result.chunksCreated || 0;
            if (iterationAttempts > 0 && iterationSuccesses === 0) {
                consecutiveFailingIterations++;
                if (consecutiveFailingIterations >= 10) {
                    progressTracker.complete(false,
                        `Giving up after 10 consecutive failed batches (~${iterationAttempts} failures in the last one). Completed vectors are saved; failed items will attempt again on the next sync.`);
                    toastr.error(
                        'Vectorization stopped: embedding requests kept failing for the remaining items. Everything completed so far is saved and resumable.',
                        'VectHare', { timeOut: 15000 }
                    );
                    console.warn(`VectHare: Aborting run - 10 consecutive iterations with zero successful chunk inserts`);
                    vectorizeRunActive = false;
                    resetControlState();
                    return false;
                }
            } else {
                consecutiveFailingIterations = 0;
            }

            // Handle disabled/blocked state.
            // VectHare+ FIX: -1 is usually TRANSIENT (send in progress, sync
            // mutex busy, momentary state). The old code aborted the entire run
            // with a scary "Blocked or disabled" failure if ANY message event
            // landed mid-run. Now: wait a beat and retry, with a consecutive-
            // failure bail-out (30 attempts ≈ 30s) for genuinely permanent
            // blocks (e.g. chat switched away and back, collection vanished).
            if (result.remaining === -1) {
                transientBlockCount++;
                if (transientBlockCount >= 30) {
                    progressTracker.complete(false, 'Blocked for 30s - giving up (collection/chat state unchanged?). Work completed so far is saved.');
                    toastr.warning('Vectorization was blocked for 30 seconds and has been stopped. Everything completed so far is saved and resumable.', 'VectHare');
                    vectorizeRunActive = false;
                    resetControlState();
                    return false;
                }
                await new Promise(resolve => setTimeout(resolve, 1000));
                continue;
            }
            transientBlockCount = 0;

            // R7 FIX (chunk progress): drive the panel's chunk counter from
            // whole-collection truth (done = total groups - remaining) instead
            // of the misleading per-item 1/1 embedding callback. This also
            // self-corrects when the chat grows during a catch-up run.
            if (result.total > 0) {
                progressTracker.updateEmbeddingProgress(result.total - result.remaining, result.total);
            }

            finished = result.remaining <= 0;
            iteration++;

            // Update progress with actual counts
            processedCount += result.messagesProcessed;
            totalChunks += result.chunksCreated;

            // R10 FIX (user feedback): the Messages counter previously showed
            // processedCount - THIS SESSION's work, resetting to 0 on every new
            // run - while the Chunks line showed whole-collection progress.
            // Both now report the same collection-wide truth: done = total
            // groups - remaining. processedCount is still used for toasts.
            progressTracker.updateProgress(
                result.total > 0 ? (result.total - result.remaining) : processedCount,
                result.remaining > 0 ? `Processing... ${result.remaining} messages remaining` : 'Finalizing...'
            );
            progressTracker.updateChunks(totalChunks);

            console.log(`VectHare: Vectorization iteration ${iteration}, ${result.remaining > 0 ? result.remaining + ' remaining' : 'complete'} (${result.chunksCreated} chunks this batch)`);

            if (chatId !== getCurrentChatId()) {
                progressTracker.complete(false, 'Chat changed during vectorization');
                vectorizeRunActive = false;
                resetControlState();
                throw new Error('Chat changed');
            }
        }

        vectorizeRunActive = false;
        resetControlState();
        if (totalFailedItems > 0) {
            progressTracker.complete(false, `Incomplete: ${totalFailedItems} item(s) failed. ${totalChunks} chunks were saved; retry Sync Chat.`);
            toastr.warning(`Vectorization incomplete: ${totalFailedItems} item(s) failed. Saved chunks are kept; retry Sync Chat.`, 'VectHare');
            return false;
        }
        progressTracker.complete(true, `Vectorized ${processedCount} messages (${totalChunks} chunks)`);
        toastr.success('Chat vectorized successfully', 'VectHare');
        console.log(`VectHare: ✅ Vectorization complete after ${iteration} iterations`);
        return true;
    } catch (error) {
        if (error instanceof StaleJobError) {
            vectorizeRunActive = false; resetControlState(); return false;
        }
        console.error('VectHare: Failed to vectorize all', error);
        vectorizeRunActive = false;
        resetControlState(); // VectHare+: never let pause/stop flags leak past a failed run
        progressTracker.addError(error.message);
        progressTracker.complete(false, 'Vectorization failed');
        toastr.error(`Vectorization failed: ${error.message}`, 'VectHare');
        return false;
    } finally { job?.finish(); }
}

/**
 * VectHare+ R12: REPAIR - fixes the already-vectorized part of the collection
 * WITHOUT continuing the backlog:
 *   1. Deletes stale vectors (source message edited or deleted).
 *   2. Heals duplicate vectors (same hash stored twice).
 *   3. Re-vectorizes ONLY "replacements": current groups whose content was
 *      previously vectorized under a now-stale hash (detected by overlapping
 *      message IDs with a ghost vector). An edited message's new text thus
 *      REPLACES its old vector.
 *   4. NEVER touches groups that were never vectorized (the backlog) - that
 *      is Sync Chat's job. Repair = make what EXISTS correct.
 *
 * Safety: aborts before touching anything if chunk metadata is unavailable
 * (protected scene/summary chunks could not be identified) or the collection
 * doesn't exist. Deletion happens AFTER successful re-insertion of each
 * replacement, so a failed embed leaves the stale vector in place rather
 * than leaving a hole. No partial state is ever created.
 *
 * @param {object} settings VectHare settings
 * @param {number} batchSize Embed batch size (unused for deletes)
 */
export async function repairChatVectors(settings, batchSize = 5) {
    let job = null;
    try {
        if (!tryAcquireVectorizationRun()) return;

        job = chatJobs.startJob({kind:'repair',collectionKey:`${settings.vector_backend || 'standard'}:${settings.source || 'transformers'}:${getChatCollectionId() || ''}`});
        const chatId = getCurrentChatId();
        if (!chatId) {
            toastr.info('No chat selected', 'Repair aborted');
            vectorizeRunActive = false;
            return;
        }

        const collectionId = getChatCollectionId();
        if (!collectionId) {
            toastr.error('Could not determine this chat\'s collection', 'Repair aborted');
            vectorizeRunActive = false;
            return;
        }

        // Repair only makes sense for an EXISTING collection (registry entries
        // only exist after a successful insert). Never creates anything.
        const known = getCollectionRegistry().some(
            key => parseRegistryKey(key).collectionId === collectionId
        );
        if (!known) {
            toastr.info('This chat has no vector collection yet - nothing to repair. Use "Sync Chat" to vectorize it.', 'Repair');
            vectorizeRunActive = false;
            return;
        }

        // Config fingerprint gate - same policy as vectorizeAll: repair adds/
        // replaces vectors, so a settings mismatch would poison the collection.
        try {
            const { getCollectionMeta, setCollectionMeta } = await import('./collection-metadata.js');
            const configFingerprint = await computeVectorizationConfigFingerprint(settings);
            job.assertCurrent();
            const storedFingerprint = getCollectionMeta(collectionId).vectorizationConfigFingerprint;
            if (configFingerprint && storedFingerprint && storedFingerprint !== configFingerprint) {
                toastr.error(
                    'Vectorization settings changed since this collection was created. Repair would mix incompatible vectors. Restore the previous settings, or re-vectorize via Content Vectorizer (Replace All).',
                    'Repair blocked: settings mismatch',
                    { timeOut: 0, closeOnHover: false }
                );
                console.error('VectHare: Repair blocked - config fingerprint mismatch');
                vectorizeRunActive = false;
                resetControlState();
                return;
            }
            if (configFingerprint && !storedFingerprint) {
                setCollectionMeta(collectionId, { vectorizationConfigFingerprint: configFingerprint });
            }
        } catch (fpError) {
            if (fpError instanceof StaleJobError) throw fpError;
            console.warn('VectHare: Repair fingerprint check failed (continuing):', fpError.message);
        }

        const context = getContext();
        if (!getCurrentChatId() || !Array.isArray(context.chat)) {
            toastr.info('No chat loaded', 'Repair aborted');
            vectorizeRunActive = false;
            return;
        }

        // Full metadata read - REQUIRED. Without per-chunk metadata we cannot
        // identify protected scene/summary chunks, so repair must not run.
        let collectionData;
        try {
            // R17: abortable+timed read (was an unbounded await - a hung backend
            // read previously stalled repair before it even started, with Stop
            // unable to free it)
            collectionData = await getSavedHashes(collectionId, settings, true, anyJobSignal(job.signal,getStopSignal()));
            job.assertCurrent();
        } catch (readError) {
            if (readError instanceof StaleJobError) throw readError;
            toastr.error('Could not read collection metadata - repair aborted, nothing was changed.', 'Repair');
            console.warn('VectHare: Repair aborted - metadata read failed:', readError.message);
            vectorizeRunActive = false;
            return;
        }

        const storedHashes = Array.isArray(collectionData) ? collectionData : (collectionData?.hashes || []);
        const metadataArr = (!Array.isArray(collectionData) && Array.isArray(collectionData?.metadata)) ? collectionData.metadata : [];

        if (storedHashes.length === 0) {
            toastr.info('The collection is empty - nothing to repair. Use "Sync Chat" to vectorize this chat.', 'Repair');
            vectorizeRunActive = false;
            return;
        }
        if (metadataArr.length === 0) {
            toastr.error('Chunk metadata unavailable from the backend - repair cannot safely identify protected chunks. Nothing was changed.', 'Repair');
            console.warn('VectHare: Repair aborted - backend returned no chunk metadata');
            vectorizeRunActive = false;
            return;
        }

        const metaByHash = new Map(storedHashes.map((h, i) => [String(h), metadataArr[i] || {}]));
        const storedHashSet = new Set(storedHashes.map(h => String(h)));

        const { getChunkMetadata } = await import('./collection-metadata.js');
        job.assertCurrent();
        const isProtectedMeta = (meta) => {
            if (!meta) return false;
            if (meta.isScene === true) return true;
            if (meta.isSummaryChunk === true || meta.isSummary === true || meta.isSummaryVector === true) return true;
            if (meta.parentHash != null) return true;
            return false;
        };
        const isProtected = (hash, meta) => {
            if (isProtectedMeta(meta)) return true;
            const chunkMeta = getChunkMetadata(hash);
            if (chunkMeta && (isProtectedMeta(chunkMeta) || chunkMeta.disabledByScene != null)) return true;
            return false;
        };

        // Current chat, grouped EXACTLY like sync (shared helper)
        const durableUids = await ensureDurableMessageUids(context.chat, context, job);
        job.assertCurrent();
        const groupedItems = collectGroupedItems(context.chat, settings, collectionId, durableUids);
        const groupByHash = new Map(groupedItems.map(it => [String(it.hash), it]));
        const currentHashSet = new Set(groupByHash.keys());

        // ---- Analyze: duplicates, ghosts, replacements ----
        const hashesToDelete = [];   // stale/duplicate vectors to remove
        const replacements = [];     // current groups to (re-)insert

        // 1) Duplicate healing (non-protected only - a duplicated scene chunk
        //    must NOT be deleted: forward sync could never recreate it)
        const dupCounts = new Map();
        for (const h of storedHashes) {
            const k = String(h);
            dupCounts.set(k, (dupCounts.get(k) || 0) + 1);
        }
        // R14 FIX: extractMessageIds handles per_message's singular `messageId`
        // AND grouped strategies' `messageIds` - previously per_message groups
        // contributed nothing here, so replacements could never match.
        const groupsByMessageId = new Map(); // messageId -> [group]
        for (const it of groupedItems) {
            for (const mid of extractMessageIds(it.metadata)) {
                if (!groupsByMessageId.has(mid)) groupsByMessageId.set(mid, []);
                groupsByMessageId.get(mid).push(it);
            }
        }

        for (const [hash, count] of dupCounts) {
            if (count <= 1) continue;
            if (isProtected(hash, metaByHash.get(hash) || null)) continue;
            hashesToDelete.push(hash);
            // Re-insert ONE clean copy if this hash is still current content
            // (dedup artifact, not a ghost). If not current, the ghost loop
            // below already covers it.
            const group = groupByHash.get(hash);
            if (group) {
                replacements.push(group);
            }
        }

        // 2) Ghosts: stored hashes that no longer match any current content
        const ghosts = [];
        for (const [hash, meta] of metaByHash) {
            if (currentHashSet.has(hash)) continue;          // still current
            if (isProtected(hash, meta)) continue;           // never delete protected
            ghosts.push({ hash, meta });
            if (!hashesToDelete.includes(hash)) hashesToDelete.push(hash);
        }

        // 3) Replacements: missing current groups whose message IDs overlap a
        //    ghost's message IDs => that content WAS vectorized before; its
        //    new text must replace the stale vector. Groups never vectorized
        //    (no overlapping ghost) stay untouched = the backlog.
        const replacementSeen = new Set();
        for (const ghost of ghosts) {
            // R14 FIX: per_message ghosts store `messageId` (singular), not
            // `messageIds` - the old check skipped EVERY per_message ghost,
            // which is why edited messages were deleted but never re-vectorized.
            const ghostMessageIds = extractMessageIds(ghost.meta);
            if (ghostMessageIds.length === 0) continue;
            for (const mid of ghostMessageIds) {
                for (const group of (groupsByMessageId.get(mid) || [])) {
                    const gHash = String(group.hash);
                    if (storedHashSet.has(gHash)) continue;         // already vectorized
                    if (replacementSeen.has(gHash)) continue;       // already queued
                    replacements.push(group);
                    replacementSeen.add(gHash);
                }
            }
        }

        // R14/R18: diagnostic logging. R18 expands this to hash-level detail so
        // the "repair looks clean in-session but dirty again after reload"
        // oscillation (user report) can be attributed in ONE test: compare the
        // collectionId line and the per-hash lines across a page reload.
        // - Same collectionId, same msgIds, DIFFERENT hashes after reload =>
        //   session-dependent hash drift (macros/regex/fileLength in the text)
        // - DIFFERENT collectionId after reload => collection-ID split (watch
        //   for the "falling back to chatId" warning)
        console.log(`VectHare: Repair target - collection "${collectionId}" (backend: ${settings.vector_backend || 'standard'}, multitenancy: ${!!settings.qdrant_multitenancy})`);
        console.log(`VectHare: Repair analysis - stale/duplicate vectors to delete: ${hashesToDelete.length}, replacements to re-vectorize: ${replacements.length}`);
        for (const { hash, meta } of ghosts) {
            console.log(`  [stale] hash ${hash} (msgIds: ${extractMessageIds(meta).join(',') || '?'})`);
        }
        for (const item of replacements) {
            console.log(`  [replace] hash ${item.hash} (msgIds: ${extractMessageIds(item.metadata).join(',') || '?'})`);
        }

        if (hashesToDelete.length === 0 && replacements.length === 0) {
            // R16 FIX: complete() (not bare hide()) - the old bare hide left
            // the panel's Pause/Stop controls bound to a dead run; a later
            // panel reveal resurrected clickable controls for a run that no
            // longer existed. complete() hides controls and shows an honest
            // green-tick line.
            progressTracker.complete(true, 'Nothing to repair - all vectorized chunks match the current chat');
            toastr.success('Nothing to repair - all vectorized chunks match the current chat.', 'Repair');
            vectorizeRunActive = false;
            resetControlState();
            return;
        }

        // ---- Execute with progress panel + Pause/Stop ----
        const totalUnits = hashesToDelete.length + replacements.length;
        progressTracker.show('Repairing Chunks', totalUnits, 'Items');
        resetControlState();
        progressTracker.setControls({
            onPause: () => { pauseVectorization(); progressTracker.markPaused('Repair paused - completed fixes are saved'); },
            onResume: () => {
                resumeVectorization();
                progressTracker.isComplete = false;
                progressTracker.isPaused = false;
                progressTracker.terminalStatus = '';
                progressTracker.startTimeUpdater();
                if (progressTracker.elements?.pauseBtn) progressTracker.elements.pauseBtn.style.display = 'inline-block';
                if (progressTracker.elements?.resumeBtn) progressTracker.elements.resumeBtn.style.display = 'none';
                if (progressTracker.elements?.stopBtn) progressTracker.elements.stopBtn.style.display = 'inline-block';
                progressTracker.updateDisplay();
            },
            onStop: () => {
                stopVectorization();
                progressTracker.isStopping = true;
                // R13: in-flight request is cancelled, not drained
                progressTracker.updateDisplay('⏹ Stopping - cancelling the in-flight request...');
                toastr.info('Stopping repair - the in-flight request is cancelled. Completed fixes are saved; nothing is ever partially saved.', 'VectHare');
            },
        });

        let done = 0;
        let inserted = 0;
        let failed = 0;
        // R20: hashes of FAILED replacements - their ghosts must NOT be deleted
        // in Phase 2 (insert-before-delete guarantee: the stale vector stays as
        // the recall fallback until the replacement exists)
        const failedHashes = new Set();
        const label = 'Item';

        // Phase 1: re-insert replacements FIRST (insert-before-delete: a failed
        // embed leaves the stale vector in place rather than a hole; the ghost
        // cleanup on the next pass will retry)
        for (const item of replacements) {
            job.assertCurrent();
            if (isVectorizationStopped() || isVectorizationPaused()) break;
            try {
                const chunks = prepareItemsForInsertion([item]);
                // R13: abortable - Stop cancels the in-flight repair embed
                const receipt = await chatJobs.trackWrite(job, () => insertVectorItems(collectionId, chunks, settings, (embedded, total) => {
                    if(job.signal.aborted) return;
                    progressTracker.updateCurrentItem(`${label} ${done + 1}/${totalUnits} - embedding ${embedded}/${total}`);
                }, anyJobSignal(job.signal,getStopSignal())), {collectionKey:job.snapshot.collectionKey});
                job.assertCurrent();
                if (receipt?.status === 'uncertain' || receipt?.requiresReconciliation) {failedHashes.add(String(item.hash)); failed++;}
                else inserted++;
            } catch (err) {
                // R13: user abort is a clean stop, not a failed item
                if (job.signal.aborted) throw new StaleJobError('chat-changed');
                if (isVectorizationStopped()) break;
                console.warn(`VectHare: Repair - failed to re-vectorize group (hash ${item.hash}):`, err.message);
                failedHashes.add(String(item.hash)); // R20: keep its stale vector as fallback
                failed++;
            }
            done++;
            progressTracker.updateProgress(done, `Repairing... ${totalUnits - done} remaining`);
        }

        // Phase 0: never remove a stale hash until its mapped replacement is
        // positively verified AND the backend can prove scoped inventory and
        // deletion acknowledgement. We cannot prove those contracts yet.
        const proposedPlan = planReplacement(hashesToDelete, replacements);
        const candidateDeletes = proposedPlan.toDelete.filter(h => !failedHashes.has(h));
        const safeDeletes = []; // Filled only by a verified follow-up, never by an assumption.
        const deferredDeletes = [...candidateDeletes];
        if (deferredDeletes.length) {
            console.warn(`VectHare: Repair deferred ${deferredDeletes.length} obsolete hash(es): backend contract/ownership verification required`);
        }

        // R15: VERIFY the work. Re-read the collection and confirm every
        // replacement's hash is actually present. An insert can silently
        // fail (backend accepts then drops, embeds nothing, etc.) and until
        // now repair reported success based on "no exception thrown" alone.
        let confirmed = 0;
        let readbackVerified = false;
        const unconfirmed = [];
        if (replacements.length > 0) {
            try {
                const hashes = await getSavedHashes(collectionId, settings, false, anyJobSignal(job.signal,getStopSignal()));
                job.assertCurrent();
                if (!Array.isArray(hashes)) throw new Error('Read-back inventory was not an array');
                readbackVerified = hasVerifiedCapability(settings?.vector_backend || 'standard','getByIds');
                const verifyHashes = new Set(hashes.map(h => String(h))); 
                for (const item of replacements) {
                    if (verifyHashes.has(String(item.hash))) {
                        confirmed++;
                    } else {
                        unconfirmed.push(item);
                    }
                }
                console.log(`VectHare: Repair verification - ${confirmed}/${replacements.length} replacement(s) confirmed in DB: [${replacements.map(r => r.hash).join(', ')}]`);
                for (const item of unconfirmed) {
                    console.warn(`VectHare: Repair verification FAILED for hash ${item.hash} (message index ${item.metadata?.messageId ?? item.metadata?.messageIds?.join(',')}): "${String(item.text).substring(0, 80)}..."`);
                }
            } catch (verifyError) {
                if (verifyError instanceof StaleJobError) throw verifyError;
                unconfirmed.push(...replacements); // A failed read is not an empty successful result.
                console.warn('VectHare: Repair verification read failed (cannot confirm inserts)');
            }
        }

        vectorizeRunActive = false;
        resetControlState();
        const unconfirmedCount = unconfirmed.length;
        // An unverified read-back cannot authorize deletion, and a missing
        // old→new mapping must never be silently inferred from a hash alone.
        const fullyVerified = failed === 0 && unconfirmedCount === 0 && deferredDeletes.length === 0
            && (replacements.length === 0 || readbackVerified);
        if (fullyVerified) {
            progressTracker.complete(true, `Repair verified: ${confirmed} replacement(s), no destructive cleanup needed`);
            toastr.success('Repair verified; no destructive cleanup needed.', 'Repair');
        } else {
            progressTracker.complete(false, `Repair incomplete: ${confirmed} observed, ${unconfirmedCount} not observed, ${deferredDeletes.length} deletion(s) deferred; requires reconciliation`);
            toastr.warning(
                `Repair requires reconciliation: ${deferredDeletes.length} old vector(s) preserved, ${unconfirmedCount} new record(s) not observed, ${failed} operation(s) failed. No destructive follow-up was authorized.`,
                'Repair incomplete', {timeOut: 15000}
            );
        }
    } catch (error) {
        if (error instanceof StaleJobError) {vectorizeRunActive=false;resetControlState();return;}
        console.error('VectHare: Repair failed', error);
        vectorizeRunActive = false;
        resetControlState();
        progressTracker.addError(error.message);
        progressTracker.complete(false, 'Repair failed');
        toastr.error(`Repair failed: ${error.message}`, 'VectHare');
    } finally {job?.finish();}
}

/**
 * VectHare+: Detects unfinished vectorization work for the current chat.
 * Compares grouped chat items against the collection's stored hashes without
 * vectorizing anything. Used on startup/chat-load to surface a "continue"
 * affordance for an interrupted run — the core of resume-on-load.
 *
 * @param {object} settings VectHare settings
 * @returns {Promise<{hasBacklog: boolean, pending: number, total: number}|null>} null if undeterminable
 */
export async function checkUnfinishedVectorization(settings, collectionIdOverride = null) {
    try {
        const collectionId = collectionIdOverride || getChatCollectionId();
        if (!collectionId) return null;
        if (settings.chunking_strategy === 'per_scene') return null;

        // VectHare+ FIX (ghost collections): only inspect collections already
        // known to the registry. Registry entries are only created after a
        // successful insert, so this both avoids wasted work AND prevents the
        // resume check from reading a vector DB that doesn't exist yet — some
        // backends create an empty collection on read, which previously
        // surfaced as 0-chunk "ghost" chats in discovery.
        const registry = getCollectionRegistry();
        const knownInRegistry = registry.some(
            key => parseRegistryKey(key).collectionId === collectionId
        );
        // Returns null in this case so callers can distinguish "collection not
        // discovered yet (retry)" from an actual definitive "no backlog".
        if (!knownInRegistry) {
            console.debug('VectHare: Resume check inconclusive - collection not in registry yet');
            return null;
        }

        const context = getContext();
        if (!getCurrentChatId() || !Array.isArray(context.chat)) return null;

        const existingHashes = new Set(await getSavedHashes(collectionId, settings));

        const strategy = settings.chunking_strategy || 'per_message';
        const strategyBatchSize = settings.batch_size || 4;
        const keywordLevel = settings.keyword_extraction_level || 'balanced';

        const allMessages = [];
        for (let i = 0; i < context.chat.length; i++) {
            const msg = context.chat[i];
            if (msg.is_system) continue;
            const rawText = String(substituteParams(msg.mes));
            const text = cleanText(rawText);
            allMessages.push({
                text,
                raw: getTextWithoutAttachments(msg), // R22: unsubstituted, for stable hashing
                hash: getStringHash(getTextWithoutAttachments(msg)), // R22: raw text, not substituted - stable identity across reloads
                index: i,
                is_user: msg.is_user
            });
        }

        const groupedItems = groupMessagesByStrategy(allMessages, strategy, strategyBatchSize, keywordLevel, settings.conversation_turn_order);
        const pending = groupedItems.filter(item => !existingHashes.has(item.hash)).length;

        return {
            hasBacklog: pending > 0,
            pending,
            total: groupedItems.length,
            storedChunks: existingHashes.size
        };
    } catch (error) {
        console.warn('VectHare: Could not check for unfinished vectorization:', error.message);
        return null;
    }
}

/**
 * Purges vector index for current chat
 * @param {object} settings VectHare settings
 */
export async function purgeChatIndex(settings) {
    if (!getCurrentChatId()) {
        toastr.info('No chat selected', 'Purge aborted');
        return;
    }

    const collectionId = getChatCollectionId();
    if (!collectionId) {
        toastr.error('Could not get collection ID', 'Purge aborted');
        return;
    }

    if (await purgeVectorIndex(collectionId, settings)) {
        toastr.success('Vector index purged', 'VectHare');
        console.log('VectHare: Index purged successfully');
    } else {
        toastr.error('Failed to purge vector index', 'VectHare');
    }
}

import {messageReference, fingerprint, reconcileSceneBoundaries} from '../utils/record-identity.js';
import {formatCollectionKey} from '../utils/collection-keys.js';
import {hasVerifiedCapability} from '../utils/backend-contracts.js';
import {updateSceneAndReindex} from '../utils/c12-scene-update.js';
import {rememberCommittedScene,forgetCommittedScene,getSceneTimeline} from './scene-timeline.js';
import {getVerifiedChatOriginId} from './collection-ids.js';
/**
 * ============================================================================
 * VECTHARE SCENE MANAGEMENT
 * ============================================================================
 * Scenes are composite chunks in the vector database. When a user marks a
 * scene (start→end), we create a single chunk from the combined message text
 * and insert it into the collection with isScene:true metadata.
 *
 * Scene chunks have metadata:
 * - isScene: true
 * - sceneStart: message index where scene starts
 * - sceneEnd: message index where scene ends
 * - containedHashes: hashes of individual chunks this scene replaces
 * - title, summary, keywords: user-provided metadata
 *
 * Individual chunks within a scene get disabledByScene: sceneHash
 *
 * @author Coneja Chibi
 * @version 2.2.0-alpha
 * ============================================================================
 */

import { getContext } from '../../../../extensions.js';
import { substituteParams, getCurrentChatId } from '../../../../../script.js';
import { getStringHash } from '../../../../utils.js';
import {
    insertVectorItems,
    deleteVectorItems,
    replaceVectorRecords,
    updateChunkMetadata,
} from './core-vector-api.js';
import { getChatCollectionId, getTextWithoutAttachments } from './chat-vectorization.js';
import {
    getChunkMetadata,
    saveChunkMetadata,
    deleteChunkMetadata,
} from './collection-metadata.js';

// ============================================================================
// CONSTANTS
// ============================================================================

/**
 * Scene mode determines how scenes interact with retrieval
 * @type {Object.<string, string>}
 */
export const SCENE_MODES = {
    NONE: 'none',                   // Scenes are visual only, no special treatment
    SCENES_ONLY: 'scenes_only',     // Only scene chunks, individual chunks disabled
    SCENES_REPLACE: 'scenes_replace', // Same as above, clearer intent
    SCENES_BOOST: 'scenes_boost',   // Both exist, scenes get relevance boost
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Gets the collection ID for the current chat
 * Uses the new vh:chat:uuid format, with legacy fallback
 * @returns {string|null}
 */
export function getCurrentCollectionId() {
    // Try new format first
    const newFormatId = getChatCollectionId();
    if (newFormatId) {
        return newFormatId;
    }
    // Fallback to legacy format
    const chatId = getCurrentChatId();
    if (!chatId) return null;
    return `vecthare_chat_${chatId}`;
}

/**
 * Builds combined text from messages in a range
 * R24: `substitute` param - hashing MUST use raw text (stable identity across
 * reloads, matching the R22 chat-hash policy); embedding/display text stays
 * substituted (macros resolve at use time)
 * @param {object[]} messages - Chat messages array
 * @param {number} start - Start index
 * @param {number} end - End index
 * @param {boolean} [substitute=true] - Resolve macros (display text) or keep raw (hashing)
 * @returns {string}
 */
function buildSceneText(messages, start, end, substitute = true) {
    const sceneMessages = messages.slice(start, end + 1);
    return sceneMessages
        .filter(msg => msg.mes && !msg.is_system)
        .map(msg => `${msg.name || 'Unknown'}: ${substitute ? substituteParams(msg.mes) : msg.mes}`)
        .join('\n\n');
}

/**
 * Computes hash for scene from combined RAW text
 * R24: raw, not substituted - scene identity must be reload-stable
 * @param {object[]} messages - Chat messages array
 * @param {number} start - Start index
 * @param {number} end - End index
 * @returns {number}
 */
export function computeSceneHash(messages, start, end) {
    const text = buildSceneText(messages, start, end, false);
    return getStringHash(text);
}

/**
 * Gets hashes of individual chunks within a scene range
 * R24: uses the EXACT chat-vectorizer formula (getTextWithoutAttachments,
 * raw) - the previous inline getStringHash(msg.mes) diverged for messages
 * with file attachments (attachment prefix left in), making scene disable-
 * linkage point at hashes that don't exist in the DB
 * @param {object[]} messages - Chat messages array
 * @param {number} start - Start index
 * @param {number} end - End index
 * @returns {number[]}
 */
export function getContainedChunkHashes(messages, start, end) {
    const hashes = [];
    const sceneMessages = messages.slice(start, end + 1);

    for (const msg of sceneMessages) {
        if (msg.mes && !msg.is_system) {
            hashes.push(getStringHash(getTextWithoutAttachments(msg)));
        }
    }

    return hashes;
}

// ============================================================================
// SCENE CHUNK OPERATIONS
// ============================================================================

/**
 * Creates and inserts a scene chunk into the vector database
 * @param {number} start - Start message index
 * @param {number} end - End message index
 * @param {object} sceneData - Scene metadata (title, summary, keywords)
 * @param {object} settings - VectHare settings
 * @returns {Promise<{success: boolean, hash?: number, error?: string}>}
 */
export async function createSceneChunk(start, end, sceneData, settings) {
    const collectionId = getCurrentCollectionId();
    if (!collectionId) {
        return { success: false, error: 'No chat selected' };
    }

    const context = getContext();
    const messages = context?.chat;
    if (!messages || !Array.isArray(messages)) {
        return { success: false, error: 'No chat messages available' };
    }

    if (start < 0 || end < start || end >= messages.length) {
        return { success: false, error: 'Invalid scene boundaries' };
    }

    // Build scene text and compute hash
    // R24: display/embed text stays substituted; the HASH comes from RAW text
    // (reload-stable identity, matches computeSceneHash)
    const sceneText = buildSceneText(messages, start, end, true);
    if (!sceneText.trim()) {
        return { success: false, error: 'Scene contains no text' };
    }

    const sceneHash = computeSceneHash(messages, start, end);
    const containedHashes = getContainedChunkHashes(messages, start, end);
    const stableChatId = getVerifiedChatOriginId();
    const boundaryRef = (index) => {
        if (!stableChatId) return null;
        try {return messageReference(stableChatId, messages[index]);} catch (_) {return null;}
    };
    const sceneStartRef = boundaryRef(start), sceneEndRef = boundaryRef(end);


    // Build chunk for insertion
    const sceneChunk = {
        hash: sceneHash,
        text: sceneText,
        metadata: {
            isScene: true,
            sceneId: String(sceneHash),
            sceneStart: start,
            sceneEnd: end,
            ...(sceneStartRef && sceneEndRef ? {sceneStartRef,sceneEndRef} : {}),
            contentFingerprint: fingerprint(getTextWithoutAttachments({mes:buildSceneText(messages, start, end, false)})),
            containedHashes: containedHashes,
            title: sceneData.title || `Scene ${start}-${end}`,
            summary: sceneData.summary || '',
            keywords: sceneData.keywords || [],
            messageCount: end - start + 1,
            createdAt: Date.now(),
        }
    };

    try {
        // Insert scene chunk into vector DB
        const staged=await replaceVectorRecords(collectionId,[],[sceneChunk],settings,{kind:'scene-replace'});
        if(staged?.status!=='committed')return {
            success:false,requiresReconciliation:true,
            operationId:staged?.operationId,
            error:'Scene creation requires reconciliation; existing message chunks remain enabled',
        };

        // Disable contained chunks
        for (const hash of containedHashes) {
            const existing = getChunkMetadata(hash) || {};
            saveChunkMetadata(hash, {
                ...existing,
                disabledByScene: sceneHash,
                disabledAt: Date.now(),
            });
        }

        if (stableChatId) {
            const key = formatCollectionKey({backend:settings?.vector_backend || 'standard',source:settings?.source || 'transformers',collectionId});
            rememberCommittedScene(stableChatId,key,{...sceneChunk.metadata,hash:sceneHash});
        }
        console.log(`VectHare Scenes: Created scene chunk ${sceneHash} (${start}-${end}), disabled ${containedHashes.length} chunks`);
        return { success: true, hash: sceneHash };

    } catch (error) {
        console.error('VectHare Scenes: Failed to create scene chunk', error);
        return { success: false, error: error.message || 'Failed to insert scene' };
    }
}

/**
 * Deletes a scene chunk and re-enables contained chunks
 * @param {number} sceneHash - Hash of the scene chunk to delete
 * @param {number[]} containedHashes - Hashes of chunks to re-enable
 * @param {object} settings - VectHare settings
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function deleteSceneChunk(sceneHash, containedHashes, settings) {
    const collectionId = getCurrentCollectionId();
    if (!collectionId) {
        return { success: false, error: 'No chat selected' };
    }

    try {
        // C02 delete journal must prove scoped delete and final readback before
        // re-enabling any disabled member. An HTTP acknowledgement is not proof.
        const key=formatCollectionKey({backend:settings?.vector_backend||'standard',source:settings?.source||'transformers',collectionId});
        const receipt=await replaceVectorRecords(key,[sceneHash],[],settings,{kind:'scene-delete'});
        if (receipt?.status!=='committed') return {success:false,requiresReconciliation:true,
            error:'Scene delete requires reconciliation; original member links preserved'};

        // Re-enable contained chunks
        for (const hash of containedHashes) {
            const existing = getChunkMetadata(hash);
            if (existing && existing.disabledByScene === sceneHash) {
                const { disabledByScene, disabledAt, ...rest } = existing;
                if (Object.keys(rest).length > 0) {
                    saveChunkMetadata(hash, rest);
                } else {
                    deleteChunkMetadata(hash);
                }
            }
        }

        const chatId=getVerifiedChatOriginId();
        if (chatId) forgetCommittedScene(chatId,key,sceneHash);
        console.log(`VectHare Scenes: Deleted scene chunk ${sceneHash}, re-enabled ${containedHashes.length} chunks`);
        return { success: true };

    } catch (error) {
        console.error('VectHare Scenes: Failed to delete scene chunk', error);
        return { success: false, error: error.message || 'Failed to delete scene' };
    }
}

/**
 * Updates a scene chunk's metadata (title, summary, keywords)
 * Does NOT change boundaries - for that, delete and recreate
 * @param {number} sceneHash - Hash of the scene chunk
 * @param {object} updates - Fields to update
 * @param {object} settings - VectHare settings
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function updateSceneChunkMetadata(sceneHash, updates, settings, scene = null) {
    // The old path saved only local settings, leaving vector metadata and the
    // search embedding unchanged. It cannot report a successful scene edit.
    const collectionId = getCurrentCollectionId();
    if (!collectionId) return {success:false,error:'No chat selected'};
    if (!scene?.metadata?.isScene || String(scene.hash)!==String(sceneHash))
        return {success:false,error:'Original scene record required for safe editing'};
    const collectionKey = formatCollectionKey({backend:settings?.vector_backend || 'standard',
        source:settings?.source || 'transformers',collectionId});
    const backend = settings?.vector_backend || 'standard';
    const result = await updateSceneAndReindex({
        scene,patch:updates,collectionKey,
        commitMetadata: async(hash, metadata, key) => {
            if (!hasVerifiedCapability(backend,'updatePayload') || !hasVerifiedCapability(backend,'getByIds') ||
                !hasVerifiedCapability(backend,'tenantFilter'))
                throw new Error('Scene metadata update blocked: backend payload and scoped readback contracts unverified');
            const ack = await updateChunkMetadata(collectionId,hash,metadata,settings);
            // A transport-level response is not a verified point-level readback.
            // The plugin supplies no authoritative confirmation yet.
            return {status:'unverified',acknowledged:!!ack,scope:key,recordId:String(hash)};
        },
        replaceRecords:async(key,oldIds,items)=>replaceVectorRecords(key,oldIds,items,settings,{kind:'scene-summary-reindex'}),
        // C07 cross-reference migration is a guarded plan, not a verified live
        // transaction. Do not invent a confirmed reference-rewrite callback.
        buildReplacement:()=>{throw new Error('Scene summary reindex blocked: verified C07 reference migration unavailable');},
        commitLocal:async()=>{throw new Error('Host settings persistence not verified');},
    });
    return result.status === 'committed' ? {success:true,...result}
        : {success:false,requiresReconciliation:true,error:result.reason || 'Scene update unverified'};
}

// ============================================================================
// SCENE QUERIES
// ============================================================================

/**
 * Checks if a chunk is disabled by a scene
 * @param {number} hash - Chunk hash
 * @returns {boolean}
 */
export function isChunkDisabledByScene(hash) {
    const meta = getChunkMetadata(hash);
    return meta?.disabledByScene != null;
}

/**
 * Gets the scene hash that disabled a chunk
 * @param {number} hash - Chunk hash
 * @returns {number|null}
 */
export function getDisablingSceneHash(hash) {
    const meta = getChunkMetadata(hash);
    return meta?.disabledByScene ?? null;
}

/**
 * Filters scene chunks from a list of chunks
 * @param {object[]} chunks - Array of chunks with metadata
 * @returns {object[]} Only chunks where metadata.isScene === true
 */
export function filterSceneChunks(chunks) {
    return chunks.filter(chunk => chunk.metadata?.isScene === true);
}

/**
 * Filters out scene chunks (returns only regular chunks)
 * @param {object[]} chunks - Array of chunks with metadata
 * @returns {object[]} Only chunks where metadata.isScene !== true
 */
export function filterNonSceneChunks(chunks) {
    return chunks.filter(chunk => chunk.metadata?.isScene !== true);
}

/**
 * Filters out chunks disabled by scenes
 * @param {object[]} chunks - Array of chunks
 * @returns {object[]} Chunks not disabled by scenes
 */
export function filterDisabledChunks(chunks) {
    return chunks.filter(chunk => !isChunkDisabledByScene(chunk.hash));
}

// ============================================================================
// SCENE BOUNDARY HELPERS (for UI markers)
// ============================================================================

/**
 * Finds scene chunk that contains a specific message
 * @param {object[]} sceneChunks - Array of scene chunks
 * @param {number} messageId - Message index
 * @returns {object|null}
 */
export function findSceneAtMessage(sceneChunks, messageId) {
    return sceneChunks.find(chunk => {
        if (!chunk.metadata?.isScene) return false;
        const bounds = resolveSceneBounds(chunk);
        return bounds && messageId >= bounds.sceneStart && messageId <= bounds.sceneEnd;
    }) || null;
}

function resolveSceneBounds(chunk) {
    const meta = chunk?.metadata;
    if (!meta) return null;
    if (!meta.sceneStartRef && !meta.sceneEndRef) return meta; // legacy
    // Half-migrated scenes never fall back to stale positional markers.
    if (!meta.sceneStartRef || !meta.sceneEndRef) return null;
    const chatId = getVerifiedChatOriginId();
    const chat = getContext()?.chat;
    if (!chatId || !Array.isArray(chat)) return null;
    const outcome = reconcileSceneBoundaries([chunk], chatId, chat)[0];
    return outcome.status === 'ready' ? outcome.metadata : null;
}

/**
 * Checks if a message is a scene boundary
 * @param {object[]} sceneChunks - Array of scene chunks
 * @param {number} messageId - Message index
 * @returns {{isStart: boolean, isEnd: boolean, scene: object|null}}
 */
export function getMessageSceneStatus(sceneChunks, messageId) {
    for (const chunk of sceneChunks) {
        if (!chunk.metadata?.isScene) continue;

        const bounds = resolveSceneBounds(chunk);
        if (!bounds) continue;
        if (bounds.sceneStart === messageId) {
            return { isStart: true, isEnd: false, scene: chunk };
        }
        if (bounds.sceneEnd === messageId) {
            return { isStart: false, isEnd: true, scene: chunk };
        }
    }

    const containingScene = findSceneAtMessage(sceneChunks, messageId);
    return {
        isStart: false,
        isEnd: false,
        scene: containingScene,
    };
}

/**
 * Gets open scene (one that has started but not ended in the current session)
 * Note: This is for UI state tracking, not stored in DB
 * @returns {object|null} Pending scene info or null
 */
let pendingSceneStart = null;

export function getPendingScene() {
    return pendingSceneStart;
}

export function setPendingSceneStart(messageId) {
    pendingSceneStart = messageId !== null ? { start: messageId } : null;
}

export function clearPendingScene() {
    pendingSceneStart = null;
}

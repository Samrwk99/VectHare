import { acquireLease } from './leases.js';
import { vhLog } from '../utils/log.js';
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
    getSavedHashes,
    deleteVectorItems,
} from './core-vector-api.js';
import { getChatCollectionId, getTextWithoutAttachments } from './chat-vectorization.js';
import { ensureChatBinding, recordChatStore, beginChatCollectionWrite, endChatCollectionWrite } from './collection-ids.js';
import {
    getChunkMetadata,
    saveChunkMetadata,
    deleteChunkMetadata,
    canRecordInitialVectorizationConfig,
    createInitialVectorizationConfig,
    saveInitialVectorizationConfig,
    resolveCollectionOperationSettings,
    snapshotCollectionOperationSettings,
    assertCollectionOperationSettingsStable,
    getAnnotatedChunkHashes,
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
    // Never build an unverified fallback ID for an unbound chat.
    return getChatCollectionId();
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
    settings = snapshotCollectionOperationSettings(settings);
    let initialConfig;
    const binding = await ensureChatBinding();
    const collectionId = binding.writable ? binding.collectionId : null;
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

    try {
        const resolved = await resolveCollectionOperationSettings(collectionId, settings, 'scene-markers', {
            pipeline: 'scene-markers', strategy: 'per_scene',
        }, { allowNew: true });
        if (resolved.status === 'new') {
            // A scene must not be the first write into a chat's collection: it
            // would record the collection's write-once settings as a scene
            // collection and Sync could never use this chat's collection again.
            return { success: false, error: 'This chat has no vectors yet. Run Sync Chat first (or let auto-sync run), then mark the scene again.' };
        }
        settings = resolved.settings;
        initialConfig = resolved.config || createInitialVectorizationConfig(settings, {
            pipeline: 'scene-markers', strategy: 'per_scene',
        });
    } catch (error) {
        return { success: false, error: error.message };
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

    // Build chunk for insertion
    const sceneChunk = {
        hash: sceneHash,
        text: sceneText,
        metadata: {
            isScene: true,
            sceneStart: start,
            sceneEnd: end,
            containedHashes: containedHashes,
            title: sceneData.title || `Scene ${start}-${end}`,
            summary: sceneData.summary || '',
            keywords: sceneData.keywords || [],
            messageCount: end - start + 1,
            createdAt: Date.now(),
        }
    };

    try {
        // Provenance belongs to the outgoing vector, not the SillyTavern chat.
        sceneChunk.__vecthareProvenanceHint = {
            writer: 'scene-markers', sourceType: 'scene', groupingStrategy: 'per_scene',
        };
        let initiallyEmpty = false;
        if (canRecordInitialVectorizationConfig(collectionId)) {
            try {
                initiallyEmpty = (await getSavedHashes(collectionId, settings)).length === 0;
            } catch (error) {
                console.warn('VectHare Scenes: Could not verify first vectorization settings:', error);
            }
        }
        // Insert scene chunk into vector DB (8C: under the chat's cross-tab lease)
        const lease = await acquireLease(collectionId, { label: 'Scene' });
        beginChatCollectionWrite(collectionId);
        try {
            assertCollectionOperationSettingsStable(initialConfig, settings, initialConfig?.chunking);
            recordChatStore(collectionId, settings);
            await insertVectorItems(collectionId, [sceneChunk], settings);
            if (initiallyEmpty) await saveInitialVectorizationConfig(collectionId, initialConfig, settings);
        } finally {
            endChatCollectionWrite(collectionId);
            await lease.release();
        }

        // Disable contained chunks
        for (const hash of containedHashes) {
            const existing = getChunkMetadata(hash, collectionId) || {};
            saveChunkMetadata(hash, {
                ...existing,
                disabledByScene: sceneHash,
                disabledAt: Date.now(),
            }, collectionId);
        }

        vhLog(`VectHare Scenes: Created scene chunk ${sceneHash} (${start}-${end}), disabled ${containedHashes.length} chunks`);
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
        // Delete scene chunk from vector DB (8C: under the chat's cross-tab lease)
        const lease = await acquireLease(collectionId, { label: 'Scene' });
        try {
            await deleteVectorItems(collectionId, [sceneHash], settings);
        } finally {
            await lease.release();
        }

        // Re-enable contained chunks
        for (const hash of containedHashes) {
            const existing = getChunkMetadata(hash, collectionId);
            if (existing && existing.disabledByScene === sceneHash) {
                const { disabledByScene, disabledAt, ...rest } = existing;
                if (Object.keys(rest).length > 0) {
                    saveChunkMetadata(hash, rest, collectionId);
                } else {
                    deleteChunkMetadata(hash, collectionId);
                }
            }
        }

        vhLog(`VectHare Scenes: Deleted scene chunk ${sceneHash}, re-enabled ${containedHashes.length} chunks`);
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
export async function updateSceneChunkMetadata(sceneHash, updates, settings, collectionId = null) {
    // Scene metadata is stored in chunk metadata, not vector DB
    const existing = getChunkMetadata(sceneHash, collectionId) || {};

    const updatedMeta = {
        ...existing,
        ...(updates.title !== undefined && { title: updates.title }),
        ...(updates.summary !== undefined && { summary: updates.summary }),
        ...(updates.keywords !== undefined && { keywords: updates.keywords }),
        updatedAt: Date.now(),
    };

    saveChunkMetadata(sceneHash, updatedMeta, collectionId);
    vhLog(`VectHare Scenes: Updated metadata for scene ${sceneHash}`);
    return { success: true };
}

// ============================================================================
// SCENE QUERIES
// ============================================================================

/**
 * Checks if a chunk is disabled by a scene
 * @param {number} hash - Chunk hash
 * @returns {boolean}
 */
export function isChunkDisabledByScene(hash, collectionId = null) {
    const meta = getChunkMetadata(hash, collectionId);
    return meta?.disabledByScene != null;
}

/**
 * Gets the scene hash that disabled a chunk
 * @param {number} hash - Chunk hash
 * @returns {number|null}
 */
export function getDisablingSceneHash(hash, collectionId = null) {
    const meta = getChunkMetadata(hash, collectionId);
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
    return chunks.filter(chunk => !isChunkDisabledByScene(chunk.hash, chunk.collectionId));
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
    return sceneChunks.find(chunk =>
        chunk.metadata?.isScene &&
        messageId >= chunk.metadata.sceneStart &&
        messageId <= chunk.metadata.sceneEnd
    ) || null;
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

        if (chunk.metadata.sceneStart === messageId) {
            return { isStart: true, isEnd: false, scene: chunk };
        }
        if (chunk.metadata.sceneEnd === messageId) {
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

// ============================================================================
// F8: SCENE STALENESS
// ============================================================================
// A scene is a protected chunk: Sync and Repair never retire it. When one of
// its messages is edited or deleted, the stored scene no longer describes the
// chat. After Sync/Repair the scene is checked against the current messages;
// a mismatch marks it "outdated" (a VectHare annotation, no vector write). An
// outdated scene is not injected and is shown with a "Re-create scene" action.
// Nothing is rewritten automatically.

const messageHashOf = msg => (msg?.mes && !msg.is_system
    ? String(getStringHash(getTextWithoutAttachments(msg))) : null);

/**
 * Finds where a scene's messages are now: the single contiguous run of chat
 * messages whose hashes equal the scene's containedHashes in order. A missing
 * member or more than one possible run -> null (cannot be located).
 * @returns {{start: number, end: number}|null}
 */
export function locateSceneMembers(messages, containedHashes) {
    const wanted = Array.isArray(containedHashes) ? containedHashes.map(String) : [];
    if (!wanted.length || !Array.isArray(messages)) return null;
    const items = [];
    messages.forEach((msg, index) => {
        const hash = messageHashOf(msg);
        if (hash !== null) items.push({ index, hash });
    });
    const runs = [];
    for (let k = 0; k + wanted.length <= items.length; k++) {
        if (wanted.every((hash, j) => items[k + j].hash === hash)) {
            runs.push({ start: items[k].index, end: items[k + wanted.length - 1].index });
        }
    }
    return runs.length === 1 ? runs[0] : null;
}

/**
 * True when the stored scene still matches the current chat.
 * @param {object[]} messages Current chat
 * @param {{hash: number|string, metadata: object}} scene Scene chunk
 */
export function isSceneCurrent(messages, scene) {
    const range = locateSceneMembers(messages, scene?.metadata?.containedHashes);
    if (!range) return false;
    return String(computeSceneHash(messages, range.start, range.end)) === String(scene.hash);
}

/** Whether a scene was marked outdated by the last check. */
export function isSceneOutdated(hash, collectionId = null) {
    return getChunkMetadata(hash, collectionId)?.sceneOutdated === true;
}

/**
 * Re-checks every scene of the current chat's collection and records which are
 * outdated. Skipped (nothing read) when the collection has no scene.
 * @param {object} settings Settings the run used (backend/source of the collection)
 * @returns {Promise<{checked: number, outdated: number}>}
 */
export async function refreshSceneStaleness(settings, collectionId = getCurrentCollectionId(),
    messages = getContext()?.chat) {
    const none = { checked: 0, outdated: 0 };
    if (!collectionId || !Array.isArray(messages)) return none;
    // Contained messages carry disabledByScene; no such annotation -> no scene.
    const hasScenes = getAnnotatedChunkHashes(collectionId).some(hash =>
        getChunkMetadata(hash, collectionId)?.disabledByScene != null ||
        getChunkMetadata(hash, collectionId)?.sceneOutdated != null);
    if (!hasScenes) return none;
    let resolvedSettings = settings;
    try {
        const resolved = await resolveCollectionOperationSettings(collectionId, settings, 'rag',
            { pipeline: 'rag', strategy: 'query' }, { readOnly: true });
        resolvedSettings = resolved.settings || settings;
    } catch (error) {
        console.debug(`VectHare Scenes: staleness check skipped: ${error.message}`);
        return none;
    }
    const data = await getSavedHashes(collectionId, resolvedSettings, true);
    if (!data || !Array.isArray(data.hashes) || !Array.isArray(data.metadata)) return none;
    let checked = 0, outdated = 0;
    data.hashes.forEach((hash, i) => {
        const meta = data.metadata[i];
        if (meta?.isScene !== true) return;
        checked++;
        const current = isSceneCurrent(messages, { hash, metadata: meta });
        if (!current) outdated++;
        const existing = getChunkMetadata(hash, collectionId) || {};
        if ((existing.sceneOutdated === true) !== !current) {
            saveChunkMetadata(hash, { ...existing, sceneOutdated: !current,
                sceneCheckedAt: Date.now() }, collectionId);
        }
    });
    if (outdated) vhLog(`VectHare Scenes: ${outdated} of ${checked} scene(s) are outdated (their messages changed)`);
    return { checked, outdated };
}

/**
 * User action: replaces an outdated scene with one built from its messages as
 * they are now (same title/summary/keywords). Only when the messages can be
 * located; otherwise the stored range is used if it is still inside the chat.
 * @returns {Promise<{success: boolean, hash?: number, error?: string}>}
 */
export async function recreateScene(scene, settings, collectionId = getCurrentCollectionId()) {
    const messages = getContext()?.chat;
    if (!scene || !Array.isArray(messages)) return { success: false, error: 'No chat selected' };
    const meta = { ...(scene.metadata || {}), ...(getChunkMetadata(scene.hash, collectionId) || {}) };
    const located = locateSceneMembers(messages, meta.containedHashes);
    const start = located ? located.start : meta.sceneStart;
    const end = located ? located.end : meta.sceneEnd;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end >= messages.length) {
        return { success: false, error: 'The scene\'s messages could not be found in this chat' };
    }
    const removed = await deleteSceneChunk(scene.hash, meta.containedHashes || [], settings);
    if (!removed.success) return removed;
    // The old scene's own annotation (title, outdated flag) is carried in `meta`.
    deleteChunkMetadata(scene.hash, collectionId);
    return createSceneChunk(start, end, {
        title: meta.title, summary: meta.summary, keywords: meta.keywords,
    }, settings);
}

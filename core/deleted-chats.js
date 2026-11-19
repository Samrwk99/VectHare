import { vhLog } from '../utils/log.js';
/**
 * N2: soft delete of a deleted chat's collection.
 *
 * Deleting a chat in SillyTavern no longer purges its vectors at once. The
 * chat's binding is released (quarantined, so RAG never uses it) and the
 * binding record is kept in the collection's own VectHare metadata as
 * `deletedChat`. The vectors are purged when the user presses "Empty deleted"
 * in Database Browser, or automatically once they are older than
 * DELETED_CHAT_KEEP_DAYS (checked at startup). Purge uses the same verified
 * path as before; any doubt keeps the collection.
 *
 * A chat that is re-imported (or restored) can re-attach the kept collection;
 * see offerDeletedChatReattach() in chat-vectorization.js.
 */

import { vecthareState, flushVectHareStore, saveVerifiedDeletion, storeNow } from './vecthare-store.js';
import {
    chatFileExists, anotherChatClaimsCollection, releaseToQuarantine, removeChatBinding,
    isQuarantinedChatCollection, tryBeginChatCollectionDelete, endChatCollectionDelete,
    chatStoreDestination, parseRegistryKey, normChat,
} from './collection-ids.js';
import { getCollectionMeta, setCollectionMeta, deleteCollectionMeta, readInitialVectorizationConfig } from './collection-metadata.js';
import { getCollectionRegistry, unregisterCollection } from './collection-loader.js';
import { purgeVectorIndex, withCollectionModelForStandard } from './core-vector-api.js';
import { resolveStorage } from './storage-resolver.js';

export const DELETED_CHAT_KEEP_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

const plainId = id => parseRegistryKey(id).collectionId || id;

/** The soft-delete record of a collection, or null when it is not a deleted chat's. */
export function getDeletedChatInfo(collectionId) {
    const id = plainId(collectionId);
    if (!id || !isQuarantinedChatCollection(id)) return null;
    const info = getCollectionMeta(id)?.deletedChat;
    return info && typeof info === 'object' && Number.isFinite(info.deletedAt) ? info : null;
}

/** All collections currently kept for a deleted chat. */
export function listDeletedChatCollections() {
    const ids = new Set(Object.keys(vecthareState().collections || {}).map(plainId));
    return [...ids].map(id => ({ id, info: getDeletedChatInfo(id) })).filter(entry => entry.info);
}

/**
 * Whole days left before the automatic purge (0 = due). VH-065: measured on
 * the server's clock (storeNow), so a device whose own clock runs ahead does
 * not purge other devices' deleted chats early; a deletion time in the future
 * (written by a device whose clock was ahead) counts as "just now".
 */
export function deletedChatDaysLeft(info, now = storeNow()) {
    if (!info) return 0;
    const deletedAt = Math.min(info.deletedAt, now);
    return Math.max(0, Math.ceil((deletedAt + DELETED_CHAT_KEEP_DAYS * DAY_MS - now) / DAY_MS));
}

/**
 * Releases a verified-deleted chat's binding and records it for later purge or
 * re-attach. Touches no vectors.
 * @param {string} collectionId Collection the deleted chat was bound to
 * @param {object} rec The binding record as it was (owner, chat, stores, ...)
 * @param {string} filename Deleted chat filename from SillyTavern
 */
export async function softDeleteChatCollection(collectionId, rec, filename) {
    const id = plainId(collectionId);
    const saved = JSON.parse(JSON.stringify(rec || {}));
    setCollectionMeta(id, {
        deletedChat: {
            rec: saved,
            deletedAt: storeNow(), // VH-065: the server's clock
            filename: normChat(filename),
            ownerKey: saved.owner ? `${saved.owner.type}:${saved.owner.id}` : null,
        },
    });
    releaseToQuarantine(id);
    try {
        await flushVectHareStore();
    } catch (error) {
        console.warn('VectHare: deleted-chat record will be saved with the next write:', error.message);
    }
}

/** Clears the soft-delete record once the collection belongs to a chat again. */
export function clearDeletedChatInfo(collectionId) {
    const id = plainId(collectionId);
    if (getCollectionMeta(id)?.deletedChat) setCollectionMeta(id, { deletedChat: null });
}

const kept = reason => ({ success: false, kept: true, reason });

/**
 * Purges one deleted chat's collection through the verified path. Every
 * condition that was checked when the chat was deleted is checked again now;
 * anything uncertain keeps the collection.
 * @param {string} collectionId Collection identifier
 * @param {object} settings VectHare settings
 * @param {{isBusy?: () => boolean}} options
 * @returns {Promise<{success: boolean, kept?: boolean, reason?: string}>}
 */
export async function purgeDeletedChatCollection(collectionId, settings, options = {}) {
    const id = plainId(collectionId);
    const info = getDeletedChatInfo(id);
    if (!info) return kept('not a deleted chat collection');
    const rec = info.rec || {};
    if (!rec.owner || !rec.chat) return kept('the deleted chat is not recorded');

    const exists = await chatFileExists(rec.owner, rec.chat);
    if (exists !== false) {
        return kept(exists === true ? 'the chat file exists again' : 'the chat file could not be checked');
    }
    const claimed = await anotherChatClaimsCollection(rec, id);
    if (claimed !== false) {
        return kept(claimed ? 'another chat file claims this collection' : 'other chat files could not be checked');
    }
    if (options.isBusy?.() || !tryBeginChatCollectionDelete(id)) return kept('vectorization is running');
    try {
        const keys = getCollectionRegistry().filter(key => plainId(key) === id);
        let stores = [...(rec.stores || [])];
        if (!stores.length && keys.length) return kept('its storage backend is unknown');
        // VH-053: old copies left by a storage move go first (while the current
        // location is still recorded); if one cannot be deleted, nothing is.
        if (getCollectionMeta(id)?.storageOldCopies?.length) {
            try {
                const { deleteAllOldStorageCopies } = await import('./storage-move.js');
                const copies = await deleteAllOldStorageCopies(id, settings);
                if (!copies.success) return kept(copies.reason);
            } catch (error) {
                return kept(`its old copy could not be deleted (${error.message})`);
            }
        }
        for (const store of [...stores]) {
            // Never purge a different Qdrant endpoint or tenant after settings
            // changes. Multitenancy purge has its own unresolved safety issue.
            const destination = chatStoreDestination({ ...settings, vector_backend: store.backend }, id);
            if (!store.destination || destination !== store.destination ||
                (store.backend === 'qdrant' && resolveStorage(id, settings, 'qdrant').layout === 'legacy-mt')) {
                return kept('its storage destination could not be verified');
            }
            // VH-048: Standard keeps one copy per model - use the collection's own.
            const backendSettings = await withCollectionModelForStandard(id,
                { ...settings, vector_backend: store.backend, source: store.source });
            if (!await purgeVectorIndex(id, backendSettings)) {
                return kept('the backend did not confirm the purge');
            }
            // VH-025 (#27): an acknowledged purge is not proof of deletion. The
            // tracking is only removed once the store's saved settings are gone.
            try {
                const after = await readInitialVectorizationConfig(id, backendSettings,
                    { backend: store.backend, source: store.source });
                const gone = after.status === 'missing' &&
                    (!['standard', 'vectra', 'lancedb'].includes(store.backend) || after.physicalAbsent !== false);
                if (!gone) return kept('the purge could not be verified (the collection still answers)');
            } catch (error) {
                return kept(`the purge could not be verified (${error.message})`);
            }
            // Persist partial success, so a retry does not revisit a store
            // already purged. Registry/metadata remain until all finish.
            stores = stores.filter(item => item !== store);
            setCollectionMeta(id, { deletedChat: { ...info, rec: { ...rec, stores } } });
        }
        for (const key of keys) unregisterCollection(key);
        deleteCollectionMeta(id);
        removeChatBinding(id);
        // VH-021: saved at once (strict, merged if another tab changed the file).
        await saveVerifiedDeletion().catch(error =>
            console.warn('VectHare: The purge is saved with the next change:', error?.message || error));
        vhLog('VectHare: Purged kept collection of deleted chat', id);
        return { success: true };
    } finally {
        endChatCollectionDelete(id);
    }
}

/**
 * Purges deleted chats' collections. `onlyExpired` limits it to those past the
 * keep period (startup); otherwise all ("Empty deleted").
 */
export async function purgeDeletedChats(settings, { onlyExpired = false, isBusy, onProgress } = {}) {
    const results = [];
    const targets = listDeletedChatCollections()
        .filter(({ info }) => !(onlyExpired && deletedChatDaysLeft(info) > 0));
    for (const { id } of targets) {
        onProgress?.({ done: results.length, total: targets.length, id });
        try {
            results.push({ id, ...(await purgeDeletedChatCollection(id, settings, { isBusy })) });
        } catch (error) {
            results.push({ id, success: false, kept: true, reason: error.message });
        }
    }
    onProgress?.({ done: results.length, total: targets.length, id: null });
    return results;
}

/**
 * VH-055 tidy-up: chunk notes (keywords, conditions, the "disabled" flag ...)
 * are kept per hash and per collection. A note whose chunk no longer exists in
 * its collection is unused. Notes are only removed for collections whose stored
 * hashes were read completely; a shared (older, collection-less) note is only
 * removed when every registered collection was read and none holds the hash.
 */
import { vecthareState, persistVectHareStore } from './vecthare-store.js';
import { getCollectionRegistry } from './collection-loader.js';
import { getSavedHashes, resolveEmbeddingSettingsForEdit } from './core-vector-api.js';
import { bareCollectionId } from './storage-resolver.js';

async function readHeldHashes(settings) {
    const held = new Map();       // bare collection id -> Set of hashes
    const unreadable = new Map(); // bare collection id -> reason
    for (const key of getCollectionRegistry()) {
        const id = bareCollectionId(key);
        if (!id || unreadable.has(id)) continue;
        try {
            const collectionSettings = await resolveEmbeddingSettingsForEdit(key, settings);
            if (!collectionSettings) throw new Error('its settings could not be resolved');
            const hashes = await getSavedHashes(id, collectionSettings);
            if (!Array.isArray(hashes)) throw new Error('no hash list');
            // Some reads answer an error with an empty list (Standard turns HTTP
            // 500 into []): an empty listing never proves that notes are unused.
            if (!hashes.length) throw new Error('the collection listed no chunks');
            const set = held.get(id) || new Set();
            for (const hash of hashes) set.add(String(hash));
            held.set(id, set);
        } catch (error) {
            held.delete(id);
            unreadable.set(id, error.message || String(error));
        }
    }
    return { held, unreadable };
}

/**
 * Lists unused notes without changing anything.
 * @returns {Promise<{scoped: Array<[string, string]>, shared: string[], unreadable: Map<string, string>}>}
 */
export async function findUnusedChunkNotes(settings) {
    const { held, unreadable } = await readHeldHashes(settings);
    const everyCollectionRead = unreadable.size === 0;
    const scoped = [];
    const shared = [];
    for (const [hash, entry] of Object.entries(vecthareState().chunkMetadata || {})) {
        if (!entry || typeof entry !== 'object') continue;
        const { __byCollection: byCollection = {}, ...sharedFields } = entry;
        for (const scope of Object.keys(byCollection || {})) {
            const set = held.get(scope);
            if (set && !set.has(hash)) scoped.push([hash, scope]);
        }
        if (Object.keys(sharedFields).length && everyCollectionRead &&
            ![...held.values()].some(set => set.has(hash))) {
            shared.push(hash);
        }
    }
    return { scoped, shared, unreadable };
}

/** Removes the notes findUnusedChunkNotes() reports. */
export async function removeUnusedChunkNotes(settings) {
    const found = await findUnusedChunkNotes(settings);
    const notes = vecthareState().chunkMetadata;
    let removed = 0;
    for (const [hash, scope] of found.scoped) {
        const entry = notes[hash];
        if (!entry?.__byCollection?.[scope]) continue;
        const { [scope]: _gone, ...rest } = entry.__byCollection;
        const { __byCollection: _old, ...sharedFields } = entry;
        if (Object.keys(rest).length) notes[hash] = { ...sharedFields, __byCollection: rest };
        else if (Object.keys(sharedFields).length) notes[hash] = sharedFields;
        else delete notes[hash];
        removed++;
    }
    for (const hash of found.shared) {
        const entry = notes[hash];
        if (!entry) continue;
        const { __byCollection: byCollection } = entry;
        if (byCollection && Object.keys(byCollection).length) notes[hash] = { __byCollection: byCollection };
        else delete notes[hash];
        removed++;
    }
    if (removed) persistVectHareStore();
    return { removed, skippedCollections: [...found.unreadable.keys()] };
}

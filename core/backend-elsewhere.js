/**
 * VH-052 (option A): one vector backend is active at a time. A collection whose
 * vectors live on another backend, or on another Qdrant/Milvus server, is not
 * searched or synced while that one is selected; this module tells the user so
 * instead of leaving them with empty results and unexplained errors.
 */
import { getBoundChatDetails, chatStoreDestination, parseRegistryKey } from './collection-ids.js';
import { getCollectionRegistry } from './collection-loader.js';
import { isManagedByAdmin } from '../backends/init-response.js';

const BACKEND_NAMES = { standard: 'Standard', vectra: 'Standard', lancedb: 'LanceDB', qdrant: 'Qdrant', milvus: 'Milvus' };
const normalize = backend => (backend === 'vectra' ? 'standard' : String(backend || 'standard').toLowerCase());
export const backendLabel = backend => BACKEND_NAMES[normalize(backend)] || backend;

/** The server part of a recorded destination (layout ignored). */
function serverOf(backend, destination) {
    if (!['qdrant', 'milvus'].includes(backend)) return '';
    // On a multi-user server the admin's connection is used whatever the
    // user's own address settings say, so they do not move the collection.
    if (isManagedByAdmin(backend)) return 'managed-by-admin';
    try {
        const parts = JSON.parse(destination);
        return Array.isArray(parts) ? JSON.stringify(parts.slice(0, 5)) : String(destination);
    } catch { return String(destination); }
}

/** "Qdrant (127.0.0.1:6333)" from a recorded store. */
export function describeStore(store) {
    const backend = normalize(store.backend);
    try {
        const parts = JSON.parse(store.destination);
        if (backend === 'qdrant' && Array.isArray(parts)) {
            const where = parts[0] ? (parts[1] || 'Qdrant Cloud') : [parts[2], parts[3]].filter(Boolean).join(':');
            return where ? `Qdrant (${where})` : 'Qdrant';
        }
        if (backend === 'milvus' && Array.isArray(parts)) {
            const where = parts[0] || [parts[1], parts[2]].filter(Boolean).join(':');
            return where ? `Milvus (${where})` : 'Milvus';
        }
    } catch { /* fall through */ }
    return backendLabel(backend);
}

/**
 * Where a collection lives, when that is not today's backend/server.
 * @returns {Array<{backend: string, destination?: string}>} empty when it lives here or it is not known
 */
export function collectionLivesElsewhere(collectionId, settings) {
    const id = parseRegistryKey(collectionId).collectionId || collectionId;
    const current = normalize(settings?.vector_backend);
    const chat = getBoundChatDetails(id);
    if (chat && Array.isArray(chat.stores) && chat.stores.length) {
        const here = serverOf(current, chatStoreDestination(settings, id));
        const stores = chat.stores.map(store => ({ ...store, backend: normalize(store.backend) }));
        const livesHere = stores.some(store => store.backend === current &&
            serverOf(current, store.destination) === here);
        return livesHere ? [] : stores;
    }
    const keys = getCollectionRegistry().filter(key => (parseRegistryKey(key).collectionId || key) === id);
    const backends = keys.map(key => parseRegistryKey(key).backend).filter(Boolean).map(normalize);
    if (!backends.length || backends.includes(current)) return [];
    return [...new Set(backends)].map(backend => ({ backend }));
}

const noticed = new Set();

/**
 * Shows, once per chat per session, where this chat's memories are.
 * @returns {boolean} true when the collection lives elsewhere (callers then skip it quietly)
 */
export function noteChatLivesElsewhere(collectionId, settings) {
    const elsewhere = collectionLivesElsewhere(collectionId, settings);
    if (!elsewhere.length) return false;
    const key = `${collectionId}|${normalize(settings?.vector_backend)}|${chatStoreDestination(settings, collectionId)}`;
    if (!noticed.has(key)) {
        noticed.add(key);
        const where = [...new Set(elsewhere.map(describeStore))].join(' and ');
        const now = backendLabel(settings?.vector_backend);
        globalThis.toastr?.warning?.(
            `This chat's memories are on ${where}. Switch back to use them, or re-vectorize this chat on ${now}.`,
            'VectHare', { timeOut: 15000 });
    }
    return true;
}

/**
 * After a backend or server change: how many collections will not be used.
 * @returns {{count: number, where: string}}
 */
export function countCollectionsElsewhere(settings) {
    const ids = [...new Set(getCollectionRegistry().map(key => parseRegistryKey(key).collectionId || key))];
    const places = new Map();
    let count = 0;
    for (const id of ids) {
        const elsewhere = collectionLivesElsewhere(id, settings);
        if (!elsewhere.length) continue;
        count++;
        for (const store of elsewhere) {
            const label = describeStore(store);
            places.set(label, (places.get(label) || 0) + 1);
        }
    }
    return { count, where: [...places.keys()].join(', ') };
}

let switchTimer = null;
/** Warns (debounced) after the backend or its address changed in the settings panel. */
export function warnAfterBackendChange(settings) {
    clearTimeout(switchTimer);
    switchTimer = setTimeout(() => {
        const { count, where } = countCollectionsElsewhere(settings);
        if (!count) return;
        globalThis.toastr?.warning?.(
            `${count} collection${count === 1 ? ' lives' : 's live'} on ${where} and will not be used while ` +
            `${describeStore({ backend: settings.vector_backend, destination: chatStoreDestination(settings) })} is selected. ` +
            'Switch back to use them, or re-vectorize those chats here.', 'VectHare', { timeOut: 15000 });
    }, 800);
}

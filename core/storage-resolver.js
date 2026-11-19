/**
 * Step 9b / P2: storage locator + resolver.
 *
 * Every collection used to be located from TODAY's settings: the Qdrant
 * multitenancy checkbox chose `vecthare_multitenancy` or the collection's own
 * Qdrant collection, Milvus was always `vecthare_main`. Toggling the checkbox
 * therefore pointed every existing Qdrant collection at the wrong place (its
 * saved settings were then "missing" and work was blocked).
 *
 * Now a collection can carry a LOCATOR in VectHare's metadata file:
 *     collections[id].storage = { backend, layout, physical, locatorVersion: 1 }
 * It is only a pointer to where the collection's vectors and saved original
 * settings already are; it is recorded when exactly one location holds a valid
 * saved configuration (see ensureStorageLocator in collection-metadata.js) or at
 * a collection's first write.
 *
 * resolveStorage() is synchronous and local (no network): with a valid locator
 * for the requested backend it returns that; otherwise exactly today's
 * settings-based rule. The Qdrant and Milvus adapters take the physical name and
 * the layout ONLY from here; with a locator present, settings.qdrant_multitenancy
 * is not read at all.
 *
 * Deliberately a leaf module (store + provider list only), so backends can
 * import it without import cycles.
 */

import { readPluginCapabilities, resetPluginCapabilitiesCache, backendWriteRefusal } from './plugin-health.js';
import { vecthareState } from './vecthare-store.js';
import { getValidProviderIds } from './providers.js';

export const QDRANT_LEGACY_MT = 'vecthare_multitenancy';
export const MILVUS_LEGACY_SHARED = 'vecthare_main';
export const LOCATOR_VERSION = 1;

const KNOWN_BACKENDS = ['standard', 'lancedb', 'vectra', 'milvus', 'qdrant'];

const MT_V2_NAME = /^vecthare_mt_([1-9]\d{0,5})$/;
const MILVUS_OWN_NAME = /^vh_[0-9a-f]{24}$/;

/**
 * Layouts a locator may name, per backend. `physicalOf` gives the physical
 * name a legacy layout implies; v2 layouts (9c) are named by the plugin and
 * only checked for shape here.
 */
const LAYOUTS = {
    qdrant: {
        'per-collection': { physicalOf: id => id },
        'legacy-mt': { physicalOf: () => QDRANT_LEGACY_MT },
        'mt-v2': { v2: true, matches: (physical, dim) => MT_V2_NAME.test(physical) && Number(MT_V2_NAME.exec(physical)[1]) === dim },
    },
    milvus: {
        'legacy-shared': { physicalOf: () => MILVUS_LEGACY_SHARED },
        'mt-v2': { v2: true, matches: (physical, dim) => MT_V2_NAME.test(physical) && Number(MT_V2_NAME.exec(physical)[1]) === dim },
        'per-collection': { v2: true, matches: physical => MILVUS_OWN_NAME.test(physical) },
    },
};

/** 9c: whether a backend's layout is one of the new, plugin-scoped layouts. */
export function isV2Layout(backend, layout) {
    return Boolean(LAYOUTS[normalizeBackend(backend)]?.[layout]?.v2);
}

/** Backends whose collections can live in more than one layout. */
export const LOCATED_BACKENDS = Object.freeze(Object.keys(LAYOUTS));

export function normalizeBackend(backend) {
    const name = backend || 'standard';
    return name === 'vectra' ? 'standard' : name;
}

/** The logical id inside a registry key (`backend:source:id`, `source:id`, `id`). */
export function bareCollectionId(collectionId) {
    if (!collectionId || typeof collectionId !== 'string') return collectionId;
    const parts = collectionId.split(':');
    let sources;
    try { sources = getValidProviderIds(); } catch { sources = []; }
    if (parts.length >= 3 && KNOWN_BACKENDS.includes(parts[0]) && sources.includes(parts[1])) {
        return parts.slice(2).join(':');
    }
    if (parts.length >= 2 && sources.includes(parts[0])) return parts.slice(1).join(':');
    return collectionId;
}

function findRecord(id) {
    let collections;
    try { collections = vecthareState()?.collections; } catch { return null; }
    if (!collections || typeof collections !== 'object') return null;
    if (Object.prototype.hasOwnProperty.call(collections, id)) return collections[id];
    for (const key of Object.keys(collections)) {
        if (bareCollectionId(key) === id) return collections[key];
    }
    return null;
}

/**
 * A locator is used only when it is complete and self-consistent; anything else
 * is ignored, which falls back to today's behaviour (fail closed).
 * @returns {{backend:string, layout:string, physical:string, locatorVersion:number}|null}
 */
export function validateLocator(locator, logicalId) {
    if (!locator || typeof locator !== 'object' || Array.isArray(locator)) return null;
    if (locator.locatorVersion !== LOCATOR_VERSION) return null;
    const spec = LAYOUTS[locator.backend]?.[locator.layout];
    if (!spec || typeof locator.physical !== 'string') return null;
    const dim = Number.isSafeInteger(locator.dim) && locator.dim > 0 ? locator.dim : null;
    if (spec.v2 ? !spec.matches(locator.physical, dim) : locator.physical !== spec.physicalOf(logicalId)) return null;
    const out = { backend: locator.backend, layout: locator.layout, physical: locator.physical, locatorVersion: LOCATOR_VERSION };
    if (dim) out.dim = dim;
    return out;
}

/** The collection's recorded locator, or null. */
export function getStorageLocator(collectionId) {
    const id = bareCollectionId(collectionId);
    if (!id) return null;
    const record = findRecord(id);
    return validateLocator(record?.storage, id);
}

/** Today's settings-based rule (exactly what every build before 13.30 did). */
export function settingsStorageRule(collectionId, settings, backend = settings?.vector_backend) {
    const id = bareCollectionId(collectionId);
    const name = normalizeBackend(backend);
    if (name === 'qdrant') {
        const shared = Boolean(settings?.qdrant_multitenancy);
        return { backend: name, layout: shared ? 'legacy-mt' : 'per-collection',
            physical: shared ? QDRANT_LEGACY_MT : id, shared, fromLocator: false };
    }
    if (name === 'milvus') {
        return { backend: name, layout: 'legacy-shared', physical: MILVUS_LEGACY_SHARED, shared: true, fromLocator: false };
    }
    return { backend: name, layout: 'per-collection', physical: id, shared: false, fromLocator: false };
}

/**
 * Where a collection's vectors are, for one backend. Synchronous and local.
 * @param {string} collectionId Logical id or registry key
 * @param {object} settings VectHare settings (only read when there is no locator)
 * @param {string} [backend] Backend being addressed (defaults to settings.vector_backend)
 * @returns {{backend:string, layout:string, physical:string, shared:boolean, fromLocator:boolean, dim?:number}}
 */
export function resolveStorage(collectionId, settings, backend = settings?.vector_backend) {
    const name = normalizeBackend(backend);
    const locator = LAYOUTS[name] ? getStorageLocator(collectionId) : null;
    if (locator && locator.backend === name) {
        return { backend: name, layout: locator.layout, physical: locator.physical,
            shared: locator.physical !== bareCollectionId(collectionId), fromLocator: true,
            v2: isV2Layout(name, locator.layout), ...(locator.dim ? { dim: locator.dim } : {}) };
    }
    // 9c: a NEW collection's first write, in a new layout chosen for this
    // operation only (resolveCollectionOperationSettings / prepareNewCollection).
    // The plugin creates it at the first insert; the locator is recorded then.
    const pending = settings?.__newStorageLayout;
    if (pending && normalizeBackend(pending.backend) === name && isV2Layout(name, pending.layout)) {
        return { backend: name, layout: pending.layout, physical: null, shared: pending.layout === 'mt-v2',
            fromLocator: false, v2: true, pending: true };
    }
    return settingsStorageRule(collectionId, settings, name);
}

/** The `storage` field a v2 request carries (the plugin scopes and names it). */
export function v2StorageParam(storage) {
    if (!storage?.v2) return null;
    return { layout: storage.layout, ...(storage.dim ? { dim: storage.dim } : {}),
        ...(storage.physical ? { physical: storage.physical } : {}) };
}

/**
 * 9c: the layout a NEW collection gets. With a plugin that offers the new
 * layouts (capabilities.scopedTenancy >= 2): Qdrant multitenancy on -> mt-v2;
 * Milvus multitenancy on (default) -> mt-v2, off -> per-collection. Without it:
 * exactly the previous behaviour.
 */
export function newCollectionLayout(settings, capable, backend = settings?.vector_backend) {
    const name = normalizeBackend(backend);
    if (name === 'qdrant') {
        if (!settings?.qdrant_multitenancy) return 'per-collection';
        return capable ? 'mt-v2' : 'legacy-mt';
    }
    if (name === 'milvus') {
        if (!capable) return 'legacy-shared';
        return settings?.milvus_multitenancy === false ? 'per-collection' : 'mt-v2';
    }
    return 'per-collection';
}

// Plugin capabilities, read once per page load (reload tabs after updating).
// VH-006: a failed read is not cached and throws (status unknown) instead of
// looking like an old plugin.
export function pluginCapabilities() {
    return readPluginCapabilities();
}
/** For probes: forget the cached capabilities. */
export function resetPluginCapabilities() { resetPluginCapabilitiesCache(); }

/** 9c: whether the plugin scopes the new layouts itself (P7 flag). */
export async function scopedTenancySupported() {
    return Number((await pluginCapabilities()).scopedTenancy) >= 2;
}

/**
 * 9c (P7): may this collection be written? Legacy Qdrant multitenancy is
 * read-only once the plugin offers the new layouts (re-vectorize to move it);
 * a v2 collection needs a plugin that scopes it.
 */
export class StorageReadOnlyError extends Error {
    constructor(message) { super(message); this.code = 'VH_STORAGE_READ_ONLY'; }
}
export async function assertStorageWritable(collectionId, settings, backend = settings?.vector_backend) {
    const refusal = backendWriteRefusal(backend);
    if (refusal) throw new StorageReadOnlyError(refusal);
    const storage = resolveStorage(collectionId, settings, backend);
    const capable = await scopedTenancySupported();
    if (storage.v2 && !capable) {
        throw new StorageReadOnlyError(`Collection ${bareCollectionId(collectionId)} is stored in a newer layout (${storage.layout}) ` +
            'that this Similharity plugin does not support. Update the plugin and restart SillyTavern; nothing was changed.');
    }
    if (storage.layout === 'legacy-mt' && capable) {
        throw new StorageReadOnlyError(`Collection ${bareCollectionId(collectionId)} is in the old shared Qdrant store ` +
            '(multitenancy), which is read-only now. Re-vectorize it to move it (Vectorize offers a rebuild; the old copy is kept). ' +
            'Nothing was changed.');
    }
    return storage;
}

/**
 * A settings copy whose storage switches describe THIS collection's storage, for
 * code that builds a storage snapshot or a destination fingerprint from settings
 * (createInitialVectorizationConfig, chatStoreDestination). Without a locator
 * the copy equals the input.
 */
export function settingsForCollectionStorage(collectionId, settings, backend = settings?.vector_backend) {
    const name = normalizeBackend(backend);
    const copy = { ...settings, vector_backend: backend ?? settings?.vector_backend };
    if (LAYOUTS[name]) {
        const storage = resolveStorage(collectionId, settings, name);
        if (storage.fromLocator) {
            if (name === 'qdrant') copy.qdrant_multitenancy = storage.layout !== 'per-collection';
            if (storage.v2) copy.__storageLayout = storage.layout;
            else delete copy.__storageLayout;
        }
    }
    return copy;
}

/** The locator a saved original configuration describes. */
export function locatorForSnapshot(collectionId, snapshot) {
    const id = bareCollectionId(collectionId);
    const backend = normalizeBackend(snapshot?.storage?.backend);
    if (snapshot?.storage?.layout) return null; // v2: named by the plugin at the first insert
    if (backend === 'qdrant') {
        const layout = snapshot.storage.multitenancy === true ? 'legacy-mt' : 'per-collection';
        return { backend, layout, physical: LAYOUTS.qdrant[layout].physicalOf(id), locatorVersion: LOCATOR_VERSION };
    }
    if (backend === 'milvus') {
        return { backend, layout: 'legacy-shared', physical: MILVUS_LEGACY_SHARED, locatorVersion: LOCATOR_VERSION };
    }
    return null;
}

/**
 * 9c: what a saved configuration read from `physical` must say about its
 * storage. null = not a recognised location.
 * @returns {{layout: string|null, multitenancy?: boolean}|null}
 */
export function expectedStorageAt(backend, physical, logicalId) {
    const name = normalizeBackend(backend);
    if (name === 'qdrant') {
        if (physical === QDRANT_LEGACY_MT) return { layout: null, multitenancy: true };
        if (MT_V2_NAME.test(physical)) return { layout: 'mt-v2', multitenancy: true };
        return { layout: null, multitenancy: false };
    }
    if (name === 'milvus') {
        if (physical === MILVUS_LEGACY_SHARED) return { layout: null };
        if (MT_V2_NAME.test(physical)) return { layout: 'mt-v2' };
        if (MILVUS_OWN_NAME.test(physical)) return { layout: 'per-collection' };
        return null;
    }
    return { layout: null };
}

/** The locator for a physical location on a located backend. */
export function locatorForPhysical(collectionId, backend, physical, dim = null) {
    const id = bareCollectionId(collectionId);
    const name = normalizeBackend(backend);
    for (const [layout, spec] of Object.entries(LAYOUTS[name] || {})) {
        if (spec.v2) {
            if (spec.matches(physical, dim)) {
                return { backend: name, layout, physical, ...(dim ? { dim } : {}), locatorVersion: LOCATOR_VERSION };
            }
        } else if (spec.physicalOf(id) === physical) {
            return { backend: name, layout, physical, locatorVersion: LOCATOR_VERSION };
        }
    }
    return null;
}

/**
 * Locations to probe for a collection without a locator: today's rule first,
 * then the other legacy location(s), then (9c, with a capable plugin) the v2
 * layouts, which the plugin finds by tenant. Items: {physical} or {layout}.
 */
export function candidateLocations(collectionId, settings, backend = settings?.vector_backend, { v2 = false } = {}) {
    const id = bareCollectionId(collectionId);
    const name = normalizeBackend(backend);
    const first = settingsStorageRule(id, settings, name).physical;
    const legacy = Object.values(LAYOUTS[name] || {}).filter(spec => !spec.v2).map(spec => spec.physicalOf(id));
    const out = [first, ...legacy.filter(p => p !== first)].map(physical => ({ physical }));
    if (v2) {
        for (const [layout, spec] of Object.entries(LAYOUTS[name] || {})) if (spec.v2) out.push({ layout });
    }
    return out;
}

// ---------------------------------------------------------------------------
// Conflicts: saved settings found in more than one location. Nothing is
// recorded and writes are blocked for the session; reads keep today's rule.
// ---------------------------------------------------------------------------
const conflicts = new Map(); // `${backend}\u0000${id}` -> physical[]

export function markStorageConflict(collectionId, backend, physicals) {
    conflicts.set(`${normalizeBackend(backend)}\u0000${bareCollectionId(collectionId)}`, [...physicals]);
}

export function clearStorageConflict(collectionId, backend) {
    conflicts.delete(`${normalizeBackend(backend)}\u0000${bareCollectionId(collectionId)}`);
}

/** @returns {string[]|null} the locations, when a conflict is known */
export function getStorageConflict(collectionId, backend) {
    return conflicts.get(`${normalizeBackend(backend)}\u0000${bareCollectionId(collectionId)}`) || null;
}

export class StorageConflictError extends Error {
    constructor(collectionId, physicals) {
        super(`Collection ${bareCollectionId(collectionId)}: its saved settings were found in more than one place ` +
            `(${physicals.join(', ')}). Writes are blocked until only one remains; nothing was changed. ` +
            'See Database Browser > Storage.');
        this.code = 'VH_STORAGE_CONFLICT';
    }
}

/** Throws when a conflict is known for this collection on this backend. */
export function assertNoStorageConflict(collectionId, backend) {
    const physicals = getStorageConflict(collectionId, backend);
    if (physicals) throw new StorageConflictError(collectionId, physicals);
}

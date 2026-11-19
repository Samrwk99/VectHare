import { vhLog } from '../utils/log.js';
/**
 * VectHare Owned State Store
 *
 * Phase 1: one authoritative per-user file holds the state VectHare owns -
 * its collection registry, local collection metadata, chat-to-collection
 * bindings, per-chat collection policies and collection-scoped chunk
 * annotations. The file lives beside the identity ledgers, under the active
 * user's vector directory, and is read and written through the Similharity
 * plugin.
 *
 * Deliberately NOT stored here:
 *   - message/group identity ledgers (their own files, unchanged)
 *   - the authoritative original vectorization configuration (backend-resident)
 *   - global preferences, credentials, backend connections, UI/retrieval
 *     settings (SillyTavern extension settings, unchanged)
 *
 * There is exactly one persistent copy. The in-memory document returned by
 * vecthareState() is the working copy every accessor reads and writes; it is
 * flushed to the file, never to settings.json.
 */

import { getRequestHeaders, saveSettingsDebounced } from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';

const STORE_VERSION = 1;
const WRITE_DEBOUNCE_MS = 1200;

/** Marker left in extension settings so a later missing file is not mistaken
 *  for a first-time migration. It records that migration happened, nothing more. */
const MIGRATION_MARKER_KEY = 'vecthareOwnedStateMigratedAt';

/** Keys this store takes ownership of. Everything else in extension settings
 *  stays exactly where it is. */
const MIGRATED_KEYS = ['vecthare_collection_registry', 'collections',
    'chatCollectionBindings', 'chatCollectionPolicies'];
const CHUNK_META_PREFIX = 'vecthare_chunk_meta_';

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function emptyState() {
    return {
        version: STORE_VERSION,
        registry: [],
        collections: {},
        chatCollectionBindings: { version: 1, byCollection: {} },
        chatCollectionPolicies: {},
        chunkMetadata: {},
        // VH-021: collection records removed by a verified delete, key -> time
        // (ms). The merge never brings such a record back from a tab that had
        // not seen the delete. Kept for RECENTLY_DELETED_DAYS.
        recentlyDeleted: {},
    };
}

const RECENTLY_DELETED_DAYS = 30;

/** VH-021: drops malformed or expired entries. */
function cleanRecentlyDeleted(map) {
    const out = {};
    if (!isPlainObject(map)) return out;
    const oldest = Date.now() - RECENTLY_DELETED_DAYS * 24 * 60 * 60 * 1000;
    for (const [key, at] of Object.entries(map)) {
        if (Number.isFinite(at) && at >= oldest) out[key] = at;
    }
    return out;
}

// VH-021: the values a brand-new collection record starts with (set by
// collection-metadata.js). When a record was created in two tabs at once, the
// merge compares both with these, so a field the other tab only filled with its
// default does not override a value this tab really set.
let collectionRecordDefaults = {};
export function setCollectionRecordDefaults(defaults) {
    collectionRecordDefaults = isPlainObject(defaults) ? clone(defaults) : {};
}

/**
 * VH-021: saves a verified deletion right away, as a strict write (exactly this
 * tab's document, no merge). If another tab changed the file meanwhile, the
 * normal merged save follows: it honours the recently-deleted list, so the
 * deletion still wins over that tab's older copy of the record.
 */
export async function saveVerifiedDeletion() {
    try {
        await flushVectHareStore({ strict: true });
    } catch (error) {
        if (error?.code !== 'VH_STORE_CONFLICT') throw error;
        await flushVectHareStore();
    }
}

/**
 * VH-021: records that these collection records were removed by a verified
 * delete. Call together with the removal.
 * @param {string[]} keys Record keys
 */
export function recordRecentlyDeleted(keys) {
    if (!state) return;
    if (!isPlainObject(state.recentlyDeleted)) state.recentlyDeleted = {};
    const now = Date.now();
    for (const key of keys || []) if (typeof key === 'string' && key) state.recentlyDeleted[key] = now;
}

/**
 * Working copy. Until the file has been read this is null, and accessors fall
 * back to whatever is still in extension settings (pre-migration startup), so
 * the UI keeps working while loading.
 */
let state = null;
let status = 'unloaded'; // unloaded | ready | failed
let statusDetail = '';
let failureKind = null; // VH-062: 'damaged' (unreadable, or missing after migration) | null
let loadPromise = null;

let writeTimer = null;
let writeChain = Promise.resolve();
let dirty = false;
let lastWriteError = null;

/**
 * The live VectHare-owned document. Callers use it exactly as they used
 * `extension_settings.vecthare` before, but it is persisted to VectHare's own
 * file. Before the file is loaded this proxies the legacy settings object so
 * nothing reads an empty store by accident.
 * @returns {object} The working state document
 */
export function vecthareState() {
    if (state) return state;
    // Pre-load (or failed load): fall back to the legacy location, which is
    // still the only data we have. normalizeState() adopts it on migration.
    const legacy = extension_settings.vecthare;
    if (!legacy) return emptyState();
    legacy.registry ??= legacy.vecthare_collection_registry ?? [];
    legacy.collections ??= {};
    legacy.chatCollectionBindings ??= { version: 1, byCollection: {} };
    legacy.chatCollectionPolicies ??= {};
    if (!legacy.chunkMetadata) {
        // Present the legacy per-hash keys in the new shape, so a read before
        // the file is loaded still sees existing annotations.
        legacy.chunkMetadata = {};
        for (const key of Object.keys(legacy)) {
            if (key.startsWith(CHUNK_META_PREFIX)) {
                legacy.chunkMetadata[key.slice(CHUNK_META_PREFIX.length)] = legacy[key];
            }
        }
    }
    return legacy;
}

/**
 * Whether the authoritative file has been loaded (or newly created) and may be
 * trusted. Destructive operations must check this.
 * @returns {boolean}
 */
export function isStoreAuthoritative() {
    return status === 'ready';
}

/**
 * @returns {{status: string, detail: string, migrated: boolean, lastWriteError: string|null}}
 */
export function storeStatus() {
    return {
        status,
        detail: statusDetail,
        migrated: Boolean(extension_settings.vecthare?.[MIGRATION_MARKER_KEY]),
        lastWriteError: lastWriteError ? String(lastWriteError.message || lastWriteError) : null,
        // VH-062: only a damaged file (not an unreachable plugin) may be started fresh.
        canStartFresh: status === 'failed' && failureKind === 'damaged',
    };
}

/**
 * Guard for destructive work: refuses to proceed while the authoritative
 * local state is uncertain, rather than acting on a possibly empty store.
 * @param {string} action Human-readable action name for the error
 */
export function assertStoreAuthoritative(action) {
    if (status === 'ready') return;
    throw new Error(`${action} is blocked: VectHare's collection metadata is not loaded (${statusDetail || status}). ` +
        'Resolve the storage problem first so the operation cannot act on incomplete data.');
}

function normalizeState(raw) {
    const next = emptyState();
    if (!isPlainObject(raw)) return next;
    if (Array.isArray(raw.registry)) {
        next.registry = raw.registry.filter(id => typeof id === 'string');
    }
    if (isPlainObject(raw.collections)) next.collections = raw.collections;
    if (isPlainObject(raw.chatCollectionPolicies)) next.chatCollectionPolicies = raw.chatCollectionPolicies;
    if (isPlainObject(raw.chunkMetadata)) next.chunkMetadata = raw.chunkMetadata;
    if (isPlainObject(raw.chatCollectionBindings)) {
        next.chatCollectionBindings = {
            version: Number(raw.chatCollectionBindings.version) || 1,
            byCollection: isPlainObject(raw.chatCollectionBindings.byCollection)
                ? raw.chatCollectionBindings.byCollection : {},
        };
    }
    next.recentlyDeleted = cleanRecentlyDeleted(raw.recentlyDeleted);
    if (raw.migratedFrom) next.migratedFrom = raw.migratedFrom;
    if (raw.migratedAt) next.migratedAt = raw.migratedAt;
    return next;
}

async function requestState(action, body = {}) {
    const response = await fetch(`/api/plugins/similharity/owned-state/${action}`, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(body),
    });
    if (response.status === 409 && action === 'write') {
        const body = await response.json().catch(() => null);
        if (body?.conflict === true) return { conflict: true, ...body };
    }
    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`owned-state/${action} failed: ${response.status} ${detail}`.trim());
    }
    const result = await response.json();
    noteServerClock(result);
    return result;
}

// VH-065: the server's clock, learnt from its answers, so time-based rules
// (the deleted-chat grace period) do not depend on each device's own clock.
let serverClockOffset = 0;
function noteServerClock(result) {
    const serverNow = Number(result?.serverNow);
    if (Number.isFinite(serverNow) && serverNow > 0) serverClockOffset = serverNow - Date.now();
}

/** VH-065: the current time on the SillyTavern server (this device's clock until it is known). */
export function storeNow() {
    return Date.now() + serverClockOffset;
}

// ---------------------------------------------------------------------------
// Step 8A: several tabs/devices on one server.
// `base` is the document as last read from, or accepted by, the server, and
// `baseToken` names that version. Writes say which version they are based on;
// a plugin without tokens (older build) never returns one, and then writes
// behave exactly as before (last writer wins).
// ---------------------------------------------------------------------------
let base = null;
let baseToken = null;

const clone = value => JSON.parse(JSON.stringify(value));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function documentOf(doc) {
    return {
        version: STORE_VERSION,
        registry: doc.registry,
        collections: doc.collections,
        chatCollectionBindings: doc.chatCollectionBindings,
        chatCollectionPolicies: doc.chatCollectionPolicies,
        chunkMetadata: doc.chunkMetadata,
        recentlyDeleted: isPlainObject(doc.recentlyDeleted) ? doc.recentlyDeleted : {},
        ...(doc.migratedFrom ? { migratedFrom: doc.migratedFrom } : {}),
        ...(doc.migratedAt ? { migratedAt: doc.migratedAt } : {}),
    };
}

/** Raised when a strict write finds the server changed; nothing was written. */
export class StoreConflictError extends Error {
    constructor(message = 'VectHare state changed in another tab') {
        super(message);
        this.code = 'VH_STORE_CONFLICT';
    }
}

/**
 * Three-way merge of routine changes: what THIS tab changed since `baseDoc`
 * is applied on top of the server's current document, key by key.
 * Rules (keep data on doubt):
 *  - unchanged here -> server; changed here only -> ours;
 *  - changed on both sides: collection records merge field by field (same
 *    field on both -> server); every other section keeps the server's value;
 *  - deleted here but changed on the server -> server's value is kept;
 *  - registry: server + our additions - our removals.
 * VH-022: chat bindings are merged field by field too, so a rename here and a
 * new store recorded elsewhere both survive; their list fields (stores,
 * renamedChats, renamedOwners) merge as sets: the server's items, plus the
 * items added here, minus the items removed here. The same field changed on
 * both sides keeps the server's value. Creating a binding still goes through
 * the strict commit() in collection-ids.js.
 */
export function mergeOwnedDocuments(baseDoc, localDoc, serverDoc, log = () => {}) {
    const b = normalizeState(clone(baseDoc || emptyState()));
    const l = normalizeState(clone(localDoc));
    const sv = normalizeState(clone(serverDoc));
    const out = normalizeState(clone(serverDoc));
    const baseReg = new Set(b.registry), localReg = new Set(l.registry);
    const added = l.registry.filter(id => !baseReg.has(id));
    const removed = new Set(b.registry.filter(id => !localReg.has(id)));
    out.registry = [...new Set([...sv.registry, ...added])].filter(id => !removed.has(id));

    // VH-021: verified deletions from both sides (newest time per record).
    const deleted = { ...sv.recentlyDeleted };
    for (const [key, at] of Object.entries(l.recentlyDeleted)) if (!(deleted[key] >= at)) deleted[key] = at;
    out.recentlyDeleted = cleanRecentlyDeleted(deleted);
    // A record survives a recorded deletion only if it was created after it.
    const madeAfterDeletion = (key, record) => !(key in out.recentlyDeleted) ||
        Number(record?.recordCreatedAt) > out.recentlyDeleted[key];

    const mergeMap = (name, bMap, lMap, sMap, oMap, fieldMerge, honourDeletions = false) => {
        const keys = new Set([...Object.keys(bMap), ...Object.keys(lMap)]);
        for (const key of keys) {
            const bv = bMap[key], lv = lMap[key], svv = sMap[key];
            if (same(lv, bv)) continue;                       // not changed here
            if (same(svv, bv)) {                              // changed here only
                if (lv === undefined) delete oMap[key];
                else if (honourDeletions && !madeAfterDeletion(key, lv)) {
                    delete oMap[key]; log(`${name}.${key}: stays deleted (deleted elsewhere)`);
                } else oMap[key] = lv;
                continue;
            }
            if (lv === undefined) {
                // Deleted here, changed elsewhere: a verified deletion wins over
                // an edit made before it was seen (VH-021).
                if (honourDeletions && !madeAfterDeletion(key, svv)) {
                    delete oMap[key]; log(`${name}.${key}: deleted (edit elsewhere predates the deletion)`);
                } else log(`${name}.${key}: kept (changed elsewhere)`);
                continue;
            }
            if (svv === undefined) {
                if (honourDeletions && !madeAfterDeletion(key, lv)) {
                    delete oMap[key]; log(`${name}.${key}: stays deleted (deleted elsewhere)`);
                } else { oMap[key] = lv; log(`${name}.${key}: kept ours (removed elsewhere)`); }
                continue;
            }
            if (fieldMerge && isPlainObject(lv) && isPlainObject(svv)) {
                const merged = { ...svv };
                // VH-021: a record new on both sides is compared with the values a
                // new record starts with (collections), not with nothing.
                const bo = isPlainObject(bv) ? bv : (name === 'collections' ? collectionRecordDefaults : {});
                const setFields = isPlainObject(fieldMerge) ? fieldMerge.setFields || [] : [];
                for (const field of new Set([...Object.keys(bo), ...Object.keys(lv)])) {
                    if (same(lv[field], bo[field])) continue;
                    if ((fieldMerge === 'sets' || setFields.includes(field)) && Array.isArray(lv[field]) &&
                        (Array.isArray(svv[field]) || svv[field] === undefined) &&
                        (Array.isArray(bo[field]) || bo[field] === undefined)) {
                        merged[field] = mergeListAsSet(bo[field] || [], lv[field], svv[field] || []);
                        continue;
                    }
                    if (same(svv[field], bo[field])) {
                        if (lv[field] === undefined) delete merged[field]; else merged[field] = lv[field];
                    } else {
                        log(`${name}.${key}.${field}: server value kept`);
                    }
                }
                oMap[key] = merged;
            } else {
                log(`${name}.${key}: server value kept`);
            }
        }
    };
    mergeMap('collections', b.collections, l.collections, sv.collections, out.collections,
        { setFields: ['storageOldCopies'] }, true);

    mergeMap('chatCollectionPolicies', b.chatCollectionPolicies, l.chatCollectionPolicies,
        sv.chatCollectionPolicies, out.chatCollectionPolicies, false);
    mergeMap('chunkMetadata', b.chunkMetadata, l.chunkMetadata, sv.chunkMetadata, out.chunkMetadata, false);
    mergeMap('bindings', b.chatCollectionBindings.byCollection, l.chatCollectionBindings.byCollection,
        sv.chatCollectionBindings.byCollection, out.chatCollectionBindings.byCollection, 'sets');
    return out;
}

/**
 * VH-022: a list merged as a set. A store record is identified by backend,
 * source and destination; anything else by its JSON form.
 */
function mergeListAsSet(baseList, localList, serverList) {
    const keyOf = item => {
        if (isPlainObject(item) && 'layout' in item) {
            // VH-021: an old or pending storage copy (storageOldCopies).
            return `copy|${item.backend ?? ''}|${item.layout ?? ''}|${item.physical ?? ''}|` +
                `${item.pending ? item.startedAt ?? '' : ''}`;
        }
        return isPlainObject(item) && 'backend' in item
            ? `store|${item.backend ?? ''}|${item.source ?? ''}|${item.destination ?? ''}`
            : JSON.stringify(item);
    };
    const baseKeys = new Set(baseList.map(keyOf));
    const localKeys = new Set(localList.map(keyOf));
    const removedHere = new Set([...baseKeys].filter(key => !localKeys.has(key)));
    const out = [];
    const seen = new Set();
    for (const item of [...serverList, ...localList.filter(item => !baseKeys.has(keyOf(item)))]) {
        const key = keyOf(item);
        if (seen.has(key) || removedHere.has(key)) continue;
        seen.add(key);
        out.push(item);
    }
    return out;
}

/**
 * Makes `target` equal to `source` WITHOUT replacing its objects, so code
 * holding a reference to a section or a collection record keeps writing
 * into the live document (R18).
 */
/**
 * VH-044: tells listeners (RAG's saved-settings cache, the status line) that
 * the working copy now holds changes from another tab or device - after a
 * reload, a merge on write, or a discard-and-reload.
 */
function announceStoreChanged() {
    try { window.dispatchEvent(new CustomEvent('vecthare:store-reloaded')); } catch { /* optional */ }
}

function applyInPlace(target, source) {
    const patch = (t, src, depth) => {
        for (const key of Object.keys(t)) if (!(key in src)) delete t[key];
        for (const [key, value] of Object.entries(src)) {
            if (depth > 0 && isPlainObject(t[key]) && isPlainObject(value)) patch(t[key], value, depth - 1);
            else t[key] = value;
        }
    };
    target.registry.splice(0, target.registry.length, ...source.registry);
    patch(target.collections, source.collections, 1);
    patch(target.chatCollectionPolicies, source.chatCollectionPolicies, 0);
    patch(target.chunkMetadata, source.chunkMetadata, 0);
    if (!isPlainObject(target.recentlyDeleted)) target.recentlyDeleted = {};
    patch(target.recentlyDeleted, source.recentlyDeleted || {}, 0);
    target.chatCollectionBindings.version = source.chatCollectionBindings.version;
    patch(target.chatCollectionBindings.byCollection, source.chatCollectionBindings.byCollection, 1);
    if (source.migratedFrom) target.migratedFrom = source.migratedFrom; else delete target.migratedFrom;
    if (source.migratedAt) target.migratedAt = source.migratedAt; else delete target.migratedAt;
}

function adoptServerDocument(result) {
    base = clone(documentOf(normalizeState(result.state)));
    baseToken = typeof result.token === 'string' ? result.token : null;
}

/**
 * Collects the VectHare-owned state still held in extension settings. Only
 * VectHare's own collection keys are read; everything else is left alone.
 * @returns {{state: object, hadData: boolean}}
 */
function collectLegacyState() {
    const legacy = extension_settings.vecthare || {};
    const next = emptyState();
    let hadData = false;

    if (Array.isArray(legacy.vecthare_collection_registry) && legacy.vecthare_collection_registry.length) {
        next.registry = legacy.vecthare_collection_registry.filter(id => typeof id === 'string');
        hadData = true;
    }
    if (isPlainObject(legacy.collections) && Object.keys(legacy.collections).length) {
        next.collections = { ...legacy.collections };
        hadData = true;
    }
    if (isPlainObject(legacy.chatCollectionPolicies) && Object.keys(legacy.chatCollectionPolicies).length) {
        next.chatCollectionPolicies = { ...legacy.chatCollectionPolicies };
        hadData = true;
    }
    if (isPlainObject(legacy.chatCollectionBindings)) {
        const byCollection = isPlainObject(legacy.chatCollectionBindings.byCollection)
            ? { ...legacy.chatCollectionBindings.byCollection } : {};
        next.chatCollectionBindings = {
            version: Number(legacy.chatCollectionBindings.version) || 1,
            byCollection,
        };
        if (Object.keys(byCollection).length) hadData = true;
    }
    for (const key of Object.keys(legacy)) {
        if (!key.startsWith(CHUNK_META_PREFIX)) continue;
        next.chunkMetadata[key.slice(CHUNK_META_PREFIX.length)] = legacy[key];
        hadData = true;
    }
    return { state: next, hadData };
}

/**
 * Removes only the keys that were successfully migrated, through SillyTavern's
 * own persistence. Unrelated VectHare preferences stay untouched.
 */
function clearMigratedLegacyKeys() {
    const legacy = extension_settings.vecthare;
    if (!legacy) return;
    for (const key of MIGRATED_KEYS) delete legacy[key];
    for (const key of Object.keys(legacy)) {
        if (key.startsWith(CHUNK_META_PREFIX)) delete legacy[key];
    }
    // Working-copy fields must never be written back into settings.json.
    for (const key of ['registry', 'chunkMetadata']) delete legacy[key];
    legacy[MIGRATION_MARKER_KEY] = new Date().toISOString();
    saveSettingsDebounced();
}

/**
 * Loads the authoritative file, migrating from extension settings the first
 * time. Call once during extension initialization, before collection metadata
 * is used.
 * @returns {Promise<{status: string, detail: string}>}
 */
export function loadVectHareStore() {
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
        const alreadyMigrated = Boolean(extension_settings.vecthare?.[MIGRATION_MARKER_KEY]);
        try {
            const result = await requestState('read');

            if (result.status === 'found') {
                state = normalizeState(result.state);
                adoptServerDocument(result);
                status = 'ready';
                statusDetail = '';
                vhLog(`VectHare: Loaded owned state (${state.registry.length} registered, ` +
                    `${Object.keys(state.collections).length} collection records)`);
                return storeStatus();
            }

            if (result.status === 'invalid') {
                // Never fall back to stale settings and never pretend it is empty.
                state = null;
                status = 'failed';
                failureKind = 'damaged';
                statusDetail = `collections.json is unreadable (${result.reason || 'invalid document'})`;
                console.error(`VectHare: ${statusDetail}`);
                return storeStatus();
            }

            // status === 'missing'
            if (alreadyMigrated) {
                state = null;
                status = 'failed';
                failureKind = 'damaged';
                statusDetail = 'collections.json is missing even though migration already completed';
                console.error(`VectHare: ${statusDetail}`);
                return storeStatus();
            }

            const { state: migrated, hadData } = collectLegacyState();
            migrated.migratedFrom = 'extension-settings';
            migrated.migratedAt = new Date().toISOString();
            // `missing` as the base token: if another tab created the file
            // first, this write is refused and that file is used instead.
            const created = await requestState('write', { state: migrated,
                ...(result.token === 'missing' ? { baseToken: 'missing' } : {}) });
            // Make it authoritative only after reading back what was stored.
            const verification = await requestState('read');
            if (verification.status !== 'found') {
                throw new Error(`verification read returned "${verification.status}"`);
            }
            if (created?.conflict) vhLog('VectHare: Another tab created collections.json first; using it');
            state = normalizeState(verification.state);
            adoptServerDocument(verification);
            status = 'ready';
            statusDetail = '';
            clearMigratedLegacyKeys();
            vhLog(hadData
                ? 'VectHare: Migrated collection metadata into collections.json'
                : 'VectHare: Created collections.json (nothing to migrate)');
            return storeStatus();
        } catch (error) {
            state = null;
            status = 'failed';
            statusDetail = error.message;
            console.error('VectHare: Could not establish owned state storage:', error);
            return storeStatus();
        }
    })();
    return loadPromise;
}

/**
 * Re-reads collections.json so the caller works from what is actually
 * persisted rather than the in-memory working copy. Read-only with respect to
 * the stored document: pending writes are flushed FIRST so a reload can never
 * discard an unsaved change, and if anything goes wrong the store is left
 * exactly as it was rather than being downgraded on a transient read.
 *
 * @returns {Promise<{status: string, reloaded: boolean, reason?: string}>}
 */
export async function reloadVectHareStore() {
    if (status !== 'ready') {
        // Never paper over an unloaded or failed store with a silent reload.
        const result = await loadVectHareStore();
        return { ...result, reloaded: status === 'ready' };
    }

    try {
        await flushVectHareStore();
    } catch (error) {
        return { ...storeStatus(), reloaded: false,
            reason: `unsaved changes could not be written first (${error.message})` };
    }

    let result;
    try {
        result = await requestState('read');
    } catch (error) {
        return { ...storeStatus(), reloaded: false, reason: error.message };
    }

    if (result.status === 'found') {
        // Applied in place (R18): references held elsewhere stay live.
        applyInPlace(state, normalizeState(result.state));
        adoptServerDocument(result);
        announceStoreChanged();
        console.debug(`VectHare: Reloaded owned state (${state.registry.length} registered, ` +
            `${Object.keys(state.collections).length} collection records)`);
        return { ...storeStatus(), reloaded: true };
    }

    // The document was readable before, so a missing or invalid answer now is
    // reported and the known-good working copy is kept.
    return { ...storeStatus(), reloaded: false,
        reason: result.status === 'invalid'
            ? `collections.json is unreadable (${result.reason || 'invalid document'})`
            : `collections.json could not be read ("${result.status}")` };
}

async function writeNow(options = {}) {
    if (!state || status !== 'ready') return;
    dirty = false;
    for (let attempt = 0; ; attempt++) {
        const snapshot = clone(documentOf(state));
        let result;
        try {
            result = await requestState('write', { state: snapshot, ...(baseToken ? { baseToken } : {}) });
        } catch (error) {
            lastWriteError = error;
            dirty = true; // keep the pending change so a later flush retries it
            console.error('VectHare: Failed to persist collection metadata:', error);
            throw error;
        }
        if (!result?.conflict) {
            base = snapshot;
            if (typeof result?.token === 'string') baseToken = result.token;
            lastWriteError = null;
            return;
        }
        // Another tab/device changed the file since this tab last read it.
        if (options.strict || attempt >= 2 || result.status !== 'found' || !result.state) {
            dirty = true;
            const error = new StoreConflictError(result.status !== 'found'
                ? `collections.json is ${result.status} on the server; not overwritten`
                : 'VectHare state changed in another tab; this change was not written');
            lastWriteError = error;
            if (!options.strict && !conflictWarned) {
                conflictWarned = true;
                toastr.warning('VectHare metadata was changed in another tab and could not be merged yet; it will be retried.', 'VectHare');
            }
            throw error;
        }
        const merged = mergeOwnedDocuments(base, documentOf(state), result.state,
            line => console.info(`VectHare: merge with another tab - ${line}`));
        applyInPlace(state, merged);
        adoptServerDocument(result);
        announceStoreChanged();
    }
}
let conflictWarned = false;

/**
 * Queues a debounced, serialized write of the working copy. Safe to call from
 * every mutation; writes never overlap, so an update cannot be lost.
 */
export function persistVectHareStore() {
    if (status !== 'ready') return;
    dirty = true;
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = setTimeout(() => {
        writeTimer = null;
        writeChain = writeChain.then(() => writeNow()).catch(() => {});
    }, WRITE_DEBOUNCE_MS);
}

/**
 * Flushes any pending write and resolves once it has completed, so a caller
 * that must not lose state (a destructive commit) can await durability.
 * @returns {Promise<void>}
 */
/**
 * Empties VectHare's authoritative metadata document: the collection registry,
 * collection records, chunk annotations, chat bindings and chat policies. The
 * vectors themselves are NOT touched here - the caller purges those first and
 * only calls this once that purge is confirmed complete. Nothing outside this
 * document is read or written.
 * @returns {Promise<{success: boolean, verified: boolean, reason?: string}>}
 */
/**
 * VH-062 (user decision 2026-11-13: start fresh, no backup copy): replaces a
 * damaged or missing collections.json with an empty document. Only allowed
 * while the store failed because of the file itself. Vectors are untouched;
 * collections are rediscovered from the backends afterwards. Bindings and
 * annotations from the damaged file are lost.
 * @returns {Promise<{success: boolean, reason?: string}>}
 */
export async function startFreshVectHareStore() {
    if (status !== 'failed' || failureKind !== 'damaged') {
        return { success: false, reason: 'collections.json is not damaged; nothing was changed.' };
    }
    try {
        const current = await requestState('read');
        if (current.status === 'found') {
            // Fixed meanwhile (another tab, or by hand): use it.
            state = normalizeState(current.state);
            adoptServerDocument(current);
            status = 'ready'; statusDetail = ''; failureKind = null;
            return { success: true, reason: 'collections.json was readable again; it was loaded unchanged.' };
        }
        if (current.status !== 'invalid' && current.status !== 'missing') {
            return { success: false, reason: `collections.json could not be checked ("${current.status}")` };
        }
        const fresh = normalizeState({});
        fresh.freshStartAt = new Date().toISOString();
        // Written against the damaged file's version: if another tab changed it
        // first, this is refused and nothing is overwritten.
        const written = await requestState('write', { state: fresh,
            ...(typeof current.token === 'string' ? { baseToken: current.token } : {}) });
        if (written?.conflict) return { success: false, reason: 'collections.json changed in another tab; reload the page.' };
        const verification = await requestState('read');
        if (verification.status !== 'found') {
            return { success: false, reason: `the new collections.json could not be read back ("${verification.status}")` };
        }
        state = normalizeState(verification.state);
        adoptServerDocument(verification);
        status = 'ready'; statusDetail = ''; failureKind = null;
        vhLog('VectHare: Started a fresh collections.json (the damaged one was replaced)');
        return { success: true };
    } catch (error) {
        return { success: false, reason: error.message };
    }
}

export async function resetVectHareStore() {
    assertStoreAuthoritative('Resetting VectHare metadata');
    const before = {
        registry: state.registry.length,
        collections: Object.keys(state.collections).length,
        annotations: Object.keys(state.chunkMetadata).length,
        bindings: Object.keys(state.chatCollectionBindings.byCollection).length,
        policies: Object.keys(state.chatCollectionPolicies).length,
    };
    state.registry = [];
    state.collections = {};
    state.chunkMetadata = {};
    state.chatCollectionPolicies = {};
    state.chatCollectionBindings = { version: 1, byCollection: {} };
    dirty = true;
    try {
        // A reset must be exact: never merged with another tab's changes.
        await flushVectHareStore({ strict: true });
    } catch (error) {
        if (error?.code === 'VH_STORE_CONFLICT') {
            // Nothing was written. Show the server's document again rather
            // than letting a later routine save merge our emptied copy in.
            await discardLocalAndReload().catch(() => {});
            return { success: false, verified: false,
                reason: 'VectHare state was changed in another tab; nothing was reset. Reload and run it again.' };
        }
        return { success: false, verified: false, reason: error.message };
    }
    // Read back what is now stored rather than trusting the write.
    let result;
    try {
        result = await requestState('read');
    } catch (error) {
        return { success: true, verified: false, reason: error.message };
    }
    const stored = result.status === 'found' ? normalizeState(result.state) : null;
    const empty = stored !== null &&
        stored.registry.length === 0 &&
        Object.keys(stored.collections).length === 0 &&
        Object.keys(stored.chunkMetadata).length === 0 &&
        Object.keys(stored.chatCollectionBindings.byCollection).length === 0 &&
        Object.keys(stored.chatCollectionPolicies).length === 0;
    vhLog('VectHare: Reset owned metadata ' +
        `(was ${before.registry} registered, ${before.collections} records, ` +
        `${before.annotations} annotated chunks, ${before.bindings} bindings, ` +
        `${before.policies} policies)`);
    return empty
        ? { success: true, verified: true }
        : { success: true, verified: false,
            reason: stored === null
                ? `the stored document could not be re-read ("${result.status}")`
                : 'the stored document still holds entries' };
}

/**
 * Drops this tab's unsaved changes and shows the server's document (applied
 * in place). Only for a strict write that was refused.
 */
export async function discardLocalAndReload() {
    if (status !== 'ready') return;
    if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
    await writeChain;
    const result = await requestState('read');
    if (result.status !== 'found') throw new Error(`collections.json could not be read ("${result.status}")`);
    applyInPlace(state, normalizeState(result.state));
    adoptServerDocument(result);
    dirty = false;
    announceStoreChanged();
}

export async function flushVectHareStore(options = {}) {
    if (writeTimer) {
        clearTimeout(writeTimer);
        writeTimer = null;
    }
    if (dirty || options.strict) {
        const run = writeChain.then(() => writeNow(options));
        writeChain = run.catch(() => {});
        await run;
        return;
    }
    await writeChain;
}

/** Step 8B: the server's current token, or null when the plugin has none. */
export async function fetchStoreToken() {
    if (!baseToken) return null;
    const response = await fetch('/api/plugins/similharity/owned-state/token', {
        method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({}),
    });
    if (!response.ok) return null;
    const data = await response.json().catch(() => null);
    noteServerClock(data); // VH-065
    return typeof data?.token === 'string' ? data.token : null;
}

let lastFreshCheck = 0;
/**
 * Step 8B (stale tab): asks the server for the current version and, if
 * another tab changed collections.json since this tab last read or wrote it,
 * re-reads it in place (pending local changes are saved/merged first).
 * Cheap: one tiny request, at most every `minIntervalMs`. Without plugin
 * tokens it does nothing.
 * @returns {Promise<boolean>} true when the document was reloaded
 */
export async function refreshStoreIfStale({ minIntervalMs = 2000, strict = false } = {}) {
    if (status !== 'ready' || !baseToken) return false;
    const now = Date.now();
    if (now - lastFreshCheck < minIntervalMs) return false;
    lastFreshCheck = now;
    let token;
    // VH-012: strict callers must not go on with a view they could not check.
    try { token = await fetchStoreToken(); } catch (error) { if (strict) throw error; return false; }
    if (!token || token === baseToken) return false;
    const result = await reloadVectHareStore(); // announces the change itself (VH-044)
    return Boolean(result.reloaded);
}

/** Step 8B: this tab's view of the server version (null without tokens). */
export function storeBaseToken() {
    return baseToken;
}

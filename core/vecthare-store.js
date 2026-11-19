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
    };
}

/**
 * Working copy. Until the file has been read this is null, and accessors fall
 * back to whatever is still in extension settings (pre-migration startup), so
 * the UI keeps working while loading.
 */
let state = null;
let status = 'unloaded'; // unloaded | ready | failed
let statusDetail = '';
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
    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`owned-state/${action} failed: ${response.status} ${detail}`.trim());
    }
    return await response.json();
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
                status = 'ready';
                statusDetail = '';
                console.log(`VectHare: Loaded owned state (${state.registry.length} registered, ` +
                    `${Object.keys(state.collections).length} collection records)`);
                return storeStatus();
            }

            if (result.status === 'invalid') {
                // Never fall back to stale settings and never pretend it is empty.
                state = null;
                status = 'failed';
                statusDetail = `collections.json is unreadable (${result.reason || 'invalid document'})`;
                console.error(`VectHare: ${statusDetail}`);
                return storeStatus();
            }

            // status === 'missing'
            if (alreadyMigrated) {
                state = null;
                status = 'failed';
                statusDetail = 'collections.json is missing even though migration already completed';
                console.error(`VectHare: ${statusDetail}`);
                return storeStatus();
            }

            const { state: migrated, hadData } = collectLegacyState();
            migrated.migratedFrom = 'extension-settings';
            migrated.migratedAt = new Date().toISOString();
            await requestState('write', { state: migrated });
            // Make it authoritative only after reading back what was stored.
            const verification = await requestState('read');
            if (verification.status !== 'found') {
                throw new Error(`verification read returned "${verification.status}"`);
            }
            state = normalizeState(verification.state);
            status = 'ready';
            statusDetail = '';
            clearMigratedLegacyKeys();
            console.log(hadData
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
        state = normalizeState(result.state);
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

async function writeNow() {
    if (!state || status !== 'ready') return;
    dirty = false;
    const snapshot = JSON.parse(JSON.stringify({
        version: STORE_VERSION,
        registry: state.registry,
        collections: state.collections,
        chatCollectionBindings: state.chatCollectionBindings,
        chatCollectionPolicies: state.chatCollectionPolicies,
        chunkMetadata: state.chunkMetadata,
        ...(state.migratedFrom ? { migratedFrom: state.migratedFrom } : {}),
        ...(state.migratedAt ? { migratedAt: state.migratedAt } : {}),
    }));
    try {
        await requestState('write', { state: snapshot });
        lastWriteError = null;
    } catch (error) {
        lastWriteError = error;
        dirty = true; // keep the pending change so a later flush retries it
        console.error('VectHare: Failed to persist collection metadata:', error);
        throw error;
    }
}

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
        await flushVectHareStore();
    } catch (error) {
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
    console.log('VectHare: Reset owned metadata ' +
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

export async function flushVectHareStore() {
    if (writeTimer) {
        clearTimeout(writeTimer);
        writeTimer = null;
    }
    if (dirty) writeChain = writeChain.then(() => writeNow());
    await writeChain.catch(error => { throw error; });
}

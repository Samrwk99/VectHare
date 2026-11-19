/**
 * Step 9d / P6: "Move storage…" - moves ONE collection between the layouts of
 * the SAME backend (Qdrant own collection <-> shared v2; Milvus old shared /
 * shared v2 / own collection), keeping its logical id, so registry, records,
 * annotations and chat bindings all stay keyed the same.
 *
 *  1. read the source vectors and 2. write them to the target (plugin, no
 *     re-embedding), 3. verify (same count, 5 random hashes identical);
 *  4. write the target's saved settings (the source's, with the storage
 *     replaced and a movedFrom note);
 *  5. strict commit: only if the locator still points at the source and the
 *     source count is unchanged -> locator = target, chat store destination
 *     updated (R13), source listed as an "old copy (moved)";
 *  6. the identity ledger is written under the new binding (the old one stays
 *     with the old copy);
 *  7. the old copy is kept until the user deletes it (Delete old copy).
 * Any failure before 5 removes the partial target and changes nothing else. A
 * failure after 5 leaves both copies; the target is authoritative.
 * The whole move holds the collection's cross-tab lease (8C).
 */

import { getRequestHeaders } from '../../../../../script.js';
import { vecthareState, persistVectHareStore, flushVectHareStore, reloadVectHareStore, discardLocalAndReload, assertStoreAuthoritative } from './vecthare-store.js';
import { acquireLease } from './leases.js';
import {
    getStorageLocator, newCollectionLayout, scopedTenancySupported, bareCollectionId,
    locatorForPhysical, normalizeBackend, isV2Layout,
} from './storage-resolver.js';
import {
    ensureStorageLocator, readInitialVectorizationConfig, verifyPhysicalCollectionExistence,
    getStoredCollectionRecord, findStoredCollectionKey, setCollectionMeta,
} from './collection-metadata.js';
import { chatStoreDestination } from './collection-ids.js';

const MOVE = '/api/plugins/similharity/storage/move';

async function post(url, body) {
    const response = await fetch(url, { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
    return data;
}

const locationOf = storage => ({ layout: storage.layout, physical: storage.physical ?? null, ...(storage.dim ? { dim: storage.dim } : {}) });

/** The storage part of a saved configuration for `layout`, from the source's. */
function storageFor(oldStorage, layout) {
    const backend = normalizeBackend(oldStorage.backend);
    if (backend === 'qdrant') {
        return { backend: 'qdrant', multitenancy: layout !== 'per-collection', address: oldStorage.address,
            ...(layout === 'mt-v2' ? { layout } : {}) };
    }
    return { backend: 'milvus', address: oldStorage.address, ...(isV2Layout('milvus', layout) ? { layout } : {}) };
}

const identityBindingFor = (settings, config, storage) => ({
    backend: settings.vector_backend || 'standard', source: config.embedding.provider,
    model: config.embedding.model || '', storage, chunking: config.chunking,
});

/**
 * What a move of this collection would do, without doing it.
 * @returns {Promise<{ok: boolean, reason?: string, from?: object, to?: string}>}
 */
export async function planStorageMove(collectionId, settings) {
    const backend = normalizeBackend(settings?.vector_backend);
    const id = bareCollectionId(collectionId);
    if (!['qdrant', 'milvus'].includes(backend)) return { ok: false, reason: 'Only Qdrant and Milvus collections have more than one storage layout.' };
    if (!await scopedTenancySupported()) return { ok: false, reason: 'The installed Similharity plugin cannot move storage. Update it (13.32 or later).' };
    const located = await ensureStorageLocator(id, settings);
    if (located.status === 'conflict') return { ok: false, reason: `Its saved settings are in more than one place (${located.locations.join(', ')}).` };
    const from = getStorageLocator(id);
    if (!from || from.backend !== backend) return { ok: false, reason: 'Where this collection is stored is not known (no saved settings were found). Re-vectorize it instead.' };
    if (from.layout === 'legacy-mt') return { ok: false, reason: 'Collections in the old shared Qdrant store cannot be moved (their contents are incomplete). Re-vectorize them instead (Vectorize offers a rebuild).' };
    const to = newCollectionLayout(settings, true, backend);
    if (to === from.layout) {
        return { ok: false, from, to, reason: `It is already where the multitenancy switch puts new collections (${from.layout}). Change the switch to choose the other layout.` };
    }
    return { ok: true, from, to };
}

/**
 * Moves the collection (see the file comment).
 * @returns {Promise<{success: boolean, reason?: string, from?: object, to?: object, copied?: number, warnings: string[]}>}
 */
export async function moveCollectionStorage(collectionId, settings, { onPhase } = {}) {
    assertStoreAuthoritative('Moving a collection');
    const id = bareCollectionId(collectionId);
    const backend = normalizeBackend(settings.vector_backend);
    const warnings = [];
    const plan = await planStorageMove(id, settings);
    if (!plan.ok) return { success: false, reason: plan.reason, warnings };
    let lease;
    try { lease = await acquireLease(id, { label: 'Move storage' }); }
    catch (error) { return { success: false, reason: error.message, warnings }; }
    try {
        // The plugin checks deletes against the metadata FILE: the recorded
        // locator must be there before anything is written.
        await flushVectHareStore();
        onPhase?.('Reading saved settings…');
        const saved = await readInitialVectorizationConfig(id, settings);
        if (saved.status !== 'valid') {
            return { success: false, reason: `Its saved settings could not be verified (${saved.status}); nothing was moved.`, warnings };
        }
        const config = saved.config;
        const oldBinding = identityBindingFor(settings, config, config.storage);
        let ledger = null;
        if (config.identityLedger === 1) {
            const read = await post('/api/plugins/similharity/identity-ledger/read', { collectionId: id, binding: oldBinding });
            if (read.status === 'found') {
                if (read.ledger.state !== 'clean') {
                    return { success: false, reason: 'A Sync of this chat is not finished (its identity ledger has pending work). Let Sync complete, then move.', warnings };
                }
                ledger = read.ledger;
            } else if (read.status === 'invalid') {
                return { success: false, reason: 'Its identity ledger is unreadable; nothing was moved.', warnings };
            }
        }
        const where = { source: config.embedding.provider, model: config.embedding.model || '' };
        const before = await verifyPhysicalCollectionExistence(id, settings, where);
        if (before.existence !== 'present') {
            return { success: false, reason: `Its vectors could not be confirmed at ${plan.from.physical} (${before.reason || before.existence}); nothing was moved.`, warnings };
        }
        const sourceCount = before.countTrusted === true && Number.isSafeInteger(before.count) ? before.count : null;
        const stillUnchanged = async () => {
            if (sourceCount === null) return true;
            const now = await verifyPhysicalCollectionExistence(id, settings, where);
            return !(now.countTrusted === true && now.count !== sourceCount);
        };

        // 1-3: copy and verify on the server.
        onPhase?.('Copying vectors…');
        const copy = await post(MOVE, { action: 'copy', backend, collectionId: id,
            from: locationOf(plan.from), to: { layout: plan.to },
            embedding: { source: config.embedding.provider, model: config.embedding.model || '' } });
        if (await lease.touch() === false) {
            await post(MOVE, { action: 'delete-copy', backend, collectionId: id, location: copy.target }).catch(() => {});
            return { success: false, reason: 'Another tab took over this chat while it was being copied; nothing was moved.', warnings };
        }
        const target = locatorForPhysical(id, backend, copy.target?.physical, copy.target?.dim ?? null);
        const removeTarget = async () => {
            try { await post(MOVE, { action: 'delete-copy', backend, collectionId: id, location: copy.target }); }
            catch (error) { warnings.push(`The partial copy in ${copy.target?.physical} could not be removed: ${error.message}`); }
        };
        if (!target || (sourceCount !== null && copy.sourceCount !== sourceCount)) {
            await removeTarget();
            return { success: false, reason: 'The source changed while it was being copied; nothing was moved.', warnings };
        }

        // 4: the target's saved settings (written once).
        onPhase?.('Saving settings at the new location…');
        const newStorage = storageFor(config.storage, plan.to);
        const { identityLedger, ...snapshotFields } = config;
        const snapshot = { ...snapshotFields, ...(identityLedger === 1 ? { identityLedger } : {}), storage: newStorage,
            movedFrom: { layout: plan.from.layout, physical: plan.from.physical, movedAt: new Date().toISOString() } };
        try {
            const result = await post('/api/plugins/similharity/collections/initial-config', {
                backend, collectionId: id, physicalCollectionId: target.physical,
                source: config.embedding.provider, model: config.embedding.model || '', snapshot,
                ...(isV2Layout(backend, plan.to) ? { storage: { layout: plan.to, physical: target.physical, ...(target.dim ? { dim: target.dim } : {}) } } : {}),
            });
            if (result.saved !== true) throw new Error('the new location already held saved settings');
        } catch (error) {
            await removeTarget();
            return { success: false, reason: `The settings could not be saved at the new location (${error.message}); nothing was moved.`, warnings };
        }

        // 5: strict commit of the switch-over.
        onPhase?.('Switching over…');
        // The old copy remembers its own saved-settings binding, so deleting it
        // later can also delete the identity ledger that belongs to it.
        const oldCopy = { ...plan.from, ...(config.identityLedger === 1 ? { ledgerBinding: oldBinding } : {}) };
        const committed = await commitMove(id, settings, plan.from, oldCopy, target, stillUnchanged);
        if (!committed.ok) {
            if (committed.uncertain) {
                return { success: false, uncertain: true, warnings,
                    reason: `${committed.reason}. Both copies were kept; reload this page and check the Storage tab before doing anything else with this chat.` };
            }
            await removeTarget();
            return { success: false, reason: `${committed.reason}; nothing was moved.`, warnings };
        }

        // 6: the identity ledger under the new binding (the old one stays).
        if (ledger) {
            try {
                const newBinding = identityBindingFor(settings, config, newStorage);
                const { __token, revision, ...contents } = ledger;
                const status = await post('/api/plugins/similharity/identity-ledger/read', { collectionId: id, binding: newBinding });
                await post('/api/plugins/similharity/identity-ledger/save', { collectionId: id, binding: newBinding,
                    ledger: { ...contents, binding: newBinding }, ...(typeof status.token === 'string' ? { baseToken: status.token } : {}) });
            } catch (error) {
                warnings.push(`The identity ledger could not be copied (${error.message}); the next Sync rebuilds it from the stored vectors.`);
            }
        }
        return { success: true, from: plan.from, to: target, copied: copy.copied, warnings };
    } catch (error) {
        return { success: false, reason: error.message, warnings };
    } finally {
        await lease.release();
    }
}

/**
 * Strict commit of step 5, re-checked on fresh state on conflict (8A pattern).
 * `uncertain` means the save's outcome is unknown and could not be read back:
 * the caller must then keep BOTH copies.
 */
async function commitMove(id, settings, from, oldCopy, target, stillUnchanged) {
    for (let attempt = 0; attempt < 3; attempt++) {
        const current = getStorageLocator(id);
        if (!current || current.physical !== from.physical || current.layout !== from.layout) {
            return { ok: false, reason: 'The collection moved or changed in another tab' };
        }
        if (!await stillUnchanged()) return { ok: false, reason: 'New vectors were written meanwhile' };
        await flushVectHareStore();
        const key = findStoredCollectionKey(id) || id;
        const collections = vecthareState().collections;
        const hadRecord = Object.prototype.hasOwnProperty.call(collections, key);
        const previousRecord = hadRecord ? JSON.parse(JSON.stringify(collections[key])) : undefined;
        const bindings = vecthareState().chatCollectionBindings?.byCollection || {};
        const previousBinding = bindings[id] ? JSON.parse(JSON.stringify(bindings[id])) : undefined;
        const rollback = () => {
            if (hadRecord) collections[key] = previousRecord; else delete collections[key];
            if (previousBinding !== undefined) bindings[id] = previousBinding;
        };
        try {
            const oldDestination = chatStoreDestination(settings, id);
            const oldCopies = Array.isArray(collections[key]?.storageOldCopies) ? collections[key].storageOldCopies : [];
            setCollectionMeta(key, {
                storage: target,
                storageOldCopies: [...oldCopies.filter(copy => !(copy.physical === target.physical && copy.layout === target.layout)),
                    { ...oldCopy, movedAt: new Date().toISOString() }],
            });
            // R13: the chat's recorded store destination follows the collection
            // (only entries naming the old place; other servers are left alone).
            const rec = bindings[id];
            if (rec && Array.isArray(rec.stores)) {
                const backend = settings.vector_backend || 'standard';
                const destination = chatStoreDestination(settings, id);
                const seen = new Set();
                rec.stores = rec.stores.map(store => store.backend === backend && store.destination === oldDestination
                    ? { ...store, destination } : store)
                    .filter(store => {
                        const k = `${store.backend}\u0000${store.source}\u0000${store.destination}`;
                        if (seen.has(k)) return false;
                        seen.add(k);
                        return true;
                    });
            }
            persistVectHareStore();
            await flushVectHareStore({ strict: true });
            return { ok: true };
        } catch (error) {
            rollback();
            if (error?.code === 'VH_STORE_CONFLICT') {
                // Nothing was written; look again on the server's document.
                if (attempt < 2) {
                    const reloaded = await reloadVectHareStore().catch(() => ({ reloaded: false }));
                    if (reloaded.reloaded) continue;
                }
                return { ok: false, reason: 'VectHare state kept changing in another tab' };
            }
            // Outcome unknown (e.g. the connection dropped): read back what the
            // server holds before deciding which copy is the real one.
            try {
                await discardLocalAndReload();
                const now = getStorageLocator(id);
                if (now?.physical === target.physical && now?.layout === target.layout) return { ok: true };
                if (now?.physical === from.physical && now?.layout === from.layout) {
                    return { ok: false, reason: `The switch-over could not be saved (${error.message})` };
                }
            } catch { /* fall through: unknown */ }
            return { ok: false, uncertain: true, reason: `The switch-over may not have been saved (${error.message})` };
        }
    }
    return { ok: false, reason: 'The switch-over could not be saved' };
}

/**
 * Deletes an "old copy (moved)" of a collection: only one this tab's records
 * list as an old copy, and never the location the collection uses now. Its
 * vectors and saved settings are removed (verified empty by the plugin), and
 * the identity ledger that belonged to it.
 */
export async function deleteOldStorageCopy(collectionId, settings, which) {
    assertStoreAuthoritative('Deleting an old copy');
    const id = bareCollectionId(collectionId);
    const record = getStoredCollectionRecord(id);
    const listed = (record?.record?.storageOldCopies || [])
        .find(copy => copy?.physical === which?.physical && copy?.layout === which?.layout);
    if (!listed) return { success: false, reason: 'That location is not recorded as an old copy of this collection.' };
    const backend = normalizeBackend(listed.backend || settings.vector_backend);
    const current = getStorageLocator(id);
    if (!current || (current.physical === listed.physical && current.layout === listed.layout)) {
        return { success: false, reason: 'That is where the collection is now (or where it is is not known); it was not deleted.' };
    }
    let lease;
    try { lease = await acquireLease(id, { label: 'Delete old copy' }); }
    catch (error) { return { success: false, reason: error.message }; }
    const warnings = [];
    try {
        await flushVectHareStore();
        await post(MOVE, { action: 'delete-copy', backend, collectionId: id, location: locationOf(listed) });
        if (listed.ledgerBinding) {
            try {
                await post('/api/plugins/similharity/identity-ledger/save', { collectionId: id, binding: listed.ledgerBinding, ledger: null });
            } catch (error) {
                warnings.push(`Its old identity ledger file could not be removed (${error.message}); it is unused.`);
            }
        }
        const fresh = getStoredCollectionRecord(id);
        const remaining = (fresh?.record?.storageOldCopies || [])
            .filter(copy => !(copy.physical === listed.physical && copy.layout === listed.layout));
        setCollectionMeta(fresh?.key || id, { storageOldCopies: remaining });
        await flushVectHareStore();
        return { success: true, warnings };
    } catch (error) {
        return { success: false, reason: error.message, warnings };
    } finally {
        await lease.release();
    }
}

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
    if (!response.ok) {
        const error = new Error(data?.error || `HTTP ${response.status}`);
        error.status = response.status;
        throw error;
    }
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
    if (!await scopedTenancySupported()) return { ok: false, reason: 'The installed Similharity plugin cannot move storage. Install the plugin that comes with this VectHare.' };
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
        // VH-012: "unchanged" used to be answered "yes" whenever the count could
        // not be trusted. The hash list taken now is compared instead in that
        // case; a list that cannot be read counts as changed (nothing switches).
        const hashKey = list => [...new Set((list || []).map(String))].sort().join(',');
        const { getSavedHashes } = await import('./core-vector-api.js');
        let sourceHashes = null;
        try { sourceHashes = hashKey(await getSavedHashes(id, settings)); } catch { sourceHashes = null; }
        const sameHashes = async () => {
            if (sourceHashes === null) return false;
            try { return hashKey(await getSavedHashes(id, settings)) === sourceHashes; } catch { return false; }
        };
        const stillUnchanged = async () => {
            if (sourceCount === null) return sameHashes();
            const now = await verifyPhysicalCollectionExistence(id, settings, where);
            if (now.countTrusted !== true) return sameHashes();
            return now.count === sourceCount;
        };

        // VH-010: record the target as a pending copy BEFORE copying, so a move
        // that is interrupted or fails half-way leaves a copy the Storage tab
        // can show and delete ("Leftover copy from an unfinished move").
        const pendingEntry = { backend, layout: plan.to, pending: true, startedAt: new Date().toISOString(),
            physical: backend === 'qdrant' && plan.to === 'per-collection' ? id : null };
        try {
            await setPendingCopy(id, null, pendingEntry);
        } catch (error) {
            return { success: false, reason: `The move could not be recorded first (${error.message}); nothing was moved.`, warnings };
        }
        let pendingNow = pendingEntry;

        // 1-3: copy and verify on the server.
        onPhase?.('Copying vectors…');
        let copy;
        try {
            copy = await post(MOVE, { action: 'copy', backend, collectionId: id,
                from: locationOf(plan.from), to: { layout: plan.to },
                embedding: { source: config.embedding.provider, model: config.embedding.model || '' } });
        } catch (error) {
            // The plugin refused before writing (or the answer was lost). The
            // pending record stays only if something may have been written.
            if (error?.status >= 400 && error.status < 500) {
                await setPendingCopy(id, pendingNow, null).catch(() => {});
                const earlier = (getStoredCollectionRecord(id)?.record?.storageOldCopies || [])
                    .some(entry => entry?.pending === true && entry.layout === plan.to);
                if (earlier && /already holds a copy/i.test(error.message)) {
                    return { success: false, warnings, reason: 'A leftover copy from an earlier unfinished move is in the way. ' +
                        'Delete it in the Storage tab ("Delete leftover copy"), then move again; nothing was moved.' };
                }
            }
            throw error;
        }
        if (copy?.target?.physical) {
            const known = { ...pendingNow, physical: copy.target.physical, ...(copy.target.dim ? { dim: copy.target.dim } : {}) };
            await setPendingCopy(id, pendingNow, known).catch(error =>
                warnings.push(`The new copy could not be recorded yet (${error.message}).`));
            pendingNow = known;
        }
        if (await lease.touch() === false) {
            try {
                await post(MOVE, { action: 'delete-copy', backend, collectionId: id, location: copy.target });
                await setPendingCopy(id, pendingNow, null).catch(() => {});
            } catch { /* stays listed as a leftover copy (VH-010) */ }
            return { success: false, reason: 'Another tab took over this chat while it was being copied; nothing was moved.', warnings };
        }
        const target = locatorForPhysical(id, backend, copy.target?.physical, copy.target?.dim ?? null);
        const removeTarget = async () => {
            try {
                await post(MOVE, { action: 'delete-copy', backend, collectionId: id, location: copy.target });
                // VH-010: removed, so it is no longer a leftover.
                await setPendingCopy(id, pendingNow, null).catch(() => {});
            } catch (error) {
                warnings.push(`The partial copy in ${copy.target?.physical} could not be removed: ${error.message}. ` +
                    'It is listed in the Storage tab as a leftover copy you can delete.');
            }
        };
        if (!target || (sourceCount !== null && copy.sourceCount !== sourceCount)) {
            await removeTarget();
            return { success: false, reason: 'The source changed while it was being copied; nothing was moved.', warnings };
        }

        // 4: the target's saved settings (written once).
        onPhase?.('Saving settings at the new location…');
        // VH-012: the copy can take long; make sure the lease still holds before
        // writing anything at the new location.
        if (await lease.touch() === false) {
            await removeTarget();
            return { success: false, reason: 'Another tab took over this chat while it was being copied; nothing was moved.', warnings };
        }
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
        // VH-012: and again right before the switch-over.
        if (await lease.touch() === false) {
            await removeTarget();
            return { success: false, reason: 'Another tab took over this chat during the move; nothing was moved.', warnings };
        }
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
                // VH-010: the target is the collection's home now - no longer a
                // pending copy (whether or not its store was known when recorded).
                storageOldCopies: [...oldCopies.filter(copy => !(copy.physical === target.physical && copy.layout === target.layout) &&
                    !(copy.pending === true && copy.physical == null && copy.layout === target.layout)),
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
/**
 * VH-053: deletes every recorded old copy of a collection (used before the
 * collection itself is deleted). Stops at the first copy that cannot be deleted.
 * @returns {Promise<{success: boolean, deleted: number, reason?: string, warnings: string[]}>}
 */
export async function deleteAllOldStorageCopies(collectionId, settings) {
    const id = bareCollectionId(collectionId);
    const copies = getStoredCollectionRecord(id)?.record?.storageOldCopies || [];
    const warnings = [];
    let deleted = 0;
    for (const copy of copies) {
        const result = await deleteOldStorageCopy(id, settings, copy);
        warnings.push(...(result.warnings || []));
        if (!result.success) {
            return { success: false, deleted, warnings,
                reason: `its old copy (moved) in ${copy.physical || copy.layout} could not be deleted: ${result.reason}` };
        }
        deleted++;
    }
    return { success: true, deleted, warnings };
}

/**
 * VH-010: asks the storage report where a leftover copy of `layout` is (the
 * report matches an unknown pending copy to any location of that layout other
 * than the collection's current one). null: nothing is there.
 */
async function findLeftoverPhysical(id, settings, layout) {
    const { fetchStorageReport } = await import('./storage-report.js');
    const result = await fetchStorageReport(settings);
    if (!result?.ok || !Array.isArray(result.report?.collections)) {
        throw new Error(result?.reason || 'the storage report is not available');
    }
    const row = result.report.collections.find(r => r.collectionId === id);
    // No row at all means the report could not see this collection: never read
    // that as "nothing left".
    if (!row) throw new Error('the storage report does not list this collection');
    // Any store the report could not read could be the one holding the copy.
    const backend = normalizeBackend(settings.vector_backend);
    const storeErrors = [result.report.backends?.[backend]?.error,
        ...(result.report.sharedStores || []).filter(s => normalizeBackend(s.backend) === backend).map(s => s.error)].filter(Boolean);
    if (storeErrors.length) throw new Error(`part of the storage could not be read (${storeErrors[0]})`);
    const hit = (row?.oldCopies || []).find(copy => copy.pending === true && copy.layout === layout &&
        typeof copy.physical === 'string' && copy.physical && !(copy.count === 0 && copy.note));
    return hit ? hit.physical : null;
}

/**
 * VH-010: replaces one pending-copy entry (`from`, matched by layout, physical
 * and startedAt) with `to` in the collection's storageOldCopies, or adds `to`
 * (from = null) or removes `from` (to = null); then saves.
 */
async function setPendingCopy(id, from, to) {
    const record = getStoredCollectionRecord(id);
    const key = record?.key || findStoredCollectionKey(id) || id;
    const list = Array.isArray(record?.record?.storageOldCopies) ? record.record.storageOldCopies : [];
    const isFrom = copy => from && copy?.pending === true && copy.layout === from.layout &&
        (copy.physical ?? null) === (from.physical ?? null) && copy.startedAt === from.startedAt;
    const next = [...list.filter(copy => !isFrom(copy)), ...(to ? [to] : [])];
    setCollectionMeta(key, { storageOldCopies: next });
    persistVectHareStore();
    await flushVectHareStore();
}

export async function deleteOldStorageCopy(collectionId, settings, which) {
    assertStoreAuthoritative('Deleting an old copy');
    const id = bareCollectionId(collectionId);
    const record = getStoredCollectionRecord(id);
    const copies = record?.record?.storageOldCopies || [];
    const isUnknownPending = copy => copy?.pending === true && copy.physical == null && copy.layout === which?.layout;
    let listed = copies.find(copy => copy?.physical != null && copy.physical === which?.physical && copy?.layout === which?.layout);
    // VH-010: a leftover copy recorded before its store was known. The Storage
    // report names the store it found (which.physical); without that name it is
    // looked up here, and with nothing left the record is simply removed.
    // A pending entry whose store is known, asked for without a store name.
    if (!listed && !which?.physical) {
        const known = copies.filter(copy => copy?.pending === true && copy.physical != null && copy.layout === which?.layout);
        if (known.length === 1) listed = known[0];
    }
    const unknownPending = !listed && copies.find(isUnknownPending);
    if (unknownPending) {
        let named = typeof which?.physical === 'string' && which.physical && which.physical !== 'null' ? which.physical : null;
        if (!named) {
            let found;
            try { found = await findLeftoverPhysical(id, settings, unknownPending.layout); }
            catch (error) { return { success: false, reason: `Where the leftover copy is could not be checked (${error.message}); nothing was deleted.` }; }
            if (found === null) {
                await setPendingCopy(id, unknownPending, null);
                return { success: true, warnings: ['Nothing was left of that copy; its record was removed.'] };
            }
            named = found;
        }
        listed = { ...unknownPending, physical: named };
    }
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
        const removed = await post(MOVE, { action: 'delete-copy', backend, collectionId: id, location: locationOf(listed) });
        if (Number(removed?.leftShared) > 0) {
            // VH-011 (option B): Milvus' older shared store.
            const { sharedLeftoverNote } = await import('./collection-loader.js');
            warnings.push(sharedLeftoverNote(Number(removed.leftShared)));
        }
        if (listed.ledgerBinding) {
            try {
                await post('/api/plugins/similharity/identity-ledger/save', { collectionId: id, binding: listed.ledgerBinding, ledger: null });
            } catch (error) {
                warnings.push(`Its old identity ledger file could not be removed (${error.message}); it is unused.`);
            }
        }
        const fresh = getStoredCollectionRecord(id);
        const remaining = (fresh?.record?.storageOldCopies || [])
            .filter(copy => !(copy.physical === listed.physical && copy.layout === listed.layout) &&
                !(unknownPending && copy.pending === true && copy.physical == null && copy.layout === listed.layout &&
                    copy.startedAt === unknownPending.startedAt));
        setCollectionMeta(fresh?.key || id, { storageOldCopies: remaining });
        await flushVectHareStore();
        return { success: true, warnings };
    } catch (error) {
        return { success: false, reason: error.message, warnings };
    } finally {
        await lease.release();
    }
}

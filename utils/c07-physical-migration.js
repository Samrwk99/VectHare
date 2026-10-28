/**
 * C07 completion groundwork: a no-side-effects migration plan for physical record IDs.
 *
 * The current plugin does not prove client IDs, scoped getByIds, updatePayload,
 * atomic upsert or tenant-safe delete. This module NEVER promotes those flags.
 * Callers must provide independently verified inventory and a C02 replacement
 * implementation before a plan can be applied. A plan is NOT a live migration.
 */
import {parseCollectionKey} from './collection-keys.js';
import {recordId, remapReferences, fingerprint} from './record-identity.js';

const validId = id => (typeof id === 'string' && id.length > 0) || (typeof id === 'number' && Number.isSafeInteger(id));
const asKey = id => String(id);
function inventoryProof(inventory, collectionKey) {
    if (!inventory || inventory.complete !== true || inventory.endOfListConfirmed !== true ||
        inventory.contractVerified !== true || inventory.scope !== collectionKey ||
        !Array.isArray(inventory.records) || !Number.isSafeInteger(inventory.expectedCount) ||
        inventory.expectedCount !== inventory.records.length) return false;
    const found = new Set();
    for (const row of inventory.records) {
        if (!row || row.collectionKey !== collectionKey || !validId(row.recordId) || found.has(asKey(row.recordId))) return false;
        found.add(asKey(row.recordId));
    }
    return true;
}
/**
 * Build a versioned, deterministic plan from an independently verified COMPLETE
 * collection inventory. For each record caller supplies a `localId` which can
 * only be derived from a durable, reviewed identity (never an array position).
 * Migration refuses physical-ID collisions, missing raw record data, and
 * unremapped links rather than guessing which object a legacy hash refers to.
 */
export function planPhysicalIdMigration({collectionKey, inventory, identities, existingIds = [], verifiedReembed = false} = {}) {
    if (!parseCollectionKey(collectionKey)) return {status:'blocked',reason:'invalid-collection-key'};
    if (!inventoryProof(inventory, collectionKey)) return {status:'blocked',reason:'complete-scoped-inventory-required'};
    if (!Array.isArray(identities) || identities.length !== inventory.records.length)
        return {status:'blocked',reason:'one-identity-per-record-required'};
    if (!Array.isArray(existingIds) || !existingIds.every(validId)) return {status:'blocked',reason:'invalid-existing-ids'};
    const index = new Map(inventory.records.map(r=>[asKey(r.recordId),r]));
    const map = new Map(), targets = new Map();
    for (const identity of identities) {
        if (!identity || !validId(identity.oldId) || typeof identity.localId !== 'string' || !identity.localId.length ||
            !index.has(asKey(identity.oldId)) || map.has(asKey(identity.oldId)))
            return {status:'blocked',reason:'missing-or-ambiguous-record-identity'};
        if (identity.verified !== true) return {status:'blocked',reason:'record-identity-not-verified'};
        let next;
        try {next = recordId(collectionKey, identity.localId);} catch (_) {return {status:'blocked',reason:'invalid-local-id'};}
        if (targets.has(next) && targets.get(next)!==asKey(identity.oldId))
            return {status:'blocked',reason:'new-record-id-collision'};
        map.set(asKey(identity.oldId),next);targets.set(next,asKey(identity.oldId));
    }
    if (map.size !== index.size) return {status:'blocked',reason:'incomplete-identity-map'};
    const oldIds = new Set(index.keys()), reserved = new Set(existingIds.map(asKey));
    for (const [oldId,next] of map) {
        // A new ID must never overwrite another *existing* record before that
        // record's own replacement is verified (the upsert is not atomic).
        if (oldIds.has(next) && next!==oldId)
            return {status:'blocked',reason:'target-id-overlaps-other-source'};
        if (reserved.has(next) && next!==oldId && !oldIds.has(next))
            return {status:'blocked',reason:'target-id-exists-outside-migration'};
    }
    const changes = [], blocked = [];
    for (const row of inventory.records) {
        const oldId=asKey(row.recordId), next=map.get(oldId);
        if (typeof row.text !== 'string' || !row.metadata || typeof row.metadata !== 'object' || Array.isArray(row.metadata)) {
            blocked.push({oldId,reason:'raw-record-or-metadata-missing'});continue;
        }
        // Without the original vector a server must prove an exactly compatible
        // embedding/re-embed contract. Silent model changes are not acceptable.
        if (!verifiedReembed && (!Array.isArray(row.vector) || !row.vector.length ||
            row.vector.some(x=>typeof x!=='number'||!Number.isFinite(x)))) {
            blocked.push({oldId,reason:'original-vector-or-verified-reembed-required'});continue;
        }
        const mapped=remapReferences(row.metadata,map,{requireMapped:true});
        if (mapped.status!=='ready') {blocked.push({oldId,reason:'unmapped-reference',ids:mapped.unresolved});continue;}
        const metadata={...mapped.metadata,recordId:next,collectionKey};
        changes.push({oldId,newId:next,textFingerprint:fingerprint(row.text),metadataFingerprint:fingerprint(metadata),
            unchanged:oldId===next && fingerprint(row.metadata)===fingerprint(metadata),metadata});
    }
    if (blocked.length) return {status:'blocked',reason:'unresolved-records',blocked};
    return {status:'ready',version:1,collectionKey,expectedCount:inventory.expectedCount,
        inventoryFingerprint:fingerprint(inventory.records.map(x=>({id:asKey(x.recordId),text:x.text,metadata:x.metadata}))),
        changes,requiresVerifiedServerContracts:true};
}
/**
 * Explicit C02 handoff. No direct writes are made here. Replace callback is
 * expected to use the durable C02 journal; it must return verified commit
 * proof. Production callers must not opt in without pinned server contracts.
 */
export async function applyPhysicalIdMigration(plan, {approved=false, verifiedContracts=false, currentInventory,
        replaceRecords} = {}) {
    if (plan?.status!=='ready' || !approved || !verifiedContracts || typeof replaceRecords!=='function')
        return {status:'blocked',reason:'approval-and-verified-contracts-required'};
    if (!inventoryProof(currentInventory,plan.collectionKey) ||
        fingerprint(currentInventory.records.map(x=>({id:asKey(x.recordId),text:x.text,metadata:x.metadata})))!==plan.inventoryFingerprint)
        return {status:'blocked',reason:'inventory-changed-since-review'};
    // A single C02 operation handles the whole remap; never delete old IDs one by one.
    // The coordinator can reject the request when the backend lacks needed proof.
    const items = plan.changes.filter(c=>!c.unchanged).map(c=>{
        const row=currentInventory.records.find(x=>asKey(x.recordId)===c.oldId);
        return {recordId:c.newId,text:row.text,vector:row.vector,metadata:c.metadata};
    });
    const oldIds=plan.changes.filter(c=>!c.unchanged).map(c=>c.oldId);
    if (!items.length) return {status:'unchanged'};
    try {
        const result=await replaceRecords({collectionKey:plan.collectionKey,kind:'physical-id-migration',oldIds,newItems:items});
        if (result?.status!=='committed' || typeof result.operationId!=='string' || !result.operationId ||
            !Array.isArray(result.deletedIds) || result.deletedIds.length!==oldIds.length ||
            new Set(result.deletedIds.map(String)).size!==oldIds.length ||
            oldIds.some(id=>!result.deletedIds.map(String).includes(String(id))))
            return {status:'needs-reconcile',reason:'replacement-not-verified',operationId:result?.operationId};
        return {status:'committed',operationId:result.operationId,migrated:items.length};
    } catch (_) {return {status:'needs-reconcile',reason:'replacement-transport-uncertain'};}
}

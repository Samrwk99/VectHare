/** C01 scoped deletion transaction. Callers supply verified backend adapters and durable persistence. */
import {parseCollectionKey} from './collection-keys.js';
import {withCollectionLock} from './keyed-mutex.js';
import {metadataEvidence} from './c01-inventory.js';

const fail = (status,reason,extra={}) => ({success:false,status,reason,requiresReconciliation:status==='needs-retry',...extra});
const own = (object,key) => Object.prototype.hasOwnProperty.call(object,key);
const verifiedEmpty = (check,key) => check?.scope===key && check?.complete===true && check?.empty===true && check?.status==='confirmed';

/**
 * store = {registry:string[],collections:object,tombstones:object,recordMetadata?:object}.
 * persist(snapshot) MUST confirm durable storage (return true). A debounced save
 * without a durable acknowledgement must return false: no purge may follow it.
 */
export async function deleteCollectionSafely({key,store,persist,inventory,purge,verifyEmpty,contractVerified=false,backup,protectedCollection=false,resume=false}={}) {
    if (!parseCollectionKey(key)) return fail('blocked','invalid-or-unqualified-key');
    return withCollectionLock(key, async()=> {
        if (contractVerified !== true) return fail('blocked','destructive-server-contract-unverified');
        if (!store || !Array.isArray(store.registry) || !store.collections || typeof store.collections!=='object' || !store.tombstones || typeof store.tombstones!=='object')
            return fail('blocked','registry-or-metadata-unavailable');
        if (typeof persist!=='function' || typeof inventory!=='function' || typeof purge!=='function' || typeof verifyEmpty!=='function')
            return fail('blocked','backend-or-durable-persistence-unavailable');
        let tombstone=store.tombstones[key];
        if (tombstone && tombstone.status!=='deleting') return fail('blocked','unexpected-tombstone-state');
        if (tombstone && resume!==true) return fail('needs-retry','pending-tombstone-requires-recovery');
        if (!tombstone) {
            if (!store.registry.includes(key)) return fail('blocked','registry-ownership-unverified');
            const metadata=metadataEvidence(store.collections,key);
            if (metadata.status!=='available' || !metadata.exists) return fail('blocked','collection-metadata-missing');
            // Do not permit ambiguous legacy/other-backend identity to stand in for evidence.
            const list=await inventory(key);
            if (list?.status!=='complete' || list?.complete!==true || list?.scope!==key || list?.endOfListConfirmed!==true)
                return fail('blocked','authoritative-inventory-incomplete');
            if (protectedCollection) {
                if (typeof backup!=='function') return fail('blocked','protected-collection-requires-export');
                let receipt;
                try { receipt=await backup(key); } catch (_) {return fail('blocked','protected-collection-export-failed');}
                if (receipt?.complete!==true || receipt?.scope!==key || receipt?.verified!==true)
                    return fail('blocked','protected-collection-export-unverified');
            }
            tombstone={status:'deleting',stage:'prepared',collectionKey:key,inventoryCount:list.recordIds?.length ?? null,durable:true,createdAt:new Date().toISOString()};
            store.tombstones[key]=tombstone;
            try { if (await persist(store)!==true) {tombstone.durable=false;return fail('needs-retry','tombstone-durability-unverified');} }
            catch (_) { tombstone.durable=false;return fail('needs-retry','tombstone-persist-failed'); }
            // If persistence returned false, do not let a later in-memory retry
            // treat the marker as a durable recovery checkpoint.
        }
        if (tombstone.durable!==true) return fail('blocked','tombstone-not-durable');
        // On recovery, verify whether a previous purge actually succeeded before
        // submitting a second destructive request. Only a confirmed empty result counts.
        let empty;
        try { empty=await verifyEmpty(key); } catch (_) { empty=null; }
        if (!verifiedEmpty(empty,key)) {
            if (tombstone.stage==='purged') return fail('needs-retry','post-purge-empty-proof-unavailable');
            // An earlier request might have committed with its acknowledgement
            // lost. Never blindly send it twice without confirmed readback.
            if (tombstone.stage==='purge-sent') return fail('needs-retry','prior-purge-uncertain-requires-reconciliation');
            tombstone.stage='purge-sent';
            try { if(await persist(store)!==true) return fail('needs-retry','pre-purge-checkpoint-unverified'); }
            catch (_) {return fail('needs-retry','pre-purge-checkpoint-failed');}
            let ack;
            try { ack=await purge(key); } catch (_) { return fail('needs-retry','purge-failed-or-ack-lost'); }
            if (ack?.status!=='confirmed' || ack?.scope!==key) return fail('needs-retry','purge-ack-unverified');
            try { empty=await verifyEmpty(key); } catch (_) { empty=null; }
            if (!verifiedEmpty(empty,key)) return fail('needs-retry','post-purge-empty-proof-unavailable');
        }
        tombstone.stage='purged';
        try { if(await persist(store)!==true) return fail('needs-retry','purge-checkpoint-durability-unverified'); }
        catch (_) { return fail('needs-retry','purge-checkpoint-persist-failed'); }
        // Scoped metadata is only ever removed by its qualified key. Legacy
        // hash-global metadata is intentionally retained until ownership is migrated.
        const oldMeta=store.collections[key];
        const oldRecords=store.recordMetadata && own(store.recordMetadata,key) ? store.recordMetadata[key] : undefined;
        const oldRegistry=[...store.registry];
        delete store.collections[key];
        if (store.recordMetadata) delete store.recordMetadata[key];
        const registryIndex=store.registry.indexOf(key);
        if (registryIndex>=0) store.registry.splice(registryIndex,1);
        tombstone.stage='finalized';
        try {
            if(await persist(store)!==true) throw Error('durable finalization unverified');
        } catch (_) {
            store.collections[key]=oldMeta;
            if (oldRecords!==undefined) store.recordMetadata[key]=oldRecords;
            store.registry.splice(0,store.registry.length,...oldRegistry);
            tombstone.stage='purged';
            return fail('needs-retry','finalization-persist-failed');
        }
        // Completion receipt is harmless to preserve and prevents a recovered
        // old snapshot from initiating an unqualified second deletion.
        tombstone.status='completed';
        try { await persist(store); } catch (_) { /* finalized receipt kept in memory */ }
        return {success:true,status:'purged-verified',collectionKey:key};
    });
}

/** Startup must surface pending tombstones; no silent retry on unknown contracts. */
export function recoverTombstones(store) {
    const entries=Object.entries(store?.tombstones || {});
    return entries.filter(([_,t])=>t && t.status==='deleting').map(([key,t])=>({key,stage:t.stage,status:'needs-retry'}));
}

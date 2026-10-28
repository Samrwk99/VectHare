import {fingerprint} from './record-identity.js';
/**
 * C02 journal-backed replacement and retry reconciliation.
 * Backend callbacks must return verified scoped evidence, not HTTP 200 alone.
 * No payload text or vectors are written to the journal.
 */
import { withCollectionLock } from './keyed-mutex.js';
import { createIndexedDBOperationJournal, makeHeader, verifiedIds } from './c02-operation-journal.js';
const phases=new Set(['staged','verified','committed','needs-reconcile']);
function uncertain(header, reason, extras={}) {return {status:'needs-reconcile',operationId:header.operationId,collectionKey:header.collectionKey,reason,...extras};}
function contentDigests(items){return items.map(item=>fingerprint({recordId:item?.recordId??item?.hash??item?.id,text:item?.text,index:item?.index,metadata:item?.metadata,vector:item?.vector}));}
function contentIds(items){if(!Array.isArray(items))throw new Error('Replacement items must be an array');return verifiedIds(items.map(i=>i?.recordId??i?.hash??i?.id),{allowEmpty:true});}
function asEvidence(data, key, requested) {
    if(data?.scope!==key || data?.complete!==true || data?.contractVerified!==true || !Array.isArray(data?.recordIds) || data.endOfListConfirmed!==true) return null;
    let ids;try{ids=verifiedIds(data.recordIds);}catch(_){return null;}
    const present=new Set(ids);
    return {present,missing:requested.filter(id=>!present.has(id))};
}
function errorReason(e) {return e?.name==='AbortError'?'aborted-after-dispatch':'write-or-transport-uncertain';}
export function createC02Coordinator({journal=createIndexedDBOperationJournal(),list,upsert,remove,
        canUpsertIdempotently=()=>false,canDelete=()=>false,allowUnverifiedFirstWrite=false, signal, mutationLock=withCollectionLock}={}) {
    if(typeof journal?.create!=='function'||typeof journal?.put!=='function'||typeof journal?.list!=='function'||typeof journal?.get!=='function')throw new Error('Journal required');
    async function checkpoint(header,phase,reason='none',confirmedIds=header.confirmedIds){
        const updated={...header,phase,reason,confirmedIds,updatedAt:Math.max(Date.now(),header.updatedAt)};
        await journal.put(updated);return updated;
    }
    async function evidence(header){if(typeof list!=='function')return null;
        try{return asEvidence(await list(header.collectionKey),header.collectionKey,header.newIds);}catch(_){return null;}}
    async function reconcileInternal(header){
        const proof=await evidence(header);
        if(!proof){header=await checkpoint(header,'needs-reconcile','inventory-unverified');return uncertain(header,'inventory-unverified');}
        header=await checkpoint(header,header.phase==='committed'?'committed':'needs-reconcile','reconciled-inventory',header.newIds.filter(id=>proof.present.has(id)));
        if(proof.missing.length)return uncertain(header,'missing-records',{missingIds:proof.missing});
        if(header.phase!=='verified')header=await checkpoint(header,'verified','verified-present');
        return {status:'verified',operationId:header.operationId,header};
    }
    async function finish(header){
        if(header.phase!=='verified')return uncertain(header,'unverified-replacement');
        const newIds=new Set(header.newIds);
        const toDelete=header.oldIds.filter(id=>!newIds.has(id));
        if(toDelete.length){
            if(typeof remove!=='function'||canDelete(header.collectionKey)!==true){header=await checkpoint(header,'needs-reconcile','delete-contract-unverified');return uncertain(header,'delete-contract-unverified',{preservedOldIds:toDelete});}
            let result;try{result=await remove(header.collectionKey,toDelete,{operationId:header.operationId,signal});}catch(_){header=await checkpoint(header,'needs-reconcile','delete-uncertain');return uncertain(header,'delete-uncertain',{preservedOldIds:toDelete});}
            if(result?.status!=='confirmed'||result.collectionKey!==header.collectionKey||result.count!==toDelete.length){header=await checkpoint(header,'needs-reconcile','delete-ack-unverified');return uncertain(header,'delete-ack-unverified',{preservedOldIds:toDelete});}
            // Confirmation is not complete until scoped post-delete evidence is known.
            if(typeof list!=='function'){header=await checkpoint(header,'needs-reconcile','post-delete-inventory-unverified');return uncertain(header,'post-delete-inventory-unverified');}
            let after;try{after=asEvidence(await list(header.collectionKey),header.collectionKey,header.newIds);}catch(_){after=null;}
            if(!after||header.newIds.some(id=>!after.present.has(id))||toDelete.some(id=>after.present.has(id))){header=await checkpoint(header,'needs-reconcile','post-delete-unverified');return uncertain(header,'post-delete-unverified');}
        }
        header=await checkpoint(header,'committed','verified-commit');return {status:'committed',operationId:header.operationId,deletedIds:toDelete};
    }
    async function replaceRecords({collectionKey,kind='replace',oldIds=[],newItems=[],signal:localSignal=signal}={}){
        // Do not acquire the same lock again in callbacks: adapter caller handles its transport.
        return mutationLock(collectionKey,async()=>{
            if(localSignal?.aborted) return {status:'cancelled',reason:'not-sent'};
            const ids=contentIds(newItems),previous=verifiedIds(oldIds);
            if(previous.length && !ids.length)throw new Error('Destructive empty replacement is forbidden');
            // Refuse to start a new indistinguishable operation while an older
            // write to the same IDs is unresolved. Never retry an uncertain
            // network write under a fresh operation ID.
            const unresolved=(await journal.list()).filter(h=>h.phase!=='committed'&&h.collectionKey===collectionKey);
            if(unresolved.some(h=>h.newIds.some(id=>ids.includes(id)) || h.oldIds.some(id=>previous.includes(id))))
                return {status:'needs-reconcile',reason:'prior-operation-unresolved',operationIds:unresolved.map(h=>h.operationId)};
            const header=await journal.create(makeHeader({collectionKey,kind,oldIds:previous,newIds:ids,newDigests:contentDigests(newItems)}));
            let current=header;
            if(localSignal?.aborted){current=await checkpoint(current,'needs-reconcile','cancelled-before-dispatch');return uncertain(current,'cancelled-before-dispatch');}
            const first=await evidence(current);
            let missing=first?.missing || ids;
            if(missing.length){
                if(typeof upsert!=='function' || (first===null && canUpsertIdempotently(collectionKey)!==true && allowUnverifiedFirstWrite!==true)){
                    current=await checkpoint(current,'needs-reconcile','unsafe-unverified-upsert');return uncertain(current,'unsafe-unverified-upsert',{missingIds:missing});
                }
                const missingSet=new Set(missing),items=newItems.filter(i=>missingSet.has(String(i.recordId??i.hash??i.id)));
                try {await upsert(collectionKey,items,{operationId:header.operationId,signal:localSignal});}
                catch(e){
                    // A lost acknowledgement may follow a successful commit.
                    // Read back once; never resend the same write blindly.
                    const recovered=await reconcileInternal(current);
                    if(recovered.status==='verified')return finish(recovered.header);
                    return {...recovered,writeReason:errorReason(e)};
                }
            }
            if(localSignal?.aborted){current=await checkpoint(current,'needs-reconcile','aborted-after-dispatch');return uncertain(current,'aborted-after-dispatch');}
            const result=await reconcileInternal(current);
            if(result.status!=='verified')return result;
            return finish(result.header);
        },{signal:localSignal});
    }
    async function reconcileBatch(id){const header=await journal.get(id);if(!header)throw new Error('C02 operation not found');
        return mutationLock(header.collectionKey,async()=>{
            if(header.phase==='committed')return {status:'committed',operationId:id};
            const result=await reconcileInternal(header);
            if(result.status!=='verified')return result;
            // Recovery never issues a blind delete; only non-destructive import
            // commits without a new server operation. Replacement requires an
            // explicit resumed user action with an independently proven delete.
            if(header.oldIds.some(id=>!header.newIds.includes(id)))return uncertain(result.header,'manual-delete-reconciliation-required');
            return finish(result.header);
        });
    }
    /** Explicit retry with the original source items, never payloads from the
     * journal. Requires proven idempotent upsert AND a complete scoped list.
     */
    async function resumeMissingRecords(id, newItems, {signal:resumeSignal=signal}={}) {
        const original=await journal.get(id);
        if(!original)throw new Error('C02 operation not found');
        return mutationLock(original.collectionKey,async()=>{
            let header=await journal.get(id);
            if(header.phase==='committed')return {status:'committed',operationId:id};
            if(canUpsertIdempotently(header.collectionKey)!==true)return uncertain(header,'idempotency-contract-unverified');
            const ids=contentIds(newItems);
            if(ids.length!==header.newIds.length || ids.some((item,index)=>item!==header.newIds[index]) ||
                header.newDigests?.length!==ids.length || contentDigests(newItems).some((digest,index)=>digest!==header.newDigests[index]))
                return uncertain(header,'source-records-differ');
            const prior=await evidence(header);
            if(!prior){header=await checkpoint(header,'needs-reconcile','inventory-unverified');return uncertain(header,'inventory-unverified');}
            const missing=new Set(prior.missing);
            if(missing.size){
                if(typeof upsert!=='function')return uncertain(header,'upsert-unavailable');
                if(resumeSignal?.aborted)return uncertain(header,'cancelled-before-dispatch');
                try{await upsert(header.collectionKey,newItems.filter(item=>missing.has(String(item.recordId??item.hash??item.id))),{operationId:id,signal:resumeSignal});}
                catch(_){const again=await reconcileInternal(header);if(again.status==='verified')return finish(again.header);return again;}
            }
            const result=await reconcileInternal(header);
            return result.status==='verified' ? finish(result.header) : result;
        },{signal:resumeSignal});
    }
    async function recoverPendingOps(){
        const headers=await journal.list();const results=[];
        for(const h of headers){if(h.phase==='committed')continue;try{results.push(await reconcileBatch(h.operationId));}catch(_){results.push(uncertain(h,'journal-recovery-failed'));}}
        return results;
    }
    return {replaceRecords,reconcileBatch,resumeMissingRecords,recoverPendingOps,listPending:async()=> (await journal.list()).filter(h=>h.phase!=='committed')};
}

import { withCollectionLock } from './keyed-mutex.js';
import { requireConfirmedDeleteAck } from './backend-operation-validation.js';
import {beginOperation,settleOperation} from './operation-outcomes.js';
/** Old and new hashes are normalized to strings to prevent 123 !== '123' loss. */
export function planReplacement(oldItems,newItems) {
    const id = item => String(item?.hash ?? item?.id ?? item);
    const old = [...new Set(oldItems.map(id))];
    const current = new Set(newItems.map(id));
    return {toUpsert:[...newItems],toDelete:old.filter(x=>!current.has(x)), oldIds:old, newIds:[...current]};
}
/** Callers must supply authoritative inserted-ID proof; a thrown or ambiguous write never deletes. */
export async function applyVerifiedReplacement({key,oldItems,newItems,insert,verify,remove,signal}) {
    return withCollectionLock(key,async()=>{
        const plan=planReplacement(oldItems,newItems);
        const operation=beginOperation('replace',key);
        if(signal?.aborted) {settleOperation(operation,{status:'failed',reason:'not-sent'});return {status:'failed',deleted:[],operationId:operation.operationId};}
        let insertion;
        try {insertion=await insert(plan.toUpsert);} catch(_) {settleOperation(operation,{status:'uncertain',reason:'transport-after-send'});return {status:'uncertain',deleted:[],requiresReconciliation:true,operationId:operation.operationId};}
        if(insertion?.status!=='confirmed') {settleOperation(operation,{status:'uncertain',reason:'missing-acknowledgement'});return {status:'uncertain',deleted:[],requiresReconciliation:true,operationId:operation.operationId};}
        let verified;
        try {verified=await verify(plan.newIds);}catch(_){ verified=null; }
        if(!verified || verified.complete!==true || !Array.isArray(verified.ids)) {settleOperation(operation,{status:'uncertain',reason:'missing-acknowledgement'});return {status:'uncertain',deleted:[],requiresReconciliation:true,operationId:operation.operationId};}
        const present=new Set(verified.ids.map(String));
        if(plan.newIds.some(x=>!present.has(x))) {settleOperation(operation,{status:'uncertain',reason:'partial-ack'});return {status:'uncertain',deleted:[],requiresReconciliation:true,operationId:operation.operationId};}
        if(signal?.aborted) {settleOperation(operation,{status:'uncertain',reason:'transport-after-send'});return {status:'uncertain',deleted:[],requiresReconciliation:true,operationId:operation.operationId};}
        if(!plan.toDelete.length) {settleOperation(operation,{status:'confirmed',reason:'verified-success'});return {status:'confirmed',deleted:[],operationId:operation.operationId};}
        try {requireConfirmedDeleteAck(await remove(plan.toDelete));}
        catch(_) {settleOperation(operation,{status:'uncertain',reason:'transport-after-send'});return {status:'uncertain',deleted:[],requiresReconciliation:true,operationId:operation.operationId};}
        settleOperation(operation,{status:'confirmed',reason:'verified-success'});
        return {status:'confirmed',deleted:plan.toDelete,operationId:operation.operationId};
    },{signal});
}

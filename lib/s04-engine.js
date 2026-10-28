/** S04 internal-only mutation coordinator.
 * NO production backend adapters are wired; host route cannot execute this.
 * An authoritative host-owned authorize callback and independently verified
 * backend adapter must be supplied by future backend checkpoints. */
import {createHash} from 'node:crypto';
import {OperationError,verifyMutationReadback,planMutation} from './s04-contract.js';
const sha=x=>createHash('sha256').update(x).digest('hex');
function sameOwner(plan,item) {
    return item && item.recordId===plan.recordId && item.physicalId===plan.physicalId &&
        item.scope?.userScopeId===plan.scope.userScopeId && item.scope?.collectionId===plan.scope.collectionId &&
        item.scope?.type===plan.scope.type && item.scope?.sourceId===plan.scope.sourceId &&
        (item.scope?.branchId??null)===(plan.scope.branchId??null);
}
function boundPayload(plan,payload){
    if(plan.action==='delete') return payload===null || payload===undefined;
    if (Object.keys(payload || {}).some(key=>!['text','vector','metadata'].includes(key))) return false;
    if(!payload || typeof payload!=='object') return false;
    if(plan.textHash!==null && (typeof payload.text!=='string' || sha(Buffer.from(payload.text,'utf8'))!==plan.textHash)) return false;
    if(plan.vectorHash!==null && (!Array.isArray(payload.vector)||sha(JSON.stringify(payload.vector))!==plan.vectorHash)) return false;
    if(plan.metadataHash!==null && (!payload.metadata || sha(JSON.stringify(payload.metadata))!==plan.metadataHash)) return false;
    return true;
}
export class MutationEngine {
    constructor({ledger,adapter,authorize}) {
        if(!ledger || typeof ledger.withCollectionLock!=='function' || !adapter || typeof authorize!=='function' || !['getRecord','insertRecord','updateRecord','deleteRecord'].every(k=>typeof adapter[k]==='function')) {
            throw new OperationError('S04_ADAPTER_UNVERIFIED','Trusted ledger, backend contract and authorization callback required');
        }
        this.ledger=ledger;this.adapter=adapter;this.authorize=authorize;
    }
    async authorized(plan) {
        // Future host adapter must independently attest source ownership, deployed
        // backend build, scope, schema and operation. S02 reservations do not.
        const result=await this.authorize(plan);
        if(result?.authorized!==true || result?.ownerVerified!==true || result?.mutationContractVerified!==true ||
           result?.collectionKey!==plan.collectionKey || result?.backend!==plan.backend) {
            throw new OperationError('S04_AUTHORIZATION_NOT_ATTESTED','Backend scope and mutation contract not authoritatively verified');
        }
    }
    async execute(plan,payload) {
        if(plan?.schemaVersion!==4 || plan?.scope?.userScopeId!==this.ledger.context.userScopeId ||
            plan?.authorized!==false || plan?.executionAllowed!==false || !boundPayload(plan,payload)) {
            throw new OperationError('S04_PLAN_INVALID','Invalid or mismatched mutation plan/payload');
        }
        // Re-derive the full plan from trusted user context and the actual
        // supplied payload. This prevents forged physical IDs or revisions.
        try {
            const computed=planMutation(this.ledger.context,{backend:plan.backend,scope:plan.scope,embedding:plan.embedding,
                action:plan.action,recordId:plan.recordId,operationId:plan.operationId,
                expectedRevision:plan.expectedRevision,...(payload || {})});
            if(JSON.stringify(computed)!==JSON.stringify(plan)) throw new Error('plan mismatch');
        } catch { throw new OperationError('S04_PLAN_INVALID','Mutation plan does not match validated scope/payload'); }
        await this.authorized(plan);
        return this.ledger.withCollectionLock(plan,()=>this.ledger.withRecordLock(plan,async()=>{
            await this.ledger.writeNew(plan); // UUID replay must fail, never re-execute.
            let original;
            try {
                original=await this.adapter.getRecord(plan);
                if (plan.action==='insert') {
                    if(original!==null) throw new OperationError('S04_RECORD_EXISTS','Record already exists');
                } else if(!sameOwner(plan,original)||original.revision!==plan.expectedRevision) {
                    throw new OperationError('S04_REVISION_OR_OWNER_MISMATCH','Missing, mismatched owner or stale revision');
                }
            } catch(error) {
                await this.ledger.advance(plan.operationId,'FAILED',{code:error.code||'S04_PREFLIGHT_ERROR'});
                throw error;
            }
            // Persist SUBMITTED *before* dispatch; a crash thereafter is uncertain.
            await this.ledger.advance(plan.operationId,'SUBMITTED');
            try {
                switch(plan.action) {
                    case 'insert': await this.adapter.insertRecord(plan,payload);break;
                    case 'delete': await this.adapter.deleteRecord(plan);break;
                    default: await this.adapter.updateRecord(plan,payload);break;
                }
            } catch(error) {
                await this.ledger.advance(plan.operationId,'UNCERTAIN',{code:error.code||'S04_BACKEND_ERROR'});
                return {state:'UNCERTAIN',operationId:plan.operationId};
            }
            return this._reconcileUnderLock(plan.operationId,{expectedVector:payload?.vector??null});
        }));
    }
    async reconcile(operationId,{expectedVector=null}={}) {
        const receipt=await this.ledger.read(operationId);
        return this.ledger.withCollectionLock(receipt.plan,()=>this._reconcileUnderLock(operationId,{expectedVector}));
    }
    async _reconcileUnderLock(operationId,{expectedVector=null}={}) {
        const receipt=await this.ledger.read(operationId);
        const plan=receipt.plan;
        if(!['SUBMITTED','UNCERTAIN'].includes(receipt.state)) {
            return {state:receipt.state,operationId};
        }
        await this.authorized(plan);
        try {
            const actual=await this.adapter.getRecord(plan);
            const verification=verifyMutationReadback(plan,actual,{expectedVector});
            if(verification.verified) {
                await this.ledger.advance(operationId,'VERIFIED');
                return {state:'VERIFIED',operationId};
            }
            if(receipt.state==='SUBMITTED') await this.ledger.advance(operationId,'UNCERTAIN',{code:'S04_READBACK_UNVERIFIED'});
            return {state:'UNCERTAIN',operationId,reason:verification.reason};
        }catch(error){
            if(receipt.state==='SUBMITTED') await this.ledger.advance(operationId,'UNCERTAIN',{code:'S04_READBACK_ERROR'});
            return {state:'UNCERTAIN',operationId};
        }
    }
}

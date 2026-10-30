/** S04 internal-only mutation coordinator.
 * NO production backend adapters are wired; host route cannot execute this.
 * An authoritative host-owned authorize callback and independently verified
 * backend adapter must be supplied by future backend checkpoints. */
import {createHash} from 'node:crypto';
import {OperationError,verifyMutationReadback,planMutation} from './s04-contract.js';
import {compareStoredVector} from './f03-vector-evidence.js';
import {runtimeWriterBoundary} from './f09c10-runtime-boundary.js';
const sha=x=>createHash('sha256').update(x).digest('hex');
// Non-exported, process-local proof that this invocation received an atomic ACK.
// A recovered receipt or external caller cannot synthesize it.
const ACK_THIS_INVOCATION=Symbol('F09C2_ATOMIC_ACK');
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
    constructor({ledger,adapter,authorize,atomicOnly=true,writerBoundary=null,trustedBinding=null,assertFreshBinding=null}) {
        if(!ledger || typeof ledger.withCollectionLock!=='function' || !adapter || typeof authorize!=='function' || !['getRecord','insertRecord','updateRecord','deleteRecord'].every(k=>typeof adapter[k]==='function')) {
            throw new OperationError('S04_ADAPTER_UNVERIFIED','Trusted ledger, backend contract and authorization callback required');
        }
        // F09c fail-closed default: uncertified adapters cannot mutate unless
        // the caller explicitly opts into a restricted development pilot.
        // A method name alone proves nothing: independent backend/deployment
        // attestation must establish that comparison and mutation are ONE atomic
        // server operation, including against nonparticipating external writers.
        if(typeof atomicOnly!=='boolean') throw new OperationError('F09C_ATOMIC_MODE_INVALID','Atomic policy must be explicit');
        if(writerBoundary!==null && typeof writerBoundary?.withWriteBoundary!=='function')
            throw new OperationError('F09C5_BOUNDARY_INVALID','Trusted writer boundary contract required');
        this.ledger=ledger;this.adapter=adapter;this.authorize=authorize;this.atomicOnly=atomicOnly;
        this.writerBoundary=writerBoundary;
        this.trustedBinding=trustedBinding;this.assertFreshBinding=assertFreshBinding;
    }
    async authorized(plan) {
        // Future host adapter must independently attest source ownership, deployed
        // backend build, scope, schema and operation. S02 reservations do not.
        const result=await this.authorize(plan);
        if(result?.authorized!==true || result?.ownerVerified!==true || result?.mutationContractVerified!==true ||
           result?.collectionKey!==plan.collectionKey || result?.backend!==plan.backend ||
           (this.atomicOnly && (result?.atomicBackendCertified!==true || result?.externalWriterScopeAttested!==true))) {
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
                expectedRevision:plan.expectedRevision,...(payload || {})},
                {trustedBinding:this.trustedBinding});
            if(JSON.stringify(computed)!==JSON.stringify(plan)) throw new Error('plan mismatch');
        } catch { throw new OperationError('S04_PLAN_INVALID','Mutation plan does not match validated scope/payload'); }
        // Fail *before creating a durable intent* when the backend has no
        // independently certified compare-and-mutate transport. Never fall
        // back to check-then-write or silently replay on errors.
        if(plan.routingGeneration!==undefined && (typeof this.assertFreshBinding!=='function'||
           this.trustedBinding?.collection?.generation!==plan.routingGeneration))
            throw new OperationError('M3_FRESH_BINDING_FENCE_REQUIRED','Versioned mutation requires a fresh journal fence');
        if(this.atomicOnly && typeof this.adapter.atomicCompareAndMutate!=='function')
            throw new OperationError('F09C_ATOMIC_BACKEND_UNAVAILABLE','Atomic backend mutation is not available');
        await this.authorized(plan);
        // Optional F09c.5 cooperating-writer lock encloses preflight, durable
        // intent, dispatch and readback. It is never an independent permission
        // grant: external writers and legacy direct backend paths remain unbound.
        let submitted=false; // Only a durable SUBMITTED receipt makes a failed call potentially unsafe to retry.
        const executeUnderLedger=()=>this.ledger.withCollectionLock(plan,()=>this.ledger.withRecordLock(plan,async()=>{
            if(plan.routingGeneration!==undefined)await this.assertFreshBinding(this.trustedBinding);
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
            // Metadata updates must retain the original text and physical vector.
            // Capture independently read original evidence before dispatch; if a
            // crash loses it, reconciliation MUST stay UNCERTAIN, not presume a
            // backend-reported hash is sufficient evidence of preservation.
            const originalVector=original?.vectorReference??original?.vector;
            if(plan.action==='metadata' && (!Array.isArray(originalVector) ||
                typeof original?.vectorHash!=='string'||typeof original?.textHash!=='string')){
                await this.ledger.advance(plan.operationId,'FAILED',{code:'F04_ORIGINAL_VECTOR_EVIDENCE_MISSING'});
                throw new OperationError('F04_ORIGINAL_VECTOR_EVIDENCE_MISSING','Preserved vector cannot be verified');
            }
            const expectedPreserved=plan.action==='metadata'?{
                vector:originalVector,vectorHash:original.vectorHash,textHash:original.textHash}:null;
            // Persist SUBMITTED *before* dispatch; a crash thereafter is uncertain.
            if(plan.routingGeneration!==undefined)await this.assertFreshBinding(this.trustedBinding);
            await this.ledger.advance(plan.operationId,'SUBMITTED');
            submitted=true;
            try {
                if(this.atomicOnly){
                    // The adapter must atomically check absent-on-insert or
                    // exact owner + expected revision on update/delete, then
                    // apply the mutation. A conditional read before dispatch
                    // is not sufficient. Conflicts remain UNCERTAIN (no retry).
                    const result=await this.adapter.atomicCompareAndMutate(plan,payload);
                    if(result?.applied!==true || result?.conflict===true)
                        throw new OperationError('F09C_ATOMIC_CONFLICT_OR_UNVERIFIED','Atomic apply not proven');
                }else{
                    switch(plan.action) {
                        case 'insert': await this.adapter.insertRecord(plan,payload);break;
                        case 'delete': await this.adapter.deleteRecord(plan);break;
                        default: await this.adapter.updateRecord(plan,payload);break;
                    }
                }
            } catch(error) {
                await this.ledger.advance(plan.operationId,'UNCERTAIN',{code:error.code||'S04_BACKEND_ERROR'});
                return {state:'UNCERTAIN',operationId:plan.operationId};
            }
            return this._reconcileUnderLock(plan.operationId,{expectedVector:payload?.vector??null,expectedPreserved,
                // In-process evidence only: the atomic call returned applied:true
                // during this exact execution. Never persist/reconstruct this flag.
                atomicDispatchAcknowledged:this.atomicOnly?ACK_THIS_INVOCATION:null});
        }));
        // ALL normal non-atomic S04 paths must participate in the same trusted
        // physical-collection boundary. Explicit boundaries remain available
        // only for administrator-controlled disposable diagnostics/tests.
        const boundary=this.writerBoundary ?? await runtimeWriterBoundary(this.ledger.context,plan);
        let preDispatchError=null;
        const outcome=await boundary.withWriteBoundary(plan,async()=>{
            try{return await executeUnderLedger();}
            catch(error){
                // A failure before SUBMITTED cannot have dispatched a backend
                // mutation: release the gate rather than permanently blocking
                // the collection for a stale revision or denied operation.
                // Failures after SUBMITTED retain the gate for investigation.
                if(!submitted) {preDispatchError=error;return {state:'FAILED'};}
                throw error;
            }
        });
        if(preDispatchError)throw preDispatchError;
        return outcome;
    }
    async reconcile(operationId,{expectedVector=null}={}) {
        const receipt=await this.ledger.read(operationId);
        return this.ledger.withCollectionLock(receipt.plan,()=>this._reconcileUnderLock(operationId,{expectedVector}));
    }
    async _reconcileUnderLock(operationId,{expectedVector=null,expectedPreserved=null,atomicDispatchAcknowledged=false}={}) {
        const receipt=await this.ledger.read(operationId);
        const plan=receipt.plan;
        if(!['SUBMITTED','UNCERTAIN'].includes(receipt.state)) {
            return {state:receipt.state,operationId};
        }
        // Atomic-only execution is intentionally not a crash-recovery protocol.
        // A delayed read cannot prove an acknowledged CAS happened after a
        // timeout, nor that a nonparticipating writer was absent meanwhile.
        // Never promote an uncertain atomic operation by physical readback.
        if(this.atomicOnly && (receipt.state==='UNCERTAIN' ||
            (receipt.state==='SUBMITTED' && atomicDispatchAcknowledged!==ACK_THIS_INVOCATION)))
            return {state:receipt.state,operationId,reason:'F09C_MANUAL_RECOVERY_REQUIRED'};
        // A cutover after dispatch invalidates the old physical target for
        // reconciliation too. Never promote a stale generation to VERIFIED.
        if(plan.routingGeneration!==undefined){
            if(typeof this.assertFreshBinding!=='function'||
               this.trustedBinding?.collection?.generation!==plan.routingGeneration)
                return {state:receipt.state,operationId,reason:'M3_RECONCILIATION_GENERATION_UNVERIFIED'};
            try{await this.assertFreshBinding(this.trustedBinding);}catch{
                return {state:receipt.state,operationId,reason:'M3_RECONCILIATION_GENERATION_STALE'};
            }
        }
        await this.authorized(plan);
        try {
            const actual=await this.adapter.getRecord(plan);
            const verification=verifyMutationReadback(plan,actual,{expectedVector});
            if(verification.verified && plan.action==='metadata'){
                const preserved=expectedPreserved;
                const evidence=preserved && compareStoredVector({backend:plan.backend,
                    metric:plan.embedding.metric,expected:preserved.vector,actual:actual?.vector,
                    dimension:plan.embedding.dimension,expectedHash:preserved.vectorHash});
                if(!preserved || actual?.textHash!==preserved.textHash ||
                    actual?.vectorHash!==preserved.vectorHash || evidence?.verified!==true){
                    verification.verified=false;
                    verification.reason='F04_PRESERVED_CONTENT_UNVERIFIED';
                }
            }
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

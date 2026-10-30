/** M3v13 cross-operation read-only adjudication intake.
 * An audit checkpoint is not physical proof; only independent re-observation
 * may classify a terminal operation as proven applied. In particular a
 * missing target, timeout or partial inventory NEVER proves NOT_APPLIED.
 * No HTTP field grants a replay or retained-lock release.
 */
import {createHash} from 'node:crypto';
import {M3Store,m3LedgerCheckpoint} from './m3-collections.js';
import {inspectM3LifecycleRecovery} from './m3-execution-audit.js';
import {inspectM3PhysicalProgress} from './m3-physical-progress.js';
import {inspectM3RebuildStage} from './m3-rebuild-stage.js';
import {inspectM3TerminalProof} from './m3-terminal-resolution.js';
import {M2JobStore} from './m2-jobs.js';
import {M3CutoverJournal} from './m3-cutover-journal.js';
import {verifyM3TargetReceipt} from './m3-target-receipts.js';
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const error=code=>Object.assign(new Error(code),{code,status:409});
function admin(req){if(!req?.s03?.userScopeId||!req.user?.directories||
  (req.user?.admin!==true&&req.user?.profile?.admin!==true))throw error('M3_GENERAL_REVIEW_ADMIN_REQUIRED');return req.s03;}
export async function inspectM3GeneralReconciliation(req,id,deps={}){
 const ctx=admin(req);if(!UUID.test(id??''))throw error('M3_GENERAL_REVIEW_OPERATION_INVALID');
 const store=deps.store?.(ctx)??new M3Store(ctx),ticket=await store.read('operation',id);
 if(ticket.owner!==ctx.userScopeId||ticket.backend!=='qdrant')throw error('M3_GENERAL_REVIEW_OWNER_INVALID');
 const audit=await (deps.inspectAudit??inspectM3LifecycleRecovery)(ctx,id,{store});
 let jobExclusionVerified=false;
 try{await (deps.jobs?.(ctx)??new M2JobStore(ctx)).assertNoLease(ticket.logicalKey);jobExclusionVerified=true;}
 catch{jobExclusionVerified=false;}
 let ledgerDigest=null;
 try{const checkpoint=await (deps.ledgerCheckpoint??m3LedgerCheckpoint)(ctx,ticket.logicalKey,deps);
  if(/^[0-9a-f]{64}$/.test(checkpoint?.digest??''))ledgerDigest=checkpoint.digest;
 }catch{} // Missing evidence must not get promoted to success.
 let physicalOutcome='NOT_PROVEN',evidenceType=null,physicalFingerprint=null;
 if(audit.claimed&&audit.evidenceComplete&&audit.lastStage==='COMMITTED'&&jobExclusionVerified&&ledgerDigest){
  try{
   if(ticket.action==='delete'){
    const result=await (deps.terminalProof??inspectM3TerminalProof)(req,id,deps);
    if(result?.proofHash&&result.proof?.physicalState==='ABSENT_404'&&result.proof.tombstoneState==='DELETED'){
     physicalOutcome='PROVEN_APPLIED';evidenceType='TERMINAL_DELETE_TOMBSTONE_AND_QDRANT_404';physicalFingerprint=result.proofHash;
    }
   }else if(ticket.action==='rebuild'){
    const result=await (deps.inspectStage??inspectM3RebuildStage)(req,id,deps);
    if(result?.state==='VERIFIED_STAGED'&&result.receiptVerified&&result.physicalVerified&&result.registryVerified&&result.sourceVerified){
     physicalOutcome='PROVEN_APPLIED';evidenceType='STAGED_TARGET_FULL_READBACK_AND_REGISTRY';physicalFingerprint=digest({logicalKey:result.stagedLogicalKey,count:result.recordCount,operationId:id});
    }
   }else if(ticket.action==='restore'||ticket.action==='empty'){
    const receipt=await store.read('target',id),backup=await store.read('backup',receipt.backupId);
    if(receipt.owner!==ctx.userScopeId||backup.owner!==ctx.userScopeId||receipt.logicalKey!==ticket.logicalKey)
     throw error('M3_GENERAL_REVIEW_RECEIPT_SCOPE_INVALID');
    const journal=deps.journal?.(ctx,ticket.logicalKey)??new M3CutoverJournal(ctx,{backend:'qdrant',logicalKey:ticket.logicalKey});
    const events=await journal.events(),published=events.at(-1);
    if(published?.state!=='PUBLISHED'||published.operationId!==id)throw error('M3_GENERAL_REVIEW_JOURNAL_ADVANCED');
    const transport=deps.transport?await deps.transport(req,ticket):
     (typeof deps.backendPool?.getTrusted==='function'?await deps.backendPool.getTrusted(ctx,'qdrant',ticket.configId):null);
    const active={logicalKey:receipt.logicalKey,physicalName:receipt.physicalName,generation:receipt.generation};
    const proved=await (deps.verifyReceipt??verifyM3TargetReceipt)(ctx,{transport,backup,operationId:id,active});
    if(proved?.receiptVerified===true&&proved.inventoryVerified===true&&proved.schemaVerified===true){
     physicalOutcome='PROVEN_APPLIED';evidenceType='ACTIVE_JOURNAL_AND_FULL_TARGET_READBACK';
     physicalFingerprint=digest({operationId:id,physicalName:receipt.physicalName,inventoryDigest:proved.inventoryDigest});
    }
   }
  }catch{} // Failure to verify does NOT prove NOT_APPLIED.
 }
 let physicalProgress=null;
 if(ticket.action==='rebuild')try{
  const summary=await (deps.physicalProgress??inspectM3PhysicalProgress)(req,id,{store});
  physicalProgress={verifiedChunks:summary.verifiedChunks,verifiedRecordCount:summary.verifiedRecordCount,
   expectedRecordCount:summary.expectedRecordCount};
 }catch{} // A damaged checkpoint must never be treated as a clean stage.
 const core={schemaVersion:1,operationId:id,ownerScopeHash:digest(ctx.userScopeId),action:ticket.action,
  logicalKey:ticket.logicalKey,claimed:audit.claimed,completedAudit:audit.evidenceComplete&&audit.lastStage==='COMMITTED',
  lastAuditStage:audit.lastStage,jobExclusionVerified,ledgerDigest,physicalOutcome,evidenceType,physicalFingerprint,physicalProgress,
  replayAllowed:false,physicalLockReleaseAuthorized:false,notAppliedProven:false};
 return {...core,evidenceHash:digest(core),classification:physicalOutcome==='PROVEN_APPLIED'?'VERIFIED_APPLIED_REVIEW':'REVIEW_REQUIRED',
  validationStatus:'AWAITING_MANUAL_TEST',
  instructions:'Administrator must separately reconcile the original receipt, registry and lock. Never replay a claimed operation or release a retained lock from this report.'};
}

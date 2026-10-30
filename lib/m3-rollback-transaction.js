/** M3f private, lossless rollback of a *pristine* Qdrant restore.
 * This is deliberately NOT an HTTP action or a general-purpose alias switch.
 * A verified divergence from the initial checkpoint requires a later,
 * explicit forward-copy/merge design; never discard post-cutover writes.
 * Lifecycle uncertainty retains the shared logical lock for adjudication.
 */
import {M3ExecutionAudit} from './m3-execution-audit.js';
import {randomUUID,createHash} from 'node:crypto';
import {M3Store,m3LedgerCheckpoint} from './m3-collections.js';
import {M3CutoverJournal} from './m3-cutover-journal.js';
import {withM3LifecycleExclusion} from './m3-logical-exclusion.js';
import {verifyM3PhysicalTarget,issueM3TargetReceipt,resolveM3VerifiedTarget} from './m3-target-receipts.js';
import {m3QdrantSmokeQueries} from './m3-lifecycle-transaction.js';
import {resolveF02Binding} from './f02-public-reads.js';
import {readM1Snapshot} from './m1-saved-records.js';
import {getEmbeddingProfile} from './f09b5-embedding-profiles.js';
import {ManagedChatRegistry} from './f09b4-managed-registry.js';
import {M2JobStore} from './m2-jobs.js';
import {readF03ProvisionReceipt} from './f03-provision.js';
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const KEY=/^[a-f0-9]{64}$/;
const refuse=code=>Object.assign(new Error(code),{code,status:409});
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

async function rollbackContext(req,restoreOperationId,deps){
 if(!UUID.test(restoreOperationId??'')||!req?.s03?.userScopeId||!req.user?.directories)
  throw refuse('M3_ROLLBACK_HOST_AND_RESTORE_ID_REQUIRED');
 const ctx=req.s03,store=deps.store?.(ctx)??new M3Store(ctx);
 const restore=await store.read('operation',restoreOperationId);
 if(restore.action!=='restore'||restore.backend!=='qdrant'||restore.owner!==ctx.userScopeId||
    !KEY.test(restore.logicalKey??''))throw refuse('M3_ROLLBACK_ORIGINAL_OPERATION_UNTRUSTED');
 const backup=await store.read('backup',restore.backupId);
 if(backup.schemaVersion!==1||backup.backend!=='qdrant'||backup.owner!==ctx.userScopeId||
    backup.logicalKey!==restore.logicalKey||backup.physicalName!==restore.physicalName||
    backup.inventory?.complete!==true||backup.inventory?.exclusiveOwner!==true||
    backup.inventory?.digest!==sha(backup.inventory?.rows)||
    backup.savedSourceFingerprint!==restore.sourceFingerprint||
    backup.managed?.fingerprint!==restore.managedFingerprint)
  throw refuse('M3_ROLLBACK_ORIGINAL_BACKUP_INVALID');
 const journal=new M3CutoverJournal(ctx,{logicalKey:restore.logicalKey});
 const events=await journal.events();
 // Initial rollback implementation supports only the first, pristine restore.
 // Never choose a historical target from an arbitrary multi-cutover history.
 if(events.length!==2||events[0]?.state!=='PREPARED'||events[1]?.state!=='PUBLISHED'||
    events[0].operationId!==restoreOperationId||events[1].operationId!==restoreOperationId||
    events[1].from!==backup.physicalName||events[1].backupDigest!==sha(backup))
  throw refuse('M3_ROLLBACK_HISTORY_NOT_SINGLE_RESTORE');
 const bound=await (deps.bind??resolveF02Binding)(req,{backend:'qdrant',source:restore.source,
  embedding:backup.embedding,configId:restore.configId},{reserve:false});
 const canonical=bound?.binding;
 if(canonical?.scope?.userScopeId!==ctx.userScopeId||canonical.scope.sourceId!==backup.sourceId||
  canonical.collection?.key!==restore.logicalKey||canonical.collection.physicalName!==backup.physicalName||
  !same(canonical.embedding,backup.embedding))throw refuse('M3_ROLLBACK_SOURCE_BINDING_CHANGED');
 const active=await journal.resolve(canonical);
 if(active.generation!==1||active.physicalName!==events[1].to||active.physicalName===backup.physicalName)
  throw refuse('M3_ROLLBACK_ACTIVE_GENERATION_CHANGED');
 const transport=deps.transport?await deps.transport(req,restore):
  (typeof deps.backendPool?.getTrusted==='function'?await deps.backendPool.getTrusted(ctx,'qdrant',restore.configId):null);
 if(typeof transport?._request!=='function')throw refuse('M3_ROLLBACK_TRUSTED_TRANSPORT_REQUIRED');
 return {ctx,store,restore,backup,journal,canonical,active,transport};
}

async function attestPristine(req,c,deps,{preparedOperationId=null}={}){
 const {ctx,backup,restore,canonical,active,transport,journal}=c;
 if(preparedOperationId!==null){
  const last=(await journal.events({allowLocked:true})).at(-1);
  if(last?.state!=='PREPARED'||last.operationId!==preparedOperationId||
    last.from!==active.physicalName||last.to!==backup.physicalName)
   throw refuse('M3_ROLLBACK_PREPARE_CHANGED');
 }else{
  const live=await journal.resolve(canonical);
  if(live.generation!==active.generation||live.physicalName!==active.physicalName)
   throw refuse('M3_ROLLBACK_GENERATION_STALE');
 }
 const profile=await (deps.getProfile??getEmbeddingProfile)(ctx);
 if(profile?.configured!==true||!same(profile.profile,backup.embedding))throw refuse('M3_ROLLBACK_EMBEDDING_CHANGED');
 const receipt=await (deps.receipt??readF03ProvisionReceipt)(ctx,canonical);
 if(receipt?.state!=='SCHEMA_VERIFIED_OFFLINE_UNCERTIFIED')throw refuse('M3_ROLLBACK_F03_RECEIPT_INVALID');
 await (deps.jobs?.(ctx)??new M2JobStore(ctx)).assertNoLease(restore.logicalKey);
 await journal.assertNoRetainedPhysicalLocks([active.physicalName,backup.physicalName]);
 const snapshot=await (deps.readSnapshot??readM1Snapshot)(req,restore.source);
 if(snapshot.sourceId!==backup.sourceId||snapshot.fileHash!==backup.savedSourceFingerprint)
  throw refuse('M3_ROLLBACK_SAVED_SOURCE_CHANGED');
 const registry=await (deps.registry?.(ctx,canonical)??new ManagedChatRegistry(ctx,canonical)).read();
 if(registry.fingerprint!==backup.managed.fingerprint)
  throw refuse('M3_ROLLBACK_MANAGED_RECORDS_CHANGED');
 const ledger=await m3LedgerCheckpoint(ctx,restore.logicalKey,deps);
 if(ledger.digest!==backup.operationCheckpoint?.digest)
  throw refuse('M3_ROLLBACK_POST_RESTORE_MUTATIONS');
 // Require BOTH the current switched collection and the retained original to
 // match the backup exactly. No last-write-wins or inferred data loss.
 const [switched,original]=await Promise.all([
  verifyM3PhysicalTarget(transport,backup,active.physicalName),
  verifyM3PhysicalTarget(transport,backup,backup.physicalName)]);
 if(!switched.verified||!original.verified||switched.inventoryDigest!==original.inventoryDigest)
  throw refuse('M3_ROLLBACK_INVENTORY_CHANGED');
 return {switched,original};
}

/** Server-only issuance. No user-supplied physical target or reversible plan.
 * A planning success is NOT a certified public rollback action. */
export async function planM3TrustedRollback(req,restoreOperationId,deps={}){
 const c=await rollbackContext(req,restoreOperationId,deps);
 const {ctx,restore,backup,journal,active}=c;
 await attestPristine(req,c,deps);
 const operationId=randomUUID();
 const ticket={schemaVersion:1,owner:ctx.userScopeId,operationId,action:'rollback',
  backend:'qdrant',restoreOperationId,backupId:backup.backupId,logicalKey:restore.logicalKey,
  source:restore.source,configId:restore.configId,sourceFingerprint:backup.savedSourceFingerprint,
  managedFingerprint:backup.managed.fingerprint,ledgerDigest:backup.operationCheckpoint.digest,
  expectedGeneration:active.generation,expectedPhysicalName:active.physicalName,
  physicalName:backup.physicalName,createdAt:Date.now(),expiresAt:Date.now()+5*60*1000,
  phase:'PLANNED',executionAllowed:false};
 await c.store.write('operation',ticket);
 return {operationId,restoreOperationId,logicalKey:ticket.logicalKey,sourceGeneration:active.generation,
  targetGeneration:active.generation+1,recordCount:backup.inventory.count,
  executionAllowed:false,productionCertified:false};
}

/** A single-use journal transition without any physical deletion. Rejects
 * mutated targets, concurrent jobs or stale source/registry/ledger before the
 * durable claim, and re-verifies both physical targets before publication.
 * Any post-claim error retains the logical lock for human recovery. */
export async function executeM3TrustedRollback(req,operationId,deps={}){
 if(!UUID.test(operationId??'')||!req?.s03?.userScopeId||!req.user?.directories)
  throw refuse('M3_ROLLBACK_HOST_OR_TICKET_REQUIRED');
 const store=deps.store?.(req.s03)??new M3Store(req.s03);
 const ticket=await store.read('operation',operationId);
 if(ticket.owner!==req.s03.userScopeId||ticket.action!=='rollback'||ticket.backend!=='qdrant'||
  ticket.expiresAt<Date.now()||!Number.isSafeInteger(ticket.expiresAt)||
  ticket.createdAt>Date.now()||!UUID.test(ticket.restoreOperationId??''))
  throw refuse('M3_ROLLBACK_TICKET_UNTRUSTED');
 const c=await rollbackContext(req,ticket.restoreOperationId,deps);
 if(c.restore.logicalKey!==ticket.logicalKey||c.backup.backupId!==ticket.backupId||
  c.active.generation!==ticket.expectedGeneration||c.active.physicalName!==ticket.expectedPhysicalName||
  c.backup.physicalName!==ticket.physicalName||
  c.backup.savedSourceFingerprint!==ticket.sourceFingerprint||
  c.backup.managed.fingerprint!==ticket.managedFingerprint||
  c.backup.operationCheckpoint.digest!==ticket.ledgerDigest)
  throw refuse('M3_ROLLBACK_PLAN_STALE');
 let claimed=false;
 const output=await withM3LifecycleExclusion(c.ctx,{backend:'qdrant',logicalKey:ticket.logicalKey,operationId},async holder=>{
  try{
   await attestPristine(req,c,deps);
   await store.claim(operationId);claimed=true;
   const audit=new M3ExecutionAudit(c.ctx,{operationId,logicalKey:ticket.logicalKey,action:'rollback'});
   await audit.checkpoint(holder,'CLAIMED');
   await audit.checkpoint(holder,'DISPATCH_PENDING');
   const proof=await verifyM3PhysicalTarget(c.transport,c.backup,c.backup.physicalName);
   const smoke=await (deps.smoke??m3QdrantSmokeQueries)(c.transport,c.backup,c.backup.physicalName);
   if(smoke?.verified!==true)throw refuse('M3_ROLLBACK_SMOKE_FAILED');
   const generation=c.active.generation+1;
   await audit.checkpoint(holder,'PHYSICAL_VERIFIED',{detail:{digest:proof.inventoryDigest}});
   await issueM3TargetReceipt(c.ctx,{transport:c.transport,backup:c.backup,operationId,
    targetPhysicalName:c.backup.physicalName,generation});
   const claimProof={...proof,exclusiveOwner:true,receiptVerified:true,smokeVerified:true,
    smokeVersion:smoke.version,generation};
   await c.journal.prepare(c.canonical,{operationId,targetPhysicalName:c.backup.physicalName,
    backupDigest:sha(c.backup),proof:claimProof,holder});
   // A separate post-prepare physical inventory and source/registry/ledger
   // attestation is mandatory before final publication.
   await attestPristine(req,c,deps,{preparedOperationId:operationId});
   const published=await c.journal.publish(c.canonical,{operationId,proof:claimProof,holder});
   await audit.checkpoint(holder,'JOURNAL_PUBLISHED',{detail:{generation,physicalName:c.backup.physicalName}});
   if(published.generation!==generation||published.physicalName!==c.backup.physicalName)
    throw refuse('M3_ROLLBACK_PUBLISHED_TARGET_MISMATCH');
   const routed=await resolveM3VerifiedTarget(c.ctx,c.canonical,{transport:c.transport,backup:c.backup});
   if(routed.collection?.physicalName!==c.backup.physicalName||routed.collection?.generation!==generation)
    throw refuse('M3_ROLLBACK_PUBLISHED_VERIFICATION_FAILED');
   await audit.checkpoint(holder,'COMMITTED');
   return {state:'VERIFIED',operationId,logicalKey:ticket.logicalKey,generation,
    physicalName:c.backup.physicalName,rollbackOf:ticket.restoreOperationId,
    originalCollectionRetained:true,restoredCollectionRetained:true,productionCertified:false};
  }catch(e){if(!claimed)return {state:'FAILED',refusal:e};throw e;}
 });
 if(output?.state==='FAILED'&&output.refusal)throw output.refusal;
 return output;
}

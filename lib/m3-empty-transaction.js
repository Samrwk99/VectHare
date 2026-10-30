/** M3.4 scoped empty: one owned canonical Qdrant collection is replaced with a
 * fresh zero-point collection of exactly the same schema. The old collection
 * and its mandatory logical backup are retained. No physical purge/delete.
 * The managed registry is tombstoned before publication, while a durable
 * logical exclusion lock fences all cooperating writers. After the one-use
 * claim, any failure retains that lock for administrator adjudication.
 */
import {randomUUID,createHash} from 'node:crypto';
import {M3Store,qdrantM3Inventory,m3LedgerCheckpoint,assertM3ManagedCompleteness,
 stageM3DisposableRestore} from './m3-collections.js';
import {M3ExecutionAudit} from './m3-execution-audit.js';
import {withM3LifecycleExclusion} from './m3-logical-exclusion.js';
import {M3CutoverJournal,guardM3CanonicalBinding} from './m3-cutover-journal.js';
import {issueM3TargetReceipt,verifyM3PhysicalTarget,resolveM3VerifiedTarget} from './m3-target-receipts.js';
import {resolveF02Binding} from './f02-public-reads.js';
import {resolveM3ReadBinding} from './m3-target-receipts.js';
import {selectedM3Profile} from './m3-source-selection.js';
import {readM1Snapshot} from './m1-saved-records.js';
import {getEmbeddingProfile} from './f09b5-embedding-profiles.js';
import {readF03ProvisionReceipt} from './f03-provision.js';
import {ManagedChatRegistry} from './f09b4-managed-registry.js';
import {M2JobStore} from './m2-jobs.js';
const H=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const bad=code=>Object.assign(new Error(code),{code,status:409});
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

export function tombstoneM3ManagedSnapshot(managed){
 if(!managed||!managed.records||typeof managed.records!=='object'||Array.isArray(managed.records))
  throw bad('M3_EMPTY_MANAGED_INVALID');
 const {fingerprint,...doc}=structuredClone(managed);
 for(const r of Object.values(doc.records)){
  if(!r||!['ACTIVE','DELETED'].includes(r.state))throw bad('M3_EMPTY_MANAGED_PENDING');
  r.state='DELETED';r.operationId=null;
 }
 return doc;
}
async function preflight(req,ticket,deps,store,transport){
 const ctx=req.s03,backup=await store.read('backup',ticket.backupId);
 if(backup.schemaVersion!==1||backup.owner!==ctx.userScopeId||backup.backend!=='qdrant'||
  backup.logicalKey!==ticket.logicalKey||backup.physicalName!==ticket.physicalName||
  backup.savedSourceFingerprint!==ticket.sourceFingerprint||
  backup.inventory?.complete!==true||backup.inventory?.exclusiveOwner!==true||
  backup.inventory?.count!==backup.inventory?.rows?.length||
  backup.inventory?.digest!==H(backup.inventory.rows)||backup.inventory.digest!==ticket.inventoryDigest||
  backup.managed?.fingerprint!==ticket.managedFingerprint||
  (backup.routingGeneration??0)!==(ticket.routingGeneration??0)||
  (backup.canonicalPhysicalName??backup.physicalName)!==(ticket.canonicalPhysicalName??ticket.physicalName))
  throw bad('M3_EMPTY_BACKUP_INVALID');
 const found=await (deps.bind??resolveF02Binding)(req,{backend:'qdrant',source:ticket.source,
  embedding:backup.embedding,configId:ticket.configId},{reserve:false,readAlias:true});
 const canonical=found?.binding;
 if(canonical?.scope?.userScopeId!==ctx.userScopeId||canonical.scope.sourceId!==backup.sourceId||
  canonical.collection?.key!==ticket.logicalKey||
  canonical.collection.physicalName!==(ticket.canonicalPhysicalName??ticket.physicalName)||
  !equal(canonical.embedding,backup.embedding))throw bad('M3_EMPTY_BINDING_CHANGED');
 const binding=await (deps.resolveLiveBinding??resolveM3ReadBinding)(ctx,canonical,{transport});
 if(binding.collection.physicalName!==ticket.physicalName||
  (binding.collection.generation??0)!==(ticket.routingGeneration??0))throw bad('M3_EMPTY_STALE_GENERATION');
 const profile=deps.getProfile?await deps.getProfile(ctx):await selectedM3Profile(req,ticket.source);
 if(profile?.configured!==true||!equal(profile.profile,backup.embedding))throw bad('M3_EMPTY_PROFILE_CHANGED');
 const receipt=await (deps.receipt??readF03ProvisionReceipt)(ctx,canonical);
 if(receipt?.state!=='SCHEMA_VERIFIED_OFFLINE_UNCERTIFIED')throw bad('M3_EMPTY_PROVISION_REQUIRED');
 await (deps.jobs?.(ctx)??new M2JobStore(ctx)).assertNoLease(ticket.logicalKey);
 const journal=new M3CutoverJournal(ctx,{logicalKey:ticket.logicalKey});
 await journal.assertNoRetainedPhysicalLocks([...new Set([canonical.collection.physicalName,ticket.physicalName])]);
 const snap=await (deps.readSnapshot??readM1Snapshot)(req,ticket.source);
 if(snap.fileHash!==ticket.sourceFingerprint||snap.sourceId!==backup.sourceId)
  throw bad('M3_EMPTY_SAVED_SOURCE_CHANGED');
 const registry=deps.registry?.(ctx,canonical)??new ManagedChatRegistry(ctx,canonical);
 const managed=await registry.read();
 if(managed.fingerprint!==backup.managed.fingerprint)throw bad('M3_EMPTY_MANAGED_CHANGED');
 const ledger=await m3LedgerCheckpoint(ctx,ticket.logicalKey,deps);
 if(ledger.digest!==backup.operationCheckpoint?.digest)throw bad('M3_EMPTY_LEDGER_CHANGED');
 const observed=await (deps.inventory?deps.inventory(req,binding,transport):qdrantM3Inventory(transport,binding));
 if(!observed.complete||!observed.exclusiveOwner||observed.digest!==backup.inventory.digest||
  observed.count!==backup.inventory.count)throw bad('M3_EMPTY_PHYSICAL_CHANGED');
 assertM3ManagedCompleteness(managed,observed,binding);
 return {backup,binding,canonical,registry,managed,journal};
}
export async function executeM3TrustedEmpty(req,operationId,deps={}){
 if(!UUID.test(operationId??'')||!req?.s03?.userScopeId||!req.user?.directories)
  throw bad('M3_EMPTY_HOST_OR_TICKET_REQUIRED');
 const ctx=req.s03,store=deps.store?.(ctx)??new M3Store(ctx),ticket=await store.read('operation',operationId);
 if(ticket.owner!==ctx.userScopeId||ticket.action!=='empty'||ticket.backend!=='qdrant'||
  ticket.phase!=='PLANNED'||!Number.isSafeInteger(ticket.createdAt)||ticket.createdAt>Date.now()||
  !Number.isSafeInteger(ticket.expiresAt)||Date.now()>ticket.expiresAt)
  throw bad('M3_EMPTY_PLAN_UNTRUSTED');
 const transport=deps.transport?await deps.transport(req,ticket):
  (typeof deps.backendPool?.getTrusted==='function'?await deps.backendPool.getTrusted(ctx,'qdrant',ticket.configId):null);
 if(typeof transport?._request!=='function')throw bad('M3_EMPTY_TRUSTED_TRANSPORT_REQUIRED');
 let claimed=false;
 const outcome=await withM3LifecycleExclusion(ctx,{backend:'qdrant',logicalKey:ticket.logicalKey,operationId},async holder=>{
  try{
   const checked=await preflight(req,ticket,deps,store,transport);
   // The target is a *new* immutable manifest: source backup always remains
   // intact, including every original vector needed for later recovery.
   const emptyManaged=tombstoneM3ManagedSnapshot(checked.managed);
   const emptyBackup={...checked.backup,backupId:randomUUID(),
    createdAt:new Date().toISOString(),derivedFromBackupId:checked.backup.backupId,
    purpose:'SCOPED_EMPTY_TARGET',managed:{...emptyManaged,fingerprint:createHash('sha256').update(JSON.stringify(emptyManaged)).digest('hex')},
    inventory:{rows:[],count:0,digest:H([]),complete:true,exclusiveOwner:true}};
   // Fresh full pre-dispatch re-attestation (including the persisted backup).
   await preflight(req,ticket,deps,store,transport);
   await store.claim(operationId);claimed=true;
   const audit=new M3ExecutionAudit(ctx,{operationId,logicalKey:ticket.logicalKey,action:'empty'});
   await audit.checkpoint(holder,'CLAIMED');
   await store.write('backup',emptyBackup);
   await audit.checkpoint(holder,'DISPATCH_PENDING');
   const staged=await stageM3DisposableRestore(transport,emptyBackup,{operationId,holder,ctx});
   const verified=await verifyM3PhysicalTarget(transport,emptyBackup,staged.targetPhysicalName);
   if(verified.count!==0)throw bad('M3_EMPTY_NONEMPTY_TARGET');
   await audit.checkpoint(holder,'PHYSICAL_VERIFIED',{detail:{physicalName:staged.targetPhysicalName,count:0}});
   const active=await checked.journal.resolve(checked.canonical);
   if(active.generation!==(ticket.routingGeneration??0)||active.physicalName!==ticket.physicalName)
    throw bad('M3_EMPTY_ACTIVE_MAPPING_CHANGED');
   const generation=active.generation+1;
   await issueM3TargetReceipt(ctx,{transport,backup:emptyBackup,operationId,
    targetPhysicalName:staged.targetPhysicalName,generation});
   const proof={...verified,exclusiveOwner:true,receiptVerified:true,smokeVerified:true,
    smokeVersion:'empty-full-scan-v1',generation};
   await checked.journal.prepare(checked.canonical,{operationId,targetPhysicalName:staged.targetPhysicalName,
    backupDigest:H(emptyBackup),proof,holder});
   // All managed records become durable tombstones. Never silently re-vectorize
   // saved source merely because the new physical collection starts empty.
   await checked.registry.lock(async()=>{
    const latest=await checked.registry.read();
    if(latest.fingerprint!==checked.managed.fingerprint)throw bad('M3_EMPTY_REGISTRY_CHANGED');
    await checked.registry.save(emptyManaged);
   });
   const newRegistry=await checked.registry.read();
   if(newRegistry.fingerprint!==emptyBackup.managed.fingerprint)throw bad('M3_EMPTY_TOMBSTONE_UNVERIFIED');
   const snap=await (deps.readSnapshot??readM1Snapshot)(req,ticket.source);
   if(snap.fileHash!==ticket.sourceFingerprint||snap.sourceId!==emptyBackup.sourceId)
    throw bad('M3_EMPTY_SOURCE_CHANGED_BEFORE_PUBLICATION');
   const fresh=await verifyM3PhysicalTarget(transport,emptyBackup,staged.targetPhysicalName);
   if(fresh.count!==0)throw bad('M3_EMPTY_TARGET_CHANGED_BEFORE_PUBLICATION');
   await checked.journal.publish(checked.canonical,{operationId,proof,holder});
   await audit.checkpoint(holder,'JOURNAL_PUBLISHED',{detail:{generation,physicalName:staged.targetPhysicalName}});
   const published=await resolveM3VerifiedTarget(ctx,checked.canonical,{transport,backup:emptyBackup});
   if(published.collection.physicalName!==staged.targetPhysicalName||published.collection.generation!==generation)
    throw bad('M3_EMPTY_PUBLISHED_PROOF_FAILED');
   await audit.checkpoint(holder,'COMMITTED');
   return {state:'VERIFIED',operationId,logicalKey:ticket.logicalKey,generation,
    physicalName:staged.targetPhysicalName,retainedOriginalPhysicalName:ticket.physicalName,
    backupId:ticket.backupId,emptyTargetBackupId:emptyBackup.backupId,
    emptiedCount:checked.backup.inventory.count,verifiedEmpty:true,productionCertified:false};
  }catch(e){if(!claimed)return {state:'FAILED',refusal:e};throw e;}
 });
 if(outcome?.state==='FAILED'&&outcome.refusal)throw outcome.refusal;
 return outcome;
}

/** M3.5 guarded cross-model STAGING, deliberately NOT an active-profile cutover.
 * Server reads saved records, generates embeddings with the separately stored
 * inactive profile, and creates a fresh, fully verified target. All operations
 * after the durable claim are non-replayable and retain the logical lock on
 * failure. The active F09b.5 profile and old physical collection are untouched.
 */
import {createHash,randomUUID} from 'node:crypto';
import {M3Store,stageM3DisposableRestore,assertM3ManagedCompleteness,inspectM3Backup,validateM3Selector} from './m3-collections.js';
import {previewM3ModelRebuild} from './m3-rebuild-preview.js';
import {withM3LifecycleExclusion} from './m3-logical-exclusion.js';
import {M3ExecutionAudit} from './m3-execution-audit.js';
import {M3PhysicalProgress} from './m3-physical-progress.js';
import {getEmbeddingProfile,getStagedEmbeddingProfile,generateStagedEmbedding} from './f09b5-embedding-profiles.js';
import {readM1Snapshot,savedRecordIdentity,makeSavedRecordV2} from './m1-saved-records.js';
import {resolveF02Binding} from './f02-public-reads.js';
import {validateRecordV2} from './m0-record-schema.js';
import {contentFingerprint} from './s02-identity.js';
import {M3CutoverJournal} from './m3-cutover-journal.js';
import {ManagedChatRegistry} from './f09b4-managed-registry.js';
import {issueM3TargetReceipt,verifyM3TargetReceipt} from './m3-target-receipts.js';
import {m3QdrantSmokeQueries} from './m3-lifecycle-transaction.js';
const H=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const bad=(code,status=409)=>Object.assign(new Error(code),{code,status});
const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const LIMITED=20000;
const INLINE_LIMIT=256;
const stagingGeneration=1; // Receipt generation is a staging proof, NOT a published routing generation.
const own=(req)=>{if(!req?.s03?.userScopeId||!req.user?.directories)throw bad('M3_REBUILD_HOST_AUTH_REQUIRED',403);};

export async function planM3RebuildStage(req,deps={}){
 own(req);
 // A newly configured inactive profile has no S02 reservation yet. Create a
 // server-derived reservation only after authenticating the saved source and
 // verifying the original owned backup; never accept a browser physical name.
 validateM3Selector({backend:req.body?.backend,source:req.body?.source,configId:req.body?.configId});
 if(!UUID.test(req.body?.backupId??''))throw bad('M3_REBUILD_BACKUP_ID_INVALID',400);
 const existing=await (deps.store?.(req.s03)??new M3Store(req.s03)).read('backup',req.body.backupId);
 await inspectM3Backup(req,req.body.backupId,deps);
 if(existing.owner!==req.s03.userScopeId||existing.backend!=='qdrant'||
  !eq(existing.source,req.body.source)||existing.configId!==(req.body.configId??'default')||
  existing.routingGeneration>0)throw bad('M3_REBUILD_STAGE_SOURCE_OR_BACKUP_INVALID',403);
 const active=await (deps.getProfile??getEmbeddingProfile)(req.s03);
 const inactive=await (deps.getStagedProfile??getStagedEmbeddingProfile)(req.s03);
 if(!active?.configured||!inactive?.configured||!inactive.profile||
  !eq(active.profile,existing.embedding)||eq(inactive.profile,active.profile))
  throw bad('M3_REBUILD_STAGED_PROFILE_INVALID');
 const owned=await (deps.readSnapshot??readM1Snapshot)(req,req.body.source);
 if(owned.fileHash!==existing.savedSourceFingerprint||owned.sourceId!==existing.sourceId)
  throw bad('M3_REBUILD_SOURCE_CHANGED');
 const reserved=await (deps.bind??resolveF02Binding)(req,{backend:'qdrant',source:req.body.source,
  embedding:inactive.profile,configId:req.body.configId},{reserve:true});
 if(reserved?.binding?.scope?.userScopeId!==req.s03.userScopeId||
  reserved.binding.scope.sourceId!==existing.sourceId)throw bad('M3_REBUILD_TARGET_RESERVATION_INVALID');
 const preview=await previewM3ModelRebuild(req,deps);
 if(preview.recordsToReembed>LIMITED)throw bad('M3_REBUILD_STAGING_BATCH_LIMIT');
 const store=deps.store?.(req.s03)??new M3Store(req.s03);
 const staged=await (deps.getStagedProfile??getStagedEmbeddingProfile)(req.s03);
 if(!staged.configured||!staged.profile)throw bad('M3_REBUILD_STAGED_PROFILE_REQUIRED');
 const ticket={schemaVersion:1,operationId:randomUUID(),owner:req.s03.userScopeId,
  action:'rebuild',backend:'qdrant',configId:req.body.configId??'default',
  source:req.body.source,backupId:req.body.backupId,
  logicalKey:preview.oldLogicalKey,targetLogicalKey:preview.newLogicalKey,
  sourceFingerprint:preview.sourceFingerprint,targetProfileHash:H(staged.profile),
  expectedCount:preview.recordsToReembed,createdAt:Date.now(),expiresAt:Date.now()+(preview.recordsToReembed>INLINE_LIMIT?7*24*60*60*1000:5*60*1000),
  phase:'PLANNED_STAGING_ONLY'};
 await store.write('operation',ticket);
 return {operationId:ticket.operationId,action:'rebuild-stage',targetLogicalKey:ticket.targetLogicalKey,
  recordCount:ticket.expectedCount,expiresAt:ticket.expiresAt,
  requiresPreparation:ticket.expectedCount>INLINE_LIMIT,preparationBatchSize:16,
  mode:'PREVIEW',enabled:false,stagingAllowed:true,activationAllowed:false,
  validationStatus:'AWAITING_MANUAL_TEST',requiresConfirmation:'STAGE NEW MODEL WITHOUT ACTIVATION'};
}

export async function executeM3RebuildStage(req,operationId,deps={}){
 own(req);
 if(!UUID.test(operationId??''))throw bad('M3_REBUILD_OPERATION_INVALID',400);
 const ctx=req.s03,store=deps.store?.(ctx)??new M3Store(ctx),ticket=await store.read('operation',operationId);
 if(ticket.owner!==ctx.userScopeId||ticket.action!=='rebuild'||ticket.backend!=='qdrant'||
  ticket.phase!=='PLANNED_STAGING_ONLY'||!Number.isSafeInteger(ticket.expiresAt)||Date.now()>ticket.expiresAt||
  !Number.isSafeInteger(ticket.createdAt)||ticket.createdAt>Date.now()||
  !Number.isSafeInteger(ticket.expectedCount)||ticket.expectedCount<0||ticket.expectedCount>LIMITED)
  throw bad('M3_REBUILD_PLAN_INVALID');
 await store.assertUnclaimed(operationId);
 const request={...req,body:{backend:'qdrant',source:ticket.source,configId:ticket.configId,backupId:ticket.backupId}};
 const transport=deps.transport?await deps.transport(req,ticket):
  (typeof deps.backendPool?.getTrusted==='function'?await deps.backendPool.getTrusted(ctx,'qdrant',ticket.configId):null);
 if(typeof transport?._request!=='function')throw bad('M3_REBUILD_TRANSPORT_REQUIRED',403);
 const check=async()=>{
  const p=await previewM3ModelRebuild(request,{...deps,transport:async()=>transport});
  const staged=await (deps.getStagedProfile??getStagedEmbeddingProfile)(ctx);
  const active=await (deps.getProfile??getEmbeddingProfile)(ctx);
  if(!eq(staged?.profile&&H(staged.profile),ticket.targetProfileHash)||
     !eq(active?.profile,(await store.read('backup',ticket.backupId)).embedding)||
     p.oldLogicalKey!==ticket.logicalKey||p.newLogicalKey!==ticket.targetLogicalKey||
     p.sourceFingerprint!==ticket.sourceFingerprint||p.recordsToReembed!==ticket.expectedCount)
   throw bad('M3_REBUILD_STALE_PLAN');
  const bound=await (deps.bind??resolveF02Binding)(request,{backend:'qdrant',source:ticket.source,
   embedding:staged.profile,configId:ticket.configId},{reserve:false});
  if(bound?.binding?.collection?.key!==ticket.targetLogicalKey)throw bad('M3_REBUILD_TARGET_CHANGED');
  return {preview:p,staged:staged.profile,binding:bound.binding};
 };
 // The original logical collection stays locked while saved text is re-embedded.
 // This is intentionally a bounded staging operation, not yet M2 resumable.
 let claimed=false;
 const outcome=await withM3LifecycleExclusion(ctx,{backend:'qdrant',logicalKey:ticket.logicalKey,operationId},async holder=>{
  try{
   const {staged,binding}=await check();
   const backup=await store.read('backup',ticket.backupId);
   const snapshot=await (deps.readSnapshot??readM1Snapshot)(req,ticket.source);
   if(snapshot.fileHash!==ticket.sourceFingerprint||snapshot.sourceId!==backup.sourceId)
    throw bad('M3_REBUILD_SOURCE_CHANGED');
   const messages=new Map();
   for(const msg of snapshot.messages){
    const id=savedRecordIdentity(ctx,binding,msg).recordId;
    if(messages.has(id))throw bad('M3_REBUILD_DUPLICATE_SOURCE_ID');
    messages.set(id,msg);
   }
   const expected=[];
   const prepared=ticket.expectedCount>INLINE_LIMIT?await (async()=>{
    const {readM3PreparedRebuildVectors}=await import('./m3-rebuild-preparation.js');
    return readM3PreparedRebuildVectors(request,operationId,deps);
   })():null;
   for(const previous of backup.inventory.rows){
    const msg=messages.get(previous.payload.recordId);
    if(!msg||previous.payload.text!==msg.text||msg.contentHash!==contentFingerprint(msg.text)||
       previous.payload.textHash!==msg.contentHash)
     throw bad('M3_REBUILD_SOURCE_PROVENANCE_MISMATCH');
    const revision=previous.payload.revision;
    const previousV2=previous.payload.metadata?.vecthareRecordV2;
    validateRecordV2(previousV2);
    if(previousV2.revision!==revision||previousV2.recordId!==previous.payload.recordId)
     throw bad('M3_REBUILD_RECORD_REVISION_INVALID');
    const v2=makeSavedRecordV2({ctx,binding,msg,snapshot,profile:staged,revision,
     operationId,existing:{metadata:previous.payload.metadata}});
    const vector=prepared?prepared.get(previous.payload.recordId):await (deps.embed??(async (text,profile)=>generateStagedEmbedding(ctx,profile,text,{
     hostEmbed:(source,text,model)=>deps.hostEmbed?.(req,source,text,model)})))(msg.text,staged);
    if(!Array.isArray(vector)||vector.length!==staged.dimension||
       vector.some(x=>typeof x!=='number'||!Number.isFinite(x)))throw bad('M3_REBUILD_EMBEDDING_INVALID');
    const metadata={...previous.payload.metadata,vecthareRecordV2:v2};
    const payload={...previous.payload,embedding:staged,metadata,metadataHash:H(metadata),
     vectorHash:H(vector),vectorReference:vector};
    expected.push({id:previous.id,vector,payload});
   }
   if(expected.length!==ticket.expectedCount)throw bad('M3_REBUILD_RECORD_COUNT_CHANGED');
   // A changed source or profile before dispatch aborts without consuming the ticket.
   await check();
   const backupTarget={...backup,backupId:randomUUID(),logicalKey:ticket.targetLogicalKey,
    physicalName:binding.collection.physicalName,embedding:staged,
    purpose:'M3_NEW_MODEL_STAGED_NO_CUTOVER',derivedFromBackupId:backup.backupId,
    inventory:{rows:expected.sort((a,b)=>String(a.id).localeCompare(String(b.id))),
     count:expected.length,digest:null,complete:true,exclusiveOwner:true}};
   backupTarget.inventory.digest=H(backupTarget.inventory.rows);
   // The immutable M3Store document is bounded to 100 MiB. Detect an
   // oversized high-dimensional rebuild BEFORE the one-way physical claim.
   if(Buffer.byteLength(JSON.stringify(backupTarget))>95*1024*1024)
    throw bad('M3_REBUILD_TARGET_BACKUP_EXCEEDS_LIMIT');
   // The target embedding identity has its own managed registry; carrying the
   // old registry's collection key would make activation unverifiable.
   const targetRegistry=deps.targetRegistry?.(ctx,binding)??new ManagedChatRegistry(ctx,binding);
   const currentTarget=await targetRegistry.read();
   if(Object.keys(currentTarget.records).length!==0)throw bad('M3_REBUILD_STAGED_REGISTRY_NOT_EMPTY');
   const targetManaged={...targetRegistry.empty(),records:structuredClone(backup.managed.records)};
   if(Object.values(targetManaged.records).some(r=>r.state!=='ACTIVE')||
      Object.keys(targetManaged.records).length!==expected.length)throw bad('M3_REBUILD_MANAGED_TARGET_MISMATCH');
   const targetFingerprint=H(targetManaged);
   // ManagedChatRegistry fingerprints use SHA256 over the exact JSON document.
   backupTarget.managed={records:targetManaged.records,fingerprint:targetFingerprint};
   // Hold BOTH old and new logical keys. A stage creates the target under its
   // own identity; passing the old holder to its backend write is forbidden.
   // A post-claim error retains both locks for administrator adjudication.
   return withM3LifecycleExclusion(ctx,{backend:'qdrant',logicalKey:ticket.targetLogicalKey,operationId},async targetHolder=>{
    try{
    // After this claim the operation MUST NOT be replayed if Qdrant times out.
    await store.claim(operationId);claimed=true;
    const audit=new M3ExecutionAudit(ctx,{operationId,logicalKey:ticket.logicalKey,action:'rebuild'});
    await audit.checkpoint(holder,'CLAIMED');
    await store.write('backup',backupTarget);
    await audit.checkpoint(holder,'DISPATCH_PENDING');
    const physicalProgress=new M3PhysicalProgress(ctx,operationId);
    const onVerifiedChunk=ticket.expectedCount>INLINE_LIMIT?async entry=>
     physicalProgress.recordVerified({...entry,recordCount:entry.chunk.length}):null;
    const result=await (deps.stage??stageM3DisposableRestore)(transport,backupTarget,
     {operationId,holder:targetHolder,ctx,onVerifiedChunk});
    if(result?.inventoryVerified!==true||result.restoredCount!==expected.length||
       result.targetPhysicalName===backup.physicalName)throw bad('M3_REBUILD_TARGET_NOT_VERIFIED');
    // Staging is not finished merely because Qdrant acknowledged an upsert.
    // Prove actual target inventory, search visibility, immutable receipt and
    // an independently scoped managed registry before marking it complete.
    const smoke=await (deps.smoke??m3QdrantSmokeQueries)(transport,backupTarget,result.targetPhysicalName);
    if(smoke?.verified!==true)throw bad('M3_REBUILD_STAGED_SMOKE_FAILED');
    const issued=await (deps.issueTargetReceipt??issueM3TargetReceipt)(ctx,{
     transport,backup:backupTarget,operationId,targetPhysicalName:result.targetPhysicalName,
     generation:stagingGeneration});
    if(issued?.receiptVerified!==true)throw bad('M3_REBUILD_STAGED_RECEIPT_MISSING');
    await targetRegistry.lock(async()=>{
     const latest=await targetRegistry.read();
     if(Object.keys(latest.records).length!==0)throw bad('M3_REBUILD_STAGED_REGISTRY_CHANGED');
     await targetRegistry.save(targetManaged);
    });
    const settled=await targetRegistry.read();
    if(settled.fingerprint!==targetFingerprint)throw bad('M3_REBUILD_STAGED_REGISTRY_UNVERIFIED');
    assertM3ManagedCompleteness(settled,backupTarget.inventory,binding);
    await audit.checkpoint(holder,'PHYSICAL_VERIFIED',{detail:{target:result.targetPhysicalName,
     targetBackupId:backupTarget.backupId,count:expected.length}});
    const stagedResult={schemaVersion:1,operationId,owner:ctx.userScopeId,
     oldLogicalKey:ticket.logicalKey,targetLogicalKey:ticket.targetLogicalKey,
     targetPhysicalName:result.targetPhysicalName,targetBackupId:backupTarget.backupId,
     sourceFingerprint:ticket.sourceFingerprint,targetProfileHash:ticket.targetProfileHash,
     expectedCount:expected.length,receiptGeneration:stagingGeneration,
     targetRegistryFingerprint:settled.fingerprint,smokeVersion:smoke.version??'m3-smoke-v1',
     activated:false,createdAt:new Date().toISOString()};
    await store.write('stage',stagedResult);
    await audit.checkpoint(holder,'COMMITTED');
    return {state:'VERIFIED_STAGED',operationId,oldLogicalKey:ticket.logicalKey,
     stagedLogicalKey:ticket.targetLogicalKey,stagedPhysicalName:result.targetPhysicalName,
     stagedBackupId:backupTarget.backupId,recordCount:expected.length,
     targetReceiptVerified:true,targetRegistryVerified:true,smokeVerified:true,
     activationAllowed:false,activeProfileUnchanged:true,oldCollectionRetained:true,
     validationStatus:'AWAITING_MANUAL_TEST',requiresProfileBindingCutover:true};
    }catch(e){if(!claimed)return {state:'FAILED',error:e};throw e;}
   });
  }catch(e){if(!claimed)return {state:'FAILED',error:e};throw e;}
 });
 if(outcome?.state==='FAILED'&&outcome.error)throw outcome.error;
 return outcome;
}

/** Read-only cross-model staging verification. There is deliberately no
 * activate button: all consumers must share one atomic profile+binding
 * selection before activation can be safe. We never infer activation from
 * a successful target readback or release retained locks here.
 */
export async function inspectM3RebuildStage(req,operationId,deps={}){
 own(req);
 if(!UUID.test(operationId??''))throw bad('M3_REBUILD_OPERATION_INVALID',400);
 const ctx=req.s03,store=deps.store?.(ctx)??new M3Store(ctx);
 const ticket=await store.read('operation',operationId);
 if(ticket.owner!==ctx.userScopeId||ticket.action!=='rebuild'||ticket.backend!=='qdrant')
  throw bad('M3_REBUILD_STAGE_SCOPE_INVALID',403);
 const audit=new M3ExecutionAudit(ctx,{operationId,logicalKey:ticket.logicalKey,action:'rebuild'});
 const events=await audit.events();
 if(events.at(-1)?.stage!=='COMMITTED')return {operationId,state:'REVIEW_REQUIRED',
  lastStage:events.at(-1)?.stage??null,activationAllowed:false,physicalLockReleaseAuthorized:false};
 const stage=await store.read('stage',operationId);
 const targetBackup=await store.read('backup',stage.targetBackupId);
 if(stage.schemaVersion!==1||stage.oldLogicalKey!==ticket.logicalKey||
  stage.targetLogicalKey!==ticket.targetLogicalKey||stage.owner!==ctx.userScopeId||
  stage.sourceFingerprint!==ticket.sourceFingerprint||stage.targetProfileHash!==ticket.targetProfileHash||
  stage.expectedCount!==ticket.expectedCount||stage.receiptGeneration!==stagingGeneration||stage.activated!==false||
  targetBackup.logicalKey!==ticket.targetLogicalKey||targetBackup.owner!==ctx.userScopeId||
  targetBackup.inventory.count!==ticket.expectedCount||H(targetBackup.inventory.rows)!==targetBackup.inventory.digest||
  targetBackup.managed?.fingerprint!==stage.targetRegistryFingerprint)
  throw bad('M3_REBUILD_STAGE_EVIDENCE_MISMATCH');
 const transport=deps.transport?await deps.transport(req,ticket):
  (typeof deps.backendPool?.getTrusted==='function'?await deps.backendPool.getTrusted(ctx,'qdrant',ticket.configId):null);
 if(typeof transport?._request!=='function')throw bad('M3_REBUILD_TRUSTED_TRANSPORT_REQUIRED',403);
 const active={logicalKey:stage.targetLogicalKey,physicalName:stage.targetPhysicalName,generation:stagingGeneration};
 const result=await (deps.verifyTargetReceipt??verifyM3TargetReceipt)(ctx,{
  transport,backup:targetBackup,operationId,active});
 if(result?.receiptVerified!==true||result?.inventoryVerified!==true||
  result?.schemaVerified!==true||result?.physicalName!==stage.targetPhysicalName)
  throw bad('M3_REBUILD_STAGE_PHYSICAL_UNVERIFIED');
 const target={authorized:true,provenance:'SERVER_VERIFIED',backend:'qdrant',scope:targetBackup.scope,
  embedding:targetBackup.embedding,collection:{key:targetBackup.logicalKey,physicalName:targetBackup.physicalName}};
 const registry=await (deps.targetRegistry?.(ctx,target)??new ManagedChatRegistry(ctx,target)).read();
 if(registry.fingerprint!==stage.targetRegistryFingerprint)throw bad('M3_REBUILD_STAGE_REGISTRY_CHANGED');
 assertM3ManagedCompleteness(registry,targetBackup.inventory,target);
 const source=await (deps.readSnapshot??readM1Snapshot)(req,ticket.source);
 if(source.sourceId!==targetBackup.sourceId||source.fileHash!==stage.sourceFingerprint)
  throw bad('M3_REBUILD_STAGE_SOURCE_CHANGED');
 const profile=await (deps.getStagedProfile??getStagedEmbeddingProfile)(ctx);
 const original=await (deps.getProfile??getEmbeddingProfile)(ctx);
 if(!eq(H(profile?.profile),stage.targetProfileHash)||
  !eq(original?.profile,(await store.read('backup',ticket.backupId)).embedding))
  throw bad('M3_REBUILD_STAGE_PROFILE_CHANGED');
 return {operationId,state:'VERIFIED_STAGED',stagedLogicalKey:stage.targetLogicalKey,
  stagedBackupId:stage.targetBackupId,recordCount:stage.expectedCount,
  receiptVerified:true,registryVerified:true,physicalVerified:true,sourceVerified:true,
  activeProfileUnchanged:true,activationAllowed:false,validationStatus:'AWAITING_MANUAL_TEST',
  activationBlocker:'M3_ATOMIC_PROFILE_AND_COLLECTION_SELECTION_UNIMPLEMENTED'};
}

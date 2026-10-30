/** Source-scoped M3 rebuild activation. No global embedding-profile mutation.
 * The last persistent commit is the per-source selection record. A target
 * journal published before that commit is not selected by normal flows.
 * Post-claim uncertainty retains BOTH logical locks; no automatic retries.
 */
import {createHash,randomUUID} from 'node:crypto';
import {M3Store} from './m3-collections.js';
import {inspectM3RebuildStage} from './m3-rebuild-stage.js';
import {M3ExecutionAudit} from './m3-execution-audit.js';
import {withM3LifecycleExclusion} from './m3-logical-exclusion.js';
import {M3CutoverJournal} from './m3-cutover-journal.js';
import {verifyM3PhysicalTarget,issueM3TargetReceipt,resolveM3ReadBinding} from './m3-target-receipts.js';
import {m3QdrantSmokeQueries} from './m3-lifecycle-transaction.js';
import {readM1Snapshot} from './m1-saved-records.js';
import {resolveF02Binding} from './f02-public-reads.js';
import {ManagedChatRegistry} from './f09b4-managed-registry.js';
import {M2JobStore} from './m2-jobs.js';
import {getEmbeddingProfile,getStagedEmbeddingProfile} from './f09b5-embedding-profiles.js';
import {configurationForM3Activation,readM3SourceSelection,commitM3SourceSelection} from './m3-source-selection.js';
import {attestHostSource} from './f01-host-sources.js';
const H=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const err=code=>Object.assign(new Error(code),{code,status:409});
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const host=req=>{if(!req?.s03?.userScopeId||!req.user?.directories)throw err('M3_ACTIVATE_HOST_REQUIRED');};
const storeOf=(ctx,deps)=>deps.store?.(ctx)??new M3Store(ctx);
async function prepare(req,stageId,deps){
 host(req);if(!UUID.test(stageId??''))throw err('M3_ACTIVATE_STAGE_ID_INVALID');
 const ctx=req.s03,store=storeOf(ctx,deps),stageTicket=await store.read('operation',stageId);
 if(stageTicket.owner!==ctx.userScopeId||stageTicket.action!=='rebuild'||stageTicket.backend!=='qdrant')throw err('M3_ACTIVATE_STAGE_SCOPE_INVALID');
 const stage=await store.read('stage',stageId);
 if(stage.owner!==ctx.userScopeId||stage.operationId!==stageId||stage.oldLogicalKey!==stageTicket.logicalKey||
   stage.targetLogicalKey!==stageTicket.targetLogicalKey||stage.sourceFingerprint!==stageTicket.sourceFingerprint)
  throw err('M3_ACTIVATE_STAGE_RECORD_INVALID');
 const oldBackup=await store.read('backup',stageTicket.backupId);
 const targetBackup=await store.read('backup',stage.targetBackupId);
 if(oldBackup.logicalKey!==stage.oldLogicalKey||targetBackup.logicalKey!==stage.targetLogicalKey||
  targetBackup.inventory.count!==stage.expectedCount||targetBackup.managed?.fingerprint!==stage.targetRegistryFingerprint||
  targetBackup.owner!==ctx.userScopeId)throw err('M3_ACTIVATE_BACKUP_MISMATCH');
 const proof=await inspectM3RebuildStage({...req,body:{...req.body,source:stageTicket.source}},stageId,deps);
 if(proof.state!=='VERIFIED_STAGED'||proof.sourceVerified!==true||proof.physicalVerified!==true||proof.registryVerified!==true)
  throw err('M3_ACTIVATE_STAGE_NOT_VERIFIED');
 const attested=await (deps.attest??attestHostSource)(req,stageTicket.source);
 if(attested?.status!=='HOST_FILE_OWNED'||attested.hostSourceOwnerVerified!==true||
  attested.scope?.userScopeId!==ctx.userScopeId||!same(attested.scope,targetBackup.scope))throw err('M3_ACTIVATE_SOURCE_NOT_ATTESTED');
 if(await readM3SourceSelection(ctx,attested.scope))throw err('M3_ACTIVATE_SOURCE_ALREADY_SELECTED');
 const active=await (deps.getProfile??getEmbeddingProfile)(ctx);
 const staged=await (deps.getStagedProfile??getStagedEmbeddingProfile)(ctx);
 if(!same(active?.profile,oldBackup.embedding)||!same(staged?.profile,targetBackup.embedding)||
  H(staged.profile)!==stage.targetProfileHash)throw err('M3_ACTIVATE_PROFILE_CHANGED');
 const snapshot=await (deps.readSnapshot??readM1Snapshot)(req,stageTicket.source);
 if(snapshot.fileHash!==stage.sourceFingerprint||snapshot.sourceId!==oldBackup.sourceId)throw err('M3_ACTIVATE_SOURCE_CHANGED');
 await (deps.jobs?.(ctx)??new M2JobStore(ctx)).assertNoLease(stage.oldLogicalKey);
 await (deps.jobs?.(ctx)??new M2JobStore(ctx)).assertNoLease(stage.targetLogicalKey);
 const targetBound=await (deps.bind??resolveF02Binding)(req,{backend:'qdrant',source:stageTicket.source,
  embedding:targetBackup.embedding,configId:stageTicket.configId},{reserve:false,readAlias:true});
 const binding=targetBound?.binding;
 if(binding?.collection?.key!==stage.targetLogicalKey||binding.collection.physicalName!==targetBackup.physicalName||
  !same(binding.scope,targetBackup.scope))throw err('M3_ACTIVATE_TARGET_BINDING_INVALID');
 const oldBound=await (deps.bind??resolveF02Binding)(req,{backend:'qdrant',source:stageTicket.source,
  embedding:oldBackup.embedding,configId:stageTicket.configId},{reserve:false});
 if(oldBound.binding?.collection?.key!==stage.oldLogicalKey)throw err('M3_ACTIVATE_ORIGINAL_BINDING_INVALID');
 const targetRegistry=await (deps.targetRegistry?.(ctx,binding)??new ManagedChatRegistry(ctx,binding)).read();
 if(targetRegistry.fingerprint!==stage.targetRegistryFingerprint)throw err('M3_ACTIVATE_REGISTRY_CHANGED');
 const connection=deps.transport?await deps.transport(req,stageTicket):await deps.backendPool?.getTrusted?.(ctx,'qdrant',stageTicket.configId);
 if(typeof connection?._request!=='function')throw err('M3_ACTIVATE_TRANSPORT_REQUIRED');
 const physical=await (deps.verifyPhysical??verifyM3PhysicalTarget)(connection,targetBackup,stage.targetPhysicalName);
 if(physical?.verified!==true||physical?.inventoryVerified!==true||physical?.schemaVerified!==true||
  physical.physicalName!==stage.targetPhysicalName)throw err('M3_ACTIVATE_TARGET_CHANGED');
 const smoke=await (deps.smoke??m3QdrantSmokeQueries)(connection,targetBackup,stage.targetPhysicalName);
 if(smoke?.verified!==true)throw err('M3_ACTIVATE_SMOKE_FAILED');
 const config=deps.configuration?await deps.configuration(ctx,targetBackup.embedding):await configurationForM3Activation(ctx,targetBackup.embedding);
 if(config?.version!==1||!same(config.profile,targetBackup.embedding))throw err('M3_ACTIVATE_CREDENTIAL_CONFIGURATION_CHANGED');
 return {ctx,store,stage,stageTicket,oldBackup,targetBackup,binding,connection,physical,smoke,config,attested};
}
export async function planM3RebuildActivation(req,deps={}){
 host(req);const {stageOperationId}=req.body??{};
 const info=await prepare(req,stageOperationId,deps);
 const op={schemaVersion:1,operationId:randomUUID(),owner:info.ctx.userScopeId,
  action:'activate-rebuild',backend:'qdrant',stageOperationId,
  sourceFingerprint:info.stage.sourceFingerprint,oldLogicalKey:info.stage.oldLogicalKey,
  targetLogicalKey:info.stage.targetLogicalKey,profileHash:info.stage.targetProfileHash,
  createdAt:Date.now(),expiresAt:Date.now()+5*60*1000};
 await info.store.write('operation',op);
 return {operationId:op.operationId,stageOperationId,targetLogicalKey:op.targetLogicalKey,
  requiresConfirmation:'ACTIVATE VERIFIED MODEL FOR THIS SOURCE',enabled:true,
  validationStatus:'AWAITING_MANUAL_TEST',executionAllowed:true};
}
export async function executeM3RebuildActivation(req,operationId,deps={}){
 host(req);if(!UUID.test(operationId??''))throw err('M3_ACTIVATE_OPERATION_ID_INVALID');
 const ctx=req.s03,store=storeOf(ctx,deps),ticket=await store.read('operation',operationId);
 if(ticket.owner!==ctx.userScopeId||ticket.action!=='activate-rebuild'||ticket.backend!=='qdrant'||
  !Number.isSafeInteger(ticket.createdAt)||!Number.isSafeInteger(ticket.expiresAt)||
  ticket.createdAt>Date.now()||Date.now()>ticket.expiresAt)throw err('M3_ACTIVATE_OPERATION_EXPIRED');
 await store.assertUnclaimed(operationId);
 let claimed=false;
 const outcome=await withM3LifecycleExclusion(ctx,{backend:'qdrant',logicalKey:ticket.oldLogicalKey,operationId},async oldHolder=>{
  try{return await withM3LifecycleExclusion(ctx,{backend:'qdrant',logicalKey:ticket.targetLogicalKey,operationId},async targetHolder=>{
   try{
    const info=await prepare(req,ticket.stageOperationId,deps);
    if(info.stage.oldLogicalKey!==ticket.oldLogicalKey||info.stage.targetLogicalKey!==ticket.targetLogicalKey||
      info.stage.sourceFingerprint!==ticket.sourceFingerprint||info.stage.targetProfileHash!==ticket.profileHash)
      throw err('M3_ACTIVATE_PLAN_STALE');
    const journal=new M3CutoverJournal(ctx,{logicalKey:ticket.targetLogicalKey});
    const before=await journal.resolve(info.binding);
    if(before.generation!==0||before.physicalName!==info.binding.collection.physicalName)
      throw err('M3_ACTIVATE_TARGET_ALREADY_PUBLISHED');
    await journal.assertNoRetainedPhysicalLocks([before.physicalName,info.stage.targetPhysicalName]);
    await new M3CutoverJournal(ctx,{logicalKey:ticket.oldLogicalKey}).assertNoRetainedPhysicalLocks([info.oldBackup.physicalName]);
    await store.claim(operationId);claimed=true;
    const audit=new M3ExecutionAudit(ctx,{operationId,logicalKey:ticket.oldLogicalKey,action:'activate-rebuild'});
    await audit.checkpoint(oldHolder,'CLAIMED');
    await audit.checkpoint(oldHolder,'DISPATCH_PENDING');
    // The new target already exists: this readback validates its immutable
    // receipt for the ACTUAL activation operation, not merely the stage.
    const issued=await (deps.issueReceipt??issueM3TargetReceipt)(ctx,{transport:info.connection,
     backup:info.targetBackup,operationId,targetPhysicalName:info.stage.targetPhysicalName,generation:1});
    if(issued?.receiptVerified!==true)throw err('M3_ACTIVATE_TARGET_RECEIPT_REQUIRED');
    const proof={...info.physical,verified:true,inventoryVerified:true,schemaVerified:true,
     exclusiveOwner:true,receiptVerified:true,smokeVerified:true,smokeVersion:info.smoke.version,
     logicalKey:ticket.targetLogicalKey,physicalName:info.stage.targetPhysicalName,generation:1};
    await audit.checkpoint(oldHolder,'PHYSICAL_VERIFIED');
    await journal.prepare(info.binding,{operationId,targetPhysicalName:info.stage.targetPhysicalName,
     backupDigest:H(info.targetBackup),proof,holder:targetHolder});
    // Re-attest with every active profile and source unchanged after PREPARED.
    const refreshed=await (deps.readSnapshot??readM1Snapshot)(req,info.stageTicket.source);
    if(refreshed.fileHash!==ticket.sourceFingerprint)throw err('M3_ACTIVATE_SOURCE_CHANGED_DURING_COMMIT');
    await journal.publish(info.binding,{operationId,proof,holder:targetHolder});
    await audit.checkpoint(oldHolder,'JOURNAL_PUBLISHED');
    const routed=await (deps.resolveTarget??resolveM3ReadBinding)(ctx,info.binding,{transport:info.connection});
    if(routed.collection.physicalName!==info.stage.targetPhysicalName||routed.collection.generation!==1)
     throw err('M3_ACTIVATE_PUBLISHED_TARGET_UNVERIFIED');
    const selected=await commitM3SourceSelection(ctx,{scope:info.binding.scope,operationId,
     fromLogicalKey:ticket.oldLogicalKey,toLogicalKey:ticket.targetLogicalKey,
     profile:info.targetBackup.embedding,config:info.config,sourceFingerprint:ticket.sourceFingerprint});
    await audit.checkpoint(oldHolder,'COMMITTED');
    return {operationId,state:'VERIFIED',sourceScoped:true,logicalKey:ticket.targetLogicalKey,
     generation:selected.generation,activeProfileUnchanged:true,oldCollectionRetained:true,
     validationStatus:'AWAITING_MANUAL_TEST',enabled:true};
   }catch(e){if(!claimed)return {state:'FAILED',error:e};throw e;}
  });}catch(e){if(!claimed)return {state:'FAILED',error:e};throw e;}
 });
 if(outcome?.state==='FAILED'&&outcome.error)throw outcome.error;
 return outcome;
}

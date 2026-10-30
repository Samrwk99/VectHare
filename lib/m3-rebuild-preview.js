/** M3.5 cross-model rebuild readiness, read-only.
 * Source vectors/credentials/owners are NEVER browser inputs. A new embedding
 * profile changes the S02 identity, so a regular M3 restore/cutover MUST NOT
 * be used. This evaluator verifies the full old inventory and saved-source
 * mapping before allowing later code to build an independent target collection.
 */
import {M3Store,inspectM3Backup,qdrantM3Inventory,m3LedgerCheckpoint,assertM3ManagedCompleteness,validateM3Selector} from './m3-collections.js';
import {collectionIdentity} from './s02-identity.js';
import {attestHostSource} from './f01-host-sources.js';
import {getEmbeddingProfile,getStagedEmbeddingProfile} from './f09b5-embedding-profiles.js';
import {resolveF02Binding} from './f02-public-reads.js';
import {readM1Snapshot,savedRecordIdentity} from './m1-saved-records.js';
import {ManagedChatRegistry} from './f09b4-managed-registry.js';
import {M2JobStore} from './m2-jobs.js';
import {M3CutoverJournal} from './m3-cutover-journal.js';
// Use the ordinary UUID format rather than loosening input to allow paths.
const ID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const bad=(code,status=409)=>Object.assign(new Error(code),{code,status});
const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export async function previewM3ModelRebuild(req,deps={}){
 const b=req?.body;
 if(!b||typeof b!=='object'||Array.isArray(b)||
  Object.keys(b).some(k=>!['backend','source','configId','backupId'].includes(k))||!ID.test(b.backupId??''))
  throw bad('M3_REBUILD_PREVIEW_SELECTOR_INVALID',400);
 validateM3Selector({backend:b.backend,source:b.source,configId:b.configId});
 if(!req?.s03?.userScopeId||!req.user?.directories)throw bad('M3_REBUILD_AUTH_REQUIRED',403);
 const ctx=req.s03,store=deps.store?.(ctx)??new M3Store(ctx);
 const backup=await store.read('backup',b.backupId);
 await inspectM3Backup(req,b.backupId,deps);
 if(backup.owner!==ctx.userScopeId||backup.backend!=='qdrant'||!eq(backup.source,b.source)||
    backup.configId!==(b.configId??'default')||backup.routingGeneration>0)
  throw bad('M3_REBUILD_BACKUP_SCOPE_OR_GENERATION_INVALID',403);
 const identity=collectionIdentity({backend:'qdrant',scope:backup.scope,embedding:backup.embedding});
 if(identity.key!==backup.logicalKey||identity.physicalName!==backup.physicalName||
  backup.sourceId!==backup.scope.sourceId)throw bad('M3_REBUILD_ORIGINAL_BINDING_INVALID');
 const activeProfile=await (deps.getProfile??getEmbeddingProfile)(ctx);
 if(activeProfile?.configured!==true||!eq(activeProfile.profile,backup.embedding))
  throw bad('M3_REBUILD_ACTIVE_PROFILE_CHANGED');
 const targetProfile=await (deps.getStagedProfile??getStagedEmbeddingProfile)(ctx);
 if(targetProfile?.configured!==true||!targetProfile.profile||
   eq(targetProfile.profile,backup.embedding))throw bad('M3_REBUILD_DISTINCT_PROFILE_REQUIRED');
 // Preview must remain read-only: an unreserved staged-model identity can
 // be derived from attested host source, while the later explicit stage plan
 // reserves it durably in S02. No preview side effects or guessed owner.
 let targetUnreserved=false;
 const bindTarget=async()=>{
  try{return (await (deps.bind??resolveF02Binding)(req,{backend:'qdrant',source:b.source,
   embedding:targetProfile.profile,configId:b.configId},{reserve:false})).binding;}
  catch(e){
   if(deps.bind||e.code!=='F02_COLLECTION_NOT_BOUND')throw e;
   const evidence=await attestHostSource(req,b.source);
   if(evidence.status!=='HOST_FILE_OWNED'||evidence.hostSourceOwnerVerified!==true||
    evidence.scope?.userScopeId!==ctx.userScopeId)throw bad('M3_REBUILD_TARGET_SOURCE_UNATTESTED',403);
   const id=collectionIdentity({backend:'qdrant',scope:evidence.scope,embedding:targetProfile.profile});
   targetUnreserved=true;
   return {authorized:true,provenance:'SERVER_VERIFIED',backend:'qdrant',scope:evidence.scope,
    embedding:targetProfile.profile,collection:{key:id.key,physicalName:id.physicalName}};
  }
 };
 const [target,snapshot]=await Promise.all([bindTarget(),(deps.readSnapshot??readM1Snapshot)(req,b.source)]);
 if(snapshot.sourceId!==backup.sourceId||snapshot.fileHash!==backup.savedSourceFingerprint)
  throw bad('M3_REBUILD_SOURCE_CHANGED');
 if(target?.authorized!==true||target.provenance!=='SERVER_VERIFIED'||
   target.scope?.userScopeId!==ctx.userScopeId||target.scope?.sourceId!==backup.sourceId||
   !eq(target.embedding,targetProfile.profile)||target.collection?.key===backup.logicalKey)
  throw bad('M3_REBUILD_TARGET_BINDING_UNVERIFIED');
 const freshTarget=collectionIdentity({backend:'qdrant',scope:target.scope,embedding:target.embedding});
 if(freshTarget.key!==target.collection.key||freshTarget.physicalName!==target.collection.physicalName)
  throw bad('M3_REBUILD_TARGET_BINDING_UNVERIFIED');
 await (deps.jobs?.(ctx)??new M2JobStore(ctx)).assertNoLease(backup.logicalKey);
 await (deps.jobs?.(ctx)??new M2JobStore(ctx)).assertNoLease(target.collection.key);
 const old={authorized:true,provenance:'SERVER_VERIFIED',backend:'qdrant',scope:backup.scope,
  embedding:backup.embedding,collection:{key:backup.logicalKey,physicalName:backup.physicalName}};
 await new M3CutoverJournal(ctx,{logicalKey:backup.logicalKey}).assertNoRetainedPhysicalLocks([backup.physicalName]);
 const registry=await (deps.registry?.(ctx,old)??new ManagedChatRegistry(ctx,old)).read();
 if(registry.fingerprint!==backup.managed?.fingerprint)
  throw bad('M3_REBUILD_MANAGED_REGISTRY_CHANGED');
 const checkpoint=await m3LedgerCheckpoint(ctx,backup.logicalKey,deps);
 if(checkpoint.digest!==backup.operationCheckpoint?.digest)throw bad('M3_REBUILD_LEDGER_CHANGED');
 const transport=deps.transport?await deps.transport(req,backup):
  await deps.backendPool?.getTrusted?.(ctx,'qdrant',backup.configId);
 if(typeof transport?._request!=='function')throw bad('M3_REBUILD_SERVER_TRANSPORT_REQUIRED',403);
 const inventory=await (deps.inventory?deps.inventory(req,old,transport):qdrantM3Inventory(transport,old));
 if(inventory.complete!==true||inventory.exclusiveOwner!==true||
   inventory.digest!==backup.inventory.digest||inventory.count!==backup.inventory.count)
  throw bad('M3_REBUILD_ORIGINAL_INVENTORY_CHANGED');
 assertM3ManagedCompleteness(registry,inventory,old);
 if(!Array.isArray(snapshot.messages))throw bad('M3_REBUILD_SAVED_SOURCE_UNVERIFIED');
 const messages=new Map();
 for(const msg of snapshot.messages){
  if(!msg||typeof msg.text!=='string'||!msg.text||msg.text.length>10000||
   typeof msg.contentHash!=='string')throw bad('M3_REBUILD_SOURCE_RECORD_INVALID');
  const {recordId}=savedRecordIdentity(ctx,old,msg);
  if(messages.has(recordId))throw bad('M3_REBUILD_DUPLICATE_SOURCE_ID');
  messages.set(recordId,msg);
 }
 let activeCount=0,deletedCount=0;
 const physical=new Map(inventory.rows.map(r=>[r.payload.recordId,r]));
 for(const [id,entry] of Object.entries(registry.records)){
  if(entry.state==='DELETED'){deletedCount++;continue;}
  if(entry.state!=='ACTIVE')throw bad('M3_REBUILD_PENDING_RECORD');
  const row=physical.get(id),message=messages.get(id);
  if(!row||!message||row.payload.textHash!==entry.contentHash||
    row.payload.textHash!==message.contentHash||
    row.payload.metadata?.vecthareRecordV2?.identity?.sourceEntryId!==message.recordId)
   throw bad('M3_REBUILD_SOURCE_PROVENANCE_MISMATCH');
  activeCount++;
 }
 if(activeCount!==inventory.count)throw bad('M3_REBUILD_MANAGED_COUNT_MISMATCH');
 // A second snapshot rejects saves during lengthy inventory verification.
 const later=await (deps.readSnapshot??readM1Snapshot)(req,b.source);
 if(later.fileHash!==snapshot.fileHash||later.sourceId!==snapshot.sourceId)
  throw bad('M3_REBUILD_SOURCE_CHANGED_DURING_PREVIEW');
 return {mode:'PREVIEW',enabled:false,validationStatus:'NOT_READY',
  reasonCode:'M3_REBUILD_ATOMIC_PROFILE_SWITCH_UNIMPLEMENTED',sourceVerified:true,
  oldLogicalKey:backup.logicalKey,newLogicalKey:target.collection.key,
  backupId:backup.backupId,sourceFingerprint:snapshot.fileHash,
  originalCount:inventory.count,recordsToReembed:activeCount,tombstonesToPreserve:deletedCount,
  embeddingProfileChanged:true,stagedProfileVerified:true,activeProfilePreserved:true,inventoryVerified:true,
  targetReservationRequired:targetUnreserved,
  nextSteps:['STAGED_TARGET_PROFILE_WITHOUT_SWITCHING_ACTIVE_PROFILE',
   'BOUNDED_SERVER_REEMBED_AND_FRESH_TARGET_RECEIPTS',
   'ATOMIC_BINDING_AND_PROFILE_CUTOVER_WITH_ROLLBACK']};
}

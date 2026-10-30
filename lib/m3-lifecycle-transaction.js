/** M3e server-side restore-and-cutover transaction on the Qdrant reference
 * backend. No browser-supplied physical target, credentials, vectors or owner.
 * A claimed operation is non-replayable. Failures once the claim is made retain
 * the shared logical lock; only an administrator's later proof can settle it.
 * Public M3 /execute stays denied until independent live-host certification.
 */
import {createHash} from 'node:crypto';
import {M3ExecutionAudit} from './m3-execution-audit.js';
import {M3Store,stageM3DisposableRestore,m3LedgerCheckpoint,qdrantM3Inventory,
 assertM3ManagedCompleteness} from './m3-collections.js';
import {withM3LifecycleExclusion} from './m3-logical-exclusion.js';
import {M3CutoverJournal,guardM3CanonicalBinding} from './m3-cutover-journal.js';
import {issueM3TargetReceipt,verifyM3PhysicalTarget,resolveM3VerifiedTarget} from './m3-target-receipts.js';
import {resolveF02Binding} from './f02-public-reads.js';
import {resolveM3ReadBinding} from './m3-target-receipts.js';
import {selectedM3Profile} from './m3-source-selection.js';
import {readM1Snapshot} from './m1-saved-records.js';
import {getEmbeddingProfile} from './f09b5-embedding-profiles.js';
import {ManagedChatRegistry} from './f09b4-managed-registry.js';
import {M2JobStore} from './m2-jobs.js';
import {readF03ProvisionReceipt} from './f03-provision.js';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bad=code=>Object.assign(new Error(code),{code,status:409});
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

/** Fixed versioned smoke checks: each sampled saved vector must retrieve its
 * own physical record. Duplicate vectors may require a large top-k; failing
 * this check is a blocked cutover, not permission to loosen the verification.
 */
export async function m3QdrantSmokeQueries(transport,backup,target,{sampleSize=4}={}){
 if(typeof transport?._request!=='function'||!Number.isInteger(sampleSize)||sampleSize<1||sampleSize>8)
  throw bad('M3_SMOKE_TRANSPORT_INVALID');
 const rows=backup?.inventory?.rows;
 if(!Array.isArray(rows)||rows.length>20000)throw bad('M3_SMOKE_SOURCE_INVALID');
 const sampled=rows.length<=sampleSize?rows:rows.filter((_,i)=>i%Math.ceil(rows.length/sampleSize)===0).slice(0,sampleSize);
 for(const row of sampled){
  if(!Array.isArray(row?.vector)||row.vector.length!==backup.embedding.dimension)throw bad('M3_SMOKE_VECTOR_INVALID');
  const limit=Math.min(Math.max(rows.length,1),100);
  const response=await transport._request('POST',`/collections/${target}/points/query`,{
   query:row.vector,limit,with_payload:true,with_vector:false});
  const points=response?.result?.points;
  if(!Array.isArray(points)||!points.some(p=>String(p.id)===String(row.id)&&p.payload?.recordId===row.payload.recordId))
   throw bad('M3_SMOKE_QUERY_FAILED');
 }
 return {verified:true,sampleCount:sampled.length,version:'m3e-smoke-v1'};
}

/** Only trusted server code invokes this, with an authenticated host request,
 * a previously created M3 restore plan, and a server-configured transport.
 * No arbitrary input is accepted besides the UUID of a server-issued plan.
 * The operation executes once; post-claim errors never release the lock.
 */
export async function executeM3TrustedRestore(req,operationId,deps={}){
 if(!UUID.test(operationId??'')||!req?.s03?.userScopeId||!req.user?.directories)
  throw bad('M3_RESTORE_HOST_OR_TICKET_REQUIRED');
 const ctx=req.s03,store=deps.store?.(ctx)??new M3Store(ctx);
 const ticket=await store.read('operation',operationId);
 if(ticket.action!=='restore'||ticket.backend!=='qdrant'||ticket.owner!==ctx.userScopeId||
  !Number.isSafeInteger(ticket.expiresAt)||Date.now()>ticket.expiresAt||
  !Number.isSafeInteger(ticket.createdAt)||ticket.createdAt>Date.now())
  throw bad('M3_RESTORE_TICKET_UNTRUSTED');
 const backup=await store.read('backup',ticket.backupId);
 if(backup.schemaVersion!==1||backup.backend!=='qdrant'||backup.owner!==ctx.userScopeId||
  backup.logicalKey!==ticket.logicalKey||backup.physicalName!==ticket.physicalName||
  backup.savedSourceFingerprint!==ticket.sourceFingerprint||
  backup.inventory?.digest!==ticket.inventoryDigest||
  backup.inventory?.count!==backup.inventory?.rows?.length||
  backup.inventory?.digest!==digest(backup.inventory.rows)||
  backup.managed?.fingerprint!==ticket.managedFingerprint||
  (backup.routingGeneration??0)!==(ticket.routingGeneration??0)||
  (backup.canonicalPhysicalName??backup.physicalName)!==(ticket.canonicalPhysicalName??ticket.physicalName))
  throw bad('M3_RESTORE_BACKUP_BINDING_INVALID');
 const transport=deps.transport?await deps.transport(req,ticket):
  (typeof deps.backendPool?.getTrusted==='function'?await deps.backendPool.getTrusted(ctx,'qdrant',ticket.configId):null);
 if(typeof transport?._request!=='function')throw bad('M3_RESTORE_SERVER_TRANSPORT_REQUIRED');
 const journal=new M3CutoverJournal(ctx,{backend:'qdrant',logicalKey:ticket.logicalKey});
 let beforeClaim=true;
 const outcome=await withM3LifecycleExclusion(ctx,{backend:'qdrant',logicalKey:ticket.logicalKey,operationId},async holder=>{
  try{
   const profile=deps.getProfile?await deps.getProfile(ctx):await selectedM3Profile(req,ticket.source);
   if(profile?.configured!==true||!eq(profile.profile,backup.embedding))throw bad('M3_RESTORE_PROFILE_CHANGED');
   const bound=await (deps.bind??resolveF02Binding)(req,{backend:'qdrant',source:ticket.source,
    embedding:backup.embedding,configId:ticket.configId},{reserve:false,readAlias:true});
   const canonical=bound?.binding;
   if(canonical?.scope?.userScopeId!==ctx.userScopeId||canonical.scope?.sourceId!==backup.sourceId||
    canonical.collection?.key!==ticket.logicalKey||
    canonical.collection?.physicalName!==(ticket.canonicalPhysicalName??ticket.physicalName))
    throw bad('M3_RESTORE_BINDING_CHANGED');
   const binding=await (deps.resolveLiveBinding??resolveM3ReadBinding)(ctx,canonical,{transport});
   if(binding.collection.physicalName!==ticket.physicalName||
    (binding.collection.generation??0)!==(ticket.routingGeneration??0))
    throw bad('M3_RESTORE_STALE_GENERATION');
   const receipt=await (deps.receipt??readF03ProvisionReceipt)(ctx,canonical);
   if(receipt?.state!=='SCHEMA_VERIFIED_OFFLINE_UNCERTIFIED')throw bad('M3_RESTORE_F03_RECEIPT_REQUIRED');
   await (deps.jobs?.(ctx)??new M2JobStore(ctx)).assertNoLease(ticket.logicalKey);
   const snapshot=await (deps.readSnapshot??readM1Snapshot)(req,ticket.source);
   if(snapshot.fileHash!==ticket.sourceFingerprint||snapshot.sourceId!==backup.sourceId)
    throw bad('M3_RESTORE_SOURCE_CHANGED');
   const managed=await (deps.registry?.(ctx,canonical)??new ManagedChatRegistry(ctx,canonical)).read();
   if(managed.fingerprint!==ticket.managedFingerprint)throw bad('M3_RESTORE_REGISTRY_CHANGED');
   const ledger=await m3LedgerCheckpoint(ctx,ticket.logicalKey,deps);
   if(ledger.digest!==backup.operationCheckpoint.digest)throw bad('M3_RESTORE_LEDGER_CHANGED');
   const current=await (deps.inventory?deps.inventory(req,binding):qdrantM3Inventory(transport,binding));
   if(current.complete!==true||current.exclusiveOwner!==true||
    current.digest!==backup.inventory.digest||current.count!==backup.inventory.count)
    throw bad('M3_RESTORE_SOURCE_INVENTORY_CHANGED');
   assertM3ManagedCompleteness(managed,current,binding);
   await journal.assertNoRetainedPhysicalLocks([...new Set([canonical.collection.physicalName,binding.collection.physicalName])]);
   // A durable operation claim is the boundary: no retry if any following
   // operation fails, including a lost response to the target GET or PUT.
   await store.claim(operationId);beforeClaim=false;
   const audit=new M3ExecutionAudit(ctx,{operationId,logicalKey:ticket.logicalKey,action:'restore'});
   await audit.checkpoint(holder,'CLAIMED');
   await audit.checkpoint(holder,'DISPATCH_PENDING');
   const staged=await stageM3DisposableRestore(transport,backup,{operationId,holder,ctx});
   const active=await journal.resolve(canonical);
   if(active.generation!==(ticket.routingGeneration??0)||active.physicalName!==ticket.physicalName)
    throw bad('M3_RESTORE_STALE_GENERATION');
   const generation=active.generation+1;
   const observed=await verifyM3PhysicalTarget(transport,backup,staged.targetPhysicalName);
   const smoke=await (deps.smoke??m3QdrantSmokeQueries)(transport,backup,staged.targetPhysicalName);
   if(smoke?.verified!==true)throw bad('M3_RESTORE_SMOKE_UNVERIFIED');
   await audit.checkpoint(holder,'PHYSICAL_VERIFIED',{detail:{digest:observed.inventoryDigest,count:observed.count}});
   await issueM3TargetReceipt(ctx,{transport,backup,operationId,
    targetPhysicalName:staged.targetPhysicalName,generation});
   // Stable digest across PREPARED and PUBLISHED: no receipt or owner data
   // from a browser. Recheck saved snapshot and inventory immediately before
   // publishing, while the logical exclusion lock is still held.
   const proof={...observed,exclusiveOwner:true,receiptVerified:true,
    smokeVerified:true,smokeVersion:smoke.version,generation};
   await journal.prepare(canonical,{operationId,targetPhysicalName:staged.targetPhysicalName,
    backupDigest:digest(backup),proof,holder});
   const currentSource=await (deps.readSnapshot??readM1Snapshot)(req,ticket.source);
   const fresh=await verifyM3PhysicalTarget(transport,backup,staged.targetPhysicalName);
   if(currentSource.fileHash!==ticket.sourceFingerprint||fresh.inventoryDigest!==proof.inventoryDigest)
    throw bad('M3_RESTORE_CHANGED_BEFORE_PUBLICATION');
   await journal.publish(canonical,{operationId,proof,holder});
   await audit.checkpoint(holder,'JOURNAL_PUBLISHED',{detail:{generation,target:staged.targetPhysicalName}});
   const published=await resolveM3VerifiedTarget(ctx,canonical,{transport,backup});
   if(published.collection.physicalName!==staged.targetPhysicalName||published.collection.generation!==generation)
    throw bad('M3_RESTORE_PUBLISHED_VERIFICATION_FAILED');
   await audit.checkpoint(holder,'COMMITTED');
   return {state:'VERIFIED',operationId,logicalKey:ticket.logicalKey,
    generation,physicalName:staged.targetPhysicalName,restoredCount:observed.count,
    smokeCount:smoke.sampleCount,productionCertified:false};
  }catch(error){
   // Before the claim we can safely release the lock, while keeping the
   // unconsumed plan unchanged. Post-claim failure is BLOCKED_UNCERTAIN.
   if(beforeClaim)return {state:'FAILED',error};
   throw error;
  }
 });
 if(outcome?.state==='FAILED'&&outcome.error)throw outcome.error;
 return outcome;
}

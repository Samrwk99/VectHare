/** M4b: authenticated Vectra collection preview, logical backup,
 * guarded deletion and generation-based restore/scoped-empty transactions.
 * Never accept collection names, owners, paths, vectors, or embedding data from HTTP.
 */
import {randomUUID,createHash} from 'node:crypto';
import path from 'node:path';
import {resolveF02Binding} from './f02-public-reads.js';
import {selectedM3Profile} from './m3-source-selection.js';
import {readM1Snapshot} from './m1-saved-records.js';
import {readF03ProvisionReceipt} from './f03-provision.js';
import {ManagedChatRegistry} from './f09b4-managed-registry.js';
import {M2JobStore} from './m2-jobs.js';
import {m3LedgerCheckpoint,M3Store,assertM3ManagedCompleteness} from './m3-collections.js';
import {runtimeWriterBoundary} from './f09c10-runtime-boundary.js';
import {CooperativeWriterBoundary} from './f09c5-writer-boundary.js';
import {withM3LifecycleExclusion} from './m3-logical-exclusion.js';
import {M3ExecutionAudit} from './m3-execution-audit.js';
import {CollectionRegistry} from './s02-registry.js';
import {m4bVectraLifecycleAdapter} from './m4b-vectra-contract.js';
import {resolveM4bVectraReadBinding} from './m4b-vectra-cutover.js';
import {planM4bVectraTransition,executeM4bVectraTransition} from './m4b-vectra-transactions.js';



const sha=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const KEY=/^[a-f0-9]{64}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const fail=(code,status=409)=>{throw Object.assign(new Error(code),{code,status});};
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const exact=(x,keys)=>object(x)&&Object.keys(x).every(k=>keys.includes(k));
const DELETE_CONFIRM='DELETE OWNED VECTRA COLLECTION';
export function validateM4bVectraSelector(body,{backup=false}={}){
 if(!exact(body,['backend','configId','source',...(backup?['confirmation']:[])])||
    body.backend!=='vectra'||!['default',undefined].includes(body.configId))fail('M4B_SELECTOR_INVALID',400);
 const fields={chat:['kind','avatar','chatFile'],'group-chat':['kind','groupId','chatFile'],lorebook:['kind','name']}[body.source?.kind];
 if(!fields||!exact(body.source,fields)||fields.some(k=>typeof body.source[k]!=='string'||
    !body.source[k]||body.source[k].length>220))fail('M4B_SOURCE_SELECTOR_INVALID',400);
 if(backup&&body.confirmation!=='CAPTURE OWNED LOGICAL BACKUP')fail('M4B_BACKUP_CONFIRMATION_REQUIRED',403);
 return body;
}
async function context(req,intent,deps={}){
 if(!req?.s03?.userScopeId||!req.user?.directories)fail('M4B_HOST_AUTH_REQUIRED',403);
 const profile=await (deps.getProfile??selectedM3Profile)(req,intent.source);
 if(!profile?.configured||!profile.profile||profile.selected)fail('M4B_PROFILE_UNSUPPORTED');
 const {binding}=await (deps.bind??resolveF02Binding)(req,{backend:'vectra',
  configId:'default',source:intent.source,embedding:profile.profile},{reserve:false,readAlias:true});
 const snapshot=await (deps.readSnapshot??readM1Snapshot)(req,intent.source);
 if(binding?.backend!=='vectra'||!KEY.test(binding.collection?.key??'')||
    binding.scope?.userScopeId!==req.s03.userScopeId||
    binding.scope.sourceId!==snapshot.sourceId||JSON.stringify(binding.embedding)!==JSON.stringify(profile.profile))
  fail('M4B_BINDING_UNTRUSTED',403);
 const receipt=await (deps.receipt??readF03ProvisionReceipt)(req.s03,binding);
 if(receipt?.state!=='SCHEMA_VERIFIED_OFFLINE_UNCERTIFIED')fail('M4B_PROVISION_RECEIPT_REQUIRED');
 const managed=await (deps.registry?.(req.s03,binding)??new ManagedChatRegistry(req.s03,binding)).read();
 if(Object.values(managed.records).some(r=>!['ACTIVE','DELETED'].includes(r.state)))fail('M4B_MANAGED_PENDING_REVIEW');
 await (deps.jobs?.(req.s03)??new M2JobStore(req.s03)).assertNoLease(binding.collection.key);
 const routed=await (deps.resolveVectraBinding??resolveM4bVectraReadBinding)(req.s03,binding,{makeIndex:deps.makeVectraIndex});
 const connection=await deps.createVectra?.(req,routed);
 if(!connection?.index||!connection?.s08ServerSchema)fail('M4B_TRUSTED_INDEX_REQUIRED',403);
 return {binding:routed,canonical:binding,snapshot,profile:profile.profile,managed,connection,requestContext:req.s03};
}
function adapterFor(ctx,requireLifecycleProof=null){
 const {binding}=ctx;
 // Called only *inside* runtimeWriterBoundary's cross-process cooperative
 // logical + physical exclusion. An injected external writer is not certified.
 return m4bVectraLifecycleAdapter({backend:ctx.connection,binding,ctx:ctx.requestContext,writerBoundary:async work=>work(),requireLifecycleProof});
}
function inventoryShape(scan,binding){
 if(!scan?.fullPhysicalScan||scan.ownerVerified!==true||!Array.isArray(scan.items)||
   scan.count!==scan.items.length||scan.count>20000||scan.logicalFingerprint!==sha(scan.items))
  fail('M4B_INVENTORY_UNVERIFIABLE');
 const rows=scan.items.map(row=>({id:row.physicalId,vector:row.vector,payload:row}));
 // Canonical sorting from adapter ensures stable digest for repeated checks.
 return {rows,count:rows.length,digest:sha(rows),complete:true,exclusiveOwner:true};
}
function enforceOwned(managed,scan,binding){
 const inv=inventoryShape(scan,binding);
 assertM3ManagedCompleteness(managed,inv,binding);
 return inv;
}
async function lock(req,binding,deps,work){
 const plan={backend:'vectra',scope:binding.scope,collectionKey:binding.collection.key,
  physicalCollectionName:binding.collection.physicalName,operationId:randomUUID()};
 const boundary=deps.boundary?.(req.s03,plan)??await runtimeWriterBoundary(req.s03,plan);
 return boundary.withWriteBoundary(plan,work);
}
async function reattest(req,intent,original,deps){
 const fresh=await context(req,intent,deps);
 if(fresh.binding.collection.physicalName!==original.binding.collection.physicalName||
   fresh.binding.collection.key!==original.binding.collection.key||
   fresh.snapshot.fileHash!==original.snapshot.fileHash||
   fresh.managed.fingerprint!==original.managed.fingerprint||
   JSON.stringify(fresh.profile)!==JSON.stringify(original.profile))fail('M4B_SOURCE_CHANGED');
 return fresh;
}
export async function previewM4bVectra(req,deps={}){
 const intent=validateM4bVectraSelector(req.body),start=await context(req,intent,deps);
 return lock(req,start.binding,deps,async()=>{
  const live=await reattest(req,intent,start,deps),adapter=adapterFor(live);
  const inv=enforceOwned(live.managed,await adapter.getInventory(),live.binding);
  return {backend:'vectra',logicalKey:live.binding.collection.key,recordCount:inv.count,
   inventoryDigest:inv.digest,ownerVerified:true,completePhysicalInventory:true,
   operationModes:{backup:'ENABLED',restore:'ENABLED',delete:live.binding.collection.generation?'BLOCKED':'ENABLED',empty:'ENABLED'},
   validationStatus:'AWAITING_MANUAL_TEST',productionWritesEnabled:false};
 });
}
export async function captureM4bVectraBackup(req,deps={}){
 const intent=validateM4bVectraSelector(req.body,{backup:true});
 const start=await context(req,intent,deps);
 return lock(req,start.binding,deps,async()=>{
  const live=await reattest(req,intent,start,deps),adapter=adapterFor(live);
  const checkpoint=await m3LedgerCheckpoint(req.s03,live.binding.collection.key,deps);
  const first=enforceOwned(live.managed,await adapter.getInventory(),live.binding);
  const second=enforceOwned(live.managed,await adapter.getInventory(),live.binding);
  if(first.digest!==second.digest||first.count!==second.count)fail('M4B_INVENTORY_CHANGED');
  const checkpointAfter=await m3LedgerCheckpoint(req.s03,live.binding.collection.key,deps);
  if(checkpoint.digest!==checkpointAfter.digest)fail('M4B_LEDGER_CHANGED');
  await reattest(req,intent,start,deps);
  const doc={schemaVersion:1,backupId:randomUUID(),owner:req.s03.userScopeId,
   backend:'vectra',logicalKey:live.binding.collection.key,
   physicalName:live.binding.collection.physicalName,canonicalPhysicalName:live.canonical.collection.physicalName,
   routingGeneration:live.binding.collection.generation??0,scope:live.binding.scope,
   embedding:live.profile,source:intent.source,configId:'default',
   sourceId:live.snapshot.sourceId,savedSourceFingerprint:live.snapshot.fileHash,
   managed:{records:live.managed.records,fingerprint:live.managed.fingerprint},
   operationCheckpoint:checkpoint,
   inventory:first,createdAt:new Date().toISOString(),
   excludes:['SillyTavern saved chat files','server credentials','external/unmanaged collections'],
   productionCertified:false};
  await (deps.store?.(req.s03)??new M3Store(req.s03)).write('backup',doc);
  return {state:'VERIFIED',backupId:doc.backupId,backend:'vectra',logicalKey:doc.logicalKey,
   count:first.count,inventoryDigest:first.digest,scopeOwned:true,
   physicalBackupVerified:true,productionCertified:false};
 });
}
export async function verifyM4bVectraBackup(req,id,deps={}){
 if(!req?.s03?.userScopeId||!req.user?.directories)fail('M4B_HOST_AUTH_REQUIRED',403);
 if(!UUID.test(id??''))fail('M4B_BACKUP_ID_INVALID',400);
 const doc=await (deps.store?.(req.s03)??new M3Store(req.s03)).read('backup',id);
 if(doc.schemaVersion!==1||doc.backend!=='vectra'||!KEY.test(doc.logicalKey??'')||
   !Array.isArray(doc.inventory?.rows)||doc.inventory.complete!==true||doc.inventory.exclusiveOwner!==true||
   doc.inventory.count!==doc.inventory.rows.length||doc.inventory.digest!==sha(doc.inventory.rows)||
   !doc.inventory.rows.every(row=>row.id===row.payload?.physicalId&&
      Array.isArray(row.vector)&&JSON.stringify(row.vector)===JSON.stringify(row.payload.vector)))
  fail('M4B_BACKUP_INTEGRITY_INVALID');
 return {backend:'vectra',backupId:id,logicalKey:doc.logicalKey,recordCount:doc.inventory.count,
  createdAt:doc.createdAt,inventoryDigest:doc.inventory.digest,integrityVerified:true,
  excludes:doc.excludes,productionCertified:false};
}
/** Only the immutable user-private backup is authority for a destructive
 * plan. A matching live snapshot, exact physical inventory, stable ledger,
 * managed registry and S02 reservation are independently checked again before
 * dispatch. The body never supplies a physical collection or ownership claim.
 */
function deletePlanSelector(body){
 if(!exact(body,['backend','source','configId','backupId'])||!UUID.test(body?.backupId??''))
  fail('M4B_DELETE_PLAN_SELECTOR_INVALID',400);
 validateM4bVectraSelector({backend:body.backend,source:body.source,configId:body.configId});
 return body;
}
function deleteExecuteSelector(body){
 if(!exact(body,['operationId','confirmation'])||!UUID.test(body?.operationId??'')||
    body.confirmation!==DELETE_CONFIRM)fail('M4B_DELETE_CONFIRMATION_REQUIRED',403);
 return body;
}
async function attestDelete(req,intent,backup,deps){
 const live=await context(req,intent,deps);
 if(backup?.schemaVersion!==1||backup.backend!=='vectra'||backup.owner!==req.s03.userScopeId||
   backup.logicalKey!==live.binding.collection.key||backup.physicalName!==live.binding.collection.physicalName||
   backup.sourceId!==live.snapshot.sourceId||backup.savedSourceFingerprint!==live.snapshot.fileHash||
   backup.managed?.fingerprint!==live.managed.fingerprint||
   JSON.stringify(backup.source)!==JSON.stringify(intent.source)||
   JSON.stringify(backup.scope)!==JSON.stringify(live.binding.scope)||
   JSON.stringify(backup.embedding)!==JSON.stringify(live.profile)||
   backup.inventory?.complete!==true||backup.inventory?.exclusiveOwner!==true||
   backup.inventory?.count!==backup.inventory.rows?.length||
   backup.inventory?.digest!==sha(backup.inventory.rows))fail('M4B_DELETE_BACKUP_OR_SOURCE_CHANGED');
 const checkpoint=await m3LedgerCheckpoint(req.s03,live.binding.collection.key,deps);
 if(checkpoint.digest!==backup.operationCheckpoint?.digest)fail('M4B_DELETE_LEDGER_CHANGED');
 const inv=enforceOwned(live.managed,await adapterFor(live).getInventory(),live.binding);
 if(inv.digest!==backup.inventory.digest||inv.count!==backup.inventory.count)
  fail('M4B_DELETE_PHYSICAL_CHANGED');
 const s02=deps.s02?.(req.s03)??new CollectionRegistry(path.join(req.s03.vectorsPath,'.similharity'));
 const entry=await s02.lookup({backend:'vectra',scope:live.binding.scope,embedding:live.profile});
 if(entry?.key!==backup.logicalKey||entry?.physicalName!==backup.physicalName||
    entry?.status!=='RESERVED_NOT_ACTIVE')fail('M4B_DELETE_REGISTRY_NOT_ACTIVE');
 return {live,s02};
}
export async function planM4bVectraDelete(req,deps={}){
 const body=deletePlanSelector(req.body),store=deps.store?.(req.s03)??new M3Store(req.s03);
 const backup=await store.read('backup',body.backupId);
 const intent={backend:'vectra',source:body.source,configId:body.configId};
 const start=await context(req,intent,deps);
 return lock(req,start.binding,deps,async()=>{
  await attestDelete(req,intent,backup,deps);
  // Recheck physical and source once more before issuing the one-use ticket.
  await attestDelete(req,intent,backup,deps);
  const operationId=randomUUID(),createdAt=Date.now(),expiresAt=createdAt+5*60*1000;
  const ticket={schemaVersion:1,operationId,owner:req.s03.userScopeId,action:'delete',
   backend:'vectra',phase:'PLANNED',logicalKey:backup.logicalKey,
   physicalName:backup.physicalName,backupId:backup.backupId,
   source:body.source,configId:'default',sourceFingerprint:backup.savedSourceFingerprint,
   inventoryDigest:backup.inventory.digest,managedFingerprint:backup.managed.fingerprint,
   createdAt,expiresAt};
  await store.write('operation',ticket);
  return {state:'PLANNED',operationId,backupId:backup.backupId,backend:'vectra',
   logicalKey:backup.logicalKey,recordCount:backup.inventory.count,
   expiresAt,requiredConfirmation:DELETE_CONFIRM,oneUse:true,productionCertified:false};
 });
}
export async function executeM4bVectraDelete(req,deps={}){
 const {operationId}=deleteExecuteSelector(req.body);
 if(!req?.s03?.userScopeId||!req.user?.directories)fail('M4B_HOST_AUTH_REQUIRED',403);
 const ctx=req.s03,store=deps.store?.(ctx)??new M3Store(ctx);
 const ticket=await store.read('operation',operationId);
 if(ticket.owner!==ctx.userScopeId||ticket.backend!=='vectra'||ticket.action!=='delete'||
    ticket.phase!=='PLANNED'||ticket.expiresAt<Date.now()||ticket.createdAt>Date.now()||
    !KEY.test(ticket.logicalKey??''))fail('M4B_DELETE_TICKET_UNTRUSTED');
 const intent={backend:'vectra',source:ticket.source,configId:'default'};
 const backup=await store.read('backup',ticket.backupId);
 if(backup.logicalKey!==ticket.logicalKey||backup.physicalName!==ticket.physicalName||
    backup.inventory.digest!==ticket.inventoryDigest||backup.managed.fingerprint!==ticket.managedFingerprint||
    backup.savedSourceFingerprint!==ticket.sourceFingerprint)fail('M4B_DELETE_PLAN_MISMATCH');
 let claimed=false;
 const result=await withM3LifecycleExclusion(ctx,{backend:'vectra',logicalKey:ticket.logicalKey,operationId},async holder=>{
  // Matching physical writer lock is retained on any post-claim uncertainty.
  const physical=new CooperativeWriterBoundary({root:path.join(ctx.vectorsPath,'.similharity','f09c10-writer-locks'),
   backend:'vectra',physicalName:ticket.physicalName});
  const gate={backend:'vectra',scope:backup.scope,collectionKey:ticket.logicalKey,
   physicalCollectionName:ticket.physicalName,operationId};
  try{
   return await physical.withWriteBoundary(gate,async()=>{
    try{
     const first=await attestDelete(req,intent,backup,deps);
     const checked=await attestDelete(req,intent,backup,deps);
     if(first.live.binding.collection.physicalName!==checked.live.binding.collection.physicalName)
      fail('M4B_DELETE_REATTESTATION_CHANGED');
     await store.claim(operationId);claimed=true;
     const audit=new M3ExecutionAudit(ctx,{operationId,logicalKey:ticket.logicalKey,action:'delete',backend:'vectra'});
     await audit.checkpoint(holder,'CLAIMED');
     const rows=backup.inventory.rows.map(r=>r.payload);
     const pack={format:'VH_VECTRA_LOGICAL_V1',backend:'vectra',collectionKey:ticket.logicalKey,
      physicalName:ticket.physicalName,scope:backup.scope,embedding:backup.embedding,
      items:rows,count:rows.length,logicalFingerprint:sha(rows)};
     const adapter=adapterFor(checked.live,async proof=>({authorized:proof.kind==='deleteCollection'&&
      proof.collectionKey===ticket.logicalKey&&proof.operationId===operationId,
      consumed:claimed,backupVerified:true,operationId}));
     await audit.checkpoint(holder,'DISPATCH_PENDING');
     const dropped=await adapter.deleteCollection({backup:{...pack,checksum:sha(pack)},operationId});
     if(dropped.status!=='VERIFIED')fail('M4B_DELETE_OUTCOME_UNCERTAIN');
     await audit.checkpoint(holder,'PHYSICAL_VERIFIED',{detail:{physicalName:ticket.physicalName,absent:true}});
     const tombstone=await checked.s02.tombstone({backend:'vectra',scope:backup.scope,
      embedding:backup.embedding},{operationId,backupId:backup.backupId,physicalAbsent:true});
     if(tombstone.status!=='DELETED')fail('M4B_DELETE_TOMBSTONE_UNVERIFIED');
     await store.write('deletion',{schemaVersion:1,owner:ctx.userScopeId,operationId,
      backupId:backup.backupId,logicalKey:ticket.logicalKey,physicalName:ticket.physicalName,
      inventoryDigest:backup.inventory.digest,registryTombstoned:true,
      verifiedPhysicalAbsent:true,verifiedAt:new Date().toISOString(),productionCertified:false});
     await audit.checkpoint(holder,'COMMITTED');
     return {state:'VERIFIED',operationId,backend:'vectra',logicalKey:ticket.logicalKey,
      physicalAbsent:true,registryTombstoned:true,backupId:backup.backupId,
      productionCertified:false};
    }catch(e){if(!claimed)return {state:'FAILED',refusal:e};throw e;}
   });
  }catch(e){if(!claimed)return {state:'FAILED',refusal:e};throw e;}
 });
 if(result?.state==='FAILED'&&result.refusal)throw result.refusal;
 return result;
}
export function registerM4bVectraRoutes(router,deps={}){
 const wrap=fn=>async(req,res)=>{try{res.json({success:true,...await fn(req)});}catch(e){
  res.status(Number.isInteger(e.status)?e.status:409).json({success:false,
   code:/^(M4B_|M3_|S05_|S08_|F09C)/.test(e?.code??'')?e.code:'M4B_OPERATION_REFUSED',
   executionAllowed:false,retryable:false});}};
 router.post('/v2/m4b/vectra/collections/preview',wrap(req=>previewM4bVectra(req,deps)));
 router.post('/v2/m4b/vectra/backups/create',wrap(req=>captureM4bVectraBackup(req,deps)));
 router.get('/v2/m4b/vectra/backups/:backupId/verify',wrap(req=>verifyM4bVectraBackup(req,req.params.backupId,deps)));
 router.post('/v2/m4b/vectra/collections/delete/plan',wrap(req=>planM4bVectraDelete(req,deps)));
 router.post('/v2/m4b/vectra/collections/delete/execute',wrap(req=>executeM4bVectraDelete(req,deps)));
 router.post('/v2/m4b/vectra/collections/transition/plan',wrap(req=>planM4bVectraTransition(req,deps)));
 router.post('/v2/m4b/vectra/collections/transition/execute',wrap(req=>executeM4bVectraTransition(req,deps)));

}
// Server-internal helpers for the separately guarded Vectra generation paths.
export {context as resolveM4bLifecycleContext,adapterFor as m4bLifecycleAdapterFor,
 enforceOwned as verifyM4bOwnedInventory};

/** M3f server-internal, one-shot owned canonical Qdrant decommission.
 * Never exposed through public /v2/m3/collections/execute. Requires a complete
 * immutable logical backup, trusted source and owner, no active job/lock/write,
 * exact physical inventory, durable claim and proven physical absence before
 * creating an S02 terminal tombstone. A post-claim failure RETAINS the logical
 * lock for administrator adjudication; never replay a DELETE.
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import {M3ExecutionAudit} from './m3-execution-audit.js';
import {createHash} from 'node:crypto';
import {M3Store,qdrantM3Inventory,assertM3ManagedCompleteness,m3LedgerCheckpoint} from './m3-collections.js';
import {withM3LifecycleExclusion} from './m3-logical-exclusion.js';
import {M3CutoverJournal} from './m3-cutover-journal.js';
import {resolveM3ReadBinding} from './m3-target-receipts.js';
import {selectedM3Profile,readM3SourceSelection} from './m3-source-selection.js';
import {resolveF02Binding} from './f02-public-reads.js';
import {readM1Snapshot} from './m1-saved-records.js';
import {readF03ProvisionReceipt} from './f03-provision.js';
import {getEmbeddingProfile} from './f09b5-embedding-profiles.js';
import {ManagedChatRegistry} from './f09b4-managed-registry.js';
import {M2JobStore} from './m2-jobs.js';
import {CollectionRegistry} from './s02-registry.js';
const sha=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const refuse=code=>Object.assign(new Error(code),{code,status:409});
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

/** The journal is the only authority for historical physical targets. Deleting
 * the active generation NEVER deletes earlier physical collections. Require an
 * owned, complete backup for every retired generation and verify its entire
 * physical inventory, including foreign-record exclusion, before dispatch.
 */
export async function attestM3RetainedGenerations(ctx,canonical,active,transport,store,deps={}){
 const journal=new M3CutoverJournal(ctx,{logicalKey:canonical.collection.key});
 const events=await journal.events();
 const retired=[];let name=canonical.collection.physicalName,generation=0;
 for(const event of events){
  if(event.state!=='PUBLISHED')continue;
  if(event.from!==name)throw refuse('M3_DELETE_HISTORY_CHAIN_BROKEN');
  retired.push({physicalName:name,generation});name=event.to;generation++;
 }
 if(name!==active.collection.physicalName||generation!==(active.collection.generation??0))
  throw refuse('M3_DELETE_HISTORY_CHANGED');
 if(retired.length===0)return [];
 if(retired.length>1000)throw refuse('M3_DELETE_HISTORY_LIMIT');
 await store.setup();
 const names=(await fs.readdir(store.root)).filter(n=>/^backup-[a-f0-9-]{36}\.json$/.test(n));
 if(names.length>20000)throw refuse('M3_DELETE_BACKUP_INVENTORY_LIMIT');
 const all=[];
 for(const file of names){
  const backup=await store.read('backup',file.slice(7,-5));
  if(backup.owner===ctx.userScopeId&&backup.backend==='qdrant'&&backup.logicalKey===canonical.collection.key&&
   backup.inventory?.complete===true&&backup.inventory?.exclusiveOwner===true&&
   backup.inventory?.digest===sha(backup.inventory.rows)&&
   equal(backup.embedding,canonical.embedding)&&equal(backup.scope,canonical.scope))all.push(backup);
 }
 const kept=[];
 for(const old of retired){
  const matches=all.filter(b=>b.physicalName===old.physicalName&&(b.routingGeneration??0)===old.generation);
  if(!matches.length&&old.generation===0&&old.physicalName===canonical.collection.physicalName){
   // A source-scoped model activation can publish a staged collection from a
   // newly RESERVED (but never provisioned) canonical name. It has no historical
   // Qdrant collection to preserve. Only a completed, source-attested selection
   // plus a fresh 404 proves this narrow exception; never infer it from absence
   // alone for ordinary restore/empty lifecycle history.
   const selected=await (deps.sourceSelection??readM3SourceSelection)(ctx,canonical.scope);
   if(selected?.toLogicalKey===canonical.collection.key&&selected.generation===1){
    try{await transport._request('GET',`/collections/${old.physicalName}`);
     throw refuse('M3_DELETE_VIRTUAL_CANONICAL_PRESENT');}
    catch(e){if(e?.httpStatus!==404)throw e;}
    kept.push({physicalName:old.physicalName,generation:old.generation,retained:false,
     classification:'UNPROVISIONED_CANONICAL_ABSENT',physicalAbsentVerified:true,deleted:false});
    continue;
   }
  }
  if(!matches.length)throw refuse('M3_DELETE_RETAINED_BACKUP_REQUIRED');
  const historicalBinding={...canonical,collection:{...canonical.collection,physicalName:old.physicalName}};
  const observed=await (deps.historicalInventory?deps.historicalInventory(historicalBinding,transport):qdrantM3Inventory(transport,historicalBinding));
  if(observed?.complete!==true||observed?.exclusiveOwner!==true||
     !matches.some(b=>b.inventory.count===observed.count&&b.inventory.digest===observed.digest))
   throw refuse('M3_DELETE_RETAINED_INVENTORY_CHANGED');
  const backup=matches.find(b=>b.inventory.count===observed.count&&b.inventory.digest===observed.digest);
  kept.push({physicalName:old.physicalName,generation:old.generation,backupId:backup.backupId,
   inventoryDigest:observed.digest,recordCount:observed.count,retained:true,deleted:false});
 }
 return kept;
}

async function prepare(req,ticket,deps){
 const ctx=req.s03,store=deps.store?.(ctx)??new M3Store(ctx),backup=await store.read('backup',ticket.backupId);
 if(backup.schemaVersion!==1||backup.owner!==ctx.userScopeId||backup.backend!=='qdrant'||
    backup.logicalKey!==ticket.logicalKey||backup.physicalName!==ticket.physicalName||
    (backup.routingGeneration??0)!==(ticket.routingGeneration??0)||
    (backup.canonicalPhysicalName??backup.physicalName)!==(ticket.canonicalPhysicalName??ticket.physicalName)||
    backup.savedSourceFingerprint!==ticket.sourceFingerprint||
    backup.inventory?.complete!==true||backup.inventory?.exclusiveOwner!==true||
    backup.inventory?.digest!==ticket.inventoryDigest||
    backup.inventory?.digest!==sha(backup.inventory?.rows)||
    backup.inventory?.count!==backup.inventory?.rows?.length||
    backup.managed?.fingerprint!==ticket.managedFingerprint)
  throw refuse('M3_DELETE_BACKUP_OR_PLAN_UNTRUSTED');
 const {binding}=await (deps.bind??resolveF02Binding)(req,{backend:'qdrant',source:ticket.source,
  embedding:backup.embedding,configId:ticket.configId},{reserve:false,readAlias:true});
 if(binding?.scope?.userScopeId!==ctx.userScopeId||binding.scope.sourceId!==backup.sourceId||
    binding.collection?.key!==ticket.logicalKey||
    binding.collection.physicalName!==(ticket.canonicalPhysicalName??ticket.physicalName)||
    !equal(binding.embedding,backup.embedding))throw refuse('M3_DELETE_BINDING_CHANGED');
 const transport=deps.transport?await deps.transport(req,ticket):
  (typeof deps.backendPool?.getTrusted==='function'?await deps.backendPool.getTrusted(ctx,'qdrant',ticket.configId):null);
 if(typeof transport?._request!=='function')throw refuse('M3_DELETE_TRUSTED_TRANSPORT_REQUIRED');
 const live=await (deps.resolveLiveBinding??resolveM3ReadBinding)(ctx,binding,{transport});
 if(live.collection.physicalName!==ticket.physicalName||
   (live.collection.generation??0)!==(ticket.routingGeneration??0))throw refuse('M3_DELETE_STALE_GENERATION');
 const profile=deps.getProfile?await deps.getProfile(ctx):await selectedM3Profile(req,ticket.source);
 if(profile?.configured!==true||!equal(profile.profile,backup.embedding))throw refuse('M3_DELETE_EMBEDDING_CHANGED');
 const receipt=await (deps.receipt??readF03ProvisionReceipt)(ctx,binding);
 if(receipt?.state!=='SCHEMA_VERIFIED_OFFLINE_UNCERTIFIED')throw refuse('M3_DELETE_PROVISION_RECEIPT_REQUIRED');
 await (deps.jobs?.(ctx)??new M2JobStore(ctx)).assertNoLease(ticket.logicalKey);
 const journal=new M3CutoverJournal(ctx,{logicalKey:ticket.logicalKey});
 await journal.assertNoRetainedPhysicalLocks([...new Set([binding.collection.physicalName,ticket.physicalName])]);
 const snap=await (deps.readSnapshot??readM1Snapshot)(req,ticket.source);
 if(snap.fileHash!==ticket.sourceFingerprint||snap.sourceId!==backup.sourceId)
  throw refuse('M3_DELETE_SOURCE_CHANGED');
 const managed=await (deps.registry?.(ctx,binding)??new ManagedChatRegistry(ctx,binding)).read();
 if(managed.fingerprint!==backup.managed.fingerprint)throw refuse('M3_DELETE_MANAGED_CHANGED');
 const ledger=await m3LedgerCheckpoint(ctx,ticket.logicalKey,deps);
 if(ledger.digest!==backup.operationCheckpoint.digest)throw refuse('M3_DELETE_LEDGER_CHANGED');
 const current=await (deps.inventory?deps.inventory(req,live,transport):qdrantM3Inventory(transport,live));
 if(!current.complete||!current.exclusiveOwner||current.digest!==backup.inventory.digest||
  current.count!==backup.inventory.count)throw refuse('M3_DELETE_PHYSICAL_INVENTORY_CHANGED');
 assertM3ManagedCompleteness(managed,current,live);
 const retained=await attestM3RetainedGenerations(ctx,binding,live,transport,store,deps);
 const s02=deps.s02?.(ctx)??new CollectionRegistry(path.join(ctx.vectorsPath,'.similharity'));
 const entry=await s02.lookup({backend:'qdrant',scope:binding.scope,embedding:binding.embedding});
 if(entry?.key!==ticket.logicalKey||entry.status!=='RESERVED_NOT_ACTIVE'||
  entry.physicalName!==(ticket.canonicalPhysicalName??ticket.physicalName))throw refuse('M3_DELETE_S02_BINDING_UNAVAILABLE');
 return {backup,binding,live,transport,s02,retained};
}

export async function executeM3TrustedDecommission(req,operationId,deps={}){
 if(!req?.s03?.userScopeId||!req.user?.directories||!UUID.test(operationId??''))
  throw refuse('M3_DELETE_HOST_OR_TICKET_REQUIRED');
 const ctx=req.s03,store=deps.store?.(ctx)??new M3Store(ctx);
 const ticket=await store.read('operation',operationId);
 if(ticket.owner!==ctx.userScopeId||ticket.action!=='delete'||ticket.backend!=='qdrant'||
   !Number.isSafeInteger(ticket.expiresAt)||ticket.expiresAt<Date.now()||
   !Number.isSafeInteger(ticket.createdAt)||ticket.createdAt>Date.now()||
   ticket.phase!=='PLANNED')throw refuse('M3_DELETE_TICKET_UNTRUSTED');
 let claimed=false;
 const result=await withM3LifecycleExclusion(ctx,{backend:'qdrant',logicalKey:ticket.logicalKey,operationId},async holder=>{
  try{
   let checked=await prepare(req,ticket,deps);
   // The trust boundary for irreversible dispatch is an immutable one-use
   // claim. Re-attest source and inventory while the logical lease is held.
   checked=await prepare(req,ticket,deps);
   await store.claim(operationId);claimed=true;
   const audit=new M3ExecutionAudit(ctx,{operationId,logicalKey:ticket.logicalKey,action:'delete'});
   await audit.checkpoint(holder,'CLAIMED');
   await audit.checkpoint(holder,'DISPATCH_PENDING');
   const route=`/collections/${ticket.physicalName}`;
   const ack=await checked.transport._request('DELETE',route);
   if(ack?.result!==true)throw refuse('M3_DELETE_QDRANT_OUTCOME_UNCERTAIN');
   try{
    await checked.transport._request('GET',route);
    throw refuse('M3_DELETE_COLLECTION_STILL_PRESENT');
   }catch(e){if(e?.httpStatus!==404)throw e;}
   await audit.checkpoint(holder,'PHYSICAL_VERIFIED',{detail:{physicalName:ticket.physicalName,absent:true}});
   // The source and physical collection identity are still held by the same
   // logical lease. Tombstone prevents a later bind from recreating the name.
   const tombstone=await checked.s02.tombstone({backend:'qdrant',scope:checked.binding.scope,
    embedding:checked.binding.embedding},{operationId,backupId:checked.backup.backupId,physicalAbsent:true});
   const receipt={schemaVersion:1,owner:ctx.userScopeId,operationId,backupId:checked.backup.backupId,
    logicalKey:ticket.logicalKey,physicalName:ticket.physicalName,canonicalPhysicalName:checked.binding.collection.physicalName,
    routingGeneration:ticket.routingGeneration??0,retainedHistoricalCollections:checked.retained.filter(x=>x.retained),
    unprovisionedCanonicalEvidence:checked.retained.filter(x=>!x.retained),
    historicalCollectionsDeleted:false,
    inventoryDigest:checked.backup.inventory.digest,verifiedPhysicalAbsent:true,
    registryTombstoned:tombstone.status==='DELETED',verifiedAt:new Date().toISOString(),productionCertified:false};
   await store.write('deletion',receipt);
   await audit.checkpoint(holder,'COMMITTED',{detail:{tombstone:tombstone.status,backupId:checked.backup.backupId}});
   return {state:'VERIFIED',operationId,logicalKey:ticket.logicalKey,
    physicalAbsent:true,registryTombstoned:true,backupId:checked.backup.backupId,
    deletedActivePhysicalName:ticket.physicalName,retainedHistoricalCollections:checked.retained.filter(x=>x.retained),
    unprovisionedCanonicalEvidence:checked.retained.filter(x=>!x.retained),
    historicalCollectionsDeleted:false,
    productionCertified:false};
  }catch(e){if(!claimed)return {state:'FAILED',refusal:e};throw e;}
 });
 if(result?.state==='FAILED'&&result.refusal)throw result.refusal;
 return result;
}

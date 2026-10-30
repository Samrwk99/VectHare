/** M4a.4 one-use source-bound LanceDB restore and scoped empty. Nothing here
 * accepts a physical database name, owner, vector or embedding from HTTP.
 * After a durable claim, *any* error retains the logical collection lock.
 */
import {randomUUID,createHash} from 'node:crypto';
import {M3Store,m3LedgerCheckpoint} from './m3-collections.js';
import {resolveM4aLifecycleContext,m4aLifecycleAdapterFor,verifyM4aOwnedInventory,
 validateM4aLanceSelector} from './m4a-lancedb-lifecycle.js';
import {withM3LifecycleExclusion} from './m3-logical-exclusion.js';
import {M3CutoverJournal} from './m3-cutover-journal.js';
import {M3ExecutionAudit} from './m3-execution-audit.js';
import {stageM4aLanceTarget} from './m4a-lancedb-stage.js';
import {tombstoneM3ManagedSnapshot} from './m3-empty-transaction.js';
import {ManagedChatRegistry} from './f09b4-managed-registry.js';
import {CollectionRegistry} from './s02-registry.js';
import path from 'node:path';
const H=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const KEY=/^[a-f0-9]{64}$/;
const fail=(code,status=409)=>{throw Object.assign(new Error(code),{code,status});};
const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const CONFIRM={restore:'RESTORE OWNED LANCEDB COLLECTION',empty:'EMPTY OWNED LANCEDB COLLECTION'};
export function validateM4aTransitionPlan(body){
 if(!body||typeof body!=='object'||Array.isArray(body)||
  Object.keys(body).some(k=>!['backend','configId','source','backupId','action'].includes(k))||
  !['restore','empty'].includes(body.action)||!UUID.test(body.backupId??''))fail('M4A_TRANSITION_SELECTOR_INVALID',400);
 validateM4aLanceSelector({backend:body.backend,source:body.source,configId:body.configId});
 return body;
}
export function validateM4aTransitionExecute(body){
 if(!body||typeof body!=='object'||Array.isArray(body)||
  Object.keys(body).sort().join(',')!=='confirmation,operationId'||!UUID.test(body.operationId??''))
  fail('M4A_TRANSITION_EXECUTE_INVALID',400);
 if(!Object.values(CONFIRM).includes(body.confirmation))fail('M4A_TRANSITION_CONSENT_REQUIRED',403);
 return body;
}
/** Authoritative source, registry, ledger, backup and full physical inventory
 * must match exactly. This deliberately declines stale historical backups:
 * their reconciliation needs a separate evidence-driven recovery action.
 */
async function attest(req,ticket,backup,deps={}){
 const intent={backend:'lancedb',source:ticket.source,configId:'default'};
 const live=await resolveM4aLifecycleContext(req,intent,deps);
 if(backup.schemaVersion!==1||backup.backend!=='lancedb'||backup.owner!==req.s03.userScopeId||
   backup.backupId!==ticket.backupId||backup.logicalKey!==ticket.logicalKey||
   backup.physicalName!==ticket.physicalName||backup.inventory?.count!==backup.inventory?.rows?.length||
   backup.inventory?.digest!==H(backup.inventory.rows)||backup.inventory?.exclusiveOwner!==true||
   backup.inventory?.complete!==true||!eq(backup.scope,live.binding.scope)||
   !eq(backup.embedding,live.profile)||!eq(backup.source,ticket.source)||
   backup.sourceId!==live.snapshot.sourceId||backup.savedSourceFingerprint!==live.snapshot.fileHash||
   (backup.canonicalPhysicalName??backup.physicalName)!==live.canonical.collection.physicalName)
  fail('M4A_TRANSITION_BACKUP_OR_SOURCE_CHANGED');
 const checkpoint=await m3LedgerCheckpoint(req.s03,backup.logicalKey,deps);
 if(checkpoint.digest!==backup.operationCheckpoint?.digest)fail('M4A_TRANSITION_LEDGER_CHANGED');
 const currentGeneration=live.binding.collection.generation??0;
 const originalGeneration=backup.routingGeneration??0;
 const direct=backup.managed?.fingerprint===live.managed.fingerprint&&
   originalGeneration===currentGeneration&&backup.physicalName===live.binding.collection.physicalName;
 let historicalRestore=false;
 if(!direct){
  // Narrow, verifiable undo of the immediately preceding scoped-empty. Never
  // restore a stale or arbitrarily selected historical backup, especially if
  // the user subsequently changed any saved record or wrote a new vector.
  if(ticket.action!=='restore'||currentGeneration!==originalGeneration+1||
     !KEY.test(backup.managed?.fingerprint??''))
   fail('M4A_TRANSITION_BACKUP_OR_SOURCE_CHANGED');
  const before={...live.managed,records:structuredClone(backup.managed.records)};
  const expected=tombstoneM3ManagedSnapshot(before);
  if(H(expected)!==live.managed.fingerprint)fail('M4A_HISTORICAL_REGISTRY_NOT_TOMBSTONED');
  const journal=new M3CutoverJournal(req.s03,{backend:'lancedb',logicalKey:backup.logicalKey});
  const events=await journal.events();const publication=events.at(-1);
  if(publication?.state!=='PUBLISHED'||publication.from!==backup.physicalName)
   fail('M4A_HISTORICAL_NOT_IMMEDIATE_EMPTY');
  const oldTicket=await (deps.store?.(req.s03)??new M3Store(req.s03)).read('operation',publication.operationId);
  if(oldTicket.action!=='empty'||oldTicket.backupId!==backup.backupId)
   fail('M4A_HISTORICAL_NOT_IMMEDIATE_EMPTY');
  const receipt=await (deps.store?.(req.s03)??new M3Store(req.s03)).read('target',publication.operationId);
  const emptyBackup=await (deps.store?.(req.s03)??new M3Store(req.s03)).read('backup',receipt.backupId);
  if(emptyBackup.purpose!=='SCOPED_EMPTY_TARGET'||emptyBackup.derivedFromBackupId!==backup.backupId||
     emptyBackup.inventory.count!==0||emptyBackup.inventory.digest!==H([])||
     receipt.physicalName!==live.binding.collection.physicalName||
     receipt.generation!==currentGeneration)
   fail('M4A_HISTORICAL_EMPTY_EVIDENCE_INVALID');
  historicalRestore=true;
 }
 if(ticket.expectedActivePhysicalName!==undefined&&
    (ticket.expectedActivePhysicalName!==live.binding.collection.physicalName||
     ticket.expectedActiveGeneration!==currentGeneration))
  fail('M4A_TRANSITION_ACTIVE_CHANGED');
 const observed=verifyM4aOwnedInventory(live.managed,
  await m4aLifecycleAdapterFor(live).getInventory(),live.binding);
 const expectedDigest=historicalRestore?H([]):backup.inventory.digest;
 const expectedCount=historicalRestore?0:backup.inventory.count;
 if(observed.digest!==expectedDigest||observed.count!==expectedCount)
  fail('M4A_TRANSITION_PHYSICAL_CHANGED');
 const s02=deps.s02?.(req.s03)??new CollectionRegistry(path.join(req.s03.vectorsPath,'.similharity'));
 const entry=await s02.lookup({backend:'lancedb',scope:backup.scope,embedding:backup.embedding});
 if(entry?.key!==backup.logicalKey||entry.physicalName!==live.canonical.collection.physicalName||
   entry.status!=='RESERVED_NOT_ACTIVE')fail('M4A_TRANSITION_S02_CHANGED');
 const journal=new M3CutoverJournal(req.s03,{backend:'lancedb',logicalKey:backup.logicalKey});
 const active=await journal.resolve(live.canonical);
 if(active.physicalName!==live.binding.collection.physicalName||active.generation!==currentGeneration)
  fail('M4A_TRANSITION_GENERATION_CHANGED');
 await journal.assertNoRetainedPhysicalLocks([backup.physicalName,active.physicalName]);
 return {...live,journal,active,historicalRestore};
}
export async function planM4aLanceTransition(req,deps={}){
 const body=validateM4aTransitionPlan(req.body);
 if(!req?.s03?.userScopeId||!req.user?.directories)fail('M4A_HOST_AUTH_REQUIRED',403);
 const store=deps.store?.(req.s03)??new M3Store(req.s03);
 const backup=await store.read('backup',body.backupId);
 const ticket={schemaVersion:1,operationId:randomUUID(),owner:req.s03.userScopeId,
  action:body.action,backend:'lancedb',phase:'PLANNED',
  logicalKey:backup.logicalKey,physicalName:backup.physicalName,backupId:backup.backupId,
  source:body.source,configId:'default',sourceFingerprint:backup.savedSourceFingerprint,
  managedFingerprint:backup.managed?.fingerprint,inventoryDigest:backup.inventory?.digest,
  routingGeneration:backup.routingGeneration??0,createdAt:Date.now(),expiresAt:Date.now()+300000};
 const current=await attest(req,ticket,backup,deps);
 ticket.expectedActivePhysicalName=current.active.physicalName;
 ticket.expectedActiveGeneration=current.active.generation;
 // A second fresh full read ensures planning never trusts one transient snapshot.
 await attest(req,ticket,backup,deps);
 await store.write('operation',ticket);
 return {state:'PLANNED',backend:'lancedb',action:ticket.action,operationId:ticket.operationId,
  logicalKey:ticket.logicalKey,backupId:ticket.backupId,recordCount:backup.inventory.count,
  expiresAt:ticket.expiresAt,requiredConfirmation:CONFIRM[ticket.action],oneUse:true,
  oldPhysicalRetained:true,productionCertified:false};
}
export async function executeM4aLanceTransition(req,deps={}){
 const input=validateM4aTransitionExecute(req.body);
 if(!req?.s03?.userScopeId||!req.user?.directories)fail('M4A_HOST_AUTH_REQUIRED',403);
 const ctx=req.s03,store=deps.store?.(ctx)??new M3Store(ctx);
 const ticket=await store.read('operation',input.operationId);
 if(ticket.owner!==ctx.userScopeId||ticket.backend!=='lancedb'||
    !['restore','empty'].includes(ticket.action)||ticket.phase!=='PLANNED'||
    input.confirmation!==CONFIRM[ticket.action]||ticket.expiresAt<Date.now()||
    ticket.createdAt>Date.now()||!KEY.test(ticket.logicalKey??''))
  fail('M4A_TRANSITION_TICKET_UNTRUSTED');
 const backup=await store.read('backup',ticket.backupId);
 if(backup.logicalKey!==ticket.logicalKey||backup.physicalName!==ticket.physicalName||
    backup.inventory.digest!==ticket.inventoryDigest||backup.managed.fingerprint!==ticket.managedFingerprint||
    backup.savedSourceFingerprint!==ticket.sourceFingerprint||
    (backup.routingGeneration??0)!==ticket.routingGeneration)
  fail('M4A_TRANSITION_TICKET_BACKUP_MISMATCH');
 let claimed=false;
 const outcome=await withM3LifecycleExclusion(ctx,{backend:'lancedb',logicalKey:ticket.logicalKey,
  operationId:ticket.operationId},async holder=>{
  try{
   let current=await attest(req,ticket,backup,deps);
   current=await attest(req,ticket,backup,deps);
   await store.claim(ticket.operationId);claimed=true;
   const audit=new M3ExecutionAudit(ctx,{operationId:ticket.operationId,
    logicalKey:ticket.logicalKey,action:ticket.action,backend:'lancedb'});
   await audit.checkpoint(holder,'CLAIMED');
   const empty=ticket.action==='empty';
   let destination=backup,managedToPublish=null;
   if(empty){
    const tombstone=tombstoneM3ManagedSnapshot(current.managed);
    destination={...backup,backupId:randomUUID(),derivedFromBackupId:backup.backupId,
     purpose:'SCOPED_EMPTY_TARGET',createdAt:new Date().toISOString(),
     managed:{...tombstone,fingerprint:H(tombstone)},
     inventory:{rows:[],count:0,digest:H([]),complete:true,exclusiveOwner:true}};
    await store.write('backup',destination);
    managedToPublish=destination.managed;
   }else if(current.historicalRestore){
    const restored={...current.managed,records:structuredClone(backup.managed.records)};
    const {fingerprint,...body}=restored;
    managedToPublish={...body,fingerprint:H(body)};
   }
   await audit.checkpoint(holder,'DISPATCH_PENDING');
   const stage=await stageM4aLanceTarget({db:current.db,canonical:current.canonical,
    operationId:ticket.operationId,originalBackup:backup,empty,proofConsumed:true,
    ...(deps.stageOptions??{})});
   if(stage.count!==destination.inventory.count||stage.inventoryDigest!==destination.inventory.digest)
    fail('M4A_TRANSITION_STAGE_CONTENT_MISMATCH');
   await audit.checkpoint(holder,'PHYSICAL_VERIFIED',{detail:{physicalName:stage.physicalName,
    count:stage.count,retained:backup.physicalName}});
   // The source and registry must not drift while the staging write was ongoing.
   await attest(req,ticket,backup,deps);
   const currentActive=await current.journal.resolve(current.canonical);
   if(currentActive.generation!==current.active.generation||currentActive.physicalName!==current.active.physicalName)
    fail('M4A_TRANSITION_ACTIVE_CHANGED');
   const generation=currentActive.generation+1;
   const proof={verified:true,schemaVerified:true,inventoryVerified:true,exclusiveOwner:true,
    physicalName:stage.physicalName,logicalKey:ticket.logicalKey,generation,
    count:stage.count,inventoryDigest:stage.inventoryDigest};
   // Receipt is durable BEFORE the journal publishes it. A crash between these
   // steps leaves a retained lock and no active alias rather than a blind replay.
   await store.write('target',{schemaVersion:1,owner:ctx.userScopeId,backend:'lancedb',
    operationId:ticket.operationId,backupId:destination.backupId,logicalKey:ticket.logicalKey,
    physicalName:stage.physicalName,canonicalPhysicalName:current.canonical.collection.physicalName,
    generation,embedding:backup.embedding,inventoryDigest:stage.inventoryDigest,
    inventoryCount:stage.count,sourceFingerprint:backup.savedSourceFingerprint,
    evidenceType:'PHYSICAL_LANCEDB_FULL_READBACK',verifiedAt:new Date().toISOString(),
    productionCertified:false});
   await current.journal.prepare(current.canonical,{operationId:ticket.operationId,
    targetPhysicalName:stage.physicalName,backupDigest:H(destination),proof,holder});
   if(empty||current.historicalRestore){
    const registry=deps.registry?.(ctx,current.canonical)??new ManagedChatRegistry(ctx,current.canonical);
    await registry.lock(async()=>{
     const old=await registry.read();if(old.fingerprint!==current.managed.fingerprint)
      fail('M4A_TRANSITION_REGISTRY_CHANGED');
     const {fingerprint,...doc}=managedToPublish;
     await registry.save(doc);
    });
    const after=await registry.read();
    if(after.fingerprint!==managedToPublish.fingerprint)fail('M4A_TRANSITION_REGISTRY_UNVERIFIED');
   }
   // Check the new physical table a SECOND time after the journal prepare and
   // after tombstones, not just at the initial stage write.
   const target=await (deps.checkStage??stageM4aLanceTargetReadback)(current.db,current.canonical,
    stage.physicalName,destination);
   if(target.count!==destination.inventory.count||target.inventoryDigest!==destination.inventory.digest)
    fail('M4A_TRANSITION_TARGET_CHANGED_BEFORE_PUBLISH');
   const refreshed=await (deps.readSnapshot?.(req,ticket.source)??
    (await import('./m1-saved-records.js')).readM1Snapshot(req,ticket.source));
   if(refreshed.fileHash!==ticket.sourceFingerprint||refreshed.sourceId!==backup.sourceId)
    fail('M4A_TRANSITION_SOURCE_CHANGED_BEFORE_PUBLISH');
   const published=await current.journal.publish(current.canonical,{operationId:ticket.operationId,proof,holder});
   if(published.generation!==generation||published.physicalName!==stage.physicalName)
    fail('M4A_TRANSITION_PUBLISHED_INVALID');
   await audit.checkpoint(holder,'JOURNAL_PUBLISHED',{detail:{generation,physicalName:stage.physicalName}});
   await audit.checkpoint(holder,'COMMITTED');
   return {state:'VERIFIED',backend:'lancedb',action:ticket.action,operationId:ticket.operationId,
    logicalKey:ticket.logicalKey,generation,physicalName:stage.physicalName,
    retainedOriginalPhysicalName:ticket.physicalName,backupId:backup.backupId,
    restoredCount:empty?0:backup.inventory.count,verifiedEmpty:empty,
    oldPhysicalRetained:true,productionCertified:false};
  }catch(e){if(!claimed)return {state:'FAILED',refusal:e};throw e;}
 });
 if(outcome?.state==='FAILED'&&outcome.refusal)throw outcome.refusal;
 return outcome;
}
/** Exact target comparison uses only the server-generated name, never a name
 * from an incoming request. An exact full inventory is required before publish.
 */
export async function stageM4aLanceTargetReadback(db,canonical,physicalName,backup){
 const {markM3ResolvedBinding}=await import('./m3-versioned-binding.js');
 const binding=markM3ResolvedBinding(canonical,{logicalKey:canonical.collection.key,
  canonicalName:canonical.collection.physicalName,physicalName,generation:1});
 const {m4aLanceLifecycleAdapter}=await import('./m4a-lancedb-contract.js');
 const adapter=m4aLanceLifecycleAdapter({db,binding,writerBoundary:async fn=>fn()});
 const schema=await adapter.inspectSchema(),first=await adapter.getInventory(),second=await adapter.getInventory();
 const items=first.items.map(r=>({id:r.physicalId,vector:r.vector,payload:r}));
 if(schema.schemaInspected!==true||!first.fullPhysicalScan||!first.ownerVerified||
   first.logicalFingerprint!==second.logicalFingerprint||first.count!==second.count)
  fail('M4A_STAGE_TARGET_UNVERIFIABLE');
 return {count:first.count,inventoryDigest:H(items),schemaVerified:true};
}

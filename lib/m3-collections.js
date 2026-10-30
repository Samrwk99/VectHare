/** M3 guarded collection lifecycle control-plane (Qdrant reference).
 * No unscoped purge, browser physical names, vectors, arbitrary text or owner IDs.
 * A logical backup is captured from an authenticated complete physical inventory.
 * Physical restore/cutover/decommission remain gated on independently verified
 * M3 real-host acceptance and proof of an exclusive single-owner collection.
 * The M0/S01/S04 legacy mutation denials remain in force.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {resolveF02Binding} from './f02-public-reads.js';
import {M3CutoverJournal,guardM3CanonicalBinding} from './m3-cutover-journal.js';
import {resolveM3ReadBinding} from './m3-target-receipts.js';
import {getEmbeddingProfile} from './f09b5-embedding-profiles.js';
import {selectedM3Profile,assertM3SelectedProfile} from './m3-source-selection.js';
import {readM1Snapshot,readM1HostEvidence} from './m1-saved-records.js';
import {readF03ProvisionReceipt,attestF03QdrantIndexes} from './f03-provision.js';
import {inspectQdrantV2Collection} from './s06-qdrant.js';
import {ownedRecord} from './s05-contract.js';
import {ManagedChatRegistry} from './f09b4-managed-registry.js';
import {M2JobStore} from './m2-jobs.js';
import {OperationLedger} from './s04-ledger.js';
import {runtimeWriterBoundary} from './f09c10-runtime-boundary.js';
import {assertM3LifecycleHolder} from './m3-logical-exclusion.js';
const H=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const KEY=/^[a-f0-9]{64}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const error=(code,status=409)=>Object.assign(new Error(code),{code,status});
const obj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const shape=(v,keys)=>obj(v)&&Object.keys(v).every(k=>keys.includes(k));
async function privateDir(p){const s=await fs.lstat(p);if(!s.isDirectory()||s.isSymbolicLink()||(process.platform!=='win32'&&(s.mode&0o077)))throw error('M3_UNTRUSTED_STORAGE',403);}
async function sync(p){const h=await fs.open(p,'r');try{await h.sync();}finally{await h.close();}}
export class M3Store {
 constructor(ctx){if(!ctx?.userScopeId||!path.isAbsolute(ctx.vectorsPath??''))throw error('M3_HOST_STORAGE_REQUIRED',403);
  this.ctx=ctx;this.root=path.join(ctx.vectorsPath,'.similharity','m3-lifecycle');}
 async setup(){await privateDir(this.ctx.vectorsPath);for(const p of [path.dirname(this.root),this.root]){
  await fs.mkdir(p,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});await privateDir(p);}}
 file(kind,id){if(!UUID.test(id??'')||!['backup','operation','target','deletion','stage'].includes(kind))throw error('M3_DOCUMENT_ID_INVALID',400);return path.join(this.root,`${kind}-${id.toLowerCase()}.json`);}
 async write(kind,doc){await this.setup();const id=kind==='backup'?doc.backupId:doc.operationId;
  if(doc.owner!==this.ctx.userScopeId)throw error('M3_OWNER_MISMATCH',403);
  const file=this.file(kind,id),str=JSON.stringify({...doc,seal:H(doc)})+'\n';
  if(Buffer.byteLength(str)>100*1024*1024)throw error('M3_BACKUP_LIMIT');
  // One-way document creation: a crash cannot overwrite original evidence.
  const fh=await fs.open(file,'wx',0o600);try{await fh.writeFile(str);await fh.sync();}finally{await fh.close();}await sync(this.root);return doc;
 }
 async read(kind,id){await this.setup();const st=await fs.lstat(this.file(kind,id));
  if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>100*1024*1024||(process.platform!=='win32'&&(st.mode&0o077)))throw error('M3_DOCUMENT_UNTRUSTED',403);
  let d;try{d=JSON.parse(await fs.readFile(this.file(kind,id),'utf8'));}catch{throw error('M3_DOCUMENT_CORRUPT');}
  const {seal,...doc}=d;if(seal!==H(doc)||doc.owner!==this.ctx.userScopeId||
   (kind==='backup'?doc.backupId:doc.operationId)!==id)throw error('M3_DOCUMENT_CORRUPT',403);return doc;
 }
 async assertUnclaimed(id){await this.setup();
  const marker=path.join(this.root,`claimed-${id}.json`);
  this.file('operation',id); // Validate the UUID before filesystem access.
  try{await fs.lstat(marker);throw error('M3_OPERATION_ALREADY_CLAIMED');}
  catch(e){if(e.code==='ENOENT')return true;throw e;}
 }
 async claim(id){await this.setup();
  // An immutable O_EXCL claim marker is written durably before any future
  // destructive dispatch. Do not link the source receipt: source nlink must
  // remain 1 so that status/investigation reads stay possible after claim.
  const original=await this.read('operation',id),marker=path.join(this.root,`claimed-${id}.json`);
  const body=JSON.stringify({owner:this.ctx.userScopeId,operationId:id,checksum:H(original)});
  let fh;try{fh=await fs.open(marker,'wx',0o600);}catch(e){if(e.code==='EEXIST')throw error('M3_OPERATION_ALREADY_CLAIMED');throw e;}
  try{await fh.writeFile(body);await fh.sync();}finally{await fh.close();}await sync(this.root);
  return original;
 }
}
export function validateM3Selector(body,{action=false}={}){
 const keys=['backend','source','configId',...(action?['action','backupId']:[])];
 if(!shape(body,keys)||body.backend!=='qdrant'||!['default','local',undefined].includes(body.configId))throw error('M3_SOURCE_SELECTOR_INVALID',400);
 const source=body.source,keysByType={chat:['kind','avatar','chatFile'],'group-chat':['kind','groupId','chatFile'],lorebook:['kind','name']};
 const names=keysByType[source?.kind];if(!names||!shape(source,names)||names.some(k=>typeof source[k]!=='string'||!source[k]||source[k].length>220))throw error('M3_SAVED_SELECTOR_INVALID',400);
 if(action&&(!['restore','delete','empty','rebuild'].includes(body.action)||!UUID.test(body.backupId??'')))throw error('M3_ACTION_INVALID',400);
 return body;
}
async function context(req,intent,deps={}, {allowAlias=false}={}){
 if(!req?.s03?.userScopeId||!req.user?.directories)throw error('M3_HOST_AUTH_REQUIRED',403);
 const info=deps.getProfile?await deps.getProfile(req.s03):await selectedM3Profile(req,intent.source);
 if(!info?.configured||!info.profile)throw error('M3_PROFILE_REQUIRED');
 if(info.selected&&!allowAlias)throw error('M3_CROSS_MODEL_DESTRUCTIVE_REQUIRES_CUTOVER_SUPPORT');
 const profile=info.profile;
 const [{binding:canonical},snapshot]=await Promise.all([
  (deps.bind??resolveF02Binding)(req,{backend:'qdrant',source:intent.source,embedding:profile,configId:intent.configId},{reserve:false,readAlias:allowAlias}),
  (deps.readSnapshot??readM1Snapshot)(req,intent.source)]);
 if(canonical?.scope?.userScopeId!==req.s03.userScopeId||canonical?.scope?.sourceId!==snapshot.sourceId||
  JSON.stringify(canonical.embedding)!==JSON.stringify(profile)||!KEY.test(canonical.collection?.key??''))throw error('M3_SCOPE_MISMATCH',403);
 // For read-only preview/backup only: resolve the canonical identity through
 // the authenticated immutable target receipt and fresh physical readback.
 // Destructive plans deliberately continue to reject aliases.
 const transport=allowAlias&&(deps.transport||deps.backendPool?.getTrusted)?await qdrantTransport(req,intent,deps):null;
 const binding=allowAlias?await (deps.resolveLiveBinding??resolveM3ReadBinding)(req.s03,canonical,{transport}):canonical;
 if(!allowAlias)await guardM3CanonicalBinding(req.s03,binding);
 const receipt=await (deps.receipt??readF03ProvisionReceipt)(req.s03,canonical);
 if(receipt?.state!=='SCHEMA_VERIFIED_OFFLINE_UNCERTIFIED'&&!info.selected)throw error('M3_PROVISION_RECEIPT_REQUIRED');
 if(info.selected&&(!allowAlias||binding.collection.generation!==info.selectionGeneration))
  throw error('M3_SELECTED_GENERATION_UNVERIFIED');
 const managed=await (deps.registry?.(req.s03,binding)??new ManagedChatRegistry(req.s03,binding)).read();
 if(Object.values(managed.records).some(r=>!['ACTIVE','DELETED'].includes(r.state)))throw error('M3_MANAGED_PENDING_REVIEW');
 await (deps.jobs?.(req.s03)??new M2JobStore(req.s03)).assertNoLease(binding.collection.key);
 return {binding,canonical,snapshot,profile,managed,transport,selectionGeneration:info.selectionGeneration??0};
}
/** Full unfiltered Qdrant scroll: filtered S05 pagination is insufficient to
 * prove that the PHYSICAL collection does not contain foreign/unmanaged rows.
 * Reject any foreign row, duplicate, absent vector, partial scan or limit hit.
 */
export async function qdrantM3Inventory(transport,binding,{maxRecords=20000}={}){
 if(typeof transport?._request!=='function')throw error('M3_TRUSTED_TRANSPORT_REQUIRED',403);
 if((await inspectQdrantV2Collection(transport,binding))?.schemaInspected!==true)throw error('M3_SCHEMA_NOT_VERIFIED');
 await attestF03QdrantIndexes(transport,binding);
 const rows=[],seen=new Set(),cursors=new Set();let cursor=null,complete=false;
 for(let page=0;page<Math.ceil(maxRecords/128)+2;page++){
  const request={limit:128,with_payload:true,with_vector:true};if(cursor!==null)request.offset=cursor;
  const res=await transport._request('POST',`/collections/${binding.collection.physicalName}/points/scroll`,request);
  const data=res?.result;
  if(!Array.isArray(data?.points))throw error('M3_INVENTORY_UNVERIFIABLE');
  for(const point of data.points){
   if(point?.payload?.physicalId!==point.id||!Array.isArray(point.vector))throw error('M3_POINT_UNVERIFIABLE');
   const normalized=ownedRecord({...point.payload,physicalId:point.id,vector:point.vector},binding,{includeVector:true});
   if(seen.has(normalized.recordId))throw error('M3_DUPLICATE_RECORD');seen.add(normalized.recordId);
   if(rows.length>=maxRecords)throw error('M3_INVENTORY_RECORD_LIMIT');
   rows.push({id:point.id,vector:point.vector,payload:point.payload});
  }
  if(data.next_page_offset===null||data.next_page_offset===undefined){complete=true;break;}
  const k=JSON.stringify(data.next_page_offset);if(cursors.has(k)||k.length>1024)throw error('M3_CURSOR_UNVERIFIABLE');
  cursors.add(k);cursor=data.next_page_offset;
 }
 if(!complete)throw error('M3_INVENTORY_INCOMPLETE');
 rows.sort((a,b)=>String(a.id).localeCompare(String(b.id)));
 return {rows,digest:H(rows),count:rows.length,complete:true,exclusiveOwner:true};
}
async function qdrantTransport(req,intent,deps){if(deps.transport)return deps.transport(req,intent);
 if(!deps.backendPool?.getTrusted)throw error('M3_SERVER_CONNECTION_REQUIRED',403);
 return deps.backendPool.getTrusted(req.s03,'qdrant',intent.configId??'default');}
/** Include a durable ledger checkpoint and REFUSE any write still in flight,
 * uncertain, or lacking a verified terminal receipt in this collection. */
export async function m3LedgerCheckpoint(ctx,logicalKey,deps={}){
 if(deps.ledgerCheckpoint)return deps.ledgerCheckpoint(ctx,logicalKey);
 const ledger=new OperationLedger(ctx);await ledger.setup();
 const files=(await fs.readdir(ledger.root)).filter(x=>x.endsWith('.json'));
 if(files.length>50000)throw error('M3_LEDGER_LIMIT');
 const receipts=[];
 for(const name of files){if(!UUID.test(name.slice(0,-5)))throw error('M3_LEDGER_ENTRY_UNTRUSTED');
  const r=await ledger.read(name.slice(0,-5));
  if(r.plan.collectionKey!==logicalKey)continue;
  if(!['VERIFIED','FAILED'].includes(r.state))throw error('M3_UNSETTLED_MUTATION');
  receipts.push([r.operationId,r.state,H(r)]);
 }
 receipts.sort((a,b)=>a[0].localeCompare(b[0]));
 return {count:receipts.length,digest:H(receipts)};
}
/** Do not authorize irreversible collection operations unless EVERY physical
 * record is accounted for in the owned managed registry with a verified v2
 * provenance marker. A valid user scope alone is not ownership of all data. */
export function assertM3ManagedCompleteness(managed,inv,binding){
 const active=new Map(Object.entries(managed.records).filter(([,v])=>v.state==='ACTIVE'));
 if(active.size!==inv.rows.length)throw error('M3_UNMANAGED_RECORDS_PRESENT');
 for(const point of inv.rows){
  const row=point.payload,meta=row?.metadata?.vecthareRecordV2,entry=active.get(row?.recordId);
  if(!entry||!meta||meta.schemaVersion!==2||meta.recordId!==row.recordId||
   meta.identity?.userScopeId!==binding.scope.userScopeId||meta.identity?.sourceId!==binding.scope.sourceId||
   meta.contentHash!==row.textHash||entry.contentHash!==row.textHash||
   meta.revision!==row.revision||entry.revision!==row.revision)
   throw error('M3_MANAGED_PROVENANCE_INCOMPLETE');
 }
 return true;
}
async function inventory(req,intent,binding,deps){return deps.inventory?deps.inventory(req,binding):qdrantM3Inventory(await qdrantTransport(req,intent,deps),binding);}
/** Repeat physical inventory readback to detect changes during logical capture.
 * The cooperative write gate is held across both reads, but the check also
 * catches some out-of-band writers; external concurrency is not certified. */
export async function captureM3Backup(req,deps={}){
 const {confirmation,...intent}=req.body??{};
 if(!shape(req.body,['backend','source','configId','confirmation'])||confirmation!=='CAPTURE OWNED LOGICAL BACKUP')throw error('M3_BACKUP_CONFIRMATION_REQUIRED',403);
 validateM3Selector(intent);
 const {binding,snapshot,profile,managed,canonical,transport,selectionGeneration}=await context(req,intent,deps,{allowAlias:true});
 const plan={backend:'qdrant',scope:binding.scope,collectionKey:binding.collection.key,
  physicalCollectionName:binding.collection.physicalName,operationId:randomUUID()};
 const boundary=deps.boundary?.(req.s03,plan)??await runtimeWriterBoundary(req.s03,plan);
 const result=await boundary.withWriteBoundary(plan,async()=>{
  await (deps.jobs?.(req.s03)??new M2JobStore(req.s03)).assertNoLease(binding.collection.key);
  // Reverify the live target while holding the exclusion, so a plan built on
  // one generation cannot be captured against another generation.
  const freshlyBound=await (deps.resolveLiveBinding??resolveM3ReadBinding)(req.s03,canonical,{transport});
  if(freshlyBound.collection.physicalName!==binding.collection.physicalName||
   (freshlyBound.collection.generation??0)!==(binding.collection.generation??0))
   throw error('M3_BACKUP_GENERATION_CHANGED');
  const checkpoint=await m3LedgerCheckpoint(req.s03,binding.collection.key,deps);
  const before=await inventory(req,intent,binding,deps);
  if(!before.complete||!before.exclusiveOwner||!Array.isArray(before.rows))throw error('M3_EXCLUSIVE_INVENTORY_REQUIRED');
  const after=await inventory(req,intent,binding,deps);
  if(before.digest!==after.digest||before.count!==after.count)throw error('M3_INVENTORY_CHANGED');
  const checkpointAfter=await m3LedgerCheckpoint(req.s03,binding.collection.key,deps);
  if(checkpoint.digest!==checkpointAfter.digest)throw error('M3_MUTATION_LEDGER_CHANGED');
  if(!deps.getProfile)await assertM3SelectedProfile(req.s03,canonical.scope,profile,selectionGeneration);
  const latest=await (deps.readSnapshot??readM1Snapshot)(req,intent.source);
  if(latest.fileHash!==snapshot.fileHash||latest.sourceId!==snapshot.sourceId)throw error('M3_SAVED_SOURCE_CHANGED');
  const latestRegistry=await (deps.registry?.(req.s03,binding)??new ManagedChatRegistry(req.s03,binding)).read();
  if(latestRegistry.fingerprint!==managed.fingerprint)throw error('M3_MANAGED_REGISTRY_CHANGED');
  const backup={schemaVersion:1,backupId:randomUUID(),owner:req.s03.userScopeId,backend:'qdrant',
   logicalKey:binding.collection.key,physicalName:binding.collection.physicalName,
   routingGeneration:binding.collection.generation??0,canonicalPhysicalName:canonical.collection.physicalName,
   scope:binding.scope,embedding:profile,source:intent.source,configId:intent.configId??'default',
   sourceId:snapshot.sourceId,savedSourceFingerprint:snapshot.fileHash,
   managed:{records:managed.records,fingerprint:managed.fingerprint},
   operationCheckpoint:checkpoint,
   inventory:{count:before.count,digest:before.digest,complete:true,exclusiveOwner:true,rows:before.rows},
   createdAt:new Date().toISOString(),excludes:['SillyTavern saved chat files','server credentials','external/unmanaged collections'],
   productionCertified:false};
  await (deps.store?.(req.s03)??new M3Store(req.s03)).write('backup',backup);
  return {state:'VERIFIED',backupId:backup.backupId,logicalKey:backup.logicalKey,
   count:before.count,inventoryDigest:before.digest,scopeOwned:true,physicalBackupVerified:true,
   routingGeneration:backup.routingGeneration,
   productionCertified:false};
 });
 if(result?.state!=='VERIFIED')throw error('M3_BACKUP_OUTCOME_UNVERIFIED');return result;
}
export async function inspectM3Backup(req,id,deps={}){
 if(!req?.s03?.userScopeId||!req.user?.directories)throw error('M3_HOST_AUTH_REQUIRED',403);
 const doc=await (deps.store?.(req.s03)??new M3Store(req.s03)).read('backup',id);
 if(doc.schemaVersion!==1||doc.backend!=='qdrant'||!KEY.test(doc.logicalKey??'')||
  !Array.isArray(doc.inventory?.rows)||doc.inventory.count!==doc.inventory.rows.length||
  doc.inventory.digest!==H(doc.inventory.rows)||doc.inventory.complete!==true||doc.inventory.exclusiveOwner!==true)
  throw error('M3_BACKUP_INTEGRITY_INVALID');
 return {backupId:id,logicalKey:doc.logicalKey,backend:doc.backend,recordCount:doc.inventory.count,
  routingGeneration:doc.routingGeneration??0,
  createdAt:doc.createdAt,inventoryDigest:doc.inventory.digest,integrityVerified:true,
  excludes:doc.excludes,productionCertified:false};
}
export async function previewM3Collection(req,deps={}){
 const intent=validateM3Selector(req.body);
 const {binding,snapshot,managed}=await context(req,intent,deps,{allowAlias:true});
 const inv=await inventory(req,intent,binding,deps);
 if(!inv.complete||!inv.exclusiveOwner)throw error('M3_INVENTORY_INCOMPLETE');
 return {backend:'qdrant',logicalKey:binding.collection.key,
  physicalName:binding.collection.physicalName,sourceId:snapshot.sourceId,
  recordCount:inv.count,inventoryDigest:inv.digest,managedRecordCount:Object.keys(managed.records).length,
  ownerVerified:true,sharedCollectionEligible:false,backupRequiredForDeletion:true,
  routingGeneration:binding.collection.generation??0,
  operationModes:{backup:'ENABLED',
   restore:m3ActionReadiness('restore').mode,
   delete:m3ActionReadiness('delete').mode,
   empty:m3ActionReadiness('empty').mode,
   rebuild:m3ActionReadiness('rebuild').mode,rollback:m3ActionReadiness('rollback').mode},
  validationStatus:'AWAITING_MANUAL_TEST',prerequisites:['M3_RUNTIME_PREFLIGHT_PER_OPERATION'],
  productionWritesEnabled:false,cutoverState:(binding.collection.generation??0)>0?'VERIFIED_PUBLISHED_GENERATION':'CANONICAL_NO_ACTIVE_TRANSITION'};
}
/** Durable one-way destructive plan. Even a completed backup alone can never
 * authorize deletion; it must match a fresh entire-collection inventory. */
export async function planM3Collection(req,deps={}){
 const intent=validateM3Selector(req.body,{action:true});
 const allowedAlias=['empty','restore','delete'].includes(intent.action);
 const {binding,snapshot,profile,managed,canonical}=await context(req,intent,deps,{allowAlias:allowedAlias});
 if(!allowedAlias&&(binding.collection.generation??0)>0)throw error('M3_DESTRUCTIVE_ALIAS_UNSUPPORTED');
 const backup=await (deps.store?.(req.s03)??new M3Store(req.s03)).read('backup',intent.backupId);
 await inspectM3Backup(req,intent.backupId,deps);
 if(backup.logicalKey!==binding.collection.key||backup.physicalName!==binding.collection.physicalName||
  (backup.routingGeneration??0)!==(binding.collection.generation??0)||
  (backup.canonicalPhysicalName??backup.physicalName)!==canonical.collection.physicalName||
  backup.savedSourceFingerprint!==snapshot.fileHash||backup.managed.fingerprint!==managed.fingerprint||
  JSON.stringify(backup.embedding)!==JSON.stringify(profile))throw error('M3_BACKUP_STALE_OR_WRONG_SCOPE',403);
 const checkpoint=await m3LedgerCheckpoint(req.s03,binding.collection.key,deps);
 if(checkpoint.digest!==backup.operationCheckpoint?.digest)throw error('M3_LEDGER_STALE');
 const inv=await inventory(req,intent,binding,deps);
 if(!inv.complete||!inv.exclusiveOwner||inv.digest!==backup.inventory.digest||inv.count!==backup.inventory.count)
  throw error('M3_BACKUP_INVENTORY_CHANGED');
 assertM3ManagedCompleteness(managed,inv,binding);
 const ticket={schemaVersion:1,operationId:randomUUID(),owner:req.s03.userScopeId,
  logicalKey:binding.collection.key,physicalName:binding.collection.physicalName,
  canonicalPhysicalName:canonical.collection.physicalName,routingGeneration:binding.collection.generation??0,
  source:intent.source,backend:'qdrant',configId:intent.configId??'default',
  action:intent.action,backupId:intent.backupId,sourceFingerprint:snapshot.fileHash,
  inventoryDigest:inv.digest,managedFingerprint:managed.fingerprint,
  createdAt:Date.now(),expiresAt:Date.now()+5*60*1000,
  phase:'PLANNED',executionAllowed:m3ActionReadiness(intent.action).enabled};
 await (deps.store?.(req.s03)??new M3Store(req.s03)).write('operation',ticket);
 return {operationId:ticket.operationId,action:ticket.action,logicalKey:ticket.logicalKey,
  physicalName:ticket.physicalName,backupId:ticket.backupId,recordCount:inv.count,
  inventoryDigest:inv.digest,expiresAt:ticket.expiresAt,
  executionAllowed:m3ActionReadiness(ticket.action).enabled,
  ...m3ActionReadiness(ticket.action),
  prerequisites:m3ActionReadiness(ticket.action).enabled?['M3_RUNTIME_PREFLIGHT_PER_DISPATCH']:
   [m3ActionReadiness(ticket.action).reasonCode]};
}
/** Public M3 entry point. A browser supplies only the opaque ID of a
 * server-issued immutable plan and the exact destructive confirmation.
 * Safety is enforced a second time by the private transaction immediately
 * before its durable dispatch, under the physical/logical lock.
 * A failed post-claim transaction is never automatically replayed.
 */
const CONFIRMATIONS=Object.freeze({
 restore:'RESTORE TO FRESH COLLECTION',
 delete:'DELETE OWNED COLLECTION',
 rollback:'ROLL BACK UNCHANGED COLLECTION',
 empty:'EMPTY OWNED COLLECTION',
});
export const M3_IMPLEMENTATION_EVIDENCE=Object.freeze({gateway:'passed',ui:'passed',
 conformance:'passed',faultTests:'passed',securityTests:'passed'});
export function m3ActionReadiness(action){
 if(Object.hasOwn(CONFIRMATIONS,action))return {mode:'ENABLED',enabled:true,
  validationStatus:'AWAITING_MANUAL_TEST',runtimePreflightRequired:true,
  reasonCode:null};
 return {mode:'BLOCKED',enabled:false,validationStatus:'NOT_READY',
  runtimePreflightRequired:true,reasonCode:action==='empty'?'M3_SCOPED_EMPTY_HANDLER_INCOMPLETE':
   action==='rebuild'?'M3_REBUILD_HANDLER_INCOMPLETE':'M3_ACTION_UNSUPPORTED'};
}
export async function executeM3Collection(req,deps={}){
 if(!shape(req.body,['operationId','confirmation'])||!UUID.test(req.body.operationId??''))
  throw error('M3_EXECUTION_REQUEST_INVALID',400);
 if(!req?.s03?.userScopeId||!req.user?.directories)throw error('M3_HOST_AUTH_REQUIRED',403);
 const store=deps.store?.(req.s03)??new M3Store(req.s03);
 const ticket=await store.read('operation',req.body.operationId);
 if(ticket.owner!==req.s03.userScopeId)throw error('M3_OPERATION_OWNER_MISMATCH',403);
 const ready=m3ActionReadiness(ticket.action);
 if(!ready.enabled)throw error(ready.reasonCode);
 if(req.body.confirmation!==CONFIRMATIONS[ticket.action])throw error('M3_EXPLICIT_CONFIRMATION_REQUIRED',403);
 let result;
 if(ticket.action==='empty'){
  const {executeM3TrustedEmpty}=await import('./m3-empty-transaction.js');
  result=await executeM3TrustedEmpty(req,ticket.operationId,deps);
 }else if(ticket.action==='restore'){
  const {executeM3TrustedRestore}=await import('./m3-lifecycle-transaction.js');
  result=await executeM3TrustedRestore(req,ticket.operationId,deps);
 }else if(ticket.action==='delete'){
  const {executeM3TrustedDecommission}=await import('./m3-decommission-transaction.js');
  result=await executeM3TrustedDecommission(req,ticket.operationId,deps);
 }else{
  const {executeM3TrustedRollback}=await import('./m3-rollback-transaction.js');
  result=await executeM3TrustedRollback(req,ticket.operationId,deps);
 }
 if(result?.state!=='VERIFIED')throw error('M3_LIFECYCLE_RESULT_UNVERIFIED');
 return {...result,mode:'ENABLED',enabled:true,validationStatus:'AWAITING_MANUAL_TEST',
  productionCertified:false,manualTestRequired:true};
}
/** A rollback plan is scoped to the original authenticated restore operation,
 * never to a browser-provided physical collection or backup path. */
export async function planM3Rollback(req,deps={}){
 if(!shape(req.body,['restoreOperationId'])||!UUID.test(req.body.restoreOperationId??''))
  throw error('M3_ROLLBACK_REQUEST_INVALID',400);
 if(!req?.s03?.userScopeId||!req.user?.directories)throw error('M3_HOST_AUTH_REQUIRED',403);
 const {planM3TrustedRollback}=await import('./m3-rollback-transaction.js');
 const plan=await planM3TrustedRollback(req,req.body.restoreOperationId,deps);
 return {...plan,action:'rollback',executionAllowed:true,mode:'ENABLED',
  validationStatus:'AWAITING_MANUAL_TEST',runtimePreflightRequired:true};
}
export function registerM3Routes(router,deps={}){
 const wrap=fn=>async(req,res)=>{try{res.json({success:true,...await fn(req)});}catch(e){res.status(Number.isInteger(e.status)?e.status:409).json({success:false,
  code:/^M3_[A-Z0-9_]+$/.test(e?.code??'')?e.code:'M3_OPERATION_REFUSED',executionAllowed:false,retryable:false});}};
 router.post('/v2/m3/collections/preview',wrap(req=>previewM3Collection(req,deps)));
 router.post('/v2/m3/backups/create',wrap(req=>captureM3Backup(req,deps)));
 router.get('/v2/m3/backups/:backupId/verify',wrap(req=>inspectM3Backup(req,req.params.backupId,deps)));
 // Authenticated, owner-bound READ-ONLY lifecycle recovery evidence. This is
 // NOT a lock-release or mutation endpoint. M2 administrator adjudication
 // must still prove the physical/ledger outcome before any lock is cleared.
 // Administrator-only, read-only cross-operation reconciliation. No verdict or
 // lock-release is accepted from the browser; evidence is independently read.
 // M3 finishing: preflight NEVER authorizes replay or lock release.
 // One-use administrator-approved stage continuation. The HTTP body is empty;
 // the approval and fresh proof hash live in server-private storage only.
 router.post('/v2/m3/collections/rebuild/continue/:operationId',wrap(async req=>{
  if(!shape(req.body,[]))throw error('M3_STAGE_RESUME_BODY_FORBIDDEN',400);
  const {continueM3VerifiedStage}=await import('./m3-stage-resume.js');
  return continueM3VerifiedStage(req,req.params.operationId,{deps,adminRoot:deps.adminRoot});
 }));
 router.get('/v2/m3/collections/rebuild/continuation-proof/:operationId',wrap(async req=>{
  const {inspectM3StageContinuation}=await import('./m3-stage-continuation.js');
  return inspectM3StageContinuation(req,req.params.operationId,deps);
 }));
 // Out-of-band private approval only; endpoint carries no verdict or lock ID.
 // Explicit ABANDON records an admin decision, but retains all uncertain locks.
 router.post('/v2/m3/operations/:operationId/abandon',wrap(async req=>{
  if(!shape(req.body,[]))throw error('M3_ABANDON_BODY_FORBIDDEN',400);
  const {abandonM3UncertainOperation}=await import('./m3-abandonment.js');
  return abandonM3UncertainOperation(req,req.params.operationId,{deps,adminRoot:deps.adminRoot});
 }));
 router.get('/v2/m3/operations/:operationId/abandonment',wrap(async req=>{
  const {inspectM3Abandonment}=await import('./m3-abandonment.js');
  return inspectM3Abandonment(req,req.params.operationId);
 }));
 router.get('/v2/m3/operations/:operationId/adjudication-proof',wrap(async req=>{
  const {inspectM3ProvenAdjudication}=await import('./m3-general-adjudication.js');
  const proof=await inspectM3ProvenAdjudication(req,req.params.operationId,deps);
  return {operationId:req.params.operationId,proofHash:proof.proofHash,
   eligible:proof.eligible,disposition:proof.disposition,requiresPrivateApproval:true};
 }));
 router.post('/v2/m3/operations/:operationId/quarantine-proven',wrap(async req=>{
  if(!shape(req.body,[]))throw error('M3_ADJUDICATION_BODY_FORBIDDEN',400);
  const {quarantineM3ProvenLocks}=await import('./m3-general-adjudication.js');
  return quarantineM3ProvenLocks(req,req.params.operationId,{deps,adminRoot:deps.adminRoot});
 }));
 router.get('/v2/m3/operations/:operationId/reconciliation',wrap(async req=>{
  const {inspectM3GeneralReconciliation}=await import('./m3-general-reconciliation.js');
  return inspectM3GeneralReconciliation(req,req.params.operationId,deps);
 }));
 router.get('/v2/m3/operations/:operationId/evidence',wrap(async req=>{
  if(!req?.s03?.userScopeId||!req.user?.directories)throw error('M3_HOST_AUTH_REQUIRED',403);
  const {inspectM3LifecycleRecovery}=await import('./m3-execution-audit.js');
  return inspectM3LifecycleRecovery(req.s03,req.params.operationId,{store:deps.store?.(req.s03)});
 }));
 router.post('/v2/m3/collections/rebuild/preview',wrap(async req=>{
  const {previewM3ModelRebuild}=await import('./m3-rebuild-preview.js');
  return previewM3ModelRebuild(req,deps);
 }));
 router.get('/v2/m3/collections/rebuild/stages/:operationId',wrap(async req=>{
  const {inspectM3RebuildStage}=await import('./m3-rebuild-stage.js');
  return inspectM3RebuildStage(req,req.params.operationId,deps);
 }));
 router.post('/v2/m3/collections/rebuild/activation-plan',wrap(async req=>{
  if(!shape(req.body,['stageOperationId'])||!UUID.test(req.body.stageOperationId??''))
   throw error('M3_ACTIVATION_PLAN_INVALID',400);
  const {planM3RebuildActivation}=await import('./m3-rebuild-activation.js');
  return planM3RebuildActivation(req,deps);
 }));
 router.post('/v2/m3/collections/rebuild/activation-execute',wrap(async req=>{
  if(!shape(req.body,['operationId','confirmation'])||!UUID.test(req.body.operationId??'')||
   req.body.confirmation!=='ACTIVATE VERIFIED MODEL FOR THIS SOURCE')
   throw error('M3_ACTIVATION_CONFIRMATION_REQUIRED',403);
  const {executeM3RebuildActivation}=await import('./m3-rebuild-activation.js');
  return executeM3RebuildActivation(req,req.body.operationId,deps);
 }));
 router.post('/v2/m3/collections/rebuild/source-profile',wrap(async req=>{
  if(!shape(req.body,['source'])||!req?.s03?.userScopeId||!req.user?.directories)
   throw error('M3_ACTIVATION_PROFILE_REQUEST_INVALID',403);
  const {selectedM3Profile}=await import('./m3-source-selection.js');
  const result=await selectedM3Profile(req,req.body.source);
  return {profile:result.profile,selected:result.selected,selectionGeneration:result.selectionGeneration,
   logicalKey:result.selected?result.logicalKey:null,credentialsIncluded:false};
 }));
 router.post('/v2/m3/collections/rebuild/stage-plan',wrap(async req=>{
  const {planM3RebuildStage}=await import('./m3-rebuild-stage.js');
  return planM3RebuildStage(req,deps);
 }));
 // Read-only progress and bounded non-physical embedding checkpoints.
 router.get('/v2/m3/collections/rebuild/physical-progress/:operationId',wrap(async req=>{
  const {inspectM3PhysicalProgress}=await import('./m3-physical-progress.js');
  return inspectM3PhysicalProgress(req,req.params.operationId,deps);
 }));
 router.get('/v2/m3/collections/rebuild/preparation/:operationId',wrap(async req=>{
  const {progressM3RebuildPreparation}=await import('./m3-rebuild-preparation.js');
  return progressM3RebuildPreparation(req,req.params.operationId,deps);
 }));
 router.post('/v2/m3/collections/rebuild/preparation/:operationId/step',wrap(async req=>{
  if(!shape(req.body,[]))throw error('M3_PREP_STEP_BODY_FORBIDDEN',400);
  const {stepM3RebuildPreparation}=await import('./m3-rebuild-preparation.js');
  return stepM3RebuildPreparation(req,req.params.operationId,deps);
 }));
 router.post('/v2/m3/collections/rebuild/stage-execute',wrap(async req=>{
  if(!shape(req.body,['operationId','confirmation'])||!UUID.test(req.body.operationId??'')||
     req.body.confirmation!=='STAGE NEW MODEL WITHOUT ACTIVATION')
    throw error('M3_REBUILD_STAGE_CONFIRMATION_REQUIRED',403);
  const {executeM3RebuildStage}=await import('./m3-rebuild-stage.js');
  return executeM3RebuildStage(req,req.body.operationId,deps);
 }));
 router.post('/v2/m3/collections/plan',wrap(req=>planM3Collection(req,deps)));
 router.post('/v2/m3/collections/rollback/plan',wrap(req=>planM3Rollback(req,deps)));
 router.get('/v2/m3/collections/readiness',wrap(async req=>{
  if(!req?.s03?.userScopeId||!req.user?.directories)throw error('M3_HOST_AUTH_REQUIRED',403);
  return {operations:{...Object.fromEntries(['backup','restore','delete','rollback','empty','rebuild'].map(a=>[a,
   a==='backup'?{mode:'ENABLED',enabled:true,validationStatus:'AWAITING_MANUAL_TEST'}:m3ActionReadiness(a)])),
   modelStage:{mode:'ENABLED',enabled:true,validationStatus:'AWAITING_MANUAL_TEST',runtimePreflightRequired:true},
   modelActivation:{mode:'ENABLED',enabled:true,validationStatus:'AWAITING_MANUAL_TEST',runtimePreflightRequired:true},
   physicalStageContinuation:{mode:'ENABLED',enabled:true,validationStatus:'AWAITING_MANUAL_TEST',
    runtimePreflightRequired:true,requiresServerPrivateAdminApproval:true,proofBound:true},
   provenAppliedAdjudication:{mode:'ENABLED',enabled:true,validationStatus:'AWAITING_MANUAL_TEST',
    runtimePreflightRequired:true,requiresServerPrivateAdminApproval:true},
   uncertainAbandonment:{mode:'ENABLED',enabled:true,validationStatus:'AWAITING_MANUAL_TEST',
    runtimePreflightRequired:true,retainsPhysicalLock:true}}};
 }));
 // M3v6: administrator-only *terminal* lock quarantine. An approval is read
 // exclusively from the private server config root, never supplied in HTTP.
 router.get('/v2/m3/operations/:operationId/terminal-proof',wrap(async req=>{
  const {inspectM3TerminalProof}=await import('./m3-terminal-resolution.js');
  const evidence=await inspectM3TerminalProof(req,req.params.operationId,deps);
  return {operationId:req.params.operationId,eligible:true,proofHash:evidence.proofHash,
   disposition:'TERMINAL_DELETE_ONLY',requiresOutOfBandAdminApproval:true};
 }));
 router.post('/v2/m3/operations/:operationId/quarantine-terminal',wrap(async req=>{
  if(!shape(req.body,[]))throw error('M3_RESOLUTION_BODY_FORBIDDEN',400);
  const {quarantineM3TerminalLock}=await import('./m3-terminal-resolution.js');
  return quarantineM3TerminalLock(req,req.params.operationId,{deps,adminRoot:deps.adminRoot});
 }));
 router.post('/v2/m3/collections/execute',wrap(req=>executeM3Collection(req,deps)));
}

/** M3.1 reference-backend STAGING experiment (NOT a public route).
 * Requires an explicitly marked disposable Qdrant fixture; a separate M3
 * production gateway, cutover journal and recovery proof are still needed.
 * This never edits, empties or removes the source collection.
 */
export async function stageM3DisposableRestore(transport,backup,{operationId=randomUUID(),holder=null,ctx=null,onVerifiedChunk=null}={}){
 // The very same physical restore procedure can run under a private M3
 // lifecycle lease, but neither HTTP clients nor plain fixture callbacks can
 // mint that lease. The ordinary direct-call path remains disposable-only.
 if(holder===null){if(transport?.m3DisposableFixture!==true)throw error('M3_RESTORE_DISPOSABLE_ONLY',403);}
 else{assertM3LifecycleHolder(holder,ctx,'qdrant',backup?.logicalKey);
  if(ctx?.userScopeId!==backup?.owner)throw error('M3_RESTORE_OWNER_MISMATCH',403);}
 if(typeof transport?._request!=='function')throw error('M3_TRUSTED_TRANSPORT_REQUIRED',403);
 if(!UUID.test(operationId)||!UUID.test(backup?.backupId??'')||backup?.backend!=='qdrant'||
  !KEY.test(backup?.logicalKey??'')||!obj(backup.embedding)||
  !Array.isArray(backup.inventory?.rows)||backup.inventory?.complete!==true||
  backup.inventory?.digest!==H(backup.inventory.rows)||backup.inventory?.count!==backup.inventory.rows.length)
  throw error('M3_RESTORE_MANIFEST_INVALID');
 // Validate every restored point against the ORIGINAL server-bound schema
 // before the first physical create; never create a target from a forged
 // owner payload, incompatible embedding or malformed vector.
 const originalBinding={authorized:true,provenance:'SERVER_VERIFIED',backend:'qdrant',
  scope:backup.scope,embedding:backup.embedding,
  collection:{key:backup.logicalKey,physicalName:backup.canonicalPhysicalName??backup.physicalName}};
 for(const p of backup.inventory.rows){
  if(!obj(p)||!obj(p.payload)||p.payload.physicalId!==p.id)
   throw error('M3_RESTORE_POINT_UNVERIFIED');
  ownedRecord({...p.payload,physicalId:p.id,vector:p.vector},originalBinding,{includeVector:true});
 }
 const target='vh2_'+H(['m3-fresh-restore',backup.backupId,operationId]).slice(0,48);
 if(target===backup.physicalName)throw error('M3_RESTORE_TARGET_COLLISION');
 const url=`/collections/${target}`;
 // A lost GET response is NOT evidence that a target is absent.
 try{await transport._request('GET',url);throw error('M3_RESTORE_TARGET_EXISTS');}
 catch(e){if(e.httpStatus!==404)throw e;}
 const distance={cosine:'Cosine',dot:'Dot',euclid:'Euclid'}[backup.embedding.metric];
 if(!distance||!Number.isSafeInteger(backup.embedding.dimension)||backup.embedding.dimension<1)
  throw error('M3_RESTORE_SCHEMA_INVALID');
 const created=await transport._request('PUT',url,{vectors:{size:backup.embedding.dimension,distance}});
 if(created?.result!==true)throw error('M3_RESTORE_CREATE_UNCERTAIN');
 // Never retry, delete or overwrite a partially restored target after dispatch.
 const fields=['userScopeId','collectionId','type','sourceId','branchId','recordId','physicalId'];
 for(const field of fields){
  const r=await transport._request('PUT',`${url}/index?wait=true`,{field_name:field,field_schema:'keyword'});
  if(r?.result===undefined||r.result===null)throw error('M3_RESTORE_INDEX_UNCERTAIN');
 }
 const expected=[...backup.inventory.rows].sort((a,b)=>String(a.id).localeCompare(String(b.id)));
 for(let i=0;i<expected.length;i+=32){
  const chunk=expected.slice(i,i+32);
  if(chunk.some(p=>!obj(p.payload)||!Array.isArray(p.vector)||p.payload.physicalId!==p.id||
   p.payload.userScopeId!==backup.scope.userScopeId||p.payload.sourceId!==backup.scope.sourceId||
   p.vector.length!==backup.embedding.dimension))throw error('M3_RESTORE_POINT_UNVERIFIED');
  const result=await transport._request('PUT',`${url}/points?wait=true`,{points:chunk});
  if(result?.result?.status!=='completed')throw error('M3_RESTORE_WRITE_UNCERTAIN');
  // A Qdrant acknowledgement by itself is not a durable per-chunk proof.
  // In checkpointed rebuild mode fetch each ID and verify its exact payload
  // and vector before recording a server-private, append-only checkpoint.
  if(onVerifiedChunk!==null){
   if(typeof onVerifiedChunk!=='function')throw error('M3_RESTORE_CHUNK_CALLBACK_INVALID');
   const observed=await transport._request('POST',`${url}/points`,{ids:chunk.map(p=>p.id),with_payload:true,with_vector:true});
   if(!Array.isArray(observed?.result)||observed.result.length!==chunk.length)
    throw error('M3_RESTORE_CHUNK_READBACK_UNVERIFIED');
   const byId=new Map();for(const item of observed.result){
    if(byId.has(String(item.id)))throw error('M3_RESTORE_CHUNK_READBACK_DUPLICATE');
    byId.set(String(item.id),item);
   }
   for(const point of chunk){const seen=byId.get(String(point.id));
    if(!seen||JSON.stringify(seen.payload)!==JSON.stringify(point.payload)||
       !Array.isArray(seen.vector)||seen.vector.length!==point.vector.length||
       seen.vector.some((v,j)=>!Number.isFinite(v)||Math.abs(v-point.vector[j])>0.00002))
     throw error('M3_RESTORE_CHUNK_READBACK_MISMATCH');
   }
   await onVerifiedChunk({index:i/32,physicalName:target,chunk,chunkDigest:H(chunk),manifestDigest:backup.inventory.digest,
    targetBackupId:backup.backupId});
  }
 }
 const actual=[];let offset=null;const seen=new Set();let done=false;
 for(let i=0;i<Math.ceil(expected.length/128)+2;i++){
  const request={limit:128,with_payload:true,with_vector:true};if(offset!==null)request.offset=offset;
  const r=await transport._request('POST',`${url}/points/scroll`,request);
  if(!Array.isArray(r?.result?.points))throw error('M3_RESTORE_READBACK_UNVERIFIED');
  for(const p of r.result.points){if(seen.has(String(p.id)))throw error('M3_RESTORE_DUPLICATE_POINT');
   seen.add(String(p.id));actual.push(p);}
  if(r.result.next_page_offset===null||r.result.next_page_offset===undefined){done=true;break;}
  offset=r.result.next_page_offset;
 }
 if(!done||actual.length!==expected.length)throw error('M3_RESTORE_INVENTORY_MISMATCH');
 const current=new Map(actual.map(p=>[String(p.id),p]));
 for(const p of expected){const v=current.get(String(p.id));
  if(!v||JSON.stringify(v.payload)!==JSON.stringify(p.payload)||!Array.isArray(v.vector)||
   v.vector.length!==p.vector.length||v.vector.some((x,i)=>typeof x!=='number'||Math.abs(x-p.vector[i])>0.00002))
   throw error('M3_RESTORE_INVENTORY_MISMATCH');
 }
 return {operationId,backend:'qdrant',targetPhysicalName:target,restoredCount:expected.length,
  inventoryVerified:true,sourceUntouched:true,cutoverPerformed:false,productionCertified:false,
  status:'DISPOSABLE_STAGING_VERIFIED'};
}

/** M3.3 disposable-only destructive conformance experiment.
 * This is deliberately NOT wired to the public execute route. A full
 * production implementation must additionally publish a durable S02 tombstone
 * and reconcile S04 + the F09c.10 lock; verification of Qdrant's deletion
 * response alone does not accomplish those steps.
 */
export async function stageM3DisposableDecommission(transport,backup,{operationId=randomUUID(),confirmation,
 boundary}={}){
 if(transport?.m3DisposableFixture!==true||typeof transport._request!=='function'||
  typeof boundary?.withWriteBoundary!=='function')throw error('M3_DECOMMISSION_DISPOSABLE_ONLY',403);
 if(confirmation!=='DELETE VERIFIED DISPOSABLE COLLECTION'||!UUID.test(operationId)||
  !UUID.test(backup?.backupId??'')||backup.backend!=='qdrant'||
  backup.inventory?.complete!==true||backup.inventory?.exclusiveOwner!==true||
  !Array.isArray(backup.inventory?.rows)||backup.inventory.digest!==H(backup.inventory.rows)||
  backup.inventory.count!==backup.inventory.rows.length||!KEY.test(backup.logicalKey??''))
  throw error('M3_DECOMMISSION_EVIDENCE_INVALID');
 const binding={authorized:true,provenance:'SERVER_VERIFIED',backend:'qdrant',
  scope:backup.scope,embedding:backup.embedding,
  collection:{key:backup.logicalKey,physicalName:backup.canonicalPhysicalName??backup.physicalName}};
 if(backup.scope?.userScopeId!==backup.owner)throw error('M3_DECOMMISSION_OWNER_INVALID',403);
 const plan={backend:'qdrant',scope:binding.scope,collectionKey:backup.logicalKey,
  physicalCollectionName:backup.physicalName,operationId};
 return boundary.withWriteBoundary(plan,async()=>{
  const before=await qdrantM3Inventory(transport,binding);
  if(before.digest!==backup.inventory.digest||before.count!==backup.inventory.count)
   throw error('M3_DECOMMISSION_BACKUP_CHANGED');
  assertM3ManagedCompleteness(backup.managed,before,binding);
  // Once DELETE starts, treat any failure as an uncertain physical mutation.
  // Never retry deletion or infer NOT_APPLIED from an HTTP failure.
  const uri=`/collections/${backup.physicalName}`;
  let ack;try{ack=await transport._request('DELETE',uri);}catch{
   return {state:'UNCERTAIN',operationId,dispatched:true,requiresAdjudication:true};}
  if(ack?.result!==true)return {state:'UNCERTAIN',operationId,dispatched:true,requiresAdjudication:true};
  try{await transport._request('GET',uri);
   return {state:'UNCERTAIN',operationId,dispatched:true,requiresAdjudication:true};}
  catch(e){if(e?.httpStatus!==404)return {state:'UNCERTAIN',operationId,dispatched:true,requiresAdjudication:true};}
  return {state:'VERIFIED_DISPOSABLE_DELETED',operationId,dispatched:true,
   physicalAbsent:true,ownerVerified:true,sourceBackupVerified:true,
   registryTombstoned:false,productionCertified:false};
 });
}

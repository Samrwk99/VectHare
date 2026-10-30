import {inspectM3LifecycleRecovery} from '../lib/m3-execution-audit.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {collectionIdentity,recordIdentity,contentFingerprint} from '../lib/s02-identity.js';
import {executeM3TrustedRestore,m3QdrantSmokeQueries} from '../lib/m3-lifecycle-transaction.js';
import {M3Store} from '../lib/m3-collections.js';
import {resolveM3ReadBinding} from '../lib/m3-target-receipts.js';
import {M3CutoverJournal} from '../lib/m3-cutover-journal.js';
import {planM3TrustedRollback,executeM3TrustedRollback} from '../lib/m3-rollback-transaction.js';
import {planM3Rollback,executeM3Collection,m3ActionReadiness} from '../lib/m3-collections.js';
import {capabilityMatrix} from '../lib/m0-capabilities.js';
import {M3_IMPLEMENTATION_EVIDENCE} from '../lib/m3-collections.js';
import {executeM3TrustedEmpty} from '../lib/m3-empty-transaction.js';
import {ManagedChatRegistry} from '../lib/f09b4-managed-registry.js';
import {CollectionRegistry} from '../lib/s02-registry.js';
const H=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const scope={userScopeId:'alice',collectionId:'a',type:'chat',sourceId:'chat-a',branchId:'branch'};
const embedding={source:'transformers',model:'fixture',dimension:3,metric:'cosine'};
const source={kind:'chat',avatar:'a.png',chatFile:'a'};
const collection=collectionIdentity({backend:'qdrant',scope,embedding});
const binding={authorized:true,provenance:'SERVER_VERIFIED',backend:'qdrant',scope,embedding,
 collection:{key:collection.key,physicalName:collection.physicalName}};
const indexes=Object.fromEntries(['userScopeId','collectionId','type','sourceId','branchId','recordId','physicalId'].map(k=>[k,{data_type:'keyword'}]));
async function fx({failWrite=false,failCreate=false,allowCanonical=false}={}){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'m3e-lifecycle-'));await fs.chmod(dir,0o700);
 const ctx={userScopeId:'alice',vectorsPath:dir},req={s03:ctx,user:{directories:{}},body:{}};
 const recordId=randomUUID(),physicalId=recordIdentity(scope,recordId).physicalId,text='restored sample';
 const hash=contentFingerprint(text),vec=[1,0,0];
 const meta={vecthareRecordV2:{schemaVersion:2,recordId,identity:{userScopeId:'alice',sourceId:scope.sourceId},contentHash:hash,revision:1}};
 const point={id:physicalId,vector:vec,payload:{...scope,recordId,physicalId,revision:1,text,textHash:hash,
  metadata:meta,metadataHash:H(meta),embedding,vectorHash:H(vec),vectorReference:vec}};
 const rows=[point];
 const db=new ManagedChatRegistry(ctx,binding);
 await db.setup();await db.save({schemaVersion:1,owner:'alice',sourceId:scope.sourceId,collectionKey:collection.key,records:{[recordId]:{state:'ACTIVE',recordId,contentHash:hash,revision:1,operationId:null}}});
 const managed=await db.read();
 const backup={schemaVersion:1,backupId:randomUUID(),owner:'alice',backend:'qdrant',logicalKey:collection.key,
  physicalName:collection.physicalName,scope,embedding,source,configId:'default',sourceId:scope.sourceId,
  savedSourceFingerprint:'b'.repeat(64),managed,operationCheckpoint:{count:0,digest:H([])},
  inventory:{rows,count:1,digest:H(rows),complete:true,exclusiveOwner:true}};
 const operationId=randomUUID(),ticket={schemaVersion:1,operationId,owner:'alice',action:'restore',backend:'qdrant',
  source,configId:'default',backupId:backup.backupId,logicalKey:collection.key,physicalName:collection.physicalName,
  sourceFingerprint:backup.savedSourceFingerprint,inventoryDigest:backup.inventory.digest,
  managedFingerprint:managed.fingerprint,createdAt:Date.now(),expiresAt:Date.now()+200000};
 const store=new M3Store(ctx);await store.write('backup',backup);await store.write('operation',ticket);
 let target=null,writeCount=0,canonicalReadable=true,deleteCalls=0,failDelete=false;const targets=new Map();
 const transport={_request:async(method,url,body)=>{
  if(url.startsWith(`/collections/${collection.physicalName}`)){
   if(!allowCanonical)throw Error('ORIGINAL_UNEXPECTED_PHYSICAL_IO');
   if(!canonicalReadable)throw Object.assign(new Error('offline'),{httpStatus:404});
   const suffix=url.slice(`/collections/${collection.physicalName}`.length);
   if(method==='GET'&&suffix==='')return {result:{config:{params:{vectors:{size:3,distance:'Cosine'}}},payload_schema:indexes}};
   if(method==='POST'&&suffix==='/points/scroll')return {result:{points:structuredClone(rows),next_page_offset:null}};
   if(method==='POST'&&suffix==='/points/query')return {result:{points:structuredClone(rows)}};
   throw Error('CANONICAL_READ_ONLY');
  }
  const match=url.match(/^\/collections\/(vh2_[a-f0-9]{48})(.*)$/);
  assert.ok(match,'target must be Qdrant collection');target=match[1];const suffix=match[2];
  if(method==='DELETE'&&suffix===''){deleteCalls++;if(failDelete)throw Error('LOST_DELETE_RESPONSE');
   if(!targets.has(target))throw Error('TARGET_ABSENT');targets.delete(target);return {result:true};}
  if(method==='GET'&&suffix===''){
   if(!targets.has(target))throw Object.assign(new Error('not found'),{httpStatus:404});
   return {result:{config:{params:{vectors:{size:3,distance:'Cosine'}}},payload_schema:indexes}};
  }
  if(method==='PUT'&&suffix===''){
   if(targets.has(target))throw Error('SECOND_CREATE');targets.set(target,[]);if(failCreate)throw Error('INJECTED_LOST_CREATE_RESPONSE');return {result:true};
  }
  if(method==='PUT'&&suffix.startsWith('/index'))return {result:true};
  if(method==='PUT'&&suffix==='/points?wait=true'){
   writeCount++;
   if(failWrite)throw Error('INJECTED_LOST_QDRANT_RESPONSE');
   targets.get(target).push(...structuredClone(body.points));return {result:{status:'completed'}};
  }
  if(method==='POST'&&suffix==='/points/scroll')return {result:{points:structuredClone(targets.get(target)??[]),next_page_offset:null}};
  if(method==='POST'&&suffix==='/points/query')return {result:{points:structuredClone(targets.get(target)??[])}};
  throw Error('UNEXPECTED_REQUEST:'+method+':'+url);
 }};
 const deps={transport:async()=>transport,getProfile:async()=>({configured:true,profile:embedding}),
  bind:async()=>({binding}),receipt:async()=>({state:'SCHEMA_VERIFIED_OFFLINE_UNCERTIFIED'}),
  jobs:()=>({assertNoLease:async()=>true}),readSnapshot:async()=>({fileHash:backup.savedSourceFingerprint,sourceId:scope.sourceId}),
  registry:()=>db,ledgerCheckpoint:async()=>backup.operationCheckpoint,
  inventory:async()=>({rows,digest:H(rows),count:1,complete:true,exclusiveOwner:true})};
 return {ctx,req,store,backup,operationId,transport,deps,db,addPoint:p=>targets.get(target)?.push(p),readCount:()=>writeCount,target:()=>target,
  makeCanonicalUnavailable:()=>{canonicalReadable=false;},
  setDeleteFailure:x=>{failDelete=x;},deleteCalls:()=>deleteCalls,
  cleanup:()=>fs.rm(dir,{recursive:true,force:true})};
}


test('M3.4 scoped empty preserves original physical collection, verifies zero-target and tombstones managed entries',async()=>{
 const f=await fx({allowCanonical:true});try{
  const id=randomUUID();await f.store.write('operation',{
   schemaVersion:1,operationId:id,owner:'alice',action:'empty',backend:'qdrant',
   phase:'PLANNED',source,configId:'default',backupId:f.backup.backupId,
   logicalKey:collection.key,physicalName:collection.physicalName,
   sourceFingerprint:f.backup.savedSourceFingerprint,inventoryDigest:f.backup.inventory.digest,
   managedFingerprint:f.backup.managed.fingerprint,createdAt:Date.now(),expiresAt:Date.now()+200000});
  f.req.body={operationId:id,confirmation:'EMPTY OWNED COLLECTION'};
  const output=await executeM3Collection(f.req,f.deps);
  assert.equal(output.state,'VERIFIED');assert.equal(output.verifiedEmpty,true);
  assert.equal(output.generation,1);assert.equal(output.emptiedCount,1);
  const active=await new M3CutoverJournal(f.ctx,{logicalKey:collection.key}).resolve(binding);
  assert.equal(active.physicalName,output.physicalName);
  assert.equal((await f.db.read()).records[Object.keys(f.backup.managed.records)[0]].state,'DELETED');
  const derived=await f.store.read('backup',output.emptyTargetBackupId);
  assert.equal(derived.inventory.count,0);assert.equal(derived.derivedFromBackupId,f.backup.backupId);
  const routed=await resolveM3ReadBinding(f.ctx,binding,{transport:f.transport});
  assert.equal(routed.collection.generation,1);
  await assert.rejects(()=>executeM3TrustedEmpty(f.req,id,f.deps),{code:'M3_EMPTY_STALE_GENERATION'});
 }finally{await f.cleanup();}
});
test('M3.4 stale saved source refuses before one-shot claim and does not tombstone',async()=>{
 const f=await fx({allowCanonical:true});try{
  const id=randomUUID();await f.store.write('operation',{
   schemaVersion:1,operationId:id,owner:'alice',action:'empty',backend:'qdrant',
   phase:'PLANNED',source,configId:'default',backupId:f.backup.backupId,
   logicalKey:collection.key,physicalName:collection.physicalName,
   sourceFingerprint:f.backup.savedSourceFingerprint,inventoryDigest:f.backup.inventory.digest,
   managedFingerprint:f.backup.managed.fingerprint,createdAt:Date.now(),expiresAt:Date.now()+200000});
  await assert.rejects(()=>executeM3TrustedEmpty(f.req,id,{...f.deps,readSnapshot:async()=>({fileHash:'a'.repeat(64),sourceId:scope.sourceId})}),{code:'M3_EMPTY_SAVED_SOURCE_CHANGED'});
  assert.equal((await f.db.read()).records[Object.keys(f.backup.managed.records)[0]].state,'ACTIVE');
  const planned=await f.store.read('operation',id);assert.equal(planned.action,'empty');
 }finally{await f.cleanup();}
});

test('M3.4 lost create response retains the logical exclusion and forbids replay',async()=>{
 const f=await fx({allowCanonical:true,failCreate:true});try{
  const id=randomUUID();await f.store.write('operation',{
   schemaVersion:1,operationId:id,owner:'alice',action:'empty',backend:'qdrant',
   phase:'PLANNED',source,configId:'default',backupId:f.backup.backupId,
   logicalKey:collection.key,physicalName:collection.physicalName,
   sourceFingerprint:f.backup.savedSourceFingerprint,inventoryDigest:f.backup.inventory.digest,
   managedFingerprint:f.backup.managed.fingerprint,createdAt:Date.now(),expiresAt:Date.now()+200000});
  await assert.rejects(()=>executeM3TrustedEmpty(f.req,id,f.deps),/INJECTED_LOST_CREATE_RESPONSE/);
  assert.equal((await f.db.read()).records[Object.keys(f.backup.managed.records)[0]].state,'ACTIVE');
  const recovery=await inspectM3LifecycleRecovery(f.ctx,id);
  assert.equal(recovery.claimed,true);assert.equal(recovery.lastStage,'DISPATCH_PENDING');
  assert.equal(recovery.automaticReplayAuthorized,false);
  await assert.rejects(()=>executeM3TrustedEmpty(f.req,id,f.deps),{code:'M3_LOGICAL_COLLECTION_BUSY'});
 }finally{await f.cleanup();}
});

test('M3.4 implementation evidence enables only Qdrant scoped empty, not general purge or new-model rebuild',()=>{
 const ready=m3ActionReadiness('empty');assert.equal(ready.enabled,true);
 assert.equal(ready.validationStatus,'AWAITING_MANUAL_TEST');
 assert.equal(m3ActionReadiness('rebuild').mode,'BLOCKED');
 const cells=capabilityMatrix({implementationEvidenceByOperation:{'qdrant:scoped-purge':M3_IMPLEMENTATION_EVIDENCE}});
 assert.equal(cells.find(c=>c.backend==='qdrant'&&c.operation==='scoped-purge').mode,'ENABLED');
 assert.equal(cells.find(c=>c.backend==='milvus'&&c.operation==='scoped-purge').mode,'BLOCKED');
 assert.equal(cells.find(c=>c.backend==='standard'&&c.operation==='scoped-purge').mode,'UNSUPPORTED_BY_DESIGN');
});

test('M3v7 backs up verified active empty generation after cutover without reading original physical collection',async()=>{
 const {captureM3Backup,previewM3Collection,qdrantM3Inventory}=await import('../lib/m3-collections.js');
 const f=await fx({allowCanonical:true});try{
  const id=randomUUID();await f.store.write('operation',{
   schemaVersion:1,operationId:id,owner:'alice',action:'empty',backend:'qdrant',
   phase:'PLANNED',source,configId:'default',backupId:f.backup.backupId,
   logicalKey:collection.key,physicalName:collection.physicalName,
   sourceFingerprint:f.backup.savedSourceFingerprint,inventoryDigest:f.backup.inventory.digest,
   managedFingerprint:f.backup.managed.fingerprint,createdAt:Date.now(),expiresAt:Date.now()+200000});
  f.req.body={operationId:id,confirmation:'EMPTY OWNED COLLECTION'};
  const result=await executeM3Collection(f.req,f.deps);
  assert.equal(result.state,'VERIFIED');
  f.req.body={backend:'qdrant',source,configId:'default',confirmation:'CAPTURE OWNED LOGICAL BACKUP'};
  const deps={...f.deps,inventory:(_req,live)=>qdrantM3Inventory(f.transport,live)};
  const saved=await captureM3Backup(f.req,deps);
  f.req.body={backend:'qdrant',source,configId:'default'};
  const preview=await previewM3Collection(f.req,deps);
  assert.equal(preview.operationModes.backup,'ENABLED');
  assert.equal(preview.operationModes.delete,'ENABLED');
  assert.equal(preview.operationModes.empty,'ENABLED');
  assert.equal(saved.routingGeneration,1);assert.equal(saved.count,0);
  const document=await f.store.read('backup',saved.backupId);
  assert.equal(document.physicalName,result.physicalName);
  assert.equal(document.canonicalPhysicalName,collection.physicalName);
  assert.equal(document.routingGeneration,1);
  assert.equal(document.inventory.rows.length,0);
 }finally{await f.cleanup();}
});

test('M3v11 repeated scoped empty follows verified generation, creates new backup, and fences stale plans',async()=>{
 const {captureM3Backup,planM3Collection,qdrantM3Inventory}=await import('../lib/m3-collections.js');
 const f=await fx({allowCanonical:true});try{
  const firstId=randomUUID();
  await f.store.write('operation',{schemaVersion:1,operationId:firstId,owner:'alice',action:'empty',backend:'qdrant',phase:'PLANNED',
   source,configId:'default',backupId:f.backup.backupId,logicalKey:collection.key,physicalName:collection.physicalName,
   sourceFingerprint:f.backup.savedSourceFingerprint,inventoryDigest:f.backup.inventory.digest,
   managedFingerprint:f.backup.managed.fingerprint,createdAt:Date.now(),expiresAt:Date.now()+200000});
  f.req.body={operationId:firstId,confirmation:'EMPTY OWNED COLLECTION'};
  const first=await executeM3Collection(f.req,f.deps);
  assert.equal(first.generation,1);
  const deps={...f.deps,bind:async(_request,_selector,opts)=>{
   assert.equal(opts?.readAlias,true,'server must explicitly request guarded alias resolution');
   return {binding};
  },inventory:(_req,live)=>qdrantM3Inventory(f.transport,live)};
  f.req.body={backend:'qdrant',source,configId:'default',confirmation:'CAPTURE OWNED LOGICAL BACKUP'};
  const snapshot=await captureM3Backup(f.req,deps);
  assert.equal(snapshot.routingGeneration,1);
  f.req.body={backend:'qdrant',source,configId:'default',action:'empty',backupId:snapshot.backupId};
  const plan=await planM3Collection(f.req,deps);
  assert.equal(plan.executionAllowed,true);
  const ticket=await f.store.read('operation',plan.operationId);
  assert.equal(ticket.routingGeneration,1);
  assert.equal(ticket.physicalName,first.physicalName);
  assert.equal(ticket.canonicalPhysicalName,collection.physicalName);
  f.req.body={operationId:plan.operationId,confirmation:'EMPTY OWNED COLLECTION'};
  const second=await executeM3Collection(f.req,deps);
  assert.equal(second.generation,2);
  assert.notEqual(second.physicalName,first.physicalName);
  const active=await resolveM3ReadBinding(f.ctx,binding,{transport:f.transport});
  assert.equal(active.collection.generation,2);
  assert.equal(active.collection.physicalName,second.physicalName);
  const lastBackup=await f.store.read('backup',second.emptyTargetBackupId);
  assert.equal(lastBackup.inventory.count,0);
  assert.equal((await f.db.read()).records[Object.keys(f.backup.managed.records)[0]].state,'DELETED');
  await assert.rejects(()=>executeM3TrustedEmpty(f.req,firstId,deps),{code:'M3_EMPTY_STALE_GENERATION'});
 }finally{await f.cleanup();}
});

test('M3v11 restore after a published empty generation uses the actual live backup',async()=>{
 const {captureM3Backup,planM3Collection,qdrantM3Inventory}=await import('../lib/m3-collections.js');
 const f=await fx({allowCanonical:true});try{
  const firstId=randomUUID();
  await f.store.write('operation',{schemaVersion:1,operationId:firstId,owner:'alice',action:'empty',backend:'qdrant',phase:'PLANNED',
   source,configId:'default',backupId:f.backup.backupId,logicalKey:collection.key,physicalName:collection.physicalName,
   sourceFingerprint:f.backup.savedSourceFingerprint,inventoryDigest:f.backup.inventory.digest,
   managedFingerprint:f.backup.managed.fingerprint,createdAt:Date.now(),expiresAt:Date.now()+200000});
  f.req.body={operationId:firstId,confirmation:'EMPTY OWNED COLLECTION'};
  const first=await executeM3Collection(f.req,f.deps);
  const deps={...f.deps,bind:async(_request,_selector,opts)=>{
   assert.equal(opts?.readAlias,true,'server must explicitly request guarded alias resolution');
   return {binding};
  },inventory:(_req,live)=>qdrantM3Inventory(f.transport,live)};
  f.req.body={backend:'qdrant',source,configId:'default',confirmation:'CAPTURE OWNED LOGICAL BACKUP'};
  const snapshot=await captureM3Backup(f.req,deps);
  f.req.body={backend:'qdrant',source,configId:'default',action:'restore',backupId:snapshot.backupId};
  const plan=await planM3Collection(f.req,deps);
  f.req.body={operationId:plan.operationId,confirmation:'RESTORE TO FRESH COLLECTION'};
  const restored=await executeM3Collection(f.req,deps);
  assert.equal(restored.state,'VERIFIED');
  assert.equal(restored.generation,2);
  assert.equal(restored.restoredCount,0);
  const current=await resolveM3ReadBinding(f.ctx,binding,{transport:f.transport});
  assert.equal(current.collection.physicalName,restored.physicalName);
  assert.notEqual(current.collection.physicalName,first.physicalName);
  assert.equal(current.collection.generation,2);
 }finally{await f.cleanup();}
});


test('M3v12 delete after cutover tombstones S02, deletes only current generation and retains historical copies',async()=>{
 const {captureM3Backup,planM3Collection,qdrantM3Inventory}=await import('../lib/m3-collections.js');
 const f=await fx({allowCanonical:true});try{
  const s02=new CollectionRegistry(path.join(f.ctx.vectorsPath,'.similharity'));
  await s02.reserve({backend:'qdrant',scope,embedding});
  const firstId=randomUUID();
  await f.store.write('operation',{schemaVersion:1,operationId:firstId,owner:'alice',action:'empty',backend:'qdrant',phase:'PLANNED',
   source,configId:'default',backupId:f.backup.backupId,logicalKey:collection.key,physicalName:collection.physicalName,
   sourceFingerprint:f.backup.savedSourceFingerprint,inventoryDigest:f.backup.inventory.digest,
   managedFingerprint:f.backup.managed.fingerprint,createdAt:Date.now(),expiresAt:Date.now()+200000});
  f.req.body={operationId:firstId,confirmation:'EMPTY OWNED COLLECTION'};
  const first=await executeM3Collection(f.req,f.deps);
  const deps={...f.deps,bind:async(_request,_selector,opts)=>{assert.equal(opts?.readAlias,true);return {binding};},
   inventory:(_request,live)=>qdrantM3Inventory(f.transport,live)};
  f.req.body={backend:'qdrant',source,configId:'default',confirmation:'CAPTURE OWNED LOGICAL BACKUP'};
  const snapshot=await captureM3Backup(f.req,deps);
  f.req.body={backend:'qdrant',source,configId:'default',action:'delete',backupId:snapshot.backupId};
  const plan=await planM3Collection(f.req,deps);
  assert.equal(plan.executionAllowed,true);
  f.req.body={operationId:plan.operationId,confirmation:'DELETE OWNED COLLECTION'};
  const removed=await executeM3Collection(f.req,deps);
  assert.equal(removed.state,'VERIFIED');assert.equal(removed.deletedActivePhysicalName,first.physicalName);
  assert.equal(removed.historicalCollectionsDeleted,false);assert.equal(removed.retainedHistoricalCollections.length,1);
  assert.equal(removed.retainedHistoricalCollections[0].physicalName,collection.physicalName);
  assert.equal(f.deleteCalls(),1);
  const entry=await s02.lookup({backend:'qdrant',scope,embedding});
  assert.equal(entry.status,'DELETED');
  const receipt=await f.store.read('deletion',plan.operationId);
  assert.equal(receipt.retainedHistoricalCollections.length,1);
  assert.equal(receipt.historicalCollectionsDeleted,false);
  await assert.rejects(()=>executeM3Collection(f.req,deps));assert.equal(f.deleteCalls(),1);
 }finally{await f.cleanup();}
});

test('M3v12 deletion after cutover refuses missing historical backup and retains Qdrant active target',async()=>{
 const {captureM3Backup,planM3Collection,qdrantM3Inventory}=await import('../lib/m3-collections.js');
 const f=await fx({allowCanonical:true});try{
  const s02=new CollectionRegistry(path.join(f.ctx.vectorsPath,'.similharity'));
  await s02.reserve({backend:'qdrant',scope,embedding});
  const firstId=randomUUID();
  await f.store.write('operation',{schemaVersion:1,operationId:firstId,owner:'alice',action:'empty',backend:'qdrant',phase:'PLANNED',
   source,configId:'default',backupId:f.backup.backupId,logicalKey:collection.key,physicalName:collection.physicalName,
   sourceFingerprint:f.backup.savedSourceFingerprint,inventoryDigest:f.backup.inventory.digest,
   managedFingerprint:f.backup.managed.fingerprint,createdAt:Date.now(),expiresAt:Date.now()+200000});
  f.req.body={operationId:firstId,confirmation:'EMPTY OWNED COLLECTION'};
  const first=await executeM3Collection(f.req,f.deps);
  const deps={...f.deps,bind:async()=>({binding}),inventory:(_request,live)=>qdrantM3Inventory(f.transport,live)};
  f.req.body={backend:'qdrant',source,configId:'default',confirmation:'CAPTURE OWNED LOGICAL BACKUP'};
  const snapshot=await captureM3Backup(f.req,deps);
  f.req.body={backend:'qdrant',source,configId:'default',action:'delete',backupId:snapshot.backupId};
  const plan=await planM3Collection(f.req,deps);
  await fs.unlink(f.store.file('backup',f.backup.backupId));
  f.req.body={operationId:plan.operationId,confirmation:'DELETE OWNED COLLECTION'};
  await assert.rejects(()=>executeM3Collection(f.req,deps));assert.equal(f.deleteCalls(),0);
  const current=await new M3CutoverJournal(f.ctx,{logicalKey:collection.key}).resolve(binding);
  assert.equal(current.physicalName,first.physicalName);
  assert.equal((await s02.lookup({backend:'qdrant',scope,embedding})).status,'RESERVED_NOT_ACTIVE');
 }finally{await f.cleanup();}
});

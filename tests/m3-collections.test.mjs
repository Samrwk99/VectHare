import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {collectionIdentity,recordIdentity,contentFingerprint} from '../lib/s02-identity.js';
import {validateM3Selector,M3Store,captureM3Backup,inspectM3Backup,planM3Collection,
 executeM3Collection,previewM3Collection,qdrantM3Inventory} from '../lib/m3-collections.js';
const H=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const scope={userScopeId:'alice',collectionId:'a',type:'chat',sourceId:'chat-a',branchId:'branch'};
const source={kind:'chat',avatar:'a.png',chatFile:'a'};
const embedding={source:'transformers',model:'fixture',dimension:3,metric:'cosine'};
const collection=collectionIdentity({backend:'qdrant',scope,embedding});
const binding={authorized:true,provenance:'SERVER_VERIFIED',backend:'qdrant',scope,embedding,
 collection:{key:collection.key,physicalName:collection.physicalName}};
const rowId=randomUUID(),pointId=recordIdentity(scope,rowId).physicalId;
const text='sample',meta={vecthareRecordV2:{schemaVersion:2,recordId:rowId,identity:{userScopeId:'alice',sourceId:scope.sourceId},contentHash:contentFingerprint('sample'),revision:1}},vector=[1,0,0];
const point={id:pointId,vector,payload:{...scope,recordId:rowId,physicalId:pointId,branchId:scope.branchId,
 revision:1,text,textHash:contentFingerprint(text),metadata:meta,metadataHash:H(meta),
 embedding,vectorHash:H(vector),vectorReference:vector}};
async function fixture(){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'m3-collections-'));await fs.chmod(dir,0o700);
 const s={fileHash:'a'.repeat(64),sourceId:scope.sourceId},managed={records:{[rowId]:{state:'ACTIVE',recordId:rowId,contentHash:contentFingerprint(text),revision:1}},fingerprint:'c'.repeat(64)};
 const rows=[structuredClone(point)],calls=[];
 const req={s03:{userScopeId:scope.userScopeId,vectorsPath:dir},user:{directories:{}},body:{}};
 const deps={getProfile:async()=>({configured:true,profile:embedding}),bind:async()=>({binding}),
  readSnapshot:async()=>({...s}),receipt:async()=>({state:'SCHEMA_VERIFIED_OFFLINE_UNCERTIFIED'}),
  registry:()=>({read:async()=>structuredClone(managed)}),jobs:()=>({assertNoLease:async()=>{if(s.lease)throw Error('LEASE');}}),
  ledgerCheckpoint:async()=>({count:0,digest:H([])}),store:ctx=>new M3Store(ctx),
  boundary:()=>({withWriteBoundary:async(_p,fn)=>{calls.push('locked');return fn();}}),
  inventory:async()=>({rows:structuredClone(rows),digest:H(rows),count:rows.length,complete:true,exclusiveOwner:true})};
 return {dir,s,managed,rows,req,deps,calls,cleanup:()=>fs.rm(dir,{recursive:true,force:true})};
}
const base={backend:'qdrant',source};
test('M3 refuses forged owner, vectors, physical names, arbitrary backend and selectors',()=>{
 assert.equal(validateM3Selector(base),base);
 for(const extra of [{ownerId:'alice'},{physicalName:collection.physicalName},{vector:[1,0,0]},
   {text:'spoof'},{url:'http://localhost'},{embedding}]){
  assert.throws(()=>validateM3Selector({...base,...extra}),{code:'M3_SOURCE_SELECTOR_INVALID'});
 }
 assert.throws(()=>validateM3Selector({...base,backend:'milvus'}));
 assert.throws(()=>validateM3Selector({...base,source:{...source,filepath:'/etc/passwd'}}));
 assert.throws(()=>validateM3Selector({...base,action:'delete',backupId:randomUUID()},{action:false}));
});
test('M3 logical backup records complete inventory, registry and ledger without dispatch',async()=>{
 const f=await fixture();try{
  f.req.body={...base};const p=await previewM3Collection(f.req,f.deps);
  assert.equal(p.ownerVerified,true);assert.equal(p.recordCount,1);
  assert.equal(p.operationModes.delete,'ENABLED');assert.equal(p.operationModes.empty,'ENABLED');
  f.req.body={...base,confirmation:'CAPTURE OWNED LOGICAL BACKUP'};
  const b=await captureM3Backup(f.req,f.deps);
  assert.equal(b.state,'VERIFIED');assert.equal(b.count,1);assert.deepEqual(f.calls,['locked']);
  const verified=await inspectM3Backup(f.req,b.backupId,f.deps);
  assert.equal(verified.integrityVerified,true);
  const store=new M3Store(f.req.s03),doc=await store.read('backup',b.backupId);
  assert.deepEqual(doc.inventory.rows,f.rows);assert.equal(doc.operationCheckpoint.digest,H([]));
  f.req.body={...base,action:'delete',backupId:b.backupId};
  const ticket=await planM3Collection(f.req,f.deps);
  assert.equal(ticket.executionAllowed,true);assert.equal(ticket.action,'delete');
  f.req.body={operationId:ticket.operationId,confirmation:'DELETE OWNED COLLECTION'};
  await assert.rejects(()=>executeM3Collection(f.req,f.deps)); // fixture lacks real Qdrant server and S02 proof
  assert.equal(f.rows.length,1,'blocked physical mutation must leave rows untouched');
 }finally{await f.cleanup();}
});
test('M3 refuses stale source, registry, inventory, outstanding job and corrupt backup',async()=>{
 const f=await fixture();try{
  f.req.body={...base,confirmation:'CAPTURE OWNED LOGICAL BACKUP'};
  const b=await captureM3Backup(f.req,f.deps);
  f.req.body={...base,action:'empty',backupId:b.backupId};
  f.rows.push({...point,id:randomUUID()});
  await assert.rejects(()=>planM3Collection(f.req,f.deps),{code:'M3_BACKUP_INVENTORY_CHANGED'});
  f.rows.pop();f.s.fileHash='b'.repeat(64);
  await assert.rejects(()=>planM3Collection(f.req,f.deps),{code:'M3_BACKUP_STALE_OR_WRONG_SCOPE'});
  f.s.fileHash='a'.repeat(64);f.managed.fingerprint='d'.repeat(64);
  await assert.rejects(()=>planM3Collection(f.req,f.deps),{code:'M3_BACKUP_STALE_OR_WRONG_SCOPE'});
  f.managed.fingerprint='c'.repeat(64);f.s.lease=true;
  await assert.rejects(()=>planM3Collection(f.req,f.deps),/LEASE/);
  f.s.lease=false;
  const store=new M3Store(f.req.s03),file=store.file('backup',b.backupId);
  await fs.writeFile(file,JSON.stringify({backupId:b.backupId,owner:'alice',seal:'forged'}));
  await assert.rejects(()=>inspectM3Backup(f.req,b.backupId,f.deps),{code:'M3_DOCUMENT_CORRUPT'});
 }finally{await f.cleanup();}
});
test('M3 physical inventory inspects WHOLE Qdrant collection, rejects foreign/duplicate/incomplete pages',async()=>{
 const schema={result:{config:{params:{vectors:{size:3,distance:'Cosine'}}},payload_schema:Object.fromEntries(
  ['userScopeId','collectionId','type','sourceId','branchId','recordId','physicalId'].map(k=>[k,{data_type:'keyword'}]))}};
 let points=[structuredClone(point)],offset=null;
 const transport={_request:async(method,url,body)=>{
  if(method==='GET')return schema;
  assert.equal(body.with_vector,true);assert.equal(body.filter,undefined,'inventory must NOT be owner-filtered');
  return {result:{points,next_page_offset:offset}};
 }};
 const good=await qdrantM3Inventory(transport,binding);
 assert.equal(good.count,1);assert.equal(good.exclusiveOwner,true);
 points=[{...point,payload:{...point.payload,userScopeId:'bob'}}];
 await assert.rejects(()=>qdrantM3Inventory(transport,binding),{code:'S05_OWNER_MISMATCH'});
 points=[point,point];await assert.rejects(()=>qdrantM3Inventory(transport,binding),{code:'M3_DUPLICATE_RECORD'});
 points=[point];offset=1;
 await assert.rejects(()=>qdrantM3Inventory(transport,binding),{code:'M3_DUPLICATE_RECORD'});
});
test('M3 operation plans one-way and refuses second consume if claimed',async()=>{
 const f=await fixture();try{
  f.req.body={...base,confirmation:'CAPTURE OWNED LOGICAL BACKUP'};
  const b=await captureM3Backup(f.req,f.deps);
  f.req.body={...base,action:'restore',backupId:b.backupId};
  const p=await planM3Collection(f.req,f.deps),store=new M3Store(f.req.s03);
  await store.claim(p.operationId);
  await assert.rejects(()=>store.claim(p.operationId),{code:'M3_OPERATION_ALREADY_CLAIMED'});
 }finally{await f.cleanup();}
});

test('M3 disposable fresh restore is copy-only, verified and never cutover',async()=>{
 const {stageM3DisposableRestore}=await import('../lib/m3-collections.js');
 const backup={backupId:randomUUID(),backend:'qdrant',logicalKey:collection.key,
  physicalName:collection.physicalName,scope,embedding,
  inventory:{rows:[point],count:1,complete:true,digest:H([point])}};
 const copies=new Map(),trace=[];
 const backend={m3DisposableFixture:true,async _request(method,url,body){trace.push([method,url]);
  if(method==='GET'&&url.startsWith('/collections/'))throw Object.assign(Error('absent'),{httpStatus:404});
  if(method==='PUT'&&url.endsWith('/index?wait=true'))return {result:{status:'completed'}};
  if(method==='PUT'&&url.endsWith('/points?wait=true')){
   for(const p of body.points)copies.set(p.id,structuredClone(p));return {result:{status:'completed'}};}
  if(method==='PUT')return {result:true};
  if(method==='POST'&&url.endsWith('/points/scroll'))return {result:{points:[...copies.values()],next_page_offset:null}};
  throw Error('UNEXPECTED_DISPATCH');}};
 const result=await stageM3DisposableRestore(backend,backup);
 assert.equal(result.inventoryVerified,true);assert.equal(result.cutoverPerformed,false);
 assert.equal(result.restoredCount,1);
 assert.ok(result.targetPhysicalName!==collection.physicalName);
 assert.ok(trace.every(([m,u])=>m!=='DELETE'&&!u.includes(collection.physicalName)));
 await assert.rejects(()=>stageM3DisposableRestore({_request:backend._request},backup),{code:'M3_RESTORE_DISPOSABLE_ONLY'});
 await assert.rejects(()=>stageM3DisposableRestore(backend,{...backup,inventory:{...backup.inventory,digest:'bad'}}),{code:'M3_RESTORE_MANIFEST_INVALID'});
});

test('M3 destructive plans require fully registry-managed records, never merely matching owner fields',async()=>{
 const f=await fixture();try{
  f.req.body={...base,confirmation:'CAPTURE OWNED LOGICAL BACKUP'};
  const b=await captureM3Backup(f.req,f.deps);
  f.req.body={...base,action:'delete',backupId:b.backupId};
  f.managed.records={};
  await assert.rejects(()=>planM3Collection(f.req,f.deps),{code:'M3_UNMANAGED_RECORDS_PRESENT'});
  f.managed.records={[rowId]:{state:'ACTIVE',recordId:rowId,contentHash:contentFingerprint(text),revision:1}};
  f.rows[0].payload.metadata.vecthareRecordV2.identity.userScopeId='other';
  // The physical inventory has changed and is detected before the managed
  // completeness check; neither a valid owner prefix nor an old backup grants deletion.
  await assert.rejects(()=>planM3Collection(f.req,f.deps),{code:'M3_BACKUP_INVENTORY_CHANGED'});
 }finally{await f.cleanup();}
});

test('M3 backup refuses unfinished cutover and a published alias lacking a verified target receipt',async()=>{
 const {M3CutoverJournal}=await import('../lib/m3-cutover-journal.js');
 const f=await fixture();try{
  const j=new M3CutoverJournal(f.req.s03,{logicalKey:collection.key});
  const op=randomUUID(),target='vh2_'+'e'.repeat(48);
  const proof={verified:true,exclusiveOwner:true,schemaVerified:true,inventoryVerified:true,
   physicalName:target,logicalKey:collection.key};
  await j.prepare(binding,{operationId:op,targetPhysicalName:target,backupDigest:'a'.repeat(64),proof});
  f.req.body={...base,confirmation:'CAPTURE OWNED LOGICAL BACKUP'};
  await assert.rejects(()=>captureM3Backup(f.req,f.deps),{code:'M3_JOURNAL_TRANSITION_REVIEW_REQUIRED'});
  await j.publish(binding,{operationId:op,proof});
  await assert.rejects(()=>captureM3Backup(f.req,f.deps),{code:'M3_READ_TARGET_RECEIPT_INVALID'});
  assert.deepEqual(f.calls,[],'neither state may acquire a destructive write path');
 }finally{await f.cleanup();}
});

test('M3 disposable delete only dispatches after exact full-inventory/managed backup verification',async()=>{
 const {stageM3DisposableDecommission}=await import('../lib/m3-collections.js');
 const backup={backupId:randomUUID(),backend:'qdrant',owner:'alice',logicalKey:collection.key,
  physicalName:collection.physicalName,scope,embedding,
  managed:{records:{[rowId]:{state:'ACTIVE',recordId:rowId,contentHash:contentFingerprint(text),revision:1}}},
  inventory:{rows:[structuredClone(point)],count:1,complete:true,exclusiveOwner:true,digest:H([point])}};
 let deleted=false,dispatch=0,held=[];const transport={m3DisposableFixture:true,
  async _request(method,url){if(method==='GET'){
   if(deleted)throw Object.assign(Error('not found'),{httpStatus:404});
   return {result:{config:{params:{vectors:{size:3,distance:'Cosine'}}},payload_schema:Object.fromEntries(
    ['userScopeId','collectionId','type','sourceId','branchId','recordId','physicalId'].map(k=>[k,{data_type:'keyword'}]))}};
  }
  if(method==='POST')return {result:{points:[structuredClone(point)],next_page_offset:null}};
  if(method==='DELETE'){dispatch++;deleted=true;return {result:true};}
  throw Error('unexpected');}};
 const boundary={withWriteBoundary:async(p,fn)=>{held.push(p.physicalCollectionName);return fn();}};
 const args={confirmation:'DELETE VERIFIED DISPOSABLE COLLECTION',boundary};
 await assert.rejects(()=>stageM3DisposableDecommission({...transport,m3DisposableFixture:false},backup,args),{code:'M3_DECOMMISSION_DISPOSABLE_ONLY'});
 await assert.rejects(()=>stageM3DisposableDecommission(transport,{...backup,inventory:{...backup.inventory,digest:'bad'}},args),{code:'M3_DECOMMISSION_EVIDENCE_INVALID'});
 await assert.rejects(()=>stageM3DisposableDecommission(transport,{...backup,managed:{records:{}}},args),{code:'M3_UNMANAGED_RECORDS_PRESENT'});
 assert.equal(dispatch,0);
 const out=await stageM3DisposableDecommission(transport,backup,args);
 assert.equal(out.state,'VERIFIED_DISPOSABLE_DELETED');assert.equal(out.registryTombstoned,false);
 assert.equal(dispatch,1);assert.deepEqual(held,[collection.physicalName,collection.physicalName]);
});
test('M3 disposable delete uncertainty remains UNCERTAIN, not a proven deletion',async()=>{
 const {stageM3DisposableDecommission}=await import('../lib/m3-collections.js');
 const backup={backupId:randomUUID(),backend:'qdrant',owner:'alice',logicalKey:collection.key,
  physicalName:collection.physicalName,scope,embedding,
  managed:{records:{[rowId]:{state:'ACTIVE',recordId:rowId,contentHash:contentFingerprint(text),revision:1}}},
  inventory:{rows:[structuredClone(point)],count:1,complete:true,exclusiveOwner:true,digest:H([point])}};
 const transport={m3DisposableFixture:true,async _request(method){
  if(method==='GET')return {result:{config:{params:{vectors:{size:3,distance:'Cosine'}}},payload_schema:Object.fromEntries(
   ['userScopeId','collectionId','type','sourceId','branchId','recordId','physicalId'].map(k=>[k,{data_type:'keyword'}]))}};
  if(method==='POST')return {result:{points:[structuredClone(point)],next_page_offset:null}};
  if(method==='DELETE')throw Error('network timeout');}};
 const boundary={withWriteBoundary:async(_p,fn)=>fn()};
 const out=await stageM3DisposableDecommission(transport,backup,{boundary,confirmation:'DELETE VERIFIED DISPOSABLE COLLECTION'});
 assert.equal(out.state,'UNCERTAIN');assert.equal(out.requiresAdjudication,true);
});

test('M3 generation-aware backup reads verified live alias and pins physical generation',async()=>{
 const {markM3ResolvedBinding}=await import('../lib/m3-versioned-binding.js');
 const f=await fixture();try{
  const target='vh2_'+'f'.repeat(48);
  const alias=markM3ResolvedBinding(binding,{logicalKey:collection.key,
   canonicalName:collection.physicalName,physicalName:target,generation:2});
  let checks=0;
  f.deps.transport=async()=>({_request:async()=>{throw Error('fixture transport may not dispatch');}});
  f.deps.resolveLiveBinding=async(_ctx,canonical)=>{
   assert.equal(canonical.collection.physicalName,collection.physicalName);
   checks++;return alias;
  };
  f.req.body={...base};
  const preview=await previewM3Collection(f.req,f.deps);
  assert.equal(preview.routingGeneration,2);
  assert.equal(preview.cutoverState,'VERIFIED_PUBLISHED_GENERATION');
  f.req.body={...base,confirmation:'CAPTURE OWNED LOGICAL BACKUP'};
  const result=await captureM3Backup(f.req,f.deps);
  assert.equal(result.state,'VERIFIED');assert.equal(result.routingGeneration,2);
  const doc=await new M3Store(f.req.s03).read('backup',result.backupId);
  assert.equal(doc.physicalName,target);
  assert.equal(doc.canonicalPhysicalName,collection.physicalName);
  assert.equal(doc.routingGeneration,2);
  assert.equal(checks,3,'preview, pre-lock, and locked generation check');
  f.req.body={...base,action:'delete',backupId:result.backupId};
  const planned=await planM3Collection(f.req,f.deps);
  assert.equal(planned.executionAllowed,true,'verified generation can be planned; executor still rechecks real journal');
  assert.equal((await new M3Store(f.req.s03).read('operation',planned.operationId)).routingGeneration,2);
 }finally{await f.cleanup();}
});

test('M3 backup refuses cutover generation switch before the physical inventory capture',async()=>{
 const {markM3ResolvedBinding}=await import('../lib/m3-versioned-binding.js');
 const f=await fixture();try{
  f.deps.transport=async()=>({_request:async()=>{throw Error('no backend I/O permitted');}});
  let reads=0;
  f.deps.resolveLiveBinding=async()=>{
   const generation=++reads;
   return markM3ResolvedBinding(binding,{logicalKey:collection.key,
    canonicalName:collection.physicalName,physicalName:'vh2_'+'f'.repeat(48),generation});
  };
  f.req.body={...base,confirmation:'CAPTURE OWNED LOGICAL BACKUP'};
  await assert.rejects(()=>captureM3Backup(f.req,f.deps),{code:'M3_BACKUP_GENERATION_CHANGED'});
  assert.equal(reads,2);
  assert.deepEqual(f.calls,['locked']);
  assert.deepEqual(await fs.readdir(path.join(f.dir,'.similharity','m3-lifecycle')).catch(()=>[]),[]);
 }finally{await f.cleanup();}
});

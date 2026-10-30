import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {collectionIdentity,recordIdentity,contentFingerprint} from '../lib/s02-identity.js';
import {CollectionRegistry} from '../lib/s02-registry.js';
import {ManagedChatRegistry} from '../lib/f09b4-managed-registry.js';
import {captureM4aLanceBackup,previewM4aLance} from '../lib/m4a-lancedb-lifecycle.js';
import {planM4aLanceTransition,executeM4aLanceTransition,
 validateM4aTransitionPlan,validateM4aTransitionExecute} from '../lib/m4a-lancedb-transactions.js';
import {resolveM4aLanceReadBinding} from '../lib/m4a-lancedb-cutover.js';
import {M3CutoverJournal} from '../lib/m3-cutover-journal.js';
import {inspectM3LifecycleRecovery} from '../lib/m3-execution-audit.js';
const sha=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const scope={userScopeId:'alice',collectionId:'chat',type:'chat',sourceId:'saved-chat',branchId:'branch'};
const embedding={source:'transformers',model:'fixture',dimension:3,metric:'dot'};
const identity=collectionIdentity({backend:'lancedb',scope,embedding});
const binding={authorized:true,provenance:'SERVER_VERIFIED',backend:'lancedb',scope,embedding,
 collection:{key:identity.key,physicalName:identity.physicalName}};
const source={kind:'chat',avatar:'character.png',chatFile:'saved.jsonl'};
function row(recordId=randomUUID()){
 const text='saved line',vector=[.25,.5,.75],metadata={vecthareRecordV2:{schemaVersion:2,
  recordId,identity:{userScopeId:'alice',sourceId:'saved-chat'},contentHash:contentFingerprint(text),revision:1}};
 return {physicalId:recordIdentity(scope,recordId).physicalId,recordId,...scope,schemaVersion:2,
  revision:1,text,textHash:contentFingerprint(text),metadata:JSON.stringify(metadata),metadataHash:sha(metadata),
  embedding:JSON.stringify(embedding),vector,vectorHash:sha(vector)};
}
const columns=['physicalId','recordId','userScopeId','collectionId','type','sourceId','branchId','text',
 'textHash','metadata','metadataHash','embedding','vectorHash'];
const schema={fields:[...columns.map(name=>({name,nullable:false})),
 {name:'schemaVersion'},{name:'revision'},{name:'vector',type:{listSize:3}}]};
async function fixture({populated=false}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'m4a4-'));await fs.chmod(root,0o700);
 const ctx={userScopeId:'alice',vectorsPath:root};
 const collections=new Map([[identity.physicalName,populated?[row()]:[]]]);
 let dropTarget=false,sourceHash='unchanged';
 function table(name){
  if(!collections.has(name))throw Error('UNKNOWN_TABLE');
  const rows=collections.get(name);
  return {schema,async countRows(){return rows.length;},
   async add(entries){rows.push(...structuredClone(entries));if(dropTarget)throw Error('LOST_TARGET_ACK');},
   query(){let offset=0,limit=Infinity,sort=false;
    const q={orderBy(){sort=true;return q;},offset(n){offset=n;return q;},
     limit(n){limit=n;return q;},async toArray(){const found=structuredClone(rows);
      if(sort)found.sort((a,b)=>a.physicalId.localeCompare(b.physicalId));return found.slice(offset,offset+limit);}};
    return q;}};
 }
 const db={async tableNames(){return [...collections.keys()].sort();},async openTable(name){return table(name);},
  async createEmptyTable(name,ignored,opts){
   assert.deepEqual(opts,{mode:'create',existOk:false});if(collections.has(name))throw Error('TABLE_EXISTS');
   collections.set(name,[]);return table(name);}};
 const reg=new ManagedChatRegistry(ctx,binding);
 await reg.setup();
 if(populated){const original=collections.get(identity.physicalName)[0];const doc=reg.empty();
  doc.records[original.recordId]={recordId:original.recordId,state:'ACTIVE',operationId:null,
   revision:1,contentHash:original.textHash};await reg.save(doc);}
 const s02=new CollectionRegistry(path.join(root,'.similharity'));
 await s02.reserve({backend:'lancedb',scope,embedding});
 const req={s03:ctx,user:{directories:{}},body:{backend:'lancedb',source}};
 const deps={getProfile:async()=>({configured:true,profile:embedding,selected:false}),
  bind:async()=>({binding}),readSnapshot:async()=>({sourceId:scope.sourceId,fileHash:sourceHash}),
  receipt:async()=>({state:'SCHEMA_VERIFIED_OFFLINE_UNCERTIFIED'}),
  connection:async()=>({getDatabase:async()=>db}),
  registry:()=>reg,jobs:()=>({assertNoLease:async()=>{}}),
  resolveLanceBinding:(ctx,canonical,{db})=>resolveM4aLanceReadBinding(ctx,canonical,{db,registry:reg}),
  stageOptions:{createEmpty:async(db,binding)=>db.createEmptyTable(binding.collection.physicalName,schema,
    {mode:'create',existOk:false})}};
 async function backup(){req.body={backend:'lancedb',source,confirmation:'CAPTURE OWNED LOGICAL BACKUP'};
  return captureM4aLanceBackup(req,deps);}
 async function plan(action,backupId){req.body={backend:'lancedb',source,action,backupId};
  return planM4aLanceTransition(req,deps);}
 async function execute(action,operationId){req.body={operationId,
  confirmation:action==='empty'?'EMPTY OWNED LANCEDB COLLECTION':'RESTORE OWNED LANCEDB COLLECTION'};
  return executeM4aLanceTransition(req,deps);}
 return {root,ctx,db,reg,req,deps,collections,backup,plan,execute,
  setSource:x=>{sourceHash=x},failAfterWrite:()=>{dropTarget=true},
  cleanup:()=>fs.rm(root,{recursive:true,force:true})};
}
test('M4a4 transition inputs reject owners, paths, vectors, non-UUIDs and invalid confirmations',()=>{
 assert.throws(()=>validateM4aTransitionPlan({backend:'lancedb',source,backupId:randomUUID(),action:'purge-all'}));
 assert.throws(()=>validateM4aTransitionPlan({backend:'lancedb',source,backupId:randomUUID(),action:'empty',path:'/tmp'}));
 assert.throws(()=>validateM4aTransitionExecute({operationId:randomUUID(),confirmation:'DELETE'}));
});
test('M4a4 empty creates a fresh zero-record generation and retains original records, backed by a one-use receipt',async()=>{
 const f=await fixture({populated:true});try{
  const backup=await f.backup();assert.equal(backup.count,1);
  const plan=await f.plan('empty',backup.backupId);
  const result=await f.execute('empty',plan.operationId);
  assert.equal(result.state,'VERIFIED');assert.equal(result.verifiedEmpty,true);
  assert.equal(result.oldPhysicalRetained,true);assert.equal(f.collections.get(identity.physicalName).length,1);
  assert.equal(f.collections.get(result.physicalName).length,0);
  const journal=new M3CutoverJournal(f.ctx,{backend:'lancedb',logicalKey:identity.key});
  const active=await journal.resolve(binding);assert.equal(active.generation,1);
  const routed=await resolveM4aLanceReadBinding(f.ctx,binding,{db:f.db,registry:f.reg});
  assert.equal(routed.collection.physicalName,result.physicalName);
  const managed=await f.reg.read();assert.equal(Object.values(managed.records)[0].state,'DELETED');
  const review=await inspectM3LifecycleRecovery(f.ctx,plan.operationId);
  assert.equal(review.lastStage,'COMMITTED');
  await assert.rejects(()=>f.execute('empty',plan.operationId));
 }finally{await f.cleanup();}
});
test('M4a4 restore stages copied vectors into a fresh table; original is never overwritten',async()=>{
 const f=await fixture({populated:true});try{
  const backup=await f.backup(),plan=await f.plan('restore',backup.backupId);
  const result=await f.execute('restore',plan.operationId);
  assert.equal(result.state,'VERIFIED');assert.equal(result.restoredCount,1);
  assert.equal(f.collections.get(identity.physicalName).length,1);
  assert.equal(f.collections.get(result.physicalName).length,1);
  const alias=await resolveM4aLanceReadBinding(f.ctx,binding,{db:f.db,registry:f.reg});
  assert.equal(alias.collection.generation,1);
  const p=await previewM4aLance({...f.req,body:{backend:'lancedb',source}},f.deps);
  assert.equal(p.recordCount,1);
 }finally{await f.cleanup();}
});
test('M4a4 source changes before planning prevent transition',async()=>{
 const f=await fixture();try{
  const backup=await f.backup();f.setSource('a different hash');
  await assert.rejects(()=>f.plan('empty',backup.backupId),{code:'M4A_TRANSITION_BACKUP_OR_SOURCE_CHANGED'});
  const journal=new M3CutoverJournal(f.ctx,{backend:'lancedb',logicalKey:identity.key});
  assert.equal((await journal.resolve(binding)).generation,0);
 }finally{await f.cleanup();}
});
test('M4a4 lost ack after target write is uncertain, retains logical lock and will not replay',async()=>{
 const f=await fixture({populated:true});try{
  const backup=await f.backup(),plan=await f.plan('restore',backup.backupId);
  f.failAfterWrite();
  await assert.rejects(()=>f.execute('restore',plan.operationId),/LOST_TARGET_ACK/);
  const review=await inspectM3LifecycleRecovery(f.ctx,plan.operationId);
  assert.equal(review.claimed,true);assert.equal(review.lastStage,'DISPATCH_PENDING');
  await assert.rejects(()=>f.execute('restore',plan.operationId),{code:'M3_LOGICAL_COLLECTION_BUSY'});
  const j=new M3CutoverJournal(f.ctx,{backend:'lancedb',logicalKey:identity.key});
  assert.equal((await j.resolve(binding)).generation,0);
 }finally{await f.cleanup();}
});
test('M4a4 original pre-empty backup can safely restore only immediately after matching scoped empty',async()=>{
 const f=await fixture({populated:true});try{
  const first=await f.backup(),emptyPlan=await f.plan('empty',first.backupId);
  const emptied=await f.execute('empty',emptyPlan.operationId);
  assert.equal(emptied.generation,1);
  const restorationPlan=await f.plan('restore',first.backupId);
  const restored=await f.execute('restore',restorationPlan.operationId);
  assert.equal(restored.state,'VERIFIED');assert.equal(restored.generation,2);
  assert.equal(restored.restoredCount,1);
  assert.equal(f.collections.get(identity.physicalName).length,1);
  assert.equal(f.collections.get(emptied.physicalName).length,0);
  assert.equal(f.collections.get(restored.physicalName).length,1);
  assert.equal(Object.values((await f.reg.read()).records)[0].state,'ACTIVE');
  const alias=await resolveM4aLanceReadBinding(f.ctx,binding,{db:f.db,registry:f.reg});
  assert.equal(alias.collection.generation,2);
 }finally{await f.cleanup();}
});
test('M4a4 post-cutover M1 saved-record preview resolves through published generation',async()=>{
 const f=await fixture({populated:true});try{
  const b=await f.backup(),plan=await f.plan('restore',b.backupId);
  const result=await f.execute('restore',plan.operationId);
  const {previewM1Records}=await import('../lib/m1-saved-records.js');
  const deps={...f.deps,getReceipt:f.deps.receipt,
   backendPool:{getTrusted:async()=>({getDatabase:async()=>f.db})},
   readSnapshot:async()=>({sourceId:scope.sourceId,fileHash:'unchanged',sourceKind:'chat',
    messages:[{recordId:randomUUID(),text:'new source',contentHash:contentFingerprint('new source')}]})};
  const preview=await previewM1Records({...f.req,body:{backend:'lancedb',source}},deps);
  assert.equal(preview.logicalKey,identity.key);
  assert.equal(preview.backend,'lancedb');
  const active=new M3CutoverJournal(f.ctx,{backend:'lancedb',logicalKey:identity.key});
  assert.equal((await active.resolve(binding)).physicalName,result.physicalName);
 }finally{await f.cleanup();}
});
test('M4a4 published target refuses unregistered physical additions; no canonical fallback',async()=>{
 const f=await fixture({populated:true});try{
  const b=await f.backup(),plan=await f.plan('restore',b.backupId);
  const result=await f.execute('restore',plan.operationId);
  f.collections.get(result.physicalName).push(row(randomUUID()));
  await assert.rejects(()=>resolveM4aLanceReadBinding(f.ctx,binding,{db:f.db,registry:f.reg}),
   e=>['M3_UNMANAGED_RECORDS_PRESENT','M4A_TARGET_INVENTORY_UNVERIFIED'].includes(e?.code));
 }finally{await f.cleanup();}
});
test('M4a4 claimed transition failing after target restore but before publish retains quarantine',async()=>{
 const f=await fixture({populated:true});try{
  const b=await f.backup(),plan=await f.plan('restore',b.backupId);
  f.deps.checkStage=async()=>{throw Error('FAIL_AFTER_PREPARE');};
  await assert.rejects(()=>f.execute('restore',plan.operationId),/FAIL_AFTER_PREPARE/);
  const ev=await inspectM3LifecycleRecovery(f.ctx,plan.operationId);
  assert.equal(ev.claimed,true);assert.equal(ev.lastStage,'PHYSICAL_VERIFIED');
  await assert.rejects(()=>f.execute('restore',plan.operationId),{code:'M3_LOGICAL_COLLECTION_BUSY'});
  const j=new M3CutoverJournal(f.ctx,{backend:'lancedb',logicalKey:identity.key});
  await assert.rejects(()=>j.resolve(binding),{code:'M3_JOURNAL_TRANSITION_REVIEW_REQUIRED'});
 }finally{await f.cleanup();}
});

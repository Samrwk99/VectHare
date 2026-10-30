import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {collectionIdentity,recordIdentity,contentFingerprint} from '../lib/s02-identity.js';
import {m4cMilvusLifecycleAdapter} from '../lib/m4c-milvus-contract.js';
import {validateM4cMilvusSelector,previewM4cMilvus,captureM4cMilvusBackup,
 verifyM4cMilvusBackup,planM4cMilvusDelete,executeM4cMilvusDelete} from '../lib/m4c-milvus-lifecycle.js';
import {planM4cMilvusTransition,executeM4cMilvusTransition} from '../lib/m4c-milvus-transactions.js';
import {resolveM4cMilvusReadBinding} from '../lib/m4c-milvus-cutover.js';
const H=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const scope={userScopeId:'alice',collectionId:'chat',type:'chat',sourceId:'saved-chat',branchId:'branch'};
const embedding={source:'transformers',model:'fixture',dimension:3,metric:'dot'};
const identity=collectionIdentity({backend:'milvus',scope,embedding});
const binding={authorized:true,provenance:'SERVER_VERIFIED',backend:'milvus',scope,embedding,
 collection:{key:identity.key,physicalName:identity.physicalName}};
const source={kind:'chat',avatar:'character.png',chatFile:'saved.jsonl'};
const schema=[['physicalId',21,36,true],['recordId',21,36],['userScopeId',21,1024],['collectionId',21,1024],
 ['type',21,128],['sourceId',21,1024],['branchId',21,1024],['schemaVersion',5],['revision',5],
 ['text',21,65535],['textHash',21,64],['metadata',23],['metadataHash',21,64],['embedding',23],
 ['vectorHash',21,64],['vector',101,3]].map(([name,data_type,size,primary])=>({name,data_type,
 ...(data_type===21?{max_length:size}:{}),...(data_type===101?{dim:size}:{}),
 ...(primary?{is_primary_key:true,autoID:false}:{})}));
const makeRow=(recordId=randomUUID(),overrides={})=>{
 const text='saved line',vector=[.25,.5,.75],metadata={vecthareRecordV2:{schemaVersion:2,recordId,
 identity:{userScopeId:'alice',sourceId:'saved-chat'},contentHash:contentFingerprint(text),revision:1}};
 return {physicalId:recordIdentity(scope,recordId).physicalId,recordId,...scope,revision:1,
  text,textHash:contentFingerprint(text),metadata,metadataHash:H(metadata),embedding,vector,
  vectorHash:H(vector),schemaVersion:2,...overrides};
};
async function setup(){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'m4c2-milvus-'));await fs.chmod(root,0o700);
 const records=new Map(),collections=new Map([[identity.physicalName,records]]);let lostAck=false,corruptIterator=false,foreign=false;
 const filter=(row,expr)=>expr.split(' && ').every(x=>{const m=x.match(/^([a-zA-Z]+) == (.+)$/);return row[m[1]]===JSON.parse(m[2]);});
 const client={
  async describeCollection(){return {status:{error_code:0},schema:{fields:schema,autoID:false}};},
  async describeIndex(){return {status:{error_code:0},index_descriptions:[{field_name:'vector',params:[{key:'metric_type',value:'IP'}]}]};},
  async query(args){return {status:{error_code:0},data:[...(collections.get(args.collection_name)??new Map()).values()].filter(r=>filter(r,args.filter)).slice(0,args.limit??100)};},
  async search(){return {status:{error_code:0},results:[]};},
  async insert(args){const target=collections.get(args.collection_name);if(!target)throw Error('collection absent');
   for(const row of args.data)target.set(row.physicalId,structuredClone(row));return {status:{error_code:0},insert_cnt:args.data.length};},
  async upsert(){return {status:{error_code:0},upsert_cnt:1};},
  async deleteEntities(){return {status:{error_code:0},delete_cnt:1};},
  async count(args){assert.equal(args.filter,'');assert.equal(args.consistency_level,'Strong');
   return {status:{error_code:0},data:(collections.get(args.collection_name)??new Map()).size};},
  async queryIterator(args){assert.equal(args.filter,'');assert.equal(args.consistency_level,'Strong');
   assert.equal(args.limit,undefined);const items=[...(collections.get(args.collection_name)??new Map()).values()].map(x=>structuredClone(x));
   return (async function*(){if(foreign)throw Error('transport failure');
    yield corruptIterator?items.slice(0,Math.max(0,items.length-1)):items;})();},
  async hasCollection(args){return {status:{error_code:0},value:collections.has(args.collection_name)};},
  async listCollections(){return {status:{error_code:0},data:[...collections.keys()].map(name=>({name}))};},
  async createCollection(args){if(collections.has(args.collection_name))throw Error('already exists');
   collections.set(args.collection_name,new Map());return {status:{error_code:0}};},
  async createIndex(){return {status:{error_code:0}};},
  async loadCollection(){return {status:{error_code:0}};},
  async dropCollection(args){collections.delete(args.collection_name);records.clear();if(lostAck)throw Error('lost drop ACK');
   return {status:{error_code:0}};},
 };
 const ctx={userScopeId:'alice',vectorsPath:root};const req={s03:ctx,user:{directories:{}},body:{backend:'milvus',source}};
 let saved={};let savedManaged=null;let fileHash='initial';
 const s02={async lookup(){return {key:identity.key,physicalName:identity.physicalName,status:'RESERVED_NOT_ACTIVE'}},
  async tombstone(){return {status:'DELETED'}}};
 const deps={getProfile:async()=>({configured:true,selected:false,profile:embedding}),bind:async()=>({binding}),
  readSnapshot:async()=>({sourceId:scope.sourceId,fileHash}),receipt:async()=>({state:'SCHEMA_VERIFIED_OFFLINE_UNCERTIFIED'}),
  registry:()=>({read:async()=>savedManaged??({records:saved,fingerprint:H(saved)}),
   lock:async work=>work(),save:async doc=>{savedManaged={...doc,fingerprint:H(doc)};}}),jobs:()=>({assertNoLease:async()=>{}}),
  connection:async()=>({client}),boundary:()=>({withWriteBoundary:async(_plan,work)=>work()}),
  s02:()=>s02,ledgerCheckpoint:async()=>({count:0,digest:H([])})};
 return {root,records,collections,client,ctx,req,deps,binding,add(row){records.set(row.physicalId,structuredClone(row));
  saved[row.recordId]={state:'ACTIVE',revision:row.revision,contentHash:row.textHash};},
  setLostAck:v=>lostAck=v,setCorruptIterator:v=>corruptIterator=v,
  setForeign:v=>foreign=v,setHash:v=>fileHash=v,clean:()=>fs.rm(root,{recursive:true,force:true})};
}
test('M4c2 Milvus lifecycle selector rejects physical names, secrets, supplied vectors',()=>{
 for(const s of [{backend:'milvus',source,collection:'other'},
  {backend:'milvus',source,token:'secret'},
  {backend:'milvus',source:{...source,owner:'bob'}},
  {backend:'milvus',source,vector:[1,2,3]}])assert.throws(()=>validateM4cMilvusSelector(s));
 assert.throws(()=>validateM4cMilvusSelector({backend:'milvus',source},{backup:true}),
  {code:'M4C_BACKUP_CONFIRMATION_REQUIRED'});
});
test('M4c2 Milvus exact unfiltered strong iterator inventory and backup',async()=>{
 const f=await setup();try{
  f.add(makeRow());const seen=await previewM4cMilvus(f.req,f.deps);assert.equal(seen.recordCount,1);
  f.req.body.confirmation='CAPTURE OWNED LOGICAL BACKUP';
  const backup=await captureM4cMilvusBackup(f.req,f.deps);assert.equal(backup.count,1);
  const checked=await verifyM4cMilvusBackup(f.req,backup.backupId,f.deps);
  assert.equal(checked.integrityVerified,true);
 }finally{await f.clean();}
});
test('M4c2 Milvus refuses foreign, duplicate, truncated, and failed full scans',async()=>{
 const f=await setup();try{
  const row=makeRow();f.add(row);
  const a=m4cMilvusLifecycleAdapter({backend:{client:f.client},binding,writerBoundary:fn=>fn()});
  assert.equal((await a.getInventory()).count,1);
  f.add(makeRow(randomUUID(),{userScopeId:'other'}));
  await assert.rejects(()=>a.getInventory(),{code:'S05_OWNER_MISMATCH'});
  f.records.clear();f.add(row);
  f.setCorruptIterator(true);await assert.rejects(()=>a.getInventory(),{code:'M4C_INVENTORY_INCOMPLETE'});
  f.setCorruptIterator(false);f.setForeign(true);await assert.rejects(()=>a.getInventory(),/transport failure/);
 }finally{await f.clean();}
});
test('M4c2 Milvus one-use confirmed delete verifies backup and tombstone',async()=>{
 const f=await setup();try{
  f.add(makeRow());f.req.body.confirmation='CAPTURE OWNED LOGICAL BACKUP';
  const backed=await captureM4cMilvusBackup(f.req,f.deps);
  f.req.body={backend:'milvus',source,backupId:backed.backupId};
  const planned=await planM4cMilvusDelete(f.req,f.deps);
  assert.equal(planned.requiredConfirmation,'DELETE OWNED MILVUS COLLECTION');
  f.req.body={operationId:planned.operationId,confirmation:planned.requiredConfirmation};
  const done=await executeM4cMilvusDelete(f.req,f.deps);
  assert.equal(done.registryTombstoned,true);assert.equal(f.records.size,0);
  await assert.rejects(()=>executeM4cMilvusDelete(f.req,f.deps));
 }finally{await f.clean();}
});
test('M4c2 Milvus stale backup cannot authorise deletion',async()=>{
 const f=await setup();try{
  f.add(makeRow());f.req.body.confirmation='CAPTURE OWNED LOGICAL BACKUP';
  const backed=await captureM4cMilvusBackup(f.req,f.deps);
  f.add(makeRow());f.req.body={backend:'milvus',source,backupId:backed.backupId};
  await assert.rejects(()=>planM4cMilvusDelete(f.req,f.deps));
  assert.equal(f.records.size,2);
 }finally{await f.clean();}
});
test('M4c2 Milvus lost drop acknowledgement does not replay one-use claim',async()=>{
 const f=await setup();try{
  f.add(makeRow());f.req.body.confirmation='CAPTURE OWNED LOGICAL BACKUP';
  const backed=await captureM4cMilvusBackup(f.req,f.deps);
  f.req.body={backend:'milvus',source,backupId:backed.backupId};const plan=await planM4cMilvusDelete(f.req,f.deps);
  f.setLostAck(true);f.req.body={operationId:plan.operationId,confirmation:plan.requiredConfirmation};
  await assert.rejects(()=>executeM4cMilvusDelete(f.req,f.deps),/lost drop ACK/);
  await assert.rejects(()=>executeM4cMilvusDelete(f.req,f.deps));
 }finally{await f.clean();}
});

test('M4c2 Milvus scoped empty retains original and publishes verified new generation',async()=>{
 const f=await setup();try{
  f.add(makeRow());f.req.body.confirmation='CAPTURE OWNED LOGICAL BACKUP';
  const backup=await captureM4cMilvusBackup(f.req,f.deps);
  f.req.body={backend:'milvus',source,backupId:backup.backupId,action:'empty'};
  const plan=await planM4cMilvusTransition(f.req,f.deps);
  assert.equal(plan.requiredConfirmation,'EMPTY OWNED MILVUS COLLECTION');
  f.req.body={operationId:plan.operationId,confirmation:plan.requiredConfirmation};
  const result=await executeM4cMilvusTransition(f.req,f.deps);
  assert.equal(result.verifiedEmpty,true);assert.equal(result.generation,1);
  assert.equal(f.records.size,1);assert.notEqual(result.physicalName,identity.physicalName);
  const routed=await resolveM4cMilvusReadBinding(f.ctx,binding,{backend:{client:f.client},registry:f.deps.registry()});
  assert.equal(routed.collection.physicalName,result.physicalName);
  assert.equal(routed.collection.generation,1);
 }finally{await f.clean();}
});
test('M4c2 Milvus populated collection -> empty -> immediate restore retains historical generations',async()=>{
 const f=await setup();try{
  f.add(makeRow());f.req.body.confirmation='CAPTURE OWNED LOGICAL BACKUP';
  const backup=await captureM4cMilvusBackup(f.req,f.deps);
  f.req.body={backend:'milvus',source,backupId:backup.backupId,action:'empty'};
  const plan=await planM4cMilvusTransition(f.req,f.deps);
  f.req.body={operationId:plan.operationId,confirmation:plan.requiredConfirmation};
  const emptied=await executeM4cMilvusTransition(f.req,f.deps);
  assert.equal(emptied.state,'VERIFIED');
  f.req.body={backend:'milvus',source,backupId:backup.backupId,action:'restore'};
  const restorePlan=await planM4cMilvusTransition(f.req,f.deps);
  f.req.body={operationId:restorePlan.operationId,confirmation:restorePlan.requiredConfirmation};
  const restored=await executeM4cMilvusTransition(f.req,f.deps);
  assert.equal(restored.restoredCount,1);assert.equal(restored.generation,2);
  assert.equal(f.records.size,1);assert.equal(f.collections.size,3);
  const routed=await resolveM4cMilvusReadBinding(f.ctx,binding,{backend:{client:f.client},registry:f.deps.registry()});
  assert.equal(routed.collection.physicalName,restored.physicalName);
 }finally{await f.clean();}
});

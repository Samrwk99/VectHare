import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {collectionIdentity,contentFingerprint} from '../lib/s02-identity.js';
import {savedRecordIdentity,previewM1Records,planM1Record,executeM1Record,validateM1Intent} from '../lib/m1-saved-records.js';
import {ManagedChatRegistry} from '../lib/f09b4-managed-registry.js';
import {milvusV2Adapter} from '../lib/s07-milvus.js';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const profile={source:'transformers',model:'fixture',dimension:3,metric:'dot'};
const source={kind:'chat',avatar:'alice.png',chatFile:'saved-chat'};
const scope={userScopeId:'alice',collectionId:'saved-chat',type:'chat',sourceId:'saved-chat'};
const id=collectionIdentity({backend:'milvus',scope,embedding:profile});
const binding={authorized:true,provenance:'SERVER_VERIFIED',backend:'milvus',scope,embedding:profile,collection:{key:id.key,physicalName:id.physicalName}};
const msg={recordId:'eabb4525-29cc-8bbc-af01-22decd92ae77',text:'saved hello',contentHash:contentFingerprint('saved hello')};
const schema=[['physicalId',21,36,true],['recordId',21,36],['userScopeId',21,1024],['collectionId',21,1024],
 ['type',21,128],['sourceId',21,1024],['branchId',21,1024],['schemaVersion',5],['revision',5],
 ['text',21,65535],['textHash',21,64],['metadata',23],['metadataHash',21,64],['embedding',23],
 ['vectorHash',21,64],['vector',101,3]].map(([name,data_type,size,primary])=>({name,data_type,
 ...(data_type===21?{max_length:size}:{}),...(data_type===101?{dim:size}:{}),
 ...(primary?{is_primary_key:true,autoID:false}:{})}));
function fakeMilvus(){
 const records=new Map();let lostAck=false,foreign=false;const calls=[];
 const filter=(row,expr)=>expr.split(' && ').every(x=>{const m=x.match(/^([a-zA-Z]+) == (.+)$/);
  assert.ok(m,`Invalid filter ${x}`);return row[m[1]]===JSON.parse(m[2]);});
 const client={
  async describeCollection(){return {status:{error_code:0},schema:{fields:schema,autoID:false}};},
  async describeIndex(){return {status:{error_code:0},index_descriptions:[{field_name:'vector',params:[{key:'metric_type',value:'IP'}]}]};},
  async query(args){calls.push(['query',args]);if(foreign)throw Error('remote read outage');
   return {status:{error_code:0},data:[...records.values()].filter(r=>filter(r,args.filter)).slice(args.offset??0,(args.offset??0)+(args.limit??100)).map(x=>structuredClone(x))};},
  async search(){return {status:{error_code:0},results:[]};},
  async insert(args){calls.push(['insert',args]);for(const r of args.data)records.set(r.physicalId,structuredClone(r));
   if(lostAck)throw Error('lost network ACK after insert');return {status:{error_code:0},insert_cnt:1};},
  async upsert(args){calls.push(['upsert',args]);for(const r of args.data)records.set(r.physicalId,structuredClone(r));
   if(lostAck)throw Error('lost network ACK after upsert');return {status:{error_code:0},upsert_cnt:1};},
  async deleteEntities(args){calls.push(['deleteEntities',args]);const keys=[...records].filter(([,r])=>filter(r,args.filter)).map(([k])=>k);
   keys.forEach(k=>records.delete(k));if(lostAck)throw Error('lost network ACK after delete');return {status:{error_code:0},delete_cnt:keys.length};},
 };
 return {client,records,calls,setLostAck:x=>lostAck=x,setForeign:x=>foreign=x};
}
async function fixture(){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'m4c-m1-'));await fs.chmod(dir,0o700);
 const req={s03:{userScopeId:'alice',vectorsPath:dir},user:{directories:{}},body:null};
 const snapshot={sourceId:scope.sourceId,sourceKind:'chat',fileHash:hash('file-1'),messages:[{...msg}]};
 const db=fakeMilvus();const deps={getProfile:async()=>({configured:true,profile}),
  bind:async()=>({binding}),readSnapshot:async()=>structuredClone(snapshot),
  getReceipt:async()=>({state:'SCHEMA_VERIFIED_OFFLINE_UNCERTIFIED'}),
  transport:async()=>db,backendPool:{getTrusted:async()=>db},embed:async()=>[0.2,0.4,0.6]};
 return {req,dir,snapshot,deps,db,recordId:savedRecordIdentity(req.s03,binding,msg).recordId,
  cleanup:()=>fs.rm(dir,{recursive:true,force:true})};
}
test('M4c saved-source Milvus M1/S04 insert update revectorize delete with readback and float32',async()=>{
 const f=await fixture();try{
  const {req,deps,recordId,db,snapshot}=f;
  assert.equal(validateM1Intent({backend:'milvus',source,action:'insert',recordId}).backend,'milvus');
  assert.throws(()=>validateM1Intent({backend:'milvus',source,action:'insert',recordId,configId:'local'}));
  assert.throws(()=>validateM1Intent({backend:'milvus',source,action:'insert',recordId,vector:[1,2,3]}));
  req.body={backend:'milvus',source};assert.equal((await previewM1Records(req,deps)).backend,'milvus');
  async function action(type){req.body={backend:'milvus',source,recordId,action:type};
   const planned=await planM1Record(req,id.key,deps);
   req.body={operationId:planned.operationId,confirmation:'APPLY SAVED RECORD MUTATION'};
   const result=await executeM1Record(req,deps);
   assert.equal(result.state,'VERIFIED',JSON.stringify(result));return result;}
  await action('insert');assert.equal(db.records.size,1);
  assert.deepEqual([...db.records.values()][0].vector,[0.2,0.4,0.6].map(Math.fround));
  snapshot.messages[0].text='saved hello changed';snapshot.messages[0].contentHash=contentFingerprint('saved hello changed');snapshot.fileHash=hash('file-2');
  await action('update');assert.equal([...db.records.values()][0].revision,2);
  await action('revectorize');assert.equal([...db.records.values()][0].revision,3);
  await action('delete');assert.equal(db.records.size,0);
  assert.equal((await new ManagedChatRegistry(req.s03,binding).read()).records[recordId].state,'DELETED');
  assert.equal(db.calls.filter(([x])=>x==='insert').length,1);
  assert.equal(db.calls.filter(([x])=>x==='upsert').length,2);
  assert.equal(db.calls.filter(([x])=>x==='deleteEntities').length,1);
 }finally{await f.cleanup();}
});
test('M4c remote lost acknowledgement is quarantined and one-use ticket cannot replay',async()=>{
 const f=await fixture();try{
  const {req,deps,recordId,db}=f;db.setLostAck(true);
  req.body={backend:'milvus',source,recordId,action:'insert'};
  const planned=await planM1Record(req,id.key,deps);
  req.body={operationId:planned.operationId,confirmation:'APPLY SAVED RECORD MUTATION'};
  const result=await executeM1Record(req,deps);
  assert.equal(result.state,'UNCERTAIN');assert.equal(db.records.size,1);
  assert.equal((await new ManagedChatRegistry(req.s03,binding).read()).records[recordId].state,'WRITE_PENDING');
  await assert.rejects(()=>executeM1Record(req,deps),{code:'M1_TICKET_ALREADY_CONSUMED'});
 }finally{await f.cleanup();}
});
test('M4c source-attested read rejects connection and schema outages, no mutation dispatched',async()=>{
 const f=await fixture();try{
  const {req,deps,recordId,db}=f;
  req.body={backend:'milvus',source,recordId,action:'insert'};
  const plan=await planM1Record(req,id.key,deps);
  db.setForeign(true);
  req.body={operationId:plan.operationId,confirmation:'APPLY SAVED RECORD MUTATION'};
  await assert.rejects(()=>executeM1Record(req,deps),/remote read outage/);
  assert.equal(db.calls.filter(([x])=>['insert','upsert','deleteEntities'].includes(x)).length,0);
 }finally{await f.cleanup();}
});
test('M4c Milvus adapter remains blocked outside trusted source-bound gateway',async()=>{
 const f=await fixture();try{
  const adapter=milvusV2Adapter(f.db,binding);
  await assert.rejects(()=>adapter.insertRecord({},{}),{code:'S07_WRITE_NOT_ACTIVATED'});
  assert.equal(f.db.calls.length,0);
 }finally{await f.cleanup();}
});

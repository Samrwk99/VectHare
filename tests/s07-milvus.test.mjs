import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {planMutation} from '../lib/s04-contract.js';
import {collectionIdentity} from '../lib/s02-identity.js';
import {MutationEngine} from '../lib/s04-engine.js';
import {OperationLedger} from '../lib/s04-ledger.js';
import {walkInventory} from '../lib/s05-contract.js';
import {milvusV2Adapter,milvusV2OwnerExpression,inspectMilvusV2Collection,provisionDisposableMilvusV2Collection} from '../lib/s07-milvus.js';

const scope={userScopeId:'alice',collectionId:'my-chat',type:'chat',sourceId:'chat-17',branchId:'branch-1'};
const embedding={source:'transformers',model:'test-model',dimension:3,metric:'cosine'};
function bind(sc=scope){const c=collectionIdentity({backend:'milvus',scope:sc,embedding});return {backend:'milvus',authorized:true,provenance:'SERVER_VERIFIED',scope:sc,embedding,collection:{key:c.key,physicalName:c.physicalName}};}
const binding=bind();
const payload={text:'hello milvus',vector:[0.5,0.25,0.125],metadata:{tag:'test'}};
function plan(input,sc=scope){return planMutation({userScopeId:sc.userScopeId},{backend:'milvus',scope:sc,embedding,operationId:randomUUID(),...input});}
const insert=()=>plan({action:'insert',...payload});
const fields=dimension=>[
 ['physicalId',21,36,true],['recordId',21,36],
 ['userScopeId',21,1024],['collectionId',21,1024],['type',21,128],['sourceId',21,1024],['branchId',21,1024],
 ['schemaVersion',5],['revision',5],['text',21,65535],['textHash',21,64],['metadata',23],
 ['metadataHash',21,64],['embedding',23],['vectorHash',21,64],['vector',101,dimension]
].map(([name,data_type,length,primary])=>({name,data_type,...(data_type===21?{max_length:length}:{}),
 ...(data_type===101?{dim:length}:{}),...(primary?{is_primary_key:true,autoID:false}:{})}));
function parseExpr(expr){
 if(typeof expr!=='string')throw Error('expression missing');
 const filters=[];
 for(const token of expr.split(' && ')){
  const match=token.match(/^([a-zA-Z]+) == (.+)$/);
  if(!match)throw Error('invalid expression '+token);
  filters.push([match[1],JSON.parse(match[2])]);
 }
 return filters;
}
function mock({disposable=true,dimension=3,fieldsOverride=null,writeFailure=null,readFailure=null,ackMode='good',existing=true,indexMetric='COSINE'}={}){
 const map=new Map(),calls=[];
 let active=existing;
 let schemaFields=fieldsOverride??fields(dimension);
 const match=(row,expr)=>parseExpr(expr).every(([name,value])=>row[name]===value);
 const goodStatus={error_code:0};
 const write=(kind,data)=>{
  if(writeFailure===kind)throw new Error(`injected ${kind} outage`);
  if(ackMode==='uncertain')return {status:{error_code:0}};
  if(ackMode==='backend-error')return {status:{error_code:7,reason:'failed'},[`${kind}_cnt`]:'1'};
  return {status:goodStatus,[`${kind}_cnt`]:'1',err_index:[]};
 };
 const client={
  async describeCollection(args){calls.push({method:'describeCollection',args});
   if(!active)throw Object.assign(Error('not found'),{code:100});
   return {status:goodStatus,schema:{fields:schemaFields,autoID:false}};
  },
  async describeIndex(args){calls.push({method:'describeIndex',args});return {status:goodStatus,index_descriptions:[{field_name:'vector',params:[{key:'metric_type',value:indexMetric}]}]};},
  async listCollections(){calls.push({method:'listCollections'});return {status:goodStatus,data:active?[{name:binding.collection.physicalName}]:[]};},
  async createCollection(args){calls.push({method:'createCollection',args});
   if(active)throw Error('exists');active=true;
   schemaFields=args.fields.map(f=>({...f}));return {status:goodStatus};
  },
  async createIndex(args){calls.push({method:'createIndex',args});return {status:goodStatus};},
  async loadCollection(args){calls.push({method:'loadCollection',args});return {status:goodStatus};},
  async query(args){calls.push({method:'query',args});
   if(readFailure==='query')throw Error('injected query outage');
   let data=[...map.values()].filter(row=>match(row,args.filter));
   data=data.slice(args.offset??0,(args.offset??0)+(args.limit??100));
   return {status:readFailure==='error-status'?{error_code:3}:goodStatus,data:data.map(row=>structuredClone(row))};
  },
  async search(args){calls.push({method:'search',args});
   if(readFailure==='search')throw Error('injected search outage');
   return {status:readFailure==='error-status'?{error_code:3}:goodStatus,
    results:[...map.values()].filter(row=>match(row,args.filter)).slice(0,args.limit).map(row=>({...structuredClone(row),score:0.8}))};
  },
  async insert(args){calls.push({method:'insert',args});const response=write('insert',args.data);if(ackMode!=='uncertain'&&ackMode!=='backend-error'){
    for(const row of args.data)map.set(row.physicalId,structuredClone(row));}
   return response;
  },
  async upsert(args){calls.push({method:'upsert',args});const response=write('upsert',args.data);if(ackMode!=='uncertain'&&ackMode!=='backend-error'){
    for(const row of args.data)map.set(row.physicalId,structuredClone(row));}
   return response;
  },
  async deleteEntities(args){calls.push({method:'deleteEntities',args});const response=write('delete',args.filter);if(ackMode!=='uncertain'&&ackMode!=='backend-error'){
    for(const [id,row] of map)if(match(row,args.filter))map.delete(id);}
   return response;
  }
 };
 return {client,s07DisposableFixture:disposable,map,calls};
}

test('S07 schema inspection verifies full physical ownership fields, primary key and dimension without writes',async()=>{
 const bk=mock();const result=await inspectMilvusV2Collection(bk,binding);
 assert.equal(result.primaryKeyVerified,true);
 assert.deepEqual(bk.calls.map(x=>x.method),['describeCollection','describeIndex']);
 await assert.rejects(()=>inspectMilvusV2Collection(mock({dimension:4}),binding),{code:'S07_DIMENSION_MISMATCH'});
 await assert.rejects(()=>inspectMilvusV2Collection(mock({indexMetric:'L2'}),binding),{code:'S07_INDEX_METRIC_MISMATCH'});
 await assert.rejects(()=>inspectMilvusV2Collection(mock({fieldsOverride:fields(3).filter(f=>f.name!=='userScopeId')}),binding),{code:'S07_SCHEMA_MISMATCH'});
 await assert.rejects(()=>inspectMilvusV2Collection(mock({fieldsOverride:fields(3).map(f=>f.name==='physicalId'?{...f,autoID:true}:f)}),binding),{code:'S07_SCHEMA_MISMATCH'});
});
test('S07 physical filter includes user, collection, type, source, explicit branch, record, primary id, revision',()=>{
 const p=insert(),expr=milvusV2OwnerExpression(binding,{recordId:p.recordId,physicalId:p.physicalId,revision:3});
 const names=parseExpr(expr).map(([k])=>k);
 assert.deepEqual(names,['userScopeId','collectionId','type','sourceId','branchId','recordId','physicalId','revision']);
 assert.ok(expr.includes('branchId == "branch-1"'));
 const sc={...scope};delete sc.branchId;
 assert.ok(milvusV2OwnerExpression(bind(sc)).includes('branchId == ""'));
 assert.throws(()=>milvusV2OwnerExpression(binding,{recordId:p.recordId,physicalId:randomUUID()}),{code:'S07_PHYSICAL_ID_INVALID'});
});
test('S07 public mutation permissions stay closed before any backend request',async()=>{
 const bk=mock({disposable:false});const adapter=milvusV2Adapter(bk,binding);
 await assert.rejects(()=>adapter.insertRecord(insert(),payload),{code:'S07_WRITE_NOT_ACTIVATED'});
 assert.equal(bk.calls.length,0);
 await assert.rejects(()=>provisionDisposableMilvusV2Collection(bk,binding),{code:'S07_PROVISION_NOT_AUTHORIZED'});
});
test('S07 disposable insert, text update, metadata revision update and fully scoped delete',async()=>{
 const bk=mock(),a=milvusV2Adapter(bk,binding),p=insert();
 assert.equal((await a.insertRecord(p,payload)).status,'VERIFIED');
 assert.equal((await a.getRecord(p.recordId)).revision,1);
 const updatePayload={text:'new text',vector:[0.125,0.25,0.5],metadata:{tag:'new'}};
 const up=plan({action:'update',recordId:p.recordId,expectedRevision:1,...updatePayload});
 assert.equal((await a.updateRecord(up,updatePayload)).status,'VERIFIED');
 assert.equal((await a.getRecord(p.recordId)).revision,2);
 const meta={metadata:{tag:'changed-only'}};
 const mp=plan({action:'metadata',recordId:p.recordId,expectedRevision:2,...meta});
 assert.equal((await a.updateRecord(mp,meta)).status,'VERIFIED');
 assert.equal((await a.getRecord(p.recordId)).text,'new text');
 assert.equal((await a.getRecord(p.recordId)).revision,3);
 const dp=plan({action:'delete',recordId:p.recordId,expectedRevision:3});
 assert.equal((await a.deleteRecord(dp)).status,'VERIFIED');
 assert.equal(await a.getRecord(p.recordId),null);
 assert.equal(bk.map.size,0);
 const deleted=bk.calls.find(c=>c.method==='deleteEntities');
 assert.equal(parseExpr(deleted.args.filter).length,8);
});
test('S07 cross-user and branch isolation with identical contents and hashes',async()=>{
 const bk=mock(),a=milvusV2Adapter(bk,binding),p=insert();await a.insertRecord(p,payload);
 const sc2={...scope,branchId:'branch-2'},bb=bind(sc2),b=milvusV2Adapter(bk,bb);
 const p2=plan({action:'insert',...payload},sc2);
 assert.notEqual(p.physicalId,p2.physicalId);
 await b.insertRecord(p2,payload);
 assert.equal((await a.getRecord(p.recordId)).scope.branchId,'branch-1');
 assert.equal((await b.getRecord(p2.recordId)).scope.branchId,'branch-2');
 assert.equal(await b.getRecord(p.recordId),null);
 await a.deleteRecord(plan({action:'delete',recordId:p.recordId,expectedRevision:1}));
 assert.equal((await b.getRecord(p2.recordId)).text,payload.text);
 const other={...scope,userScopeId:'bob'};
 assert.equal(await milvusV2Adapter(bk,bind(other)).getRecord(p2.recordId),null);
});
test('S07 forged ownership or missing physical ownership columns are rejected',async()=>{
 const bk=mock(),a=milvusV2Adapter(bk,binding),p=insert();await a.insertRecord(p,payload);
 const raw=bk.map.get(p.physicalId);raw.userScopeId='bob';
 assert.equal(await a.getRecord(p.recordId),null); // backend scope removes other-owner row
 raw.userScopeId='alice';delete raw.collectionId;
 assert.equal(await a.getRecord(p.recordId),null); // physical scope removes unscoped row
 raw.collectionId=scope.collectionId;raw.metadata={userScopeId:'bob'};
 await assert.rejects(()=>a.getRecord(p.recordId),{code:'S05_METADATA_MISMATCH'});
});
test('S07 stale revisions and changed payloads refuse updates without write dispatch',async()=>{
 const bk=mock(),a=milvusV2Adapter(bk,binding),p=insert();
 await assert.rejects(()=>a.insertRecord({...p,physicalId:randomUUID()},payload),{code:'S07_PLAN_SCOPE_INVALID'});
 assert.equal(bk.calls.filter(c=>c.method==='insert').length,0);
 await assert.rejects(()=>a.insertRecord(p,{...payload,vector:[0.1,0.2,0.3]}),{code:'S07_FLOAT32_REQUIRED'});
 assert.equal(bk.calls.filter(c=>c.method==='insert').length,0);
 await a.insertRecord(p,payload);
 const outdated=plan({action:'metadata',recordId:p.recordId,expectedRevision:9,metadata:{x:1}});
 await assert.rejects(()=>a.updateRecord(outdated,{metadata:{x:1}}),{code:'S07_REVISION_CONFLICT'});
 assert.equal(bk.calls.filter(c=>c.method==='upsert').length,0);
});
test('S07 failed/uncertain acknowledgements never become verified',async()=>{
 const failed=mock({writeFailure:'insert'});
 await assert.rejects(()=>milvusV2Adapter(failed,binding).insertRecord(insert(),payload),/injected insert outage/);
 const ack=mock({ackMode:'uncertain'});
 await assert.rejects(()=>milvusV2Adapter(ack,binding).insertRecord(insert(),payload),{code:'S07_MUTATION_UNCERTAIN'});
 const err=mock({ackMode:'backend-error'});
 await assert.rejects(()=>milvusV2Adapter(err,binding).insertRecord(insert(),payload),{code:'S07_BACKEND_FAILURE'});
});
test('S07 backend query exceptions and status errors do not turn into empty record result',async()=>{
 const bk=mock({readFailure:'query'});
 await assert.rejects(()=>milvusV2Adapter(bk,binding).getRecord(randomUUID()),/injected query outage/);
 const bad=mock({readFailure:'error-status'});
 await assert.rejects(()=>milvusV2Adapter(bad,binding).getRecord(randomUUID()),{code:'S07_BACKEND_FAILURE'});
 await assert.rejects(()=>milvusV2Adapter(bad,binding).query({vector:payload.vector,topK:5}),{code:'S07_BACKEND_FAILURE'});
});
test('S07 ordinary page traversal is bounded and cannot certify consistent export',async()=>{
 const bk=mock(),a=milvusV2Adapter(bk,binding);
 // Stable generated primary IDs and valid new-schema owner columns from planned rows.
 for(let i=0;i<1090;i++){
  const p=plan({action:'insert',text:`record ${i}`,vector:payload.vector,metadata:{i}});
  const row={schemaVersion:2,...scope,physicalId:p.physicalId,recordId:p.recordId,revision:1,text:`record ${i}`,
   textHash:p.textHash,metadata:{i},metadataHash:p.metadataHash,embedding,vectorHash:p.vectorHash,vector:payload.vector};
  bk.map.set(p.physicalId,row);
 }
 const page=await a.listPage({limit:60});assert.equal(page.items.length,60);
 assert.equal(page.inventoryVerified,false);
 const walked=await walkInventory({binding,readPage:async({cursor,limit})=>{
  const response=await bk.client.query({collection_name:binding.collection.physicalName,filter:milvusV2OwnerExpression(binding),offset:cursor??0,limit:limit+1});
  const hasMore=response.data.length>limit;
  return {items:response.data.slice(0,limit),hasMore,nextCursor:hasMore?(cursor??0)+limit:null};
 },limit:100,maxPages:20});
 assert.equal(walked.examined,1090);assert.equal(walked.inventoryVerified,false);
 assert.equal(walked.verifiedExportAllowed,false);
});
test('S07 disposable provisioning refuses existing physical collection without modification',async()=>{
 const bk=mock();await assert.rejects(()=>provisionDisposableMilvusV2Collection(bk,binding),{code:'S07_COLLECTION_EXISTS'});
 assert.ok(bk.calls.every(c=>c.method==='listCollections'));
});
test('S07 disposable provisioning explicitly builds v2 schema; never drops on mismatched dimension',async()=>{
 const bk=mock({existing:false});const r=await provisionDisposableMilvusV2Collection(bk,binding);
 assert.equal(r.status,'PROVISIONED_DISPOSABLE_ONLY');
 assert.ok(bk.calls.some(c=>c.method==='createCollection'));
 assert.ok(bk.calls.some(c=>c.method==='createIndex'));
 assert.ok(!bk.calls.some(c=>c.method==='dropCollection'));
 const mismatched=mock({dimension:4});
 await assert.rejects(()=>milvusV2Adapter(mismatched,binding).insertRecord(insert(),payload),{code:'S07_DIMENSION_MISMATCH'});
 assert.equal(mismatched.calls.filter(c=>['insert','upsert','deleteEntities','dropCollection'].includes(c.method)).length,0);
});
test('S07 internal adapter works with S04 ledger and remains disabled on public routes',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'s07-milvus-engine-'));
 try{
  const context={userScopeId:scope.userScopeId,vectorsPath:dir},bk=mock();
  const engine=new MutationEngine({atomicOnly:false,ledger:new OperationLedger(context),adapter:milvusV2Adapter(bk,binding),
   authorize:async p=>({authorized:true,ownerVerified:true,mutationContractVerified:true,collectionKey:p.collectionKey,backend:p.backend})});
  const p=plan({action:'insert',...payload});
  const response=await engine.execute(p,payload);
  assert.equal(response.state,'VERIFIED');
  assert.equal(bk.map.size,1);
  await assert.rejects(()=>engine.execute(p,payload));
  assert.equal(bk.map.size,1);
 }finally{await fs.rm(dir,{force:true,recursive:true});}
});
test('S07 error and non-disposable mutation routes remain gated in index.js',async()=>{
 const source=await fs.readFile(new URL('../index.js',import.meta.url),'utf8');
 assert.equal(source.includes("import {milvusV2Adapter"),false);
 assert.match(source,/registerS04Routes|s04-routes/);
 assert.match(source,/registerS05Routes|s05-routes/);
});
test('S07 scoped get and search request strong consistency and physical owner fields',async()=>{
 const bk=mock(),a=milvusV2Adapter(bk,binding),p=insert();await a.insertRecord(p,payload);
 const got=await a.getRecord(p.recordId);assert.equal(got.recordId,p.recordId);
 const results=await a.query({vector:payload.vector,topK:5});assert.equal(results.length,1);
 const q=bk.calls.find(c=>c.method==='query'),search=bk.calls.find(c=>c.method==='search');
 assert.equal(q.args.consistency_level,'Strong');assert.equal(search.args.consistency_level,'Strong');
 assert.ok(q.args.output_fields.includes('userScopeId'));
 assert.ok(q.args.output_fields.includes('branchId'));
 assert.ok(search.args.output_fields.includes('sourceId'));
});
test('S07 unbranched chat records use explicit empty branch for all reads and mutations',async()=>{
 const sc={...scope};delete sc.branchId;
 const bk=mock(),a=milvusV2Adapter(bk,bind(sc)),p=plan({action:'insert',...payload},sc);
 assert.equal((await a.insertRecord(p,payload)).status,'VERIFIED');
 const row=bk.map.get(p.physicalId);assert.equal(row.branchId,'');
 assert.equal((await a.getRecord(p.recordId)).scope.branchId,undefined);
 await a.deleteRecord(plan({action:'delete',recordId:p.recordId,expectedRevision:1},sc));
 assert.equal(await a.getRecord(p.recordId),null);
});
test('S07 failed scoped delete preserves physical data and propagates failure',async()=>{
 const bk=mock(),a=milvusV2Adapter(bk,binding),p=insert();await a.insertRecord(p,payload);
 bk.client.deleteEntities=async()=>{throw Error('injected scoped delete failure');};
 await assert.rejects(()=>a.deleteRecord(plan({action:'delete',recordId:p.recordId,expectedRevision:1})),/injected scoped delete failure/);
 assert.equal((await a.getRecord(p.recordId)).revision,1);
 assert.equal(bk.map.size,1);
});
test('S07 post-ack readback failure cannot report a verified insertion',async()=>{
 const bk=mock(),a=milvusV2Adapter(bk,binding),p=insert(),orig=bk.client.insert;
 bk.client.insert=async(args)=>{const r=await orig(args);bk.map.delete(p.physicalId);return r;};
 await assert.rejects(()=>a.insertRecord(p,payload),{code:'S07_MUTATION_UNCERTAIN'});
});
test('S07 v2 API remains unavailable despite a caller providing its own provenance flag',async()=>{
 const bk=mock({disposable:false});const a=milvusV2Adapter(bk,binding);
 const p=insert();await assert.rejects(()=>a.insertRecord({...p,authorized:true,executionAllowed:true},payload),{code:'S07_WRITE_NOT_ACTIVATED'});
 assert.equal(bk.calls.length,0);
});
test('S07 schema inspection refuses insufficient owner string capacity or absent index',async()=>{
 const tooShort=fields(3).map(f=>f.name==='sourceId'?{...f,max_length:32}:f);
 await assert.rejects(()=>inspectMilvusV2Collection(mock({fieldsOverride:tooShort}),binding),{code:'S07_SCHEMA_MISMATCH'});
 const bk=mock();delete bk.client.describeIndex;
 await assert.rejects(()=>inspectMilvusV2Collection(bk,binding),{code:'S07_INDEX_UNVERIFIABLE'});
});
test('S07 malformed or truncated response cannot be treated as an empty successful read',async()=>{
 const bk=mock(),a=milvusV2Adapter(bk,binding);
 bk.client.query=async()=>({status:{error_code:0}});
 await assert.rejects(()=>a.getRecord(randomUUID()),{code:'S05_BACKEND_RESPONSE_INVALID'});
 bk.client.query=async()=>({status:{error_code:7},data:[]});
 await assert.rejects(()=>a.getRecord(randomUUID()),{code:'S07_BACKEND_FAILURE'});
});
test('S07 operation ledger survives a simulated process restart after verified insert',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'s07-milvus-restart-'));
 try{
  const ctx={userScopeId:scope.userScopeId,vectorsPath:dir},bk=mock();
  const ledger=new OperationLedger(ctx),a=milvusV2Adapter(bk,binding),engine=new MutationEngine({atomicOnly:false,ledger,adapter:a,
   authorize:async p=>({authorized:true,ownerVerified:true,mutationContractVerified:true,collectionKey:p.collectionKey,backend:p.backend})});
  const p=insert();await engine.execute(p,payload);
  const fresh=new OperationLedger(ctx),receipt=await fresh.read(p.operationId);
  assert.equal(receipt.state,'VERIFIED');
  assert.equal((await a.getRecord(p.recordId)).revision,1);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

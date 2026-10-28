import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {collectionIdentity} from '../lib/s02-identity.js';
import {f07VectraLocation,provisionF07VectraV2Collection,f07SealedVectra,f07SchemaSeal} from '../lib/f07-vectra.js';
import {F07_ACCEPTANCE_CONSENT,F07_ACCEPTANCE_STAGES,runF07VectraAcceptance,registerF07AcceptanceRoutes} from '../lib/f07-vectra-acceptance.js';
import {F07_PILOT_CONSENT,registerF07PilotRoutes,validateF07VectraPilot} from '../lib/f07-vectra-pilot.js';
import {OperationLedger} from '../lib/s04-ledger.js';
const scope={userScopeId:'alice',collectionId:'chat',type:'chat',sourceId:'file',branchId:'branch'};
const embedding={source:'transformers',model:'test',dimension:4,metric:'cosine'};
const id=collectionIdentity({backend:'vectra',scope,embedding});
const binding={backend:'vectra',authorized:true,provenance:'SERVER_VERIFIED',scope,embedding,
 collection:{key:id.key,physicalName:id.physicalName}};
const indices=new Map();
function mockIndex(folder){
 const state=indices.get(folder)??{items:new Map(),created:false};indices.set(folder,state);
 return {
  async isIndexCreated(){return state.created;},
  async createIndex(options){assert.equal(options.version,1);await fs.mkdir(folder);state.created=true;},
  async listItems(){return structuredClone([...state.items.values()]);},
  async getItem(id){return structuredClone(state.items.get(id));},
  async queryItems(vector,text,topK){assert.equal(text,'');assert.ok(Number.isInteger(topK));return [...state.items.values()].slice(0,topK).map(item=>({score:0.9,item:structuredClone(item)}));},
  async beginUpdate(){},async endUpdate(){},async cancelUpdate(){},
  async insertItem(item){if(state.items.has(item.id))throw Error('collision');state.items.set(item.id,structuredClone(item));},
  async upsertItem(item){state.items.set(item.id,structuredClone(item));},
  async deleteItem(id){state.items.delete(id);},
 };
}
async function fixture(fn){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'f07-'));await fs.chmod(dir,0o700);
 try{return await fn({vectorsPath:dir,userScopeId:'alice'});}finally{await fs.rm(dir,{recursive:true,force:true});}
}
function router(){const routes=new Map();return {routes,post:(x,fn)=>routes.set(x,fn)};}
function res(){return {statusCode:200,status(n){this.statusCode=n;return this},json(v){this.body=v;return this}};}
test('F07 creates only new user-rooted Vectra index, no overwrite or path injection',()=>fixture(async ctx=>{
 const folder=await f07VectraLocation(ctx,binding,{createRoot:true});
 const index=mockIndex(folder);
 assert.equal((await provisionF07VectraV2Collection({folder,index},binding,ctx)).status,'PROVISIONED_SOURCE_BOUND_UNCERTIFIED');
 await assert.rejects(()=>provisionF07VectraV2Collection({folder,index},binding,ctx),{code:'F07_COLLECTION_EXISTS'});
 await assert.rejects(()=>provisionF07VectraV2Collection({folder:'/tmp/other',index},binding,ctx),{code:'F07_COLLECTION_EXISTS'});
 const wrong={...binding,collection:{...binding.collection,physicalName:'legacy'}};
 await assert.rejects(()=>f07VectraLocation(ctx,wrong),{code:'S05_COLLECTION_UNVERIFIED'});
}));
test('F07 receipt-sealed Vectra access refuses mere reservation and requires valid receipt',()=>fixture(async ctx=>{
 const folder=await f07VectraLocation(ctx,binding,{createRoot:true});await provisionF07VectraV2Collection({folder,index:mockIndex(folder)},binding,ctx);
 await assert.rejects(()=>f07SealedVectra({s03:ctx},binding,{createIndex:mockIndex}),{code:'ENOENT'});
 const receiptFolder=path.join(ctx.vectorsPath,'.similharity','f03-provisions');
 await fs.mkdir(receiptFolder,{recursive:true,mode:0o700});await fs.chmod(path.dirname(receiptFolder),0o700);
 await fs.writeFile(path.join(receiptFolder,id.key+'.json'),JSON.stringify({schemaVersion:3,collectionKey:id.key,
  physicalName:id.physicalName,backend:'vectra',userScopeId:'alice',operationId:randomUUID(),state:'SCHEMA_VERIFIED_OFFLINE_UNCERTIFIED'}),{mode:0o600});
 const backend=await f07SealedVectra({s03:ctx},binding,{createIndex:mockIndex});
 assert.equal(backend.s08ServerSchema.collectionKey,id.key);
}));
test('F07 acceptance traverses disposable Vectra S04 lifecycle, never enables production',()=>fixture(async ctx=>{
 const result=await runF07VectraAcceptance(ctx,mockIndex);
 assert.equal(result.success,true,JSON.stringify(result));
 assert.deepEqual(result.stages.map(x=>x.stage),F07_ACCEPTANCE_STAGES);
 assert.equal(result.backendCertified,false);assert.equal(result.nativeStandardCertified,false);
 assert.equal(result.productionWritesEnabled,false);
}));
test('F07 guarded diagnostic blocks client-selected paths and cross-site marker',()=>fixture(async ctx=>{
 const r=router();registerF07AcceptanceRoutes(r,{makeIndex:mockIndex});
 const call=async(body,headers)=>{const x=res();await r.routes.get('/v2/diagnostics/vectra-f07')({s03:ctx,body,headers},x);return x;};
 assert.equal((await call({consent:F07_ACCEPTANCE_CONSENT},{})).statusCode,403);
 assert.equal((await call({consent:F07_ACCEPTANCE_CONSENT,path:'/tmp'}, {'x-vecthare-f07-diagnostic':'1'})).statusCode,403);
 const result=await call({consent:F07_ACCEPTANCE_CONSENT},{'x-vecthare-f07-diagnostic':'1','sec-fetch-site':'same-origin'});
 assert.equal(result.statusCode,200,JSON.stringify(result.body));
}));
test('F07 pilot verifies server binding and ledger through insert/meta/delete, denies unsafe request',()=>fixture(async ctx=>{
 const folder=await f07VectraLocation(ctx,binding,{createRoot:true});await provisionF07VectraV2Collection({folder,index:mockIndex(folder)},binding,ctx);
 const r=router();let attestations=0;
 registerF07PilotRoutes(r,{bind:async()=>{attestations++;return {binding}},createVectra:async()=>({index:mockIndex(folder),s08ServerSchema:f07SchemaSeal(binding)})});
 const body=(action,recordId,rev,extras={})=>({backend:'vectra',configId:'default',source:{kind:'chat',avatar:'a.png',chatFile:'test'},
  embedding,action,recordId,operationId:randomUUID(),expectedRevision:rev,experimentalConsent:F07_PILOT_CONSENT,...extras});
 const call=async b=>{const x=res();await r.routes.get('/v2/records/vectra-pilot-mutate')({s03:ctx,body:b,headers:{'x-vecthare-f07-pilot':'1'}},x);return x;};
 const recordId=randomUUID(),insert=body('insert',recordId,0,{text:'record',vector:[.25,.5,.75,.125],metadata:{x:1}});
 assert.equal((await call(insert)).body.state,'VERIFIED');
 assert.equal((await new OperationLedger(ctx).read(insert.operationId)).state,'VERIFIED');
 assert.equal((await call(body('metadata',recordId,1,{metadata:{x:2}}))).body.state,'VERIFIED');
 assert.equal((await call(body('delete',recordId,2))).body.state,'VERIFIED');
 assert.ok(attestations>=6);
 assert.throws(()=>validateF07VectraPilot({headers:{'x-vecthare-f07-pilot':'1'},body:{...insert,path:'/data/other'}}),{code:'F07_PILOT_REQUEST_INVALID'});
 assert.equal((await call({...insert,experimentalConsent:'no'})).statusCode,403);
}));
import {registerF03ProvisionRoutes,readF03ProvisionReceipt} from '../lib/f03-provision.js';
test('F07 F03 router provisions one new verified Vectra index, seals receipt and refuses retry',()=>fixture(async ctx=>{
 const r=router();const backendPool={get(){throw Error('Vectra must never resolve remote backend pool');}};
 registerF03ProvisionRoutes(r,{backendPool,bind:async()=>({binding}),
  createVectra:async(req,b)=>{const folder=await f07VectraLocation(req.s03,b,{createRoot:true});return {folder,index:mockIndex(folder)};}});
 const body={backend:'vectra',source:{kind:'chat',avatar:'a.png',chatFile:'chat.jsonl'},embedding,configId:'default'};
 const call=async(route,fields)=>{const x=res();await r.routes.get('/v2/collections/'+route)({s03:ctx,body:{...body,...fields}},x);return x;};
 const preview=await call('preview',{});assert.equal(preview.body.success,true);
 assert.equal(preview.body.collectionName,id.physicalName);
 const created=await call('provision',{expectedCollectionName:id.physicalName,confirmProvision:true});
 assert.equal(created.statusCode,200,JSON.stringify(created.body));
 assert.equal(created.body.receiptState,'SCHEMA_VERIFIED_OFFLINE_UNCERTIFIED');
 const receipt=await readF03ProvisionReceipt(ctx,binding);assert.equal(receipt.state,'SCHEMA_VERIFIED_OFFLINE_UNCERTIFIED');
 const repeated=await call('provision',{expectedCollectionName:id.physicalName,confirmProvision:true});
 assert.equal(repeated.statusCode,409);assert.equal(repeated.body.code,'F03_RECEIPT_EXISTS');
 const mismatch=await call('provision',{expectedCollectionName:'vh2_'+'b'.repeat(48),confirmProvision:true});
 assert.equal(mismatch.statusCode,409);
}));

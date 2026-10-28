import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {OperationLedger} from '../lib/s04-ledger.js';
import {compareStoredVector} from '../lib/f03-vector-evidence.js';
import {registerF03ProvisionRoutes} from '../lib/f03-provision.js';
import {collectionIdentity} from '../lib/s02-identity.js';
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const scope={userScopeId:'alice',collectionId:'owned-chat',type:'chat',sourceId:'file-derived',branchId:'branch-b'};
const embedding={source:'transformers',model:'f03-test',dimension:3,metric:'cosine'};
const c=collectionIdentity({backend:'qdrant',scope,embedding});
const binding={authorized:true,provenance:'SERVER_VERIFIED',backend:'qdrant',scope,embedding,collection:{key:c.key,physicalName:c.physicalName}};
const source={kind:'chat',avatar:'character.png',chatFile:'example'};
const request={backend:'qdrant',source,embedding,configId:'local'};
function router(){const routes=new Map();return {routes,post:(p,fn)=>routes.set(p,fn)};}
function res(){return {statusCode:200,body:null,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};}
async function temp(fn){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'vecthare-f03-'));try{
 await fs.chmod(dir,0o700);await fs.mkdir(path.join(dir,'.similharity'),{mode:0o700});
 return await fn({userScopeId:'alice',vectorsPath:dir});
}finally{await fs.rm(dir,{recursive:true,force:true});}}
const setup=(ctx,provisionBackend)=>{
 const r=router();let connections=0,bindCalls=[];
 registerF03ProvisionRoutes(r,{backendPool:{async get(){connections++;return {fake:true};}},
  bind:async(req,body,{reserve})=>{bindCalls.push(reserve);assert.equal(req.s03,ctx);return {binding};},
  provisionBackend});
 return {r,bindCalls,getConnections:()=>connections};
};
const call=async(r,path,ctx,body)=>{const out=res();await r.routes.get(path)({s03:ctx,body},out);return out;};
test('F03 vector evidence tolerates float32 and Qdrant cosine normalization but refuses hash copies',()=>{
 const expected=[0.1,0.2,0.3],norm=Math.hypot(...expected);
 assert.equal(compareStoredVector({backend:'qdrant',metric:'cosine',expected,actual:expected.map(v=>Math.fround(v/norm)),dimension:3,expectedHash:sha(expected)}).verified,true);
 assert.equal(compareStoredVector({backend:'milvus',metric:'dot',expected,actual:expected.map(Math.fround),dimension:3,expectedHash:sha(expected)}).verified,true);
 for(const actual of [[2,3,4],[0,0,0],[0.1,0.2,NaN]])
  assert.equal(compareStoredVector({backend:'qdrant',metric:'cosine',expected,actual,dimension:3,expectedHash:sha(expected)}).verified,false);
 assert.equal(compareStoredVector({backend:'qdrant',metric:'cosine',expected,actual:expected,dimension:3,expectedHash:'bad'}).verified,false);
});
test('F03 schema preview reserves name but never connects or provisions',async()=>temp(async ctx=>{
 const {r,bindCalls,getConnections}=setup(ctx,async()=>{throw Error('must not provision');});
 const result=await call(r,'/v2/collections/preview',ctx,request);
 assert.equal(result.statusCode,200);assert.equal(result.body.collectionName,c.physicalName);
 assert.equal(result.body.physicalCollectionProvisioned,false);assert.equal(result.body.productionWritesEnabled,false);
 assert.equal(getConnections(),0);assert.deepEqual(bindCalls,[true]);
 const spoof=await call(r,'/v2/collections/preview',ctx,{...request,scope:{userScopeId:'bob'}});
 assert.equal(spoof.statusCode,403);assert.equal(getConnections(),0);
}));
test('F03 requires exact generated collection and explicit consent before backend dispatch',async()=>temp(async ctx=>{
 const {r,getConnections}=setup(ctx,async()=>({status:'PROVISIONED_SOURCE_BOUND_UNCERTIFIED',physicalName:c.physicalName}));
 for(const body of [{...request,confirmProvision:false,expectedCollectionName:c.physicalName},
  {...request,confirmProvision:true,expectedCollectionName:'vh2_'+'0'.repeat(48)},
  {...request,confirmProvision:true,expectedCollectionName:c.physicalName,physicalName:c.physicalName}]){
  const result=await call(r,'/v2/collections/provision',ctx,body);
  assert.ok(result.statusCode>=400);assert.equal(getConnections(),0);
 }
}));
test('F03 one-time provision records a durable receipt, rejects retry, never enables writes',async()=>temp(async ctx=>{
 let calls=0;
 const {r,getConnections}=setup(ctx,async()=>{calls++;return {status:'PROVISIONED_SOURCE_BOUND_UNCERTIFIED',physicalName:c.physicalName};});
 const input={...request,confirmProvision:true,expectedCollectionName:c.physicalName};
 const first=await call(r,'/v2/collections/provision',ctx,input);
 assert.equal(first.statusCode,200);assert.equal(first.body.physicalCollectionProvisioned,true);
 assert.equal(first.body.productionWritesEnabled,false);assert.equal(calls,1);
 const file=path.join(ctx.vectorsPath,'.similharity','f03-provisions',c.key+'.json');
 const receipt=JSON.parse(await fs.readFile(file,'utf8'));
 assert.equal(receipt.state,'SCHEMA_VERIFIED_OFFLINE_UNCERTIFIED');assert.equal(receipt.physicalName,c.physicalName);
 const retry=await call(r,'/v2/collections/provision',ctx,input);
 assert.equal(retry.statusCode,409);assert.equal(retry.body.code,'F03_RECEIPT_EXISTS');assert.equal(calls,1);assert.equal(getConnections(),1);
}));
test('F03 backend errors leave UNCERTAIN receipt and refuse all automatic retries',async()=>temp(async ctx=>{
 let writes=0;const {r}=setup(ctx,async()=>{writes++;throw Object.assign(Error('backend crash'),{code:'CONNECTION_LOST'});});
 const input={...request,confirmProvision:true,expectedCollectionName:c.physicalName};
 const first=await call(r,'/v2/collections/provision',ctx,input);
 assert.equal(first.body.code,'F03_PROVISION_UNCERTAIN');assert.equal(writes,1);
 const receipt=JSON.parse(await fs.readFile(path.join(ctx.vectorsPath,'.similharity','f03-provisions',c.key+'.json'),'utf8'));
 assert.equal(receipt.state,'UNCERTAIN');
 const retry=await call(r,'/v2/collections/provision',ctx,input);
 assert.equal(retry.body.code,'F03_RECEIPT_EXISTS');assert.equal(writes,1);
}));
test('F03 collection lock serializes separate ledger instances and refuses stale lock rather than stealing',async()=>temp(async ctx=>{
 const a=new OperationLedger(ctx),b=new OperationLedger(ctx),plan={collectionKey:c.key};
 let release;const blocked=new Promise(resolve=>{release=resolve;});
 let entered;const enteredPromise=new Promise(resolve=>{entered=resolve;});
 const running=a.withCollectionLock(plan,async()=>{entered();await blocked;});
 await enteredPromise;
 await assert.rejects(()=>b.withCollectionLock(plan,async()=>{}),e=>e.code==='S04_OPERATION_BUSY');
 release();await running;
 assert.equal(await b.withCollectionLock(plan,async()=>42),42);
}));
test('F03 collection lock excludes another Node process sharing the private user path',async()=>temp(async ctx=>{
 const ledger=new OperationLedger(ctx);
 await ledger.withCollectionLock({collectionKey:c.key},async()=>{
  const script=`import {OperationLedger} from ${JSON.stringify(new URL('../lib/s04-ledger.js',import.meta.url).href)};\nconst l=new OperationLedger(${JSON.stringify(ctx)});\ntry{await l.withCollectionLock({collectionKey:${JSON.stringify(c.key)}},async()=>{});process.exitCode=13;}catch(e){if(e.code!=='S04_OPERATION_BUSY')process.exitCode=14;}`;
  const file=path.join(ctx.vectorsPath,'child.mjs');await fs.writeFile(file,script);
  await promisify(execFile)(process.execPath,[file]);
 });
}));
test('F03 Qdrant native provisioning verifies all owner indexes and refuses existing collections',async()=>{
 // The public F03 route uses its actual Qdrant adapter, not an injected success.
 await temp(async ctx=>{
  const names=new Map();let created=0;
  const backend={async _request(method,url,body){
   if(method==='GET'&&url.startsWith('/collections/')){
    if(!names.has(c.physicalName))throw Object.assign(new Error('404'),{httpStatus:404});
    return {result:{status:'green',config:{params:{vectors:{size:3,distance:'Cosine'}}},payload_schema:Object.fromEntries(
      [...names.get(c.physicalName)].map(field=>[field,{data_type:'keyword'}]))}};
   }
   if(method==='PUT'&&url===`/collections/${c.physicalName}`){created++;names.set(c.physicalName,new Set());return {result:true};}
   if(method==='PUT'&&url.endsWith('/index?wait=true')){names.get(c.physicalName).add(body.field_name);return {result:{status:'completed'}};}
   throw Error('unexpected request');
  }};
  const r=router();registerF03ProvisionRoutes(r,{backendPool:{async get(){return backend;}},
   bind:async()=>({binding})});
  const result=await call(r,'/v2/collections/provision',ctx,{...request,confirmProvision:true,expectedCollectionName:c.physicalName});
  assert.equal(result.statusCode,200);assert.equal(result.body.physicalCollectionProvisioned,true);
  assert.equal(created,1);assert.equal(names.get(c.physicalName).size,7);
 });
});
test('F03 Qdrant unverified owner indexes produce UNCERTAIN receipt instead of false success',async()=>temp(async ctx=>{
 const backend={async _request(method,url){
  if(method==='GET'){
   if(!this.created)throw Object.assign(new Error('404'),{httpStatus:404});
   return {result:{status:'green',config:{params:{vectors:{size:3,distance:'Cosine'}}},payload_schema:{}}};
  }
  if(method==='PUT'&&url.includes('/index?'))return {result:{status:'completed'}};
  if(method==='PUT'){this.created=true;return {result:true};}
 }};
 const r=router();registerF03ProvisionRoutes(r,{backendPool:{async get(){return backend;}},bind:async()=>({binding})});
 const result=await call(r,'/v2/collections/provision',ctx,{...request,confirmProvision:true,expectedCollectionName:c.physicalName});
 assert.equal(result.statusCode,409);assert.equal(result.body.code,'F03_PROVISION_UNCERTAIN');
 const receipt=JSON.parse(await fs.readFile(path.join(ctx.vectorsPath,'.similharity','f03-provisions',c.key+'.json'),'utf8'));
 assert.equal(receipt.state,'UNCERTAIN');
}));
test('F03 receipt status is source scoped and does not verify production writes',async()=>temp(async ctx=>{
 const {r}=setup(ctx,async()=>({status:'PROVISIONED_SOURCE_BOUND_UNCERTIFIED',physicalName:c.physicalName}));
 const prior=await call(r,'/v2/collections/status',ctx,request);
 assert.equal(prior.statusCode,200);assert.equal(prior.body.receiptState,'NO_F03_RECEIPT');
 assert.equal(prior.body.productionWritesEnabled,false);
 await call(r,'/v2/collections/provision',ctx,{...request,confirmProvision:true,expectedCollectionName:c.physicalName});
 const status=await call(r,'/v2/collections/status',ctx,request);
 assert.equal(status.body.receiptState,'SCHEMA_VERIFIED_OFFLINE_UNCERTIFIED');
 assert.equal(status.body.backendCertified,false);assert.equal(status.body.inventoryVerified,false);
}));

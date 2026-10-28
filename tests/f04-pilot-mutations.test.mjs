import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {registerF04PilotRoutes,F04_PILOT_CONSENT,validateF04Pilot} from '../lib/f04-pilot-mutations.js';
import {readF03ProvisionReceipt} from '../lib/f03-provision.js';
import {collectionIdentity} from '../lib/s02-identity.js';
import {OperationLedger} from '../lib/s04-ledger.js';

const scope={userScopeId:'f04-user',collectionId:'scoped-test',type:'chat',sourceId:'verified-source',branchId:'branch-1'};
const embedding={source:'transformers',model:'f04-mock',dimension:3,metric:'dot'};
const identity=collectionIdentity({backend:'qdrant',scope,embedding});
const binding={authorized:true,provenance:'SERVER_VERIFIED',backend:'qdrant',scope,embedding,collection:{key:identity.key,physicalName:identity.physicalName}};
const source={kind:'chat',avatar:'test.png',chatFile:'saved-chat'};
const base={backend:'qdrant',configId:'local',source,embedding,experimentalConsent:F04_PILOT_CONSENT};
const indexes=Object.fromEntries(['userScopeId','collectionId','type','sourceId','branchId','recordId','physicalId'].map(k=>[k,{data_type:'keyword'}]));
const router=()=>{const routes=new Map();return {routes,post:(route,handler)=>routes.set(route,handler)};};
const response=()=>({code:200,body:null,status(code){this.code=code;return this;},json(body){this.body=body;return this;}});
const call=async(r,ctx,body)=>{const res=response();await r.routes.get('/v2/records/pilot-mutate')({s03:ctx,body,headers:{'x-vecthare-f04-pilot':'1'}},res);return res;};
async function freshDir(fn){const root=await fs.mkdtemp(path.join(os.tmpdir(),'vh-f04-'));try{
 await fs.chmod(root,0o700);
 const folder=path.join(root,'.similharity','f03-provisions');await fs.mkdir(folder,{recursive:true,mode:0o700});
 await fs.chmod(path.dirname(folder),0o700);
 await fs.writeFile(path.join(folder,identity.key+'.json'),JSON.stringify({schemaVersion:3,collectionKey:identity.key,
  physicalName:identity.physicalName,backend:'qdrant',userScopeId:scope.userScopeId,operationId:randomUUID(),state:'SCHEMA_VERIFIED_OFFLINE_UNCERTIFIED'}),{mode:0o600});
 return await fn({userScopeId:scope.userScopeId,vectorsPath:root});
}finally{await fs.rm(root,{recursive:true,force:true});}}
function fakeQdrant(){const points=new Map();let mutations=0;
 return {points,get mutationCount(){return mutations;},async _request(method,route,body){
  if(method==='GET'&&route===`/collections/${identity.physicalName}`)return {result:{config:{params:{vectors:{size:3,distance:'Dot'}}},payload_schema:indexes}};
  if(method==='POST'&&route.endsWith('/points/scroll')){
   const must=body.filter.must;
   const rows=[...points.values()].filter(point=>must.every(({key,match})=>point.payload[key]===match.value));
   return {result:{points:rows.slice(0,body.limit).map(p=>({...p,vector:body.with_vector?p.vector:undefined}))}};
  }
  if(method==='PUT'&&route.endsWith('/points?wait=true')){
   mutations++;
   for(const point of body.points)points.set(point.id,{...point});
   return {result:{status:'completed',operation_id:mutations}};
  }
  if(method==='POST'&&route.endsWith('/points/delete?wait=true')){
   mutations++;
   for(const [id,point] of points){if(body.filter.must.every(({key,match})=>point.payload[key]===match.value))points.delete(id);}
   return {result:{status:'completed',operation_id:mutations}};
  }
  throw Error('Fake Qdrant unsupported '+method+' '+route);
 }};
}
const payload=(action,recordId,expectedRevision,extra={})=>({...base,action,recordId,expectedRevision,operationId:randomUUID(),...extra});

test('F04 pilot refuses unrecognized owner/collection scope, missing consent and other backends',()=>{
 const good=payload('insert',randomUUID(),0,{text:'test',vector:[1,2,3]});
 assert.equal(validateF04Pilot(good),good);
 for(const bad of [{...good,collectionName:'legacy'}, {...good,userScopeId:'other'},
  {...good,backend:'milvus'}, {...good,experimentalConsent:false},
  {...good,operationId:'not-a-uuid'}, {...good,configId:'evil'}, {...good,configId:'default'},
  {...good,action:'delete',text:'overwrite'}, {...good,action:'metadata',vector:[1,2,3]}]){
  assert.throws(()=>validateF04Pilot(bad));
 }
});
test('F04 pilot missing/uncertain F03 receipt cannot authorize records',async()=>freshDir(async ctx=>{
 const receiptFile=path.join(ctx.vectorsPath,'.similharity','f03-provisions',identity.key+'.json');
 const actual=await readF03ProvisionReceipt(ctx,binding);assert.equal(actual.state,'SCHEMA_VERIFIED_OFFLINE_UNCERTIFIED');
 const contents=JSON.parse(await fs.readFile(receiptFile,'utf8'));
 await fs.writeFile(receiptFile,JSON.stringify({...contents,state:'UNCERTAIN'}));
 assert.equal((await readF03ProvisionReceipt(ctx,binding)).state,'UNCERTAIN');
 const fake=fakeQdrant(),r=router();registerF04PilotRoutes(r,{backendPool:{get:async()=>fake},bind:async()=>({binding})});
 const answer=await call(r,ctx,payload('insert',randomUUID(),0,{text:'test',vector:[1,2,3]}));
 assert.equal(answer.code,409);assert.equal(answer.body.code,'F04_F03_RECEIPT_REQUIRED');assert.equal(fake.mutationCount,0);
 await fs.writeFile(receiptFile,JSON.stringify({...contents,userScopeId:'wrong'}));
 assert.equal((await call(r,ctx,payload('insert',randomUUID(),0,{text:'test',vector:[1,2,3]}))).body.code,'F03_RECEIPT_UNTRUSTED');
}));
test('F04 real engine + Qdrant adapter pilot insert/update/metadata/delete, replay and stale revision',async()=>freshDir(async ctx=>{
 const fake=fakeQdrant(),r=router();let attestCount=0;
 registerF04PilotRoutes(r,{backendPool:{async get(){return fake;}},bind:async()=>{attestCount++;return {binding};}});
 const id=randomUUID();
 const insert=payload('insert',id,0,{text:'new source-bound record',vector:[0.1,0.2,0.3],metadata:{tag:'pilot'}});
 const one=await call(r,ctx,insert);
 assert.equal(one.code,200,JSON.stringify(one.body));assert.equal(one.body.state,'VERIFIED');assert.equal(one.body.productionWritesEnabled,false);
 assert.equal(one.body.recordId,id);assert.equal(fake.mutationCount,1);
 assert.equal((await new OperationLedger(ctx).read(insert.operationId)).state,'VERIFIED');
 const replay=await call(r,ctx,insert);
 assert.equal(replay.code,409);assert.equal(replay.body.code,'S04_OPERATION_EXISTS');assert.equal(fake.mutationCount,1);
 const stale=await call(r,ctx,payload('update',id,9,{text:'no',vector:[0.3,0.2,0.1]}));
 assert.equal(stale.code,409);assert.equal(stale.body.code,'S04_REVISION_OR_OWNER_MISMATCH');assert.equal(fake.mutationCount,1);
 const update=await call(r,ctx,payload('update',id,1,{text:'updated',vector:[0.3,0.2,0.1],metadata:{tag:'next'}}));
 assert.equal(update.body.state,'VERIFIED',JSON.stringify(update.body));assert.equal(fake.mutationCount,2);
 const metadata=await call(r,ctx,payload('metadata',id,2,{metadata:{tag:'final'}}));
 assert.equal(metadata.body.state,'VERIFIED',JSON.stringify(metadata.body));assert.equal(fake.mutationCount,3);
 const deleteResult=await call(r,ctx,payload('delete',id,3));
 assert.equal(deleteResult.body.state,'VERIFIED',JSON.stringify(deleteResult.body));assert.equal(fake.mutationCount,4);
 assert.equal(fake.points.size,0);assert.ok(attestCount>=8);
}));
test('F04 owner/source binding failure is a refusal before backend access',async()=>freshDir(async ctx=>{
 let backendCalled=false;const r=router();
 registerF04PilotRoutes(r,{backendPool:{async get(){backendCalled=true;throw Error('SHOULD_NOT_CALL');}},
  bind:async()=>({binding:{...binding,scope:{...binding.scope,userScopeId:'other'}}})});
 const result=await call(r,ctx,payload('insert',randomUUID(),0,{text:'test',vector:[0,0,1]}));
 assert.equal(result.code,403);assert.equal(result.body.code,'F04_SOURCE_NOT_VERIFIED');assert.equal(backendCalled,false);
}));

test('F04 origin guard rejects no custom header and cross-origin attempts before backend',async()=>freshDir(async ctx=>{
 let connects=0;const r=router();registerF04PilotRoutes(r,{backendPool:{get:async()=>{connects++;return fakeQdrant();}},bind:async()=>({binding})});
 const handler=r.routes.get('/v2/records/pilot-mutate');
 for(const headers of [{},{'x-vecthare-f04-pilot':'1','sec-fetch-site':'cross-site'},
  {'x-vecthare-f04-pilot':'1',origin:'https://evil.test',host:'localhost:8000'}]){
  const out=response();await handler({s03:ctx,body:payload('insert',randomUUID(),0,{text:'x',vector:[1,2,3]}),headers},out);
  assert.equal(out.code,403);assert.equal(out.body.code,headers['x-vecthare-f04-pilot']?'F04_PILOT_ORIGIN_FORBIDDEN':'F04_PILOT_HEADER_REQUIRED');
 }
 assert.equal(connects,0);
}));
test('F04 Qdrant acknowledged-only response stays UNCERTAIN and operation UUID cannot be retried',async()=>freshDir(async ctx=>{
 const backend=fakeQdrant(),request=backend._request.bind(backend);
 backend._request=async(method,route,body)=>{
  const result=await request(method,route,body);
  if(method==='PUT'&&route.endsWith('/points?wait=true'))return {result:{status:'acknowledged',operation_id:99}};
  return result;
 };
 const r=router();registerF04PilotRoutes(r,{backendPool:{get:async()=>backend},bind:async()=>({binding})});
 const body=payload('insert',randomUUID(),0,{text:'synthetic uncertain response',vector:[1,0,0]});
 const outcome=await call(r,ctx,body);
 assert.equal(outcome.code,202);assert.equal(outcome.body.success,false);assert.equal(outcome.body.state,'UNCERTAIN');
 assert.equal((await new OperationLedger(ctx).read(body.operationId)).state,'UNCERTAIN');
 assert.equal(backend.mutationCount,1);
 assert.equal((await call(r,ctx,body)).body.code,'S04_OPERATION_EXISTS');
 assert.equal(backend.mutationCount,1);
}));
test('F04 refuses missing Qdrant owner index before any record mutation',async()=>freshDir(async ctx=>{
 const backend=fakeQdrant(),get=backend._request.bind(backend);
 backend._request=(method,route,body)=>{
  if(method==='GET')return {result:{config:{params:{vectors:{size:3,distance:'Dot'}}},payload_schema:{userScopeId:{data_type:'keyword'}}}};
  return get(method,route,body);
 };
 const r=router();registerF04PilotRoutes(r,{backendPool:{get:async()=>backend},bind:async()=>({binding})});
 const result=await call(r,ctx,payload('insert',randomUUID(),0,{text:'no index',vector:[1,0,0]}));
 assert.equal(result.code,409);assert.equal(result.body.code,'F03_QDRANT_OWNER_INDEX_UNVERIFIED');
 assert.equal(backend.mutationCount,0);
}));

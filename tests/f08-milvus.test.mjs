import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {collectionIdentity} from '../lib/s02-identity.js';
import {provisionDisposableMilvusV2Collection,milvusV2Adapter} from '../lib/s07-milvus.js';
import {runF08MilvusAcceptance,registerF08AcceptanceRoutes,F08_ACCEPTANCE_CONSENT,F08_ACCEPTANCE_STAGES} from '../lib/f08-milvus-acceptance.js';
import {validateF08MilvusPilot,registerF08MilvusPilotRoutes,F08_PILOT_CONSENT} from '../lib/f08-milvus.js';
const status={error_code:0};
function entries(expr){return expr.split(' && ').map(part=>{const m=part.match(/^([A-Za-z]+) == (.*)$/);if(!m)throw Error('invalid filter');return [m[1],JSON.parse(m[2])];});}
function mock({failInsert=false}={}){
 let name=null, fields=null, index=false;const records=new Map(),calls=[];
 const match=(r,expr)=>entries(expr).every(([k,v])=>r[k]===v);
 const result=(kind,fn,fields)=>async args=>{calls.push({kind,args});if(kind==='insert'&&failInsert)throw Object.assign(Error('injected'),{code:'ECONNRESET'});
  fn(args);return {status,[`${kind}_cnt`]:'1',err_index:[]};};
 const client={
 async listCollections(){calls.push({kind:'listCollections'});return {status,data:name?[{name}]:[]};},
 async createCollection(args){calls.push({kind:'createCollection',args});if(name)throw Error('exists');name=args.collection_name;fields=args.fields;return {status};},
 async describeCollection(args){calls.push({kind:'describeCollection',args});if(!name||args.collection_name!==name)throw Error('missing');return {status,schema:{fields,autoID:false}};},
 async createIndex(args){calls.push({kind:'createIndex',args});index=true;return {status};},
 async describeIndex(args){calls.push({kind:'describeIndex',args});return {status,index_descriptions:index?[{field_name:'vector',params:[{key:'metric_type',value:'COSINE'}]}]:[]};},
 async loadCollection(args){calls.push({kind:'loadCollection',args});return {status};},
 async query(args){calls.push({kind:'query',args});if(args.collection_name!==name)throw Error('other collection');return {status,data:[...records.values()].filter(r=>match(r,args.filter)).slice(args.offset??0,(args.offset??0)+(args.limit??100)).map(r=>structuredClone(r))};},
 async search(args){calls.push({kind:'search',args});return {status,results:[...records.values()].filter(r=>match(r,args.filter)).slice(0,args.limit).map(r=>({...structuredClone(r),score:.9}))};},
 insert:result('insert',a=>{for(const r of a.data)records.set(r.physicalId,structuredClone(r));}),
 upsert:result('upsert',a=>{for(const r of a.data)records.set(r.physicalId,structuredClone(r));}),
 deleteEntities:result('delete',a=>{for(const [id,r] of records)if(match(r,a.filter))records.delete(id);})
 };
 return {client,config:{address:'127.0.0.1:19530'},calls,records,get collection(){return name;}};
}
async function sandbox(callback){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'vecthare-f08-'));try{await fs.chmod(dir,0o700);return await callback({userScopeId:'test-owner',vectorsPath:dir});}finally{await fs.rm(dir,{force:true,recursive:true});}}
const router=()=>{const handlers=new Map();return {handlers,post:(route,handler)=>handlers.set(route,handler)}};
const reply=()=>({statusCode:200,body:null,status(n){this.statusCode=n;return this;},json(b){this.body=b;return this;}});
const hdr={'x-vecthare-f08-diagnostic':'1'};
test('F08 disposable Milvus acceptance covers a complete synthetic lifecycle with no collection drop',()=>sandbox(async ctx=>{
 const backend=mock(),result=await runF08MilvusAcceptance(ctx,backend);
 assert.equal(result.success,true,JSON.stringify(result));
 assert.deepEqual(result.stages.map(s=>s.stage),F08_ACCEPTANCE_STAGES);
 assert.equal(result.backendCertified,false);assert.equal(result.productionWritesEnabled,false);
 assert.equal(backend.records.size,0);assert.ok(backend.collection.startsWith('vh2_'));
 assert.equal(backend.calls.filter(c=>c.kind==='insert').length,1);
 assert.equal(backend.calls.filter(c=>c.kind==='delete').length,1);
 assert.ok(backend.calls.every(c=>!['dropCollection','purge'].includes(c.kind)));
}));
test('F08 uncertain write does not retry, purge or claim success',()=>sandbox(async ctx=>{
 const backend=mock({failInsert:true}),r=await runF08MilvusAcceptance(ctx,backend);
 assert.equal(r.success,false);assert.equal(r.productionWritesEnabled,false);
 assert.equal(r.stages.at(-1).status,'FAILED_OR_UNCERTAIN');
 assert.equal(backend.calls.filter(c=>c.kind==='insert').length,1);
 assert.equal(backend.calls.filter(c=>c.kind==='delete').length,0);
}));
test('F08 acceptance HTTP consent and body fields are fixed before backend contact',async()=>{
 const r=router();let connected=0;registerF08AcceptanceRoutes(r,{backendPool:{get:async()=>{connected++;return mock();}}});
 const call=async(body,ctx={userScopeId:'test-owner',vectorsPath:'/private'},headers=hdr)=>{
  const res=reply();await r.handlers.get('/v2/diagnostics/milvus-f08')({body,s03:ctx,headers},res);return res;};
 for(const bad of [{consent:F08_ACCEPTANCE_CONSENT,configId:'local'},
 {consent:F08_ACCEPTANCE_CONSENT,configId:'default',collection:'victim'},
 {consent:'yes',configId:'default'}])assert.equal((await call(bad)).statusCode,403);
 assert.equal((await call({consent:F08_ACCEPTANCE_CONSENT,configId:'default'},null)).statusCode,403);
 assert.equal((await call({consent:F08_ACCEPTANCE_CONSENT,configId:'default'},undefined,{})).statusCode,403);
 assert.equal(connected,0);
});
test('F08 rejects pilot source spoof, external backend, and missing consent',()=>{
 const source={kind:'chat',avatar:'hero.png',chatFile:'saved'},embedding={source:'transformers',model:'test',dimension:4,metric:'cosine'};
 const body={backend:'milvus',source,embedding,configId:'default',action:'insert',recordId:randomUUID(),operationId:randomUUID(),expectedRevision:0,experimentalConsent:F08_PILOT_CONSENT,text:'fixture',vector:[.5,.25,.125,.0625]};
 const req=b=>({body:b,headers:{'x-vecthare-f08-pilot':'1'}});
 assert.equal(validateF08MilvusPilot(req(body)).backend,'milvus');
 for(const b of [{...body,collection:'legacy'},{...body,owner:'victim'},{...body,configId:'local'},
  {...body,experimentalConsent:'yes'},{...body,operationId:'bad'},
  {...body,action:'delete',vector:[1]}, {...body,action:'update',expectedRevision:0}])
  assert.throws(()=>validateF08MilvusPilot(req(b)));
});
test('F08 pilot public path uses server-owned binding, ledger and physical readback',()=>sandbox(async ctx=>{
 const backend=mock(),scope={userScopeId:ctx.userScopeId,collectionId:'test-chat',type:'chat',sourceId:'saved'};
 const embedding={source:'transformers',model:'test',dimension:4,metric:'cosine'};
 const coll=collectionIdentity({backend:'milvus',scope,embedding});
 const binding={backend:'milvus',authorized:true,provenance:'SERVER_VERIFIED',scope,embedding,collection:{key:coll.key,physicalName:coll.physicalName}};
 await provisionDisposableMilvusV2Collection({...backend,s07DisposableFixture:true},binding);
 const r=router();registerF08MilvusPilotRoutes(r,{backendPool:{get:async()=>backend},bind:async()=>({binding}),verify:async()=>true});
 const base={backend:'milvus',source:{kind:'chat',avatar:'hero.png',chatFile:'saved'},embedding,configId:'default',
  action:'insert',recordId:randomUUID(),operationId:randomUUID(),expectedRevision:0,experimentalConsent:F08_PILOT_CONSENT,
  text:'test',vector:[.5,.25,.125,.0625],metadata:{test:true}};
 const call=async b=>{const res=reply();await r.handlers.get('/v2/records/milvus-pilot-mutate')({body:b,s03:ctx,headers:{'x-vecthare-f08-pilot':'1'}},res);return res;};
 const inserted=await call(base);assert.equal(inserted.body.state,'VERIFIED',JSON.stringify(inserted.body));
 assert.equal((await call({...base,operationId:base.operationId})).body.success,false); // replay denied
 const edited=await call({...base,action:'metadata',operationId:randomUUID(),expectedRevision:1,metadata:{test:'edited'},text:undefined,vector:undefined});
 // no optional client fields are allowed in metadata form; omitted below for the real edit
 assert.equal(edited.body.success,false);
 const meta={...base,action:'metadata',operationId:randomUUID(),expectedRevision:1,metadata:{edited:true}};
 delete meta.text;delete meta.vector;
 const updated=await call(meta);assert.equal(updated.body.state,'VERIFIED',JSON.stringify(updated.body));
 const remove={...meta,action:'delete',operationId:randomUUID(),expectedRevision:2};delete remove.metadata;
 const deleted=await call(remove);assert.equal(deleted.body.state,'VERIFIED',JSON.stringify(deleted.body));
 assert.equal(backend.records.size,0);
}));
test('F08 local pilot rejects remote Milvus address before any vector mutation',()=>sandbox(async ctx=>{
 const r=router(),remote={...mock(),config:{address:'cloud.example.com:19530'}};
 let writes=0,verified=0;
 registerF08MilvusPilotRoutes(r,{backendPool:{get:async()=>remote},
  bind:async()=>({binding:{backend:'milvus',scope:{userScopeId:ctx.userScopeId},collection:{key:'unused',physicalName:'unused'}}}),
  verify:async()=>{verified++;},makeAdapter:()=>{writes++;throw Error('must not be called')}});
 const req={s03:ctx,headers:{'x-vecthare-f08-pilot':'1'},body:{backend:'milvus',configId:'default',
  source:{kind:'chat',avatar:'hero.png',chatFile:'saved'},embedding:{source:'transformers',model:'test',dimension:4,metric:'cosine'},
  action:'insert',recordId:randomUUID(),operationId:randomUUID(),expectedRevision:0,
  experimentalConsent:F08_PILOT_CONSENT,text:'hello',vector:[.5,.25,.125,.0625]}};
 const res=reply();await r.handlers.get('/v2/records/milvus-pilot-mutate')(req,res);
 assert.equal(res.statusCode,403);assert.equal(res.body.code,'F08_LOCAL_MILVUS_REQUIRED');
 assert.equal(writes,0);assert.equal(verified,0);
}));
test('F08 invalid float32 values are rejected before opening a ledger',()=>{
 const req={headers:{'x-vecthare-f08-pilot':'1'},body:{backend:'milvus',configId:'default',
  source:{kind:'chat',avatar:'hero.png',chatFile:'saved'},embedding:{source:'transformers',model:'test',dimension:4,metric:'cosine'},
  action:'insert',recordId:randomUUID(),operationId:randomUUID(),expectedRevision:0,
  experimentalConsent:F08_PILOT_CONSENT,text:'hello',vector:[.8,.4,.2,.1]}};
 assert.throws(()=>validateF08MilvusPilot(req),{code:'F08_FLOAT32_VECTOR_REQUIRED'});
 req.body.vector=[.5,.25,.125,.0625];assert.equal(validateF08MilvusPilot(req).backend,'milvus');
});

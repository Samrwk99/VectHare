import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {registerF02Routes} from '../lib/f02-public-reads.js';
import {registerS05Routes} from '../lib/s05-routes.js';
import {contentFingerprint,recordIdentity} from '../lib/s02-identity.js';
const sha=x=>createHash('sha256').update(x).digest('hex');
const embedding={source:'transformers',model:'test-model',dimension:3,metric:'cosine'};
const selector=name=>({kind:'chat',avatar:'Nina.png',chatFile:name});
const body=(chatFile='one')=>({backend:'qdrant',source:selector(chatFile),embedding,configId:'local'});
const response=()=>({statusCode:200,data:null,status(n){this.statusCode=n;return this;},json(x){this.data=x;return this;}});
async function fixture(fn){
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'f02-public-'));
 try{
  const root=path.join(tmp,'alice');const vectors=path.join(root,'vectors');const chats=path.join(root,'chats');const characters=path.join(root,'characters');
  const worlds=path.join(root,'worlds'),groups=path.join(root,'groups'),groupChats=path.join(root,'groupChats');
  for(const d of [vectors,path.join(chats,'Nina'),characters,worlds,groups,groupChats])await fs.mkdir(d,{recursive:true});
  await fs.writeFile(path.join(characters,'Nina.png'),'avatar');
  for(const [name,metadata] of [['one',{integrity:'copied'}],['branch',{integrity:'copied',main_chat:'one'}]])
   await fs.writeFile(path.join(chats,'Nina',`${name}.jsonl`),JSON.stringify({chat_metadata:metadata})+'\n');
  const req={s03:{userScopeId:'alice',vectorsPath:vectors},user:{profile:{handle:'alice'},directories:{root,vectors,chats,characters,worlds,groups,groupChats}}};
  await fn({tmp,req,chats,vectors});
 }finally{await fs.rm(tmp,{force:true,recursive:true});}
}
function fakeQdrant(){
 const calls=[];let row=null,fail=false,ignoreFilters=false;
 const backend={calls,setRow:x=>row=x,setFail:x=>fail=x,setIgnoreFilters:x=>ignoreFilters=x,async _request(method,route,payload){
  calls.push({method,route,payload});
  if(fail)throw new Error('password=secret backend unavailable');
  if(method==='GET')return {result:{config:{params:{vectors:{size:3,distance:'Cosine'}}},status:'green'}};
  const matching=r=>ignoreFilters||payload.filter.must.every(m=>r?.[m.key]===m.match.value);
  if(route.endsWith('/points/scroll'))return {result:{points:row&&matching(row)?[{id:row.physicalId,payload:row,vector:payload.with_vector?row.vector:undefined}]:[],next_page_offset:null}};
  if(route.endsWith('/points/search'))return {result:row&&matching(row)?[{id:row.physicalId,payload:row,score:0.88}]:[]};
  throw new Error('Unexpected backend call');
 }};
 return backend;
}
function routes(backend){
 const map=new Map(),router={post:(url,cb)=>map.set(url,cb)};
 const handler=registerF02Routes(router,{backendPool:{get:async()=>backend}});
 registerS05Routes(router,{readHandler:handler});
 async function invoke(url,req,requestBody){const res=response();await map.get(url)({...req,body:requestBody},res);return res;}
 return {invoke,backend};
}
const rowFor=(scope)=>{
 const rid=recordIdentity(scope,randomUUID()),text='safe test',vector=[0.1,0.2,0.3],metadata={tag:'safe'};
 return {...scope,branchId:scope.branchId??'',recordId:rid.recordId,physicalId:rid.physicalId,
  text,revision:1,textHash:contentFingerprint(text),vector,vectorHash:sha(JSON.stringify(vector)),
  metadata,metadataHash:sha(JSON.stringify(metadata)),embedding};
};
test('F02 refuses reads before explicit bound v2 collection, and never connects',()=>fixture(async({req})=>{
 const backend=fakeQdrant(),{invoke}=routes(backend);
 const r=await invoke('/v2/reads/list',req,body());
 assert.equal(r.statusCode,409);assert.equal(r.data.code,'F02_COLLECTION_NOT_BOUND');assert.equal(backend.calls.length,0);
}));
test('F02 binds verified chat, then get/list/query use physical filters and valid Qdrant schema',()=>fixture(async({req})=>{
 const backend=fakeQdrant(),{invoke}=routes(backend);
 const b=await invoke('/v2/reads/bind',req,body());
 assert.equal(b.statusCode,200);assert.equal(b.data.bindingReserved,true);assert.equal(b.data.physicalCollectionProvisioned,false);
 const scoped=await invoke('/v2/reads/list',req,{...body(),page:{limit:2}});
 assert.equal(scoped.statusCode,200);assert.equal(scoped.data.data.items.length,0);
 assert.equal(scoped.data.inventoryVerified,false);assert.equal(scoped.data.productionWritesEnabled,false);
 const empty=await invoke('/v2/reads/query',req,{...body(),vector:[1,0,0],topK:5});
 assert.equal(empty.statusCode,200);assert.deepEqual(empty.data.data,[]);
 // Use the backend's exact filter after binding to generate an authoritative owned record.
 const must=backend.calls.find(c=>c.route.endsWith('/points/scroll')).payload.filter.must;
 const scope=Object.fromEntries(must.filter(m=>m.key!=='branchId').map(m=>[m.key,m.match.value]));
 const r=rowFor(scope);backend.setRow(r);
 const q=await invoke('/v2/reads/query',req,{...body(),vector:[1,0,0]});
 assert.equal(q.statusCode,200);assert.equal(q.data.data[0].recordId,r.recordId);
 const get=await invoke('/v2/reads/get',req,{...body(),recordId:r.recordId});
 assert.equal(get.statusCode,200);assert.equal(get.data.data.text,'safe test');
 assert.ok(backend.calls.every(c=>c.method==='GET'||c.method==='POST'));
}));
test('F02 branch with copied integrity has distinct physical namespace and cannot see parent records',()=>fixture(async({req})=>{
 const backend=fakeQdrant(),{invoke}=routes(backend);
 await invoke('/v2/reads/bind',req,body('one'));await invoke('/v2/reads/bind',req,body('branch'));
 const a=await invoke('/v2/reads/list',req,body('one'));
 const b=await invoke('/v2/reads/list',req,body('branch'));
 assert.equal(a.statusCode,200);assert.equal(b.statusCode,200);
 const paths=backend.calls.filter(c=>c.route.endsWith('/points/scroll')).map(c=>c.route);
 assert.equal(paths.length,2);assert.notEqual(paths[0],paths[1]);
 const filters=backend.calls.filter(c=>c.route.endsWith('/points/scroll')).map(c=>c.payload.filter.must);
 assert.equal(filters[0].find(x=>x.key==='branchId').match.value,'');
 assert.notEqual(filters[1].find(x=>x.key==='branchId').match.value,'');
}));
test('F02 rejects browser owner/physical scopes, malformed vectors and invalid backend without network',()=>fixture(async({req})=>{
 const backend=fakeQdrant(),{invoke}=routes(backend);
 for(const input of [{...body(),userScopeId:'alice'},{...body(),scope:{userScopeId:'alice'}},
  {...body(),collectionName:'real-collection'},{...body(),backend:'garbage'}]){
  const r=await invoke('/v2/reads/bind',req,input);assert.ok(r.statusCode>=400);
 }
 const q=await invoke('/v2/reads/query',req,{...body(),vector:[1,2]});assert.equal(q.data.code,'S05_VECTOR_INVALID');
 assert.equal(backend.calls.length,0);
}));
test('F02 refuses changed or missing source after binding and refuses wrong owner backend responses',()=>fixture(async({req,chats})=>{
 const backend=fakeQdrant(),{invoke}=routes(backend);
 await invoke('/v2/reads/bind',req,body());
 const list=await invoke('/v2/reads/list',req,body());
 const must=backend.calls.find(c=>c.route.endsWith('/points/scroll')).payload.filter.must;
 const scope=Object.fromEntries(must.filter(m=>m.key!=='branchId').map(m=>[m.key,m.match.value]));
 backend.setRow({...rowFor(scope),userScopeId:'someone-else'});
 const q=await invoke('/v2/reads/query',req,{...body(),vector:[1,0,0]});
 assert.equal(q.statusCode,200);assert.deepEqual(q.data.data,[]); // backend itself filtered wrong tenant
 await fs.writeFile(path.join(chats,'Nina','one.jsonl'),JSON.stringify({chat_metadata:{integrity:'replaced'}})+'\n');
 const denied=await invoke('/v2/reads/list',req,body());
 assert.equal(denied.data.code,'F01_SOURCE_CHANGED');
 assert.equal(backend.calls.length,4);
}));
test('F02 missing backend collection, failures, and inventory always distinguish absence/uncertainty',()=>fixture(async({req})=>{
 const backend=fakeQdrant(),{invoke}=routes(backend);
 await invoke('/v2/reads/bind',req,body());
 backend.setFail(true);
 const unavailable=await invoke('/v2/reads/list',req,body());
 assert.equal(unavailable.data.code,'F02_READ_FAILED');assert.equal(unavailable.data.success,false);
 const inventory=await invoke('/v2/reads/inventory',req,body());
 assert.equal(inventory.statusCode,409);assert.equal(inventory.data.code,'S05_READ_NOT_ACTIVATED');
}));

test('F02 rejects a malicious backend returning another tenant despite requested scope filters',()=>fixture(async({req})=>{
 const backend=fakeQdrant(),{invoke}=routes(backend);
 await invoke('/v2/reads/bind',req,body());
 backend.setRow(rowFor({userScopeId:'mallory',collectionId:'other',type:'chat',sourceId:'foreign'}));
 backend.setIgnoreFilters(true);
 const result=await invoke('/v2/reads/query',req,{...body(),vector:[1,0,0]});
 assert.equal(result.statusCode,403);assert.equal(result.data.code,'S05_OWNER_MISMATCH');
 assert.equal(result.data.success,false);
}));

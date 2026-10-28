import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {readAttestedChatSnapshot,registerF09bSyncRoutes,validateF09bSyncBody,
 compareF09bSyncMessages} from '../lib/f09b-chat-sync.js';

const source=(chatFile='one')=>({kind:'chat',avatar:'Nina.png',chatFile});
const body=(chatFile='one')=>({backend:'qdrant',source:source(chatFile),configId:'local',embedding:{source:'webllm',model:'m',dimension:3,metric:'cosine'}});
const msg=(text,date,extra={})=>({name:'Nina',is_user:false,send_date:date,mes:text,...extra});
const response=()=>({statusCode:200,status(s){this.statusCode=s;return this;},json(b){this.body=b;return this;}});
async function fixture(fn){
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'f09b-sync-'));
 try{
  const root=path.join(tmp,'alice'),vectors=path.join(root,'vectors'),chats=path.join(root,'chats'),characters=path.join(root,'characters');
  const worlds=path.join(root,'worlds'),groups=path.join(root,'groups'),groupChats=path.join(root,'groupChats');
  for(const p of [vectors,path.join(chats,'Nina'),characters,worlds,groups,groupChats])await fs.mkdir(p,{recursive:true});
  await fs.writeFile(path.join(characters,'Nina.png'),'avatar');
  const write=async(chatFile,rows,integrity='copied')=>fs.writeFile(path.join(chats,'Nina',`${chatFile}.jsonl`),
   [JSON.stringify({chat_metadata:{integrity}}),...rows.map(x=>JSON.stringify(x))].join('\n')+'\n');
  const req={user:{profile:{handle:'alice'},directories:{root,vectors,chats,characters,worlds,groups,groupChats}},
   s03:{userScopeId:'alice',vectorsPath:vectors}};
  await write('one',[msg('hello',1000),msg('second',2000)]);
  await fn({req,write,tmp,chats});
 }finally{await fs.rm(tmp,{recursive:true,force:true});}
}
const routes=()=>{const handlers={};return {handlers,router:{post:(p,h)=>handlers[p]=h}};};
test('F09b chat sync request never accepts client-supplied paths, content, owner or record IDs',()=>{
 assert.deepEqual(validateF09bSyncBody(body()),body());
 for(const extra of [{text:'browser message'},{userScopeId:'other'},{ownerId:'other'},
  {recordId:'not-owned'},{page:{limit:200}},{physicalCollectionName:'legacy'}])
  assert.throws(()=>validateF09bSyncBody({...body(),...extra}));
 assert.throws(()=>validateF09bSyncBody({...body(),source:{kind:'lorebook',name:'test'}}));
});
test('F09b host messages use stable IDs across text edits, additions and chat branches',()=>fixture(async({req,write})=>{
 const first=await readAttestedChatSnapshot(req,source());
 assert.equal(first.messages.length,2);
 const original=first.messages[0];
 await write('one',[msg('changed text',1000),msg('second',2000),msg('new',3000)]);
 const changed=await readAttestedChatSnapshot(req,source());
 assert.equal(changed.messages[0].recordId,original.recordId);
 assert.notEqual(changed.messages[0].contentHash,original.contentHash);
 assert.equal(changed.messages[1].recordId,first.messages[1].recordId);
 await write('branch',[msg('changed text',1000),msg('second',2000),msg('new',3000)]);
 const branch=await readAttestedChatSnapshot(req,source('branch'));
 assert.notEqual(branch.messages[0].recordId,changed.messages[0].recordId);
 assert.notEqual(branch.sourceId,changed.sourceId);
}));
test('F09b refuses duplicate timestamp/speaker or missing stable key instead of inventing a hash-only ID',()=>fixture(async({req,write})=>{
 await write('one',[msg('A',1),msg('B',1)]);
 await assert.rejects(readAttestedChatSnapshot(req,source()),e=>e.code==='F09B_SYNC_STABLE_KEY_COLLISION');
 await write('one',[{name:'Nina',is_user:false,mes:'no date'}]);
 await assert.rejects(readAttestedChatSnapshot(req,source()),e=>e.code==='F09B_SYNC_STABLE_KEY_MISSING');
}));
test('F09b read-only sync plan compares independently scoped gets, never writes or assumes deletion',()=>fixture(async({req})=>{
 const {handlers,router}=routes();let count=0;
 registerF09bSyncRoutes(router,{backendPool:{},readScoped:async(request,b,operation)=>{
  assert.equal(operation,'get');assert.ok(!('ownerId' in b));count++;
  return count===1?null:{recordId:b.recordId,text:'second',revision:3};
 }});
 const r=response();await handlers['/v2/workflows/chat-sync-plan']({...req,body:body()},r);
 assert.equal(r.statusCode,200,JSON.stringify(r.body));
 assert.deepEqual(r.body.counts,{create:1,update:0,inSync:1});
 assert.equal(r.body.productionWritesEnabled,false);
 assert.equal(r.body.deletionsPlanned,false);
 assert.equal(r.body.completeInventory,false);
 assert.equal(r.body.actions[1].expectedRevision,3);
 assert.equal(count,2);
}));
test('F09b refuses saved-chat changes during remote record checks',()=>fixture(async({req,write})=>{
 const {handlers,router}=routes();let called=0;
 registerF09bSyncRoutes(router,{backendPool:{},readScoped:async()=>{
  if(++called===1)await write('one',[msg('edited',1000),msg('second',2000)]);
  return null;
 }});
 const r=response();await handlers['/v2/workflows/chat-sync-plan']({...req,body:body()},r);
 assert.equal(r.statusCode,409);assert.equal(r.body.code,'F09B_SYNC_SOURCE_CHANGED');
}));
test('F09b denies missing authenticated user, forged owner, missing source, wrong record and incomplete snapshots',()=>fixture(async({req,chats,write})=>{
 const {handlers,router}=routes();let called=0;
 registerF09bSyncRoutes(router,{backendPool:{},readScoped:async(r,b)=>{called++;return {recordId:'wrong',revision:1,text:'bad'};}});
 const r=response();await handlers['/v2/workflows/chat-sync-plan']({...req,s03:{},body:body()},r);
 assert.equal(r.statusCode,403);assert.equal(called,0);
 const spoof=response();await handlers['/v2/workflows/chat-sync-plan']({...req,body:{...body(),ownerId:'bob'}},spoof);
 assert.equal(spoof.statusCode,400);assert.equal(called,0);
 const bad=response();await handlers['/v2/workflows/chat-sync-plan']({...req,body:body()},bad);
 assert.equal(bad.body.code,'F09B_SYNC_READBACK_INVALID');
 await fs.rm(path.join(chats,'Nina','one.jsonl'));
 await assert.rejects(readAttestedChatSnapshot(req,source()));
 await write('one',[msg('ok',1)]);
 assert.throws(()=>compareF09bSyncMessages([{recordId:'x',text:'test'}],[]));
}));
test('F09b oversized chat must not be processed partially',()=>fixture(async({req,write})=>{
 await write('one',Array.from({length:81},(_,i)=>msg('text',i)));
 await assert.rejects(readAttestedChatSnapshot(req,source()),e=>e.code==='F09B_SYNC_CHAT_LIMIT');
}));
test('F09b real F02 Qdrant integration scopes each record read to its server-attested chat collection',()=>fixture(async({req,write,chats})=>{
 const {registerF02Routes}=await import('../lib/f02-public-reads.js');
 const {handlers,router}=routes();const captures=[];
 const backendPool={get:async()=>({_request:async(method,uri,payload)=>{
  captures.push({method,uri,payload});
  if(method==='GET')return {result:{config:{params:{vectors:{size:3,distance:'Cosine'}}},status:'green'}};
  if(method==='POST'&&uri.endsWith('/points/scroll'))return {result:{points:[],next_page_offset:null}};
  throw Error('unexpected mutation');
 }})};
 registerF02Routes(router,{backendPool});registerF09bSyncRoutes(router,{backendPool});
 const invoke=async(url,b)=>{const out=response();await handlers[url]({...req,body:b},out);return out;};
 for(const file of ['one','branch']){
  if(file==='branch')await write('branch',[msg('hello',1000),msg('second',2000)]);
  const b=body(file);
  const bind=await invoke('/v2/reads/bind',b);assert.equal(bind.statusCode,200,JSON.stringify(bind.body));
  const plan=await invoke('/v2/workflows/chat-sync-plan',b);
  assert.equal(plan.statusCode,200,JSON.stringify(plan.body));
  assert.deepEqual(plan.body.counts,{create:2,update:0,inSync:0});
 }
 const scroll=captures.filter(x=>x.uri.endsWith('/points/scroll'));
 assert.equal(scroll.length,4);
 assert.notEqual(scroll[0].uri,scroll[2].uri);
 assert.notEqual(scroll[0].payload.filter.must.find(x=>x.key==='sourceId').match.value,
  scroll[2].payload.filter.must.find(x=>x.key==='sourceId').match.value);
 await fs.rm(path.join(chats,'Nina','one.jsonl'));
 const missing=await invoke('/v2/workflows/chat-sync-plan',body());
 assert.equal(missing.statusCode,404);
 assert.equal(captures.filter(x=>x.uri.endsWith('/points/scroll')).length,4);
}));

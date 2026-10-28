import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {executeF09b3Sync,registerF09b3SyncRoutes,F09B3_CONSENT} from '../lib/f09b3-chat-sync-execute.js';
import {readAttestedChatSnapshot} from '../lib/f09b-chat-sync.js';
import {collectionIdentity,contentFingerprint,recordIdentity} from '../lib/s02-identity.js';
const digest=x=>createHash('sha256').update(x).digest('hex');
const source={kind:'chat',avatar:'Nina.png',chatFile:'one'};
const embedding={source:'transformers',model:'server-model',dimension:3,metric:'dot'};
async function fixture(run){
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'f09b3-'));
 try{
  const root=path.join(tmp,'alice'),vectors=path.join(root,'vectors'),chats=path.join(root,'chats'),characters=path.join(root,'characters');
  const worlds=path.join(root,'worlds'),groups=path.join(root,'groups'),groupChats=path.join(root,'groupChats');
  for(const p of [vectors,path.join(chats,'Nina'),characters,worlds,groups,groupChats])await fs.mkdir(p,{recursive:true,mode:0o700});
  await fs.chmod(vectors,0o700);await fs.writeFile(path.join(characters,'Nina.png'),'avatar');
  const write=async text=>fs.writeFile(path.join(chats,'Nina','one.jsonl'),[
   JSON.stringify({chat_metadata:{integrity:'copied'}}),
   JSON.stringify({name:'Nina',is_user:false,send_date:'1000',mes:text})].join('\n')+'\n');
  await write('hello');
  const req={user:{profile:{handle:'alice'},directories:{root,vectors,chats,characters,worlds,groups,groupChats}},
   s03:{userScopeId:'alice',vectorsPath:vectors},headers:{'x-vecthare-f09b3-pilot':'1'}};
  const first=await readAttestedChatSnapshot(req,source);
  const scope={userScopeId:'alice',collectionId:'chat_memory',type:'chat',sourceId:first.sourceId};
  const ident=collectionIdentity({backend:'qdrant',scope,embedding});
  const binding={backend:'qdrant',scope,embedding,collection:{key:ident.key,physicalName:ident.physicalName}};
  const body={backend:'qdrant',source,embedding,configId:'local',experimentalConsent:F09B3_CONSENT,
   sourceRevisionFingerprint:first.fileHash};
  const records=new Map(),calls=[];
  const adapter={
   getRecord:async plan=>records.get(plan.recordId)??null,
   insertRecord:async(plan,payload)=>{calls.push('insert');records.set(plan.recordId,{recordId:plan.recordId,physicalId:recordIdentity(scope,plan.recordId).physicalId,scope,revision:1,
    text:payload.text,textHash:contentFingerprint(payload.text),vector:payload.vector,vectorHash:digest(JSON.stringify(payload.vector)),metadataHash:digest('{}')});},
   updateRecord:async(plan,payload)=>{calls.push('update');records.set(plan.recordId,{recordId:plan.recordId,physicalId:recordIdentity(scope,plan.recordId).physicalId,scope,revision:plan.targetRevision,
    text:payload.text,textHash:contentFingerprint(payload.text),vector:payload.vector,vectorHash:digest(JSON.stringify(payload.vector)),metadataHash:digest('{}')});},
   deleteRecord:async()=>{throw Error('delete forbidden')}
  };
  let embeds=0;
  const deps={backendPool:{get:async()=>({_request:()=>{throw Error('unexpected qdrant call')}})},
   embed:async(provider,text,model)=>{embeds++;assert.equal(provider,'transformers');assert.equal(model,'server-model');assert.ok(['hello','edited'].includes(text));return [0.5,0.25,0.125];},
   readScoped:async(req,b,op)=>{assert.equal(op,'get');return records.get(b.recordId)??null;},
   bind:async()=>({binding}),verifyCollection:async()=>{},makeAdapter:()=>adapter};
  await run({req,body,deps,write,records,calls,first,scope,getEmbeds:()=>embeds});
 }finally{await fs.rm(tmp,{recursive:true,force:true});}
}
const response=()=>({statusCode:200,status(n){this.statusCode=n;return this;},json(obj){this.body=obj;return this;}});
test('F09b3 inserts verified saved-chat content, then updates the exact stable record after edit',()=>fixture(async({req,body,deps,write,records,calls,first})=>{
 const created=await executeF09b3Sync({...req,body},deps);
 assert.equal(created.status,'VERIFIED');assert.equal(created.applied,1);assert.equal(records.size,1);
 assert.deepEqual(calls,['insert']);assert.equal([...records.values()][0].text,'hello');
 const repeated=await executeF09b3Sync({...req,body},deps);
 assert.equal(repeated.status,'IN_SYNC');assert.deepEqual(calls,['insert']);
 await write('edited');
 const changed=await readAttestedChatSnapshot(req,source);
 const updated=await executeF09b3Sync({...req,body:{...body,sourceRevisionFingerprint:changed.fileHash}},deps);
 assert.equal(updated.status,'VERIFIED');assert.deepEqual(calls,['insert','update']);
 assert.equal([...records.values()][0].text,'edited');assert.equal([...records.values()][0].revision,2);
 assert.equal(changed.messages[0].recordId,first.messages[0].recordId);
}));
test('F09b3 refuses forged text/vector/owner, stale snapshot, webllm and missing pilot header without writing',()=>fixture(async({req,body,deps,write,calls})=>{
 for(const extra of [{text:'forged'},{vector:[1,2,3]},{recordId:'foo'},{ownerId:'other'},
   {physicalCollection:'secret'},{operationId:'arbitrary'},{source:{...source,filepath:'/tmp/secret'}}]){
  await assert.rejects(executeF09b3Sync({...req,body:{...body,...extra}},deps));
 }
 await assert.rejects(executeF09b3Sync({...req,body:{...body,embedding:{...embedding,source:'webllm'}}},deps));
 await assert.rejects(executeF09b3Sync({...req,headers:{},body},deps),e=>e.code==='F09B3_SAME_ORIGIN_REQUIRED');
 await write('edited');
 await assert.rejects(executeF09b3Sync({...req,body},deps),e=>e.code==='F09B3_SOURCE_CHANGED_OR_EMPTY');
 assert.equal(calls.length,0);
}));
test('F09b3 rejects a changed saved chat during embedding and prevents backend dispatch',()=>fixture(async({req,body,deps,write,calls})=>{
 deps.embed=async()=>{await write('edited');return [0.5,0.25,0.125]};
 await assert.rejects(executeF09b3Sync({...req,body},deps),e=>e.code==='F09B3_SOURCE_CHANGED');
 assert.equal(calls.length,0);
}));
test('F09b3 catches repeat operation UUID after ambiguous first response even if chat text changed',()=>fixture(async({req,body,deps,calls,write})=>{
 deps.makeAdapter=()=>({getRecord:async()=>null,insertRecord:async()=>{calls.push('uncertain');throw Error('timeout')},
  updateRecord:async()=>{},deleteRecord:async()=>{}});
 const first=await executeF09b3Sync({...req,body},deps);
 assert.equal(first.status,'UNCERTAIN');assert.equal(first.applied,0);assert.equal(first.retryable,false);
 await assert.rejects(executeF09b3Sync({...req,body},deps),e=>e.code==='F09B4_MANAGED_INTENT_BLOCKED');
 await write('edited');
 const changed=await readAttestedChatSnapshot(req,source);
 await assert.rejects(executeF09b3Sync({...req,body:{...body,sourceRevisionFingerprint:changed.fileHash}},deps),
  e=>e.code==='F09B4_MANAGED_INTENT_BLOCKED');
 assert.deepEqual(calls,['uncertain']);
}));
test('F09b3 route is explicitly guarded and returns no sensitive text or vector',()=>fixture(async({req,body,deps})=>{
 const handlers={};registerF09b3SyncRoutes({post:(path,h)=>handlers[path]=h},deps);
 const res=response();await handlers['/v2/workflows/chat-sync-pilot-apply']({...req,body},res);
 assert.equal(res.statusCode,200);assert.equal(res.body.success,true);
 assert.equal(res.body.productionWritesEnabled,false);assert.equal(res.body.automaticMutationsEnabled,false);
 assert.ok(!JSON.stringify(res.body).includes('hello'));
 const wrong=response();await handlers['/v2/workflows/chat-sync-pilot-apply']({...req,body:{...body,userScopeId:'bob'}},wrong);
 assert.equal(wrong.statusCode,403);assert.equal(wrong.body.success,false);
}));

for(const backend of ['lancedb','vectra','milvus'])test(`F09b3 applies exact one-record sync using ${backend} server-bound adapter contract`,()=>fixture(async({req,body,deps,records,calls,scope})=>{
 const collection=collectionIdentity({backend,scope,embedding});
 const binding={backend,scope,embedding,collection:{key:collection.key,physicalName:collection.physicalName}};
 deps.bind=async()=>({binding});
 const selected=[];
 deps.backendPool={get:async(ctx,name,config)=>{selected.push([name,config]);
  return backend==='lancedb'?{getDatabase:async()=>({name:'source-db'})}:
   backend==='milvus'?{config:{address:'127.0.0.1:19530'}}:{kind:backend};}};
 deps.createVectra=async()=>({index:{},s08ServerSchema:{}});
 const response=await executeF09b3Sync({...req,body:{...body,backend,configId:'default'}},deps);
 assert.equal(response.status,'VERIFIED');assert.equal(response.applied,1);
 assert.equal(records.size,1);assert.deepEqual(calls,['insert']);
 assert.equal(response.productionWritesEnabled,false);
 if(backend==='vectra')assert.equal(selected.length,0);
 else assert.deepEqual(selected,[[backend,'default']]);
}));

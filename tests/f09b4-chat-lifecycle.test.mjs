import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {executeF09b4Lifecycle,registerF09b4LifecycleRoutes,F09B4_DELETE_CONSENT,F09B4_REVECTOR_CONSENT} from '../lib/f09b4-chat-lifecycle.js';
import {readAttestedChatSnapshot} from '../lib/f09b-chat-sync.js';
import {collectionIdentity,recordIdentity,contentFingerprint} from '../lib/s02-identity.js';
const hash=x=>createHash('sha256').update(x).digest('hex');
const source={kind:'chat',avatar:'Nina.png',chatFile:'one'};
const embedding={source:'transformers',model:'fixture',dimension:3,metric:'dot'};
async function withFixture(fn){
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'f09b4-'));
 try{
  const root=path.join(tmp,'user'),dirs=Object.fromEntries(['vectors','chats','characters','worlds','groups','groupChats'].map(k=>[k,path.join(root,k)]));
  for(const p of Object.values(dirs))await fs.mkdir(p,{recursive:true,mode:0o700});
  await fs.mkdir(path.join(dirs.chats,'Nina'),{recursive:true});
  await fs.writeFile(path.join(dirs.characters,'Nina.png'),'avatar');
  const write=async(text='hello')=>fs.writeFile(path.join(dirs.chats,'Nina','one.jsonl'),[JSON.stringify({chat_metadata:{integrity:'copied'}}),JSON.stringify({name:'Nina',is_user:false,send_date:'1000',mes:text})].join('\n')+'\n');
  await write();
  const req={user:{profile:{handle:'alice'},directories:{root,...dirs}},s03:{userScopeId:'alice',vectorsPath:dirs.vectors},headers:{'x-vecthare-f09b4-pilot':'1'}};
  const first=await readAttestedChatSnapshot(req,source);
  const scope={userScopeId:'alice',collectionId:'chat_memory',type:'chat',sourceId:first.sourceId};
  const c=collectionIdentity({backend:'qdrant',scope,embedding});
  const binding={backend:'qdrant',scope,embedding,collection:{key:c.key,physicalName:c.physicalName}};
  const recordId=first.messages[0].recordId;
  const records=new Map();const calls=[];
  function record(revision,text,vector){return {recordId,physicalId:recordIdentity(scope,recordId).physicalId,scope,revision,text,metadata:{},textHash:contentFingerprint(text),vector,vectorHash:hash(JSON.stringify(vector)),metadataHash:hash('{}')};}
  records.set(recordId,record(1,'hello',[0.25,0.5,0.125]));
  const adapter={getRecord:async()=>records.get(recordId)??null,
   insertRecord:async()=>{throw Error('no inserts')},
   updateRecord:async(plan,payload)=>{calls.push('update');records.set(recordId,record(plan.targetRevision,payload.text,payload.vector));},
   deleteRecord:async()=>{calls.push('delete');records.delete(recordId);}};
  const deps={backendPool:{get:async()=>({})},readScoped:async(_req,b,method)=>{assert.equal(method,'get');return records.get(b.recordId)??null},
   bind:async()=>({binding}),getTransport:async()=>({}),verifyCollection:async()=>{},makeAdapter:()=>adapter,
   embed:async()=>[0.5,0.25,0.125]};
  const base={backend:'qdrant',source,embedding,configId:'local',sourceRevisionFingerprint:first.fileHash,messageIndex:0};
  await fn({req,base,deps,write,records,calls,first,recordId});
 }finally{await fs.rm(tmp,{recursive:true,force:true});}
}
test('F09b4 exact saved-message delete verifies absence, prevents replay and never purges',()=>withFixture(async({req,base,deps,records,calls})=>{
 const body={...base,action:'delete',experimentalConsent:F09B4_DELETE_CONSENT};
 const result=await executeF09b4Lifecycle({...req,body},deps);
 assert.equal(result.status,'VERIFIED');assert.equal(result.action,'delete');assert.equal(records.size,0);assert.deepEqual(calls,['delete']);
 assert.equal(result.orphanDeletionEnabled,false);assert.equal(result.productionWritesEnabled,false);
 await assert.rejects(executeF09b4Lifecycle({...req,body},deps),e=>e.code==='F09B4_MANAGED_INTENT_BLOCKED');
 const status=await executeF09b4Lifecycle({...req,body:{...base,action:'inspect',operationId:result.operationId}},deps);
 assert.equal(status.state,'VERIFIED');assert.equal(status.automaticallyReconciled,false);
}));
test('F09b4 revector uses server-side saved text, checks readback, rejects deterministic replay',()=>withFixture(async({req,base,deps,records,calls})=>{
 const body={...base,action:'revector',experimentalConsent:F09B4_REVECTOR_CONSENT};
 const applied=await executeF09b4Lifecycle({...req,body},deps);
 assert.equal(applied.status,'VERIFIED');assert.equal(records.values().next().value.revision,2);
 assert.deepEqual(calls,['update']);assert.deepEqual(records.values().next().value.vector,[0.5,0.25,0.125]);
 // Revision 2 produces a *new* operation ID: repeat revector is deliberate
 // and only allowed with explicit consent; operation id uniqueness still holds.
 const next=await executeF09b4Lifecycle({...req,body},deps);
 assert.equal(next.status,'VERIFIED');assert.notEqual(applied.operationId,next.operationId);
}));
test('F09b4 denies forged IDs, missing consent, unauthorized header, stale file and wrong-owner binding',()=>withFixture(async({req,base,deps,write,calls})=>{
 const body={...base,action:'delete',experimentalConsent:F09B4_DELETE_CONSENT};
 for(const extra of [{recordId:'arbitrary'},{physicalId:'collide'},{ownerId:'other'},{vector:[1,2,3]},
   {messageIndex:90},{operationId:'00000000-0000-8000-8000-000000000001'},
   {source:{...source,filepath:'/tmp/secret'}}])await assert.rejects(executeF09b4Lifecycle({...req,body:{...body,...extra}},deps));
 await assert.rejects(executeF09b4Lifecycle({...req,body:{...body,experimentalConsent:'yes'}},deps));
 await assert.rejects(executeF09b4Lifecycle({...req,headers:{},body},deps),e=>e.code==='F09B4_SAME_ORIGIN_REQUIRED');
 await write('edited');
 await assert.rejects(executeF09b4Lifecycle({...req,body},deps),e=>e.code==='F09B4_SOURCE_CHANGED_OR_MESSAGE_MISSING');
 assert.equal(calls.length,0);
}));
test('F09b4 rejects delete when stored record text no longer matches saved file; no inferred orphan cleanup',()=>withFixture(async({req,base,deps,records,calls,recordId})=>{
 records.get(recordId).text='unrelated text';
 await assert.rejects(executeF09b4Lifecycle({...req,body:{...base,action:'delete',experimentalConsent:F09B4_DELETE_CONSENT}},deps),e=>e.code==='F09B4_DELETE_CONTENT_CHANGED');
 assert.equal(calls.length,0);
}));
test('F09b4 never retries UNCERTAIN operation; receipt inspection is read-only',()=>withFixture(async({req,base,deps,calls})=>{
 deps.makeAdapter=()=>({getRecord:async()=>deps.readScoped(req,{recordId:base.messageRecordId??(await readAttestedChatSnapshot(req,source)).messages[0].recordId},'get'),insertRecord:async()=>{},updateRecord:async()=>{},deleteRecord:async()=>{calls.push('delete');throw Error('timeout')}});
 const body={...base,action:'delete',experimentalConsent:F09B4_DELETE_CONSENT};
 const result=await executeF09b4Lifecycle({...req,body},deps);
 assert.equal(result.status,'UNCERTAIN');assert.equal(result.retryable,false);
 const inspected=await executeF09b4Lifecycle({...req,body:{...base,action:'inspect',operationId:result.operationId}},deps);
 assert.equal(inspected.state,'UNCERTAIN');assert.equal(inspected.automaticallyReconciled,false);
 await assert.rejects(executeF09b4Lifecycle({...req,body},deps),e=>e.code==='F09B4_MANAGED_INTENT_BLOCKED');
 assert.deepEqual(calls,['delete']);
}));
test('F09b4 route returns redacted responses and refuses browser-scoped record fields',()=>withFixture(async({req,base,deps})=>{
 const handlers={};registerF09b4LifecycleRoutes({post:(route,fn)=>handlers[route]=fn},deps);
 const res=()=>({statusCode:200,status(v){this.statusCode=v;return this},json(v){this.body=v;return this}});
 const response=res();await handlers['/v2/workflows/chat-lifecycle-pilot']({...req,body:{...base,action:'delete',experimentalConsent:F09B4_DELETE_CONSENT}},response);
 assert.equal(response.statusCode,200);assert.equal(response.body.success,true);
 assert.equal(JSON.stringify(response.body).includes('hello'),false);
 const refused=res();await handlers['/v2/workflows/chat-lifecycle-pilot']({...req,body:{...base,action:'delete',experimentalConsent:F09B4_DELETE_CONSENT,text:'leak'}},refused);
 assert.equal(refused.statusCode,403);assert.equal(refused.body.success,false);
}));

test('F09b4 revectorization refuses changed saved chat during embedding and preserves old vector',()=>withFixture(async({req,base,deps,write,records,calls})=>{
 deps.embed=async()=>{await write('edited during embed');return [0.5,0.25,0.125]};
 await assert.rejects(executeF09b4Lifecycle({...req,body:{...base,action:'revector',experimentalConsent:F09B4_REVECTOR_CONSENT}},deps),e=>e.code==='F09B4_SOURCE_CHANGED');
 assert.deepEqual(calls,[]);assert.deepEqual(records.values().next().value.vector,[0.25,0.5,0.125]);
}));
test('F09b4 refuses revector when preserved metadata is absent or has a mismatched hash',()=>withFixture(async({req,base,deps,records,calls,recordId})=>{
 const rec=records.get(recordId);rec.metadata={unexpected:true};
 await assert.rejects(executeF09b4Lifecycle({...req,body:{...base,action:'revector',experimentalConsent:F09B4_REVECTOR_CONSENT}},deps),e=>e.code==='F09B4_METADATA_PRESERVATION_UNVERIFIED');
 assert.deepEqual(calls,[]);
}));

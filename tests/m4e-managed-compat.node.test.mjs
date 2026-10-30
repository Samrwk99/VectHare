import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {m4eVectorizeSavedSource,m4eSavedSource,m4eVectorizeCurrentChat} from '../utils/m4e-managed-vectorization.js';
const root=new URL('../',import.meta.url);
const source={kind:'chat',avatar:'Jane.png',chatFile:'saved-1'};
const id1=randomUUID(),id2=randomUUID(),logicalKey='b'.repeat(64),op=randomUUID();
const response=(data,status=200)=>({ok:status<400,status,async json(){return data;}});
const caps=['qdrant','lancedb','vectra','milvus'].flatMap(backend=>['insert','update','revectorize','delete'].map(operation=>({backend,operation,mode:'ENABLED',enabled:true})));
const makeFetch=({records=[{recordId:id1,availableActions:['insert'],managedState:'UNTRACKED',changed:false}],
  unprovisioned=false,fail='',track=[]}={})=>{
 let bound=!unprovisioned;
 return async (url,opts)=>{
  const route=url.replace('/api/plugins/similharity/v2','');
  const body=opts.body?JSON.parse(opts.body):{};
  track.push({route,body});
  if(route==='/m1/capabilities')return response({success:true,capabilities:caps});
  if(route==='/m1/records/preview')return bound?
   response({success:true,logicalKey,backend:body.backend,completeSavedSource:true,records}):
   response({success:false,code:'F02_COLLECTION_NOT_BOUND'},409);
  if(route==='/m1/collections/prepare')return response({success:true,plan:{logicalKey,operationId:op,action:'provision',requiresExplicitApply:true,executionAllowed:false}});
  if(route==='/m1/collections/provision'){bound=true;return response({success:true,backend:'qdrant',logicalKey,
   receiptState:'SCHEMA_VERIFIED_OFFLINE_UNCERTIFIED',productionWritesEnabled:false});}
  if(route.endsWith('/records/plan'))return response({success:true,plan:{logicalKey,operationId:op,recordId:body.recordId,action:body.action,requiresExplicitApply:true,executionAllowed:false}});
  if(route==='/mutations/execute')return fail==='lost'?
   response({success:false,code:'S04_UNCERTAIN'},409):response({success:true,operationId:op,state:'VERIFIED',retryable:false});
  throw Error('Unexpected route: '+route);
 };
};
for(const backend of ['qdrant','lancedb','vectra','milvus'])test(`M4e manual Sync Chat uses only M1/S04 for ${backend}`,async()=>{
 const calls=[];const f=makeFetch({track:calls});
 const result=await m4eVectorizeSavedSource({backend,source,fetchImpl:f,confirm:()=>true});
 assert.equal(result.status,'inserted');assert.equal(result.inserted,1);
 assert.deepEqual(calls.map(c=>c.route),['/m1/capabilities','/m1/records/preview',`/collections/${logicalKey}/records/plan`,'/mutations/execute']);
 for(const {route,body} of calls){
  assert.ok(!route.includes('/chunks/'));
  for(const forbidden of ['text','vector','vectors','ownerId','physicalName','databasePath','embedding'])assert.ok(!(forbidden in body),forbidden);
 }
});
test('M4e first-use collection receives its own separate explicit consent and no forged name',async()=>{
 const calls=[];let consent=0;
 const result=await m4eVectorizeSavedSource({backend:'qdrant',source,configId:'local',fetchImpl:makeFetch({unprovisioned:true,track:calls}),confirm:()=>{consent++;return true;}});
 assert.equal(consent,2);assert.equal(result.inserted,1);
 assert.ok(calls.some(c=>c.route==='/m1/collections/prepare'));
 assert.ok(calls.some(c=>c.route==='/m1/collections/provision'));
 assert.ok(calls.every(c=>!('physicalName' in c.body)));
});
test('M4e does not create collection on a general preview failure',async()=>{
 const calls=[];const f=async(url,init)=>{
  calls.push(url);
  if(url.endsWith('/m1/capabilities'))return response({success:true,capabilities:caps});
  return response({success:false,code:'M1_OWNER_UNVERIFIED'},409);
 };
 await assert.rejects(()=>m4eVectorizeSavedSource({backend:'qdrant',source,fetchImpl:f,confirm:()=>true}),/M1_OWNER_UNVERIFIED/);
 assert.equal(calls.length,2);
});
test('M4e stops on uncertain acknowledgement and never replays later records',async()=>{
 const calls=[];
 await assert.rejects(()=>m4eVectorizeSavedSource({backend:'qdrant',source,fetchImpl:makeFetch({track:calls,
  records:[{recordId:id1,availableActions:['insert'],managedState:'UNTRACKED'},
   {recordId:id2,availableActions:['insert'],managedState:'UNTRACKED'}],fail:'lost'}),confirm:()=>true}),/M4E_BATCH_STOPPED_AFTER_0_OF_2/);
 assert.equal(calls.filter(c=>c.route.endsWith('/records/plan')).length,1);
 assert.equal(calls.filter(c=>c.route==='/mutations/execute').length,1);
});
test('M4e repair updates changed managed records without inserting new ones',async()=>{
 const calls=[];const records=[{recordId:id1,availableActions:['update','revectorize'],managedState:'ACTIVE',changed:true},
  {recordId:id2,availableActions:['insert'],managedState:'UNTRACKED'}];
 const out=await m4eVectorizeSavedSource({backend:'vectra',source,fetchImpl:makeFetch({records,track:calls}),confirm:()=>true,mode:'repair'});
 assert.equal(out.inserted,1);assert.equal(calls.find(c=>c.route.endsWith('/records/plan')).body.action,'update');
});
test('M4e aborts when user switches saved source after preview',async()=>{
 const calls=[];let checks=0;
 await assert.rejects(()=>m4eVectorizeSavedSource({backend:'qdrant',source,fetchImpl:makeFetch({track:calls}),confirm:()=>true,
  checkSource:async()=>++checks>1?{...source,chatFile:'other-chat'}:source}),/SAVED_SOURCE_CHANGED_STOPPED/);
 assert.equal(calls.filter(c=>c.route==='/mutations/execute').length,0);
});
test('M4e uploaded text, untrusted content and incomplete previews are rejected',async()=>{
 assert.throws(()=>m4eSavedSource('chat',{type:'file',content:'FAKE'},{getChatId:()=> 'c'}),/IMPORT/);
 assert.throws(()=>m4eSavedSource('document',{type:'paste',content:'x'}),/SOURCE_REGISTRATION_REQUIRED/);
 await assert.rejects(()=>m4eVectorizeSavedSource({backend:'qdrant',source:{...source,text:'spoof'},fetchImpl:makeFetch(),confirm:()=>true}),/M4E_SOURCE_SELECTOR_INVALID/);
});
test('M4e real UI paths no longer route managed writes through the legacy insert/purge',()=>{
 const chat=readFileSync(new URL('../core/chat-vectorization.js',import.meta.url),'utf8');
 const content=readFileSync(new URL('../core/content-vectorization.js',import.meta.url),'utf8');
 const cv=readFileSync(new URL('../ui/content-vectorizer.js',import.meta.url),'utf8');
 assert.match(chat,/\['qdrant','lancedb','vectra','milvus'\]\.includes\(settings\?\.vector_backend\)/);
 assert.match(chat,/m4eVectorizeCurrentChat/);
 assert.match(content,/M4E_BACKENDS\.includes\(backend\)/);
 assert.match(content,/m4eSavedSource\(contentType,source/);
 assert.match(cv,/if\(!managedBackend\)/);
});
test('M4e Sync Chat runtime derives saved selector from SillyTavern and uses configured local Qdrant',async()=>{
 const calls=[];
 const result=await m4eVectorizeCurrentChat({vector_backend:'qdrant',qdrant_use_cloud:false},{
  getChatId:()=> 'saved-1',getContext:()=>({characterId:0,characters:[{avatar:'Jane.png'}]}),
  getHeaders:async()=>({'X-CSRF-Token':'test'}),fetchImpl:makeFetch({track:calls}),confirm:()=>true
 });
 assert.equal(result.inserted,1);
 const preview=calls.find(x=>x.route==='/m1/records/preview');
 assert.deepEqual(preview.body.source,source);
 assert.equal(preview.body.configId,'local');
});

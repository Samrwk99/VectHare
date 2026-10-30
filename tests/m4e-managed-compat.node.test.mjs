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
  if(route==='/m1/preflight')return response({success:true,configured:true,ready:true,connectionState:'VERIFIED',profile:{source:'llama_cpp',model:'fixture',dimension:3,metric:'cosine'}});
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
 assert.deepEqual(calls.map(c=>c.route),['/m1/preflight','/m1/capabilities','/m1/records/preview',`/collections/${logicalKey}/records/plan`,'/mutations/execute']);
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
  if(url.endsWith('/m1/preflight'))return response({success:true,configured:true,ready:true,profile:{source:'llama_cpp',model:'fixture',dimension:3,metric:'cosine'},connectionState:'VERIFIED'});
  if(url.endsWith('/m1/capabilities'))return response({success:true,capabilities:caps});
  return response({success:false,code:'M1_OWNER_UNVERIFIED'},409);
 };
 await assert.rejects(()=>m4eVectorizeSavedSource({backend:'qdrant',source,fetchImpl:f,confirm:()=>true}),/M1_OWNER_UNVERIFIED/);
 assert.equal(calls.length,3);
});
test('M4e stops on uncertain acknowledgement and never replays later records',async()=>{
 const calls=[];
 await assert.rejects(()=>m4eVectorizeSavedSource({backend:'qdrant',source,fetchImpl:makeFetch({track:calls,
  records:[{recordId:id1,availableActions:['insert'],managedState:'UNTRACKED'},
   {recordId:id2,availableActions:['insert'],managedState:'UNTRACKED'}],fail:'lost'}),confirm:()=>true}),/M4E_BATCH_STOPPED_AFTER_0_OF_2/);
 assert.equal(calls.filter(c=>c.route.endsWith('/records/plan')).length,1);
 assert.equal(calls.filter(c=>c.route==='/mutations/execute').length,1);
});
test('P05 repair updates changed managed records and inserts missing records',async()=>{
 const calls=[];const records=[{recordId:id1,availableActions:['update','revectorize'],managedState:'ACTIVE',physicalState:'VERIFIED',changed:true},
  {recordId:id2,availableActions:['insert'],managedState:'UNTRACKED',physicalState:'MISSING'}];
 const out=await m4eVectorizeSavedSource({backend:'vectra',source,fetchImpl:makeFetch({records,track:calls}),confirm:()=>true,mode:'repair'});
 assert.equal(out.inserted,2);assert.deepEqual(calls.filter(c=>c.route.endsWith('/records/plan')).map(c=>c.body.action),['update','insert']);
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

function pagedFetch({count=250,failAt=-1,mutateAt=-1,unverified=false,track=[]}={}){
 const records=Array.from({length:count},()=>({recordId:randomUUID(),availableActions:['insert'],managedState:'UNTRACKED'}));
 let applies=0;
 return async (url,opts={})=>{
  const route=url.replace('/api/plugins/similharity/v2','');
  const body=opts.body?JSON.parse(opts.body):{};
  track.push({route,body});
  if(route==='/m1/preflight')return response({success:true,configured:!unverified,ready:!unverified,profile:{source:'llama_cpp',model:'fixture',dimension:3,metric:'cosine'},connectionState:unverified?'NOT_CONFIGURED':'VERIFIED'});
  if(route==='/m1/capabilities')return response({success:true,capabilities:caps});
  if(route==='/m1/records/preview'){
   const offset=body.cursor?Number(Buffer.from(body.cursor.split('.')[0],'base64url').toString()):0;
   return response({success:true,backend:body.backend,logicalKey,fileFingerprint:offset>=mutateAt&&mutateAt>=0?'c'.repeat(64):'d'.repeat(64),
    totalRecords:count,offset,completeSavedSource:true,orphanReview:0,
    records:records.slice(offset,offset+50),nextCursor:offset+50<count?`${Buffer.from(String(offset+50)).toString('base64url')}.abc`:null});
  }
  if(route.endsWith('/records/plan'))return response({success:true,plan:{logicalKey,operationId:op,recordId:body.recordId,
   action:body.action,requiresExplicitApply:true,executionAllowed:false}});
  if(route==='/mutations/execute'){
   if(applies++===failAt)return response({success:false,code:'S04_UNCERTAIN'},409);
   return response({success:true,operationId:op,state:'VERIFIED',retryable:false});
  }
  throw Error(`Unexpected route ${route}`);
 };
}
test('P06 250 and 1000 saved records consume all server-issued cursor pages, no arbitrary offset',async()=>{
 for(const n of [250,1000]){
  const track=[];const progress=[];
  const result=await m4eVectorizeSavedSource({backend:'qdrant',source,fetchImpl:pagedFetch({count:n,track}),
   confirm:()=>true,progress:x=>progress.push(x)});
  assert.equal(result.inserted,n);assert.equal(result.processed,n);assert.equal(result.totalRecords,n);
  assert.equal(result.complete,true);assert.equal(result.previewBounded,false);
  assert.equal(track.filter(x=>x.route==='/m1/records/preview').length,n/50);
  assert.equal(track.filter(x=>x.route==='/mutations/execute').length,n);
  assert.ok(track.every(x=>!('offset' in x.body)&&!('vector' in x.body)&&!('text' in x.body)));
  assert.equal(progress.at(-1).processed,n);
 }
});
test('P01 preflight missing profile prevents capabilities, provision and any mutation',async()=>{
 const calls=[];
 await assert.rejects(()=>m4eVectorizeSavedSource({backend:'qdrant',source,
  fetchImpl:pagedFetch({unverified:true,track:calls}),confirm:()=>true}),/EMBEDDING_PROFILE_REQUIRED/);
 assert.deepEqual(calls.map(c=>c.route),['/m1/preflight']);
});
test('P06 source changes between pages stop after verified 50 and never report complete',async()=>{
 const calls=[];
 await assert.rejects(()=>m4eVectorizeSavedSource({backend:'vectra',source,fetchImpl:pagedFetch({count:250,mutateAt:50,track:calls}),
  confirm:()=>true}),/M4E_SOURCE_INVENTORY_CHANGED_STOPPED/);
 assert.equal(calls.filter(c=>c.route==='/mutations/execute').length,50);
});
test('P06 uncertain acknowledgement stops paginated batch and never dispatches a second mutation',async()=>{
 const calls=[];
 await assert.rejects(()=>m4eVectorizeSavedSource({backend:'vectra',source,fetchImpl:pagedFetch({count:250,failAt:3,track:calls}),
  confirm:()=>true}),/M4E_BATCH_STOPPED_AFTER_3_OF_250/);
 assert.equal(calls.filter(c=>c.route==='/mutations/execute').length,4);
 assert.equal(calls.filter(c=>c.route==='/m1/records/preview').length,1);
});
test('P06 abort stops before any further plan, no success claim',async()=>{
 const controller=new AbortController();let observed=0;const calls=[];
 await assert.rejects(()=>m4eVectorizeSavedSource({backend:'milvus',source,fetchImpl:pagedFetch({count:250,track:calls}),
  signal:controller.signal,confirm:()=>true,progress:()=>{if(++observed===7)controller.abort();}}),/USER_ABORTED/);
 assert.equal(calls.filter(c=>c.route==='/mutations/execute').length,7);
});
test('P05 direct repair export protects all managed backends before legacy getSavedHashes path',()=>{
 const src=readFileSync(new URL('../core/chat-vectorization.js',import.meta.url),'utf8');
 const start=src.indexOf('export async function repairChatVectors('),end=src.indexOf('let job = null;',start);
 const bridge=src.slice(start,end);
 assert.match(bridge,/M4E_BACKENDS\.includes\(settings\?\.vector_backend\)/);
 assert.match(bridge,/runManagedSavedChat\(settings,'repair'\)/);
 assert.doesNotMatch(bridge,/getSavedHashes|chunks\/delete/);
});

test('P-A.4 restart recovery re-reads durable managed states, skips verified records and refuses to replay an uncertain write',async()=>{
 const count=170,rows=Array.from({length:count},()=>randomUUID());
 const managed=new Map(),attempts=new Map(),calls=[];
 let interrupted=false;
 const restartable=async(url,opts={})=>{
  const route=url.replace('/api/plugins/similharity/v2','');
  const body=opts.body?JSON.parse(opts.body):{};
  calls.push({route,body});
  if(route==='/m1/preflight')return response({success:true,configured:true,ready:true,connectionState:'VERIFIED',profile:{source:'llama_cpp',model:'fixture',dimension:3,metric:'cosine'}});
  if(route==='/m1/capabilities')return response({success:true,capabilities:caps});
  if(route==='/m1/records/preview'){
   const offset=body.cursor?Number(Buffer.from(body.cursor.split('.')[0],'base64url').toString('utf8')):0;
   return response({success:true,logicalKey,backend:body.backend,completeSavedSource:true,totalRecords:count,offset,
    fileFingerprint:'f'.repeat(64),orphanReview:0,records:rows.slice(offset,offset+50).map(recordId=>{
     const state=managed.get(recordId)||'UNTRACKED';return {recordId,managedState:state,
      changed:false,availableActions:state==='UNTRACKED'?['insert']:state==='ACTIVE'?['update']:[]};
    }),nextCursor:offset+50<count?`${Buffer.from(String(offset+50)).toString('base64url')}.abc`:null});
  }
  if(route.endsWith('/records/plan')){
   const id=body.recordId;
   if(managed.has(id))throw Error('REPLAY_OF_PERSISTED_RECORD');
   attempts.set(id,(attempts.get(id)||0)+1);
   if(attempts.get(id)>1)throw Error('BLIND_RETRY');
   return response({success:true,plan:{logicalKey,operationId:op,recordId:id,action:body.action,requiresExplicitApply:true,executionAllowed:false}});
  }
  if(route==='/mutations/execute'){
   const id=[...attempts.keys()].at(-1);
   if(!interrupted&&attempts.size===75){
    interrupted=true;managed.set(id,'WRITE_PENDING');
    return response({success:false,code:'S04_UNCERTAIN'},409);
   }
   managed.set(id,'ACTIVE');return response({success:true,operationId:op,state:'VERIFIED',retryable:false});
  }
  throw Error('UNEXPECTED_ROUTE_'+route);
 };
 await assert.rejects(()=>m4eVectorizeSavedSource({backend:'qdrant',source,fetchImpl:restartable,confirm:()=>true}),/BATCH_STOPPED_AFTER_74_OF_170/);
 assert.equal([...managed.values()].filter(x=>x==='ACTIVE').length,74);
 assert.equal([...managed.values()].filter(x=>x==='WRITE_PENDING').length,1);
 // This is a fresh invocation, as after a restarted browser; the server's
 // persisted registry is authoritative rather than a browser-resume offset.
 const again=await m4eVectorizeSavedSource({backend:'qdrant',source,fetchImpl:restartable,confirm:()=>true});
 assert.equal(again.complete,true);assert.equal(again.totalRecords,count);
 assert.equal(again.inserted,95);assert.equal(again.skipped,75);assert.equal(again.remainingReview,1);
 assert.equal(again.status,'review-required');
 assert.equal(attempts.size,170-0); // 74 verified, one uncertain, 95 newly applied
 assert.ok([...attempts.values()].every(n=>n===1),'never replay a persisted or uncertain mutation');
 assert.equal(managed.get(rows[74]),'WRITE_PENDING');
 assert.equal([...managed.values()].filter(x=>x==='ACTIVE').length,169);
});

test('P-A.6 Repair regenerates verified physically missing ACTIVE record through managed repair-missing',async()=>{
 const calls=[];
 const records=[{recordId:id1,managedState:'ACTIVE',physicalState:'MISSING',changed:false,availableActions:['repair-missing']}];
 const result=await m4eVectorizeSavedSource({backend:'qdrant',source,fetchImpl:makeFetch({records,track:calls}),confirm:()=>true,mode:'repair'});
 assert.equal(result.complete,true);assert.equal(result.status,'inserted');assert.equal(result.remainingReview,0);
 assert.equal(result.inserted,1);assert.equal(result.repaired.missingRestored,1);
 assert.equal(calls.find(x=>x.route.endsWith('/records/plan')).body.action,'repair-missing');
 assert.equal(calls.filter(x=>x.route==='/mutations/execute').length,1);
 assert.equal(calls.find(x=>x.route==='/m1/records/preview').body.verifyPhysical,true);
});
test('P-A.5 Repair refuses registry-only ACTIVE rows without physical evidence',async()=>{
 const calls=[];
 const records=[{recordId:id1,managedState:'ACTIVE',changed:false,availableActions:['update']}];
 await assert.rejects(()=>m4eVectorizeSavedSource({backend:'vectra',source,
  fetchImpl:makeFetch({records,track:calls}),confirm:()=>true,mode:'repair'}),/M1_PREVIEW_RESPONSE_INVALID/);
 assert.equal(calls.filter(x=>x.route.endsWith('/records/plan')).length,0);
});
test('P-A.5 unchanged ACTIVE record counts healthy only when physically VERIFIED',async()=>{
 const calls=[];
 const records=[{recordId:id1,managedState:'ACTIVE',physicalState:'VERIFIED',changed:false,availableActions:['update']}];
 const result=await m4eVectorizeSavedSource({backend:'vectra',source,fetchImpl:makeFetch({records,track:calls}),confirm:()=>true,mode:'repair'});
 assert.equal(result.status,'no-new-records');assert.equal(result.remainingReview,0);
 assert.equal(calls.filter(x=>x.route.endsWith('/records/plan')).length,0);
});

test('P-A.6 Repair reconciles a proved registry-only discrepancy without claiming physical insert',async()=>{
 const calls=[];const records=[{recordId:id1,managedState:'UNTRACKED',physicalState:'VERIFIED',
  changed:false,availableActions:['repair-registry']}];
 const result=await m4eVectorizeSavedSource({backend:'qdrant',source,fetchImpl:makeFetch({records,track:calls}),confirm:()=>true,mode:'repair'});
 assert.equal(result.remainingReview,0);assert.equal(result.repaired.registryReconciled,1);
 assert.equal(calls.find(x=>x.route.endsWith('/records/plan')).body.action,'repair-registry');
});
test('P-A.6 conflicting ownership is review-only; unaffected records continue',async()=>{
 const calls=[];const records=[{recordId:id1,managedState:'ACTIVE',physicalState:'CONFLICT',
  changed:false,availableActions:[]},{recordId:id2,managedState:'UNTRACKED',physicalState:'MISSING',
  availableActions:['insert']}];
 const result=await m4eVectorizeSavedSource({backend:'qdrant',source,fetchImpl:makeFetch({records,track:calls}),confirm:()=>true,mode:'repair'});
 assert.equal(result.remainingReview,1);assert.equal(result.inserted,1);assert.equal(result.status,'review-required');
 assert.equal(calls.filter(x=>x.route.endsWith('/records/plan')).length,1);
});
test('P-A.6 disabled update cannot be smuggled by preview, while other safe records proceed',async()=>{
 const calls=[];const records=[
  {recordId:id1,managedState:'ACTIVE',physicalState:'VERIFIED',changed:true,availableActions:['update']},
  {recordId:id2,managedState:'UNTRACKED',physicalState:'MISSING',availableActions:['insert']}];
 const original=makeFetch({records,track:calls});
 const noUpdate=async(url,options)=>url.endsWith('/m1/capabilities')?
  response({success:true,capabilities:caps.map(c=>c.operation==='update'?{...c,enabled:false,mode:'BLOCKED'}:c)}):original(url,options);
 const out=await m4eVectorizeSavedSource({backend:'vectra',source,fetchImpl:noUpdate,mode:'repair',confirm:()=>true});
 assert.equal(out.inserted,1);assert.equal(out.remainingReview,1);
 assert.deepEqual(calls.filter(x=>x.route.endsWith('/records/plan')).map(x=>x.body.action),['insert']);
});

test('P-B.8 registry-only reconciliation works with update permission and insert blocked, without vector writes',async()=>{
 const calls=[],records=[
  {recordId:id1,managedState:'UNTRACKED',physicalState:'VERIFIED',changed:false,registryMismatch:true,availableActions:['repair-registry']},
  {recordId:id2,managedState:'ACTIVE',physicalState:'VERIFIED',changed:false,availableActions:['update']}];
 const base=makeFetch({records,track:calls});
 const updateOnly=async(url,opts)=>url.endsWith('/m1/capabilities')?
  response({success:true,capabilities:caps.map(c=>c.operation==='insert'?{...c,enabled:false,mode:'BLOCKED'}:c)}):base(url,opts);
 const result=await m4eVectorizeSavedSource({backend:'qdrant',source,mode:'registry',fetchImpl:updateOnly,confirm:()=>true});
 assert.equal(result.registryOnly,true);assert.equal(result.physicalCollectionInventoryVerified,false);
 assert.equal(result.repaired.registryReconciled,1);assert.equal(result.repaired.alreadyVerified,1);
 assert.equal(result.remainingReview,0);
 assert.deepEqual(calls.filter(x=>x.route.endsWith('/records/plan')).map(x=>x.body.action),['repair-registry']);
 assert.equal(calls.filter(x=>x.route==='/mutations/execute').length,1);
 assert.equal(calls.find(x=>x.route==='/m1/records/preview').body.verifyPhysical,true);
 assert.ok(!calls.some(x=>x.route.includes('collections/prepare')||x.route.includes('collections/provision')));
});
test('P-B.8 registry-only refuses disabled update, and cannot grant registry update with insert permission',async()=>{
 const calls=[],base=makeFetch({track:calls});
 const insertOnly=async(url,opts)=>url.endsWith('/m1/capabilities')?
  response({success:true,capabilities:caps.map(c=>c.operation==='update'?{...c,enabled:false,mode:'BLOCKED'}:c)}):base(url,opts);
 await assert.rejects(()=>m4eVectorizeSavedSource({backend:'qdrant',source,mode:'registry',fetchImpl:insertOnly,confirm:()=>true}),/PB8_REGISTRY_UPDATE_NOT_ENABLED/);
 assert.equal(calls.filter(x=>x.route.endsWith('/records/plan')).length,0);
});
test('P-B.8 registry-only never inserts missing records or updates stale content',async()=>{
 const calls=[];
 const records=[
  {recordId:id1,managedState:'UNTRACKED',physicalState:'MISSING',changed:false,availableActions:['insert']},
  {recordId:id2,managedState:'ACTIVE',physicalState:'VERIFIED',changed:true,availableActions:['update']}];
 const result=await m4eVectorizeSavedSource({backend:'milvus',source,mode:'registry',fetchImpl:makeFetch({records,track:calls}),confirm:()=>true});
 assert.equal(result.inserted,0);assert.equal(result.remainingReview,2);
 assert.equal(calls.filter(x=>x.route.endsWith('/records/plan')).length,0);
});
test('P-B.8 registry-only never creates a collection when one is unprovisioned',async()=>{
 const calls=[];
 await assert.rejects(()=>m4eVectorizeSavedSource({backend:'qdrant',source,mode:'registry',fetchImpl:makeFetch({track:calls,unprovisioned:true}),confirm:()=>true}),/F02_COLLECTION_NOT_BOUND/);
 assert.equal(calls.filter(x=>x.route.includes('/collections/')).length,0);
});
test('P-B.8 unknown receipt stops registry batch, no next plan/replay',async()=>{
 const calls=[],records=[{recordId:id1,managedState:'UNTRACKED',physicalState:'VERIFIED',changed:false,availableActions:['repair-registry']},
  {recordId:id2,managedState:'UNTRACKED',physicalState:'VERIFIED',changed:false,availableActions:['repair-registry']}];
 await assert.rejects(()=>m4eVectorizeSavedSource({backend:'vectra',source,mode:'registry',fetchImpl:makeFetch({records,track:calls,fail:'lost'}),confirm:()=>true}),/M4E_BATCH_STOPPED_AFTER_0_OF_2/);
 assert.equal(calls.filter(x=>x.route.endsWith('/records/plan')).length,1);
 assert.equal(calls.filter(x=>x.route==='/mutations/execute').length,1);
});
test('P-B.8 browser registry repair is exposed as an actual managed M1 action, not hash metadata',()=>{
 const content=readFileSync(new URL('../utils/pb1-saved-browser.js',import.meta.url),'utf8');
 assert.match(content,/m4eVectorizeSavedSource\(\{backend:chosenBackend,configId:chosenConfig/);
 assert.match(content,/mode:'registry'/);
 assert.match(content,/Reconcile verified server registry/);
});

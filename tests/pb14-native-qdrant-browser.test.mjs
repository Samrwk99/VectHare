import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {browsePB14NativeQdrant,registerPB14NativeRoutes} from '../lib/pb14-native-qdrant-browser.js';
import {collectionIdentity,recordIdentity,contentFingerprint} from '../lib/s02-identity.js';
const sha=x=>createHash('sha256').update(x).digest('hex');
const source={kind:'chat',avatar:'tester.png',chatFile:'saved.jsonl'};
const scope={userScopeId:'owner-1',collectionId:'chat1',type:'chat',sourceId:'saved-1'};
const embedding={source:'transformers',model:'test-model',dimension:3,metric:'cosine'};
const collection=collectionIdentity({backend:'qdrant',scope,embedding});
const binding={backend:'qdrant',authorized:true,provenance:'SERVER_VERIFIED',scope,embedding,collection};
const req=(cursor=null,overrides={})=>({s03:{userScopeId:scope.userScopeId},user:{directories:{}},
 body:{backend:'qdrant',source,...(cursor?{cursor}:{})},...overrides});
function fixture(n=111){
 const point=[],records={};let scanned=0;
 for(let i=0;i<n;i++){
  const rid=`00000000-0000-4000-8000-${i.toString(16).padStart(12,'0')}`;
  const {physicalId}=recordIdentity(scope,rid),text=`hello ${i}`,textHash=contentFingerprint(text);
  const metadata={vecthareRecordV2:{schemaVersion:2,recordId:rid,
   identity:{userScopeId:scope.userScopeId,sourceId:scope.sourceId},contentHash:textHash,revision:1}};
  point.push({id:physicalId,payload:{...scope,recordId:rid,physicalId,revision:1,text,textHash,
    metadata,metadataHash:sha(JSON.stringify(metadata)),embedding}});
  records[rid]={recordId:rid,revision:1,contentHash:textHash,state:'ACTIVE'};
 }
 point.sort((a,b)=>a.id.localeCompare(b.id));
 const managed={records,fingerprint:sha('registry')},snapshot={fileHash:sha('snapshot')};
 let nCalls=0;
 const transport={async _request(method,path,query){nCalls++;assert.equal(method,'POST');assert.equal(query.with_vector,false);
  const pos=query.offset?point.findIndex(p=>p.id===query.offset):0;
  const slice=point.slice(pos,pos+query.limit);
  return {result:{points:slice,next_page_offset:pos+query.limit<point.length?point[pos+query.limit].id:null}};
 }};
 const resolver=async()=>({binding,snapshot,managed,transport});
 const deps={resolveContext:resolver,recheck:resolver,schemaCheck:async()=>({schemaInspected:true}),
 ledgerCheckpoint:async()=>({digest:sha('ledger')})};
 return {deps,point,records,managed,transport,requests:()=>nCalls};
}
test('native Qdrant pages stream without full inventory scans and without false collection authority',async()=>{
 const f=fixture(119);let cursor=null,total=0;
 for(let p=0;p<3;p++){
  const r=await browsePB14NativeQdrant(req(cursor),f.deps);
  assert.equal(r.inventoryVerified,false);assert.equal(r.ownerVerified,false);
  assert.equal(r.physicalInventoryComplete,false);assert.equal(r.scopeVerified,true);
  assert.equal(r.records.length,[50,50,19][p]);
  total+=r.records.length;assert.equal(r.examined,total);cursor=r.nextCursor;
 }
 assert.equal(total,119);assert.equal(cursor,null);assert.equal(f.requests(),3);
});
test('>20,000 physical points page with bounded read size and without whole-collection proof',async()=>{
 const f=fixture(20051);let cursor=null,count=0,requests=0;
 while(true){const r=await browsePB14NativeQdrant(req(cursor),f.deps);
  assert.ok(r.records.length<=50);count+=r.records.length;requests++;
  if(!r.nextCursor)break;cursor=r.nextCursor;
 }
 assert.equal(count,20051);assert.equal(requests,402);assert.equal(f.requests(),402);
});
test('cursor cannot cross tenant, source or generation and is tamper resistant',async()=>{
 const f=fixture(80),first=await browsePB14NativeQdrant(req(),f.deps);
 await assert.rejects(()=>browsePB14NativeQdrant(req(first.nextCursor.slice(0,-2)+'xx'),f.deps),{code:'PB14_CURSOR_INVALID'});
 await assert.rejects(()=>browsePB14NativeQdrant(req(first.nextCursor,{s03:{userScopeId:'another'}}),f.deps),{code:'PB14_CONTEXT_UNVERIFIED'});
 await assert.rejects(()=>browsePB14NativeQdrant({...req(first.nextCursor),body:{backend:'qdrant',source:{...source,chatFile:'other.jsonl'},cursor:first.nextCursor}},f.deps),{code:'PB14_CURSOR_STALE'});
 const changed={...f.deps,resolveContext:async()=>({...await f.deps.resolveContext(),binding:{...binding,collection:{...collection,generation:1}}}),recheck:async()=>({...await f.deps.recheck(),binding:{...binding,collection:{...collection,generation:1}}})};
 await assert.rejects(()=>browsePB14NativeQdrant(req(first.nextCursor),changed),{code:'PB14_CURSOR_STALE'});
});
test('foreign, malformed and unregistered records fail closed rather than being skipped',async()=>{
 for(const mutation of [p=>p.payload.userScopeId='another',p=>p.payload.metadataHash='bogus',
  p=>p.payload.recordId=randomUUID(),p=>p.payload.metadata.vecthareRecordV2.recordId=randomUUID()]){
  const f=fixture(1);mutation(f.point[0]);
  await assert.rejects(()=>browsePB14NativeQdrant(req(),f.deps));
 }
});
test('no trusted context, bad selector, changing source and backend loops are refused',async()=>{
 const f=fixture(80);
 await assert.rejects(()=>browsePB14NativeQdrant(req(null,{s03:null}),f.deps),{code:'PB14_HOST_AUTH_REQUIRED'});
 await assert.rejects(()=>browsePB14NativeQdrant({...req(),body:{backend:'qdrant',source,physicalName:'forge'}},f.deps),{code:'PB14_SELECTOR_INVALID'});
 const changed={...f.deps,recheck:async()=>({...await f.deps.recheck(),snapshot:{fileHash:sha('new')}})};
 await assert.rejects(()=>browsePB14NativeQdrant(req(),changed),{code:'PB14_PAGE_STALE'});
 const loop={...f.deps,resolveContext:async()=>({...await f.deps.resolveContext(),transport:{_request:async()=>({result:{points:[],next_page_offset:randomUUID()}})}})};
 await assert.rejects(()=>browsePB14NativeQdrant(req(),loop),{code:'PB14_BACKEND_CURSOR_INVALID'});
});
test('route delivers explicitly unverified browser responses and sanitized errors',async()=>{
 const f=fixture(1),router={post(path,handler){this.path=path;this.handler=handler}};
 registerPB14NativeRoutes(router,f.deps);assert.equal(router.path,'/v2/pb14/qdrant/physical-page');
 const res={status(code){this.code=code;return this;},json(body){this.body=body}};
 await router.handler(req(),res);assert.equal(res.body.success,true);assert.equal(res.body.inventoryVerified,false);
 await router.handler(req(null,{s03:null}),res);assert.equal(res.code,403);assert.equal(res.body.success,false);
});

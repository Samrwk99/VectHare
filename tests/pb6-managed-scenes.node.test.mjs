import test from 'node:test';
import assert from 'node:assert/strict';
import {readManagedScenes,validateManagedScenesResponse,commitManagedSceneEdit,validateHostSceneDraft,sceneLocator} from '../utils/pb6-managed-scenes.js';
import {inspectVectorRequest} from '../utils/e02-vector-request-gateway.js';
const source={kind:'chat',avatar:'Alice.png',chatFile:'day1'};
const a={send_date:'1',name:'Alice',is_user:true,mes:'first'};
const b={send_date:'2',name:'Alice',is_user:true,mes:'second'};
const scene={id:'123e4567-e89b-42d3-a456-426614174000',start:sceneLocator(a),end:sceneLocator(b),title:'First scene'};
const evidence=(scenes=[],fileFingerprint='a'.repeat(64),sceneRevision='b'.repeat(64))=>({success:true,readOnly:true,sourceAuthoritative:true,
 storage:'SAVED_CHAT_METADATA',fileFingerprint,sceneRevision,scenes,messageCount:2,vectorSceneRecordsVerified:false});
test('P-B.6 read-only route permits exact owned selector and rejects vectors, paths, and payload edits',()=>{
 const url='/api/plugins/similharity/v2/pb6/scenes/read';
 const opts=b=>({method:'POST',body:JSON.stringify(b)});
 assert.equal(inspectVectorRequest(url,opts({source})).allowed,true);
 for(const b of [{source,scenes:[scene]},{source:{...source,filepath:'/tmp/x'}},{source:{kind:'lorebook',name:'x'}},{source,backend:'qdrant'}])
  assert.throws(()=>inspectVectorRequest(url,opts(b)),/VectHare safety gate/);
 assert.throws(()=>inspectVectorRequest(url,{method:'GET'}),/VectHare safety gate/);
});
test('P-B.6 saved metadata readback is distinct from verified physical scene vectors',async()=>{
 const result=await readManagedScenes({source,fetchImpl:async(url,options)=>{
  assert.deepEqual(JSON.parse(options.body),{source});return {ok:true,json:async()=>evidence([scene])};}});
 assert.deepEqual(result.scenes,[scene]);
 assert.throws(()=>validateManagedScenesResponse({...evidence(),vectorSceneRecordsVerified:true}),/UNVERIFIED/);
});
const fixture=()=>{
 const chat=[{...a},{...b}],metadata={vecthareManagedScenes:[]};
 let saved=0,postScenes=[],postHash='a'.repeat(64),postRev='b'.repeat(64);
 const context={chat,saveChat:async()=>{saved++;postScenes=metadata.vecthareManagedScenes;postHash='c'.repeat(64);postRev='d'.repeat(64);}};
 const original=evidence();
 const read=async()=>evidence(postScenes,postHash,postRev);
 const opts={source,context,chatMetadata:metadata,getCurrentSource:async()=>source,read,expected:original,scenes:[scene],confirm:async()=>true};
 return {opts,metadata,get saved(){return saved;}};
};
test('P-B.6 edits host metadata first, proves actual saved file readback, no DB mutation',async()=>{
 const f=fixture();validateHostSceneDraft([scene],f.opts.context.chat);
 const result=await commitManagedSceneEdit(f.opts);
 assert.equal(result.status,'VERIFIED_SAVED_METADATA');assert.equal(f.saved,1);
 assert.deepEqual(f.metadata.vecthareManagedScenes,[scene]);
});
test('P-B.6 stale source/revision or cancellation performs zero host writes',async()=>{
 for(const alteration of [
  f=>f.opts.getCurrentSource=async()=>({...source,chatFile:'other'}),
  f=>f.opts.expected={...f.opts.expected,fileFingerprint:'f'.repeat(64)},
  f=>f.metadata.vecthareManagedScenes=[scene],
 ]){const f=fixture();alteration(f);await assert.rejects(()=>commitManagedSceneEdit(f.opts),/PB6_/);assert.equal(f.saved,0);}
 const f=fixture();f.opts.confirm=async()=>false;
 assert.equal((await commitManagedSceneEdit(f.opts)).status,'CANCELLED');assert.equal(f.saved,0);
});
test('P-B.6 host-save errors are uncertain and readback failure never becomes success',async()=>{
 const f=fixture();f.opts.context.saveChat=async()=>{throw Error('host disconnected');};
 await assert.rejects(()=>commitManagedSceneEdit(f.opts),e=>e.sourceSaveUncertain===true);
 const g=fixture();g.opts.read=async()=>evidence();
 await assert.rejects(()=>commitManagedSceneEdit(g.opts),e=>e.saved===true&&/READBACK_UNVERIFIED/.test(e.message));
});
test('P-B.6 refuses overlapping or ambiguous host scenes before persistence',()=>{
 assert.throws(()=>validateHostSceneDraft([scene,scene],[a,b]),/PB6_SCENE_DRAFT_INVALID/);
 assert.throws(()=>validateHostSceneDraft([scene],[a,{...a},b]),/PB6_SCENE_BOUNDARY_AMBIGUOUS/);
 assert.throws(()=>validateHostSceneDraft([{...scene,end:scene.start}],[a,b]),/PB6_SCENE_RANGE_INVALID/);
});

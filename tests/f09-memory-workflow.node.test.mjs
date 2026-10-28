import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {inspectVectorRequest,VectorOperationDenied} from '../utils/e02-vector-request-gateway.js';
import {f09PreviewMemories,buildF09ReadOnlyCandidateView,renderF09MemoryPreview} from '../utils/f09-memory-workflow.js';
const url='/api/plugins/similharity/v2/workflows/preview';
const base={backend:'qdrant',source:{kind:'chat',avatar:'Nina.png',chatFile:'branch'},
 embedding:{source:'webllm',model:'fixed',dimension:3,metric:'cosine'},configId:'local',vector:[1,0,0],topK:4};
const record={recordId:randomUUID(),text:'valid scoped memory',revision:1,score:0.9};
const reply={success:true,scopeVerified:true,readOnly:true,completeInventory:false,automaticInjectionEnabled:false,
 productionWritesEnabled:false,recordIdentity:'V2_RECORD_UUID',legacyHashCompatible:false,candidates:[record]};
test('F09 gateway permits only scoped read preview and never grants write or owner spoof',()=>{
 assert.equal(inspectVectorRequest(url,{method:'POST',body:JSON.stringify(base)}).allowed,true);
 for(const b of [{...base,userScopeId:'victim'},{...base,physicalCollectionName:'old'},
  {...base,source:{...base.source,userScopeId:'victim'}},{...base,topK:200},
  {...base,embedding:{...base.embedding,apiKey:'secret'}}])
  assert.throws(()=>inspectVectorRequest(url,{method:'POST',body:JSON.stringify(b)}),VectorOperationDenied);
 assert.throws(()=>inspectVectorRequest(url,{method:'GET'}),VectorOperationDenied);
});
test('F09 client refuses overclaimed capabilities and malformed v2 record IDs',async()=>{
 let called;const result=await f09PreviewMemories(base,{'X-CSRF-Token':'test'},async(url,opts)=>{
  called={url,opts};return {ok:true,status:200,json:async()=>reply};
 });
 assert.equal(called.url,url);assert.equal(called.opts.credentials,'same-origin');
 assert.equal(result[0].recordId,record.recordId);
 for(const changed of [{productionWritesEnabled:true},{automaticInjectionEnabled:true},{completeInventory:true},
   {recordIdentity:'HASH_ONLY'},{candidates:[{...record,recordId:'123'}]}])
  await assert.rejects(()=>f09PreviewMemories(base,{},async()=>({ok:true,json:async()=>({...reply,...changed})})),/F09_RESPONSE_CAPABILITY_UNVERIFIED|F09_RECORD_UNVERIFIED/);
});
test('F09 read-only preview respects budget and does not invent hash IDs',()=>{
 const output=buildF09ReadOnlyCandidateView([record],{maxCharacters:8,limit:1});
 assert.equal(output.items[0].text,'valid sc');assert.equal(output.items[0].previewTruncated,true);
 assert.equal(output.injectionReady,false);assert.ok(!('hash' in output.items[0]));
 assert.throws(()=>buildF09ReadOnlyCandidateView([record,record]),/F09_PREVIEW_RECORD_UNVERIFIED/);
});
test('F09 GUI is inert until a human explicitly requests read-only preview',()=>{
 const events=[];
 const doc={createElement:tag=>({tag,append(){},addEventListener(name){events.push(name);},setAttribute(){}})};
 const root={querySelector:()=>null,prepend(){}};
 assert.equal(renderF09MemoryPreview(root,()=>({}),doc),true);
 assert.ok(events.includes('click'));
});

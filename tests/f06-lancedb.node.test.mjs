import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectVectorRequest,VectorOperationDenied} from '../utils/e02-vector-request-gateway.js';
import {F06_ACCEPTANCE_CONSENT,runF06LanceAcceptance,renderF06LanceAcceptance} from '../utils/f06-lancedb-acceptance.js';
const url='/api/plugins/similharity/v2/diagnostics/lancedb-f06';
test('F06 browser gate allows only fixed disposable LanceDB diagnostic request',()=>{
 assert.equal(inspectVectorRequest(url,{method:'POST',body:JSON.stringify({consent:F06_ACCEPTANCE_CONSENT})}).allowed,true);
 for(const body of [{consent:'yes'},{consent:F06_ACCEPTANCE_CONSENT,path:'/user/data'},
  {consent:F06_ACCEPTANCE_CONSENT,collectionName:'arbitrary'}]){
  assert.throws(()=>inspectVectorRequest(url,{method:'POST',body:JSON.stringify(body)}),VectorOperationDenied);
 }
 assert.throws(()=>inspectVectorRequest(url,{method:'GET'}),VectorOperationDenied);
 assert.throws(()=>inspectVectorRequest('/api/plugins/similharity/v2/records/insert',{method:'POST',body:'{}'}),VectorOperationDenied);
});
test('F06 GUI sends only a fixed consent field; server creates paths, source and vectors',async()=>{
 const result=await runF06LanceAcceptance({'X-CSRF-Token':'test'},async(u,opts)=>{
  assert.equal(u,url);assert.equal(opts.method,'POST');assert.deepEqual(JSON.parse(opts.body),{consent:F06_ACCEPTANCE_CONSENT});
  assert.equal(opts.headers['x-vecthare-f06-diagnostic'],'1');assert.equal(opts.credentials,'same-origin');
  return {ok:true,json:async()=>({success:true,productionWritesEnabled:false,backendCertified:false,
   acceptance:'F06_DISPOSABLE_CONTRACT_PASS',externalWriterIsolationVerified:false,restartPersistenceVerified:false,
   stages:Array.from({length:11},(_,i)=>({stage:`test${i}`,status:'PASS'}))})};
 });assert.equal(result.success,true);
});
test('F06 rejects false success and production capability claims',async()=>{
 const response=overrides=>async()=>({ok:true,json:async()=>({success:true,productionWritesEnabled:false,backendCertified:false,
  acceptance:'F06_DISPOSABLE_CONTRACT_PASS',externalWriterIsolationVerified:false,restartPersistenceVerified:false,
  stages:Array.from({length:11},()=>({status:'PASS'})),...overrides})});
 await assert.rejects(()=>runF06LanceAcceptance({},response({productionWritesEnabled:true})),/F06_CAPABILITY_OVERCLAIM/);
 await assert.rejects(()=>runF06LanceAcceptance({},response({restartPersistenceVerified:true})),/F06_EVIDENCE_INVALID/);
});
test('F06 GUI remains opt-in; no automatic LanceDB mutation at render',()=>{
 let count=0;const doc={createElement:()=>({append(){},prepend(){},addEventListener(){count++},setAttribute(){}})};
 assert.equal(renderF06LanceAcceptance({querySelector:()=>null,prepend(){}},doc),true);assert.equal(count,1);
});
test('F03 LanceDB v2 provision request accepted only with source-bound consent',()=>{
 const b={backend:'lancedb',source:{kind:'chat',avatar:'x.png',chatFile:'test'},
  embedding:{source:'transformers',model:'test',dimension:3,metric:'dot'},configId:'default',
  confirmProvision:true,expectedCollectionName:'vh2_'+'a'.repeat(48)};
 assert.equal(inspectVectorRequest('/api/plugins/similharity/v2/collections/provision',{method:'POST',body:JSON.stringify(b)}).allowed,true);
 assert.throws(()=>inspectVectorRequest('/api/plugins/similharity/v2/collections/provision',
  {method:'POST',body:JSON.stringify({...b,userScopeId:'mallory'})}),VectorOperationDenied);
});
import {randomUUID} from 'node:crypto';
import {f06PilotMutation,renderF06PilotPanel,F06_PILOT_CONSENT} from '../utils/f06-lancedb-pilot-client.js';
const PILOT='/api/plugins/similharity/v2/records/lancedb-pilot-mutate';
const request={backend:'lancedb',configId:'default',source:{kind:'chat',avatar:'hero.png',chatFile:'test'},
 embedding:{source:'transformers',model:'model',dimension:3,metric:'dot'},action:'insert',
 recordId:randomUUID(),operationId:randomUUID(),expectedRevision:0,
 experimentalConsent:F06_PILOT_CONSENT,text:'record',vector:[.25,.5,.75]};
test('F06 LanceDB pilot gateway refuses client scope, wrong backend and missing consent',()=>{
 assert.equal(inspectVectorRequest(PILOT,{method:'POST',body:JSON.stringify(request)}).allowed,true);
 for(const b of [{...request,collectionName:'valuable'}, {...request,userScopeId:'someone'},
  {...request,backend:'qdrant'},{...request,configId:'local'},{...request,experimentalConsent:false},
  {...request,recordId:'not-uuid'},{...request,action:'delete',vector:[1,2,3]},
  {...request,source:{...request.source,userScopeId:'other'}}]){
  assert.throws(()=>inspectVectorRequest(PILOT,{method:'POST',body:JSON.stringify(b)}),VectorOperationDenied);
 }
});
test('F06 LanceDB pilot validates verified receipt identity and never returns production permission',async()=>{
 let sent=0;const valid={success:true,state:'VERIFIED',recordId:request.recordId,operationId:request.operationId,
  productionWritesEnabled:false,experimental:true,retryable:false,targetRevision:1};
 const result=await f06PilotMutation(request,{},async(u,o)=>{sent++;
  assert.equal(u,PILOT);assert.equal(o.headers['x-vecthare-f06-pilot'],'1');
  assert.equal(o.credentials,'same-origin');return {ok:true,status:200,json:async()=>valid};});
 assert.equal(result.state,'VERIFIED');assert.equal(sent,1);
 await assert.rejects(()=>f06PilotMutation(request,{},async()=>({ok:true,status:200,json:async()=>({...valid,productionWritesEnabled:true})})),/F06_RESPONSE_CONTRACT_INVALID/);
 await assert.rejects(()=>f06PilotMutation(request,{},async()=>({ok:true,status:200,json:async()=>({...valid,recordId:randomUUID()})})),/F06_RESULT_ID_MISMATCH/);
});
test('F06 manual pilot GUI renders without automatic mutation',()=>{
 let count=0;const doc={createElement(tag){const obj={tag,children:[],setAttribute(){},addEventListener(){},append(...n){this.children.push(...n);}};count++;return obj;}};
 assert.equal(renderF06PilotPanel({querySelector:()=>null,prepend(){}},()=>({}),doc),true);assert.ok(count>=12);
});

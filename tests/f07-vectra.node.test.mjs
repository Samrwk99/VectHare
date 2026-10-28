import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {inspectVectorRequest,VectorOperationDenied} from '../utils/e02-vector-request-gateway.js';
import {F07_ACCEPTANCE_CONSENT,runF07VectraAcceptance,renderF07VectraAcceptance} from '../utils/f07-vectra-acceptance.js';
import {F07_PILOT_CONSENT,f07PilotMutation,renderF07PilotPanel} from '../utils/f07-vectra-pilot-client.js';
const ACCEPT='/api/plugins/similharity/v2/diagnostics/vectra-f07';
const PILOT='/api/plugins/similharity/v2/records/vectra-pilot-mutate';
const request={backend:'vectra',configId:'default',source:{kind:'chat',avatar:'hero.png',chatFile:'test'},
 embedding:{source:'transformers',model:'model',dimension:3,metric:'dot'},action:'insert',
 recordId:randomUUID(),operationId:randomUUID(),expectedRevision:0,
 experimentalConsent:F07_PILOT_CONSENT,text:'record',vector:[.25,.5,.75]};
test('F07 browser gate allows fixed disposable test only, not arbitrary path or collection',()=>{
 assert.equal(inspectVectorRequest(ACCEPT,{method:'POST',body:JSON.stringify({consent:F07_ACCEPTANCE_CONSENT})}).allowed,true);
 for(const body of [{consent:'yes'},{consent:F07_ACCEPTANCE_CONSENT,path:'/tmp/legacy'},{consent:F07_ACCEPTANCE_CONSENT,collectionName:'other'}])
  assert.throws(()=>inspectVectorRequest(ACCEPT,{method:'POST',body:JSON.stringify(body)}),VectorOperationDenied);
 assert.throws(()=>inspectVectorRequest(ACCEPT,{method:'GET'}),VectorOperationDenied);
});
test('F07 GUI requests disposable test with no client-selected path and rejects overstated certification',async()=>{
 const value={success:true,productionWritesEnabled:false,backendCertified:false,nativeStandardCertified:false,
  acceptance:'F07_DISPOSABLE_CONTRACT_PASS',externalWriterIsolationVerified:false,restartPersistenceVerified:false,
  stages:Array.from({length:11},()=>({status:'PASS'}))};
 const good=async(u,opts)=>{assert.equal(u,ACCEPT);assert.deepEqual(JSON.parse(opts.body),{consent:F07_ACCEPTANCE_CONSENT});
  assert.equal(opts.headers['x-vecthare-f07-diagnostic'],'1');return {ok:true,json:async()=>value};};
 assert.equal((await runF07VectraAcceptance({},good)).success,true);
 await assert.rejects(()=>runF07VectraAcceptance({},async()=>({ok:true,json:async()=>({...value,nativeStandardCertified:true})})),/F07_CAPABILITY_OVERCLAIM/);
});
test('F07 pilot excludes client-supplied owners and physical identifiers',()=>{
 assert.equal(inspectVectorRequest(PILOT,{method:'POST',body:JSON.stringify(request)}).allowed,true);
 for(const body of [{...request,collectionName:'legacy'}, {...request,userScopeId:'userB'},
  {...request,backend:'standard'}, {...request,configId:'local'}, {...request,experimentalConsent:'yes'},
  {...request,recordId:'x'}, {...request,action:'delete',vector:[.25,.5,.75]},
  {...request,source:{...request.source,userScopeId:'wrong'}}])
  assert.throws(()=>inspectVectorRequest(PILOT,{method:'POST',body:JSON.stringify(body)}),VectorOperationDenied);
});
test('F07 manual pilot returns only verified success or explicit uncertain; never activates production',async()=>{
 const result={success:true,state:'VERIFIED',recordId:request.recordId,operationId:request.operationId,
  productionWritesEnabled:false,experimental:true,retryable:false,targetRevision:1};
 assert.equal((await f07PilotMutation(request,{},async(u,o)=>{
  assert.equal(u,PILOT);assert.equal(o.headers['x-vecthare-f07-pilot'],'1');
  return {ok:true,status:200,json:async()=>result};})).state,'VERIFIED');
 await assert.rejects(()=>f07PilotMutation(request,{},async()=>({ok:true,status:200,json:async()=>({...result,productionWritesEnabled:true})})),/F07_RESPONSE_CONTRACT_INVALID/);
});
test('F07 panels render without dispatching any mutation or diagnostic',()=>{
 const doc={createElement:tag=>({tag,append(){},addEventListener(){},setAttribute(){}})};
 assert.equal(renderF07VectraAcceptance({querySelector:()=>null,prepend(){}},doc),true);
 assert.equal(renderF07PilotPanel({querySelector:()=>null,prepend(){}},()=>({}),doc),true);
});
test('F07 F03 provisioning gateway accepts plugin Vectra but native Standard stays blocked',()=>{
 const payload={backend:'vectra',configId:'default',source:request.source,embedding:request.embedding,
  confirmProvision:true,expectedCollectionName:'vh2_'+'a'.repeat(48)};
 assert.equal(inspectVectorRequest('/api/plugins/similharity/v2/collections/provision',{method:'POST',body:JSON.stringify(payload)}).allowed,true);
 assert.throws(()=>inspectVectorRequest('/api/vector/insert',{method:'POST',body:JSON.stringify({collectionId:'anything',items:[]})}),VectorOperationDenied);
});

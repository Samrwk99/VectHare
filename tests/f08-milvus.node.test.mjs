import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {inspectVectorRequest,VectorOperationDenied} from '../utils/e02-vector-request-gateway.js';
import {F08_ACCEPTANCE_CONSENT,runF08MilvusAcceptance,renderF08MilvusAcceptance} from '../utils/f08-milvus-acceptance.js';
import {F08_PILOT_CONSENT,f08PilotMutation,renderF08PilotPanel} from '../utils/f08-milvus-pilot-client.js';
const ACCEPT='/api/plugins/similharity/v2/diagnostics/milvus-f08';
const PILOT='/api/plugins/similharity/v2/records/milvus-pilot-mutate';
const req={backend:'milvus',configId:'default',source:{kind:'chat',avatar:'hero.png',chatFile:'test'},
 embedding:{source:'transformers',model:'model',dimension:4,metric:'cosine'},action:'insert',
 recordId:randomUUID(),operationId:randomUUID(),expectedRevision:0,
 experimentalConsent:F08_PILOT_CONSENT,text:'record',vector:[.5,.25,.125,.0625]};
test('F08 gateway permits fixed Milvus diagnostic and rejects client collection nomination',()=>{
 assert.equal(inspectVectorRequest(ACCEPT,{method:'POST',body:JSON.stringify({configId:'default',consent:F08_ACCEPTANCE_CONSENT})}).allowed,true);
 for(const b of [{consent:F08_ACCEPTANCE_CONSENT,configId:'local'},
  {consent:F08_ACCEPTANCE_CONSENT,configId:'default',collectionName:'legacy'},{configId:'default',consent:'yes'}])
  assert.throws(()=>inspectVectorRequest(ACCEPT,{method:'POST',body:JSON.stringify(b)}),VectorOperationDenied);
});
test('F08 GUI validates diagnostic results and rejects capability overclaims',async()=>{
 const data={success:true,productionWritesEnabled:false,backendCertified:false,
  acceptance:'F08_DISPOSABLE_CONTRACT_PASS',externalWriterIsolationVerified:false,restartPersistenceVerified:false,
  stages:Array.from({length:11},()=>({status:'PASS'}))};
 assert.equal((await runF08MilvusAcceptance({},async(url,options)=>{
  assert.equal(url,ACCEPT);assert.equal(options.headers['x-vecthare-f08-diagnostic'],'1');
  assert.deepEqual(JSON.parse(options.body),{configId:'default',consent:F08_ACCEPTANCE_CONSENT});
  return {ok:true,json:async()=>data};})).success,true);
 await assert.rejects(()=>runF08MilvusAcceptance({},async()=>({ok:true,json:async()=>({...data,backendCertified:true})})),/F08_CAPABILITY_OVERCLAIM/);
});
test('F08 pilot only accepts source-bound record operations',()=>{
 assert.equal(inspectVectorRequest(PILOT,{method:'POST',body:JSON.stringify(req)}).allowed,true);
 for(const b of [{...req,collectionName:'legacy'},{...req,userScopeId:'victim'},
  {...req,source:{...req.source,userScopeId:'victim'}},{...req,configId:'local'},
  {...req,experimentalConsent:'no'}, {...req,operationId:'bad'},
  {...req,action:'delete',vector:[.5]}, {...req,action:'update',expectedRevision:0}])
  assert.throws(()=>inspectVectorRequest(PILOT,{method:'POST',body:JSON.stringify(b)}),VectorOperationDenied);
});
test('F08 pilot response only allows VERIFIED/UNCERTAIN without production permissions',async()=>{
 const response={success:true,state:'VERIFIED',recordId:req.recordId,operationId:req.operationId,
  targetRevision:1,productionWritesEnabled:false,experimental:true,retryable:false};
 assert.equal((await f08PilotMutation(req,{},async(url,o)=>{
  assert.equal(url,PILOT);assert.equal(o.headers['x-vecthare-f08-pilot'],'1');
  return {ok:true,status:200,json:async()=>response};})).state,'VERIFIED');
 await assert.rejects(()=>f08PilotMutation(req,{},async()=>({ok:true,status:200,json:async()=>({...response,productionWritesEnabled:true})})),/F08_RESPONSE_CONTRACT_INVALID/);
});
test('F08 GUI panels are inert until explicit button action',()=>{
 const doc={createElement:tag=>({tag,append(){},addEventListener(){},setAttribute(){}})};
 assert.equal(renderF08MilvusAcceptance({querySelector:()=>null,prepend(){}},doc),true);
 assert.equal(renderF08PilotPanel({querySelector:()=>null,prepend(){}},()=>({}),doc),true);
});

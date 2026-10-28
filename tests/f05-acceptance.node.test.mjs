import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectVectorRequest,VectorOperationDenied} from '../utils/e02-vector-request-gateway.js';
import {runF05QdrantAcceptance,renderF05QdrantAcceptance,F05_ACCEPTANCE_CONSENT} from '../utils/f05-acceptance-client.js';
const url='/api/plugins/similharity/v2/diagnostics/qdrant-f05';
const body={configId:'local',consent:F05_ACCEPTANCE_CONSENT};
test('F05 gateway accepts only fixed explicitly consented local disposable diagnostic',()=>{
 assert.equal(inspectVectorRequest(url,{method:'POST',body:JSON.stringify(body)}).allowed,true);
 for(const bad of [{...body,configId:'default'},{...body,collectionName:'valuable'},
   {...body,apiKey:'secret'},{...body,consent:'yes'}]){
  assert.throws(()=>inspectVectorRequest(url,{method:'POST',body:JSON.stringify(bad)}),VectorOperationDenied);
 }
 assert.throws(()=>inspectVectorRequest(url,{method:'GET'}),VectorOperationDenied);
 assert.throws(()=>inspectVectorRequest('/api/plugins/similharity/v2/records/insert',
   {method:'POST',body:'{}'}),VectorOperationDenied);
});
test('F05 sends no secrets, source identity, or client-selected collection',async()=>{
 const result=await runF05QdrantAcceptance({'X-CSRF-Token':'ok'},async(u,opts)=>{
  assert.equal(u,url);assert.equal(opts.method,'POST');
  assert.deepEqual(JSON.parse(opts.body),body);
  assert.equal(opts.credentials,'same-origin');assert.equal(opts.headers['x-vecthare-f05-diagnostic'],'1');
  return {ok:true,json:async()=>({success:true,acceptance:'F05_DISPOSABLE_CONTRACT_PASS',
   productionWritesEnabled:false,externalWriterIsolationVerified:false,
   stages:Array.from({length:11},(_,i)=>({stage:'check'+i,status:'PASS'}))})};
 });
 assert.equal(result.success,true);
});
test('F05 rejects self-reported production enablement and false success',async()=>{
 const fetch=extra=>async()=>({ok:true,json:async()=>({success:true,acceptance:'F05_DISPOSABLE_CONTRACT_PASS',
   productionWritesEnabled:false,externalWriterIsolationVerified:false,
   stages:Array.from({length:11},()=>({status:'PASS'})),...extra})});
 await assert.rejects(()=>runF05QdrantAcceptance({},fetch({productionWritesEnabled:true})),/F05_RESPONSE_CONTRACT_INVALID/);
 await assert.rejects(()=>runF05QdrantAcceptance({},fetch({externalWriterIsolationVerified:true})),/F05_ACCEPTANCE_EVIDENCE_INVALID/);
});
test('F05 GUI clearly requires click, does not silently dispatch',()=>{
 let count=0;const make=()=>({append(){},prepend(){},addEventListener(){count++;},setAttribute(){},textContent:''});
 const doc={createElement:make},root={querySelector:()=>null,prepend(){}};
 assert.equal(renderF05QdrantAcceptance(root,doc),true);assert.equal(count,1);
});

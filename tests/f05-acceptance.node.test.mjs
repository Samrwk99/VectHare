import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectVectorRequest,VectorOperationDenied} from '../utils/e02-vector-request-gateway.js';
import {runF05QdrantAcceptance,renderF05QdrantAcceptance,F05_ACCEPTANCE_CONSENT} from '../utils/f05-acceptance-client.js';
const url='/api/plugins/similharity/v2/diagnostics/qdrant-f05';
const body={configId:'local',consent:F05_ACCEPTANCE_CONSENT};
test('M0 F05 diagnostics are not a trusted record mutation gateway',()=>{
 for(const payload of [body,{...body,apiKey:'secret'}])
  assert.throws(()=>inspectVectorRequest(url,{method:'POST',body:JSON.stringify(payload)}),VectorOperationDenied);
});
test('M0 F05 diagnostic cannot dispatch an old synthetic mutation',async()=>{
 let calls=0;await assert.rejects(()=>runF05QdrantAcceptance({},async()=>{calls++;return {ok:true};}),VectorOperationDenied);
 assert.equal(calls,0);
});
test('M0 F05 cannot accept fake production status because gateway blocks the request',async()=>{
 await assert.rejects(()=>runF05QdrantAcceptance({},async()=>({ok:true,json:async()=>({success:true,productionWritesEnabled:true})})),VectorOperationDenied);
});
test('F05 GUI clearly requires click, does not silently dispatch',()=>{
 let count=0;const make=()=>({append(){},prepend(){},addEventListener(){count++;},setAttribute(){},textContent:''});
 const doc={createElement:make},root={querySelector:()=>null,prepend(){}};
 assert.equal(renderF05QdrantAcceptance(root,doc),true);assert.equal(count,1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectVectorRequest,VectorOperationDenied} from '../utils/e02-vector-request-gateway.js';
import {runH01QdrantAcceptance} from '../utils/s11-plugin-compatibility.js';
const route='/api/plugins/similharity/v2/diagnostics/qdrant-contract';
test('M0 H01 synthetic Qdrant writer is blocked alongside normal mutations',()=>{
 for(const body of [{configId:'local',confirmDisposable:true},{configId:'remote',confirmDisposable:true}])
  assert.throws(()=>inspectVectorRequest(route,{method:'POST',body:JSON.stringify(body)}),VectorOperationDenied);
 assert.throws(()=>inspectVectorRequest('/api/plugins/similharity/v2/records/insert',{method:'POST',body:'{}'}),VectorOperationDenied);
});
test('M0 H01 diagnostic client cannot dispatch any mutation',async()=>{
 let calls=0;await assert.rejects(()=>runH01QdrantAcceptance('local',{},async()=>{calls++;return {ok:true};}),VectorOperationDenied);
 assert.equal(calls,0);
 await assert.rejects(()=>runH01QdrantAcceptance('arbitrary',{},async()=>{}),/H01_CONFIG_SELECTOR_INVALID/);
});

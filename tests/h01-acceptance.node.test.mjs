import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectVectorRequest,VectorOperationDenied} from '../utils/e02-vector-request-gateway.js';
import {runH01QdrantAcceptance} from '../utils/s11-plugin-compatibility.js';
const route='/api/plugins/similharity/v2/diagnostics/qdrant-contract';
test('H01 allow only explicit disposable Qdrant acceptance, still deny actual records',()=>{
 assert.equal(inspectVectorRequest(route,{method:'POST',body:JSON.stringify({configId:'local',confirmDisposable:true})}).allowed,true);
 for(const body of [{}, {configId:'local'}, {configId:'local',confirmDisposable:true,collectionId:'my-chat'}, {configId:'remote',confirmDisposable:true}]) {
  assert.throws(()=>inspectVectorRequest(route,{method:'POST',body:JSON.stringify(body)}),VectorOperationDenied);
 }
 assert.throws(()=>inspectVectorRequest(route,{method:'GET'}),VectorOperationDenied);
 assert.throws(()=>inspectVectorRequest('/api/plugins/similharity/v2/records/insert',{method:'POST',body:'{}'}),VectorOperationDenied);
});
test('H01 client never includes credential, record ID, chat data, or arbitrary scope',async()=>{
 const seen=[];
 const result=await runH01QdrantAcceptance('local',{'X-CSRF-Token':'test'},async(url,opts)=>{
  seen.push([url,opts]);return {ok:true,json:async()=>({success:true,productionWritesEnabled:false,disposableCollection:'vh2_abc',stages:[]})};
 });
 assert.equal(result.success,true);assert.equal(seen.length,1);
 assert.deepEqual(JSON.parse(seen[0][1].body),{configId:'local',confirmDisposable:true});
 await assert.rejects(()=>runH01QdrantAcceptance('arbitrary',{},async()=>{}),/H01_CONFIG_SELECTOR_INVALID/);
});

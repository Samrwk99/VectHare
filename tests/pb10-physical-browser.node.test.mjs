import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inspectVectorRequest} from '../utils/e02-vector-request-gateway.js';
import {readPB10PhysicalPage,validatePB10PhysicalPage} from '../utils/pb10-physical-browser.js';
const K='a'.repeat(64),url='/api/plugins/similharity/v2/pb10/physical/browse';
const source={kind:'chat',avatar:'avatar.png',chatFile:'chat.jsonl'};
const request=(backend='qdrant',extra={})=>({method:'POST',body:JSON.stringify({backend,source,...extra})});
const page={success:true,readOnly:true,inventoryKind:'ENTIRE_OWNED_PHYSICAL_COLLECTION',
 inventoryVerified:true,physicalInventoryComplete:true,ownerVerified:true,backend:'qdrant',
 logicalKey:K,inventoryDigest:K,sourceFingerprint:K,registryFingerprint:K,routingGeneration:0,
 totalRecords:1,offset:0,pageComplete:true,nextCursor:null,
 records:[{recordId:'rec_1',revision:1,textHash:K,metadataHash:K,textPreview:'OK',textTruncated:false,metadataKeys:['foo']}]};
test('gateway permits only read-only exact saved-source selectors for all backends',()=>{
 for(const backend of ['qdrant','lancedb','vectra','milvus']){
  assert.equal(inspectVectorRequest(url,request(backend)).allowed,true);
  for(const extra of [{vector:[0.1]},{physicalName:'arbitrary'},{owner:'someone'},
   {cursor:123},{cursor:'bad'}, {configId:'private'}]){
   assert.throws(()=>inspectVectorRequest(url,request(backend,extra)),/denied/i);
  }
 }
 assert.throws(()=>inspectVectorRequest(url,{method:'GET'}),/denied/i);
});
test('physical pages require complete proof; reject false completeness and invalid page sizes',()=>{
 assert.equal(validatePB10PhysicalPage(page).totalRecords,1);
 for(const invalid of [{physicalInventoryComplete:false},{inventoryVerified:false},{ownerVerified:false},
  {pageComplete:false},{totalRecords:2},{offset:2},{records:Array(51).fill(page.records[0])},
  {nextCursor:'evil'}, {sourceFingerprint:'no'}]){
  assert.throws(()=>validatePB10PhysicalPage({...page,...invalid}),/PB10_PHYSICAL_PAGE_UNVERIFIED/);
 }
});
test('network read uses protected gateway and validates the resulting proof',async()=>{
 const seen=[];
 const fetchImpl=async(u,opt)=>{seen.push({u,body:JSON.parse(opt.body)});
  return {ok:true,json:async()=>page};};
 const response=await readPB10PhysicalPage({backend:'qdrant',source,fetchImpl});
 assert.equal(response.totalRecords,1);assert.equal(seen[0].u,url);
 assert.deepEqual(Object.keys(seen[0].body).sort(),['backend','configId','source']);
});

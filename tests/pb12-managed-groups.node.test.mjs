import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {assertPB12GroupEvidence,requestPB12Groups} from '../utils/pb12-managed-groups.js';
import {guardedVectorFetch} from '../utils/e02-vector-request-gateway.js';
const KEY='a'.repeat(64),ID=randomUUID(),source={kind:'chat',avatar:'test.png',chatFile:'chat.jsonl'};
const valid={success:true,sourceAuthoritative:true,verifiedPhysicalInventory:true,
 backend:'qdrant',logicalKey:KEY,generation:0,storedGeneration:0,revision:1,proof:KEY,recordCount:1,
 groups:[{id:randomUUID(),name:'Title',members:[ID]}],orphanedMembers:[],
 availableRecords:[{recordId:ID,textPreview:'saved text'}],requiresGenerationReview:false};
test('group read validates owned physical evidence and never trusts generic success',()=>{
 assert.equal(assertPB12GroupEvidence(valid).revision,1);
 for(const bad of [{verifiedPhysicalInventory:false},{sourceAuthoritative:false},
  {groups:[{...valid.groups[0],members:['legacy-hash']}]},
  {availableRecords:[{recordId:'unverified',textPreview:'hello'}]},
  {recordCount:20001},{proof:'bad'},{storedGeneration:undefined},
  {storedGeneration:1},{requiresGenerationReview:undefined}]){
  assert.throws(()=>assertPB12GroupEvidence({...valid,...bad}),/PB12_GROUP_EVIDENCE_UNVERIFIED/);
 }
});
test('gateway permits only guarded managed group read/update, never physical mutation',async()=>{
 let body=null,route=null;
 const fetchImpl=async(url,opts)=>{route=url;body=JSON.parse(opts.body);
  return {ok:true,json:async()=>({...valid,receipt:{verified:true,durable:true,revision:1}})};};
 await requestPB12Groups({backend:'qdrant',source,headers:{},fetchImpl});
 assert.equal(route,'/api/plugins/similharity/v2/pb12/groups/read');
 assert.deepEqual(Object.keys(body).sort(),['backend','configId','source']);
 await requestPB12Groups({action:'update',backend:'qdrant',source,mutation:'save',
  expectedRevision:0,expectedProof:KEY,operationId:randomUUID(),groups:valid.groups,fetchImpl});
 assert.equal(route,'/api/plugins/similharity/v2/pb12/groups/update');
 assert.equal(body.action,'save');
 await requestPB12Groups({action:'update',backend:'qdrant',source,mutation:'review-generation',
  expectedRevision:1,expectedProof:KEY,expectedStoredGeneration:0,operationId:randomUUID(),fetchImpl});
 assert.equal(body.action,'review-generation');assert.equal(body.expectedStoredGeneration,0);
 assert.ok(!('groups' in body));
 assert.throws(()=>guardedVectorFetch(route,{method:'POST',body:JSON.stringify({...body,groups:[]})},fetchImpl),/pb12-managed-group-intent-invalid/);
 assert.throws(()=>guardedVectorFetch(route,{method:'POST',body:JSON.stringify({...body,expectedStoredGeneration:-1})},fetchImpl),/pb12-managed-group-intent-invalid/);
 const opts={method:'POST',body:JSON.stringify({...body,physicalName:'forged'})};
 assert.throws(()=>guardedVectorFetch(route,opts,fetchImpl),/pb12-managed-group-intent-invalid/);
});
test('refused server responses never become successful group readback',async()=>{
 const fetchImpl=async()=>({ok:false,json:async()=>({success:false,code:'PB12_PROOF_STALE'})});
 await assert.rejects(()=>requestPB12Groups({backend:'milvus',source,fetchImpl}),/PB12_PROOF_STALE/);
});
test('P-B.13 client validates retrieval modes and never treats unverified policy as ready',()=>{
 const good={...valid,groups:[{...valid.groups[0],mode:'inclusive',boost:.15}]};
 assert.equal(assertPB12GroupEvidence(good).groups[0].mode,'inclusive');
 assert.equal(assertPB12GroupEvidence({...good,groups:[{...good.groups[0],mode:'exclusive',boost:undefined}]}).groups[0].mode,'exclusive');
 for(const wrong of [{mode:'mandatory',boost:undefined},{mode:'inclusive',boost:10},
  {mode:'exclusive',boost:.15}]){
  assert.throws(()=>assertPB12GroupEvidence({...good,groups:[{...good.groups[0],...wrong}]}),/UNVERIFIED/);
 }
});

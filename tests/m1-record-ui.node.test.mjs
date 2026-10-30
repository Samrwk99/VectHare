import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {inspectVectorRequest,VectorOperationDenied} from '../utils/e02-vector-request-gateway.js';
import {m1Capabilities,m1Preview,m1Plan,m1Apply,m1PrepareCollection,m1ProvisionCollection} from '../utils/m1-record-gui.js';
const base='/api/plugins/similharity';
const source={kind:'chat',avatar:'alice.png',chatFile:'a'};
const recordId=randomUUID(),operationId=randomUUID(),logicalKey='a'.repeat(64);
const call=(url,body)=>inspectVectorRequest(base+url,{method:'POST',body:JSON.stringify(body)});
const refused=(url,body)=>assert.throws(()=>call(url,body),VectorOperationDenied);
function response(data,{status=200}={}){return {ok:status<400,status,async json(){return data;}};}
test('M1 extension policy permits only exact scoped mutation routes',()=>{
 assert.equal(call('/v2/m1/records/preview',{backend:'qdrant',source}).allowed,true);
 assert.equal(call('/v2/m1/collections/prepare',{backend:'qdrant',source}).allowed,true);
 assert.equal(call('/v2/m1/collections/provision',{operationId,confirmation:'CREATE OWNED V2 COLLECTION'}).allowed,true);
 refused('/v2/m1/collections/provision',{operationId,confirmation:'CREATE OWNED V2 COLLECTION',physicalName:'foreign'});
 assert.equal(call(`/v2/collections/${logicalKey}/records/plan`,{backend:'qdrant',source,recordId,action:'restore'}).allowed,true);
 assert.equal(call('/v2/mutations/execute',{operationId,confirmation:'APPLY SAVED RECORD MUTATION'}).allowed,true);
 refused('/v2/mutations/execute',{operationId,confirmation:'APPLY SAVED RECORD MUTATION',text:'spoof'});
 refused('/v2/m1/records/preview',{backend:'qdrant',source,ownerId:'bob'});
 refused(`/v2/collections/${logicalKey}/records/plan`,{backend:'qdrant',source,recordId,action:'delete',vector:[1]});
 refused('/v2/workflows/chat-sync-pilot-apply',{backend:'qdrant'});
});
test('M1 frontend validates bound preview, plan, and confirmed execute response',async()=>{
 const f=async(_u,_i)=>response({success:true,logicalKey,records:[{recordId,availableActions:['insert'],managedState:'UNTRACKED'}]});
 assert.equal((await m1Preview(source,'default',{},f)).records[0].recordId,recordId);
 const g=async()=>response({success:true,plan:{operationId,logicalKey,recordId,action:'insert',requiresExplicitApply:true,executionAllowed:false}});
 assert.equal((await m1Plan({logicalKey,source,recordId,action:'insert'}, {},g)).operationId,operationId);
 const h=async()=>response({success:true,operationId,state:'VERIFIED',retryable:false});
 assert.equal((await m1Apply(operationId,{},h)).state,'VERIFIED');
 await assert.rejects(()=>m1Apply(operationId,{},async()=>response({success:false,code:'M1_BLOCKED'},{status:409})),/M1_BLOCKED/);
});
test('M1 capability UI cannot interpret Blocked as Enabled',async()=>{
 const ops=['insert','update','revectorize','delete'];
 const result=await m1Capabilities({},async()=>response({success:true,capabilities:ops.map(operation=>({backend:'qdrant',operation,enabled:false,mode:'BLOCKED'}))}));
 assert.ok(result.every(x=>x.enabled===false));
 await assert.rejects(()=>m1Capabilities({},async()=>response({success:true,capabilities:ops.map(operation=>({backend:'qdrant',operation,enabled:true,mode:'BLOCKED'}))})),/M1_CAPABILITY_RESPONSE_INVALID/);
});

test('M1 safe owned collection bootstrap validates planned identity and verified F03 receipt',async()=>{
 const f=async()=>response({success:true,plan:{operationId,logicalKey,action:'provision',requiresExplicitApply:true,executionAllowed:false}});
 assert.equal((await m1PrepareCollection(source,'default',{},f)).logicalKey,logicalKey);
 const g=async()=>response({success:true,backend:'qdrant',logicalKey,receiptState:'SCHEMA_VERIFIED_OFFLINE_UNCERTIFIED',productionWritesEnabled:false});
 assert.equal((await m1ProvisionCollection(operationId,{},g)).logicalKey,logicalKey);
 await assert.rejects(()=>m1ProvisionCollection(operationId,{},async()=>response({success:true,backend:'qdrant',logicalKey,receiptState:'FAILED',productionWritesEnabled:true})),/M1_PROVISION_RECEIPT_INVALID/);
});

test('M4a LanceDB selected saved-record intent is guarded and never accepts local/physical overrides',async()=>{
 const preview=call('/v2/m1/records/preview',{backend:'lancedb',source,configId:'default'});
 assert.equal(preview.allowed,true);assert.equal(preview.backend,'lancedb');
 assert.equal(call('/v2/m1/collections/prepare',{backend:'lancedb',source,configId:'default'}).allowed,true);
 assert.equal(call(`/v2/collections/${logicalKey}/records/plan`,{backend:'lancedb',source,configId:'default',recordId,action:'delete'}).allowed,true);
 refused('/v2/m1/records/preview',{backend:'lancedb',source,configId:'local'});
 refused('/v2/m1/records/preview',{backend:'lancedb',source,configId:'default',physicalName:'foreign'});
 refused(`/v2/collections/${logicalKey}/records/plan`,{backend:'lancedb',source,recordId,action:'update',vector:[1]});
 const ops=['insert','update','revectorize','delete'];
 const capabilities=await m1Capabilities({},async()=>response({success:true,capabilities:[
 ...ops.map(operation=>({backend:'qdrant',operation,enabled:true,mode:'ENABLED'})),
 ...ops.map(operation=>({backend:'lancedb',operation,enabled:true,mode:'ENABLED'}))]}),'lancedb');
 assert.ok(capabilities.every(c=>c.backend==='lancedb'));
 const chosen=await m1Preview(source,'default',{},async(_url,init)=>{
  assert.equal(JSON.parse(init.body).backend,'lancedb');
  return response({success:true,logicalKey,records:[{recordId,availableActions:['insert']}]});
 },'lancedb');
 assert.equal(chosen.records[0].recordId,recordId);
 const result=await m1ProvisionCollection(operationId,{},async()=>response({success:true,backend:'lancedb',logicalKey,
  receiptState:'SCHEMA_VERIFIED_OFFLINE_UNCERTIFIED',productionWritesEnabled:false}),'lancedb');
 assert.equal(result.backend,'lancedb');
});

test('M4c Milvus saved-record UI permits only attested selectors and rejects raw mutation data',async()=>{
 assert.equal(call('/v2/m1/records/preview',{backend:'milvus',source,configId:'default'}).backend,'milvus');
 assert.equal(call('/v2/m1/collections/prepare',{backend:'milvus',source,configId:'default'}).allowed,true);
 assert.equal(call(`/v2/collections/${logicalKey}/records/plan`,{backend:'milvus',source,recordId,action:'delete'}).allowed,true);
 refused('/v2/m1/records/preview',{backend:'milvus',source,configId:'local'});
 refused('/v2/m1/records/preview',{backend:'milvus',source,ownerId:'foreign'});
 refused('/v2/m1/records/preview',{backend:'milvus',source,physicalName:'foreign'});
 refused('/v2/m1/records/preview',{backend:'milvus',source,server:'attacker.example'});
 refused(`/v2/collections/${logicalKey}/records/plan`,{backend:'milvus',source,recordId,action:'update',text:'forged'});
 refused(`/v2/collections/${logicalKey}/records/plan`,{backend:'milvus',source,recordId,action:'update',vector:[0,1,2]});
 const ops=['insert','update','revectorize','delete'];
 const capabilities=await m1Capabilities({},async()=>response({success:true,capabilities:
  ['qdrant','lancedb','vectra','milvus'].flatMap(backend=>ops.map(operation=>({backend,operation,enabled:true,mode:'ENABLED'})))}),'milvus');
 assert.equal(capabilities.length,4);
 assert.ok(capabilities.every(c=>c.backend==='milvus'&&c.enabled===true));
 const preview=await m1Preview(source,'default',{},async(_url,init)=>{
  assert.equal(JSON.parse(init.body).backend,'milvus');
  return response({success:true,logicalKey,records:[{recordId,availableActions:['insert']}]});
 },'milvus');
 assert.equal(preview.records[0].recordId,recordId);
 const provision=await m1ProvisionCollection(operationId,{},async()=>response({success:true,backend:'milvus',logicalKey,
  receiptState:'SCHEMA_VERIFIED_OFFLINE_UNCERTIFIED',productionWritesEnabled:false}),'milvus');
 assert.equal(provision.backend,'milvus');
});

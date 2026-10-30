import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {inspectVectorRequest,VectorOperationDenied} from '../utils/e02-vector-request-gateway.js';
import {m1Capabilities,m1Preview,m1Plan,m1PrepareCollection,m1ProvisionCollection} from '../utils/m1-record-gui.js';
const source={kind:'lorebook',name:'saved-lore'},root='/api/plugins/similharity';
const recordId=randomUUID(),operationId=randomUUID(),logicalKey='b'.repeat(64);
const body=(suffix,payload)=>inspectVectorRequest(root+suffix,{method:'POST',body:JSON.stringify(payload)});
const rejected=(suffix,payload)=>assert.throws(()=>body(suffix,payload),VectorOperationDenied);
const ok=result=>({ok:true,async json(){return result;}});
test('M4b Vectra guarded UI allows only saved-source selectors and no client-side data or credentials',()=>{
 assert.equal(body('/v2/m1/records/preview',{backend:'vectra',source,configId:'default'}).backend,'vectra');
 assert.equal(body('/v2/m1/collections/prepare',{backend:'vectra',source,configId:'default'}).backend,'vectra');
 assert.equal(body(`/v2/collections/${logicalKey}/records/plan`,{backend:'vectra',source,recordId,action:'delete'}).allowed,true);
 for(const extras of [{physicalName:'other'},{vector:[1,2,3]},{ownerId:'other'},{databasePath:'/tmp/other'},{text:'browser forged'}]){
  rejected('/v2/m1/records/preview',{backend:'vectra',source,...extras});
  rejected(`/v2/collections/${logicalKey}/records/plan`,{backend:'vectra',source,recordId,action:'delete',...extras});
 }
 rejected('/v2/m1/records/preview',{backend:'vectra',source,configId:'local'});
 rejected('/v2/m1/records/preview',{backend:'vectra',source:{...source,userScopeId:'fake'}});
});
test('M4b Vectra UI validates server capabilities, preview, plans and provision receipt',async()=>{
 const ops=['insert','update','revectorize','delete'];
 const capabilities=await m1Capabilities({},async()=>ok({success:true,capabilities:
 ['qdrant','lancedb','vectra'].flatMap(backend=>ops.map(operation=>({backend,operation,mode:'ENABLED',enabled:true})))}),'vectra');
 assert.equal(capabilities.length,4);
 const p=await m1Preview(source,'default',{},async(_u,init)=>{
  assert.equal(JSON.parse(init.body).backend,'vectra');
  return ok({success:true,logicalKey,records:[{recordId,availableActions:['insert']}]});
 },'vectra');assert.equal(p.records.length,1);
 const planned=await m1Plan({logicalKey,source,recordId,action:'insert',backend:'vectra'}, {},async()=>ok({success:true,plan:
  {logicalKey,recordId,operationId,action:'insert',requiresExplicitApply:true,executionAllowed:false}}));
 assert.equal(planned.operationId,operationId);
 assert.equal((await m1PrepareCollection(source,'default',{},async()=>ok({success:true,plan:{logicalKey,operationId,
  action:'provision',requiresExplicitApply:true,executionAllowed:false}}),'vectra')).logicalKey,logicalKey);
 assert.equal((await m1ProvisionCollection(operationId,{},async()=>ok({success:true,backend:'vectra',logicalKey,
  receiptState:'SCHEMA_VERIFIED_OFFLINE_UNCERTIFIED',productionWritesEnabled:false}),'vectra')).backend,'vectra');
});

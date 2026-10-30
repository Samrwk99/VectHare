import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {inspectVectorRequest,VectorOperationDenied} from '../utils/e02-vector-request-gateway.js';
import {m4bVectraPreview,m4bVectraBackup,m4bVectraVerify,m4bVectraPlanDelete,
 m4bVectraExecuteDelete,m4bVectraPlanTransition,m4bVectraExecuteTransition} from '../utils/m4b-vectra-lifecycle.js';
const root='/api/plugins/similharity/v2/m4b/vectra',id=randomUUID(),key='a'.repeat(64);
const source={kind:'chat',avatar:'a.png',chatFile:'a.jsonl'};
const inspect=(route,method,body)=>inspectVectorRequest(root+route,{method,...(body===undefined?{}:{body:JSON.stringify(body)})});
const response=d=>({ok:true,status:200,async json(){return {success:true,...d}}});
test('M4b E02 admits only exact Vectra lifecycle shapes with no client physical authority',()=>{
 for(const route of ['/collections/preview','/backups/create']){
  const body={backend:'vectra',source,...(route.endsWith('/create')?{confirmation:'CAPTURE OWNED LOGICAL BACKUP'}:{})};
  assert.equal(inspect(route,'POST',body).allowed,true);
  for(const bad of [{physicalName:'vh2_override'},{path:'/tmp/other'},{owner:'alice'},
   {vector:[1,2,3]},{embedding:{source:'bad'}},{text:'forged'}])
   assert.throws(()=>inspect(route,'POST',{...body,...bad}),VectorOperationDenied);
 }
 assert.equal(inspect(`/backups/${id}/verify`,'GET').allowed,true);
 assert.equal(inspect('/collections/delete/plan','POST',{backend:'vectra',source,backupId:id}).allowed,true);
 assert.equal(inspect('/collections/delete/execute','POST',
  {operationId:id,confirmation:'DELETE OWNED VECTRA COLLECTION'}).allowed,true);
 for(const action of ['restore','empty']){
  assert.equal(inspect('/collections/transition/plan','POST',{backend:'vectra',source,backupId:id,action}).allowed,true);
  assert.equal(inspect('/collections/transition/execute','POST',{operationId:id,
   confirmation:action==='restore'?'RESTORE OWNED VECTRA COLLECTION':'EMPTY OWNED VECTRA COLLECTION'}).allowed,true);
 }
 for(const route of ['/purge-all','/collections/purge','/collections/restore-direct','/chunks/delete'])
  assert.throws(()=>inspect(route,'POST',{backend:'vectra',source}),VectorOperationDenied);
 assert.throws(()=>inspect('/collections/delete/execute','POST',{operationId:id,confirmation:'DELETE'}),VectorOperationDenied);
 assert.throws(()=>inspect('/collections/transition/plan','POST',{backend:'vectra',source,backupId:id,action:'purge-all'}),VectorOperationDenied);
});
test('M4b UI validates backup, delete consent, and transition generation evidence',async()=>{
 const preview={backend:'vectra',logicalKey:key,recordCount:1,ownerVerified:true,
  completePhysicalInventory:true,operationModes:{backup:'ENABLED'},productionWritesEnabled:false};
 assert.equal((await m4bVectraPreview(source,{},async()=>response(preview))).recordCount,1);
 await assert.rejects(()=>m4bVectraPreview(source,{},async()=>response({...preview,ownerVerified:false})),/UNTRUSTED/);
 const backup={backend:'vectra',state:'VERIFIED',backupId:id,physicalBackupVerified:true,productionCertified:false};
 assert.equal((await m4bVectraBackup(source,{},async()=>response(backup))).backupId,id);
 await assert.rejects(()=>m4bVectraBackup(source,{},async()=>response({...backup,physicalBackupVerified:false})),/UNVERIFIED/);
 assert.equal((await m4bVectraVerify(id,{},async()=>response({backend:'vectra',backupId:id,integrityVerified:true,logicalKey:key}))).integrityVerified,true);
 const plan={backend:'vectra',state:'PLANNED',operationId:id,backupId:id,expiresAt:Date.now()+100000,
  requiredConfirmation:'DELETE OWNED VECTRA COLLECTION',oneUse:true};
 assert.equal((await m4bVectraPlanDelete(source,id,{},async()=>response(plan))).oneUse,true);
 await assert.rejects(()=>m4bVectraPlanDelete(source,id,{},async()=>response({...plan,oneUse:false})),/UNTRUSTED/);
 const done={backend:'vectra',state:'VERIFIED',operationId:id,registryTombstoned:true,physicalAbsent:true};
 assert.equal((await m4bVectraExecuteDelete(id,{},async()=>response(done))).physicalAbsent,true);
 await assert.rejects(()=>m4bVectraExecuteDelete(id,{},async()=>response({...done,physicalAbsent:false})),/UNTRUSTED/);
 for(const action of ['restore','empty']){
  const transitionPlan={backend:'vectra',state:'PLANNED',action,operationId:id,backupId:id,expiresAt:Date.now()+10000,
   requiredConfirmation:action==='restore'?'RESTORE OWNED VECTRA COLLECTION':'EMPTY OWNED VECTRA COLLECTION',
   oneUse:true,oldPhysicalRetained:true};
  assert.equal((await m4bVectraPlanTransition(source,id,action,{},async()=>response(transitionPlan))).oneUse,true);
  await assert.rejects(()=>m4bVectraPlanTransition(source,id,action,{},async()=>response({...transitionPlan,oldPhysicalRetained:false})),/UNTRUSTED/);
  const executed={backend:'vectra',action,operationId:id,state:'VERIFIED',generation:1,
   oldPhysicalRetained:true,verifiedEmpty:action==='empty',restoredCount:action==='restore'?1:0};
  assert.equal((await m4bVectraExecuteTransition(id,action,{},async()=>response(executed))).generation,1);
  await assert.rejects(()=>m4bVectraExecuteTransition(id,action,{},async()=>response({...executed,generation:0})),/UNVERIFIED/);
 }
});

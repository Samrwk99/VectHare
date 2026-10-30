import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {inspectVectorRequest,VectorOperationDenied} from '../utils/e02-vector-request-gateway.js';
import {m4cMilvusPreview,m4cMilvusBackup,m4cMilvusVerify,m4cMilvusPlanDelete,
 m4cMilvusExecuteDelete,m4cMilvusPlanTransition,m4cMilvusExecuteTransition} from '../utils/m4c-milvus-lifecycle.js';
const base='/api/plugins/similharity/v2/m4c/milvus',id=randomUUID(),key='a'.repeat(64);
const source={kind:'chat',avatar:'a.png',chatFile:'a.jsonl'};
const inspect=(route,method,body)=>inspectVectorRequest(base+route,{method,...(body===undefined?{}:{body:JSON.stringify(body)})});
const response=d=>({ok:true,status:200,async json(){return {success:true,...d}}});
test('M4c2 browser gateway allows only server-source selectors, verified backup and one-use delete',()=>{
 for(const route of ['/collections/preview','/backups/create']){
  const body={backend:'milvus',source,...(route.endsWith('/create')?{confirmation:'CAPTURE OWNED LOGICAL BACKUP'}:{})};
  assert.equal(inspect(route,'POST',body).allowed,true);
  for(const bad of [{physicalName:'vh2_injected'},{path:'/tmp/other'},{owner:'alice'},
   {vector:[1,2,3]},{embedding:{source:'bad'}},{token:'secret'},{address:'127.0.0.1'}])
    assert.throws(()=>inspect(route,'POST',{...body,...bad}),VectorOperationDenied);
 }
 assert.equal(inspect(`/backups/${id}/verify`,'GET').allowed,true);
 assert.equal(inspect('/collections/delete/plan','POST',{backend:'milvus',source,backupId:id}).allowed,true);
 assert.equal(inspect('/collections/delete/execute','POST',
  {operationId:id,confirmation:'DELETE OWNED MILVUS COLLECTION'}).allowed,true);
 for(const route of ['/purge-all','/collections/purge','/collections/restore-direct','/chunks/delete'])
  assert.throws(()=>inspect(route,'POST',{backend:'milvus',source}),VectorOperationDenied);
 for(const action of ['restore','empty']){
  assert.equal(inspect('/collections/transition/plan','POST',{backend:'milvus',source,backupId:id,action}).allowed,true);
  assert.equal(inspect('/collections/transition/execute','POST',{operationId:id,
   confirmation:action==='restore'?'RESTORE OWNED MILVUS COLLECTION':'EMPTY OWNED MILVUS COLLECTION'}).allowed,true);
 }
 assert.throws(()=>inspect('/collections/transition/plan','POST',{backend:'milvus',source,backupId:id,action:'purge-all'}),VectorOperationDenied);
 assert.throws(()=>inspect('/collections/delete/execute','POST',
  {operationId:id,confirmation:'DELETE'}),VectorOperationDenied);
});
test('M4c2 Milvus UI refuses missing backup, fraudulent confirmation and unverified deletion',async()=>{
 const preview={backend:'milvus',logicalKey:key,recordCount:1,ownerVerified:true,
  completePhysicalInventory:true,operationModes:{backup:'ENABLED'},productionWritesEnabled:false};
 assert.equal((await m4cMilvusPreview(source,{},async()=>response(preview))).recordCount,1);
 await assert.rejects(()=>m4cMilvusPreview(source,{},async()=>response({...preview,ownerVerified:false})),/UNTRUSTED/);
 const backup={backend:'milvus',state:'VERIFIED',backupId:id,physicalBackupVerified:true,productionCertified:false};
 assert.equal((await m4cMilvusBackup(source,{},async()=>response(backup))).backupId,id);
 await assert.rejects(()=>m4cMilvusBackup(source,{},async()=>response({...backup,physicalBackupVerified:false})),/UNVERIFIED/);
 assert.equal((await m4cMilvusVerify(id,{},async()=>response({backend:'milvus',backupId:id,integrityVerified:true,logicalKey:key}))).integrityVerified,true);
 const planned={backend:'milvus',state:'PLANNED',operationId:id,backupId:id,expiresAt:Date.now()+100000,
  requiredConfirmation:'DELETE OWNED MILVUS COLLECTION',oneUse:true};
 assert.equal((await m4cMilvusPlanDelete(source,id,{},async()=>response(planned))).oneUse,true);
 await assert.rejects(()=>m4cMilvusPlanDelete(source,id,{},async()=>response({...planned,oneUse:false})),/UNTRUSTED/);
 const done={backend:'milvus',state:'VERIFIED',operationId:id,registryTombstoned:true,physicalAbsent:true};
 assert.equal((await m4cMilvusExecuteDelete(id,{},async()=>response(done))).physicalAbsent,true);
 await assert.rejects(()=>m4cMilvusExecuteDelete(id,{},async()=>response({...done,physicalAbsent:false})),/UNTRUSTED/);
 for(const action of ['restore','empty']){
  const ticket={backend:'milvus',action,state:'PLANNED',operationId:id,backupId:id,oneUse:true,oldPhysicalRetained:true,
   expiresAt:Date.now()+10000,requiredConfirmation:action==='restore'?'RESTORE OWNED MILVUS COLLECTION':'EMPTY OWNED MILVUS COLLECTION'};
  assert.equal((await m4cMilvusPlanTransition(source,id,action,{},async()=>response(ticket))).oneUse,true);
  await assert.rejects(()=>m4cMilvusPlanTransition(source,id,action,{},async()=>response({...ticket,oldPhysicalRetained:false})),/UNTRUSTED/);
  const result={backend:'milvus',state:'VERIFIED',action,operationId:id,generation:1,oldPhysicalRetained:true,
   verifiedEmpty:action==='empty',restoredCount:action==='restore'?1:0};
  assert.equal((await m4cMilvusExecuteTransition(id,action,{},async()=>response(result))).generation,1);
  await assert.rejects(()=>m4cMilvusExecuteTransition(id,action,{},async()=>response({...result,generation:0})),/UNVERIFIED/);
 }
});

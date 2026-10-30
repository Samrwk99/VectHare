import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {inspectVectorRequest,VectorOperationDenied} from '../utils/e02-vector-request-gateway.js';
import {m4aLancePreview,m4aLanceBackup,m4aLanceVerify,m4aLancePlanDelete,m4aLanceExecuteDelete} from '../utils/m3-collections-gui.js';
const base='/api/plugins/similharity/v2/m4a/lancedb';
const source={kind:'chat',avatar:'a.png',chatFile:'a.jsonl'},key='a'.repeat(64),id=randomUUID();
const inspect=(route,method,body)=>inspectVectorRequest(base+route,{method,...(body===undefined?{}:{body:JSON.stringify(body)})});
const response=(obj,status=200)=>({ok:status<400,status,async json(){return obj;}});
test('M4a E02 permits only exact LanceDB preview/create/verify, denies all destructive and spoofed fields',()=>{
 assert.equal(inspect('/collections/preview','POST',{backend:'lancedb',source}).allowed,true);
 assert.equal(inspect('/backups/create','POST',{backend:'lancedb',source,
  confirmation:'CAPTURE OWNED LOGICAL BACKUP'}).allowed,true);
 assert.equal(inspect(`/backups/${id}/verify`,'GET').allowed,true);
 for(const route of ['/collections/delete','/collections/execute','/collections/empty',
   '/backups/restore','/purge-all'])
  assert.throws(()=>inspect(route,'POST',{backend:'lancedb',source}),VectorOperationDenied);
 for(const ext of [{physicalName:'x'},{path:'/tmp'},{ownerId:'alice'},
   {vector:[1,2,3]},{embedding:{model:'bad'}},{text:'spoofed'}])
  assert.throws(()=>inspect('/collections/preview','POST',{backend:'lancedb',source,...ext}),VectorOperationDenied);
 assert.throws(()=>inspect('/backups/create','POST',{backend:'lancedb',source,
  confirmation:'BYPASS'}),VectorOperationDenied);
 assert.throws(()=>inspect('/collections/preview','POST',{backend:'lancedb',source:{...source,owner:'x'}}),VectorOperationDenied);
 assert.throws(()=>inspect(`/backups/${id}/verify?owner=x`,'GET'),VectorOperationDenied);
 assert.throws(()=>inspect(`/backups/${id}/verify`,'POST',{}),VectorOperationDenied);
});
test('M4a UI clients validate server evidence and reject forged readbacks',async()=>{
 const p=await m4aLancePreview(source,{},async()=>response({success:true,backend:'lancedb',
  logicalKey:key,recordCount:1,ownerVerified:true,completePhysicalInventory:true,
  productionWritesEnabled:false,operationModes:{backup:'ENABLED',delete:'ENABLED'}}));
 assert.equal(p.recordCount,1);
 const b=await m4aLanceBackup(source,{},async()=>response({success:true,backend:'lancedb',
  backupId:id,logicalKey:key,state:'VERIFIED',physicalBackupVerified:true,productionCertified:false}));
 assert.equal(b.backupId,id);
 const v=await m4aLanceVerify(id,{},async()=>response({success:true,backend:'lancedb',
  backupId:id,logicalKey:key,integrityVerified:true}));
 assert.equal(v.integrityVerified,true);
 await assert.rejects(()=>m4aLancePreview(source,{},async()=>response({...p,operationModes:{backup:'BLOCKED'}})),
  /M4A_PREVIEW_UNTRUSTED/);
 await assert.rejects(()=>m4aLanceBackup(source,{},async()=>response({...b,physicalBackupVerified:false})),
  /M4A_BACKUP_UNVERIFIED/);
});

test('M4a E02 only accepts typed LanceDB deletion plan/execute without physical paths or owner override',()=>{
 const plan={backend:'lancedb',source,backupId:id};
 assert.equal(inspect('/collections/delete/plan','POST',plan).allowed,true);
 const execute={operationId:id,confirmation:'DELETE OWNED LANCEDB COLLECTION'};
 assert.equal(inspect('/collections/delete/execute','POST',execute).allowed,true);
 for(const b of [{...plan,path:'/tmp'}, {...plan,owner:'intruder'},
  {...plan,collection:'foreign'}, {...plan,vector:[1,2]}, {...plan,backupId:'invalid'}])
  assert.throws(()=>inspect('/collections/delete/plan','POST',b),VectorOperationDenied);
 for(const b of [{...execute,confirmation:'DELETE'}, {...execute,physicalName:'other'},
  {...execute,operationId:'not-uuid'}])
  assert.throws(()=>inspect('/collections/delete/execute','POST',b),VectorOperationDenied);
 for(const route of ['/collections/empty','/collections/purge','/backups/restore'])
  assert.throws(()=>inspect(route,'POST',plan),VectorOperationDenied);
});
test('M4a delete UI enforces one-use server proof and verified tombstone on readback',async()=>{
 const plan=await m4aLancePlanDelete(source,id,{},async()=>response({success:true,backend:'lancedb',
  state:'PLANNED',operationId:id,backupId:id,logicalKey:key,expiresAt:Date.now()+100000,
  requiredConfirmation:'DELETE OWNED LANCEDB COLLECTION',oneUse:true,productionCertified:false}));
 assert.equal(plan.operationId,id);
 const done=await m4aLanceExecuteDelete(id,{},async()=>response({success:true,backend:'lancedb',
  state:'VERIFIED',operationId:id,logicalKey:key,physicalAbsent:true,registryTombstoned:true,
  productionCertified:false}));
 assert.equal(done.registryTombstoned,true);
 await assert.rejects(()=>m4aLancePlanDelete(source,id,{},async()=>response({...plan,success:true,oneUse:false})),
  /M4A_DELETE_PLAN_UNVERIFIED/);
 await assert.rejects(()=>m4aLanceExecuteDelete(id,{},async()=>response({...done,success:true,registryTombstoned:false})),
  /M4A_DELETE_OUTCOME_UNVERIFIED/);
});

test('M4a4 E02 permits only specific one-use restore/empty transition routes and blocks forged fields',()=>{
 for(const action of ['restore','empty']){
  const plan={backend:'lancedb',source,backupId:id,action};
  assert.equal(inspect('/collections/transition/plan','POST',plan).allowed,true);
  const confirmation=action==='restore'?'RESTORE OWNED LANCEDB COLLECTION':'EMPTY OWNED LANCEDB COLLECTION';
  assert.equal(inspect('/collections/transition/execute','POST',{operationId:id,confirmation}).allowed,true);
  for(const k of [{path:'/tmp/escape'},{physicalName:'evil'},{owner:'intruder'},{vector:[1,2,3]},{embedding:{source:'x'}}])
   assert.throws(()=>inspect('/collections/transition/plan','POST',{...plan,...k}),VectorOperationDenied);
  assert.throws(()=>inspect('/collections/transition/execute','POST',{operationId:id,confirmation,physicalName:'forged'}),VectorOperationDenied);
 }
 assert.throws(()=>inspect('/collections/transition/plan','POST',{backend:'lancedb',source,backupId:id,action:'purge-all'}),VectorOperationDenied);
 assert.throws(()=>inspect('/collections/transition/execute','POST',{operationId:id,confirmation:'NO'}),VectorOperationDenied);
});
test('M4a4 UI refuses forged transition planning and missing physical-retention proof',async()=>{
 const {m4aLancePlanTransition,m4aLanceExecuteTransition}=await import('../utils/m3-collections-gui.js');
 const expected={success:true,backend:'lancedb',action:'empty',operationId:id,
  backupId:id,logicalKey:key,state:'PLANNED',expiresAt:Date.now()+60000,
  requiredConfirmation:'EMPTY OWNED LANCEDB COLLECTION',oneUse:true,oldPhysicalRetained:true,productionCertified:false};
 assert.equal((await m4aLancePlanTransition(source,id,'empty',{},async()=>response(expected))).oneUse,true);
 await assert.rejects(()=>m4aLancePlanTransition(source,id,'empty',{},async()=>response({...expected,oldPhysicalRetained:false})),
  /M4A_TRANSITION_PLAN_UNVERIFIED/);
 const result={success:true,backend:'lancedb',action:'empty',operationId:id,logicalKey:key,state:'VERIFIED',
  generation:1,oldPhysicalRetained:true,verifiedEmpty:true,restoredCount:0,productionCertified:false};
 assert.equal((await m4aLanceExecuteTransition(id,'empty',{},async()=>response(result))).verifiedEmpty,true);
 await assert.rejects(()=>m4aLanceExecuteTransition(id,'empty',{},async()=>response({...result,generation:0})),
  /M4A_TRANSITION_OUTCOME_UNVERIFIED/);
});

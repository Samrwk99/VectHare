import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {verifyManagedRecordReadback} from '../utils/pb3-managed-record-readback.js';
import {requiresManagedSceneContract,assertManagedSceneMutationSupported} from '../utils/pb3-managed-scene-guard.js';
const ID=randomUUID(),OTHER=randomUUID();
const healthy={recordId:ID,physicalState:'VERIFIED',managedState:'ACTIVE',changed:false,
 registryMismatch:false,displayStatus:'PHYSICALLY_VERIFIED',revision:2,
 savedText:'saved chat',savedTextTruncated:false,availableActions:['update']};
const deleted={...healthy,physicalState:'MISSING',managedState:'DELETED',displayStatus:'MISSING_PHYSICAL',availableActions:['restore']};
const page=(rows,offset=0,total=rows.length,cursor=null,changes={})=>({
 success:true,readOnly:true,sourceAuthoritative:true,inventoryKind:'SAVED_SOURCE_RECORDS',
 inventoryVerified:false,physicalInventoryComplete:false,completeSavedSource:true,
 logicalKey:'a'.repeat(64),fileFingerprint:'b'.repeat(64),registryFingerprint:'c'.repeat(64),
 routingGeneration:0,sourceSelectionGeneration:0,totalRecords:total,offset,
 records:rows,nextCursor:cursor,pageComplete:cursor===null,...changes});
test('P-B.3 readback requires physical state plus managed registry consistency',async()=>{
 for(const action of ['insert','restore','repair-missing','update','revectorize','repair-registry']){
  const r=await verifyManagedRecordReadback({recordId:ID,action,readPage:async()=>page([healthy])});
  assert.equal(r.readbackVerified,true);assert.equal(r.physicalInventoryComplete,false);
 }
 assert.equal((await verifyManagedRecordReadback({recordId:ID,action:'delete',readPage:async()=>page([deleted])})).managedState,'DELETED');
 for(const bad of [{...healthy,changed:true},{...healthy,registryMismatch:true},
  {...healthy,managedState:'WRITE_PENDING'},{...healthy,physicalState:'CONFLICT'},
  {...deleted,managedState:'ACTIVE'}]){
  await assert.rejects(verifyManagedRecordReadback({recordId:ID,
   action:bad.physicalState==='MISSING'?'delete':'update',readPage:async()=>page([bad])}),/PB3_READBACK_/);
 }
});
test('P-B.3 readback paginates, rejects registry races, forged cursor replay, and cancellation',async()=>{
 const other={...healthy,recordId:OTHER};
 const first=page([other],0,2,'valid.cursor');const second=page([healthy],1,2);
 const readPage=async c=>c?second:first;
 const good=await verifyManagedRecordReadback({recordId:ID,action:'update',readPage});
 assert.equal(good.examined,2);
 await assert.rejects(verifyManagedRecordReadback({recordId:ID,action:'update',
  readPage:async c=>c?page([healthy],1,2,null,{registryFingerprint:'d'.repeat(64)}):first}),/PB3_READBACK_GENERATION_CHANGED/);
 await assert.rejects(verifyManagedRecordReadback({recordId:ID,action:'update',
  readPage:async()=>first}),/PB3_READBACK_PAGE_SEQUENCE_INVALID/);
 await assert.rejects(verifyManagedRecordReadback({recordId:ID,action:'update',
  readPage:async()=>page([healthy]),shouldContinue:()=>false}),/PB3_READBACK_SELECTION_CHANGED/);
 await assert.rejects(verifyManagedRecordReadback({recordId:ID,action:'update',
  readPage:async()=>page([healthy]),maxRows:0}),/PB3_READBACK_ARGUMENTS_INVALID/);
 let calls=0;
 await assert.rejects(verifyManagedRecordReadback({recordId:ID,action:'update',
  readPage:async()=>++calls===1?page([healthy]):page([healthy],0,1,null,{registryFingerprint:'d'.repeat(64)})}),
  /PB3_READBACK_CHANGED_DURING_FINAL_ATTESTATION/);
});
test('P-B.3 managed scene markers never issue legacy metadata/hash mutations',()=>{
 for(const backend of ['qdrant','lancedb','vectra','milvus']){
  assert.equal(requiresManagedSceneContract({vector_backend:backend}),true);
  assert.throws(()=>assertManagedSceneMutationSupported({vector_backend:backend}),/PB3_MANAGED_SCENE_METADATA_WRITE_UNAVAILABLE/);
 }
 assert.equal(requiresManagedSceneContract({vector_backend:'standard'}),false);
 assert.equal(assertManagedSceneMutationSupported({vector_backend:'standard'}),true);
});

test('P-B.3 old collection-delete path rejects identifiable managed-v2 rows',async()=>{
 const {requiresManagedLifecycle,assertLegacyCollectionDeletionAllowed}=await import('../utils/pb3-managed-collection-guard.js');
 for(const row of [{managedV2:true},{schemaVersion:2},{routingGeneration:0},{physicalName:'vh2_'+'a'.repeat(64)}]){
  assert.equal(requiresManagedLifecycle(row),true);
  assert.throws(()=>assertLegacyCollectionDeletionAllowed(row),/PB3_MANAGED_LIFECYCLE_PLAN_REQUIRED/);
 }
 assert.equal(assertLegacyCollectionDeletionAllowed({id:'legacy-custom-collection'}),true);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {inspectVectorRequest,VectorOperationDenied} from '../utils/e02-vector-request-gateway.js';
import {m3Preview,m3Backup,m3VerifyBackup,m3Plan,m3ExecuteBlocked,m3OperationEvidence,m3RollbackPlan,m3Readiness,m3TerminalProof,m3QuarantineTerminal,m3RebuildPreview,m3RebuildStagePlan,m3RebuildStageExecute,m3InspectRebuildStage,m3SetLocalStagedProfile,m3SourceProfile,m3RebuildActivationPlan,m3RebuildActivationExecute} from '../utils/m3-collections-gui.js';
const ROOT='/api/plugins/similharity/v2/m3';
const id=randomUUID(),operationId=randomUUID(),source={kind:'chat',avatar:'a.png',chatFile:'a'};
const intent={backend:'qdrant',source},key='a'.repeat(64);
const check=(path,method,body)=>inspectVectorRequest(ROOT+path,{method,...(body===undefined?{}:{body:JSON.stringify(body)})});
const response=(obj,status=200)=>({ok:status<400,status,async json(){return obj;}});
test('M3 frontend E02 permits only typed saved-source backup and read-only verify',()=>{
 assert.equal(check('/collections/preview','POST',intent).allowed,true);
 assert.equal(check('/backups/create','POST',{...intent,confirmation:'CAPTURE OWNED LOGICAL BACKUP'}).allowed,true);
 assert.equal(check(`/backups/${id}/verify`,'GET').allowed,true);
 assert.equal(check(`/operations/${operationId}/evidence`,'GET').allowed,true);
 assert.equal(check('/collections/plan','POST',{...intent,action:'delete',backupId:id}).allowed,true);
 assert.equal(check('/collections/rollback/plan','POST',{restoreOperationId:id}).allowed,true);
 assert.equal(check('/collections/readiness','GET').allowed,true);
 assert.equal(check('/collections/execute','POST',{operationId,confirmation:'DELETE OWNED COLLECTION'}).allowed,true);
 for(const extra of [{physicalName:'my-other'},{ownerId:'bob'},{vector:[1]},{text:'hi'},{embedding:{source:'x'}}]){
  assert.throws(()=>check('/collections/preview','POST',{...intent,...extra}),VectorOperationDenied);
 }
 assert.throws(()=>check('/collections/plan','POST',{...intent,action:'delete',backupId:id,owner:'a'}),VectorOperationDenied);
 assert.throws(()=>check('/collections/execute','POST',{operationId,confirmation:'DELETE OWNED COLLECTION',force:true}),VectorOperationDenied);
 assert.throws(()=>check('/backups/create','POST',{...intent,confirmation:'BYPASS'}),VectorOperationDenied);
 assert.throws(()=>check(`/backups/${id}/verify`,'POST',{}),VectorOperationDenied);
 assert.throws(()=>check(`/operations/${operationId}/evidence`,'POST',{}),VectorOperationDenied);
 assert.throws(()=>check(`/operations/${operationId}/evidence?owner=bob`,'GET'),VectorOperationDenied);
 assert.throws(()=>check('/collections/preview','POST',{...intent,source:{...source,path:'/tmp'}}),VectorOperationDenied);
 assert.throws(()=>check('/collections/execute','POST',{operationId,confirmation:'PURGE ALL'}),VectorOperationDenied);
 assert.throws(()=>check('/collections/rollback/plan','POST',{restoreOperationId:id,physicalName:'bad'}),VectorOperationDenied);
 assert.throws(()=>check('/collections/readiness','POST',{}),VectorOperationDenied);
});
test('M3 client treats blocked as blocked and verifies backup responses',async()=>{
 const p=await m3Preview(source,'default',{},async()=>response({success:true,logicalKey:key,ownerVerified:true,recordCount:2,productionWritesEnabled:false}));
 assert.equal(p.recordCount,2);
 const backup=await m3Backup(source,'default',{},async()=>response({success:true,backupId:id,logicalKey:key,state:'VERIFIED',physicalBackupVerified:true,productionCertified:false}));
 assert.equal(backup.backupId,id);
 const verified=await m3VerifyBackup(id,{},async()=>response({success:true,backupId:id,logicalKey:key,integrityVerified:true}));
 assert.equal(verified.integrityVerified,true);
 const plan=await m3Plan(source,'delete',id,'default',{},async()=>response({success:true,operationId,backupId:id,action:'delete',executionAllowed:false}));
 assert.equal(plan.executionAllowed,false);
 await assert.rejects(()=>m3ExecuteBlocked(operationId,'delete',{},async()=>response({success:false,code:'M3_COLLECTION_GATEWAY_NOT_CERTIFIED'},409)),/M3_COLLECTION_GATEWAY_NOT_CERTIFIED/);
 await assert.rejects(()=>m3Preview(source,'default',{},async()=>response({success:true,logicalKey:key,ownerVerified:true,recordCount:2,productionWritesEnabled:true})),/M3_PREVIEW_UNTRUSTED/);
});

test('M3g recovery status is read-only, owner-bound and never authorizes release',async()=>{
 const good={success:true,operationId,action:'delete',claimed:true,lastStage:'DISPATCH_PENDING',
  classification:'REVIEW_REQUIRED',automaticReplayAuthorized:false,physicalLockReleaseAuthorized:false};
 const evidence=await m3OperationEvidence(operationId,{},async()=>response(good));
 assert.equal(evidence.classification,'REVIEW_REQUIRED');
 await assert.rejects(()=>m3OperationEvidence(operationId,{},async()=>response({...good,physicalLockReleaseAuthorized:true})),
  /M3_OPERATION_EVIDENCE_UNTRUSTED/);
 await assert.rejects(()=>m3OperationEvidence('not-a-uuid',{},async()=>response(good)),/M3_OPERATION_ID_INVALID/);
});

test('M3v4 completed lifecycle reports verified result awaiting manual acceptance',async()=>{
 const verified={success:true,operationId,state:'VERIFIED',enabled:true,validationStatus:'AWAITING_MANUAL_TEST'};
 const result=await m3ExecuteBlocked(operationId,'delete',{},async()=>response(verified));
 assert.equal(result.state,'VERIFIED');
 await assert.rejects(()=>m3ExecuteBlocked(operationId,'delete',{},async()=>response({...verified,enabled:false})),/M3_EXECUTION_UNVERIFIED/);
 const rollback=await m3RollbackPlan(operationId,{},async()=>response({success:true,operationId:id,action:'rollback',executionAllowed:true}));
 assert.equal(rollback.executionAllowed,true);
 const readiness=await m3Readiness({},async()=>response({success:true,operations:{delete:{mode:'ENABLED'}}}));
 assert.equal(readiness.operations.delete.mode,'ENABLED');
});
test('M3.4 scoped empty is typed, guard-protected and exposed as executable UI action',async()=>{
 assert.equal(check('/collections/execute','POST',{operationId,confirmation:'EMPTY OWNED COLLECTION'}).allowed,true);
 assert.throws(()=>check('/collections/execute','POST',{operationId,confirmation:'PURGE ALL'}),VectorOperationDenied);
 const verified={success:true,operationId,state:'VERIFIED',enabled:true,validationStatus:'AWAITING_MANUAL_TEST'};
 const responseEmpty=await m3ExecuteBlocked(operationId,'empty',{},async()=>response(verified));
 assert.equal(responseEmpty.state,'VERIFIED');
});

test('M3v6 server-admin terminal review is strictly typed and does not accept an unlock verdict',async()=>{
 assert.equal(check(`/operations/${operationId}/terminal-proof`,'GET').allowed,true);
 assert.equal(check(`/operations/${operationId}/quarantine-terminal`,'POST',{}).allowed,true);
 assert.throws(()=>check(`/operations/${operationId}/quarantine-terminal`,'POST',{force:true}),VectorOperationDenied);
 assert.throws(()=>check(`/operations/${operationId}/terminal-proof`,'POST',{}),VectorOperationDenied);
 assert.throws(()=>check(`/operations/${operationId}/quarantine-terminal?owner=bob`,'POST',{}),VectorOperationDenied);
 const proof=await m3TerminalProof(operationId,{},async()=>response({success:true,operationId,eligible:true,
  proofHash:key,requiresOutOfBandAdminApproval:true,disposition:'TERMINAL_DELETE_ONLY'}));
 assert.equal(proof.proofHash,key);
 await assert.rejects(()=>m3TerminalProof(operationId,{},async()=>response({success:true,operationId,eligible:true,proofHash:'bad'})));
 const done=await m3QuarantineTerminal(operationId,{},async()=>response({success:true,operationId,
  disposition:'QUARANTINED_COMMITTED_DELETE_LOCK',replayAllowed:false,mutationReplayed:false}));
 assert.equal(done.replayAllowed,false);
 await assert.rejects(()=>m3QuarantineTerminal(operationId,{},async()=>response({success:true,operationId,
  disposition:'QUARANTINED_COMMITTED_DELETE_LOCK',replayAllowed:true,mutationReplayed:false})));
});


test('M3.5 frontend permits ONLY source-bound read-only rebuild preview and rejects injected target profiles',async()=>{
 assert.equal(check('/collections/rebuild/preview','POST',{...intent,backupId:id}).allowed,true);
 for(const extra of [{targetProfile:{model:'not-owned'}},{physicalName:'x'},{embedding:{dimension:1}},{owner:'bob'},{vectors:[[1,2]]}]){
  assert.throws(()=>check('/collections/rebuild/preview','POST',{...intent,backupId:id,...extra}),VectorOperationDenied);
 }
 assert.throws(()=>check('/collections/rebuild/preview','POST',{...intent,backupId:'forged'}),VectorOperationDenied);
 assert.throws(()=>check('/collections/rebuild/preview','GET'),VectorOperationDenied);
 const d=await m3RebuildPreview(source,id,'default',{},async()=>response({success:true,mode:'PREVIEW',enabled:false,
  inventoryVerified:true,embeddingProfileChanged:true,recordsToReembed:3,newLogicalKey:key}));
 assert.equal(d.enabled,false);assert.equal(d.recordsToReembed,3);
 await assert.rejects(()=>m3RebuildPreview(source,id,'default',{},async()=>response({...d,enabled:true})),/M3_REBUILD_PREVIEW_UNTRUSTED/);
});


test('M3v8 stage-only frontend requires typed plan and never grants activation',async()=>{
 const body={...intent,backupId:id};
 assert.equal(check('/collections/rebuild/stage-plan','POST',body).allowed,true);
 assert.throws(()=>check('/collections/rebuild/stage-plan','POST',{...body,text:'untrusted'}),VectorOperationDenied);
 assert.throws(()=>check('/collections/rebuild/stage-execute','POST',{operationId:id,confirmation:'ACTIVATE NEW MODEL'}),VectorOperationDenied);
 assert.throws(()=>check('/collections/rebuild/stage-execute','POST',{operationId:id,confirmation:'STAGE NEW MODEL WITHOUT ACTIVATION',physicalName:'forged'}),VectorOperationDenied);
 assert.equal(check('/collections/rebuild/stage-execute','POST',{operationId:id,confirmation:'STAGE NEW MODEL WITHOUT ACTIVATION'}).allowed,true);
 const plan=await m3RebuildStagePlan(source,id,'default',{},async()=>response({success:true,action:'rebuild-stage',operationId:id,stagingAllowed:true,activationAllowed:false,targetLogicalKey:key}));
 assert.equal(plan.activationAllowed,false);
 await assert.rejects(()=>m3RebuildStagePlan(source,id,'default',{},async()=>response({...plan,activationAllowed:true})),/M3_REBUILD_STAGE_PLAN_UNTRUSTED/);
 const staged=await m3RebuildStageExecute(id,{},async()=>response({success:true,operationId:id,state:'VERIFIED_STAGED',activationAllowed:false,oldCollectionRetained:true,stagedLogicalKey:key}));
 assert.equal(staged.oldCollectionRetained,true);
 await assert.rejects(()=>m3RebuildStageExecute(id,{},async()=>response({...staged,activationAllowed:true})),/M3_REBUILD_STAGING_UNVERIFIED/);
});


test('M3v8 staged local model config cannot send credentials or switch the active profile',async()=>{
 const profileCheck=(method,body)=>inspectVectorRequest('/api/plugins/similharity/v2/embeddings/staged-profile',{method,body:JSON.stringify(body)});
 const b={source:'transformers',model:'local-embed',dimension:4,metric:'cosine'};
 assert.equal(profileCheck('PUT',b).allowed,true);
 for(const forbidden of [{credential:'secret'},{url:'http://evil'},{owner:'bob'}, {source:'openai'}])
  assert.throws(()=>profileCheck('PUT',{...b,...forbidden}),VectorOperationDenied);
 assert.throws(()=>inspectVectorRequest('/api/plugins/similharity/v2/embeddings/profile',{method:'PUT',body:JSON.stringify(b)}),VectorOperationDenied);
 const d=await m3SetLocalStagedProfile('local-embed',4,'cosine',{},async()=>response({success:true,configured:true,profile:b}));
 assert.equal(d.profile.model,'local-embed');
 await assert.rejects(()=>m3SetLocalStagedProfile('bad model',4,'cosine'),/M3_STAGED_PROFILE_INVALID/);
});

test('M3v9 staging status is read-only and requires complete physical, registry and source proofs',async()=>{
 assert.equal(check(`/collections/rebuild/stages/${operationId}`,'GET').allowed,true);
 assert.throws(()=>check(`/collections/rebuild/stages/${operationId}`,'POST',{}),VectorOperationDenied);
 assert.throws(()=>check(`/collections/rebuild/stages/${operationId}?physicalName=x`,'GET'),VectorOperationDenied);
 const good={success:true,operationId,state:'VERIFIED_STAGED',activationAllowed:false,
  stagedLogicalKey:key,receiptVerified:true,registryVerified:true,physicalVerified:true,
  sourceVerified:true,activeProfileUnchanged:true};
 const result=await m3InspectRebuildStage(operationId,{},async()=>response(good));
 assert.equal(result.activationAllowed,false);
 await assert.rejects(()=>m3InspectRebuildStage(operationId,{},async()=>response({...good,registryVerified:false})),/EVIDENCE_UNTRUSTED/);
 await assert.rejects(()=>m3InspectRebuildStage(operationId,{},async()=>response({...good,activationAllowed:true})),/EVIDENCE_UNTRUSTED/);
 const blocked=await m3InspectRebuildStage(operationId,{},async()=>response({success:true,operationId,
  state:'REVIEW_REQUIRED',activationAllowed:false,physicalLockReleaseAuthorized:false}));
 assert.equal(blocked.state,'REVIEW_REQUIRED');
});


test('M3v10 guarded activation plan and execute admit only exact stage IDs and confirmation',async()=>{
 assert.equal(check('/collections/rebuild/activation-plan','POST',{stageOperationId:id}).allowed,true);
 assert.throws(()=>check('/collections/rebuild/activation-plan','POST',{stageOperationId:id,physicalName:'evil'}),VectorOperationDenied);
 assert.equal(check('/collections/rebuild/activation-execute','POST',
  {operationId:id,confirmation:'ACTIVATE VERIFIED MODEL FOR THIS SOURCE'}).allowed,true);
 for(const data of [{operationId:id,confirmation:'ACTIVATE GLOBAL MODEL'},
  {operationId:id,confirmation:'ACTIVATE VERIFIED MODEL FOR THIS SOURCE',force:true}])
  assert.throws(()=>check('/collections/rebuild/activation-execute','POST',data),VectorOperationDenied);
 assert.equal(check('/collections/rebuild/source-profile','POST',{source}).allowed,true);
 assert.throws(()=>check('/collections/rebuild/source-profile','POST',{source,credential:'secret'}),VectorOperationDenied);
 const plan=await m3RebuildActivationPlan(id,{},async()=>response({success:true,operationId,stageOperationId:id,
  targetLogicalKey:key,enabled:true,validationStatus:'AWAITING_MANUAL_TEST',
  requiresConfirmation:'ACTIVATE VERIFIED MODEL FOR THIS SOURCE'}));
 assert.equal(plan.targetLogicalKey,key);
 const active=await m3RebuildActivationExecute(plan.operationId,{},async()=>response({success:true,
  operationId:plan.operationId,state:'VERIFIED',sourceScoped:true,enabled:true,
  validationStatus:'AWAITING_MANUAL_TEST',activeProfileUnchanged:true,oldCollectionRetained:true,logicalKey:key}));
 assert.equal(active.sourceScoped,true);
 const selected=await m3SourceProfile(source,{},async()=>response({success:true,selected:true,
  profile:{source:'transformers',model:'new',dimension:4,metric:'cosine'},selectionGeneration:1,
  logicalKey:key,credentialsIncluded:false}));
 assert.equal(selected.profile.model,'new');
 await assert.rejects(()=>m3SourceProfile(source,{},async()=>response({...selected,success:true,credential:'private'})));
});


test('M3v11 GUI keeps restore/empty enabled for verified published generations without granting alias deletion',async()=>{
 const preview=await m3Preview(source,'default',{},async()=>response({success:true,logicalKey:key,ownerVerified:true,recordCount:0,
  routingGeneration:2,operationModes:{backup:'ENABLED',restore:'ENABLED',empty:'ENABLED',delete:'BLOCKED'},productionWritesEnabled:false}));
 assert.equal(preview.routingGeneration,2);
 assert.equal(preview.operationModes.restore,'ENABLED');
 assert.equal(preview.operationModes.empty,'ENABLED');
 assert.equal(preview.operationModes.delete,'BLOCKED');
 assert.equal(check('/collections/plan','POST',{...intent,action:'restore',backupId:id}).allowed,true);
 assert.equal(check('/collections/plan','POST',{...intent,action:'empty',backupId:id}).allowed,true);
 assert.throws(()=>check('/collections/plan','POST',{...intent,action:'empty',backupId:id,physicalName:'vh2_fake'}),VectorOperationDenied);
});

test('M3v12 preembedding jobs expose only exact source-owned stage IDs and no physical writes',async()=>{
 const {m3RebuildPreparationProgress,m3RebuildPreparationStep}=await import('../utils/m3-collections-gui.js');
 assert.equal(check(`/collections/rebuild/preparation/${operationId}`,'GET').allowed,true);
 assert.equal(check(`/collections/rebuild/preparation/${operationId}/step`,'POST',{}).allowed,true);
 assert.throws(()=>check(`/collections/rebuild/preparation/${operationId}/step`,'POST',{vector:[0.1]}),VectorOperationDenied);
 assert.throws(()=>check(`/collections/rebuild/preparation/${operationId}/step`,'POST',{owner:'bob'}),VectorOperationDenied);
 assert.throws(()=>check(`/collections/rebuild/preparation/${operationId}?force=true`,'GET'),VectorOperationDenied);
 assert.throws(()=>check(`/collections/rebuild/preparation/${operationId}/step`,'GET'),VectorOperationDenied);
 assert.throws(()=>check('/collections/rebuild/preparation/../../fake/step','POST',{}),VectorOperationDenied);
 const ready={success:true,operationId,state:'READY_TO_STAGE',preparedCount:300,totalCount:300,physicalWritesPerformed:false};
 assert.equal((await m3RebuildPreparationProgress(operationId,{},async()=>response(ready))).preparedCount,300);
 assert.equal((await m3RebuildPreparationStep(operationId,{},async()=>response(ready))).readyForStageExecute,undefined);
 await assert.rejects(()=>m3RebuildPreparationStep(operationId,{},async()=>response({...ready,physicalWritesPerformed:true})),
  /M3_PREPARATION_UNVERIFIED/);
});

test('M3v13 physical Qdrant staging inspection is read-only and bound to exact UUID',()=>{
 const operationId='123e4567-e89b-42d3-a456-426614174000';
 assert.equal(check(`/collections/rebuild/physical-progress/${operationId}`,'GET').allowed,true);
 assert.throws(()=>check(`/collections/rebuild/physical-progress/${operationId}`,'POST',{}),VectorOperationDenied);
 assert.throws(()=>check(`/collections/rebuild/physical-progress/${operationId}?physicalName=x`,'GET'),VectorOperationDenied);
});

test('M3v13 general adjudication evidence is GET only, without client verdict or lock release',()=>{
 const operationId='123e4567-e89b-42d3-a456-426614174000';
 assert.equal(check(`/operations/${operationId}/reconciliation`,'GET').allowed,true);
 assert.throws(()=>check(`/operations/${operationId}/reconciliation`,'POST',{decision:'NOT_APPLIED'}),VectorOperationDenied);
 assert.throws(()=>check(`/operations/${operationId}/reconciliation?releaseLock=true`,'GET'),VectorOperationDenied);
});

test('M3 completion exact stage continuation and adjudication routes reject injected authority',async()=>{
 const {m3ContinuationProof,m3ContinueVerifiedStage,m3ProvenAdjudicationProof,m3QuarantineProven}=await import('../utils/m3-collections-gui.js');
 const op='123e4567-e89b-42d3-a456-426614174000',next='123e4567-e89b-42d3-a456-426614174001';
 assert.equal(check(`/collections/rebuild/continuation-proof/${op}`,'GET').allowed,true);
 assert.equal(check(`/collections/rebuild/continue/${op}`,'POST',{}).allowed,true);
 assert.throws(()=>check(`/collections/rebuild/continue/${op}`,'POST',{force:true}),VectorOperationDenied);
 assert.throws(()=>check(`/collections/rebuild/continue/${op}`,'POST',{owner:'bob'}),VectorOperationDenied);
 assert.throws(()=>check(`/collections/rebuild/continue/${op}`,'GET'),VectorOperationDenied);
 assert.throws(()=>check(`/collections/rebuild/continuation-proof/${op}?physicalName=evil`,'GET'),VectorOperationDenied);
 const h='a'.repeat(64);
 const proof={success:true,originalOperationId:op,classification:'EXACT_PREFIX_VERIFIED',
  physicallyObserved:true,foreignPoints:false,automaticResumeAuthorized:false,lockReleaseAuthorized:false,
  prefixCount:32,totalCount:40,proofHash:h};
 assert.equal((await m3ContinuationProof(op,{},async()=>response(proof))).prefixCount,32);
 await assert.rejects(()=>m3ContinuationProof(op,{},async()=>response({...proof,lockReleaseAuthorized:true})));
 const staged={success:true,previousOperationId:op,operationId:next,state:'VERIFIED_STAGED',
  originalOperationReplayed:false,targetReceiptVerified:true,targetRegistryVerified:true,
  oldCollectionRetained:true,stagedLogicalKey:h};
 assert.equal((await m3ContinueVerifiedStage(op,{},async()=>response(staged))).operationId,next);
 await assert.rejects(()=>m3ContinueVerifiedStage(op,{},async()=>response({...staged,operationId:op})));
 assert.equal(check(`/operations/${op}/adjudication-proof`,'GET').allowed,true);
 assert.equal(check(`/operations/${op}/quarantine-proven`,'POST',{}).allowed,true);
 assert.throws(()=>check(`/operations/${op}/quarantine-proven`,'POST',{decision:'PROVEN_APPLIED'}),VectorOperationDenied);
 assert.throws(()=>check(`/operations/${op}/adjudication-proof?owner=bob`,'GET'),VectorOperationDenied);
 const approved={success:true,operationId:op,eligible:true,disposition:'PROVEN_APPLIED',
  requiresPrivateApproval:true,proofHash:h};
 assert.equal((await m3ProvenAdjudicationProof(op,{},async()=>response(approved))).eligible,true);
 const done={success:true,operationId:op,disposition:'PROVEN_APPLIED_LOCKS_QUARANTINED',originalOperationReplayed:false};
 assert.equal((await m3QuarantineProven(op,{},async()=>response(done))).originalOperationReplayed,false);
 await assert.rejects(()=>m3QuarantineProven(op,{},async()=>response({...done,originalOperationReplayed:true})));
});

test('M3 completion ABANDON is admin-only server-approved and never clears uncertain locks',async()=>{
 const {m3AbandonUncertain,m3InspectAbandonment}=await import('../utils/m3-collections-gui.js');
 const op='123e4567-e89b-42d3-a456-426614174000';
 assert.equal(check(`/operations/${op}/abandon`,'POST',{}).allowed,true);
 assert.equal(check(`/operations/${op}/abandonment`,'GET').allowed,true);
 assert.throws(()=>check(`/operations/${op}/abandon`,'POST',{decision:'NOT_APPLIED'}),VectorOperationDenied);
 assert.throws(()=>check(`/operations/${op}/abandon`,'POST',{releaseLock:true}),VectorOperationDenied);
 assert.throws(()=>check(`/operations/${op}/abandonment?owner=bob`,'GET'),VectorOperationDenied);
 const proof={success:true,operationId:op,disposition:'ABANDONED_UNCERTAIN_LOCK_RETAINED',
  physicalOutcome:'NOT_PROVEN',lockReleaseAuthorized:false,replayAllowed:false};
 assert.equal((await m3AbandonUncertain(op,{},async()=>response(proof))).replayAllowed,false);
 assert.equal((await m3InspectAbandonment(op,{},async()=>response(proof))).lockReleaseAuthorized,false);
 await assert.rejects(()=>m3AbandonUncertain(op,{},async()=>response({...proof,lockReleaseAuthorized:true})));
});

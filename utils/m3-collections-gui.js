/** M3 Qdrant owned collection preflight and logical backup UI.
 * No browser-supplied physical name, embedding, vectors or authority.
 * The guarded restore/delete/rollback/scoped-empty actions are available for manual testing.
 */
import {guardedVectorFetch} from './e02-vector-request-gateway.js';
import {f02CurrentChatSelector} from './f02-public-read-client.js';
const ROOT='/api/plugins/similharity/v2/m3';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY=/^[a-f0-9]{64}$/;
const actions=new Set(['restore','delete','empty','rebuild']);
async function req(path,body,headers={},fetchImpl=globalThis.fetch){
 const r=await guardedVectorFetch(ROOT+path,{method:body===null?'GET':'POST',credentials:'same-origin',cache:'no-store',
  headers:{...headers,...(body===null?{}:{'Content-Type':'application/json'})},
  ...(body===null?{}:{body:JSON.stringify(body)})},fetchImpl);
 let d;try{d=await r.json();}catch{throw Error('M3_RESPONSE_INVALID');}
 if(!r.ok||d?.success!==true)throw Error(d?.code??'M3_REQUEST_REFUSED');return d;
}
const intent=(source,configId='default')=>({backend:'qdrant',source,configId});
export async function m3Preview(source,configId='default',headers={},fetchImpl=globalThis.fetch){
 const d=await req('/collections/preview',intent(source,configId),headers,fetchImpl);
 if(!KEY.test(d.logicalKey??'')||d.ownerVerified!==true||!Number.isSafeInteger(d.recordCount)||d.recordCount<0||
  d.productionWritesEnabled!==false)throw Error('M3_PREVIEW_UNTRUSTED');return d;
}
export async function m3Backup(source,configId='default',headers={},fetchImpl=globalThis.fetch){
 const d=await req('/backups/create',{...intent(source,configId),confirmation:'CAPTURE OWNED LOGICAL BACKUP'},headers,fetchImpl);
 if(!UUID.test(d.backupId??'')||!KEY.test(d.logicalKey??'')||d.state!=='VERIFIED'||d.physicalBackupVerified!==true||d.productionCertified!==false)
  throw Error('M3_BACKUP_UNVERIFIED');return d;
}
export async function m3VerifyBackup(backupId,headers={},fetchImpl=globalThis.fetch){
 if(!UUID.test(backupId??''))throw Error('M3_BACKUP_ID_INVALID');
 const d=await req(`/backups/${backupId}/verify`,null,headers,fetchImpl);
 if(d.backupId!==backupId||d.integrityVerified!==true||!KEY.test(d.logicalKey??''))throw Error('M3_BACKUP_UNVERIFIED');return d;
}
/** Read-only M3 crash / uncertain-operation evidence; never approves recovery. */
export async function m3OperationEvidence(operationId,headers={},fetchImpl=globalThis.fetch){
 if(!UUID.test(operationId??''))throw Error('M3_OPERATION_ID_INVALID');
 const d=await req(`/operations/${operationId}/evidence`,null,headers,fetchImpl);
 if(d.operationId!==operationId||!['REVIEW_REQUIRED','NOT_DISPATCHED_BY_THIS_CLAIM'].includes(d.classification)||
   d.physicalLockReleaseAuthorized!==false||d.automaticReplayAuthorized!==false)throw Error('M3_OPERATION_EVIDENCE_UNTRUSTED');
 return d;
}
/** Privileged, server-evidence-only terminal delete lock review. Approval
 * must exist in a private server config file; the browser never supplies it. */
/** Administrator-only read-only cross-operation evidence. Not an approval. */
export async function m3GeneralReconciliation(operationId,headers={},fetchImpl=globalThis.fetch){
 if(!UUID.test(operationId??''))throw Error('M3_GENERAL_REVIEW_ID_INVALID');
 const d=await req(`/operations/${operationId}/reconciliation`,null,headers,fetchImpl);
 if(d.operationId!==operationId||!KEY.test(d.evidenceHash??'')||
    !['VERIFIED_APPLIED_REVIEW','REVIEW_REQUIRED'].includes(d.classification)||
    d.replayAllowed!==false||d.physicalLockReleaseAuthorized!==false||d.notAppliedProven!==false)
  throw Error('M3_GENERAL_REVIEW_EVIDENCE_UNTRUSTED');
 return d;
}
export async function m3TerminalProof(operationId,headers={},fetchImpl=globalThis.fetch){
 if(!UUID.test(operationId??''))throw Error('M3_OPERATION_ID_INVALID');
 const d=await req(`/operations/${operationId}/terminal-proof`,null,headers,fetchImpl);
 if(d.operationId!==operationId||d.eligible!==true||!KEY.test(d.proofHash??'')||
    d.requiresOutOfBandAdminApproval!==true||d.disposition!=='TERMINAL_DELETE_ONLY')
  throw Error('M3_TERMINAL_PROOF_UNTRUSTED');
 return d;
}
export async function m3QuarantineTerminal(operationId,headers={},fetchImpl=globalThis.fetch){
 if(!UUID.test(operationId??''))throw Error('M3_OPERATION_ID_INVALID');
 const d=await req(`/operations/${operationId}/quarantine-terminal`,{},headers,fetchImpl);
 if(d.operationId!==operationId||d.disposition!=='QUARANTINED_COMMITTED_DELETE_LOCK'||
  d.replayAllowed!==false||d.mutationReplayed!==false)throw Error('M3_TERMINAL_QUARANTINE_UNTRUSTED');
 return d;
}
export async function m3RebuildPreview(source,backupId,configId='default',headers={},fetchImpl=globalThis.fetch){
 if(!UUID.test(backupId??''))throw Error('M3_REBUILD_BACKUP_INVALID');
 const d=await req('/collections/rebuild/preview',{...intent(source,configId),backupId},headers,fetchImpl);
 if(d.enabled!==false||d.mode!=='PREVIEW'||d.inventoryVerified!==true||
   d.embeddingProfileChanged!==true||!Number.isSafeInteger(d.recordsToReembed)||
   !KEY.test(d.newLogicalKey??''))throw Error('M3_REBUILD_PREVIEW_UNTRUSTED');
 return d;
}
/** Explicit local staged identity only. No password, URL or API key leaves the server. */
export async function m3SetLocalStagedProfile(model,dimension,metric='cosine',headers={},fetchImpl=globalThis.fetch){
 if(typeof model!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,127}$/.test(model)||
    !Number.isSafeInteger(dimension)||dimension<1||dimension>65536||
    !['cosine','dot','euclid'].includes(metric))throw Error('M3_STAGED_PROFILE_INVALID');
 const response=await guardedVectorFetch('/api/plugins/similharity/v2/embeddings/staged-profile',{
  method:'PUT',credentials:'same-origin',cache:'no-store',headers:{...headers,
   'x-vecthare-configuration':'1','Content-Type':'application/json'},
  body:JSON.stringify({source:'transformers',model,dimension,metric})},fetchImpl);
 const d=await response.json();
 if(!response.ok||d?.success!==true||d?.profile?.model!==model||d.configured!==true||
    d.profile?.dimension!==dimension)throw Error(d?.code??'M3_STAGED_PROFILE_REFUSED');
 return d;
}
/** Stage server-reembedded vectors only; does NOT activate or swap profiles. */
export async function m3RebuildStagePlan(source,backupId,configId='default',headers={},fetchImpl=globalThis.fetch){
 if(!UUID.test(backupId??''))throw Error('M3_REBUILD_BACKUP_INVALID');
 const d=await req('/collections/rebuild/stage-plan',{...intent(source,configId),backupId},headers,fetchImpl);
 if(!UUID.test(d.operationId??'')||d.action!=='rebuild-stage'||d.stagingAllowed!==true||
    d.activationAllowed!==false||!KEY.test(d.targetLogicalKey??''))throw Error('M3_REBUILD_STAGE_PLAN_UNTRUSTED');
 return d;
}
/** Pre-dispatch, resumable embedding checkpoints; no Qdrant mutation. */
export async function m3RebuildPreparationProgress(operationId,headers={},fetchImpl=globalThis.fetch){
 if(!UUID.test(operationId??''))throw Error('M3_PREPARATION_OPERATION_INVALID');
 const d=await req(`/collections/rebuild/preparation/${operationId}`,null,headers,fetchImpl);
 if(d.operationId!==operationId||!Number.isSafeInteger(d.preparedCount)||
    !Number.isSafeInteger(d.totalCount)||d.preparedCount>d.totalCount||
    !['PREPARING','READY_TO_STAGE'].includes(d.state)||d.physicalWritesPerformed!==false)
  throw Error('M3_PREPARATION_UNVERIFIED');return d;
}
export async function m3RebuildPreparationStep(operationId,headers={},fetchImpl=globalThis.fetch){
 if(!UUID.test(operationId??''))throw Error('M3_PREPARATION_OPERATION_INVALID');
 const d=await req(`/collections/rebuild/preparation/${operationId}/step`,{},headers,fetchImpl);
 if(d.operationId!==operationId||!Number.isSafeInteger(d.preparedCount)||
    !Number.isSafeInteger(d.totalCount)||d.preparedCount>d.totalCount||
    !['PREPARING','READY_TO_STAGE'].includes(d.state)||d.physicalWritesPerformed!==false)
  throw Error('M3_PREPARATION_UNVERIFIED');return d;
}
/** Historical, per-chunk readback evidence. Never authorizes retry or lock release. */
export async function m3PhysicalStageProgress(operationId,headers={},fetchImpl=globalThis.fetch){
 if(!UUID.test(operationId??''))throw Error('M3_PHYSICAL_PROGRESS_ID_INVALID');
 const d=await req(`/collections/rebuild/physical-progress/${operationId}`,null,headers,fetchImpl);
 if(d.operationId!==operationId||!Number.isSafeInteger(d.verifiedChunks)||
    !Number.isSafeInteger(d.verifiedRecordCount)||!Number.isSafeInteger(d.expectedRecordCount)||
    d.verifiedRecordCount>d.expectedRecordCount||d.readbackEvidenceOnly!==true||
    d.automaticReplayAuthorized!==false||d.physicalLockReleaseAuthorized!==false||
    !['WRITE_CHUNKS_READBACK_VERIFIED','PARTIAL_OR_NOT_STARTED'].includes(d.state))
  throw Error('M3_PHYSICAL_PROGRESS_UNTRUSTED');
 return d;
}
export async function m3RebuildStageExecute(operationId,headers={},fetchImpl=globalThis.fetch){
 if(!UUID.test(operationId??''))throw Error('M3_REBUILD_STAGE_ID_INVALID');
 const d=await req('/collections/rebuild/stage-execute',{operationId,confirmation:'STAGE NEW MODEL WITHOUT ACTIVATION'},headers,fetchImpl);
 if(d.operationId!==operationId||d.state!=='VERIFIED_STAGED'||d.activationAllowed!==false||
    d.oldCollectionRetained!==true||!KEY.test(d.stagedLogicalKey??''))throw Error('M3_REBUILD_STAGING_UNVERIFIED');
 return d;
}
/** Read-only, re-verified stage evidence. No activation or lock release. */
export async function m3InspectRebuildStage(operationId,headers={},fetchImpl=globalThis.fetch){
 if(!UUID.test(operationId??''))throw Error('M3_REBUILD_STAGE_ID_INVALID');
 const d=await req(`/collections/rebuild/stages/${operationId}`,null,headers,fetchImpl);
 if(d.operationId!==operationId||d.activationAllowed!==false||
    !['VERIFIED_STAGED','REVIEW_REQUIRED'].includes(d.state))throw Error('M3_REBUILD_STAGE_EVIDENCE_UNTRUSTED');
 if(d.state==='VERIFIED_STAGED'&&(!KEY.test(d.stagedLogicalKey??'')||
     d.receiptVerified!==true||d.registryVerified!==true||d.physicalVerified!==true||
     d.sourceVerified!==true||d.activeProfileUnchanged!==true))
  throw Error('M3_REBUILD_STAGE_EVIDENCE_UNTRUSTED');
 if(d.state==='REVIEW_REQUIRED'&&d.physicalLockReleaseAuthorized!==false)
  throw Error('M3_REBUILD_STAGE_EVIDENCE_UNTRUSTED');
 return d;
}
/** Source-attested selected model. Credentials are never returned. */
export async function m3SourceProfile(source,headers={},fetchImpl=globalThis.fetch){
 const d=await req('/collections/rebuild/source-profile',{source},headers,fetchImpl);
 if(Object.keys(d).some(k=>!['success','profile','selected','selectionGeneration','logicalKey','credentialsIncluded'].includes(k))||
  typeof d.selected!=='boolean'||!Number.isSafeInteger(d.selectionGeneration)||
  d.credentialsIncluded!==false||!d.profile||typeof d.profile.model!=='string'||
  (d.selected&&!KEY.test(d.logicalKey??'')))throw Error('M3_SOURCE_PROFILE_UNTRUSTED');
 return d;
}
export async function m3RebuildActivationPlan(stageOperationId,headers={},fetchImpl=globalThis.fetch){
 if(!UUID.test(stageOperationId??''))throw Error('M3_ACTIVATION_STAGE_ID_INVALID');
 const d=await req('/collections/rebuild/activation-plan',{stageOperationId},headers,fetchImpl);
 if(!UUID.test(d.operationId??'')||d.stageOperationId!==stageOperationId||!KEY.test(d.targetLogicalKey??'')||
  d.enabled!==true||d.validationStatus!=='AWAITING_MANUAL_TEST'||
  d.requiresConfirmation!=='ACTIVATE VERIFIED MODEL FOR THIS SOURCE')throw Error('M3_ACTIVATION_PLAN_UNTRUSTED');
 return d;
}
export async function m3RebuildActivationExecute(operationId,headers={},fetchImpl=globalThis.fetch){
 if(!UUID.test(operationId??''))throw Error('M3_ACTIVATION_OPERATION_ID_INVALID');
 const d=await req('/collections/rebuild/activation-execute',
  {operationId,confirmation:'ACTIVATE VERIFIED MODEL FOR THIS SOURCE'},headers,fetchImpl);
 if(d.operationId!==operationId||d.state!=='VERIFIED'||d.sourceScoped!==true||
  d.enabled!==true||d.validationStatus!=='AWAITING_MANUAL_TEST'||
  d.activeProfileUnchanged!==true||d.oldCollectionRetained!==true||!KEY.test(d.logicalKey??''))
  throw Error('M3_ACTIVATION_RESULT_UNVERIFIED');
 return d;
}
export async function m3Plan(source,action,backupId,configId='default',headers={},fetchImpl=globalThis.fetch){
 if(!actions.has(action)||!UUID.test(backupId??''))throw Error('M3_PLAN_INPUT_INVALID');
 const d=await req('/collections/plan',{...intent(source,configId),action,backupId},headers,fetchImpl);
 if(!UUID.test(d.operationId??'')||d.action!==action||d.backupId!==backupId||typeof d.executionAllowed!=='boolean')
  throw Error('M3_PLAN_UNVERIFIED');return d;
}
export async function m3Execute(operationId,action,headers={},fetchImpl=globalThis.fetch){
 if(!UUID.test(operationId??'')||!new Set([...actions,'rollback']).has(action))throw Error('M3_EXECUTION_INPUT_INVALID');
 const confirmation={restore:'RESTORE TO FRESH COLLECTION',delete:'DELETE OWNED COLLECTION',
  rollback:'ROLL BACK UNCHANGED COLLECTION',empty:'EMPTY OWNED COLLECTION'}[action];
 if(!confirmation)throw Error('M3_EXECUTION_UNIMPLEMENTED');
 const d=await req('/collections/execute',{operationId,confirmation},headers,fetchImpl);
 if(d.state!=='VERIFIED'||d.operationId!==operationId||d.enabled!==true||
  d.validationStatus!=='AWAITING_MANUAL_TEST')throw Error('M3_EXECUTION_UNVERIFIED');
 return d;
}
export async function m3RollbackPlan(restoreOperationId,headers={},fetchImpl=globalThis.fetch){
 if(!UUID.test(restoreOperationId??''))throw Error('M3_RESTORE_OPERATION_INVALID');
 const d=await req('/collections/rollback/plan',{restoreOperationId},headers,fetchImpl);
 if(!UUID.test(d.operationId??'')||d.action!=='rollback'||d.executionAllowed!==true)
  throw Error('M3_ROLLBACK_PLAN_UNVERIFIED');
 return d;
}
export async function m3Readiness(headers={},fetchImpl=globalThis.fetch){
 return req('/collections/readiness',null,headers,fetchImpl);
}
// Existing consumers of the former name use the same guarded implementation.
export const m3ExecuteBlocked=m3Execute;
export function renderM3CollectionsPanel(root,doc=globalThis.document){
 if(!root||!doc?.createElement||root.querySelector?.('#vecthare_m3_collections'))return false;
 const section=doc.createElement('section');section.id='vecthare_m3_collections';
 const h=doc.createElement('h4');h.textContent='M3 — owned collection backup and lifecycle (Qdrant)';
 const help=doc.createElement('p');help.textContent='Manual testing: use a DISPOSABLE owned Qdrant collection. Verified backups are mandatory. Restore, rollback, owned deletion and scoped empty run through the trusted gateway. Empty retains the original collection, creates a verified fresh zero-point generation and tombstones managed records. New-model rebuild offers a source-attested readiness check and a guarded staging operation that re-embeds saved records into a separate Qdrant collection without activating it. Source-scoped activation supports larger staged collections after bounded checkpointed embedding preparation. The global active model stays unchanged; other chats and lorebooks are unaffected. Large-model preparation can be paused and resumed before database dispatch. Historical generations are retained on collection deletion; deletion does not purge their physical backups. Operations may be irreversible and uncertain outcomes require administrator review. Terminal delete locks have a narrow admin-only evidence-bound quarantine; ambiguous operations cannot be unlocked this way. No unrestricted purge.';
 const mode=doc.createElement('select');for(const [value,label] of [['chat','Current saved chat'],['lorebook','Saved lorebook']]){
  const o=doc.createElement('option');o.value=value;o.textContent=label;mode.append(o);}
 const lore=doc.createElement('input');lore.placeholder='Exact saved lorebook name';lore.type='text';
 const config=doc.createElement('select');for(const value of ['default','local']){const o=doc.createElement('option');o.value=value;o.textContent=value;config.append(o);}
 const previewBtn=doc.createElement('button');previewBtn.type='button';previewBtn.textContent='Inspect owned collection';
 const backupBtn=doc.createElement('button');backupBtn.type='button';backupBtn.textContent='Capture complete logical backup';backupBtn.disabled=true;
 const backupId=doc.createElement('input');backupId.type='text';backupId.placeholder='Verified backup UUID';
 const verify=doc.createElement('button');verify.type='button';verify.textContent='Verify saved backup';
 const action=doc.createElement('select');for(const value of actions){const o=doc.createElement('option');o.value=value;o.textContent=value;action.append(o);}
 const rebuildBtn=doc.createElement('button');rebuildBtn.type='button';rebuildBtn.textContent='Check new-model rebuild readiness (read-only)';
 const stagedModel=doc.createElement('input');stagedModel.type='text';stagedModel.placeholder='Staged local embedding model';
 const stagedDimension=doc.createElement('input');stagedDimension.type='number';stagedDimension.min='1';stagedDimension.placeholder='Model vector dimension';
 const stagedMetric=doc.createElement('select');for(const m of ['cosine','dot','euclid']){const o=doc.createElement('option');o.value=m;o.textContent=m;stagedMetric.append(o);}
 const stagedSave=doc.createElement('button');stagedSave.type='button';stagedSave.textContent='Save staged local model (inactive)';
 const stageBtn=doc.createElement('button');stageBtn.type='button';stageBtn.textContent='Stage vectors with configured new model (no activation)';
 const stageOperation=doc.createElement('input');stageOperation.type='text';stageOperation.placeholder='Staging operation UUID';
 const prepareBtn=doc.createElement('button');prepareBtn.type='button';prepareBtn.textContent='Resume / prepare large rebuild (16 records per step)';
 let stopPreparation=false;const pausePreparation=doc.createElement('button');pausePreparation.type='button';pausePreparation.textContent='Pause large rebuild preparation';
 pausePreparation.addEventListener('click',()=>{stopPreparation=true;});
 const stageInspectBtn=doc.createElement('button');stageInspectBtn.type='button';stageInspectBtn.textContent='Verify staged physical target and registry (read-only)';
 const physicalProgressBtn=doc.createElement('button');physicalProgressBtn.type='button';physicalProgressBtn.textContent='Inspect physical rebuild checkpoints (read-only)';
 const continuationProofBtn=doc.createElement('button');continuationProofBtn.type='button';continuationProofBtn.textContent='Admin: verify exact interrupted Qdrant staging frontier';
 const continuationBtn=doc.createElement('button');continuationBtn.type='button';continuationBtn.textContent='Admin: continue PREAPPROVED verified staging under NEW operation';
 const activateBtn=doc.createElement('button');activateBtn.type='button';activateBtn.textContent='Activate verified staged model for THIS saved source';
 const currentProfileBtn=doc.createElement('button');currentProfileBtn.type='button';currentProfileBtn.textContent='Inspect model selected for this source';
 const planBtn=doc.createElement('button');planBtn.type='button';planBtn.textContent='Create lifecycle plan';
 const executeBtn=doc.createElement('button');executeBtn.type='button';executeBtn.textContent='Execute confirmed operation';executeBtn.disabled=true;
 const rollbackFrom=doc.createElement('input');rollbackFrom.type='text';rollbackFrom.placeholder='Restore operation UUID for rollback';
 const rollbackBtn=doc.createElement('button');rollbackBtn.type='button';rollbackBtn.textContent='Plan pristine rollback';
 let prepared=null;
 const recoveryId=doc.createElement('input');recoveryId.type='text';recoveryId.placeholder='Lifecycle operation UUID';
 const recoveryBtn=doc.createElement('button');recoveryBtn.type='button';recoveryBtn.textContent='Inspect lifecycle recovery evidence';
 const generalReviewBtn=doc.createElement('button');generalReviewBtn.type='button';generalReviewBtn.textContent='Admin: reconcile Qdrant lifecycle outcome (read-only)';
 const provenProofBtn=doc.createElement('button');provenProofBtn.type='button';provenProofBtn.textContent='Admin: inspect proven-applied recovery proof';
 const provenQuarantineBtn=doc.createElement('button');provenQuarantineBtn.type='button';provenQuarantineBtn.textContent='Admin: quarantine PREAPPROVED proven-applied locks';
 const abandonBtn=doc.createElement('button');abandonBtn.type='button';abandonBtn.textContent='Admin: record PREAPPROVED abandonment (lock retained)';
 const abandonmentInspectBtn=doc.createElement('button');abandonmentInspectBtn.type='button';abandonmentInspectBtn.textContent='Admin: inspect recorded abandonment';
 const terminalProofBtn=doc.createElement('button');terminalProofBtn.type='button';terminalProofBtn.textContent='Admin: inspect terminal deletion lock';
 const terminalQuarantineBtn=doc.createElement('button');terminalQuarantineBtn.type='button';terminalQuarantineBtn.textContent='Admin: quarantine approved terminal lock';
 const status=doc.createElement('p');status.setAttribute('role','status');
 let last=null,chosen=null;
 const headers=async()=>{const m=await import('../../../../../script.js');return m.getRequestHeaders();};
 const source=async()=>{if(mode.value==='lorebook'){
  const name=lore.value.trim();if(!name||name.length>220)throw Error('Exact lorebook name required');return {kind:'lorebook',name};}
  const m=await import('../../../../../script.js');return f02CurrentChatSelector({getChatId:m.getCurrentChatId,
   getContext:()=>globalThis.SillyTavern?.getContext?.()});};
 previewBtn.addEventListener('click',async()=>{try{chosen=await source();last=await m3Preview(chosen,config.value,await headers());
  backupBtn.disabled=false;status.textContent=`Verified source-bound collection (${last.logicalKey.slice(0,12)}), generation ${last.routingGeneration??0}: ${last.recordCount} physical records. Verified cutover generations support repeated backup, restore and scoped empty. Deletion after a verified cutover deletes only the active generation and explicitly retains historical physical collections.`;
 }catch(e){last=null;backupBtn.disabled=true;status.textContent=`M3 preview refused: ${e.message}`;}});
 backupBtn.addEventListener('click',async()=>{try{if(!last||JSON.stringify(await source())!==JSON.stringify(chosen))throw Error('Saved source changed; preview again');
  if(!globalThis.confirm?.(`Capture a sensitive plaintext logical backup of ${last.recordCount} owned records to private server storage? No chat files or credentials are included.`))return;
  const backup=await m3Backup(chosen,config.value,await headers());backupId.value=backup.backupId;
  status.textContent=`Logical backup ${backup.backupId} verified (${backup.count} records). Manual acceptance remains pending.`;
 }catch(e){status.textContent=`M3 backup refused: ${e.message}`;}});
 verify.addEventListener('click',async()=>{try{const b=await m3VerifyBackup(backupId.value.trim(),await headers());
  status.textContent=`Backup ${b.backupId}: ${b.recordCount} records, integrity verified; manual acceptance pending.`;
 }catch(e){status.textContent=`Backup verification refused: ${e.message}`;}});
 rebuildBtn.addEventListener('click',async()=>{try{
  const report=await m3RebuildPreview(await source(),backupId.value.trim(),config.value,await headers());
  status.textContent=`New-model rebuild readiness: ${report.recordsToReembed} saved records, ${report.tombstonesToPreserve} tombstones; ${report.reasonCode}. No vectors changed.`;
 }catch(e){status.textContent=`Rebuild preview refused: ${e.message}`;}});
 stagedSave.addEventListener('click',async()=>{try{
  const result=await m3SetLocalStagedProfile(stagedModel.value.trim(),Number(stagedDimension.value),stagedMetric.value,await headers());
  status.textContent=`Staged local model ${result.profile.model} (${result.profile.dimension}D). Active model unchanged.`;
 }catch(e){status.textContent=`Staged profile refused: ${e.message}`;}});
 const prepareLarge=async id=>{stopPreparation=false;
  while(!stopPreparation){const progress=await m3RebuildPreparationStep(id,await headers());
   status.textContent=`Rebuild ${id}: ${progress.preparedCount}/${progress.totalCount} embeddings safely checkpointed; ${progress.state}.`;
   if(progress.readyForStageExecute)return true;
  }
  status.textContent=`Rebuild preparation paused: ${id}. Resume later using the same operation UUID.`;
  return false;
 };
 prepareBtn.addEventListener('click',async()=>{try{
  const id=stageOperation.value.trim();if(!UUID.test(id))throw Error('Saved staging operation UUID required');
  await prepareLarge(id);
 }catch(e){status.textContent=`Rebuild preparation stopped: ${e.message}`;}});
 stageBtn.addEventListener('click',async()=>{try{
  const planned=await m3RebuildStagePlan(await source(),backupId.value.trim(),config.value,await headers());
  const phrase='STAGE NEW MODEL WITHOUT ACTIVATION';
  if(!globalThis.confirm?.(`Stage ${planned.recordCount} vectors into a NEW disposable Qdrant collection? This does not activate the new model. Staging is non-replayable after dispatch.`))return;
  if(globalThis.prompt?.(`Type exactly: ${phrase}`)!==phrase)throw Error('Confirmation mismatch');
  stageOperation.value=planned.operationId;
  if(planned.requiresPreparation&&!(await prepareLarge(planned.operationId)))return;
  const result=await m3RebuildStageExecute(planned.operationId,await headers());
  status.textContent=`Rebuild staging VERIFIED (${result.recordCount} records). Active profile unchanged. Verify the staged target, then activate it for the selected saved source; target backup ${result.stagedBackupId}.`;
 }catch(e){status.textContent=`Rebuild staging refused or uncertain: ${e.message}. Inspect retained locks before retry.`;}});
 currentProfileBtn.addEventListener('click',async()=>{try{
  const d=await m3SourceProfile(await source(),await headers());
  status.textContent=`Saved source embedding: ${d.profile.model} (${d.profile.dimension}D), selected generation ${d.selectionGeneration}; ${d.selected?'source-specific':'global default'}.`;
 }catch(e){status.textContent=`Source profile inspection refused: ${e.message}`;}});
 activateBtn.addEventListener('click',async()=>{try{
  const id=stageOperation.value.trim();
  const verification=await m3InspectRebuildStage(id,await headers());
  if(verification.state!=='VERIFIED_STAGED')throw Error('Stage evidence requires administrator review');
  const plan=await m3RebuildActivationPlan(id,await headers());
  const phrase='ACTIVATE VERIFIED MODEL FOR THIS SOURCE';
  if(!globalThis.confirm?.(`Switch only THIS saved source to the verified staged embedding model? Old collection is retained. The operation is one-shot and can require administrator recovery.`))return;
  if(globalThis.prompt?.(`Type exactly: ${phrase}`)!==phrase)throw Error('Activation confirmation mismatch');
  const result=await m3RebuildActivationExecute(plan.operationId,await headers());
  status.textContent=`Source-specific model activated: ${result.logicalKey.slice(0,12)}, generation ${result.generation}. Manual verification required.`;
 }catch(e){status.textContent=`Model activation refused or uncertain: ${e.message}. Do NOT repeat a claimed operation.`;}});
 physicalProgressBtn.addEventListener('click',async()=>{try{
  const p=await m3PhysicalStageProgress(stageOperation.value.trim(),await headers());
  status.textContent=`Physical staging: ${p.verifiedRecordCount}/${p.expectedRecordCount} records read back across ${p.verifiedChunks} durable chunks. Evidence is historical only; a failed write still requires administrator review. Never replay an uncertain stage.`;
 }catch(e){status.textContent=`Physical staging inspection refused: ${e.message}`;}});
 continuationProofBtn.addEventListener('click',async()=>{try{
  const p=await m3ContinuationProof(stageOperation.value.trim(),await headers());
  status.textContent=`Verified Qdrant prefix ${p.prefixCount}/${p.totalCount} records; proof ${p.proofHash}. This is NOT a resume authorization. An administrator must create a one-use private server approval bound to this exact hash.`;
 }catch(e){status.textContent=`Physical staging proof refused: ${e.message}`;}});
 continuationBtn.addEventListener('click',async()=>{try{
  if(!globalThis.confirm?.('Administrator only: continue a physically verified prefix with a NEW operation ID using an existing PRIVATE SERVER approval? Original forensic locks will be transferred in place. Any uncertain outcome retains them.'))return;
  const id=stageOperation.value.trim(),done=await m3ContinueVerifiedStage(id,await headers());
  stageOperation.value=done.operationId;
  status.textContent=`Rebuild continuation VERIFIED: ${done.recordCount} staged records under NEW operation ${done.operationId}; original ${id} retained for forensic review. The old operation was not replayed.`;
 }catch(e){status.textContent=`Approved stage continuation refused/uncertain: ${e.message}. Do not replay; inspect all retained locks.`;}});
 stageInspectBtn.addEventListener('click',async()=>{try{
  const inspected=await m3InspectRebuildStage(stageOperation.value.trim(),await headers());
  status.textContent=inspected.state==='VERIFIED_STAGED'?
   `Staged ${inspected.recordCount} records: target receipt, managed registry, saved source and physical Qdrant inventory verified. Activation requires a separate guarded one-use confirmation.`:
   `Stage ${inspected.operationId}: REVIEW_REQUIRED at ${inspected.lastStage??'unrecorded'}. No replay or lock release.`;
 }catch(e){status.textContent=`Staged target verification refused: ${e.message}`;}});
 planBtn.addEventListener('click',async()=>{try{const src=await source();const p=await m3Plan(src,action.value,backupId.value.trim(),config.value,await headers());
  prepared=p;executeBtn.disabled=!p.executionAllowed;recoveryId.value=p.operationId;
  status.textContent=`${p.action} plan ${p.operationId}. ${p.executionAllowed?'Ready for explicit confirmation and guarded execution.':'Blocked: '+p.prerequisites.join(', ')}`;
 }catch(e){status.textContent=`M3 planning refused: ${e.message}`;}});
 rollbackBtn.addEventListener('click',async()=>{try{
  prepared=await m3RollbackPlan(rollbackFrom.value.trim(),await headers());
  executeBtn.disabled=false;recoveryId.value=prepared.operationId;
  status.textContent=`Rollback plan ${prepared.operationId}. Only unchanged verified collections can be rolled back.`;
 }catch(e){prepared=null;executeBtn.disabled=true;status.textContent=`Rollback refused: ${e.message}`;}});
 executeBtn.addEventListener('click',async()=>{try{
  if(!prepared?.executionAllowed||!['restore','rollback','delete','empty'].includes(prepared.action))throw Error('Operation not ready');
  const phrase={restore:'RESTORE TO FRESH COLLECTION',rollback:'ROLL BACK UNCHANGED COLLECTION',
   delete:'DELETE OWNED COLLECTION',empty:'EMPTY OWNED COLLECTION'}[prepared.action];
  if(!globalThis.confirm?.(`IRREVERSIBLE RISK: Execute ${prepared.action} on a disposable collection? Backup must be verified. This is not host-certified.`))return;
  const typed=globalThis.prompt?.(`Type exactly: ${phrase}`);
  if(typed!==phrase)throw Error('Typed confirmation mismatch');
  const result=await m3Execute(prepared.operationId,prepared.action,await headers());
  status.textContent=`${prepared.action}: VERIFIED operation ${result.operationId}. `+
   (prepared.action==='delete'?`Only the active physical collection was deleted; ${result.retainedHistoricalCollections?.length??0} historical collections remain retained. `:'')+
   'Awaiting your manual acceptance report.';
  prepared=null;executeBtn.disabled=true;
 }catch(e){status.textContent=`Execution refused/uncertain: ${e.message}. If a dispatch occurred, inspect recovery evidence. Do not retry blindly.`;
  prepared=null;executeBtn.disabled=true;}});
 recoveryBtn.addEventListener('click',async()=>{try{
  const e=await m3OperationEvidence(recoveryId.value.trim(),await headers());
  status.textContent=`Lifecycle ${e.operationId}: ${e.classification}, last checkpoint ${e.lastStage??'none'}; claimed ${e.claimed?'yes':'no'}. No automatic replay or lock release authorized.`;
 }catch(e){status.textContent=`M3 recovery evidence refused: ${e.message}`;}});
 generalReviewBtn.addEventListener('click',async()=>{try{
  const evidence=await m3GeneralReconciliation(recoveryId.value.trim(),await headers());
  status.textContent=`Administrator reconciliation ${evidence.classification}: ${evidence.physicalOutcome}, audit ${evidence.lastAuditStage??'absent'}, evidence hash ${evidence.evidenceHash}. No replay or retained-lock release is authorized.`;
 }catch(e){status.textContent=`General reconciliation refused: ${e.message}`;}});
 provenProofBtn.addEventListener('click',async()=>{try{
  const p=await m3ProvenAdjudicationProof(recoveryId.value.trim(),await headers());
  status.textContent=`PROVEN_APPLIED proof ${p.proofHash}. To quarantine a retained lock, first create the matching server-private one-use administrator approval. No browser verdict or replay is accepted.`;
 }catch(e){status.textContent=`Proven-applied review refused: ${e.message}`;}});
 provenQuarantineBtn.addEventListener('click',async()=>{try{
  if(!globalThis.confirm?.('Administrator only: has independently proven operation completion been approved in PRIVATE SERVER config? This action moves retained locks to forensic quarantine.'))return;
  const d=await m3QuarantineProven(recoveryId.value.trim(),await headers());
  status.textContent=`PROVEN_APPLIED locks quarantined under ${d.reviewId}; original operation was not replayed.`;
 }catch(e){status.textContent=`General lock quarantine refused: ${e.message}`;}});
 abandonBtn.addEventListener('click',async()=>{try{
  if(!globalThis.confirm?.('Administrator only: ABANDON the unresolved operation using a PRIVATE SERVER approved evidence hash? It remains blocked and its physical lock will NOT be released.'))return;
  const d=await m3AbandonUncertain(recoveryId.value.trim(),await headers());
  status.textContent=`Recorded ${d.disposition} (${d.reviewId}). The unknown operation remains locked; no replay or NOT_APPLIED inference.`;
 }catch(e){status.textContent=`Uncertain-operation abandonment refused: ${e.message}`;}});
 abandonmentInspectBtn.addEventListener('click',async()=>{try{
  const d=await m3InspectAbandonment(recoveryId.value.trim(),await headers());
  status.textContent=`Forensic case ${d.reviewId}: ${d.disposition}. Original lock remains retained; Qdrant outcome not proven.`;
 }catch(e){status.textContent=`Abandonment inspection refused: ${e.message}`;}});
 terminalProofBtn.addEventListener('click',async()=>{try{
  const proof=await m3TerminalProof(recoveryId.value.trim(),await headers());
  status.textContent=`Administrator-only terminal proof ${proof.proofHash}: eligible only if completed Qdrant delete, S02 tombstone and dead PID are reverified. Create one-use private approval on the server before quarantine.`;
 }catch(e){status.textContent=`Terminal proof refused: ${e.message}`;}});
 terminalQuarantineBtn.addEventListener('click',async()=>{try{
  if(!globalThis.confirm?.('Administrator-only: has the independently verified terminal-delete proof been approved from the PRIVATE SERVER config? This does not settle ambiguous operations.'))return;
  const result=await m3QuarantineTerminal(recoveryId.value.trim(),await headers());
  status.textContent=`Terminal lock forensic quarantine ${result.reviewId} complete. No Qdrant mutation was replayed.`;
 }catch(e){status.textContent=`Terminal lock quarantine refused: ${e.message}`;}});
 section.append(h,help,mode,lore,config,previewBtn,backupBtn,backupId,verify,action,rebuildBtn,stagedModel,stagedDimension,stagedMetric,stagedSave,stageBtn,stageOperation,prepareBtn,pausePreparation,stageInspectBtn,physicalProgressBtn,continuationProofBtn,continuationBtn,activateBtn,currentProfileBtn,planBtn,rollbackFrom,rollbackBtn,executeBtn,recoveryId,recoveryBtn,generalReviewBtn,provenProofBtn,provenQuarantineBtn,abandonBtn,abandonmentInspectBtn,terminalProofBtn,terminalQuarantineBtn,status);
 root.append(section);return true;
}

/** Read-only Qdrant physical prefix proof; never a resume grant. */
export async function m3ContinuationProof(operationId,headers={},fetchImpl=globalThis.fetch){
 if(!UUID.test(operationId??''))throw Error('M3_CONTINUATION_OPERATION_INVALID');
 const d=await req(`/collections/rebuild/continuation-proof/${operationId}`,null,headers,fetchImpl);
 if(d.originalOperationId!==operationId||d.classification!=='EXACT_PREFIX_VERIFIED'||
  d.physicallyObserved!==true||d.foreignPoints!==false||
  d.automaticResumeAuthorized!==false||d.lockReleaseAuthorized!==false||
  !KEY.test(d.proofHash??'')||!Number.isSafeInteger(d.prefixCount)||
  !Number.isSafeInteger(d.totalCount)||d.prefixCount>d.totalCount)
  throw Error('M3_CONTINUATION_PROOF_UNTRUSTED');
 return d;
}
/** Proof requires administrator identity at server; this call sends no decision. */
export async function m3ProvenAdjudicationProof(operationId,headers={},fetchImpl=globalThis.fetch){
 if(!UUID.test(operationId??''))throw Error('M3_ADJUDICATION_OPERATION_INVALID');
 const d=await req(`/operations/${operationId}/adjudication-proof`,null,headers,fetchImpl);
 if(d.operationId!==operationId||d.eligible!==true||d.disposition!=='PROVEN_APPLIED'||
  d.requiresPrivateApproval!==true||!KEY.test(d.proofHash??''))
  throw Error('M3_ADJUDICATION_PROOF_UNTRUSTED');
 return d;
}
/** Server-private approval file must already exist. No browser verdict. */
export async function m3QuarantineProven(operationId,headers={},fetchImpl=globalThis.fetch){
 if(!UUID.test(operationId??''))throw Error('M3_ADJUDICATION_OPERATION_INVALID');
 const d=await req(`/operations/${operationId}/quarantine-proven`,{},headers,fetchImpl);
 if(d.operationId!==operationId||d.disposition!=='PROVEN_APPLIED_LOCKS_QUARANTINED'||
  d.originalOperationReplayed!==false)throw Error('M3_ADJUDICATION_RESULT_UNTRUSTED');
 return d;
}

/** Explicit administrator-approved stage continuation. New operation UUID only. */
export async function m3ContinueVerifiedStage(operationId,headers={},fetchImpl=globalThis.fetch){
 if(!UUID.test(operationId??''))throw Error('M3_STAGE_RESUME_ID_INVALID');
 const d=await req(`/collections/rebuild/continue/${operationId}`,{},headers,fetchImpl);
 if(d.previousOperationId!==operationId||!UUID.test(d.operationId??'')||d.operationId===operationId||
  d.state!=='VERIFIED_STAGED'||d.originalOperationReplayed!==false||
  d.targetReceiptVerified!==true||d.targetRegistryVerified!==true||
  d.oldCollectionRetained!==true||!KEY.test(d.stagedLogicalKey??''))
  throw Error('M3_STAGE_RESUME_RESULT_UNTRUSTED');
 return d;
}

/** Explicit admin ABANDON: never asserts NOT_APPLIED or unlocks unknown writes. */
export async function m3AbandonUncertain(operationId,headers={},fetchImpl=globalThis.fetch){
 if(!UUID.test(operationId??''))throw Error('M3_ABANDON_OPERATION_INVALID');
 const d=await req(`/operations/${operationId}/abandon`,{},headers,fetchImpl);
 if(d.operationId!==operationId||d.disposition!=='ABANDONED_UNCERTAIN_LOCK_RETAINED'||
  d.physicalOutcome!=='NOT_PROVEN'||d.lockReleaseAuthorized!==false||d.replayAllowed!==false)
  throw Error('M3_ABANDON_RESULT_UNTRUSTED');
 return d;
}
export async function m3InspectAbandonment(operationId,headers={},fetchImpl=globalThis.fetch){
 if(!UUID.test(operationId??''))throw Error('M3_ABANDON_OPERATION_INVALID');
 const d=await req(`/operations/${operationId}/abandonment`,null,headers,fetchImpl);
 if(d.operationId!==operationId||d.disposition!=='ABANDONED_UNCERTAIN_LOCK_RETAINED'||
  d.physicalOutcome!=='NOT_PROVEN'||d.lockReleaseAuthorized!==false||d.replayAllowed!==false)
  throw Error('M3_ABANDON_RECORD_UNTRUSTED');return d;
}

/** M4a LanceDB source-bound lifecycle surface. Delete uses one-use plans. Unlike the Qdrant M3
 * pane it never presents destructive plans as available. The saved selector is
 * re-attested by the server on every request; no local path or physical name. */
async function lanceLifecycleRequest(endpoint,body,headers={},fetchImpl=globalThis.fetch){
 const result=await guardedVectorFetch('/api/plugins/similharity/v2/m4a/lancedb/'+endpoint,{
  method:body===null?'GET':'POST',credentials:'same-origin',cache:'no-store',
  headers:{...headers,...(body===null?{}:{'Content-Type':'application/json'})},
  ...(body===null?{}:{body:JSON.stringify(body)})},fetchImpl);
 let data;try{data=await result.json();}catch{throw Error('M4A_RESPONSE_INVALID');}
 if(!result.ok||data?.success!==true)throw Error(data?.code??'M4A_REQUEST_REFUSED');
 return data;
}
export async function m4aLancePreview(source,headers={},fetchImpl=globalThis.fetch){
 const d=await lanceLifecycleRequest('collections/preview',{backend:'lancedb',source},headers,fetchImpl);
 if(d.backend!=='lancedb'||!KEY.test(d.logicalKey??'')||d.ownerVerified!==true||
   d.completePhysicalInventory!==true||!Number.isSafeInteger(d.recordCount)||d.recordCount<0||
   d.operationModes?.backup!=='ENABLED'||!['ENABLED','BLOCKED'].includes(d.operationModes?.delete)||
   d.productionWritesEnabled!==false)throw Error('M4A_PREVIEW_UNTRUSTED');
 return d;
}
export async function m4aLanceBackup(source,headers={},fetchImpl=globalThis.fetch){
 const d=await lanceLifecycleRequest('backups/create',{backend:'lancedb',source,
  confirmation:'CAPTURE OWNED LOGICAL BACKUP'},headers,fetchImpl);
 if(d.backend!=='lancedb'||!UUID.test(d.backupId??'')||!KEY.test(d.logicalKey??'')||
   d.state!=='VERIFIED'||d.physicalBackupVerified!==true||d.productionCertified!==false)
  throw Error('M4A_BACKUP_UNVERIFIED');
 return d;
}
export async function m4aLancePlanDelete(source,backupId,headers={},fetchImpl=globalThis.fetch){
 if(!UUID.test(backupId??''))throw Error('M4A_DELETE_BACKUP_ID_INVALID');
 const d=await lanceLifecycleRequest('collections/delete/plan',
  {backend:'lancedb',source,backupId},headers,fetchImpl);
 if(d.backend!=='lancedb'||d.state!=='PLANNED'||!UUID.test(d.operationId??'')||
   d.backupId!==backupId||!KEY.test(d.logicalKey??'')||
   d.requiredConfirmation!=='DELETE OWNED LANCEDB COLLECTION'||d.oneUse!==true||
   !Number.isSafeInteger(d.expiresAt)||d.productionCertified!==false)
   throw Error('M4A_DELETE_PLAN_UNVERIFIED');
 return d;
}
export async function m4aLanceExecuteDelete(operationId,headers={},fetchImpl=globalThis.fetch){
 if(!UUID.test(operationId??''))throw Error('M4A_DELETE_OPERATION_ID_INVALID');
 const d=await lanceLifecycleRequest('collections/delete/execute',
  {operationId,confirmation:'DELETE OWNED LANCEDB COLLECTION'},headers,fetchImpl);
 if(d.backend!=='lancedb'||d.state!=='VERIFIED'||d.operationId!==operationId||
    !KEY.test(d.logicalKey??'')||d.physicalAbsent!==true||
    d.registryTombstoned!==true||d.productionCertified!==false)
   throw Error('M4A_DELETE_OUTCOME_UNVERIFIED');
 return d;
}
export async function m4aLancePlanTransition(source,backupId,action,headers={},fetchImpl=globalThis.fetch){
 if(!UUID.test(backupId??'')||!['restore','empty'].includes(action))throw Error('M4A_TRANSITION_INPUT_INVALID');
 const d=await lanceLifecycleRequest('collections/transition/plan',
  {backend:'lancedb',source,backupId,action},headers,fetchImpl);
 const consent=action==='restore'?'RESTORE OWNED LANCEDB COLLECTION':'EMPTY OWNED LANCEDB COLLECTION';
 if(d.backend!=='lancedb'||d.state!=='PLANNED'||d.action!==action||
    !UUID.test(d.operationId??'')||d.backupId!==backupId||!KEY.test(d.logicalKey??'')||
    d.requiredConfirmation!==consent||d.oneUse!==true||d.oldPhysicalRetained!==true||
    !Number.isSafeInteger(d.expiresAt)||d.productionCertified!==false)
  throw Error('M4A_TRANSITION_PLAN_UNVERIFIED');
 return d;
}
export async function m4aLanceExecuteTransition(operationId,action,headers={},fetchImpl=globalThis.fetch){
 if(!UUID.test(operationId??'')||!['restore','empty'].includes(action))throw Error('M4A_TRANSITION_INPUT_INVALID');
 const d=await lanceLifecycleRequest('collections/transition/execute',
  {operationId,confirmation:action==='restore'?'RESTORE OWNED LANCEDB COLLECTION':'EMPTY OWNED LANCEDB COLLECTION'},headers,fetchImpl);
 if(d.backend!=='lancedb'||d.state!=='VERIFIED'||d.action!==action||
    d.operationId!==operationId||!KEY.test(d.logicalKey??'')||
    !Number.isSafeInteger(d.generation)||d.generation<1||
    d.oldPhysicalRetained!==true||d.productionCertified!==false||
    (action==='empty'&&d.verifiedEmpty!==true)||
    (action==='restore'&&(!Number.isSafeInteger(d.restoredCount)||d.restoredCount<0)))
  throw Error('M4A_TRANSITION_OUTCOME_UNVERIFIED');
 return d;
}
export async function m4aLanceVerify(backupId,headers={},fetchImpl=globalThis.fetch){
 if(!UUID.test(backupId??''))throw Error('M4A_BACKUP_ID_INVALID');
 const d=await lanceLifecycleRequest(`backups/${backupId}/verify`,null,headers,fetchImpl);
 if(d.backend!=='lancedb'||d.backupId!==backupId||d.integrityVerified!==true||
  !KEY.test(d.logicalKey??''))throw Error('M4A_BACKUP_UNVERIFIED');
 return d;
}
export function renderM4aLanceLifecyclePanel(root,doc=globalThis.document){
 if(!root?.append||!doc?.createElement)return false;
 const section=doc.createElement('section');section.className='vecthare-m4a-lancedb-lifecycle';
 const title=doc.createElement('h4');title.textContent='LanceDB — owned collection lifecycle (M4a)';
 const description=doc.createElement('p');description.textContent='Source-attested logical backup, guarded collection deletion, fresh-generation restore and scoped empty. Every destructive action requires an immutable backup and one-use typed confirmation; historical tables are retained on cutover.';
 const sourceMode=doc.createElement('select');
 for(const [value,label] of [['chat','Current saved chat'],['lorebook','World Info lorebook']]){
  const option=doc.createElement('option');option.value=value;option.textContent=label;sourceMode.append(option);
 }
 const lore=doc.createElement('input');lore.type='text';lore.placeholder='Exact lorebook name';
 const preview=doc.createElement('button');preview.type='button';preview.textContent='Preview LanceDB inventory';
 const backup=doc.createElement('button');backup.type='button';backup.textContent='Capture LanceDB logical backup';backup.disabled=true;
 const backupId=doc.createElement('input');backupId.type='text';backupId.placeholder='LanceDB backup UUID';
 const verify=doc.createElement('button');verify.type='button';verify.textContent='Verify LanceDB backup';
 const deletePlan=doc.createElement('button');deletePlan.type='button';deletePlan.textContent='Plan owned LanceDB collection deletion';
 const deleteExecute=doc.createElement('button');deleteExecute.type='button';deleteExecute.textContent='Execute one-use LanceDB deletion';deleteExecute.disabled=true;
 const transitionPlan=doc.createElement('button');transitionPlan.type='button';transitionPlan.textContent='Plan LanceDB restore / scoped empty';
 const transitionAction=doc.createElement('select');
 for(const [value,label] of [['restore','Restore to a fresh generation'],['empty','Scoped empty (retain old generation)']]){const opt=doc.createElement('option');opt.value=value;opt.textContent=label;transitionAction.append(opt);}
 const transitionExecute=doc.createElement('button');transitionExecute.type='button';transitionExecute.textContent='Execute one-use LanceDB transition';transitionExecute.disabled=true;
 let plannedTransition=null;
 let plannedDelete=null;
 const status=doc.createElement('p');status.setAttribute('role','status');
 const headers=async()=>{const m=await import('../../../../../script.js');return m.getRequestHeaders();};
 const chosenSource=async()=>{if(sourceMode.value==='lorebook'){
  const name=lore.value.trim();if(!name||name.length>220)throw Error('Exact lorebook name required');
  return {kind:'lorebook',name};}
  const m=await import('../../../../../script.js');return f02CurrentChatSelector({getChatId:m.getCurrentChatId,
   getContext:()=>globalThis.SillyTavern?.getContext?.()});};
 let current=null;
 preview.addEventListener('click',async()=>{try{
  const selected=await chosenSource(),proof=await m4aLancePreview(selected,await headers());
  current={selected,proof};backup.disabled=false;plannedDelete=null;deleteExecute.disabled=true;
  status.textContent=`LanceDB ${proof.logicalKey.slice(0,12)}: ${proof.recordCount} owned records. Backup, restore and scoped empty available when live safety checks pass. Deletion only for canonical collections.`;
 }catch(e){current=null;backup.disabled=true;status.textContent=`LanceDB preview refused: ${e.message}`;}});
 backup.addEventListener('click',async()=>{try{
  if(!current||JSON.stringify(await chosenSource())!==JSON.stringify(current.selected))throw Error('Source changed; preview again');
  if(!globalThis.confirm?.('Save a sensitive plaintext backup of the verified owned LanceDB vectors in private server storage?'))return;
  const result=await m4aLanceBackup(current.selected,await headers());backupId.value=result.backupId;
  status.textContent=`LanceDB backup ${result.backupId} verified: ${result.count} records. Manual host acceptance pending.`;
 }catch(e){status.textContent=`LanceDB backup refused: ${e.message}`;}});
 verify.addEventListener('click',async()=>{try{
  const result=await m4aLanceVerify(backupId.value.trim(),await headers());
  status.textContent=`LanceDB backup ${result.backupId}: ${result.recordCount} records; integrity verified.`;
 }catch(e){status.textContent=`LanceDB verification refused: ${e.message}`;}});
 deletePlan.addEventListener('click',async()=>{try{
  plannedDelete=null;deleteExecute.disabled=true;
  const selected=await chosenSource();
  const verified=await m4aLanceVerify(backupId.value.trim(),await headers());
  if(!globalThis.confirm?.(`Plan permanent deletion of the owned LanceDB collection backed up as ${verified.backupId}?`))return;
  const plan=await m4aLancePlanDelete(selected,verified.backupId,await headers());
  plannedDelete={plan,selected};deleteExecute.disabled=false;
  status.textContent=`Deletion plan ${plan.operationId} expires ${new Date(plan.expiresAt).toLocaleString()}. Requires exact typed consent.`;
 }catch(e){status.textContent=`LanceDB deletion plan refused: ${e.message}`;}});
 deleteExecute.addEventListener('click',async()=>{try{
  if(!plannedDelete||JSON.stringify(await chosenSource())!==JSON.stringify(plannedDelete.selected))
   throw Error('Source changed; replan deletion');
  const code=globalThis.prompt?.('Irreversible collection deletion. Type DELETE OWNED LANCEDB COLLECTION to confirm:');
  if(code!=='DELETE OWNED LANCEDB COLLECTION')throw Error('Exact typed confirmation required');
  const id=plannedDelete.plan.operationId;plannedDelete=null;deleteExecute.disabled=true;
  const result=await m4aLanceExecuteDelete(id,await headers());
  status.textContent=`Owned LanceDB collection deleted. Tombstone verified. Receipt operation ${result.operationId}.`;
  current=null;backup.disabled=true;
 }catch(e){plannedDelete=null;deleteExecute.disabled=true;
  status.textContent=`LanceDB deletion refused or uncertain: ${e.message}. Do not replay if dispatched; inspect retained locks.`;}});
 transitionPlan.addEventListener('click',async()=>{try{
  plannedTransition=null;transitionExecute.disabled=true;
  const selected=await chosenSource(),action=transitionAction.value;
  const verified=await m4aLanceVerify(backupId.value.trim(),await headers());
  if(!globalThis.confirm?.(`Plan ${action} with owned LanceDB backup ${verified.backupId}? The old collection will be retained.`))return;
  const plan=await m4aLancePlanTransition(selected,verified.backupId,action,await headers());
  plannedTransition={plan,selected,action};transitionExecute.disabled=false;
  status.textContent=`LanceDB ${action} plan ${plan.operationId}. Expires ${new Date(plan.expiresAt).toLocaleString()}; exact typed consent required.`;
 }catch(e){status.textContent=`LanceDB transition planning refused: ${e.message}`;}});
 transitionExecute.addEventListener('click',async()=>{try{
  if(!plannedTransition||JSON.stringify(await chosenSource())!==JSON.stringify(plannedTransition.selected)||
     transitionAction.value!==plannedTransition.action)throw Error('Source/action changed; replan');
  const required=plannedTransition.plan.requiredConfirmation;
  if(globalThis.prompt?.(`Type ${required} to confirm:`)!==required)throw Error('Exact typed confirmation required');
  const {plan,action}=plannedTransition;plannedTransition=null;transitionExecute.disabled=true;
  const result=await m4aLanceExecuteTransition(plan.operationId,action,await headers());
  status.textContent=`LanceDB ${action} verified. Active generation ${result.generation}; prior physical table retained. Operation ${result.operationId}.`;
  current=null;backup.disabled=true;
 }catch(e){plannedTransition=null;transitionExecute.disabled=true;
  status.textContent=`LanceDB transition refused or uncertain: ${e.message}. Never blindly retry a dispatched operation.`;}});
 section.append(title,description,sourceMode,lore,preview,backup,backupId,verify,deletePlan,deleteExecute,transitionAction,transitionPlan,transitionExecute,status);root.append(section);return true;
}

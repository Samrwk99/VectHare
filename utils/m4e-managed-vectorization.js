/** M4e: user-initiated saved-source vectorization through M1/S04 only.
 * No browser text, vectors, hash inventory, arbitrary physical collections or
 * implicit legacy writes. This is NOT unattended M5 reconciliation. */
import {m1Capabilities,m1Preflight,m1Preview,m1PrepareCollection,m1ProvisionCollection,m1Plan,m1Apply} from './m1-record-gui.js';
import {f02CurrentChatSelector} from './f02-public-read-client.js';

export const M4E_BACKENDS=Object.freeze(['qdrant','lancedb','vectra','milvus']);
const sourceKinds=new Set(['chat','group-chat','lorebook']);
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
export function m4eSavedSource(contentType,selection,{getChatId,getContext}={}){
 if(contentType==='chat'){
  if(selection?.type!=='current')throw Error('M4E_UNSAVED_OR_UPLOADED_CHAT_REQUIRES_IMPORT');
  return f02CurrentChatSelector({getChatId,getContext});
 }
 if(contentType==='lorebook'){
  if(selection?.type!=='select'||typeof selection.name!=='string'||!selection.name.trim()||selection.name.length>220)
   throw Error('M4E_UNSAVED_LOREBOOK_REQUIRES_IMPORT');
  return {kind:'lorebook',name:selection.name.trim()};
 }
 throw Error('M4E_SOURCE_REGISTRATION_REQUIRED');
}
function validateSource(source){
 if(!plain(source)||!sourceKinds.has(source.kind)||Object.keys(source).some(k=>!['kind','avatar','chatFile','groupId','name'].includes(k)))
  throw Error('M4E_SOURCE_SELECTOR_INVALID');
 if(source.kind==='lorebook'){
  if(typeof source.name!=='string'||!source.name.trim()||source.name.length>220||Object.keys(source).some(k=>!['kind','name'].includes(k)))throw Error('M4E_SOURCE_SELECTOR_INVALID');
 }else if(typeof source.chatFile!=='string'||!source.chatFile||source.chatFile.length>256||
  (source.kind==='chat'&&(typeof source.avatar!=='string'||!source.avatar.endsWith('.png')))||
  (source.kind==='group-chat'&&(typeof source.groupId!=='string'||!source.groupId)))throw Error('M4E_SOURCE_SELECTOR_INVALID');
 return source;
}
/** One explicit batch consent; each record still gets its own short-lived M1
 * plan, verified S04 execution and a separately persisted operation receipt.
 * A failed/uncertain response stops the batch: NEVER retry automatically. */
export async function m4eVectorizeSavedSource({backend,source,configId='default',headers={},fetchImpl=globalThis.fetch,
 confirm=globalThis.confirm,progress=()=>{},checkSource=async()=>source,mode='sync',signal,pauseGate=async()=>{},requireProfile=true}={}){
 if(!M4E_BACKENDS.includes(backend))throw Error('M4E_BACKEND_NOT_MANAGED');
 if(!['sync','insert','repair','registry'].includes(mode))throw Error('M4E_MODE_INVALID');
 validateSource(source);
 if(backend!=='qdrant'&&configId!=='default')throw Error('M4E_CONFIG_NOT_ALLOWED');
 if(!['default','local'].includes(configId))throw Error('M4E_CONFIG_NOT_ALLOWED');
 if(typeof confirm!=='function')throw Error('M4E_EXPLICIT_CONSENT_UNAVAILABLE');
 const sameSource=async()=>{
  const latest=validateSource(await checkSource());
  if(JSON.stringify(latest)!==JSON.stringify(source))throw Error('M4E_SAVED_SOURCE_CHANGED_STOPPED');
 };
 const safePoint=async()=>{if(signal?.aborted)throw Error('M4E_USER_ABORTED_CHECK_RECEIPTS');await pauseGate(signal);if(signal?.aborted)throw Error('M4E_USER_ABORTED_CHECK_RECEIPTS');await sameSource();};
 await safePoint();
 if(requireProfile){
  const profile=await m1Preflight(source,configId,headers,fetchImpl,backend);
  if(!profile.configured)throw Error('M1_EMBEDDING_PROFILE_REQUIRED: Open Server-managed embeddings, save a profile and run Test server embedding. No vector database operation was attempted.');
  if(!profile.ready)throw Error(`M1_EMBEDDING_NOT_VERIFIED (${profile.connectionState}): Test server embedding before vectorizing.`);
 }
 const caps=await m1Capabilities(headers,fetchImpl,backend);
 // P-B.8: registry-only reconciliation must not need vector INSERT permission.
 // For mixed Repair, permission is checked against each actual planned action.
 const hasInsert=caps.some(c=>c.operation==='insert'&&c.enabled===true);
 const hasUpdate=caps.some(c=>c.operation==='update'&&c.enabled===true);
 if((mode==='insert'||mode==='sync')&&!hasInsert)throw Error('M4E_INSERT_NOT_ENABLED');
 if(mode==='registry'&&!hasUpdate)throw Error('PB8_REGISTRY_UPDATE_NOT_ENABLED');
 if(mode==='repair'&&!hasInsert&&!hasUpdate)throw Error('M4E_REPAIR_MUTATIONS_NOT_ENABLED');
 let preview;
 try{preview=await m1Preview(source,configId,headers,fetchImpl,backend,null,(mode==='repair'||mode==='registry'));}
 catch(err){
  // Only an explicit, identified unprovisioned outcome may trigger setup.
  // Never treat an arbitrary failed read/timeout/ownership problem as empty.
  if(mode==='registry')throw err;
  if(!hasInsert)throw Error('M4E_INSERT_NOT_ENABLED');
  if(!['M1_PROVISION_RECEIPT_REQUIRED','F02_COLLECTION_NOT_BOUND','F02_COLLECTION_UNPROVISIONED','M1_COLLECTION_UNPROVISIONED'].includes(err?.message))throw err;
  await sameSource();
  const plan=await m1PrepareCollection(source,configId,headers,fetchImpl,backend);
  if(!confirm(`Create a new server-owned ${backend} collection for this SAVED source? Operation ${plan.operationId}. No existing collection will be overwritten.`))
   return {status:'cancelled',inserted:0,sourceProvisioned:false};
  await m1ProvisionCollection(plan.operationId,headers,fetchImpl,backend);
  await sameSource();
  preview=await m1Preview(source,configId,headers,fetchImpl,backend,null,(mode==='repair'||mode==='registry'));
 }
 // Source snapshots and ownership are re-attested by the server on every
 // cursor page and again on every record plan/apply. No browser-provided offset.
 const total=preview.totalRecords??preview.records.length;
 if(!Number.isSafeInteger(total)||total<0)throw Error('M4E_INVENTORY_COUNT_INVALID');
 if(!confirm(mode==='registry'
  ?`Reconcile REGISTRY ONLY for ${total} saved ${source.kind} records on ${backend}? Only physically verified, current and owned records may receive M1 repair-registry tickets. NO vectors will be inserted, updated or deleted. Missing/foreign/pending records remain review items.`
  :`Process the complete ${total}-record SAVED ${source.kind} source using managed ${backend} plans? This run will insert/update only eligible records. Conflicting ownership and uncertain operations require review. You can stop at a safe checkpoint; every mutation needs its own verified receipt.`))
  return {status:'cancelled',inserted:0,totalRecords:total};
 let inserted=0,processed=0,skipped=0,review=0,seen=0,cursor=null,pages=0;
 const repaired={missingRestored:0,outdatedUpdated:0,registryReconciled:0,alreadyVerified:0};
 const fingerprint=preview.fileFingerprint,logicalKey=preview.logicalKey;
 const orphanReview=preview.orphanReview??0;
 const snapshotTotal=total;
 do{
  await safePoint();
  if(pages++>=2000)throw Error('M4E_PAGE_COUNT_LIMIT');
  if(preview?.backend&&preview.backend!==backend)throw Error('M4E_PREVIEW_BACKEND_MISMATCH');
  if(preview?.completeSavedSource!==true||!Array.isArray(preview.records)||preview.records.length>50)
   throw Error('M4E_PREVIEW_OUT_OF_BOUNDS');
  if((preview.totalRecords??snapshotTotal)!==snapshotTotal||preview.logicalKey!==logicalKey||
   (fingerprint!==undefined&&preview.fileFingerprint!==fingerprint)||
   (preview.offset!==undefined&&preview.offset!==seen))throw Error('M4E_SOURCE_INVENTORY_CHANGED_STOPPED');
  if(preview.records.length===0&&preview.nextCursor)throw Error('M4E_EMPTY_PAGE_WITH_CURSOR');
  for(const record of preview.records){
   await safePoint();
   let action=null;
   if(['repair','registry'].includes(mode)&&!['VERIFIED','MISSING','CONFLICT'].includes(record.physicalState))
    throw Error('M4E_REPAIR_PHYSICAL_EVIDENCE_REQUIRED');
   if(mode==='repair'&&record.physicalState==='MISSING'&&record.managedState==='ACTIVE'&&
    record.availableActions?.includes('repair-missing'))action='repair-missing';
   else if(['repair','registry'].includes(mode)&&record.physicalState==='VERIFIED'&&record.availableActions?.includes('repair-registry'))action='repair-registry';
   else if(mode==='repair'&&record.physicalState==='MISSING'&&record.managedState==='DELETED'&&
    record.availableActions?.includes('restore'))action='restore';
   else if(mode!=='registry'&&record.managedState==='UNTRACKED'&&record.availableActions?.includes('insert'))action='insert';
   else if(mode!=='insert'&&mode!=='registry'&&record.managedState==='ACTIVE'&&record.changed===true&&
    (mode!=='repair'||record.physicalState==='VERIFIED')&&record.availableActions?.includes('update'))action='update';
   if(action){
    // A previewed recovery action does not override the current safety matrix.
    // Disabled operations become per-record review items, not a whole-run error.
    const permission=['update','repair-registry'].includes(action)?'update':'insert';
    if(!caps.some(c=>c.operation===permission&&c.enabled===true)){
     skipped++;review++;processed++;
     progress({inserted,processed,total:snapshotTotal,skipped,remainingReview:review+orphanReview,
      recordId:record.recordId,action:'review-disabled-'+permission});
     continue;
    }
    try{
     const plan=await m1Plan({logicalKey,source,configId,recordId:record.recordId,action,backend,expectedFileFingerprint:fingerprint},headers,fetchImpl);
     await safePoint();
     await m1Apply(plan.operationId,headers,fetchImpl);
     inserted++;
     if(mode==='repair'||mode==='registry'){
      if(action==='repair-missing'||action==='restore')repaired.missingRestored++;
      else if(action==='repair-registry')repaired.registryReconciled++;
      else if(action==='update')repaired.outdatedUpdated++;
     }
    }catch(err){
     // A submitted, lost or uncertain response must never be retried blindly.
     const error=new Error(`M4E_BATCH_STOPPED_AFTER_${inserted}_OF_${snapshotTotal}: ${err?.message||'unknown error'}; review the M1/S04 receipt before resuming`);
     error.inserted=inserted;error.processed=processed;error.total=snapshotTotal;error.cause=err;throw error;
    }
   }else{
    skipped++;
    if(['repair','registry'].includes(mode)&&record.physicalState==='VERIFIED'&&record.managedState==='ACTIVE'&&!record.changed&&!record.registryMismatch)repaired.alreadyVerified++;
    if((mode==='registry'&&record.physicalState==='VERIFIED'&&
       !(record.managedState==='ACTIVE'&&!record.changed&&!record.registryMismatch))||
      (mode==='registry'&&record.physicalState!=='VERIFIED')||
      (mode==='registry'&&record.changed===true)||
      record.managedState==='DELETED'||(record.managedState!=='UNTRACKED'&&record.managedState!=='ACTIVE')||
      (mode==='insert'&&record.changed===true)||
      (['repair','registry'].includes(mode)&&record.physicalState==='CONFLICT')||
      (['repair','registry'].includes(mode)&&record.managedState==='ACTIVE'&&record.physicalState!=='VERIFIED')||
      (record.managedState==='UNTRACKED'&&!record.availableActions?.includes('insert')))review++;
   }
   processed++;
   progress({inserted,processed,total:snapshotTotal,skipped,remainingReview:review+orphanReview,
    recordId:record.recordId,action:action??'skipped'});
  }
  seen+=preview.records.length;
  cursor=preview.nextCursor??null;
  if(cursor){
   if(seen>=snapshotTotal)throw Error('M4E_CURSOR_AFTER_END');
   await safePoint();
   preview=await m1Preview(source,configId,headers,fetchImpl,backend,cursor,['repair','registry'].includes(mode));
  }
 }while(cursor);
 if(seen!==snapshotTotal||inserted+skipped!==snapshotTotal)throw Error('M4E_INVENTORY_INCOMPLETE_NO_SUCCESS');
 const remainingReview=review+orphanReview;
 return {status:remainingReview?'review-required':mode==='registry'?(inserted?'registry-reconciled':'no-registry-changes'):inserted?'inserted':'no-new-records',inserted,
  processed,skipped,total:snapshotTotal,totalRecords:snapshotTotal,remainingReview,orphanReview,
  complete:true,fullyReconciled:remainingReview===0,previewBounded:false,...(['repair','registry'].includes(mode)?{repaired}:{}),...(mode==='registry'?{registryOnly:true,physicalCollectionInventoryVerified:false}:{})};
}
/** Runtime bridge for the ordinary Sync Chat button; caller must be user-initiated. */
export async function m4eVectorizeCurrentChat(settings,{getChatId,getContext,getHeaders,confirm,progress,fetchImpl,mode='sync',signal,pauseGate}={}){
 const backend=settings?.vector_backend;
 if(!M4E_BACKENDS.includes(backend))throw Error('M4E_BACKEND_NOT_MANAGED');
 const selector=()=>f02CurrentChatSelector({getChatId,getContext});
 const source=await selector();
 return m4eVectorizeSavedSource({backend,source,
  configId:backend==='qdrant'&&settings?.qdrant_use_cloud!==true?'local':'default',
  headers:await getHeaders(),fetchImpl,confirm,progress,checkSource:selector,mode,signal,pauseGate});
}

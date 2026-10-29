/** F09b continuation: normal saved-chat v2 sync PLAN UI.
 * It cannot insert, edit or delete vectors and rejects server permission overclaims.
 */
import {guardedVectorFetch} from './e02-vector-request-gateway.js';
import {f02CurrentChatSelector} from './f02-public-read-client.js';
const URI='/api/plugins/similharity/v2/workflows/chat-sync-plan';
const APPLY='/api/plugins/similharity/v2/workflows/chat-sync-pilot-apply';
const LIFECYCLE='/api/plugins/similharity/v2/workflows/chat-lifecycle-pilot';
const ORPHAN='/api/plugins/similharity/v2/workflows/chat-orphan-pilot';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function validateF09bSyncPlan(result){
 if(result?.success!==true||result.status!=='READ_ONLY_SYNC_PLAN'||result.sourceVerified!==true||
  result.recordIdentity!=='V2_STABLE_HOST_MESSAGE_UUID'||result.productionWritesEnabled!==false||
  result.automaticMutationsEnabled!==false||result.completeInventory!==false||result.deletionsPlanned!==false||
  !Array.isArray(result.actions)||result.actions.length>80||!result.counts||
  !/^[a-f0-9]{64}$/.test(result.sourceRevisionFingerprint||''))throw Error('F09B_SYNC_CONTRACT_UNVERIFIED');
 const allowed=new Set(['CREATE_PENDING_EMBEDDING','UPDATE_PENDING_EMBEDDING','IN_SYNC']);
 const seen=new Set(),counts={create:0,update:0,inSync:0};
 for(const item of result.actions){
  if(!UUID.test(item?.recordId||'')||seen.has(item.recordId)||!allowed.has(item.action)||
   !Number.isSafeInteger(item.expectedRevision)||
   (item.action==='CREATE_PENDING_EMBEDDING' ? item.expectedRevision!==0:item.expectedRevision<1))
   throw Error('F09B_SYNC_PLAN_INVALID');
  seen.add(item.recordId);
  counts[item.action==='CREATE_PENDING_EMBEDDING'?'create':item.action==='UPDATE_PENDING_EMBEDDING'?'update':'inSync']++;
 }
 if(!Object.keys(counts).every(k=>result.counts[k]===counts[k])||result.sourceMessagesChecked!==result.actions.length)
  throw Error('F09B_SYNC_COUNTS_INVALID');
 return result;
}
export async function f09bPreviewChatSync(body,headers={},fetchImpl=globalThis.fetch){
 if(!['qdrant','lancedb','vectra','milvus'].includes(body?.backend)||
  !['chat','group-chat'].includes(body?.source?.kind))throw Error('F09B_SYNC_REQUEST_INVALID');
 const r=await guardedVectorFetch(URI,{method:'POST',credentials:'same-origin',cache:'no-store',
  headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(body)},fetchImpl);
 let data;try{data=await r.json();}catch{throw Error('F09B_SYNC_RESPONSE_INVALID');}
 if(!r.ok)throw Error(data?.code||`F09B_SYNC_HTTP_${r.status}`);
 return validateF09bSyncPlan(data);
}
export async function f09b3ApplyOneChatSync(body,headers={},fetchImpl=globalThis.fetch){
 if(!['qdrant','lancedb','vectra','milvus'].includes(body?.backend)||
  body.configId!==(body.backend==='qdrant'?'local':'default')||
  body.experimentalConsent!=='I ACCEPT LOCAL CHAT SYNC PILOT'||
  !/^[a-f0-9]{64}$/.test(body.sourceRevisionFingerprint||''))throw Error('F09B3_SYNC_REQUEST_INVALID');
 const r=await guardedVectorFetch(APPLY,{method:'POST',credentials:'same-origin',cache:'no-store',
  headers:{...headers,'Content-Type':'application/json','X-VectHare-F09b3-Pilot':'1'},
  body:JSON.stringify(body)},fetchImpl);
 let data;try{data=await r.json();}catch{throw Error('F09B3_SYNC_RESPONSE_INVALID');}
 if(!r.ok)throw Error(data?.code||`F09B3_SYNC_HTTP_${r.status}`);
 if(data?.experimental!==true||data.productionWritesEnabled!==false||
   !['IN_SYNC','VERIFIED','UNCERTAIN'].includes(data.status)||
   !Number.isSafeInteger(data.applied)||data.applied<0||data.applied>1||
   !Number.isSafeInteger(data.remaining)||data.remaining<0)
  throw Error('F09B3_SYNC_RESPONSE_UNVERIFIED');
 return data;
}
export async function f09b4LifecyclePilot(body,headers={},fetchImpl=globalThis.fetch){
 const consents={delete:'I ACCEPT EXACT MESSAGE VECTOR DELETE PILOT',
  revector:'I ACCEPT EXACT MESSAGE REVECTOR PILOT'};
 if(!['qdrant','lancedb','vectra','milvus'].includes(body?.backend)||
    body.configId!==(body.backend==='qdrant'?'local':'default')||
    !['delete','revector','inspect'].includes(body.action)||
    !Number.isSafeInteger(body.messageIndex)||body.messageIndex<0||body.messageIndex>=80||
    !/^[a-f0-9]{64}$/.test(body.sourceRevisionFingerprint||'')||
    (body.action==='inspect'?!UUID.test(body.operationId||'')||body.experimentalConsent!==undefined:
      body.experimentalConsent!==consents[body.action]||body.operationId!==undefined))
  throw Error('F09B4_LIFECYCLE_REQUEST_INVALID');
 const r=await guardedVectorFetch(LIFECYCLE,{method:'POST',credentials:'same-origin',cache:'no-store',
  headers:{...headers,'Content-Type':'application/json','X-VectHare-F09b4-Pilot':'1'},body:JSON.stringify(body)},fetchImpl);
 let data;try{data=await r.json();}catch{throw Error('F09B4_LIFECYCLE_RESPONSE_INVALID');}
 if(!r.ok && !(r.status===202&&data?.status==='UNCERTAIN'))throw Error(data?.code||`F09B4_HTTP_${r.status}`);
 if(data?.experimental!==true||data.productionWritesEnabled!==false||data.retryable!==false||
    !['VERIFIED','UNCERTAIN','RECEIPT_INSPECTED'].includes(data.status)||!UUID.test(data.operationId||'')||
    (data.status==='RECEIPT_INSPECTED'?!['PREPARED','SUBMITTED','UNCERTAIN','VERIFIED','FAILED'].includes(data.state):
       data.action!==body.action||!UUID.test(data.recordId||'')))
  throw Error('F09B4_LIFECYCLE_RESPONSE_UNVERIFIED');
 return data;
}
export async function f09b4ManagedOrphanPilot(body,headers={},fetchImpl=globalThis.fetch){
 if(!['qdrant','lancedb','vectra','milvus'].includes(body?.backend)||
    !['preview','delete','inspect'].includes(body?.mode)||
    body.configId!==(body.backend==='qdrant'?'local':'default')||
    (body.mode==='delete'&&!/^[a-f0-9]{64}$/.test(body.sourceRevisionFingerprint||''))||
    (body.mode==='preview'&&(body.orphanIndex!==undefined||body.experimentalConsent!==undefined||body.registryFingerprint!==undefined||body.operationId!==undefined||body.sourceRevisionFingerprint!==undefined))||
    (body.mode==='inspect'&&(!UUID.test(body.operationId||'')||body.orphanIndex!==undefined||body.registryFingerprint!==undefined||body.experimentalConsent!==undefined||body.sourceRevisionFingerprint!==undefined))||
    (body.mode==='delete'&&(!Number.isSafeInteger(body.orphanIndex)||body.orphanIndex<0||body.orphanIndex>=2000||
      !/^[a-f0-9]{64}$/.test(body.registryFingerprint||'')||
      body.experimentalConsent!=='I ACCEPT VERIFIED MANAGED ORPHAN DELETE PILOT')))
  throw Error('F09B4_ORPHAN_REQUEST_INVALID');
 const r=await guardedVectorFetch(ORPHAN,{method:'POST',credentials:'same-origin',cache:'no-store',
  headers:{...headers,'Content-Type':'application/json','X-VectHare-F09b4-Pilot':'1'},body:JSON.stringify(body)},fetchImpl);
 let data;try{data=await r.json();}catch{throw Error('F09B4_ORPHAN_RESPONSE_INVALID');}
 if(!r.ok&&!(r.status===202&&data?.status==='UNCERTAIN'))throw Error(data?.code||`F09B4_ORPHAN_HTTP_${r.status}`);
 if(data?.success!==true&&data?.status!=='UNCERTAIN')throw Error('F09B4_ORPHAN_RESPONSE_UNVERIFIED');
 if(data.experimental!==true||data.productionWritesEnabled!==false||data.retryable!==false)throw Error('F09B4_ORPHAN_RESPONSE_UNVERIFIED');
 if(body.mode==='preview'){
  if(data.status!=='MANAGED_ORPHAN_PREVIEW'||data.sourceVerified!==true||
     data.completeBackendInventory!==false||data.legacyOrphansNotDiscoverable!==true||
     !/^[a-f0-9]{64}$/.test(data.registryFingerprint||'')||! /^[a-f0-9]{64}$/.test(data.sourceRevisionFingerprint||'')||
     !Number.isSafeInteger(data.orphanCount)||data.orphanCount<0||
     !Number.isSafeInteger(data.pendingCount)||data.pendingCount<0||
     !Number.isSafeInteger(data.tombstoneCount)||data.tombstoneCount<0||
     !Array.isArray(data.orphans)||data.orphans.length!==data.orphanCount||
     data.orphans.some((o,i)=>o.index!==i||!Number.isSafeInteger(o.revision)||o.revision<1||
      !UUID.test(o.recordId||'')||typeof o.textPreview!=='string'||o.textPreview.length>100))
   throw Error('F09B4_ORPHAN_RESPONSE_UNVERIFIED');
 }else if(body.mode==='inspect'){
  if(data.status!=='MANAGED_RECEIPT_INSPECTED'||!UUID.test(data.operationId||'')||
    !['PREPARED','SUBMITTED','UNCERTAIN','VERIFIED','FAILED'].includes(data.state)||
    !['WRITE_PENDING','DELETE_PENDING'].includes(data.managedState)||data.automaticallyReconciled!==false)
   throw Error('F09B4_ORPHAN_RESPONSE_UNVERIFIED');
 }else if(!['VERIFIED','UNCERTAIN'].includes(data.status)||!UUID.test(data.operationId||'')||
   !UUID.test(data.recordId||'')||data.action!=='managed-orphan-delete')
  throw Error('F09B4_ORPHAN_RESPONSE_UNVERIFIED');
 return data;
}
export function renderF09bChatSyncPreview(root,getSettings,doc=globalThis.document){
 if(!root||!doc?.createElement||root.querySelector?.('#vecthare_f09b_sync_preview'))return false;
 const panel=doc.createElement('section');panel.id='vecthare_f09b_sync_preview';
 const title=doc.createElement('h4');title.textContent='F09b — saved chat synchronization preview';
 const info=doc.createElement('p');info.textContent='Reads the saved chat on the SillyTavern server, derives stable IDs, and compares each against your source-owned v2 collection. No vectors are written; deletions are not inferred from incomplete inventory. Requires unique message dates/speakers.';
 const button=doc.createElement('button');button.type='button';button.textContent='Check current saved chat against v2 vectors (read-only)';
 const status=doc.createElement('div');status.setAttribute('role','status');
 const pilotLabel=doc.createElement('label');
 const optIn=doc.createElement('input');optIn.type='checkbox';optIn.id='vecthare_f09b3_consent';
 pilotLabel.append(optIn,doc.createTextNode(' I explicitly consent to local v2 PILOT writes from the saved chat (no deletion).'));
 const applyButton=doc.createElement('button');applyButton.type='button';
 applyButton.textContent='F09b.3 — sync up to 5 pending chat vectors (pilot)';
 applyButton.addEventListener('click',async()=>{
  applyButton.disabled=true;
  try{
   if(!optIn.checked)throw Error('Check the explicit local pilot consent first');
   const {getRequestHeaders,getCurrentChatId}=await import('../../../../../script.js');
   const source=await f02CurrentChatSelector({getChatId:getCurrentChatId,getContext:()=>globalThis.SillyTavern?.getContext?.()});
   const settings=getSettings?.()||{};const embedding={source:settings.f09b_embedding_source||settings.source||'webllm',
    model:settings.f09b_embedding_model,dimension:Number(settings.f09b_embedding_dimension),
    metric:settings.f09b_embedding_metric};
   if(embedding.source==='webllm')throw Error('Pilot requires a host/server embedding provider, not WebLLM. Create the v2 collection using the exact same provider/model.');
   const backend=settings.f09b_backend||'qdrant';
   if(!['qdrant','lancedb','vectra','milvus'].includes(backend)||
      (backend==='qdrant'&&settings.qdrant_use_cloud===true))
    throw Error('This pilot requires a supported local plugin backend.');
   const base={backend,source,embedding,configId:backend==='qdrant'?'local':'default'};
   const headers=getRequestHeaders();
   let applied=0,lastRemaining=0;
   for(let i=0;i<5;i++){
    // A chat switch during the user-confirmed batch must terminate immediately.
    const current=await f02CurrentChatSelector({getChatId:getCurrentChatId,
     getContext:()=>globalThis.SillyTavern?.getContext?.()});
    if(JSON.stringify(current)!==JSON.stringify(source))throw Error('Active chat changed; pilot batch stopped');
    const preview=await f09bPreviewChatSync(base,headers);
    lastRemaining=preview.counts.create+preview.counts.update;
    if(!lastRemaining)break;
    const result=await f09b3ApplyOneChatSync({...base,sourceRevisionFingerprint:preview.sourceRevisionFingerprint,
     experimentalConsent:'I ACCEPT LOCAL CHAT SYNC PILOT'},headers);
    if(result.status==='UNCERTAIN'){
     status.textContent=`${applied} previously verified; UNCERTAIN operation ${result.operationId}. Do not retry blindly.`;
     return;
    }
    if(result.status!=='VERIFIED'||result.applied!==1)throw Error('Unexpected pilot result; stopped');
    applied++;lastRemaining=result.remaining;
    status.textContent=`Verified ${applied} record(s). ${lastRemaining} pending; verifying next step…`;
   }
   status.textContent=`Verified ${applied} saved-chat record(s). ${lastRemaining} remaining (if any). Refresh preview before another batch.`;
  }catch(e){status.textContent=`Sync pilot refused: ${e?.message||'unknown'}`;}
  finally{applyButton.disabled=false;optIn.checked=false;}
 });
 button.addEventListener('click',async()=>{
  button.disabled=true;status.textContent='Attesting saved chat and inspecting v2 records…';
  try{
   const {getRequestHeaders,getCurrentChatId}=await import('../../../../../script.js');
   const source=await f02CurrentChatSelector({getChatId:getCurrentChatId,getContext:()=>globalThis.SillyTavern?.getContext?.()});
   const settings=getSettings?.()||{};
   const model=settings.f09b_embedding_model,dimension=Number(settings.f09b_embedding_dimension),metric=settings.f09b_embedding_metric;
   const backend=settings.f09b_backend||'qdrant';
   if(!model||!Number.isSafeInteger(dimension)||dimension<1)throw Error('Configure F09b embedding model and dimension first');
   const result=await f09bPreviewChatSync({backend,source,embedding:{source:settings.f09b_embedding_source||settings.source||'webllm',model,dimension,metric},
    configId:backend==='qdrant'&&settings.qdrant_use_cloud!==true?'local':'default'},getRequestHeaders());
   status.textContent=`Saved chat verified: ${result.counts.create} missing, ${result.counts.update} changed, ${result.counts.inSync} matched. Read-only: no insert/delete, no complete inventory or production write permission.`;
  }catch(e){status.textContent=`Sync preview unavailable: ${e?.message||'unknown'}`;}
  finally{button.disabled=false;}
 });
 // F09b.4 — single explicitly selected message, not arbitrary record IDs.
 const lifecycleInfo=doc.createElement('p');
 lifecycleInfo.textContent='F09b.4 (development pilot): revectorize or delete the vector for one existing saved message. The ordinal is the index in the verified synchronization preview (starting at 0). It cannot clean up already-removed messages; do not use on valuable collections.';
 const indexLabel=doc.createElement('label');indexLabel.textContent='Saved message index (0-based) ';
 const messageIndex=doc.createElement('input');messageIndex.type='number';messageIndex.min='0';messageIndex.max='79';messageIndex.step='1';messageIndex.value='0';
 indexLabel.append(messageIndex);
 const lifecycleConsentLabel=doc.createElement('label');
 const lifecycleConsent=doc.createElement('input');lifecycleConsent.type='checkbox';
 lifecycleConsentLabel.append(lifecycleConsent,doc.createTextNode(' I explicitly consent to the selected exact-record pilot action.'));
 const revButton=doc.createElement('button');revButton.type='button';revButton.textContent='F09b.4 — revector selected saved message';
 const delButton=doc.createElement('button');delButton.type='button';delButton.textContent='F09b.4 — DELETE selected saved-message vector';
 const receiptId=doc.createElement('input');receiptId.type='text';receiptId.placeholder='Operation UUID for receipt inspection';
 const receiptButton=doc.createElement('button');receiptButton.type='button';receiptButton.textContent='Inspect F09b.4 receipt (read-only)';
 const lastReceipt={value:null};
 const runLifecycle=async(action,control)=>{
  control.disabled=true;
  try{
   if(action!=='inspect'&&!lifecycleConsent.checked)throw Error('Explicit consent is required');
   const {getRequestHeaders,getCurrentChatId}=await import('../../../../../script.js');
   const source=await f02CurrentChatSelector({getChatId:getCurrentChatId,getContext:()=>globalThis.SillyTavern?.getContext?.()});
   const settings=getSettings?.()||{};
   const backend=settings.f09b_backend||'qdrant';
   if(backend==='qdrant'&&settings.qdrant_use_cloud===true)throw Error('Local pilot only');
   const base={backend,source,configId:backend==='qdrant'?'local':'default',embedding:{
    source:settings.f09b_embedding_source||settings.source||'webllm',model:settings.f09b_embedding_model,
    dimension:Number(settings.f09b_embedding_dimension),metric:settings.f09b_embedding_metric}};
   if(base.embedding.source==='webllm')throw Error('Server embedding provider required for this pilot');
   const idx=Number(messageIndex.value);
   if(!Number.isSafeInteger(idx)||idx<0||idx>=80)throw Error('Choose a saved message index from 0 to 79');
   const headers=getRequestHeaders();
   const plan=await f09bPreviewChatSync(base,headers);
   if(!plan.actions[idx])throw Error('Selected message is not in the verified saved-chat preview');
   if(action==='delete'&&plan.actions[idx].action!=='IN_SYNC')throw Error('Delete requires a vector matching the saved message; first resolve its changed state');
   if(action==='revector'&&plan.actions[idx].action==='CREATE_PENDING_EMBEDDING')throw Error('No saved vector to revectorize');
   if(action==='inspect'&&!UUID.test(receiptId.value.trim()))throw Error('Enter a valid operation UUID');
   // Refuse a switch between reading the saved selector and dispatching.
   const current=await f02CurrentChatSelector({getChatId:getCurrentChatId,getContext:()=>globalThis.SillyTavern?.getContext?.()});
   if(JSON.stringify(current)!==JSON.stringify(source))throw Error('Active chat changed; operation stopped');
   const extra=action==='inspect'?{operationId:receiptId.value.trim()}:
    {experimentalConsent:action==='delete'?'I ACCEPT EXACT MESSAGE VECTOR DELETE PILOT':'I ACCEPT EXACT MESSAGE REVECTOR PILOT'};
   const result=await f09b4LifecyclePilot({...base,sourceRevisionFingerprint:plan.sourceRevisionFingerprint,
    messageIndex:idx,action,...extra},headers);
   lastReceipt.value=result.operationId;receiptId.value=result.operationId;
   status.textContent=result.status==='UNCERTAIN'?`UNCERTAIN ${result.operationId}. Inspect the receipt; do not retry.`:
    action==='inspect'?`Receipt ${result.operationId}: ${result.state}. Observation: ${result.readbackObservation||'unavailable'}. No automatic reconciliation or retry.`:
    `F09b.4 ${action}: ${result.status}; operation ${result.operationId}. This is not production activation.`;
  }catch(e){status.textContent=`F09b.4 ${action} refused: ${e?.message||'unknown'}`;}
  finally{control.disabled=false;lifecycleConsent.checked=false;}
 };
 revButton.addEventListener('click',()=>runLifecycle('revector',revButton));
 delButton.addEventListener('click',()=>runLifecycle('delete',delButton));
 receiptButton.addEventListener('click',()=>runLifecycle('inspect',receiptButton));
 // F09b.4 completion: separate managed orphan preview + explicitly confirmed
 // exact deletion. No backend enumeration, no legacy/untracked record cleanup.
 const orphanTitle=doc.createElement('p');orphanTitle.textContent='F09b.4 managed orphan cleanup (pilot): only previously server-registered v2 records absent from the saved chat. Untracked or legacy vectors cannot be deleted here.';
 const orphanPreviewButton=doc.createElement('button');orphanPreviewButton.type='button';orphanPreviewButton.textContent='Preview managed orphan vectors (read-only)';
 const orphanIndexLabel=doc.createElement('label');orphanIndexLabel.textContent='Managed orphan index (0-based) ';
 const orphanIndex=doc.createElement('input');orphanIndex.type='number';orphanIndex.min='0';orphanIndex.step='1';orphanIndex.value='0';orphanIndexLabel.append(orphanIndex);
 const orphanConsentLabel=doc.createElement('label');const orphanConsent=doc.createElement('input');orphanConsent.type='checkbox';
 orphanConsentLabel.append(orphanConsent,doc.createTextNode(' I explicitly consent to deleting one verified managed orphan vector (development pilot).'));
 const orphanDeleteButton=doc.createElement('button');orphanDeleteButton.type='button';orphanDeleteButton.textContent='DELETE selected managed orphan vector (pilot)';
 let orphanPreview=null;
 const orphanBase=async()=>{
  const {getRequestHeaders,getCurrentChatId}=await import('../../../../../script.js');
  const source=await f02CurrentChatSelector({getChatId:getCurrentChatId,getContext:()=>globalThis.SillyTavern?.getContext?.()});
  const settings=getSettings?.()||{},backend=settings.f09b_backend||'qdrant';
  if(backend==='qdrant'&&settings.qdrant_use_cloud===true)throw Error('Local pilot only');
  const embedding={source:settings.f09b_embedding_source||settings.source||'webllm',model:settings.f09b_embedding_model,
   dimension:Number(settings.f09b_embedding_dimension),metric:settings.f09b_embedding_metric};
  if(embedding.source==='webllm')throw Error('Server embedding profile required');
  return {base:{backend,source,embedding,configId:backend==='qdrant'?'local':'default'},
   headers:getRequestHeaders(),getChatId:getCurrentChatId};
 };
 orphanPreviewButton.addEventListener('click',async()=>{
  orphanPreviewButton.disabled=true;orphanPreview=null;
  try{
   const {base,headers}=await orphanBase();
   const result=await f09b4ManagedOrphanPilot({...base,mode:'preview'},headers);
   orphanPreview={...base,sourceRevisionFingerprint:result.sourceRevisionFingerprint,registryFingerprint:result.registryFingerprint,orphanCount:result.orphanCount};
   status.textContent=`Managed orphan preview: ${result.orphanCount} eligible, ${result.pendingCount} blocked pending operations, ${result.tombstoneCount} tombstones. Legacy/untracked vectors excluded. No deletion performed.`;
  }catch(e){status.textContent=`Managed orphan preview refused: ${e?.message||'unknown'}`;}
  finally{orphanPreviewButton.disabled=false;}
 });
 orphanDeleteButton.addEventListener('click',async()=>{
  orphanDeleteButton.disabled=true;
  try{
   if(!orphanConsent.checked||!orphanPreview)throw Error('Preview the managed orphans and give explicit consent first');
   const idx=Number(orphanIndex.value);
   if(!Number.isSafeInteger(idx)||idx<0||idx>=orphanPreview.orphanCount)throw Error('Select a valid managed orphan index');
   const {base,headers,getChatId}=await orphanBase();
   if(JSON.stringify(base)!==JSON.stringify({backend:orphanPreview.backend,source:orphanPreview.source,
    embedding:orphanPreview.embedding,configId:orphanPreview.configId}))throw Error('Source or embedding profile changed');
   const result=await f09b4ManagedOrphanPilot({...base,sourceRevisionFingerprint:orphanPreview.sourceRevisionFingerprint,
    registryFingerprint:orphanPreview.registryFingerprint,orphanIndex:idx,mode:'delete',
    experimentalConsent:'I ACCEPT VERIFIED MANAGED ORPHAN DELETE PILOT'},headers);
   orphanPreview=null;
   status.textContent=result.status==='UNCERTAIN'?`UNCERTAIN orphan deletion ${result.operationId}; do not retry.`:
    `Verified managed orphan deletion ${result.operationId}; refresh preview. Production writes remain disabled.`;
  }catch(e){status.textContent=`Managed orphan deletion refused: ${e?.message||'unknown'}`;}
  finally{orphanDeleteButton.disabled=false;orphanConsent.checked=false;}
 });
 const orphanReceiptInput=doc.createElement('input');orphanReceiptInput.type='text';orphanReceiptInput.placeholder='Pending managed operation UUID';
 const orphanInspectButton=doc.createElement('button');orphanInspectButton.type='button';orphanInspectButton.textContent='Inspect pending managed operation (read-only)';
 orphanInspectButton.addEventListener('click',async()=>{
  orphanInspectButton.disabled=true;
  try{const {base,headers}=await orphanBase();const operationId=orphanReceiptInput.value.trim();
   if(!UUID.test(operationId))throw Error('Enter a valid managed operation UUID');
   const result=await f09b4ManagedOrphanPilot({...base,mode:'inspect',operationId},headers);
   status.textContent=`Managed receipt ${result.operationId}: ${result.state}, ${result.managedState}. ${result.readbackObservation}. No automatic retry or reconciliation.`;
  }catch(e){status.textContent=`Managed receipt inspection refused: ${e?.message||'unknown'}`;}
  finally{orphanInspectButton.disabled=false;}
 });
 panel.append(orphanTitle,orphanPreviewButton,orphanIndexLabel,orphanConsentLabel,orphanDeleteButton,
  orphanReceiptInput,orphanInspectButton);
 panel.append(title,info,button,pilotLabel,applyButton,lifecycleInfo,indexLabel,lifecycleConsentLabel,
  revButton,delButton,receiptId,receiptButton,status);root.prepend(panel);return true;
}

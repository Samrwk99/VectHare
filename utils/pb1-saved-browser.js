import {publishManagedViewInvalidation,watchManagedViewInvalidation} from './pb11-managed-view-coherence.js';
/** P-B.1: source-authoritative managed-v2 saved-record browser.
 * This is NOT a whole physical collection listing; orphan/foreign records and
 * historical generations are intentionally excluded. Never reuse the legacy
 * hash-based chunk editor, group metadata writer or collection-delete path.
 */
import {guardedVectorFetch} from './e02-vector-request-gateway.js';
import {f02CurrentChatSelector} from './f02-public-read-client.js';
import {m1Preflight,m1Plan,m1Apply,m1Capabilities} from './m1-record-gui.js';
import {auditManagedSavedSource,verifyQdrantPhysicalProof} from './pb2-authoritative-audit.js';
import {verifyManagedRecordReadback} from './pb3-managed-record-readback.js';
import {commitSavedChatTextEdit} from './pb5-managed-chat-edit.js';
import {commitSavedLorebookTextEdit} from './pb7-managed-lorebook-edit.js';
import {m4eVectorizeSavedSource} from './m4e-managed-vectorization.js';

const ROOT='/api/plugins/similharity/v2/m1/records/browse';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY=/^[a-f0-9]{64}$/;
const BACKENDS=['qdrant','lancedb','vectra','milvus'];
export const SAFE_BROWSER_ACTIONS=Object.freeze(['insert','update','revectorize','delete','restore','repair-missing','repair-registry']);

/** Exact response validation. Browser never upgrades this to physical completeness. */
export function validateSavedBrowserPage(result){
 if(!result||result.success!==true||result.readOnly!==true||result.sourceAuthoritative!==true||
  result.inventoryKind!=='SAVED_SOURCE_RECORDS'||result.inventoryVerified!==false||
  result.physicalInventoryComplete!==false||result.completeSavedSource!==true||
  !KEY.test(result.logicalKey??'')||!KEY.test(result.fileFingerprint??'')||
  !KEY.test(result.registryFingerprint??'')||
  !Number.isSafeInteger(result.routingGeneration)||result.routingGeneration<0||
  !Number.isSafeInteger(result.sourceSelectionGeneration)||result.sourceSelectionGeneration<0||
  !Number.isSafeInteger(result.totalRecords)||result.totalRecords<0||
  !Number.isSafeInteger(result.offset)||result.offset<0||
  result.offset>result.totalRecords||!Array.isArray(result.records)||result.records.length>50||
  result.offset+result.records.length>result.totalRecords||
  (result.nextCursor!==null&&(typeof result.nextCursor!=='string'||result.nextCursor.length>2048||!/^[-_A-Za-z0-9]+\.[-_A-Za-z0-9]+$/.test(result.nextCursor)))||
  (result.nextCursor===null?result.offset+result.records.length!==result.totalRecords:result.offset+result.records.length>=result.totalRecords)||
  Boolean(result.pageComplete)!==(result.nextCursor===null)||
  result.records.some(row=>!UUID.test(row?.recordId??'')||
   !['VERIFIED','MISSING','CONFLICT'].includes(row.physicalState)||
   typeof row.savedText!=='string'||row.savedText.length>8192||
   typeof row.savedTextTruncated!=='boolean'||!Array.isArray(row.availableActions)||
   row.availableActions.some(action=>!SAFE_BROWSER_ACTIONS.includes(action))||
   (row.lorebookUid!==undefined&&(!Number.isSafeInteger(row.lorebookUid)||row.lorebookUid<0))||
   (row.chatLocator!==undefined&&(typeof row.chatLocator!=='object'||!row.chatLocator||
    !['string','number'].includes(typeof row.chatLocator.sendDate)||
    typeof row.chatLocator.name!=='string'||typeof row.chatLocator.isUser!=='boolean'||
    Object.keys(row.chatLocator).some(k=>!['sendDate','name','isUser'].includes(k))))))
  throw Error('PB1_BROWSER_PAGE_UNVERIFIED');
 if(new Set(result.records.map(row=>row.recordId)).size!==result.records.length)
  throw Error('PB1_BROWSER_DUPLICATE_RECORD_ID');
 if(result.totalRecords>0&&result.records.length===0)throw Error('PB1_BROWSER_EMPTY_PARTIAL_PAGE');
 return result;
}
export async function readSavedBrowserPage({backend,source,configId='default',cursor=null,headers={},fetchImpl=globalThis.fetch}){
 if(!BACKENDS.includes(backend)||!source||typeof source!=='object'||
  (backend!=='qdrant'&&configId==='local'))throw Error('PB1_BROWSER_SELECTOR_INVALID');
 const body={backend,source,configId,verifyPhysical:true,...(cursor?{cursor}:{})};
 const response=await guardedVectorFetch(ROOT,{method:'POST',credentials:'same-origin',cache:'no-store',
  headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(body)},fetchImpl);
 let result;try{result=await response.json();}catch{throw Error('PB1_BROWSER_RESPONSE_INVALID');}
 if(!response.ok||result?.success!==true)throw Error(result?.code??'PB1_BROWSER_REFUSED');
 return validateSavedBrowserPage(result);
}
/** A modal-local UI; never writes metadata or imports raw DB records. */
export function renderSavedBrowser(root,doc=globalThis.document){
 if(!root||!doc?.createElement||root.querySelector?.('#vecthare_pb1_saved_browser'))return false;
 const section=doc.createElement('section');section.id='vecthare_pb1_saved_browser';
 const title=doc.createElement('h4');title.textContent='Managed saved records (source-authoritative)';
 const detail=doc.createElement('p');detail.textContent='Authenticated saved chat / lorebook records only. Each page verifies physical records and the source revision. This is NOT a complete physical collection inventory. Edit verified saved chat or lorebook text here; VectHare saves the source first, then requests a managed vector update. Legacy/foreign records are excluded.';
 const backend=doc.createElement('select');backend.setAttribute('aria-label','Managed backend');
 for(const b of BACKENDS){const option=doc.createElement('option');option.value=b;option.textContent=b;backend.append(option);}
 const kind=doc.createElement('select');kind.setAttribute('aria-label','Saved source');
 for(const [v,label] of [['chat','Current saved chat'],['lorebook','Saved lorebook']]){const option=doc.createElement('option');option.value=v;option.textContent=label;kind.append(option);}
 const lorebook=doc.createElement('input');lorebook.type='text';lorebook.placeholder='Exact saved lorebook name';
 const config=doc.createElement('select');for(const c of ['default','local']){const option=doc.createElement('option');option.value=c;option.textContent=c;config.append(option);}
 const refresh=doc.createElement('button');refresh.type='button';refresh.textContent='Inspect managed saved source';
 const audit=doc.createElement('button');audit.type='button';audit.textContent='Audit all saved records';
 const registryRepair=doc.createElement('button');registryRepair.type='button';registryRepair.textContent='Reconcile verified server registry';registryRepair.disabled=true;
 const qdrantProof=doc.createElement('button');qdrantProof.type='button';qdrantProof.textContent='Verify Qdrant whole physical inventory';
 const back=doc.createElement('button');back.type='button';back.textContent='Previous page';back.disabled=true;
 const next=doc.createElement('button');next.type='button';next.textContent='Next page';next.disabled=true;
 const record=doc.createElement('select');record.setAttribute('aria-label','Verified source record');
 const text=doc.createElement('pre');text.style.cssText='max-height:180px;overflow:auto;white-space:pre-wrap;word-break:break-word;';
 const action=doc.createElement('select');for(const a of SAFE_BROWSER_ACTIONS){const o=doc.createElement('option');o.value=a;o.textContent=a;action.append(o);}
 const apply=doc.createElement('button');apply.type='button';apply.textContent='Plan and confirm record action';apply.disabled=true;
 const editText=doc.createElement('textarea');editText.setAttribute('aria-label','Saved source text editor');
 editText.rows=5;editText.maxLength=8192;editText.disabled=true;
 const saveText=doc.createElement('button');saveText.type='button';saveText.textContent='Save source text and update managed vector';saveText.disabled=true;
 const status=doc.createElement('p');status.setAttribute('role','status');
 let page=null,source=null,history=[],busy=false,caps=[],epoch=0,pageCursor=null;
 const conf=()=>backend.value==='qdrant'?config.value:'default';
 const getHeaders=async()=>{const {getRequestHeaders}=await import('../../../../../script.js');return getRequestHeaders();};
 const readSource=async()=>{if(kind.value==='lorebook'){
  const name=lorebook.value.trim();if(!name||name.length>220)throw Error('Exact saved lorebook name required');return {kind:'lorebook',name};
 }
 const {getCurrentChatId}=await import('../../../../../script.js');
 return f02CurrentChatSelector({getChatId:getCurrentChatId,getContext:()=>globalThis.SillyTavern?.getContext?.()});};
 const selected=()=>page?.records.find(row=>row.recordId===record.value);
 const reset=()=>{epoch++;page=null;source=null;caps=[];history=[];pageCursor=null;record.replaceChildren();text.textContent='';editText.value='';
  back.disabled=true;next.disabled=true;apply.disabled=true;registryRepair.disabled=true;editText.disabled=true;saveText.disabled=true;};
 watchManagedViewInvalidation(reason=>{reset();status.textContent=`Managed saved records expired (${reason}); refresh to re-attest.`;},{identity:section,document:doc,window:doc.defaultView??globalThis.window});
 const render=()=>{
  const priorRecord=record.value;record.replaceChildren();for(const row of page.records){const o=doc.createElement('option');o.value=row.recordId;
   o.textContent=`${row.recordId.slice(0,8)} rev ${row.revision}: ${row.displayStatus}`;record.append(o);}
  if(page.records.some(r=>r.recordId===priorRecord))record.value=priorRecord;
  const chosen=selected();text.textContent=chosen?.savedText??'';
  editText.value=chosen?.savedText??'';
  editText.disabled=!((kind.value==='chat'&&chosen?.chatLocator)||
   (kind.value==='lorebook'&&Number.isSafeInteger(chosen?.lorebookUid)))||!!chosen?.savedTextTruncated||!(
   chosen.managedState==='ACTIVE'&&chosen.physicalState==='VERIFIED'&&!chosen.changed&&
   caps.some(c=>c.operation==='update'&&c.enabled===true));
  saveText.disabled=editText.disabled;
  if(chosen?.savedTextTruncated)text.textContent+='\n[Preview truncated: saved message is longer than 8192 characters]';
  back.disabled=history.length===0;next.disabled=!page.nextCursor;
  const supported=caps.some(c=>c.operation===(action.value==='restore'||action.value==='repair-missing'?'insert':action.value==='repair-registry'?'update':action.value)&&c.enabled===true);
  apply.disabled=!chosen||!chosen.availableActions.includes(action.value)||!supported;
  registryRepair.disabled=!caps.some(c=>c.operation==='update'&&c.enabled===true);
  status.textContent=`${page.records.length?page.offset+1:0}-${page.offset+page.records.length} of ${page.totalRecords} saved records (0 means provisioned empty). ${page.orphanReview} registry orphans require independent inventory. Collection-wide completeness UNVERIFIED. ${chosen?.displayStatus??'No records'}.`;
 };
 const checkIdentity=async()=>{const actual=await readSource();if(JSON.stringify(actual)!==JSON.stringify(source))throw Error('Saved source changed; refresh required');};
 const load=async(cursor=null,nav='reset')=>{
  if(busy)return;busy=true;refresh.disabled=true;next.disabled=true;back.disabled=true;apply.disabled=true;
  try{
   if(nav==='reset'){reset();source=await readSource();}
   else await checkIdentity();
   const version=epoch,selectedBackend=backend.value,selectedConfig=conf(),selectedKind=kind.value;
   const h=await getHeaders(),ready=await m1Preflight(source,conf(),h,globalThis.fetch,backend.value);
   if(!ready.ready)throw Error('Managed embedding profile is not verified. Configure/test it first.');
   const incoming=await readSavedBrowserPage({backend:backend.value,source,configId:conf(),cursor,headers:h});
   // A chat switch, tab change, or selector edit during a pending read must
   // never paint the previous saved source into the newly selected context.
   if(version!==epoch||backend.value!==selectedBackend||conf()!==selectedConfig||kind.value!==selectedKind)
    throw Error('PB1_BROWSER_SELECTION_CHANGED');
   await checkIdentity();
   if(version!==epoch)throw Error('PB1_BROWSER_SELECTION_CHANGED');
   if(page&&(page.logicalKey!==incoming.logicalKey||page.fileFingerprint!==incoming.fileFingerprint||
    page.registryFingerprint!==incoming.registryFingerprint||
    page.routingGeneration!==incoming.routingGeneration||
    page.sourceSelectionGeneration!==incoming.sourceSelectionGeneration||page.totalRecords!==incoming.totalRecords))
    throw Error('PB1_BROWSER_SOURCE_OR_GENERATION_CHANGED');
   if(nav==='next')history.push({cursor:history.length?history.at(-1).nextCursor:null,nextCursor:cursor});
   if(nav==='back')history.pop();
   const nextCaps=await m1Capabilities(h,globalThis.fetch,backend.value);
   await checkIdentity();
   if(version!==epoch||backend.value!==selectedBackend||conf()!==selectedConfig||kind.value!==selectedKind)
    throw Error('PB2_BROWSER_SELECTION_CHANGED_DURING_CAPABILITIES');
   caps=nextCaps;page=incoming;pageCursor=cursor;render();
  }catch(err){reset();status.textContent=err.message==='M1_COLLECTION_UNPROVISIONED'
   ?'UNPROVISIONED: no managed physical collection is bound to this saved source. Not a verified empty collection.'
   :`Managed browser UNVERIFIED: ${err.message}. No legacy inventory fallback.`;}
  finally{busy=false;refresh.disabled=false;}
 };
 // Deliberately audits saved-source records, not arbitrary physical collection IDs.
 audit.addEventListener('click',async()=>{
  if(busy)return;busy=true;const serial=++epoch;
  refresh.disabled=true;audit.disabled=true;qdrantProof.disabled=true;apply.disabled=true;
  try{
   const chosenSource=await readSource(),chosenBackend=backend.value,chosenConfig=conf();
   const h=await getHeaders(),ready=await m1Preflight(chosenSource,chosenConfig,h,globalThis.fetch,chosenBackend);
   if(!ready.ready)throw Error('M1_EMBEDDING_PROFILE_UNVERIFIED');
   const result=await auditManagedSavedSource({readPage:cursor=>readSavedBrowserPage({
    backend:chosenBackend,source:chosenSource,configId:chosenConfig,cursor,headers:h}),
    shouldContinue:()=>serial===epoch&&backend.value===chosenBackend&&conf()===chosenConfig&&
      JSON.stringify(source??chosenSource)===JSON.stringify(chosenSource),
    onPage:({examined,total})=>{status.textContent=`Auditing saved records: ${examined}/${total} verified page positions. Not a physical collection inventory.`;}});
   await checkAuditSource(chosenSource);
   if(serial!==epoch)throw Error('PB2_AUDIT_SELECTION_CHANGED');
   status.textContent=`SAVED SOURCE AUDIT COMPLETE: ${result.examined} of ${result.total} rows; ${result.physicallyVerified} physically verified, ${result.missing} missing, ${result.conflicts} conflicts, ${result.registryMismatches} registry discrepancies, ${result.sourceChanged} outdated saved-text records. ${result.orphanReview} registry orphans. WHOLE PHYSICAL COLLECTION: UNVERIFIED. No writes performed.`;
  }catch(err){status.textContent=`Saved-source audit UNVERIFIED: ${err.message}. No legacy fallback.`;}
  finally{busy=false;refresh.disabled=false;audit.disabled=false;qdrantProof.disabled=false;}
 });
 const checkAuditSource=async(expected)=>{const actual=await readSource();if(JSON.stringify(actual)!==JSON.stringify(expected))throw Error('PB2_AUDIT_SOURCE_CHANGED');};
 qdrantProof.addEventListener('click',async()=>{
  if(busy)return;busy=true;qdrantProof.disabled=true;audit.disabled=true;refresh.disabled=true;
  const serial=++epoch;
  try{
   if(backend.value!=='qdrant')throw Error('PB2_QDRANT_ONLY_OTHER_BACKENDS_UNVERIFIED');
   const selectedSource=await readSource(),selectedConfig=conf(),h=await getHeaders();
   const response=await guardedVectorFetch('/api/plugins/similharity/v2/m3/collections/managed-inventory',{
    method:'POST',credentials:'same-origin',cache:'no-store',headers:{...h,'Content-Type':'application/json'},
    body:JSON.stringify({backend:'qdrant',source:selectedSource,configId:selectedConfig})});
   let result;try{result=await response.json();}catch{throw Error('PB2_PHYSICAL_PROOF_RESPONSE_INVALID');}
   if(!response.ok||result?.success!==true)throw Error(result?.code??'PB2_PHYSICAL_PROOF_REFUSED');
   verifyQdrantPhysicalProof(result);
   await checkAuditSource(selectedSource);
   if(serial!==epoch||backend.value!=='qdrant'||conf()!==selectedConfig)throw Error('PB2_PHYSICAL_PROOF_SELECTION_CHANGED');
   status.textContent=`QDRANT WHOLE PHYSICAL INVENTORY VERIFIED: ${result.recordCount} exclusive managed-v2 records; generation ${result.routingGeneration}, digest ${result.inventoryDigest.slice(0,16)}… . This read-only proof authorizes NO mutation or backup and does not certify the saved-source audit.`;
  }catch(err){status.textContent=`Physical inventory UNVERIFIED: ${err.message}. No legacy fallback.`;}
  finally{busy=false;qdrantProof.disabled=false;audit.disabled=false;refresh.disabled=false;}
 });
 // P-B.8: functionally reconcile only server-verified registry drift.
 // The existing M1/S04 single-use repair-registry ticket is the sole mutation
 // authority. No client collection cache, hash list or physical vector writes.
 registryRepair.addEventListener('click',async()=>{
  if(busy||!page||registryRepair.disabled)return;
  busy=true;const serial=epoch,chosenBackend=backend.value,chosenConfig=conf(),chosenSource=source;
  registryRepair.disabled=true;refresh.disabled=true;audit.disabled=true;
  try{
   const h=await getHeaders();
   publishManagedViewInvalidation({sender:section});
   const result=await m4eVectorizeSavedSource({backend:chosenBackend,configId:chosenConfig,
    source:chosenSource,headers:h,mode:'registry',checkSource:async()=>{
     if(epoch!==serial||kind.value!==chosenSource.kind||backend.value!==chosenBackend||conf()!==chosenConfig)
      throw Error('PB8_REGISTRY_BROWSER_SELECTION_CHANGED');
     return readSource();
    },confirm:message=>globalThis.confirm?.(message)===true,
    progress:p=>{if(epoch===serial)status.textContent=`Registry: ${p.processed}/${p.total}; reconciled ${p.inserted}; review ${p.remainingReview}.`;}});
   // Re-read source-bound physical evidence after every successful run.
   reset();
   if(result.status==='cancelled'){status.textContent='Registry reconciliation cancelled. No repair plans submitted.';return;}
   const fresh=await readSavedBrowserPage({backend:chosenBackend,configId:chosenConfig,source:chosenSource,headers:h});
   await checkAuditSource(chosenSource);
   status.textContent=`Registry run: ${result.repaired?.registryReconciled??0} verified corrections, ${result.remainingReview} review items; fresh source-bound page checked (${fresh.records.length} records). Physical whole-collection completeness UNVERIFIED.`;
  }catch(err){
   reset();status.textContent=`Registry reconciliation stopped/UNVERIFIED: ${err.message}. Check operation receipts before retrying.`;
  }finally{busy=false;refresh.disabled=false;audit.disabled=false;}
 });
 refresh.addEventListener('click',()=>load());
 next.addEventListener('click',()=>{if(page?.nextCursor)load(page.nextCursor,'next');});
 back.addEventListener('click',()=>{if(history.length){const previous=history.length===1?null:history.at(-2).nextCursor;load(previous,'back');}});
 record.addEventListener('change',render);action.addEventListener('change',render);
 for(const selector of [backend,kind,config,lorebook]){selector.addEventListener('change',()=>{reset();status.textContent='Selection changed; inspect source again.';});
  if(selector===lorebook)selector.addEventListener('input',()=>{reset();status.textContent='Source name edited; inspect again.';});}
 backend.addEventListener('change',()=>{config.disabled=backend.value!=='qdrant';config.value='default';});
 // P-B.7: edit the real saved chat or saved lorebook first, then update M1.
 // Other source kinds and unverified records remain unavailable.
 saveText.addEventListener('click',async()=>{
  if(busy||!page||saveText.disabled||editText.disabled)return;
  busy=true;saveText.disabled=true;apply.disabled=true;refresh.disabled=true;
  let hostSaved=false;
  try{
   const row=selected(),selectedBackend=backend.value,selectedConfig=conf();
   const chosenSource=source,original=page,originalCursor=pageCursor,serial=epoch;
   const h=await getHeaders(),context=globalThis.SillyTavern?.getContext?.();
   if(kind.value==='chat'&&!context)throw Error('PB5_HOST_CHAT_UNAVAILABLE');
   const getCurrent=async()=>{if(serial!==epoch||backend.value!==selectedBackend||conf()!==selectedConfig)
    throw Error('PB5_BROWSER_SELECTION_CHANGED');return readSource();};
   const readRecord=async(expectedId,cursor=null)=>{
    let at=cursor,first=true;const seen=new Set();
    for(let pages=0;pages<4000;pages++){
     if(at&&seen.has(at))throw Error('PB5_BROWSER_CURSOR_REPLAY');if(at)seen.add(at);
     const fresh=await readSavedBrowserPage({backend:selectedBackend,source:chosenSource,
      configId:selectedConfig,cursor:at,headers:h});
     const hit=fresh.records.find(r=>r.recordId===expectedId);if(hit)return {page:fresh,row:hit};
     if(!fresh.nextCursor)break;at=fresh.nextCursor;first=false;
    }
    throw Error('PB5_SAVED_RECORD_MISSING');
   };
   const loreMode=chosenSource.kind==='lorebook';
   const worldApi=loreMode?await import('../../../../world-info.js'):null;
   const commit=loreMode?commitSavedLorebookTextEdit:commitSavedChatTextEdit;
   if(loreMode&&(typeof worldApi?.loadWorldInfo!=='function'||typeof worldApi?.saveWorldInfo!=='function'))
    throw Error('PB7_HOST_WORLD_INFO_API_UNAVAILABLE');
   const result=await commit({source:chosenSource,recordId:row.recordId,
    ...(loreMode?{uid:row.lorebookUid,loadWorldInfo:worldApi.loadWorldInfo,
     saveWorldInfo:worldApi.saveWorldInfo}:{locator:row.chatLocator,context}),
    previousText:row.savedText,newText:editText.value,
    expectedFingerprint:original.fileFingerprint,context,getSource:getCurrent,
    checkBeforeSave:async({recordId,expectedFingerprint,previousText})=>{
     const fresh=await readSavedBrowserPage({backend:selectedBackend,source:chosenSource,
      configId:selectedConfig,cursor:originalCursor,headers:h});
     const match=fresh.records.find(r=>r.recordId===recordId);
     if(fresh.fileFingerprint!==expectedFingerprint||!match||
      match.savedText!==previousText||match.physicalState!=='VERIFIED'||
      match.managedState!=='ACTIVE'||match.changed||
      (loreMode&&match.lorebookUid!==row.lorebookUid)||!match.availableActions.includes('update'))
      throw Error('PB5_RECORD_CHANGED_BEFORE_SAVE');
    },
    readAfterSave:async id=>{hostSaved=true;publishManagedViewInvalidation({sender:section});const fresh=await readRecord(id);return {fileFingerprint:fresh.page.fileFingerprint,row:fresh.row};},
    plan:async fileFingerprint=>m1Plan({logicalKey:original.logicalKey,source:chosenSource,
     configId:selectedConfig,recordId:row.recordId,action:'update',backend:selectedBackend,
     expectedFileFingerprint:fileFingerprint},h),
    apply:async operationId=>m1Apply(operationId,h),
    verify:async id=>verifyManagedRecordReadback({recordId:id,action:'update',
     readPage:cursor=>readSavedBrowserPage({backend:selectedBackend,source:chosenSource,
      configId:selectedConfig,cursor,headers:h}),shouldContinue:()=>serial===epoch}),
    confirm:async()=>globalThis.confirm?.(loreMode
     ?'Save this edit to the actual SillyTavern lorebook, then re-embed its saved entry using M1? An unverified vector update leaves the lorebook edited and requires Repair.'
     :'Save this edit to the actual SillyTavern chat, then re-embed the saved message using the managed server? A failed vector update leaves the saved chat edited and requires Repair.')===true});
   reset();status.textContent=result.status==='VERIFIED'
    ?`Saved ${loreMode?'lorebook':'chat'} text and VERIFIED managed vector update receipt ${result.operationId}. Refresh the browser to inspect current source.`
    :'Edit cancelled; no source or vector mutation was requested.';
  }catch(err){
   reset();status.textContent=err.sourceSaveUncertain
    ?`HOST SOURCE SAVE OUTCOME UNCERTAIN: ${err.message}. Inspect the actual saved chat before any retry; no vector update was attempted.`
    :err.sourceSaved||hostSaved
    ?`SOURCE SAVED; VECTOR UPDATE UNVERIFIED: ${err.message}. Use Repair Chat or inspect receipts; do NOT blindly retry.`
    :`Saved-source edit refused without verified source persistence: ${err.message}`;
  }finally{busy=false;refresh.disabled=false;}
 });
 apply.addEventListener('click',async()=>{
  if(busy||!page)return;busy=true;apply.disabled=true;
  try{
   await checkIdentity();const chosen=selected(),name=action.value;
   if(!chosen?.availableActions.includes(name))throw Error('Action no longer available; refresh required');
   if(!caps.some(c=>c.operation===(name==='restore'||name==='repair-missing'?'insert':name==='repair-registry'?'update':name)&&c.enabled===true))throw Error('Action disabled by capability policy');
   const h=await getHeaders();const p=await m1Plan({logicalKey:page.logicalKey,source,configId:conf(),recordId:chosen.recordId,action:name,backend:backend.value,expectedFileFingerprint:page.fileFingerprint},h);
   if(!globalThis.confirm?.(`Apply ${name} to SAVED record ${chosen.recordId}? The server will check ownership, revision and backend receipts. Operation ${p.operationId}.`)){
    status.textContent='Not applied; plan expires.';return;
   }
   await checkIdentity();
   publishManagedViewInvalidation({sender:section});
   const result=await m1Apply(p.operationId,h);
   // A receipt confirms the M1 operation, but browser state may have changed.
   // Never claim a reconciled record before a *fresh* physical readback.
   const completedId=chosen.recordId,completedSource=source,completedBackend=backend.value;
   const completedConfig=conf(),serial=epoch;
   reset();
   status.textContent=`Receipt ${result.operationId} received. Verifying saved-source physical readback…`;
   try{
    const checked=await verifyManagedRecordReadback({recordId:completedId,action:name,
     readPage:cursor=>readSavedBrowserPage({backend:completedBackend,source:completedSource,
      configId:completedConfig,cursor,headers:h}),
     shouldContinue:()=>epoch===serial+1&&backend.value===completedBackend&&
      conf()===completedConfig&&JSON.stringify(completedSource)===JSON.stringify(source??completedSource)});
    await checkAuditSource(completedSource);
    if(epoch!==serial+1)throw Error('PB3_READBACK_SELECTION_CHANGED');
    status.textContent=`VERIFIED receipt ${result.operationId}; fresh physical saved-record readback confirmed ${checked.action} on ${checked.recordId}. Whole physical collection inventory remains UNVERIFIED.`;
   }catch(readErr){
    status.textContent=`Mutation receipt ${result.operationId} returned, but physical readback is UNVERIFIED (${readErr.message}). Do not blindly retry; inspect managed records and receipts.`;
   }
  }catch(err){reset();status.textContent=`Operation refused or outcome uncertain: ${err.message}. Verify receipts before any retry.`;}
  finally{busy=false;}
 });
 section.append(title,detail,backend,kind,lorebook,config,refresh,audit,registryRepair,qdrantProof,back,next,record,text,editText,saveText,action,apply,status);
 root.prepend(section);return true;
}

/** M4e: user-initiated saved-source vectorization through M1/S04 only.
 * No browser text, vectors, hash inventory, arbitrary physical collections or
 * implicit legacy writes. This is NOT unattended M5 reconciliation. */
import {m1Capabilities,m1Preview,m1PrepareCollection,m1ProvisionCollection,m1Plan,m1Apply} from './m1-record-gui.js';
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
 confirm=globalThis.confirm,progress=()=>{},checkSource=async()=>source,mode='sync'}={}){
 if(!M4E_BACKENDS.includes(backend))throw Error('M4E_BACKEND_NOT_MANAGED');
 if(!['sync','insert','repair'].includes(mode))throw Error('M4E_MODE_INVALID');
 validateSource(source);
 if(backend!=='qdrant'&&configId!=='default')throw Error('M4E_CONFIG_NOT_ALLOWED');
 if(!['default','local'].includes(configId))throw Error('M4E_CONFIG_NOT_ALLOWED');
 if(typeof confirm!=='function')throw Error('M4E_EXPLICIT_CONSENT_UNAVAILABLE');
 const sameSource=async()=>{
  const latest=validateSource(await checkSource());
  if(JSON.stringify(latest)!==JSON.stringify(source))throw Error('M4E_SAVED_SOURCE_CHANGED_STOPPED');
 };
 await sameSource();
 const caps=await m1Capabilities(headers,fetchImpl,backend);
 if(!caps.some(c=>c.operation==='insert'&&c.enabled===true))throw Error('M4E_INSERT_NOT_ENABLED');
 let preview;
 try{preview=await m1Preview(source,configId,headers,fetchImpl,backend);}
 catch(err){
  // Only an explicit, identified unprovisioned outcome may trigger setup.
  // Never treat an arbitrary failed read/timeout/ownership problem as empty.
  if(!['M1_PROVISION_RECEIPT_REQUIRED','F02_COLLECTION_NOT_BOUND','F02_COLLECTION_UNPROVISIONED','M1_COLLECTION_UNPROVISIONED'].includes(err?.message))throw err;
  await sameSource();
  const plan=await m1PrepareCollection(source,configId,headers,fetchImpl,backend);
  if(!confirm(`Create a new server-owned ${backend} collection for this SAVED source? Operation ${plan.operationId}. No existing collection will be overwritten.`))
   return {status:'cancelled',inserted:0,sourceProvisioned:false};
  await m1ProvisionCollection(plan.operationId,headers,fetchImpl,backend);
  await sameSource();
  preview=await m1Preview(source,configId,headers,fetchImpl,backend);
 }
 if(preview?.backend&&preview.backend!==backend)throw Error('M4E_PREVIEW_BACKEND_MISMATCH');
 if(preview?.completeSavedSource!==true)throw Error('M4E_PREVIEW_INCOMPLETE');
 if(!Array.isArray(preview.records)||preview.records.length>80)throw Error('M4E_PREVIEW_OUT_OF_BOUNDS');
 const targets=preview.records.flatMap(r=>{
  if(mode!=='repair'&&r.managedState==='UNTRACKED'&&r.availableActions?.includes('insert'))return [{...r,action:'insert'}];
  if(mode!=='insert'&&r.managedState==='ACTIVE'&&r.changed===true&&r.availableActions?.includes('update'))return [{...r,action:'update'}];
  return [];
 });
 const needsReview=preview.records.filter(r=>r.managedState==='DELETED'||
  (r.managedState!=='UNTRACKED'&&r.managedState!=='ACTIVE')||
  (mode==='insert'&&r.changed===true)).length;
 if(targets.length===0){progress({inserted:0,total:0,remainingReview:needsReview});return {status:needsReview?'review-required':'no-new-records',inserted:0,total:0,remainingReview:needsReview};}
 if(!confirm(`Apply ${targets.length} saved-record insert/update plans into the managed ${backend} collection? Each item gets its own verified mutation receipt. Deleted records will NOT be automatically restored or deleted. This may be a bounded 80-record preview.`))
  return {status:'cancelled',inserted:0,total:targets.length,remainingReview:needsReview};
 let inserted=0;
 for(const record of targets){
  try{
   await sameSource();
   const plan=await m1Plan({logicalKey:preview.logicalKey,source,configId,recordId:record.recordId,action:record.action,backend},headers,fetchImpl);
   await sameSource();
   await m1Apply(plan.operationId,headers,fetchImpl);
   inserted++;
   progress({inserted,total:targets.length,remainingReview:needsReview,operationId:plan.operationId,action:record.action});
  }catch(err){
   // Never continue or auto-replay after a potentially submitted mutation.
   const error=new Error(`M4E_BATCH_STOPPED_AFTER_${inserted}_OF_${targets.length}: ${err?.message||'unknown error'}; inspect mutation receipts before retrying`);
   error.inserted=inserted;error.total=targets.length;error.cause=err;throw error;
  }
 }
 // A bounded source preview is not an authoritative full collection inventory.
 return {status:needsReview?'review-required':'inserted',inserted,total:targets.length,remainingReview:needsReview,
  previewBounded:preview.records.length===80};
}
/** Runtime bridge for the ordinary Sync Chat button; caller must be user-initiated. */
export async function m4eVectorizeCurrentChat(settings,{getChatId,getContext,getHeaders,confirm,progress,fetchImpl,mode='sync'}={}){
 const backend=settings?.vector_backend;
 if(!M4E_BACKENDS.includes(backend))throw Error('M4E_BACKEND_NOT_MANAGED');
 const selector=()=>f02CurrentChatSelector({getChatId,getContext});
 const source=await selector();
 return m4eVectorizeSavedSource({backend,source,
  configId:backend==='qdrant'&&settings?.qdrant_use_cloud!==true?'local':'default',
  headers:await getHeaders(),fetchImpl,confirm,progress,checkSource:selector,mode});
}

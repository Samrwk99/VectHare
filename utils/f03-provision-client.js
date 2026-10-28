/** F03 source-bound, opt-in v2 collection schema setup.
 * This never inserts, updates or deletes any memory record.
 */
import {guardedVectorFetch} from './e02-vector-request-gateway.js';
import {f02CurrentChatSelector} from './f02-public-read-client.js';
const ROOT='/api/plugins/similharity/v2/collections';
export async function f03CollectionRequest(operation,body,headers={},fetchImpl=globalThis.fetch){
 if(!['preview','provision','status'].includes(operation))throw Error('F03_OPERATION_INVALID');
 const response=await guardedVectorFetch(`${ROOT}/${operation}`,{
  method:'POST',credentials:'same-origin',cache:'no-store',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(body)
 },fetchImpl);
 const value=await response.json();
 if(!response.ok||value?.success!==true)throw Error(value?.code||`F03_HTTP_${response.status}`);
 if(value.productionWritesEnabled!==false||value.backendCertified!==false)throw Error('F03_CAPABILITY_OVERCLAIM');
 if(operation==='preview'&&(value.physicalCollectionProvisioned!==false||value.consentRequired!==true||
   !/^vh2_[a-f0-9]{48}$/.test(value.collectionName)))throw Error('F03_PREVIEW_UNVERIFIED');
 if(operation==='status'&&typeof value.receiptState!=='string')throw Error('F03_STATUS_RESPONSE_INVALID');
 if(operation==='provision'&&(value.physicalCollectionProvisioned!==true||value.recordMutationsEnabled!==false))
  throw Error('F03_PROVISION_RESPONSE_UNVERIFIED');
 return value;
}
export function renderF03ProvisionPanel(root,getSettings,doc=globalThis.document){
 if(!root||!doc?.createElement||root.querySelector?.('#vecthare_f03_provision'))return false;
 const panel=doc.createElement('div');panel.id='vecthare_f03_provision';
 const title=doc.createElement('div');title.textContent='F03 — new v2 collection setup (Qdrant/Milvus/LanceDB)';
 const desc=doc.createElement('div');desc.textContent='Preview, then explicitly confirm creation of a NEW empty source-bound collection. No existing collections are cleared or overwritten. Memory writes remain disabled.';
 const backend=doc.createElement('select');for(const b of ['qdrant','milvus','lancedb']){const op=doc.createElement('option');op.value=b;op.textContent=b;backend.append(op);}
 const model=doc.createElement('input');model.type='text';model.placeholder='Exact embedding model identifier';
 const dimension=doc.createElement('input');dimension.type='number';dimension.min='1';dimension.max='65536';dimension.placeholder='Embedding dimension';
 const metric=doc.createElement('select');for(const m of ['cosine','dot','euclid']){const op=doc.createElement('option');op.value=m;op.textContent=m;metric.append(op);}
 const preview=doc.createElement('button');preview.type='button';preview.textContent='Preview v2 collection (no backend writes)';
 const confirm=doc.createElement('button');confirm.type='button';confirm.textContent='Confirm creation of NEW empty collection';confirm.disabled=true;
 const status=doc.createElement('button');status.type='button';status.textContent='Check previous provisioning receipt';status.disabled=true;
 const output=doc.createElement('div');output.setAttribute('role','status');
 let pending=null;
 const invalidate=()=>{pending=null;confirm.disabled=true;status.disabled=true;};
 for(const control of [backend,model,dimension,metric]){control.addEventListener?.('change',invalidate);control.addEventListener?.('input',invalidate);}
 preview.addEventListener('click',async()=>{
  invalidate();preview.disabled=true;output.textContent='Verifying saved-source ownership…';
  try{
   const {getRequestHeaders}=await import('../../../../script.js');
   const {getCurrentChatId}=await import('../../../../../script.js');
   const source=await f02CurrentChatSelector({getChatId:getCurrentChatId,getContext:()=>globalThis.SillyTavern?.getContext?.()});
   const settings=typeof getSettings==='function'?getSettings():{};
   const body={backend:backend.value,source,embedding:{source:settings?.source||'transformers',
    model:model.value.trim(),dimension:Number(dimension.value),metric:metric.value},
    configId:backend.value==='qdrant'&&settings?.qdrant_use_cloud!==true?'local':'default'};
   const result=await f03CollectionRequest('preview',body,getRequestHeaders());
   pending={body,collectionName:result.collectionName};confirm.disabled=false;status.disabled=false;
   output.textContent=`New collection name: ${result.collectionName}. Confirm ONLY if you intend to create this empty v2 collection. Existing memories are not migrated.`;
  }catch(e){output.textContent=`F03 preview refused: ${e?.message||'unknown'}`;}
  finally{preview.disabled=false;}
 });
 status.addEventListener('click',async()=>{
  if(!pending)return;
  status.disabled=true;
  try{const {getRequestHeaders}=await import('../../../../script.js');
   const result=await f03CollectionRequest('status',pending.body,getRequestHeaders());
   output.textContent=`F03 provisioning receipt: ${result.receiptState}${result.receiptCode?' ('+result.receiptCode+')':''}. Production writes remain disabled.`;
  }catch(e){output.textContent=`F03 receipt check refused: ${e?.message||'unknown'}`;}
  finally{status.disabled=false;}
 });
 confirm.addEventListener('click',async()=>{
  if(!pending)return;confirm.disabled=true;preview.disabled=true;
  const current=pending;pending=null;output.textContent='Provisioning new collection; interruption may require manual inspection…';
  try{
   const {getRequestHeaders}=await import('../../../../script.js');
   const result=await f03CollectionRequest('provision',{...current.body,confirmProvision:true,
    expectedCollectionName:current.collectionName},getRequestHeaders());
   output.textContent=`Created empty collection ${result.collectionName}. Schema checkpoint only: memory writes and full inventory are NOT enabled.`;
  }catch(e){output.textContent=`F03 creation uncertain/refused: ${e?.message||'unknown'}. Do NOT retry blindly or delete an existing collection.`;}
  finally{preview.disabled=false;}
 });
 panel.append(title,desc,backend,model,dimension,metric,preview,confirm,status,output);root.prepend(panel);return true;
}

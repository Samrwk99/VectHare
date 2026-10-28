/** F08: explicitly consented manual Milvus v2 pilot. Does not enable normal
 * VectHare /chunks writes, legacy records, or unverified shared reads. */
import {guardedVectorFetch} from './e02-vector-request-gateway.js';
import {f02CurrentChatSelector} from './f02-public-read-client.js';
export const F08_PILOT_CONSENT='I ACCEPT F08 DISPOSABLE MILVUS PILOT';
const URL='/api/plugins/similharity/v2/records/milvus-pilot-mutate';
const uuid=()=>{if(typeof globalThis.crypto?.randomUUID!=='function')throw Error('F08_SECURE_UUID_UNAVAILABLE');return globalThis.crypto.randomUUID();};
export async function f08PilotMutation(payload,headers={},fetchImpl=globalThis.fetch){
 const response=await guardedVectorFetch(URL,{method:'POST',credentials:'same-origin',cache:'no-store',
  headers:{...headers,'Content-Type':'application/json','x-vecthare-f08-pilot':'1'},body:JSON.stringify(payload)},fetchImpl);
 let data;try{data=await response.json();}catch{throw Error('F08_RESPONSE_INVALID');}
 if(!response.ok)throw Error(data?.code||`F08_HTTP_${response.status}`);
 if(data?.productionWritesEnabled!==false||data?.experimental!==true||data?.retryable!==false)
  throw Error('F08_RESPONSE_CONTRACT_INVALID');
 if(response.status===202&&data?.state==='UNCERTAIN')return data;
 if(data.success!==true||data.state!=='VERIFIED')throw Error(data?.code||`F08_HTTP_${response.status}`);
 if(data.recordId!==payload.recordId||data.operationId!==payload.operationId)throw Error('F08_RESULT_ID_MISMATCH');
 return data;
}
export async function f08OperationReceipt(operationId,headers={},fetchImpl=globalThis.fetch){
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId))
  throw Error('F08_OPERATION_ID_INVALID');
 const response=await guardedVectorFetch(`/api/plugins/similharity/v2/operations/${operationId}`,
  {method:'GET',credentials:'same-origin',cache:'no-store',headers},fetchImpl);
 let data;try{data=await response.json();}catch{throw Error('F08_RECEIPT_INVALID');}
 if(!response.ok||data.success!==true||data.operationId!==operationId||
    !['PREPARED','SUBMITTED','UNCERTAIN','VERIFIED','FAILED'].includes(data.state)||
    data.executionAllowed!==false)throw Error(data?.code||'F08_RECEIPT_INVALID');
 return data;
}
export function renderF08PilotPanel(root,getSettings,doc=globalThis.document){
 if(!root||!doc?.createElement||root.querySelector?.('#vecthare_f08_pilot'))return false;
 const panel=doc.createElement('div');panel.id='vecthare_f08_pilot';
 const title=doc.createElement('div');title.textContent='F08 — Milvus v2 manual mutation PILOT (disposable collections only)';
 const note=doc.createElement('div');note.textContent='Danger: this changes real records in a NEW F03-provisioned v2 collection. It is NOT production certified. Old memories and normal VectHare writes remain blocked. Local loopback Milvus only. The pilot cannot prevent independent writers from modifying the same table.';
 const model=doc.createElement('input');model.placeholder='Exact F03 embedding model';
 const dim=doc.createElement('input');dim.type='number';dim.min='1';dim.max='65536';dim.placeholder='Exact F03 embedding dimension';
 const metric=doc.createElement('select');for(const x of ['cosine','dot','euclid']){const opt=doc.createElement('option');opt.value=x;opt.textContent=x;metric.append(opt);}
 const action=doc.createElement('select');for(const x of ['insert','update','metadata','delete']){const opt=doc.createElement('option');opt.value=x;opt.textContent=x;action.append(opt);}
 const record=doc.createElement('input');record.placeholder='Record UUID (auto-created on insert, preserve for edits)';
 const revision=doc.createElement('input');revision.type='number';revision.min='0';revision.value='0';revision.placeholder='Expected current revision';
 const text=doc.createElement('textarea');text.placeholder='Text for insert/update';
 const vector=doc.createElement('textarea');vector.placeholder='Float32-exact vector as JSON numeric array (insert/update)';
 const meta=doc.createElement('textarea');meta.placeholder='Metadata JSON object (insert/update/metadata)';
 const consent=doc.createElement('input');consent.type='checkbox';
 const consentLabel=doc.createElement('label');consentLabel.textContent='I understand this writes to a disposable v2 collection';consentLabel.append(consent);
 const submit=doc.createElement('button');submit.type='button';submit.textContent='Execute one F08 pilot mutation (no automatic retries)';
 const receiptId=doc.createElement('input');receiptId.type='text';receiptId.placeholder='Paste operation UUID to inspect, including after restart';
 const inspect=doc.createElement('button');inspect.type='button';inspect.textContent='Inspect operation receipt (read-only)';
 const output=doc.createElement('div');output.setAttribute('role','status');
 let lastOperationId=null;
 inspect.addEventListener('click',async()=>{
  const id=receiptId.value.trim()||lastOperationId;
  if(!id){output.textContent='Enter a saved operation UUID to inspect.';return;}
  try{const {getRequestHeaders}=await import('../../../../script.js');
   const result=await f08OperationReceipt(id,getRequestHeaders());
   output.textContent=`Operation ${result.operationId}: ${result.state}. ${result.state==='UNCERTAIN'?'Do NOT resubmit; manual reconciliation needed.':''}`;
  }catch(e){output.textContent=`Receipt inspection unavailable: ${e?.message||'unknown'}`;}
 });
 submit.addEventListener('click',async()=>{
  if(!consent.checked){output.textContent='F08: explicit disposable consent required';return;}
  submit.disabled=true;
  let operationId;
  try{
   const {getRequestHeaders}=await import('../../../../script.js');
   const {getCurrentChatId}=await import('../../../../../script.js');
   const source=await f02CurrentChatSelector({getChatId:getCurrentChatId,getContext:()=>globalThis.SillyTavern?.getContext?.()});
   const settings=typeof getSettings==='function'?getSettings():{};
   if(!record.value.trim()&&action.value==='insert')record.value=uuid();
   operationId=uuid();lastOperationId=operationId;receiptId.value=operationId;
   const a=action.value;
   const payload={backend:'milvus',source,configId:'default',
    embedding:{source:settings?.source||'transformers',model:model.value.trim(),dimension:Number(dim.value),metric:metric.value},
    action:a,recordId:record.value.trim(),expectedRevision:Number(revision.value),operationId,
    experimentalConsent:F08_PILOT_CONSENT,
    ...(['insert','update'].includes(a)?{text:text.value,vector:JSON.parse(vector.value).map(x=>Math.fround(x))}:{}),
    ...(['insert','update','metadata'].includes(a)&&meta.value.trim()?{metadata:JSON.parse(meta.value)}:{})};
   if(a==='metadata'&&!payload.metadata)throw Error('Metadata JSON object required');
   output.textContent=`Submitting operation ${operationId}; don't retry if status becomes uncertain…`;
   const result=await f08PilotMutation(payload,getRequestHeaders());
   if(result.state==='VERIFIED'){
    revision.value=String(result.targetRevision);
    output.textContent=`F08 pilot ${a} VERIFIED. Record ${result.recordId}; revision ${result.targetRevision}; operation ${result.operationId}.`;
   }else output.textContent=`F08 pilot UNCERTAIN, operation ${result.operationId}. Inspect S04 receipt; do NOT repeat.`;
  }catch(e){output.textContent=`F08 pilot refused/uncertain: ${e?.message||'unknown'}. ${operationId?`Operation ${operationId}. Check operation receipt before any further action.`:''}`;}
  finally{submit.disabled=false;consent.checked=false;}
 });
 panel.append(title,note,model,dim,metric,action,record,revision,text,vector,meta,consentLabel,submit,receiptId,inspect,output);root.prepend(panel);return true;
}

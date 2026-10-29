/** F09: source-bound v2 memory candidate bridge. A preview of normal retrieval,
 * NOT a replacement for the legacy hash-based mutation/injection pipeline.
 * This code never retries, caches cross-chat results, sends credentials, or
 * treats a numeric hash as a stable v2 record ID.
 */
import {guardedVectorFetch} from './e02-vector-request-gateway.js';
import {f02CurrentChatSelector} from './f02-public-read-client.js';
const URI='/api/plugins/similharity/v2/workflows/preview';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function validateF09PreviewResponse(result){
 if(result?.success!==true||result?.scopeVerified!==true||
    result?.readOnly!==true||result?.completeInventory!==false||
    result?.automaticInjectionEnabled!==false||result?.productionWritesEnabled!==false||
    result?.recordIdentity!=='V2_RECORD_UUID'||result?.legacyHashCompatible!==false||
    !Array.isArray(result?.candidates)||result.candidates.length>30)
   throw Error('F09_RESPONSE_CAPABILITY_UNVERIFIED');
 const ids=new Set();
 for(const item of result.candidates){
  if(!UUID.test(item?.recordId||'')||ids.has(item.recordId)||
     !Number.isInteger(item?.revision)||item.revision<1||
     typeof item.text!=='string'||!item.text.trim()||item.text.length>64000||
     typeof item.score!=='number'||!Number.isFinite(item.score))
   throw Error('F09_RECORD_UNVERIFIED');
  ids.add(item.recordId);
 }
 return result.candidates;
}
export async function f09PreviewMemories(payload,headers={},fetchImpl=globalThis.fetch){
 if(!payload||typeof payload!=='object'||!['qdrant','milvus','lancedb','vectra'].includes(payload.backend)||
    !Number.isInteger(payload.topK)||payload.topK<1||payload.topK>30||!Array.isArray(payload.vector))
   throw Error('F09_REQUEST_INVALID');
 const response=await guardedVectorFetch(URI,{
  method:'POST',credentials:'same-origin',cache:'no-store',
  headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(payload)
 },fetchImpl);
 let result;
 try{result=await response.json();}catch{throw Error('F09_RESPONSE_INVALID');}
 if(!response.ok||result?.success!==true)throw Error(result?.code||`F09_HTTP_${response.status}`);
 return validateF09PreviewResponse(result);
}
export function buildF09ReadOnlyCandidateView(candidates,{limit=10,maxCharacters=16000}={}){
 if(!Array.isArray(candidates)||!Number.isSafeInteger(limit)||limit<1||limit>30||
    !Number.isSafeInteger(maxCharacters)||maxCharacters<1||maxCharacters>64000)
   throw Error('F09_PREVIEW_BUDGET_INVALID');
 const output=[],seen=new Set();let remaining=maxCharacters;
 for(const row of candidates){
  if(!UUID.test(row?.recordId||'')||seen.has(row.recordId))throw Error('F09_PREVIEW_RECORD_UNVERIFIED');
  seen.add(row.recordId);
  if(typeof row.text!=='string'||!row.text.trim())throw Error('F09_PREVIEW_RECORD_UNVERIFIED');
  if(output.length===limit||remaining<1)break;
  const text=row.text.slice(0,remaining);
  output.push({recordId:row.recordId,revision:row.revision,score:row.score,text,previewTruncated:text.length<row.text.length});
  remaining-=text.length;
 }
 return {items:output,characterBudget:maxCharacters,unusedCharacters:remaining,
   injectionReady:false,reason:'F09_PREVIEW_ONLY_UNTIL_HOST_ACCEPTANCE'};
}
/** Explicit read preview: no automatic prompt modification or vector mutation. */
export function renderF09MemoryPreview(root,getSettings,doc=globalThis.document){
 if(!root||!doc?.createElement||root.querySelector?.('#vecthare_f09_memory_preview'))return false;
 const wrap=doc.createElement('section');wrap.id='vecthare_f09_memory_preview';
 const title=doc.createElement('h4');title.textContent='F09 — verified v2 memory retrieval preview';
 const info=doc.createElement('p');info.textContent='Read-only preview for a saved chat or owned lorebook. Requires a newly provisioned v2 collection and exact embedding profile. Does not write memories or inject them into model prompts.';
 const backend=doc.createElement('select');for(const name of ['qdrant','lancedb','vectra','milvus']){
  const o=doc.createElement('option');o.value=name;o.textContent=name;backend.append(o);
 }
 const kind=doc.createElement('select');for(const name of ['Current saved chat','Owned lorebook']){
  const o=doc.createElement('option');o.value=name==='Current saved chat'?'chat':'lorebook';o.textContent=name;kind.append(o);
 }
 const lorebook=doc.createElement('input');lorebook.type='text';lorebook.placeholder='Owned lorebook name (if selected)';
 const model=doc.createElement('input');model.type='text';model.placeholder='Exact embedding model';
 const dim=doc.createElement('input');dim.type='number';dim.min='1';dim.max='65536';dim.placeholder='Embedding dimensions';
 const metric=doc.createElement('select');for(const name of ['cosine','dot','euclid']){
  const o=doc.createElement('option');o.value=name;o.textContent=name;metric.append(o);
 }
 const vector=doc.createElement('textarea');vector.placeholder='Query vector JSON; matches the provisioned model and dimensions';
 const searchText=doc.createElement('textarea');searchText.placeholder='Optional query text for local WebLLM embedding only';
 const button=doc.createElement('button');button.type='button';button.textContent='Preview scoped v2 retrieval (no injection)';
 const status=doc.createElement('div');status.setAttribute('role','status');
 const results=doc.createElement('div');
 button.addEventListener('click',async()=>{
  button.disabled=true;status.textContent='Checking host ownership and v2 schema…';results.textContent='';
  try{
   const {getRequestHeaders,getCurrentChatId}=await import('../../../../../script.js');
   const settings=typeof getSettings==='function'?getSettings():{};
   const source=kind.value==='lorebook'?{kind:'lorebook',name:lorebook.value.trim()}:
     await f02CurrentChatSelector({getChatId:getCurrentChatId,getContext:()=>globalThis.SillyTavern?.getContext?.()});
   const embedding={source:settings.f09b_embedding_source||settings.source||'transformers',model:model.value.trim(),dimension:Number(dim.value),metric:metric.value};
   let numericVector;
   if(vector.value.trim())numericVector=JSON.parse(vector.value);
   else if(embedding.source==='webllm'&&searchText.value.trim()){
    const {getAdditionalArgs}=await import('../core/core-vector-api.js');
    const args=await getAdditionalArgs([searchText.value.trim()],settings);
    numericVector=args.embeddings?.[searchText.value.trim()];
   }else throw Error('Enter a numeric vector, or use a configured WebLLM text query');
   if(!Array.isArray(numericVector)||numericVector.length!==embedding.dimension||
      numericVector.some(v=>typeof v!=='number'||!Number.isFinite(v)))throw Error('Query vector must match the exact embedding dimensions');
   const rows=await f09PreviewMemories({backend:backend.value,source,embedding,
      configId:backend.value==='qdrant'&&!settings.qdrant_use_cloud?'local':'default',
      vector:numericVector,topK:10},getRequestHeaders());
   const view=buildF09ReadOnlyCandidateView(rows);
   for(const item of view.items){
    const el=doc.createElement('div');el.textContent=`Record ${item.recordId} (rev ${item.revision}, score ${item.score.toFixed(3)}): ${item.text}`;
    results.append(el); // textContent only — retrieved text is untrusted.
   }
   status.textContent=`${view.items.length} verified, source-scoped candidates previewed. Not injected; not a complete inventory.`;
  }catch(error){status.textContent=`F09 preview refused: ${error?.message||'unknown'}`;}
  finally{button.disabled=false;}
 });
 wrap.append(title,info,backend,kind,lorebook,model,dim,metric,vector,searchText,button,status,results);
 root.prepend(wrap);return true;
}

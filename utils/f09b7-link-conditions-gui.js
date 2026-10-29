/** F09b.7: read-only source-link, condition and lifecycle inspection. */
import {guardedVectorFetch} from './e02-vector-request-gateway.js';
const URI='/api/plugins/similharity/v2/workflows/link-condition-preview';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function validateF09b7Response(data){
 if(data?.success!==true||data?.experimental!==true||data?.status!=='READ_ONLY_LINK_CONDITION_LIFECYCLE_PREVIEW'||
    data.sourceVerified!==true||data.recordIdentity!=='F09B6_STABLE_LORE_UID'||
    !/^[a-f0-9]{64}$/.test(data.sourceRevisionFingerprint||'')||!Array.isArray(data.entries)||data.entries.length>80||
    data.productionWritesEnabled!==false||data.automaticMutationsEnabled!==false||data.deletionAuthority!==false||
    data.completeInventory!==false||data.conditionEvaluation!=='NOT_EVALUATED'||data.linkActivation!=='NOT_PERFORMED')throw Error('F09B7_UNVERIFIED_RESPONSE');
 const allowed=new Set(['DISABLED_SOURCE','EMPTY_SOURCE','MISSING_VECTOR','STALE_VECTOR','IN_SYNC']);
 const ids=new Set();let unresolved=0,disabled=0,empty=0,eligible=0;
 for(const entry of data.entries){
  if(!UUID.test(entry?.recordId||'')||ids.has(entry.recordId)||!allowed.has(entry.lifecycle)||
     !Array.isArray(entry.links)||entry.links.length>8||entry.condition?.evaluated!==false||entry.condition?.mode!=='NOT_EVALUATED'||
     entry.linkedTargetCount!==entry.links.length||typeof entry.storedVectorPresent!=='boolean')throw Error('F09B7_UNVERIFIED_ENTRY');
  ids.add(entry.recordId);
  for(const link of entry.links){
   if(!['SOURCE_LINK_ONLY','TARGET_DISABLED_OR_EMPTY','UNRESOLVED_TARGET'].includes(link?.state)||
     (link.targetRecordId!==null&&!UUID.test(link.targetRecordId)))throw Error('F09B7_UNVERIFIED_LINK');
   if(link.state!=='SOURCE_LINK_ONLY')unresolved++;
  }
  if(entry.lifecycle==='DISABLED_SOURCE')disabled++;
  else if(entry.lifecycle==='EMPTY_SOURCE')empty++;
  else eligible++;
 }
 if(!data.counts||data.counts.eligible!==eligible||data.counts.disabled!==disabled||
    data.counts.empty!==empty||data.counts.unresolvedLinks!==unresolved)throw Error('F09B7_COUNT_MISMATCH');
 return data;
}
export async function f09b7Preview(body,headers={},fetchImpl=globalThis.fetch){
 const r=await guardedVectorFetch(URI,{method:'POST',credentials:'same-origin',cache:'no-store',
  headers:{...headers,'Content-Type':'application/json','X-VectHare-F09b7-Preview':'1'},body:JSON.stringify(body)},fetchImpl);
 let data;try{data=await r.json();}catch{throw Error('F09B7_RESPONSE_INVALID');}
 if(!r.ok)throw Error(/^F09B7_[A-Z0-9_]+$/.test(data?.code||'')?data.code:'F09B7_REFUSED');
 return validateF09b7Response(data);
}
export function renderF09b7Gui(root,getSettings,getHeaders,doc=globalThis.document){
 if(!root||!doc?.createElement||root.querySelector?.('#vecthare_f09b7_inspector'))return false;
 const section=doc.createElement('section');section.id='vecthare_f09b7_inspector';
 const title=doc.createElement('h4');title.textContent='F09b.7 — links, conditions and lifecycle (read-only pilot)';
 const desc=doc.createElement('p');desc.textContent='Inspect saved lorebook entries and experimental vecthareLinks UID references. Disabled/empty entries are shown, not deleted. Conditions are NOT evaluated for prompt activation; no links are followed or activated.';
 const name=doc.createElement('input');name.type='text';name.placeholder='Saved lorebook name';name.maxLength=220;
 const button=doc.createElement('button');button.type='button';button.textContent='Inspect saved World Info links and lifecycle';
 const status=doc.createElement('div');status.setAttribute('role','status');
 const output=doc.createElement('pre');output.style.whiteSpace='pre-wrap';output.style.maxHeight='280px';output.style.overflow='auto';
 button.addEventListener('click',async()=>{
  button.disabled=true;output.textContent='';try{
   const s=getSettings?.()||{},backend=s.f09b_backend||'qdrant';
   if(!['qdrant','lancedb','vectra','milvus'].includes(backend)||(backend==='qdrant'&&s.qdrant_use_cloud===true))throw Error('Select a supported local plugin backend');
   const n=name.value.trim();if(!n||n.endsWith('.json')||/[\\/\x00-\x1f]/.test(n))throw Error('Select a saved lorebook filename stem');
   const embedding={source:s.f09b_embedding_source,model:s.f09b_embedding_model,
    dimension:Number(s.f09b_embedding_dimension),metric:s.f09b_embedding_metric};
   const data=await f09b7Preview({backend,configId:backend==='qdrant'?'local':'default',source:{kind:'lorebook',name:n},embedding},getHeaders?.()||{});
   status.textContent=`${data.entries.length} source records; ${data.counts.disabled} disabled; ${data.counts.empty} empty; ${data.counts.unresolvedLinks} blocked/unresolved references. No mutations performed.`;
   output.textContent=data.entries.map((x,i)=>`#${i+1}: ${x.recordId.slice(0,12)}… ${x.lifecycle}; ${x.links.length} source links; conditions NOT evaluated`).join('\n');
  }catch(e){status.textContent=`F09b.7 refused: ${e.message}`;}finally{button.disabled=false;}
 });
 section.append(title,desc,name,button,status,output);root.prepend(section);return true;
}

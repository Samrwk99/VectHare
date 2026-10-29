/** F09b.6: explicit, source-backed saved-summary/lorebook v2 workflow GUI. */
import {guardedVectorFetch} from './e02-vector-request-gateway.js';
import {f02CurrentChatSelector} from './f02-public-read-client.js';
const URI='/api/plugins/similharity/v2/workflows/saved-content-pilot';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const F09B6_CONSENT='I ACCEPT SAVED CONTENT VECTOR PILOT';
export function validateF09b6Response(result,mode){
 if(result?.success!==true||result?.experimental!==true||result.productionWritesEnabled!==false)throw Error('F09B6_RESPONSE_UNVERIFIED');
 if(mode==='preview'){
  if(result.status!=='READ_ONLY_SAVED_CONTENT_PLAN'||result.sourceVerified!==true||
     !['saved-summary','lorebook-entry'].includes(result.sourceKind)||
     result.recordIdentity!=='V2_STABLE_SAVED_SOURCE_UUID'||result.completeInventory!==false||
     result.deletionsPlanned!==false||result.automaticMutationsEnabled!==false||
     !/^[a-f0-9]{64}$/.test(result.sourceRevisionFingerprint||'')||
     !Array.isArray(result.actions)||result.actions.length<1||result.actions.length>80||
     result.sourceItemsChecked!==result.actions.length)throw Error('F09B6_PREVIEW_UNVERIFIED');
  const seen=new Set(),cnt={create:0,update:0,inSync:0};
  for(const a of result.actions){
   if(!UUID.test(a?.recordId||'')||seen.has(a.recordId)||!Number.isSafeInteger(a.expectedRevision))throw Error('F09B6_ACTION_UNVERIFIED');
   seen.add(a.recordId);
   if(a.action==='CREATE_PENDING_EMBEDDING'&&a.expectedRevision===0)cnt.create++;
   else if(a.action==='UPDATE_PENDING_EMBEDDING'&&a.expectedRevision>=1)cnt.update++;
   else if(a.action==='IN_SYNC'&&a.expectedRevision>=1)cnt.inSync++;
   else throw Error('F09B6_ACTION_UNVERIFIED');
  }
  if(!result.counts||Object.keys(cnt).some(k=>cnt[k]!==result.counts[k]))throw Error('F09B6_COUNT_UNVERIFIED');
 }else if(!['VERIFIED','IN_SYNC'].includes(result.status)||result.applied<0||result.applied>1||
           (result.status==='VERIFIED'&&!UUID.test(result.operationId||'')))throw Error('F09B6_APPLY_UNVERIFIED');
 return result;
}
export async function f09b6Request(body,headers={},fetchImpl=globalThis.fetch){
 const r=await guardedVectorFetch(URI,{method:'POST',credentials:'same-origin',cache:'no-store',
  headers:{...headers,'Content-Type':'application/json','X-VectHare-F09b6-Pilot':'1'},body:JSON.stringify(body)},fetchImpl);
 let data;try{data=await r.json();}catch{throw Error('F09B6_RESPONSE_INVALID');}
 if(data?.status==='UNCERTAIN'&&data?.productionWritesEnabled===false)throw Error(`UNCERTAIN operation ${data.operationId||'unknown'}; do not retry automatically`);
 if(!r.ok)throw Error(/^F09B6_[A-Z0-9_]+$/.test(data?.code||'')?data.code:'F09B6_SERVER_REFUSED');
 return validateF09b6Response(data,body.mode);
}
export function renderF09b6SavedContentGui(root,getSettings,getHeaders,doc=globalThis.document){
 if(!root||!doc?.createElement||root.querySelector?.('#vecthare_f09b6_saved_content'))return false;
 const panel=doc.createElement('section');panel.id='vecthare_f09b6_saved_content';
 const title=doc.createElement('h4');title.textContent='F09b.6 — saved summaries and World Info (pilot)';
 const info=doc.createElement('p');info.textContent='Read only from the saved SillyTavern chat header chat_metadata.summary or an owned lorebook JSON. World Info entries require unique stable numeric uid values. Preview uses v2 reads; one explicitly selected record may be embedded with consent. No automatic sync, deletion, legacy import or production write activation.';
 const kind=doc.createElement('select');for(const k of ['saved-summary','lorebook-entry']){const opt=doc.createElement('option');opt.value=k;opt.textContent=k;kind.append(opt);}
 const loreName=doc.createElement('input');loreName.type='text';loreName.placeholder='Saved lorebook name (without .json)';loreName.maxLength=220;
 const status=doc.createElement('div');status.setAttribute('role','status');status.textContent='Select a source and preview its saved records.';
 const resultPicker=doc.createElement('select');resultPicker.setAttribute('aria-label','Verified saved record to sync');
 const consent=doc.createElement('input');consent.type='checkbox';
 const consentLabel=doc.createElement('label');consentLabel.append(consent,doc.createTextNode(' I consent to exactly one saved content v2 pilot write.'));
 let preview=null,base=null;
 const sourceSelector=async()=>{
  if(kind.value==='lorebook-entry'){
   const name=loreName.value.trim();if(!name||name.length>220||name.endsWith('.json')||/[\\/\x00-\x1f]/.test(name))throw Error('Enter a saved lorebook filename stem');
   return {kind:'lorebook',name};
  }
  const {getCurrentChatId}=await import('../../../../../script.js');
  return f02CurrentChatSelector({getChatId:getCurrentChatId,getContext:()=>globalThis.SillyTavern?.getContext?.()});
 };
 const connection=async()=>{
  const s=getSettings?.()||{},backend=s.f09b_backend||'qdrant';
  if(!['qdrant','lancedb','vectra','milvus'].includes(backend)||(backend==='qdrant'&&s.qdrant_use_cloud===true))throw Error('Select an eligible local plugin backend');
  const embedding={source:s.f09b_embedding_source,model:s.f09b_embedding_model,
   dimension:Number(s.f09b_embedding_dimension),metric:s.f09b_embedding_metric};
  if(!['transformers','openai','togetherai','mistral','openrouter'].includes(embedding.source)||
    !embedding.model||!Number.isSafeInteger(embedding.dimension)||embedding.dimension<1||
    !['cosine','dot','euclid'].includes(embedding.metric))throw Error('Configure the server-managed F09b.5 embedding profile first');
  return {backend,configId:backend==='qdrant'?'local':'default',source:await sourceSelector(),embedding};
 };
 const button=(text,handler)=>{const b=doc.createElement('button');b.type='button';b.textContent=text;
  b.addEventListener('click',async()=>{b.disabled=true;try{await handler();}catch(e){status.textContent=`F09b.6 refused: ${e.message}`;}finally{b.disabled=false;}});return b;};
 const clear=()=>{preview=null;base=null;resultPicker.replaceChildren();consent.checked=false;};
 kind.addEventListener('change',clear);loreName.addEventListener('input',clear);
 const read=button('Preview saved summary / World Info vectors (read-only)',async()=>{
  clear();const selected=await connection(),response=await f09b6Request({...selected,mode:'preview'},getHeaders?.()||{});
  preview=response;base=selected;
  response.actions.forEach((a,i)=>{const opt=doc.createElement('option');opt.value=String(i);
   opt.textContent=`#${i} ${a.action} — ${a.recordId.slice(0,12)}…`;resultPicker.append(opt);});
  status.textContent=`Verified ${response.sourceKind}: ${response.counts.create} missing, ${response.counts.update} changed, ${response.counts.inSync} in sync. No deletions inferred.`;
 });
 const apply=button('Apply selected saved record (explicit pilot)',async()=>{
  if(!consent.checked||!preview||!base)throw Error('Preview first and check explicit consent');
  const fresh=await connection();if(JSON.stringify(fresh)!==JSON.stringify(base))throw Error('Source, embedding or backend changed; preview again');
  const i=Number(resultPicker.value);if(!Number.isSafeInteger(i)||i<0||i>=preview.actions.length)throw Error('Select a verified item');
  consent.checked=false;
  const data=await f09b6Request({...base,mode:'apply',sourceRevisionFingerprint:preview.sourceRevisionFingerprint,
   itemIndex:i,experimentalConsent:F09B6_CONSENT},getHeaders?.()||{});
  clear();status.textContent=data.status==='VERIFIED'?`One saved record verified: ${data.recordId}. Preview again before another write.`:'Selected record is already in sync.';
 });
 panel.append(title,info,kind,loreName,read,resultPicker,consentLabel,apply,status);root.prepend(panel);return true;
}

import {watchManagedViewInvalidation} from './pb11-managed-view-coherence.js';
import {readPB14NativePage} from './pb14-native-browser.js';
/** P-B.10 independent whole-physical read-only view. Not a saved-source
 * preview and never a mutation authority. Server proves ownership/complete
 * inventory before releasing each page of sanitized physical records. */
import {guardedVectorFetch} from './e02-vector-request-gateway.js';
import {f02CurrentChatSelector} from './f02-public-read-client.js';
const URL='/api/plugins/similharity/v2/pb10/physical/browse';
const KEY=/^[a-f0-9]{64}$/;
const BACKENDS=['qdrant','lancedb','vectra','milvus'];
const CURSOR=/^[-_A-Za-z0-9]+\.[-_A-Za-z0-9]+$/;
export function validatePB10PhysicalPage(p){
 if(!p||p.success!==true||p.readOnly!==true||
  p.inventoryKind!=='ENTIRE_OWNED_PHYSICAL_COLLECTION'||
  p.inventoryVerified!==true||p.physicalInventoryComplete!==true||p.ownerVerified!==true||
  !BACKENDS.includes(p.backend)||!KEY.test(p.logicalKey??'')||
  !KEY.test(p.inventoryDigest??'')||!KEY.test(p.sourceFingerprint??'')||
  !KEY.test(p.registryFingerprint??'')||
  !Number.isSafeInteger(p.routingGeneration)||p.routingGeneration<0||
  !Number.isSafeInteger(p.totalRecords)||p.totalRecords<0||p.totalRecords>20000||
  !Number.isSafeInteger(p.offset)||p.offset<0||p.offset>p.totalRecords||
  !Array.isArray(p.records)||p.records.length>50||p.offset+p.records.length>p.totalRecords||
  (p.totalRecords>0&&p.records.length===0)||
  !p.records.every(r=>r&&typeof r.recordId==='string'&&r.recordId.length>0&&
    Number.isSafeInteger(r.revision)&&r.revision>0&&KEY.test(r.textHash??'')&&
    KEY.test(r.metadataHash??'')&&typeof r.textPreview==='string'&&r.textPreview.length<=160&&
    typeof r.textTruncated==='boolean'&&Array.isArray(r.metadataKeys)&&r.metadataKeys.length<=24&&
    r.metadataKeys.every(k=>typeof k==='string'))||
  new Set(p.records.map(r=>r.recordId)).size!==p.records.length||
  (p.nextCursor!==null&&(typeof p.nextCursor!=='string'||p.nextCursor.length>2048||!CURSOR.test(p.nextCursor)))||
  (p.nextCursor===null?p.offset+p.records.length!==p.totalRecords:
   p.offset+p.records.length>=p.totalRecords)||
  p.pageComplete!==(p.nextCursor===null))throw Error('PB10_PHYSICAL_PAGE_UNVERIFIED');
 return p;
}
export async function readPB10PhysicalPage({backend,source,configId='default',cursor=null,headers={},fetchImpl=globalThis.fetch}){
 if(!BACKENDS.includes(backend)||!source||typeof source!=='object'||Array.isArray(source)||
    (backend!=='qdrant'&&configId!=='default'))throw Error('PB10_SELECTOR_INVALID');
 const res=await guardedVectorFetch(URL,{method:'POST',credentials:'same-origin',cache:'no-store',
  headers:{...headers,'Content-Type':'application/json'},
  body:JSON.stringify({backend,source,configId,...(cursor?{cursor}:{})})},fetchImpl);
 let p;try{p=await res.json();}catch{throw Error('PB10_RESPONSE_INVALID');}
 if(!res.ok||p?.success!==true)throw Error(p?.code??'PB10_READ_REFUSED');
 return validatePB10PhysicalPage(p);
}
export function renderPB10PhysicalBrowser(root,doc=globalThis.document){
 if(!root||!doc?.createElement||root.querySelector?.('#vecthare_pb10_physical'))return false;
 const el=(tag,txt='')=>{const x=doc.createElement(tag);if(txt)x.textContent=txt;return x;};
 const select=values=>{const e=el('select');for(const [v,label] of values){const o=el('option',label);o.value=v;e.append(o);}return e;};
 const section=el('section');section.id='vecthare_pb10_physical';
 const title=el('h4','Complete owned physical inventory (read-only)');
 const info=el('p','Inspects the ENTIRE physical collection, not just saved messages. Requires verified exclusive managed ownership. No vectors, backend addresses, credentials, or arbitrary collection targets are displayed. The complete-proof scanner refuses >20,000 records. For larger Qdrant collections, use the separate native page reader: it validates each displayed managed record but does NOT certify the whole collection, the total count, or consistent pages. External writers are not certified.');
 const backend=select(BACKENDS.map(v=>[v,v]));backend.setAttribute('aria-label','Physical inventory backend');
 const kind=select([['chat','Current chat'],['lorebook','Saved lorebook']]);
 const lorebook=el('input');lorebook.placeholder='Exact saved lorebook name';lorebook.type='text';
 const config=select([['default','Default connection'],['local','Local Qdrant']]);
 const inspect=el('button','Inspect physical records'),native=el('button','Browse large Qdrant (page-verified)'),previous=el('button','Previous page'),next=el('button','Next page');
 for(const b of [inspect,native,previous,next])b.type='button';
 const state=el('p');state.setAttribute('role','status');const rows=el('div');
 let current=null,expectedSource=null,cursors=[],activeCursor=null,epoch=0,busy=false,mode='verified';
 const selection=()=>JSON.stringify([backend.value,kind.value,lorebook.value,config.value]);
 const reset=()=>{epoch++;current=null;expectedSource=null;cursors=[];activeCursor=null;mode='verified';rows.replaceChildren();state.textContent='Selection changed; inspect again.';previous.disabled=true;next.disabled=true;native.disabled=backend.value!=='qdrant';};
 for(const s of [backend,kind,config])s.addEventListener('change',reset);
 lorebook.addEventListener('input',reset);
 watchManagedViewInvalidation(reason=>{reset();state.textContent=`Managed physical evidence expired (${reason}); inspect again.`;},{identity:section,document:doc,window:doc.defaultView??globalThis.window});
 const source=async()=>{if(kind.value==='lorebook'){
  const name=lorebook.value.trim();if(!name||name.length>220)throw Error('PB10_LOREBOOK_NAME_REQUIRED');
  return {kind:'lorebook',name};}
  const {getCurrentChatId}=await import('../../../../../script.js');
  return f02CurrentChatSelector({getChatId,getContext:()=>globalThis.SillyTavern?.getContext?.()});};
 const headers=async()=>{const {getRequestHeaders}=await import('../../../../../script.js');return getRequestHeaders();};
 const sameProof=(a,b)=>['backend','logicalKey','inventoryDigest','sourceFingerprint','registryFingerprint',
  'routingGeneration','totalRecords'].every(k=>a[k]===b[k]);
 const render=()=>{rows.replaceChildren();
  for(const r of current.records){const line=el('div');line.textContent=`${r.recordId} · rev ${r.revision} · ${r.textPreview}${r.textTruncated?'…':''} · metadata keys: ${r.metadataKeys.join(', ')}`;rows.append(line);}
  previous.disabled=!cursors.length;next.disabled=!current.nextCursor;
  state.textContent=mode==='native'
   ?`QDRANT PAGE RECORDS VERIFIED: ${current.examined} examined; generation ${current.routingGeneration}. Whole collection ownership, inventory completeness, total count and cross-page consistency NOT VERIFIED. Read-only; NEVER mutation authority.`
   :`ENTIRE OWNED PHYSICAL COLLECTION VERIFIED: ${current.offset+1>current.totalRecords?0:current.offset+1}–${current.offset+current.records.length}/${current.totalRecords}; generation ${current.routingGeneration}; inventory ${current.inventoryDigest.slice(0,16)}…. Read-only, not authorization to mutate.`;};
 const load=async(direction,requestMode=mode)=>{if(busy)return;busy=true;inspect.disabled=true;native.disabled=true;previous.disabled=true;next.disabled=true;
  const serial=epoch,choice=selection();
  try{const selectedSource=await source();
   if(direction==='reset'){expectedSource=selectedSource;current=null;cursors=[];activeCursor=null;mode=requestMode;}
   else if(JSON.stringify(selectedSource)!==JSON.stringify(expectedSource))throw Error('PB10_SOURCE_CHANGED');
   const h=await headers(),target=direction==='back'?cursors.at(-1):direction==='next'?current.nextCursor:null;
   const page=mode==='native'
    ?await readPB14NativePage({source:selectedSource,configId:config.value,cursor:target,headers:h})
    :await readPB10PhysicalPage({backend:backend.value,source:selectedSource,
      configId:backend.value==='qdrant'?config.value:'default',cursor:target,headers:h});
   if(serial!==epoch||choice!==selection()||JSON.stringify(await source())!==JSON.stringify(selectedSource))
    throw Error('PB10_SELECTION_CHANGED');
   if(current&&!(mode==='native'
    ?['backend','logicalKey','sourceFingerprint','registryFingerprint','routingGeneration'].every(k=>current[k]===page[k])
    :sameProof(current,page)))throw Error('PB10_INVENTORY_CHANGED');
   if(direction==='next')cursors.push(activeCursor);
   if(direction==='back')cursors.pop();
   current=page;activeCursor=target;render();
  }catch(e){reset();state.textContent=`Physical inventory UNVERIFIED: ${e.message}. No legacy fallback or write authorization.`;}
  finally{busy=false;inspect.disabled=false;native.disabled=backend.value!=='qdrant';}
 };
 inspect.addEventListener('click',()=>load('reset','verified'));
 native.addEventListener('click',()=>load('reset','native'));
 previous.addEventListener('click',()=>load('back'));
 next.addEventListener('click',()=>load('next'));
 section.append(title,info,backend,kind,lorebook,config,inspect,native,previous,next,state,rows);
 root.prepend(section);previous.disabled=true;next.disabled=true;native.disabled=backend.value!=='qdrant';return true;
}

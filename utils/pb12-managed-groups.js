/** P-B.12 managed UUID groups. Completely separate from legacy hash groups. */
import {guardedVectorFetch} from './e02-vector-request-gateway.js';
import {f02CurrentChatSelector} from './f02-public-read-client.js';
import {publishManagedViewInvalidation,watchManagedViewInvalidation} from './pb11-managed-view-coherence.js';
const URL='/api/plugins/similharity/v2/pb12/groups/';
const KEY=/^[a-f0-9]{64}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const backends=['qdrant','lancedb','vectra','milvus'];
export function assertPB12GroupEvidence(result){
 if(!result||result.success!==true||result.sourceAuthoritative!==true||
  result.verifiedPhysicalInventory!==true||!backends.includes(result.backend)||
  !KEY.test(result.logicalKey??'')||!KEY.test(result.proof??'')||
  !Number.isSafeInteger(result.revision)||result.revision<0||
  !Number.isSafeInteger(result.generation)||result.generation<0||
  !Number.isSafeInteger(result.storedGeneration)||result.storedGeneration<0||
  result.requiresGenerationReview!==(result.storedGeneration!==result.generation)||
  !Number.isSafeInteger(result.recordCount)||result.recordCount<0||result.recordCount>20000||
  !Array.isArray(result.groups)||result.groups.length>256||
  !result.groups.every(g=>g&&UUID.test(g.id??'')&&typeof g.name==='string'&&
    Array.isArray(g.members)&&g.members.every(m=>UUID.test(m))&&
    (g.mode===undefined||['inclusive','exclusive'].includes(g.mode))&&
    (g.mode==='inclusive'?typeof g.boost==='number'&&Number.isFinite(g.boost)&&g.boost>=0&&g.boost<=1:g.boost===undefined))||
  !Array.isArray(result.orphanedMembers)||!Array.isArray(result.availableRecords)||
  result.availableRecords.length>200||
  !result.availableRecords.every(r=>r&&UUID.test(r.recordId??'')&&typeof r.textPreview==='string')||
  typeof result.requiresGenerationReview!=='boolean')throw Error('PB12_GROUP_EVIDENCE_UNVERIFIED');
 return result;
}
export async function requestPB12Groups({action='read',backend,source,configId='default',
 expectedRevision,expectedProof,expectedStoredGeneration,operationId,groups,mutation='save',headers={},fetchImpl=globalThis.fetch}){
 if(!['read','update'].includes(action)||!backends.includes(backend)||!source||
  (backend!=='qdrant'&&configId!=='default'))throw Error('PB12_SELECTOR_INVALID');
 const body={backend,source,configId};
 if(action==='update')Object.assign(body,{action:mutation,operationId,expectedRevision,expectedProof,
  ...(mutation==='save'?{groups}:{}),
  ...(mutation==='review-generation'?{expectedStoredGeneration}:{})});
 const r=await guardedVectorFetch(URL+action,{method:'POST',credentials:'same-origin',cache:'no-store',
  headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(body)},fetchImpl);
 let result;try{result=await r.json();}catch{throw Error('PB12_RESPONSE_INVALID');}
 if(!r.ok||result?.success!==true)throw Error(result?.code??'PB12_OPERATION_REFUSED');
 return assertPB12GroupEvidence(result);
}
export function renderPB12ManagedGroups(root,doc=globalThis.document){
 if(!root||!doc?.createElement||root.querySelector?.('#vecthare_pb12_groups'))return false;
 const el=(tag,text='')=>{const n=doc.createElement(tag);n.textContent=text;return n;};
 const select=entries=>{const n=el('select');for(const [v,t] of entries){const o=el('option',t);o.value=v;n.append(o);}return n;};
 const section=el('section');section.id='vecthare_pb12_groups';
 const title=el('h4','Managed UUID groups (saved to server)');
 const blurb=el('p','Create/edit UUID-based groups against the verified owned physical collection. Old hash-based groups are NOT migrated. Exclusive groups keep the highest-ranked candidate; inclusive groups soft-boost members already returned. No cross-record hard fetch or mandatory forcing. Use record UUIDs from the physical browser. A missing member can be pruned only after explicit confirmation. The current verified inventory limit is 20,000.');
 const backend=select(backends.map(x=>[x,x]));const kind=select([['chat','Current chat'],['lorebook','Saved lorebook']]);
 const lorebook=el('input');lorebook.placeholder='Saved lorebook name';
 const config=select([['default','Default connection'],['local','Local Qdrant']]);
 const load=el('button','Load managed groups'),group=select([['','New group']]),name=el('input');name.placeholder='Group name';
 const mode=select([['exclusive','Exclusive — keep best match'],['inclusive','Inclusive — soft boost matched members'],['','Metadata only (legacy P-B.12)']]);
 const boost=el('input');boost.type='number';boost.min='0';boost.max='1';boost.step='0.01';boost.value='0.15';
 const members=el('textarea');members.placeholder='Record UUIDs (one per line)';members.rows=5;
 const save=el('button','Save group'),remove=el('button','Delete selected group');
 const prune=el('button','Prune verified orphan members');
 const review=el('button','Review collection generation'),status=el('p'),available=el('div');
 status.setAttribute('role','status');for(const b of [load,save,remove,prune,review])b.type='button';
 let snapshot=null,loadedSource=null,serial=0,busy=false;
 const selection=()=>JSON.stringify([backend.value,kind.value,lorebook.value,config.value]);
 const reset=()=>{serial++;snapshot=null;loadedSource=null;group.replaceChildren();group.append(new Option('New group',''));name.value='';mode.value='exclusive';boost.value='0.15';members.value='';available.replaceChildren();status.textContent='Read verified group state before editing.';};
 for(const n of [backend,kind,config])n.addEventListener('change',reset);
 lorebook.addEventListener('input',reset);
 watchManagedViewInvalidation(()=>reset(),{identity:section,window:doc.defaultView??globalThis.window,document:doc});
 const getSource=async()=>{if(kind.value==='lorebook'){
  if(!lorebook.value.trim()||lorebook.value.length>220)throw Error('PB12_LOREBOOK_NAME_REQUIRED');
  return {kind:'lorebook',name:lorebook.value.trim()};}
  const {getCurrentChatId}=await import('../../../../../script.js');
  return f02CurrentChatSelector({getChatId:getCurrentChatId,getContext:()=>globalThis.SillyTavern?.getContext?.()});};
 const getHeaders=async()=>{const {getRequestHeaders}=await import('../../../../../script.js');return getRequestHeaders();};
 const read=async()=>requestPB12Groups({backend:backend.value,source:await getSource(),
  configId:backend.value==='qdrant'?config.value:'default',headers:await getHeaders()});
 function paint(p){snapshot=p;group.replaceChildren();group.append(new Option('New group',''));
  for(const g of p.groups)group.append(new Option(`${g.name} (${g.members.length})`,g.id));
  group.value='';name.value='';mode.value='exclusive';boost.value='0.15';members.value='';available.replaceChildren();
  for(const r of p.availableRecords){const row=el('div',`${r.recordId} — ${r.textPreview}`);available.append(row);}
  status.textContent=`Durable groups revision ${p.revision}, ${p.groups.length} group(s). ${p.orphanedMembers.length} orphan(s); ${p.recordCount} verified physical records. ${p.requiresGenerationReview?`GENERATION CHANGED (${p.storedGeneration} → ${p.generation}): review required before edits.`:''}`;}
 group.addEventListener('change',()=>{const g=snapshot?.groups.find(g=>g.id===group.value);
  name.value=g?.name??'';mode.value=g?.mode??'';boost.value=String(g?.boost??0.15);members.value=g?.members.join('\n')??'';});
 load.addEventListener('click',async()=>{if(busy)return;busy=true;const epoch=++serial,choice=selection();
  try{const src=await getSource(),p=await read();
   if(serial!==epoch||choice!==selection()||JSON.stringify(src)!==JSON.stringify(await getSource()))throw Error('PB12_SELECTION_CHANGED');
   loadedSource=src;paint(p);
  }catch(e){reset();status.textContent=`Managed groups UNVERIFIED: ${e.message}`;}finally{busy=false;}});
 async function mutate(action){if(busy||!snapshot)return;
  busy=true;const epoch=serial,choice=selection();
  try{
   if(snapshot.requiresGenerationReview&&action!=='review')throw Error('PB12_GENERATION_REVIEW_REQUIRED');
   if(action==='review'&&!snapshot.requiresGenerationReview)throw Error('PB12_NO_GENERATION_CHANGE');
   const src=await getSource();if(JSON.stringify(src)!==JSON.stringify(loadedSource))throw Error('PB12_SOURCE_CHANGED');
   let groups=structuredClone(snapshot.groups),mutation='save';
   if(action==='review'){
    const missing=snapshot.orphanedMembers.length;
    const message=`Confirm moving UUID groups from generation ${snapshot.storedGeneration} to ${snapshot.generation} using the VERIFIED current physical inventory? ${missing} missing UUID membership(s) will be removed. No legacy hashes are converted.`;
    if(!globalThis.confirm?.(message))return;
    mutation='review-generation';
   }else if(action==='save'){
    const ids=members.value.split(/[\n, ]+/).map(s=>s.trim()).filter(Boolean);
    if(!name.value.trim()||ids.some(x=>!UUID.test(x))||new Set(ids).size!==ids.length)throw Error('PB12_GROUP_INVALID');
    const id=group.value||globalThis.crypto.randomUUID();
    const item={id,name:name.value.trim(),members:ids};
    if(mode.value){item.mode=mode.value;if(mode.value==='inclusive'){
     item.boost=Number(boost.value);if(!boost.value.trim()||!Number.isFinite(item.boost)||item.boost<0||item.boost>1)throw Error('PB13_BOOST_INVALID');
    }}
    const i=groups.findIndex(x=>x.id===id);if(i<0)groups.push(item);else groups[i]=item;
   }else if(action==='delete'){
    if(!group.value)throw Error('PB12_SELECT_GROUP');
    if(!globalThis.confirm?.('Delete this managed group (metadata only)?'))return;
    groups=groups.filter(g=>g.id!==group.value);
   }else{
    if(!snapshot.orphanedMembers.length)throw Error('PB12_NO_ORPHANS');
    if(!globalThis.confirm?.(`Remove ${snapshot.orphanedMembers.length} physically absent UUID memberships?`))return;
    mutation='prune-orphans';
   }
   if(epoch!==serial||choice!==selection())throw Error('PB12_SELECTION_CHANGED');
   const result=await requestPB12Groups({action:'update',backend:backend.value,source:src,
    configId:backend.value==='qdrant'?config.value:'default',headers:await getHeaders(),
    expectedRevision:snapshot.revision,expectedProof:snapshot.proof,
    ...(mutation==='review-generation'?{expectedStoredGeneration:snapshot.storedGeneration}:{}),
    operationId:globalThis.crypto.randomUUID(),mutation,groups});
   if(!result.receipt?.verified||result.receipt.durable!==true||result.receipt.revision!==result.revision)
    throw Error('PB12_RECEIPT_UNVERIFIED');
   publishManagedViewInvalidation({sender:section});
   const fresh=await read();
   if(fresh.revision!==result.revision||fresh.storedGeneration!==result.storedGeneration||
      JSON.stringify(fresh.groups)!==JSON.stringify(result.groups))
    throw Error('PB12_READBACK_UNVERIFIED');
   paint(fresh);status.textContent=`Managed UUID groups saved and independently read back at revision ${fresh.revision}.`;
  }catch(e){reset();status.textContent=`Group mutation UNVERIFIED: ${e.message}. Reload server evidence before retry; unknown acknowledgements must not be replayed.`;}
  finally{busy=false;}
 }
 save.addEventListener('click',()=>mutate('save'));remove.addEventListener('click',()=>mutate('delete'));
 prune.addEventListener('click',()=>mutate('prune'));
 review.addEventListener('click',()=>mutate('review'));
 section.append(title,blurb,backend,kind,lorebook,config,load,group,name,mode,boost,members,save,remove,prune,review,status,available);
 root.prepend(section);reset();return true;
}

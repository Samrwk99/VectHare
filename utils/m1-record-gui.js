/** M1 saved-record UI. No browser vector, content, owner or physical DB name. */
import {guardedVectorFetch} from './e02-vector-request-gateway.js';
import {f02CurrentChatSelector} from './f02-public-read-client.js';
import {preflightEmbeddingProfile} from './f09b5-embedding-gui.js';
const ROOT='/api/plugins/similharity/v2';
const KEY=/^[a-f0-9]{64}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIONS=['insert','update','revectorize','delete','restore','repair-missing','repair-registry'];
const BACKENDS=['qdrant','lancedb','vectra','milvus'];
const backendName=b=>{if(!BACKENDS.includes(b))throw Error('M1_BACKEND_UNSUPPORTED');return b;};
async function request(url,body=null,headers={},fetchImpl=globalThis.fetch){
 const response=await guardedVectorFetch(ROOT+url,{method:body===null?'GET':'POST',
  credentials:'same-origin',cache:'no-store',headers:{...headers,...(body===null?{}:{'Content-Type':'application/json'})},
  ...(body===null?{}:{body:JSON.stringify(body)})},fetchImpl);
 let result;try{result=await response.json();}catch{throw Error('M1_RESPONSE_INVALID');}
 if(!response.ok||result?.success!==true)throw Error(result?.code||'M1_REQUEST_REFUSED');
 return result;
}
export async function m1Capabilities(headers={},fetchImpl=globalThis.fetch,backend='qdrant'){
 backend=backendName(backend);
 const r=await request('/m1/capabilities',null,headers,fetchImpl);
 if(!Array.isArray(r.capabilities)||![4,8,12,16].includes(r.capabilities.length)||r.capabilities.some(c=>!BACKENDS.includes(c.backend)||
  !['insert','update','revectorize','delete'].includes(c.operation)||
  c.enabled!==(c.mode==='ENABLED')))throw Error('M1_CAPABILITY_RESPONSE_INVALID');
 const selected=r.capabilities.filter(c=>c.backend===backend);
 if(selected.length!==4||new Set(selected.map(c=>c.operation)).size!==4)throw Error('M1_CAPABILITY_RESPONSE_INVALID');
 return selected;
}
export async function m1Preflight(source,configId='default',headers={},fetchImpl=globalThis.fetch,backend='qdrant'){
 const r=await request('/m1/preflight',{backend:backendName(backend),configId,source},headers,fetchImpl);
 if(typeof r.configured!=='boolean'||typeof r.ready!=='boolean'||
  (r.configured&&(!r.profile||typeof r.profile.source!=='string'||!Number.isSafeInteger(r.profile.dimension))))
   throw Error('M1_PROFILE_PREFLIGHT_INVALID');
 return r;
}
export async function m1Preview(source,configId='default',headers={},fetchImpl=globalThis.fetch,backend='qdrant',cursor=null,verifyPhysical=false){
 const r=await request('/m1/records/preview',{backend:backendName(backend),configId,source,...(cursor?{cursor}:{}),...(verifyPhysical?{verifyPhysical:true}:{})},headers,fetchImpl);
 if(!KEY.test(r.logicalKey||'')||!Array.isArray(r.records)||r.records.length>50||
  r.records.some(x=>!UUID.test(x.recordId||'')||!Array.isArray(x.availableActions)||
   x.availableActions.some(a=>!ACTIONS.includes(a))||
   (verifyPhysical&&!['VERIFIED','MISSING','CONFLICT'].includes(x.physicalState)))||
  (r.nextCursor!==undefined&&(r.nextCursor!==null&&(typeof r.nextCursor!=='string'||r.nextCursor.length>2048)))||
  (r.totalRecords!==undefined&&(!Number.isSafeInteger(r.totalRecords)||r.totalRecords<0))||
  (r.offset!==undefined&&(!Number.isSafeInteger(r.offset)||r.offset<0)))throw Error('M1_PREVIEW_RESPONSE_INVALID');
 return r;
}
export async function m1PrepareCollection(source,configId='default',headers={},fetchImpl=globalThis.fetch,backend='qdrant'){
 const r=await request('/m1/collections/prepare',{backend:backendName(backend),configId,source},headers,fetchImpl);
 if(!KEY.test(r.plan?.logicalKey||'')||!UUID.test(r.plan?.operationId||'')||r.plan.action!=='provision'||
    r.plan.requiresExplicitApply!==true||r.plan.executionAllowed!==false)
    throw Error('M1_PROVISION_PLAN_INVALID');
 return r.plan;
}
export async function m1ProvisionCollection(operationId,headers={},fetchImpl=globalThis.fetch,backend='qdrant'){
 if(!UUID.test(operationId||''))throw Error('M1_OPERATION_ID_INVALID');
 const r=await request('/m1/collections/provision',
  {operationId,confirmation:'CREATE OWNED V2 COLLECTION'},headers,fetchImpl);
 if(!KEY.test(r.logicalKey||'')||r.backend!==backendName(backend)||r.receiptState!=='SCHEMA_VERIFIED_OFFLINE_UNCERTIFIED'||
    r.productionWritesEnabled!==false)throw Error('M1_PROVISION_RECEIPT_INVALID');
 return r;
}
export async function m1Plan({logicalKey,source,configId='default',recordId,action,backend='qdrant',expectedFileFingerprint},headers={},fetchImpl=globalThis.fetch){
 if(!KEY.test(logicalKey||'')||!UUID.test(recordId||'')||!ACTIONS.includes(action)||
  (expectedFileFingerprint!==undefined&&!KEY.test(expectedFileFingerprint)))throw Error('M1_PLAN_INPUT_INVALID');
 const r=await request(`/collections/${logicalKey}/records/plan`,{backend:backendName(backend),source,configId,recordId,action,...(expectedFileFingerprint?{expectedFileFingerprint}:{})},headers,fetchImpl);
 if(!UUID.test(r.plan?.operationId||'')||r.plan.logicalKey!==logicalKey||r.plan.recordId!==recordId||
  r.plan.action!==action||r.plan.requiresExplicitApply!==true||r.plan.executionAllowed!==false)
  throw Error('M1_PLAN_RESPONSE_INVALID');
 return r.plan;
}
export async function m1Apply(operationId,headers={},fetchImpl=globalThis.fetch){
 if(!UUID.test(operationId||''))throw Error('M1_OPERATION_ID_INVALID');
 const r=await request('/mutations/execute',{operationId,confirmation:'APPLY SAVED RECORD MUTATION'},headers,fetchImpl);
 if(r.operationId!==operationId||r.state!=='VERIFIED'||r.retryable!==false)
  throw Error('M1_RECEIPT_UNVERIFIED');
 return r;
}
export function renderM1RecordPanel(root,doc=globalThis.document){
 if(!root||!doc?.createElement||root.querySelector?.('#vecthare_m1_record_ops'))return false;
 const panel=doc.createElement('section');panel.id='vecthare_m1_record_ops';
 const heading=doc.createElement('h4');heading.textContent='M1 / M4c — saved-record vectorization';
 const backend=doc.createElement('select');backend.setAttribute('aria-label','Vector backend');
 for(const name of BACKENDS){const o=doc.createElement('option');o.value=name;o.textContent=name==='qdrant'?'Qdrant':name==='lancedb'?'LanceDB':name==='milvus'?'Milvus':'Vectra';backend.append(o);}
 const info=doc.createElement('p');info.textContent='Operations require verified server-owned embedding, a bound v2 collection, with runtime safety checks. Enabled operations await your manual testing; legacy and unregistered vectors are excluded. First preview the saved source; each operation requires an exact plan and confirmation.';
 const mode=doc.createElement('select');for(const name of ['Current saved chat','Saved lorebook']){const o=doc.createElement('option');o.value=name;o.textContent=name;mode.append(o);}
 const loreName=doc.createElement('input');loreName.placeholder='Exact saved lorebook name';loreName.type='text';
 const config=doc.createElement('select');for(const name of ['default','local']){const o=doc.createElement('option');o.value=name;o.textContent=name==='default'?'Server-configured Qdrant':'Local Qdrant (loopback)';config.append(o);}
 const refresh=doc.createElement('button');refresh.type='button';refresh.textContent='Preview saved records / capabilities';
 const provision=doc.createElement('button');provision.type='button';provision.textContent='Set up owned v2 collection';provision.disabled=true;
 const recordSelect=doc.createElement('select');recordSelect.setAttribute('aria-label','Saved record');
 const actionSelect=doc.createElement('select');for(const a of ACTIONS){const o=doc.createElement('option');o.value=a;o.textContent=a;actionSelect.append(o);}
 const apply=doc.createElement('button');apply.type='button';apply.textContent='Plan and confirm selected action';apply.disabled=true;
 const status=doc.createElement('div');status.setAttribute('role','status');
 let preview=null,source=null,caps=[];
 const selectedSource=async()=>{
  if(mode.value==='Saved lorebook'){
   const name=loreName.value.trim();if(!name||name.length>220)throw Error('Exact saved lorebook name required');
   return {kind:'lorebook',name};
  }
  const {getCurrentChatId}=await import('../../../../../script.js');
  return f02CurrentChatSelector({getChatId:getCurrentChatId,getContext:()=>globalThis.SillyTavern?.getContext?.()});
 };
 const headers=async()=>{const {getRequestHeaders}=await import('../../../../../script.js');return getRequestHeaders();};
 const requireProfile=async(h,s)=>{
  const state=await m1Preflight(s,currentConfig(),h,globalThis.fetch,backend.value);
  if(!state.configured)throw Error('No managed embedding profile. Open Server-managed embeddings above, save your provider and run its connection test.');
  if(state.connectionState==='CREDENTIAL_REQUIRED')throw Error('Embedding API credential missing. Configure it in Server-managed embeddings.');
  if(!state.ready)throw Error(`Embedding profile is ${state.connectionState}. Run Test server embedding in the settings before vectorizing; this verifies the model and vector dimension.`);
  return state;
 };
 const supported=a=>caps.find(c=>c.operation===(a==='restore'?'insert':a))?.enabled===true;
 const currentConfig=()=>backend.value==='qdrant'?config.value:'default';
 backend.addEventListener('change',()=>{caps=[];preview=null;source=null;config.disabled=backend.value!=='qdrant';
  config.value='default';status.textContent='Backend changed. Refresh capabilities and saved source before applying operations.';updateAction();});
 const updateAction=()=>{
  provision.disabled=!caps.some(c=>c.operation==='insert'&&c.enabled===true);
  const item=preview?.records?.find(x=>x.recordId===recordSelect.value);
  apply.disabled=!item||!item.availableActions.includes(actionSelect.value)||!supported(actionSelect.value);
 };
 recordSelect.addEventListener('change',updateAction);actionSelect.addEventListener('change',updateAction);
 provision.addEventListener('click',async()=>{
  provision.disabled=true;status.textContent='Preparing server-owned v2 collection…';
  try{
   const s=await selectedSource(),h=await headers();
   await requireProfile(h,s);
   if(!caps.find(c=>c.operation==='insert')?.enabled)throw Error(`${backend.value} insert is not enabled`);
   const p=await m1PrepareCollection(s,currentConfig(),h,globalThis.fetch,backend.value);
   if(!globalThis.confirm?.(`Create owned ${backend.value} collection for saved ${s.kind}? The server will select its physical identity and embedding schema. Operation ${p.operationId}.`)){
    status.textContent='Collection setup cancelled; ticket will expire.';return;
   }
   const result=await m1ProvisionCollection(p.operationId,h,globalThis.fetch,backend.value);
   status.textContent=`Collection ${result.logicalKey.slice(0,12)} provisioned. Preview saved records to proceed.`;
   preview=null;
  }catch(e){status.textContent=`M1 collection setup refused: ${e.message}`;}
  finally{updateAction();}
 });
 refresh.addEventListener('click',async()=>{
  refresh.disabled=true;apply.disabled=true;status.textContent='Checking server-attested saved source…';
  try{
   source=await selectedSource();const h=await headers();
   await requireProfile(h,source);
   caps=await m1Capabilities(h,globalThis.fetch,backend.value);
   try{preview=await m1Preview(source,currentConfig(),h,globalThis.fetch,backend.value);}
   catch(e){preview=null;updateAction();status.textContent=`M1 saved-source preview refused: ${e.message}. If the owned v2 collection does not exist, use Set up owned v2 collection after configuring the backend.`;return;}
   recordSelect.replaceChildren();
   for(const [i,item] of preview.records.entries()){
    const o=doc.createElement('option');o.value=item.recordId;
    o.textContent=`${i+1}: ${item.recordId.slice(0,8)} (${item.managedState}, rev ${item.revision})`;
    recordSelect.append(o);
   }
   updateAction();status.textContent=`Saved records: ${preview.records.length} shown / ${preview.totalRecords??preview.records.length} total (first page only). ${backend.value}: ${caps.map(c=>`${c.operation} ${c.mode}`).join(', ')}. Enabled actions are awaiting manual verification; use disposable data.`;
  }catch(e){preview=null;status.textContent=`M1 preview refused: ${e.message}`;}
  finally{refresh.disabled=false;}
 });
 apply.addEventListener('click',async()=>{
  apply.disabled=true;try{
   const latest=await selectedSource();if(JSON.stringify(latest)!==JSON.stringify(source))throw Error('Source selection changed; refresh first');
   const choice=recordSelect.value,action=actionSelect.value;
   if(!preview.records.some(x=>x.recordId===choice&&x.availableActions.includes(action))||!supported(action))throw Error('Action unavailable for this source or backend');
   const h=await headers();await requireProfile(h,source);const plan=await m1Plan({logicalKey:preview.logicalKey,source,configId:currentConfig(),recordId:choice,action,backend:backend.value,expectedFileFingerprint:preview.fileFingerprint},h);
   if(!globalThis.confirm?.(`Apply ${action} to owned saved record ${choice}? Operation ${plan.operationId}. This may change stored vectors.`)){
    status.textContent='M1 plan not applied. The ticket will expire.';return;
   }
   const outcome=await m1Apply(plan.operationId,h);
   status.textContent=`${action}: VERIFIED receipt ${outcome.operationId}. Refresh before another operation.`;
   preview=null;
  }catch(e){status.textContent=`M1 operation refused: ${e.message}. Do not blindly retry an uncertain operation.`;}
  finally{updateAction();}
 });
 panel.append(heading,info,backend,mode,loreName,config,refresh,provision,recordSelect,actionSelect,apply,status);root.append(panel);return true;
}

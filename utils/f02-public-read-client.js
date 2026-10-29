/** F02 browser gateway: a selected saved chat/lorebook is only a selector.
 * Auth is repeated by the plugin on every read. This client grants NO writes,
 * verified export, legacy inventory or general activation. */
import {guardedVectorFetch} from './e02-vector-request-gateway.js';
const ROOT='/api/plugins/similharity/v2/reads';
const isObj=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
export async function f02Read(operation,payload,headers={},fetchImpl=globalThis.fetch){
 if(!['bind','get','list','query'].includes(operation)||!isObj(payload))throw Error('F02_CLIENT_INVALID');
 const response=await guardedVectorFetch(`${ROOT}/${operation}`,{
  method:'POST',credentials:'same-origin',cache:'no-store',
  headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(payload)
 },fetchImpl);
 let result=null;
 try{result=await response.json();}catch{throw Error('F02_RESPONSE_INVALID');}
 if(!response.ok||result?.success!==true)throw Error(result?.code||`F02_HTTP_${response.status}`);
 if(result.productionWritesEnabled!==false||result.inventoryVerified!==false)throw Error('F02_CAPABILITY_OVERCLAIM');
 if(operation==='bind'&&result.physicalCollectionProvisioned!==false)throw Error('F02_BIND_OVERCLAIM');
 if(operation!=='bind'&&result.scopeVerified!==true)throw Error('F02_SCOPE_UNVERIFIED');
 return result;
}
/** Construct only the SillyTavern active file selector. Server checks ownership. */
export async function f02CurrentChatSelector({getChatId,getContext}={}){
 if(typeof getChatId!=='function')throw Error('F02_HOST_CHAT_UNAVAILABLE');
 const chatFile=getChatId();if(!chatFile)throw Error('F02_CHAT_UNSAVED');
 const ctx=typeof getContext==='function'?getContext():null;
 if(ctx?.groupId||ctx?.selectedGroup)return {kind:'group-chat',chatFile,groupId:String(ctx.groupId||ctx.selectedGroup)};
 const avatar=ctx?.characters?.[ctx?.characterId]?.avatar;
 if(typeof avatar!=='string'||!avatar.endsWith('.png'))throw Error('F02_HOST_AVATAR_UNAVAILABLE');
 return {kind:'chat',avatar,chatFile};
}
/** Developer-facing, ordinary-GUI read smoke controls; no vector mutation. */
export function renderF02ReadPanel(root,getSettings,doc=globalThis.document){
 if(!root||!doc?.createElement||root.querySelector?.('#vecthare_f02_reads'))return false;
 const panel=doc.createElement('div');panel.id='vecthare_f02_reads';
 const title=doc.createElement('div');title.textContent='F02 — v2 saved-source reads (new v2 collections only)';
 const desc=doc.createElement('div');desc.textContent='Legacy memories are not migrated. Bind reserves a logical name only; it does not create a database collection. No writes or verified exports.';
 const model=doc.createElement('input');model.type='text';model.placeholder='Exact embedding model identifier';
 const dimension=doc.createElement('input');dimension.type='number';dimension.min='1';dimension.max='65536';dimension.placeholder='Embedding dimensions';
 const metric=doc.createElement('select');for(const name of ['cosine','dot','euclid']){const o=doc.createElement('option');o.value=name;o.textContent=name;metric.append(o);}
 const current=getSettings?.()||{};model.value=current.f09b_embedding_model||'';dimension.value=current.f09b_embedding_dimension||'';metric.value=current.f09b_embedding_metric||'cosine';
 const selection=doc.createElement('select');for(const backend of ['qdrant','lancedb','vectra','milvus']){const o=doc.createElement('option');o.value=backend;o.textContent=backend;selection.append(o);}
 const bind=doc.createElement('button');bind.type='button';bind.textContent='Bind saved chat (no vectors written)';
 const list=doc.createElement('button');list.type='button';list.textContent='List v2 records (read-only)';
 const recordId=doc.createElement('input');recordId.type='text';recordId.placeholder='v2 record UUID for get';
 const get=doc.createElement('button');get.type='button';get.textContent='Get v2 record';
 const vectorInput=doc.createElement('textarea');vectorInput.placeholder='Diagnostic query vector as JSON numeric array';
 const query=doc.createElement('button');query.type='button';query.textContent='Search v2 records (numeric vector)';
 const output=doc.createElement('div');output.setAttribute('role','status');
 let source=null;
 const run=async operation=>{
  for(const button of [bind,list,get,query])button.disabled=true;output.textContent='Checking saved-source ownership and v2 schema…';
  try{
   const {getRequestHeaders}=await import('../../../../script.js');
   const {getCurrentChatId}=await import('../../../../../script.js');
   source=await f02CurrentChatSelector({getChatId:getCurrentChatId,getContext:()=>globalThis.SillyTavern?.getContext?.()});
   const settings=typeof getSettings==='function'?getSettings():{};
   const embedding={source:settings?.f09b_embedding_source||settings?.source||'transformers',model:model.value.trim(),dimension:Number(dimension.value),metric:metric.value};
   const result=await f02Read(operation,{backend:selection.value,source,embedding,
     configId:selection.value==='qdrant'&&(settings?.qdrant_use_cloud!==true)?'local':'default',
     ...(operation==='list'?{page:{limit:20}}:operation==='get'?{recordId:recordId.value.trim()}:
       operation==='query'?{vector:JSON.parse(vectorInput.value),topK:5}:{})},getRequestHeaders());
   output.textContent=operation==='bind'
    ? `Saved-source mapping reserved. Physical collection not provisioned. Key: ${result.collectionKey?.slice(0,12)||'unknown'}`
    : operation==='list' ? `${result.data?.items?.length??0} scoped v2 records on this page; complete inventory NOT verified.` :
      operation==='get' ? (result.data?`Record ${result.data.recordId} (revision ${result.data.revision}) verified for this saved source.`:'Record not found in scoped v2 collection.') :
      `${result.data?.length??0} scoped v2 search matches; results are NOT a complete inventory.`;
  }catch(err){output.textContent=`F02 ${operation} unavailable: ${err?.message||'unknown'}`;}
  finally{for(const button of [bind,list,get,query])button.disabled=false;}
 };
 bind.addEventListener('click',()=>run('bind'));list.addEventListener('click',()=>run('list'));
 get.addEventListener('click',()=>run('get'));query.addEventListener('click',()=>run('query'));
 panel.append(title,desc,selection,model,dimension,metric,bind,list,recordId,get,vectorInput,query,output);root.prepend(panel);return true;
}

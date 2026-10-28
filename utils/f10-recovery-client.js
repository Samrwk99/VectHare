/** F10: explicitly requested, authenticated record-evidence capture UI.
 * No complete-inventory, restore, migration, automatic vector writes or purge.
 */
import {guardedVectorFetch} from './e02-vector-request-gateway.js';
import {f02CurrentChatSelector} from './f02-public-read-client.js';
const ROOT='/api/plugins/similharity/v2/recovery/';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const scoped=x=>x&&typeof x==='object'&&!Array.isArray(x);
export function validateF10Response(operation,result){
 if(result?.success!==true||result?.scopeVerified!==true||
    result.authoritativeInventory!==false||result.verifiedFullBackup!==false||
    result.snapshotConsistency!=='UNPROVEN'||result.migrationAllowed!==false||
    result.restoreAllowed!==false||result.productionWritesEnabled!==false||
    !UUID.test(result.captureId||'')||!/^[a-f0-9]{64}$/.test(result.checksum||'')||
    !Number.isSafeInteger(result.recordCount)||result.recordCount<0||result.recordCount>300)
  throw Error('F10_RESPONSE_OVERCLAIMS_CAPABILITIES');
 if(operation!=='capture'&&result.captureIntegrityVerified!==true)
  throw Error('F10_CAPTURE_INTEGRITY_UNVERIFIED');
 if(operation==='download'&&(result.exportKind!=='NONAUTHORITATIVE_RECORD_EVIDENCE_ONLY'||
    !scoped(result.data)||!Array.isArray(result.data.records)||
    result.data.records.length!==result.recordCount||result.data.captureId!==result.captureId))
  throw Error('F10_DOWNLOAD_INVALID');
 return result;
}
export async function f10RecoveryRequest(operation,payload,headers={},fetchImpl=globalThis.fetch){
 if(!['capture','status','download'].includes(operation)||!scoped(payload)||
    !['qdrant','lancedb','vectra','milvus'].includes(payload.backend)||
    !scoped(payload.source)||!scoped(payload.embedding)||
    (operation==='capture'&&payload.confirmCapture!=='I UNDERSTAND THIS IS NOT A VERIFIED FULL BACKUP')||
    (operation!=='capture'&&!UUID.test(payload.captureId||'')))throw Error('F10_REQUEST_INVALID');
 const response=await guardedVectorFetch(ROOT+operation,{
  method:'POST',credentials:'same-origin',cache:'no-store',
  headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(payload)
 },fetchImpl);
 let reply;try{reply=await response.json();}catch{throw Error('F10_RESPONSE_INVALID');}
 if(!response.ok||reply?.success!==true)throw Error(reply?.code||`F10_HTTP_${response.status}`);
 return validateF10Response(operation,reply);
}
export function renderF10RecoveryPanel(root,getSettings,doc=globalThis.document){
 if(!root||!doc?.createElement||root.querySelector?.('#vecthare_f10_recovery'))return false;
 const panel=doc.createElement('section');panel.id='vecthare_f10_recovery';
 const title=doc.createElement('h4');title.textContent='F10 — scoped record evidence (not a verified full backup)';
 const info=doc.createElement('p');info.textContent='For a saved source and provisioned v2 collection: capture two bounded read passes, verify individual records and store an integrity-checked copy in the private SillyTavern user area. NOT an atomic snapshot, full export, migration, restore or deletion tool. Max 300 records/8 MB.';
 const backend=doc.createElement('select');for(const v of ['qdrant','lancedb','vectra','milvus']){const e=doc.createElement('option');e.value=v;e.textContent=v;backend.append(e);}
 const kind=doc.createElement('select');for(const v of ['chat','lorebook']){const e=doc.createElement('option');e.value=v;e.textContent=v;kind.append(e);}
 const lorebook=doc.createElement('input');lorebook.type='text';lorebook.placeholder='Owned lorebook name (if selected)';
 const model=doc.createElement('input');model.type='text';model.placeholder='Exact provisioned embedding model';
 const dim=doc.createElement('input');dim.type='number';dim.min='1';dim.max='65536';dim.placeholder='Embedding dimensions';
 const metric=doc.createElement('select');for(const v of ['cosine','dot','euclid']){const e=doc.createElement('option');e.value=v;e.textContent=v;metric.append(e);}
 const id=doc.createElement('input');id.type='text';id.placeholder='Capture UUID to verify or download';
 const capture=doc.createElement('button');capture.type='button';capture.textContent='Capture scoped record evidence (NOT a full backup)';
 const statusButton=doc.createElement('button');statusButton.type='button';statusButton.textContent='Verify capture integrity';
 const download=doc.createElement('button');download.type='button';download.textContent='Download non-authoritative evidence JSON';
 const status=doc.createElement('div');status.setAttribute('role','status');
 async function requestBody(){
  const {getCurrentChatId}=await import('../../../../../script.js');
  const settings=typeof getSettings==='function'?getSettings():{};
  return {backend:backend.value,source:kind.value==='lorebook'?{kind:'lorebook',name:lorebook.value.trim()}:
    await f02CurrentChatSelector({getChatId:getCurrentChatId,getContext:()=>globalThis.SillyTavern?.getContext?.()}),
   embedding:{source:settings.source||'transformers',model:model.value.trim(),dimension:Number(dim.value),metric:metric.value},
   configId:backend.value==='qdrant'&&!settings.qdrant_use_cloud?'local':'default'};
 }
 async function doRequest(op){
  const {getRequestHeaders}=await import('../../../../../script.js');
  const data=await requestBody();
  return f10RecoveryRequest(op,{...data,...(op==='capture'?{
   confirmCapture:'I UNDERSTAND THIS IS NOT A VERIFIED FULL BACKUP'}:{captureId:id.value.trim()})},getRequestHeaders());
 }
 async function run(button,op){
  button.disabled=true;status.textContent='Checking verified source and collection…';
  try{
   if(op==='capture'&&typeof globalThis.confirm==='function'&&!globalThis.confirm('This stores an authenticated copy of up to 300 records on the SillyTavern server. It is NOT a verified complete backup or an atomic snapshot. Continue?')){status.textContent='Cancelled';return;}
   const result=await doRequest(op);id.value=result.captureId;
   if(op==='download'){
    const blob=new Blob([JSON.stringify(result.data,null,2)+'\n'],{type:'application/json'});
    const url=URL.createObjectURL(blob);
    try{const a=doc.createElement('a');a.href=url;a.download=`vecthare-f10-NOT-A-FULL-BACKUP-${result.captureId}.json`;a.click();}
    finally{URL.revokeObjectURL(url);}
   }
   status.textContent=`F10 ${op}: ${result.recordCount} source-scoped records; receipt ${result.captureId}. Integrity check passed. Full inventory/snapshot NOT certified; no migration/restore enabled.`;
  }catch(e){status.textContent=`F10 ${op} refused: ${e?.message||'unavailable'}`;}
  finally{button.disabled=false;}
 }
 capture.addEventListener('click',()=>run(capture,'capture'));
 statusButton.addEventListener('click',()=>run(statusButton,'status'));
 download.addEventListener('click',()=>run(download,'download'));
 panel.append(title,info,backend,kind,lorebook,model,dim,metric,id,capture,statusButton,download,status);
 root.prepend(panel);return true;
}

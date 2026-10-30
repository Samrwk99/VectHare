/** Milvus managed lifecycle. Only source selectors/one-use UUIDs cross HTTP.
 * No arbitrary path, physical name, owner or vector ever leaves this module.
 */
import {guardedVectorFetch} from './e02-vector-request-gateway.js';
import {f02CurrentChatSelector} from './f02-public-read-client.js';
const root='/api/plugins/similharity/v2/m4c/milvus/';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY=/^[a-f0-9]{64}$/;
async function send(route,body,headers={},fetchImpl=globalThis.fetch){
 const res=await guardedVectorFetch(root+route,{method:body===null?'GET':'POST',credentials:'same-origin',cache:'no-store',
  headers:{...headers,...(body===null?{}:{'Content-Type':'application/json'})},
  ...(body===null?{}:{body:JSON.stringify(body)})},fetchImpl);
 let data;try{data=await res.json();}catch{throw Error('M4C_RESPONSE_INVALID');}
 if(!res.ok||data?.success!==true)throw Error(data?.code??'M4C_REFUSED');return data;
}
export async function m4cMilvusPreview(source,headers,fetchImpl){
 const d=await send('collections/preview',{backend:'milvus',source},headers,fetchImpl);
 if(d.backend!=='milvus'||!KEY.test(d.logicalKey??'')||d.ownerVerified!==true||
  d.completePhysicalInventory!==true||d.operationModes?.backup!=='ENABLED'||
  !Number.isSafeInteger(d.recordCount)||d.recordCount<0||d.productionWritesEnabled!==false)
  throw Error('M4C_PREVIEW_UNTRUSTED');return d;
}
export async function m4cMilvusBackup(source,headers,fetchImpl){
 const d=await send('backups/create',{backend:'milvus',source,confirmation:'CAPTURE OWNED LOGICAL BACKUP'},headers,fetchImpl);
 if(d.backend!=='milvus'||d.state!=='VERIFIED'||!UUID.test(d.backupId??'')||
  d.physicalBackupVerified!==true||d.productionCertified!==false)throw Error('M4C_BACKUP_UNVERIFIED');return d;
}
export async function m4cMilvusVerify(backupId,headers,fetchImpl){
 if(!UUID.test(backupId??''))throw Error('M4C_BACKUP_ID_INVALID');
 const d=await send(`backups/${backupId}/verify`,null,headers,fetchImpl);
 if(d.backend!=='milvus'||d.backupId!==backupId||d.integrityVerified!==true||
  !KEY.test(d.logicalKey??''))throw Error('M4C_VERIFY_UNTRUSTED');return d;
}
export async function m4cMilvusPlanDelete(source,backupId,headers,fetchImpl){
 if(!UUID.test(backupId??''))throw Error('M4C_DELETE_BACKUP_ID_INVALID');
 const d=await send('collections/delete/plan',{backend:'milvus',source,backupId},headers,fetchImpl);
 if(d.backend!=='milvus'||d.state!=='PLANNED'||d.backupId!==backupId||
  !UUID.test(d.operationId??'')||d.requiredConfirmation!=='DELETE OWNED MILVUS COLLECTION'||
  d.oneUse!==true||!Number.isSafeInteger(d.expiresAt))throw Error('M4C_DELETE_PLAN_UNTRUSTED');return d;
}
export async function m4cMilvusExecuteDelete(operationId,headers,fetchImpl){
 if(!UUID.test(operationId??''))throw Error('M4C_DELETE_ID_INVALID');
 const d=await send('collections/delete/execute',{operationId,confirmation:'DELETE OWNED MILVUS COLLECTION'},headers,fetchImpl);
 if(d.backend!=='milvus'||d.operationId!==operationId||d.state!=='VERIFIED'||
  d.registryTombstoned!==true||d.physicalAbsent!==true)throw Error('M4C_DELETE_RESULT_UNTRUSTED');return d;
}
export function renderM4cMilvusLifecyclePanel(parent,doc=globalThis.document){
 if(!parent?.append||!doc?.createElement)return false;
 const section=doc.createElement('section');section.className='vecthare-m4c-milvus-lifecycle';
 const title=doc.createElement('h4');title.textContent='Milvus — owned collection backup and guarded deletion';
 const desc=doc.createElement('p');desc.textContent='Authenticated full-collection backup and one-use deletion. Restore and scoped empty stage new remote generations, verify full physical readback, and retain previous Milvus collections. External writers are not certified.';
 const sourceMode=doc.createElement('select');for(const [v,label] of [['chat','Current saved chat'],['lorebook','World Info lorebook']]){
  const option=doc.createElement('option');option.value=v;option.textContent=label;sourceMode.append(option);}
 const lore=doc.createElement('input');lore.type='text';lore.placeholder='Exact saved lorebook name';
 const make=(label)=>{const b=doc.createElement('button');b.type='button';b.textContent=label;return b;};
 const preview=make('Preview Milvus inventory'),backup=make('Create Milvus logical backup'),
  verify=make('Verify backup'),plan=make('Plan Milvus collection deletion'),execute=make('Execute one-use deletion');
 const id=doc.createElement('input');id.type='text';id.placeholder='Milvus backup UUID';
 const status=doc.createElement('p');status.setAttribute('role','status');
 const transitionAction=doc.createElement('select');for(const [v,label] of [['restore','Restore to a fresh Milvus generation'],['empty','Scoped empty (retain old index)']]){
  const option=doc.createElement('option');option.value=v;option.textContent=label;transitionAction.append(option);}
 const transitionPlan=make('Plan Milvus restore / scoped empty'),transitionExecute=make('Execute one-use transition');transitionExecute.disabled=true;
 let pendingTransition=null;
 backup.disabled=true;execute.disabled=true;
 let current=null,pending=null;
 const headers=async()=>{const m=await import('../../../../../script.js');return m.getRequestHeaders();};
 const selected=async()=>{if(sourceMode.value==='lorebook'){const name=lore.value.trim();if(!name||name.length>220)throw Error('Exact lorebook name required');return {kind:'lorebook',name};}
  const m=await import('../../../../../script.js');return f02CurrentChatSelector({getChatId:m.getCurrentChatId,getContext:()=>globalThis.SillyTavern?.getContext?.()});};
 preview.addEventListener('click',async()=>{try{const source=await selected(),proof=await m4cMilvusPreview(source,await headers());current={source,proof};backup.disabled=false;pending=null;execute.disabled=true;
  status.textContent=`Milvus ${proof.logicalKey.slice(0,12)}: ${proof.recordCount} owned vectors.`;}
  catch(e){current=null;backup.disabled=true;status.textContent=`Milvus preview refused: ${e.message}`;}});
 backup.addEventListener('click',async()=>{try{if(!current||JSON.stringify(await selected())!==JSON.stringify(current.source))throw Error('Source changed');
  if(!globalThis.confirm?.('Capture a plaintext logical backup in private server storage?'))return;
  const d=await m4cMilvusBackup(current.source,await headers());id.value=d.backupId;status.textContent=`Milvus backup ${d.backupId} verified.`;}
  catch(e){status.textContent=`Milvus backup refused: ${e.message}`;}});
 verify.addEventListener('click',async()=>{try{const d=await m4cMilvusVerify(id.value.trim(),await headers());status.textContent=`Milvus backup ${d.backupId}, ${d.recordCount} records: integrity verified.`;}
  catch(e){status.textContent=`Milvus verification refused: ${e.message}`;}});
 plan.addEventListener('click',async()=>{try{pending=null;execute.disabled=true;const source=await selected();
  const verified=await m4cMilvusVerify(id.value.trim(),await headers());
  if(!globalThis.confirm?.('Plan permanent deletion of this owned Milvus index?'))return;
  const proof=await m4cMilvusPlanDelete(source,verified.backupId,await headers());pending={source,proof};execute.disabled=false;
  status.textContent=`Milvus deletion plan ${proof.operationId}; exact typed consent required.`;}
  catch(e){status.textContent=`Milvus delete plan refused: ${e.message}`;}});
 execute.addEventListener('click',async()=>{try{if(!pending||JSON.stringify(await selected())!==JSON.stringify(pending.source))throw Error('Source changed; replan');
  if(globalThis.prompt?.('Type DELETE OWNED MILVUS COLLECTION to confirm:')!=='DELETE OWNED MILVUS COLLECTION')throw Error('Exact confirmation required');
  const operationId=pending.proof.operationId;pending=null;execute.disabled=true;
  const result=await m4cMilvusExecuteDelete(operationId,await headers());current=null;backup.disabled=true;
  status.textContent=`Milvus collection removed; receipt ${result.operationId}.`;}
  catch(e){pending=null;execute.disabled=true;status.textContent=`Milvus deletion refused or uncertain: ${e.message}. Never blindly retry.`;}});
 transitionPlan.addEventListener('click',async()=>{try{pendingTransition=null;transitionExecute.disabled=true;const source=await selected(),action=transitionAction.value;
  const verified=await m4cMilvusVerify(id.value.trim(),await headers());
  if(!globalThis.confirm?.(`Plan ${action} of the Milvus collection using backup ${verified.backupId}? Original collection retained.`))return;
  const ticket=await m4cMilvusPlanTransition(source,verified.backupId,action,await headers());
  pendingTransition={source,action,ticket};transitionExecute.disabled=false;
  status.textContent=`Milvus ${action} plan ${ticket.operationId}; exact typed consent required.`;
 }catch(e){status.textContent=`Milvus transition plan refused: ${e.message}`;}});
 transitionExecute.addEventListener('click',async()=>{try{if(!pendingTransition||
  JSON.stringify(await selected())!==JSON.stringify(pendingTransition.source)||
  pendingTransition.action!==transitionAction.value)throw Error('Source/action changed; replan');
  const {ticket,action}=pendingTransition;
  if(globalThis.prompt?.(`Type ${ticket.requiredConfirmation} to confirm:`)!==ticket.requiredConfirmation)
   throw Error('Exact confirmation required');
  pendingTransition=null;transitionExecute.disabled=true;
  const result=await m4cMilvusExecuteTransition(ticket.operationId,action,await headers());
  current=null;backup.disabled=true;status.textContent=`Milvus ${action} verified; active generation ${result.generation}, old collection retained.`;
 }catch(e){pendingTransition=null;transitionExecute.disabled=true;
   status.textContent=`Milvus transition refused or uncertain: ${e.message}. Never blindly retry.`;}});
 section.append(title,desc,sourceMode,lore,preview,backup,id,verify,plan,execute,transitionAction,transitionPlan,transitionExecute,status);parent.append(section);return true;
}
export async function m4cMilvusPlanTransition(source,backupId,action,headers,fetchImpl){
 if(!UUID.test(backupId??'')||!['restore','empty'].includes(action))throw Error('M4C_TRANSITION_INPUT_INVALID');
 const d=await send('collections/transition/plan',{backend:'milvus',source,backupId,action},headers,fetchImpl);
 const consent=action==='restore'?'RESTORE OWNED MILVUS COLLECTION':'EMPTY OWNED MILVUS COLLECTION';
 if(d.backend!=='milvus'||d.action!==action||d.backupId!==backupId||d.state!=='PLANNED'||
  !UUID.test(d.operationId??'')||d.requiredConfirmation!==consent||d.oneUse!==true||
  d.oldPhysicalRetained!==true||!Number.isSafeInteger(d.expiresAt))throw Error('M4C_TRANSITION_PLAN_UNTRUSTED');
 return d;
}
export async function m4cMilvusExecuteTransition(operationId,action,headers,fetchImpl){
 if(!UUID.test(operationId??'')||!['restore','empty'].includes(action))throw Error('M4C_TRANSITION_INPUT_INVALID');
 const confirmation=action==='restore'?'RESTORE OWNED MILVUS COLLECTION':'EMPTY OWNED MILVUS COLLECTION';
 const d=await send('collections/transition/execute',{operationId,confirmation},headers,fetchImpl);
 if(d.backend!=='milvus'||d.state!=='VERIFIED'||d.action!==action||d.operationId!==operationId||
  !Number.isSafeInteger(d.generation)||d.generation<1||d.oldPhysicalRetained!==true||
  (action==='empty'&&d.verifiedEmpty!==true)||
  (action==='restore'&&(!Number.isSafeInteger(d.restoredCount)||d.restoredCount<0)))
  throw Error('M4C_TRANSITION_UNVERIFIED');
 return d;
}

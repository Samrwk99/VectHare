/** Vectra managed lifecycle. Only source selectors/one-use UUIDs cross HTTP.
 * No arbitrary path, physical name, owner or vector ever leaves this module.
 */
import {guardedVectorFetch} from './e02-vector-request-gateway.js';
import {f02CurrentChatSelector} from './f02-public-read-client.js';
const root='/api/plugins/similharity/v2/m4b/vectra/';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY=/^[a-f0-9]{64}$/;
async function send(route,body,headers={},fetchImpl=globalThis.fetch){
 const res=await guardedVectorFetch(root+route,{method:body===null?'GET':'POST',credentials:'same-origin',cache:'no-store',
  headers:{...headers,...(body===null?{}:{'Content-Type':'application/json'})},
  ...(body===null?{}:{body:JSON.stringify(body)})},fetchImpl);
 let data;try{data=await res.json();}catch{throw Error('M4B_RESPONSE_INVALID');}
 if(!res.ok||data?.success!==true)throw Error(data?.code??'M4B_REFUSED');return data;
}
export async function m4bVectraPreview(source,headers,fetchImpl){
 const d=await send('collections/preview',{backend:'vectra',source},headers,fetchImpl);
 if(d.backend!=='vectra'||!KEY.test(d.logicalKey??'')||d.ownerVerified!==true||
  d.completePhysicalInventory!==true||d.operationModes?.backup!=='ENABLED'||
  !Number.isSafeInteger(d.recordCount)||d.recordCount<0||d.productionWritesEnabled!==false)
  throw Error('M4B_PREVIEW_UNTRUSTED');return d;
}
export async function m4bVectraBackup(source,headers,fetchImpl){
 const d=await send('backups/create',{backend:'vectra',source,confirmation:'CAPTURE OWNED LOGICAL BACKUP'},headers,fetchImpl);
 if(d.backend!=='vectra'||d.state!=='VERIFIED'||!UUID.test(d.backupId??'')||
  d.physicalBackupVerified!==true||d.productionCertified!==false)throw Error('M4B_BACKUP_UNVERIFIED');return d;
}
export async function m4bVectraVerify(backupId,headers,fetchImpl){
 if(!UUID.test(backupId??''))throw Error('M4B_BACKUP_ID_INVALID');
 const d=await send(`backups/${backupId}/verify`,null,headers,fetchImpl);
 if(d.backend!=='vectra'||d.backupId!==backupId||d.integrityVerified!==true||
  !KEY.test(d.logicalKey??''))throw Error('M4B_VERIFY_UNTRUSTED');return d;
}
export async function m4bVectraPlanDelete(source,backupId,headers,fetchImpl){
 if(!UUID.test(backupId??''))throw Error('M4B_DELETE_BACKUP_ID_INVALID');
 const d=await send('collections/delete/plan',{backend:'vectra',source,backupId},headers,fetchImpl);
 if(d.backend!=='vectra'||d.state!=='PLANNED'||d.backupId!==backupId||
  !UUID.test(d.operationId??'')||d.requiredConfirmation!=='DELETE OWNED VECTRA COLLECTION'||
  d.oneUse!==true||!Number.isSafeInteger(d.expiresAt))throw Error('M4B_DELETE_PLAN_UNTRUSTED');return d;
}
export async function m4bVectraExecuteDelete(operationId,headers,fetchImpl){
 if(!UUID.test(operationId??''))throw Error('M4B_DELETE_ID_INVALID');
 const d=await send('collections/delete/execute',{operationId,confirmation:'DELETE OWNED VECTRA COLLECTION'},headers,fetchImpl);
 if(d.backend!=='vectra'||d.operationId!==operationId||d.state!=='VERIFIED'||
  d.registryTombstoned!==true||d.physicalAbsent!==true)throw Error('M4B_DELETE_RESULT_UNTRUSTED');return d;
}
export function renderM4bVectraLifecyclePanel(parent,doc=globalThis.document){
 if(!parent?.append||!doc?.createElement)return false;
 const section=doc.createElement('section');section.className='vecthare-m4b-vectra-lifecycle';
 const title=doc.createElement('h4');title.textContent='Vectra — owned collection backup and guarded deletion';
 const desc=doc.createElement('p');desc.textContent='Authenticated full-index backup and one-use deletion. Restore and scoped empty stage new private generations, verify physical readback, and retain historical indexes.';
 const sourceMode=doc.createElement('select');for(const [v,label] of [['chat','Current saved chat'],['lorebook','World Info lorebook']]){
  const option=doc.createElement('option');option.value=v;option.textContent=label;sourceMode.append(option);}
 const lore=doc.createElement('input');lore.type='text';lore.placeholder='Exact saved lorebook name';
 const make=(label)=>{const b=doc.createElement('button');b.type='button';b.textContent=label;return b;};
 const preview=make('Preview Vectra inventory'),backup=make('Create Vectra logical backup'),
  verify=make('Verify backup'),plan=make('Plan Vectra collection deletion'),execute=make('Execute one-use deletion');
 const id=doc.createElement('input');id.type='text';id.placeholder='Vectra backup UUID';
 const status=doc.createElement('p');status.setAttribute('role','status');
 const transitionAction=doc.createElement('select');for(const [v,label] of [['restore','Restore to a fresh Vectra generation'],['empty','Scoped empty (retain old index)']]){
  const option=doc.createElement('option');option.value=v;option.textContent=label;transitionAction.append(option);}
 const transitionPlan=make('Plan Vectra restore / scoped empty'),transitionExecute=make('Execute one-use transition');transitionExecute.disabled=true;
 let pendingTransition=null;
 backup.disabled=true;execute.disabled=true;
 let current=null,pending=null;
 const headers=async()=>{const m=await import('../../../../../script.js');return m.getRequestHeaders();};
 const selected=async()=>{if(sourceMode.value==='lorebook'){const name=lore.value.trim();if(!name||name.length>220)throw Error('Exact lorebook name required');return {kind:'lorebook',name};}
  const m=await import('../../../../../script.js');return f02CurrentChatSelector({getChatId:m.getCurrentChatId,getContext:()=>globalThis.SillyTavern?.getContext?.()});};
 preview.addEventListener('click',async()=>{try{const source=await selected(),proof=await m4bVectraPreview(source,await headers());current={source,proof};backup.disabled=false;pending=null;execute.disabled=true;
  status.textContent=`Vectra ${proof.logicalKey.slice(0,12)}: ${proof.recordCount} owned vectors.`;}
  catch(e){current=null;backup.disabled=true;status.textContent=`Vectra preview refused: ${e.message}`;}});
 backup.addEventListener('click',async()=>{try{if(!current||JSON.stringify(await selected())!==JSON.stringify(current.source))throw Error('Source changed');
  if(!globalThis.confirm?.('Capture a plaintext logical backup in private server storage?'))return;
  const d=await m4bVectraBackup(current.source,await headers());id.value=d.backupId;status.textContent=`Vectra backup ${d.backupId} verified.`;}
  catch(e){status.textContent=`Vectra backup refused: ${e.message}`;}});
 verify.addEventListener('click',async()=>{try{const d=await m4bVectraVerify(id.value.trim(),await headers());status.textContent=`Vectra backup ${d.backupId}, ${d.recordCount} records: integrity verified.`;}
  catch(e){status.textContent=`Vectra verification refused: ${e.message}`;}});
 plan.addEventListener('click',async()=>{try{pending=null;execute.disabled=true;const source=await selected();
  const verified=await m4bVectraVerify(id.value.trim(),await headers());
  if(!globalThis.confirm?.('Plan permanent deletion of this owned Vectra index?'))return;
  const proof=await m4bVectraPlanDelete(source,verified.backupId,await headers());pending={source,proof};execute.disabled=false;
  status.textContent=`Vectra deletion plan ${proof.operationId}; exact typed consent required.`;}
  catch(e){status.textContent=`Vectra delete plan refused: ${e.message}`;}});
 execute.addEventListener('click',async()=>{try{if(!pending||JSON.stringify(await selected())!==JSON.stringify(pending.source))throw Error('Source changed; replan');
  if(globalThis.prompt?.('Type DELETE OWNED VECTRA COLLECTION to confirm:')!=='DELETE OWNED VECTRA COLLECTION')throw Error('Exact confirmation required');
  const operationId=pending.proof.operationId;pending=null;execute.disabled=true;
  const result=await m4bVectraExecuteDelete(operationId,await headers());current=null;backup.disabled=true;
  status.textContent=`Vectra collection removed; receipt ${result.operationId}.`;}
  catch(e){pending=null;execute.disabled=true;status.textContent=`Vectra deletion refused or uncertain: ${e.message}. Never blindly retry.`;}});
 transitionPlan.addEventListener('click',async()=>{try{pendingTransition=null;transitionExecute.disabled=true;const source=await selected(),action=transitionAction.value;
  const verified=await m4bVectraVerify(id.value.trim(),await headers());
  if(!globalThis.confirm?.(`Plan ${action} of the Vectra collection using backup ${verified.backupId}? Original index retained.`))return;
  const ticket=await m4bVectraPlanTransition(source,verified.backupId,action,await headers());
  pendingTransition={source,action,ticket};transitionExecute.disabled=false;
  status.textContent=`Vectra ${action} plan ${ticket.operationId}; exact typed consent required.`;
 }catch(e){status.textContent=`Vectra transition plan refused: ${e.message}`;}});
 transitionExecute.addEventListener('click',async()=>{try{if(!pendingTransition||
  JSON.stringify(await selected())!==JSON.stringify(pendingTransition.source)||
  pendingTransition.action!==transitionAction.value)throw Error('Source/action changed; replan');
  const {ticket,action}=pendingTransition;
  if(globalThis.prompt?.(`Type ${ticket.requiredConfirmation} to confirm:`)!==ticket.requiredConfirmation)
   throw Error('Exact confirmation required');
  pendingTransition=null;transitionExecute.disabled=true;
  const result=await m4bVectraExecuteTransition(ticket.operationId,action,await headers());
  current=null;backup.disabled=true;status.textContent=`Vectra ${action} verified; active generation ${result.generation}, old index retained.`;
 }catch(e){pendingTransition=null;transitionExecute.disabled=true;
   status.textContent=`Vectra transition refused or uncertain: ${e.message}. Never blindly retry.`;}});
 section.append(title,desc,sourceMode,lore,preview,backup,id,verify,plan,execute,transitionAction,transitionPlan,transitionExecute,status);parent.append(section);return true;
}
export async function m4bVectraPlanTransition(source,backupId,action,headers,fetchImpl){
 if(!UUID.test(backupId??'')||!['restore','empty'].includes(action))throw Error('M4B_TRANSITION_INPUT_INVALID');
 const d=await send('collections/transition/plan',{backend:'vectra',source,backupId,action},headers,fetchImpl);
 const consent=action==='restore'?'RESTORE OWNED VECTRA COLLECTION':'EMPTY OWNED VECTRA COLLECTION';
 if(d.backend!=='vectra'||d.action!==action||d.backupId!==backupId||d.state!=='PLANNED'||
  !UUID.test(d.operationId??'')||d.requiredConfirmation!==consent||d.oneUse!==true||
  d.oldPhysicalRetained!==true||!Number.isSafeInteger(d.expiresAt))throw Error('M4B_TRANSITION_PLAN_UNTRUSTED');
 return d;
}
export async function m4bVectraExecuteTransition(operationId,action,headers,fetchImpl){
 if(!UUID.test(operationId??'')||!['restore','empty'].includes(action))throw Error('M4B_TRANSITION_INPUT_INVALID');
 const confirmation=action==='restore'?'RESTORE OWNED VECTRA COLLECTION':'EMPTY OWNED VECTRA COLLECTION';
 const d=await send('collections/transition/execute',{operationId,confirmation},headers,fetchImpl);
 if(d.backend!=='vectra'||d.state!=='VERIFIED'||d.action!==action||d.operationId!==operationId||
  !Number.isSafeInteger(d.generation)||d.generation<1||d.oldPhysicalRetained!==true||
  (action==='empty'&&d.verifiedEmpty!==true)||
  (action==='restore'&&(!Number.isSafeInteger(d.restoredCount)||d.restoredCount<0)))
  throw Error('M4B_TRANSITION_UNVERIFIED');
 return d;
}

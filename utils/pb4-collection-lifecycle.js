import {publishManagedViewInvalidation,watchManagedViewInvalidation} from './pb11-managed-view-coherence.js';
/** P-B.4: Database Browser workflow for already-certified M3 Qdrant operations.
 * Not an alternate mutation route. The browser supplies only saved-source
 * selectors and server-issued backup/plan IDs; the server owns the target.
 */
import {m3Preview,m3Backup,m3VerifyBackup,m3Plan,m3Execute} from './m3-collections-gui.js';
import {f02CurrentChatSelector} from './f02-public-read-client.js';

export const PB4_CONFIRMATIONS=Object.freeze({
 delete:'DELETE OWNED COLLECTION',empty:'EMPTY OWNED COLLECTION',restore:'RESTORE TO FRESH COLLECTION'
});
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY=/^[a-f0-9]{64}$/;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function unchanged(before,after){
 return before.logicalKey===after.logicalKey&&before.routingGeneration===after.routingGeneration&&
 before.recordCount===after.recordCount&&
 (!before.inventoryDigest||before.inventoryDigest===after.inventoryDigest)&&
 (!before.fileFingerprint||before.fileFingerprint===after.fileFingerprint);
}
const methods=Object.freeze({preview:m3Preview,backup:m3Backup,verify:m3VerifyBackup,plan:m3Plan,execute:m3Execute});
/** Lifecycle state is scoped to one source and one Qdrant config, never a
 * browser-discovered physical collection name. No implicit mutation retries. */
export class PB4LifecycleSession {
 constructor({source,configId='default',headers={},api=methods,fetchImpl=globalThis.fetch}){
  if(!source||!['chat','lorebook'].includes(source.kind)||
    !['default','local'].includes(configId))throw Error('PB4_SELECTOR_INVALID');
  this.source=structuredClone(source);this.configId=configId;this.headers=headers;
  this.api=api;this.fetchImpl=fetchImpl;this.preview=null;this.backup=null;
  this.pending=null;this.busy=false;this.terminal=false;
 }
 ensure(source,configId){if(this.terminal||!same(source,this.source)||configId!==this.configId)
  throw Error('PB4_SELECTION_CHANGED');}
 async locked(fn){if(this.busy)throw Error('PB4_OPERATION_IN_PROGRESS');this.busy=true;
  try{return await fn();}finally{this.busy=false;}}
 async inspect(source=this.source,configId=this.configId){return this.locked(async()=>{
  this.ensure(source,configId);this.pending=null;this.backup=null;this.preview=null;
  const p=await this.api.preview(this.source,this.configId,this.headers,this.fetchImpl);
  if(!KEY.test(p.logicalKey??'')||p.ownerVerified!==true||!Number.isSafeInteger(p.recordCount))
   throw Error('PB4_PREVIEW_UNVERIFIED');
  this.preview=p;return p;
 });}
 async capture(source=this.source,configId=this.configId){return this.locked(async()=>{
  this.ensure(source,configId);if(!this.preview)throw Error('PB4_INSPECT_FIRST');
  this.pending=null;this.backup=null;
  const fresh=await this.api.preview(this.source,this.configId,this.headers,this.fetchImpl);
  if(!unchanged(this.preview,fresh))throw Error('PB4_COLLECTION_CHANGED');
  const backup=await this.api.backup(this.source,this.configId,this.headers,this.fetchImpl);
  if(!UUID.test(backup.backupId??'')||backup.logicalKey!==this.preview.logicalKey||
     backup.state!=='VERIFIED'||backup.physicalBackupVerified!==true)
   throw Error('PB4_BACKUP_UNVERIFIED');
  const verified=await this.api.verify(backup.backupId,this.headers,this.fetchImpl);
  if(verified.integrityVerified!==true||verified.backupId!==backup.backupId||
    verified.logicalKey!==this.preview.logicalKey)throw Error('PB4_BACKUP_INTEGRITY_UNVERIFIED');
  this.backup={backupId:backup.backupId,logicalKey:backup.logicalKey};return this.backup;
 });}
 async plan(action,source=this.source,configId=this.configId){return this.locked(async()=>{
  this.ensure(source,configId);this.pending=null;
  if(!Object.hasOwn(PB4_CONFIRMATIONS,action)||!this.preview||!this.backup)
   throw Error('PB4_BACKUP_AND_INSPECTION_REQUIRED');
  const fresh=await this.api.preview(this.source,this.configId,this.headers,this.fetchImpl);
  if(!unchanged(this.preview,fresh))throw Error('PB4_COLLECTION_CHANGED');
  const verified=await this.api.verify(this.backup.backupId,this.headers,this.fetchImpl);
  if(verified.integrityVerified!==true||verified.logicalKey!==this.preview.logicalKey||
    verified.backupId!==this.backup.backupId)throw Error('PB4_BACKUP_STALE');
  const plan=await this.api.plan(this.source,action,this.backup.backupId,this.configId,this.headers,this.fetchImpl);
  if(plan.executionAllowed!==true||plan.action!==action||plan.backupId!==this.backup.backupId||
     !UUID.test(plan.operationId??''))throw Error('PB4_EXECUTION_NOT_AUTHORIZED');
  this.pending={operationId:plan.operationId,action};return {...this.pending,confirmation:PB4_CONFIRMATIONS[action]};
 });}
 async execute({phrase,source=this.source,configId=this.configId}={}){return this.locked(async()=>{
  this.ensure(source,configId);
  const pending=this.pending;
  if(!pending||phrase!==PB4_CONFIRMATIONS[pending.action])throw Error('PB4_TYPED_CONFIRMATION_REQUIRED');
  // Consume the plan before any await or dispatch, even when response is lost.
  this.pending=null;this.terminal=true;
  const result=await this.api.execute(pending.operationId,pending.action,this.headers,this.fetchImpl);
  if(result.operationId!==pending.operationId||result.state!=='VERIFIED')
   throw Error('PB4_RECEIPT_UNVERIFIED');
  return result;
 });}
}
/** A compact, visible P08 workspace. Qdrant only; no legacy hashes or purge. */
export function renderPB4Lifecycle(root,doc=globalThis.document){
 if(!root||!doc?.createElement||root.querySelector?.('#vecthare_pb4_lifecycle'))return false;
 const section=doc.createElement('section');section.id='vecthare_pb4_lifecycle';
 const title=doc.createElement('h4');title.textContent='Managed collection lifecycle (owned Qdrant only)';
 const help=doc.createElement('p');help.textContent='Uses M3 authenticated source-owned collection preview, private verified backup, one-use plan, typed confirmation and receipt. No unrestricted purge. Backups stay on the server. Other backends require separate proven lifecycle contracts.';
 const kind=doc.createElement('select');for(const [v,t] of [['chat','Current saved chat'],['lorebook','Saved lorebook']]){
  const o=doc.createElement('option');o.value=v;o.textContent=t;kind.append(o);}
 const name=doc.createElement('input');name.type='text';name.placeholder='Exact saved lorebook name';
 const config=doc.createElement('select');for(const v of ['default','local']){const o=doc.createElement('option');o.value=v;o.textContent=v;config.append(o);}
 const inspect=doc.createElement('button');inspect.type='button';inspect.textContent='1. Inspect owned collection';
 const backup=doc.createElement('button');backup.type='button';backup.textContent='2. Capture and verify backup';
 const action=doc.createElement('select');for(const v of ['empty','restore','delete']){const o=doc.createElement('option');o.value=v;o.textContent=v;action.append(o);}
 const plan=doc.createElement('button');plan.type='button';plan.textContent='3. Plan backed-up operation';
 const typed=doc.createElement('input');typed.type='text';typed.placeholder='Type exact confirmation from plan';
 const execute=doc.createElement('button');execute.type='button';execute.textContent='4. Execute one-use plan';
 const status=doc.createElement('p');status.setAttribute('role','status');
 let session=null,epoch=0,busy=false;
 const selector=async()=>{if(kind.value==='lorebook'){
  const n=name.value.trim();if(!n||n.length>220)throw Error('Exact lorebook name required');return {kind:'lorebook',name:n};}
  const m=await import('../../../../../script.js');return f02CurrentChatSelector({getChatId:m.getCurrentChatId,getContext:()=>globalThis.SillyTavern?.getContext?.()});};
 const headers=async()=>{const m=await import('../../../../../script.js');return m.getRequestHeaders();};
 const currentConfig=()=>config.value;
 const clear=()=>{epoch++;session=null;typed.value='';render();};
 const render=()=>{inspect.disabled=busy;backup.disabled=busy||!session?.preview||Boolean(session?.terminal);
  plan.disabled=busy||!session?.backup||Boolean(session?.terminal);
  execute.disabled=busy||!session?.pending||Boolean(session?.terminal);};
 watchManagedViewInvalidation(reason=>{clear();status.textContent=`Managed lifecycle evidence expired (${reason}); inspect again.`;},{identity:section,document:doc,window:doc.defaultView??globalThis.window});
 for(const el of [kind,name,config])el.addEventListener('change',clear);
 const operate=async fn=>{if(busy)return;busy=true;render();const version=epoch;
  try{const s=await selector(),c=currentConfig();await fn(s,c);
   if(epoch!==version)throw Error('PB4_SELECTION_CHANGED');}
  catch(e){if(epoch===version)status.textContent=`Collection lifecycle refused or outcome uncertain: ${e.message}. Never replay a dispatched plan; inspect server operation evidence.`;}
  finally{busy=false;render();}};
 inspect.addEventListener('click',()=>operate(async(s,c)=>{session=new PB4LifecycleSession({source:s,configId:c,headers:await headers()});
  const p=await session.inspect(s,c);status.textContent=`Owned collection verified: ${p.recordCount} records, logical key ${p.logicalKey.slice(0,12)}, generation ${p.routingGeneration}. No write authorized.`;}));
 backup.addEventListener('click',()=>operate(async(s,c)=>{session.ensure(s,c);
  if(!globalThis.confirm?.('Capture a private server-side backup of this verified owned collection? It can contain sensitive text.'))return;
  const b=await session.capture(s,c);status.textContent=`Backup integrity VERIFIED: ${b.backupId}. No destructive action taken.`;}));
 plan.addEventListener('click',()=>operate(async(s,c)=>{session.ensure(s,c);const p=await session.plan(action.value,s,c);
  typed.value='';status.textContent=`One-use ${p.action} plan ${p.operationId}. Type exactly: ${p.confirmation}. The server may still refuse execution.`;}));
 execute.addEventListener('click',()=>operate(async(s,c)=>{session.ensure(s,c);
  if(typed.value!==PB4_CONFIRMATIONS[session.pending?.action])throw Error('PB4_TYPED_CONFIRMATION_REQUIRED');
  if(!globalThis.confirm?.('Execute this irreversible one-use owned-collection plan? An uncertain result MUST NOT be retried.'))return;
  publishManagedViewInvalidation({sender:section});
  const result=await session.execute({phrase:typed.value,source:s,configId:c});
  status.textContent=`M3 receipt VERIFIED for ${result.operationId}. Reinspect the collection and other tabs; do not reuse the old plan.`;}));
 section.append(title,help,kind,name,config,inspect,backup,action,plan,typed,execute,status);
 root.prepend(section);render();return true;
}

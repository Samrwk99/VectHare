import {publishManagedViewInvalidation,watchManagedViewInvalidation} from './pb11-managed-view-coherence.js';
/** P-B.9: Functional M4 lifecycle UI for source-owned LanceDB, Vectra and
 * Milvus. All decisions/physical names are server-authored M4 contracts.
 * A received or possibly dispatched one-use ticket is NEVER replayed.
 */
import {guardedVectorFetch} from './e02-vector-request-gateway.js';
import {f02CurrentChatSelector} from './f02-public-read-client.js';
const ROOT='/api/plugins/similharity/v2';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY=/^[a-f0-9]{64}$/;
const DIGEST=/^[a-f0-9]{64}$/;
const DESCRIPTORS=Object.freeze({
 lancedb:Object.freeze({prefix:'/m4a/lancedb',label:'LanceDB',confirm:Object.freeze({delete:'DELETE OWNED LANCEDB COLLECTION',empty:'EMPTY OWNED LANCEDB COLLECTION',restore:'RESTORE OWNED LANCEDB COLLECTION'})}),
 vectra:Object.freeze({prefix:'/m4b/vectra',label:'Vectra',confirm:Object.freeze({delete:'DELETE OWNED VECTRA COLLECTION',empty:'EMPTY OWNED VECTRA COLLECTION',restore:'RESTORE OWNED VECTRA COLLECTION'})}),
 milvus:Object.freeze({prefix:'/m4c/milvus',label:'Milvus',confirm:Object.freeze({delete:'DELETE OWNED MILVUS COLLECTION',empty:'EMPTY OWNED MILVUS COLLECTION',restore:'RESTORE OWNED MILVUS COLLECTION'})}),
});
export const PB9_BACKENDS=Object.freeze(Object.keys(DESCRIPTORS));
export function pb9Confirmation(backend,action){return DESCRIPTORS[backend]?.confirm[action]??null;}
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function assertSource(source){
 const fields={chat:['kind','avatar','chatFile'],'group-chat':['kind','groupId','chatFile'],lorebook:['kind','name']}[source?.kind];
 if(!fields||!source||typeof source!=='object'||Array.isArray(source)||
    Object.keys(source).some(k=>!fields.includes(k))||fields.some(k=>typeof source[k]!=='string'||!source[k]||source[k].length>220))
  throw Error('PB9_SOURCE_INVALID');
}
function assertPreview(p,backend){
 if(p?.backend!==backend||!KEY.test(p.logicalKey??'')||p.ownerVerified!==true||
    p.completePhysicalInventory!==true||!Number.isSafeInteger(p.recordCount)||p.recordCount<0||
    !DIGEST.test(p.inventoryDigest??'')||p.productionWritesEnabled!==false||
    !p.operationModes||p.operationModes.backup!=='ENABLED')throw Error('PB9_PREVIEW_UNVERIFIED');
 return p;
}
function sameInventory(a,b){return a.backend===b.backend&&a.logicalKey===b.logicalKey&&
 a.inventoryDigest===b.inventoryDigest&&a.recordCount===b.recordCount&&
 same(a.operationModes,b.operationModes);}
async function apiRequest(backend,path,body,headers,fetchImpl){
 const prefix=DESCRIPTORS[backend]?.prefix;if(!prefix)throw Error('PB9_BACKEND_INVALID');
 const r=await guardedVectorFetch(ROOT+prefix+path,{method:body===null?'GET':'POST',
  credentials:'same-origin',cache:'no-store',headers:{...headers,...(body===null?{}:{'Content-Type':'application/json'})},
  ...(body===null?{}:{body:JSON.stringify(body)})},fetchImpl);
 let d;try{d=await r.json();}catch{throw Error('PB9_RESPONSE_INVALID');}
 if(!r.ok||d?.success!==true)throw Error(d?.code??'PB9_REQUEST_REFUSED');return d;
}
/** Network adapter performs its own response validation; session never trusts UI data. */
export function pb9M4Api(fetchImpl=globalThis.fetch){
 const selector=(backend,source)=>({backend,source,configId:'default'});
 return {
  async preview(backend,source,headers){return assertPreview(await apiRequest(backend,'/collections/preview',selector(backend,source),headers,fetchImpl),backend);},
  async backup(backend,source,headers){const d=await apiRequest(backend,'/backups/create',
   {...selector(backend,source),confirmation:'CAPTURE OWNED LOGICAL BACKUP'},headers,fetchImpl);
   if(d.backend!==backend||d.state!=='VERIFIED'||!UUID.test(d.backupId??'')||
     !KEY.test(d.logicalKey??'')||d.physicalBackupVerified!==true||
     !Number.isSafeInteger(d.count)||!DIGEST.test(d.inventoryDigest??''))throw Error('PB9_BACKUP_UNVERIFIED');return d;},
  async verify(backend,backupId,headers){if(!UUID.test(backupId))throw Error('PB9_BACKUP_ID_INVALID');
   const d=await apiRequest(backend,`/backups/${backupId}/verify`,null,headers,fetchImpl);
   if(d.backend!==backend||d.backupId!==backupId||d.integrityVerified!==true||
      !KEY.test(d.logicalKey??'')||!DIGEST.test(d.inventoryDigest??'')||
      !Number.isSafeInteger(d.recordCount))throw Error('PB9_BACKUP_VERIFY_UNTRUSTED');return d;},
  async plan(backend,source,action,backupId,headers){
   const suffix=action==='delete'?'/collections/delete/plan':'/collections/transition/plan';
   const d=await apiRequest(backend,suffix,{...selector(backend,source),backupId,...(action==='delete'?{}:{action})},headers,fetchImpl);
   if(d.backend!==backend||d.state!=='PLANNED'||!UUID.test(d.operationId??'')||
      d.backupId!==backupId||d.action!==action&&!(action==='delete'&&d.action===undefined)||
      d.requiredConfirmation!==pb9Confirmation(backend,action)||d.oneUse!==true||
      !KEY.test(d.logicalKey??'')||!Number.isSafeInteger(d.recordCount)||
      !Number.isFinite(d.expiresAt)||d.expiresAt<=Date.now())throw Error('PB9_PLAN_UNTRUSTED');
   return d;},
  async execute(backend,action,operationId,headers){if(!UUID.test(operationId)||!pb9Confirmation(backend,action))throw Error('PB9_EXECUTE_INVALID');
   const suffix=action==='delete'?'/collections/delete/execute':'/collections/transition/execute';
   const d=await apiRequest(backend,suffix,{operationId,confirmation:pb9Confirmation(backend,action)},headers,fetchImpl);
   if(d.backend!==backend||d.state!=='VERIFIED'||d.operationId!==operationId||
      !KEY.test(d.logicalKey??'')||d.productionCertified!==false||
      (action==='delete'&&(d.physicalAbsent!==true||d.registryTombstoned!==true))||
      (action==='empty'&&(d.verifiedEmpty!==true||d.oldPhysicalRetained!==true))||
      (action==='restore'&&d.oldPhysicalRetained!==true))throw Error('PB9_RECEIPT_UNVERIFIED');
   return d;}
 };
}
export class PB9LifecycleSession {
 constructor({backend,source,headers={},api=pb9M4Api()}){
  if(!DESCRIPTORS[backend])throw Error('PB9_BACKEND_INVALID');assertSource(source);
  this.backend=backend;this.source=structuredClone(source);this.headers=headers;this.api=api;
  this.preview=null;this.backup=null;this.pending=null;this.terminal=false;this.busy=false;
 }
 ensure(backend=this.backend,source=this.source){if(this.terminal||backend!==this.backend||!same(source,this.source))throw Error('PB9_SELECTION_CHANGED');}
 async locked(fn){if(this.busy)throw Error('PB9_OPERATION_IN_PROGRESS');this.busy=true;try{return await fn();}finally{this.busy=false;}}
 async inspect(backend=this.backend,source=this.source){return this.locked(async()=>{
  this.ensure(backend,source);this.preview=null;this.backup=null;this.pending=null;
  const p=assertPreview(await this.api.preview(this.backend,this.source,this.headers),this.backend);this.preview=p;return p;});}
 async capture(backend=this.backend,source=this.source){return this.locked(async()=>{
  this.ensure(backend,source);this.backup=null;this.pending=null;if(!this.preview)throw Error('PB9_INSPECT_FIRST');
  const fresh=assertPreview(await this.api.preview(this.backend,this.source,this.headers),this.backend);
  if(!sameInventory(this.preview,fresh))throw Error('PB9_COLLECTION_CHANGED');
  const b=await this.api.backup(this.backend,this.source,this.headers);
  if(b.state!=='VERIFIED'||b.backend!==this.backend||!UUID.test(b.backupId??'')||
     b.logicalKey!==this.preview.logicalKey||b.count!==this.preview.recordCount||
     b.inventoryDigest!==this.preview.inventoryDigest||b.physicalBackupVerified!==true)
   throw Error('PB9_BACKUP_MISMATCH');
  const verified=await this.api.verify(this.backend,b.backupId,this.headers);
  if(verified.integrityVerified!==true||verified.backupId!==b.backupId||verified.logicalKey!==b.logicalKey||
     verified.inventoryDigest!==b.inventoryDigest||verified.recordCount!==b.count)throw Error('PB9_BACKUP_VERIFY_MISMATCH');
  this.backup={backupId:b.backupId,logicalKey:b.logicalKey,inventoryDigest:b.inventoryDigest,recordCount:b.count};return this.backup;});}
 async plan(action,backend=this.backend,source=this.source){return this.locked(async()=>{
  this.ensure(backend,source);this.pending=null;
  if(!pb9Confirmation(this.backend,action)||!this.preview||!this.backup)throw Error('PB9_VERIFIED_BACKUP_REQUIRED');
  if(this.preview.operationModes[action]!=='ENABLED')throw Error('PB9_ACTION_BLOCKED');
  const fresh=assertPreview(await this.api.preview(this.backend,this.source,this.headers),this.backend);
  if(!sameInventory(this.preview,fresh))throw Error('PB9_COLLECTION_CHANGED');
  const b=await this.api.verify(this.backend,this.backup.backupId,this.headers);
  if(b.integrityVerified!==true||b.logicalKey!==this.backup.logicalKey||
     b.inventoryDigest!==this.backup.inventoryDigest||b.recordCount!==this.backup.recordCount)throw Error('PB9_BACKUP_CHANGED');
  const p=await this.api.plan(this.backend,this.source,action,this.backup.backupId,this.headers);
  if(p.state!=='PLANNED'||p.backend!==this.backend||p.logicalKey!==this.backup.logicalKey||
     p.backupId!==this.backup.backupId||p.action!==action&&!(action==='delete'&&p.action===undefined)||
     p.requiredConfirmation!==pb9Confirmation(this.backend,action)||p.oneUse!==true||
     !UUID.test(p.operationId??'')||!Number.isFinite(p.expiresAt)||p.expiresAt<=Date.now())throw Error('PB9_PLAN_UNTRUSTED');
  this.pending={action,operationId:p.operationId,expiresAt:p.expiresAt};return {...this.pending,confirmation:pb9Confirmation(this.backend,action)};});}
 async execute({phrase,backend=this.backend,source=this.source}={}){return this.locked(async()=>{
  this.ensure(backend,source);const p=this.pending;
  if(!p||phrase!==pb9Confirmation(this.backend,p.action))throw Error('PB9_TYPED_CONFIRMATION_REQUIRED');
  if(p.expiresAt<=Date.now()){this.pending=null;throw Error('PB9_PLAN_EXPIRED');}
  // IMPORTANT: terminal before awaiting network dispatch; lost ACK cannot lead to replay.
  this.terminal=true;this.pending=null;
  const d=await this.api.execute(this.backend,p.action,p.operationId,this.headers);
  if(d.state!=='VERIFIED'||d.backend!==this.backend||d.operationId!==p.operationId||
     d.logicalKey!==this.backup.logicalKey||d.productionCertified!==false||
     (p.action==='delete'&&(d.physicalAbsent!==true||d.registryTombstoned!==true))||
     (p.action==='empty'&&(d.verifiedEmpty!==true||d.oldPhysicalRetained!==true))||
     (p.action==='restore'&&d.oldPhysicalRetained!==true))throw Error('PB9_RECEIPT_UNVERIFIED');
  return d;});}
}
/** One separate modal section, preserving the existing Qdrant M3 workspace. */
export function renderPB9Lifecycle(root,doc=globalThis.document){
 if(!root||!doc?.createElement||root.querySelector?.('#vecthare_pb9_lifecycle'))return false;
 const section=doc.createElement('section');section.id='vecthare_pb9_lifecycle';
 const title=doc.createElement('h4');title.textContent='Managed collection lifecycle — LanceDB / Vectra / Milvus';
 const help=doc.createElement('p');help.textContent='Uses source-owned M4 complete physical inventory, private backup and verification, one-use plans, exact confirmation and authoritative receipts. Delete is not available for cutover generations. Run destructive operations only on disposable collections until live validated. No purge or automatic replay.';
 const select=(choices)=>{const el=doc.createElement('select');for(const [value,label] of choices){const o=doc.createElement('option');o.value=value;o.textContent=label;el.append(o);}return el;};
 const backend=select(PB9_BACKENDS.map(x=>[x,DESCRIPTORS[x].label]));
 const kind=select([['chat','Current saved chat'],['lorebook','Saved lorebook']]);
 const name=doc.createElement('input');name.type='text';name.placeholder='Exact saved lorebook name';
 const action=select([['empty','Empty into a new generation'],['restore','Restore backed-up generation'],['delete','Delete canonical owned collection']]);
 const button=(label)=>{const b=doc.createElement('button');b.type='button';b.textContent=label;return b;};
 const inspect=button('1. Inspect full physical collection'),backup=button('2. Capture and verify backup');
 const plan=button('3. Plan owned lifecycle action'),execute=button('4. Execute one-use plan');
 const typed=doc.createElement('input');typed.type='text';typed.placeholder='Type the exact operation confirmation';
 const status=doc.createElement('p');status.setAttribute('role','status');let session=null,busy=false,epoch=0;
 const selector=async()=>{if(kind.value==='lorebook'){const n=name.value.trim();if(!n||n.length>220)throw Error('PB9_LOREBOOK_NAME_REQUIRED');return {kind:'lorebook',name:n};}
  const m=await import('../../../../../script.js');return f02CurrentChatSelector({getChatId:m.getCurrentChatId,getContext:()=>globalThis.SillyTavern?.getContext?.()});};
 const headers=async()=>{const m=await import('../../../../../script.js');return m.getRequestHeaders();};
 const render=()=>{inspect.disabled=busy;backup.disabled=busy||!session?.preview||session.terminal;
  plan.disabled=busy||!session?.backup||session.terminal;execute.disabled=busy||!session?.pending||session.terminal;};
 const reset=()=>{epoch++;session=null;typed.value='';status.textContent='Selection changed. Inspect again.';render();};
 watchManagedViewInvalidation(reason=>{reset();status.textContent=`Managed lifecycle evidence expired (${reason}); inspect again.`;},{identity:section,document:doc,window:doc.defaultView??globalThis.window});
 for(const el of [backend,kind,name])el.addEventListener('change',reset);
 action.addEventListener('change',()=>{if(session)session.pending=null;typed.value='';render();});
 const operate=async fn=>{if(busy)return;busy=true;render();const version=epoch;
  try{const source=await selector();const message=await fn(source);if(version!==epoch)throw Error('PB9_SELECTION_CHANGED');
   if(message)status.textContent=message;}
  catch(e){if(version===epoch)status.textContent=`M4 lifecycle refused or uncertain: ${e.message}. Do not replay a dispatched operation; inspect server evidence.`;}
  finally{busy=false;render();}};
 inspect.addEventListener('click',()=>operate(async source=>{session=new PB9LifecycleSession({backend:backend.value,source,headers:await headers()});
  const p=await session.inspect();return `Owned ${backend.value} collection: ${p.recordCount} physical records, inventory ${p.inventoryDigest.slice(0,12)}. No write authorized.`;}));
 backup.addEventListener('click',()=>operate(async source=>{session.ensure(backend.value,source);
  if(!globalThis.confirm?.('Capture private server backup of this complete source-owned collection?'))return;
  const b=await session.capture();return `Backup VERIFIED: ${b.backupId}. No mutation performed.`;}));
 plan.addEventListener('click',()=>operate(async source=>{session.ensure(backend.value,source);
  const p=await session.plan(action.value);typed.value='';return `One-use ${action.value} plan ${p.operationId}. Type exactly: ${p.confirmation}. The server may still refuse.`;}));
 execute.addEventListener('click',()=>operate(async source=>{session.ensure(backend.value,source);
  if(typed.value!==pb9Confirmation(backend.value,session.pending?.action))throw Error('PB9_TYPED_CONFIRMATION_REQUIRED');
  if(!globalThis.confirm?.('Execute irreversible managed collection operation? Never retry if response is uncertain.'))return;
  publishManagedViewInvalidation({sender:section});
  const d=await session.execute({phrase:typed.value});return `M4 receipt VERIFIED for ${d.operationId}. Reinspect before any further operation.`;}));
 section.append(title,help,backend,kind,name,inspect,backup,action,plan,typed,execute,status);
 root.prepend(section);render();return true;
}

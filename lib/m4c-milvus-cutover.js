/** M4c.2: strictly read-only MilvusDB generation resolver and target attestation.
 * Only the private append-only journal can select a different physical index.
 * It is NOT permission to write, create, restore, or delete an index.
 */
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import {OperationLedger} from './s04-ledger.js';
import {M3CutoverJournal,guardM3CanonicalBinding} from './m3-cutover-journal.js';
import {M3Store,assertM3ManagedCompleteness} from './m3-collections.js';
import {ManagedChatRegistry} from './f09b4-managed-registry.js';
import {m4cMilvusLifecycleAdapter} from './m4c-milvus-contract.js';
import {markM3ResolvedBinding} from './m3-versioned-binding.js';


const sha=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const KEY=/^[a-f0-9]{64}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][0-9a-f]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const reject=code=>{throw Object.assign(new Error(code),{code,status:409});};
const eq=(x,y)=>JSON.stringify(x)===JSON.stringify(y);
function targetBinding(canonical,active){
 return markM3ResolvedBinding(canonical,{...active,canonicalName:canonical.collection.physicalName});
}
/** Live complete physical scan and managed inventory check; no filtering out
 * foreign rows and no casual count-only assertion. Call under a logical read
 * barrier for destructive actions. Normal scoped read can fail safely on races.
 */
export async function inspectM4cMilvusTarget(ctx,canonical,active,{backend,registry=null}={}){
 if(!ctx?.userScopeId||canonical?.backend!=='milvus'||!backend?.client||
    !Number.isSafeInteger(active?.generation)||active.generation<1||!KEY.test(active?.logicalKey??''))
  reject('M4C_TARGET_CONTEXT_REQUIRED');
 const binding=targetBinding(canonical,active);
 const adapter=m4cMilvusLifecycleAdapter({backend,binding,writerBoundary:async fn=>fn()});
 const [schema,first,second,managed]=await Promise.all([
  adapter.inspectSchema(),adapter.getInventory(),adapter.getInventory(),
  registry?.read?registry.read():new ManagedChatRegistry(ctx,canonical).read()]);
 if(schema?.schemaInspected!==true||schema?.indexVerified!==true||first.fullPhysicalScan!==true||first.ownerVerified!==true||
   first.logicalFingerprint!==second.logicalFingerprint||first.count!==second.count||
   !Array.isArray(first.items)||first.items.length!==first.count)reject('M4C_TARGET_INVENTORY_UNVERIFIED');
 const rows=first.items.map(r=>({id:r.physicalId,vector:r.vector,payload:r}));
 const inventory={rows,count:rows.length,digest:sha(rows),complete:true,exclusiveOwner:true};
 assertM3ManagedCompleteness(managed,inventory,binding);
 return {verified:true,schemaVerified:true,inventoryVerified:true,exclusiveOwner:true,
  receiptVerified:false,logicalKey:active.logicalKey,physicalName:active.physicalName,
  generation:active.generation,count:inventory.count,digest:inventory.digest,
  managedFingerprint:managed.fingerprint,rows:inventory.rows};
}
/** The original target receipt is immutable. Future M1-verified record edits can
 * change physical inventory, but only when the complete managed registry still
 * agrees with the physical index. The receipt cannot be substituted with a
 * browser-selected path or an unverified restoration target.
 */
export async function verifyM4cMilvusTargetReceipt(ctx,canonical,active,{backend,store=null,registry=null}={}){
 const journal=new M3CutoverJournal(ctx,{backend:'milvus',logicalKey:canonical.collection.key});
 const events=await journal.events(),publication=[...events].reverse().find(e=>e.state==='PUBLISHED');
 if(!publication||!UUID.test(publication.operationId??'')||publication.to!==active.physicalName||
    publication.operationId!==events.at(-1)?.operationId)reject('M4C_TARGET_PUBLICATION_REQUIRED');
 const receipt=await (store??new M3Store(ctx)).read('target',publication.operationId);
 if(receipt.schemaVersion!==1||receipt.backend!=='milvus'||receipt.owner!==ctx.userScopeId||
    receipt.operationId!==publication.operationId||receipt.logicalKey!==active.logicalKey||
    receipt.physicalName!==active.physicalName||receipt.generation!==active.generation||
    !KEY.test(receipt.inventoryDigest??'')||!eq(receipt.embedding,canonical.embedding))
  reject('M4C_TARGET_RECEIPT_INVALID');
 const observed=await inspectM4cMilvusTarget(ctx,canonical,active,{backend,registry});
 const backup=await (store??new M3Store(ctx)).read('backup',receipt.backupId);
 if(backup.owner!==ctx.userScopeId||backup.backend!=='milvus'||backup.logicalKey!==active.logicalKey||
   backup.inventory?.digest!==receipt.inventoryDigest||backup.inventory?.count!==receipt.inventoryCount||
   !Array.isArray(backup.inventory.rows)||backup.inventory.digest!==sha(backup.inventory.rows)||
   !eq(backup.embedding,canonical.embedding)||!eq(backup.scope,canonical.scope))
  reject('M4C_TARGET_BASELINE_INVALID');
 if(observed.digest!==receipt.inventoryDigest){
  // A published target is mutable by normal S04 jobs. Each physical delta
  // must be supported by a verified same-generation, same-target ledger plan.
  const baseline=new Map(backup.inventory.rows.map(row=>[String(row.id),row]));
  const current=new Map(observed.rows.map(row=>[String(row.id),row]));
  if(baseline.size!==backup.inventory.rows.length||current.size!==observed.rows.length)
   reject('M4C_TARGET_DUPLICATE_ID');
  const changes=[];
  for(const [id,row] of current){const previous=baseline.get(id);
   if(!previous||!eq(previous,row))changes.push({recordId:row.payload.recordId,
    action:previous?'update':'insert',revision:row.payload.revision});}
  for(const [id,row] of baseline)if(!current.has(id))
   changes.push({recordId:row.payload.recordId,action:'delete',revision:null});
  if(!changes.length)reject('M4C_TARGET_UNEXPLAINED_EVOLUTION');
  const ledger=new OperationLedger(ctx);await ledger.setup();
  const names=(await fs.readdir(ledger.root)).filter(name=>name.endsWith('.json'));
  if(names.length>50000||names.some(name=>!UUID.test(name.slice(0,-5))))
   reject('M4C_TARGET_LEDGER_UNTRUSTED');
  const verified=[];
  for(const name of names){
   const op=await ledger.read(name.slice(0,-5));
   if(op.plan?.collectionKey!==active.logicalKey)continue;
   if(!['VERIFIED','FAILED'].includes(op.state))reject('M4C_TARGET_PENDING_JOB');
   if(op.state==='VERIFIED'&&op.plan.backend==='milvus'&&
      op.plan.physicalCollectionName===active.physicalName&&
      op.plan.routingGeneration===active.generation)verified.push(op.plan);
  }
  for(const item of changes)if(!verified.some(plan=>plan.recordId===item.recordId&&
   (item.action==='insert'?plan.action==='insert':
    item.action==='delete'?plan.action==='delete':['update','metadata'].includes(plan.action))&&
   (item.revision===null||plan.targetRevision===item.revision)))
   reject('M4C_TARGET_EVOLUTION_RECEIPT_MISSING');
 }
 return {...observed,receiptVerified:true,initialInventoryDigest:receipt.inventoryDigest};
}
export async function resolveM4cMilvusReadBinding(ctx,canonical,{backend,store=null,registry=null}={}){
 if(canonical?.backend!=='milvus'||canonical.scope?.userScopeId!==ctx?.userScopeId||
   !backend?.client?.query)reject('M4C_ROUTING_UNVERIFIED');
 const journal=new M3CutoverJournal(ctx,{backend:'milvus',logicalKey:canonical.collection.key});
 const active=await journal.resolve(canonical);
 if(active.generation===0){await guardM3CanonicalBinding(ctx,canonical);return canonical;}
 const checked=await verifyM4cMilvusTargetReceipt(ctx,canonical,active,{backend,store,registry});
 if(checked.verified!==true||checked.receiptVerified!==true||checked.schemaVerified!==true)
  reject('M4C_TARGET_NOT_VERIFIED');
 return targetBinding(canonical,active);
}

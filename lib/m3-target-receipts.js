/** M3 target-specific restore proof. This module is INTERNAL, never a mutation
 * HTTP endpoint and never a substitute for the M3 gateway/host acceptance.
 * It verifies the entire physical target inventory, payload/schema and vector
 * values before issuing an immutable per-operation target receipt.
 */
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import {M3Store,qdrantM3Inventory,assertM3ManagedCompleteness} from './m3-collections.js';
import {ManagedChatRegistry} from './f09b4-managed-registry.js';
import {OperationLedger} from './s04-ledger.js';
import {markM3ResolvedBinding} from './m3-versioned-binding.js';
import {M3CutoverJournal} from './m3-cutover-journal.js';
import {ownedRecord} from './s05-contract.js';
import {collectionIdentity} from './s02-identity.js';
const sha=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const bad=(code)=>Object.assign(new Error(code),{code,status:409});
const NAME=/^vh2_[a-f0-9]{48}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const distances={cosine:'Cosine',dot:'Dot',euclid:'Euclid'};
function manifest(backup){
 if(backup?.schemaVersion!==1||backup.backend!=='qdrant'||!UUID.test(backup.backupId??'')||
  backup.owner!==backup.scope?.userScopeId||!NAME.test(backup.physicalName??'')||
  !Array.isArray(backup.inventory?.rows)||backup.inventory.complete!==true||
  backup.inventory.exclusiveOwner!==true||backup.inventory.count!==backup.inventory.rows.length||
  backup.inventory.digest!==sha(backup.inventory.rows))throw bad('M3_TARGET_BACKUP_UNVERIFIED');
 const canonical=collectionIdentity({backend:'qdrant',scope:backup.scope,embedding:backup.embedding});
 if(canonical.key!==backup.logicalKey||
  (backup.canonicalPhysicalName??backup.physicalName)!==canonical.physicalName||
  ((backup.routingGeneration??0)===0&&backup.physicalName!==canonical.physicalName)||
  !NAME.test(backup.physicalName)||
  !Number.isSafeInteger(backup.routingGeneration??0)||(backup.routingGeneration??0)<0)
  throw bad('M3_TARGET_BACKUP_BINDING_MISMATCH');
 return {authorized:true,provenance:'SERVER_VERIFIED',backend:'qdrant',scope:backup.scope,
  embedding:backup.embedding,collection:{key:canonical.key,physicalName:canonical.physicalName}};
}
/** Read-only physical check, not an assertion that there are no external writers. */
export async function verifyM3PhysicalTarget(transport,backup,target,{maxRecords=20000}={}){
 const binding=manifest(backup);
 if(!NAME.test(target??'')||typeof transport?._request!=='function'||
  !Number.isInteger(maxRecords)||maxRecords<1||maxRecords>20000)throw bad('M3_TARGET_TRANSPORT_INVALID');
 const base=`/collections/${target}`;
 const info=await transport._request('GET',base);
 const vectors=info?.result?.config?.params?.vectors;
 if(vectors?.size!==backup.embedding.dimension||vectors.distance!==distances[backup.embedding.metric])
  throw bad('M3_TARGET_SCHEMA_MISMATCH');
 const indexes=info?.result?.payload_schema;
 const required=['userScopeId','collectionId','type','sourceId','branchId','recordId','physicalId'];
 if(!indexes||required.some(k=>indexes[k]?.data_type!=='keyword'))throw bad('M3_TARGET_INDEX_UNVERIFIED');
 const expected=new Map();
 for(const point of backup.inventory.rows){
  if(!point||!Array.isArray(point.vector)||!point.payload||point.payload.physicalId!==point.id)
   throw bad('M3_TARGET_BACKUP_POINT_UNVERIFIED');
  ownedRecord({...point.payload,physicalId:point.id,vector:point.vector},binding,{includeVector:true});
  if(expected.has(String(point.id)))throw bad('M3_TARGET_DUPLICATE_EXPECTED');
  expected.set(String(point.id),point);
 }
 const seen=new Set();let next=null,complete=false,count=0;
 for(let page=0;page<Math.ceil(maxRecords/128)+2;page++){
  const body={limit:128,with_payload:true,with_vector:true};if(next!==null)body.offset=next;
  const response=await transport._request('POST',`${base}/points/scroll`,body);
  if(!Array.isArray(response?.result?.points))throw bad('M3_TARGET_SCAN_UNVERIFIED');
  for(const p of response.result.points){
   if(++count>maxRecords||seen.has(String(p.id)))throw bad('M3_TARGET_SCAN_DUPLICATE_OR_LIMIT');
   seen.add(String(p.id));const wanted=expected.get(String(p.id));
   if(!wanted||!p.payload||JSON.stringify(p.payload)!==JSON.stringify(wanted.payload)||
      !Array.isArray(p.vector)||p.vector.length!==wanted.vector.length||
      p.vector.some((v,i)=>!Number.isFinite(v)||Math.abs(v-wanted.vector[i])>0.00002))
      throw bad('M3_TARGET_INVENTORY_MISMATCH');
  }
  if(response.result.next_page_offset===null||response.result.next_page_offset===undefined){complete=true;break;}
  const cursor=JSON.stringify(response.result.next_page_offset);
  if(cursor.length>512||next===response.result.next_page_offset)throw bad('M3_TARGET_CURSOR_UNVERIFIED');
  next=response.result.next_page_offset;
 }
 if(!complete||count!==expected.size)throw bad('M3_TARGET_INVENTORY_MISMATCH');
 return {verified:true,physicalName:target,logicalKey:backup.logicalKey,
  inventoryDigest:backup.inventory.digest,count, schemaVerified:true,inventoryVerified:true};
}
/** Server-only: caller must supply a complete, previously verified and saved
 * M3 backup plus actual Qdrant reads. Immutable receipt is written once. */
export async function issueM3TargetReceipt(ctx,{transport,backup,operationId,targetPhysicalName,generation}={}){
 if(ctx?.userScopeId!==backup?.owner||!UUID.test(operationId??'')||
    !Number.isSafeInteger(generation)||generation<1)throw bad('M3_TARGET_OWNER_OR_GENERATION_INVALID');
 const observed=await verifyM3PhysicalTarget(transport,backup,targetPhysicalName);
 const doc={schemaVersion:1,owner:ctx.userScopeId,operationId,backupId:backup.backupId,
  logicalKey:backup.logicalKey,physicalName:targetPhysicalName,canonicalPhysicalName:backup.canonicalPhysicalName??backup.physicalName,
  generation,inventoryDigest:observed.inventoryDigest,inventoryCount:observed.count,
  embedding:backup.embedding,sourceFingerprint:backup.savedSourceFingerprint,
  evidenceType:'PHYSICAL_QDRANT_READBACK',verifiedAt:new Date().toISOString(),productionCertified:false};
 await new M3Store(ctx).write('target',doc);
 return {operationId,logicalKey:doc.logicalKey,physicalName:doc.physicalName,
  generation,receiptVerified:true,productionCertified:false};
}
/** Re-read receipt and live target; never trust a stale receipt alone. */
export async function verifyM3TargetReceipt(ctx,{transport,backup,operationId,active,allowManagedEvolutions=false}={}){
 if(ctx?.userScopeId!==backup?.owner||!active||!UUID.test(operationId??''))throw bad('M3_TARGET_OWNER_INVALID');
 const receipt=await new M3Store(ctx).read('target',operationId);
 if(receipt.schemaVersion!==1||receipt.backupId!==backup.backupId||
  receipt.logicalKey!==active.logicalKey||receipt.physicalName!==active.physicalName||
  receipt.generation!==active.generation||receipt.embedding===undefined||
  sha(receipt.embedding)!==sha(backup.embedding)||
  receipt.inventoryDigest!==backup.inventory.digest||receipt.inventoryCount!==backup.inventory.count)
  throw bad('M3_TARGET_RECEIPT_BINDING_MISMATCH');
 let actual;
 try{actual=await verifyM3PhysicalTarget(transport,backup,active.physicalName);}
 catch(error){
  // The immutable target receipt proves the moment of cutover. A later
  // S04-verified mutation legitimately changes the physical inventory; only
  // allow that evolution when *every* deviation from the backup is supported
  // by a verified ledger operation and the full managed registry matches.
  if(!allowManagedEvolutions||error.code!=='M3_TARGET_INVENTORY_MISMATCH'||
    !backup.managed?.records)throw error;
  actual=await verifyM3ManagedTargetEvolution(ctx,transport,backup,active);
 }
 return {...actual,receiptVerified:true,generation:active.generation};
}


/** A restored alias remains writable only while its live inventory can be
 * explained by the immutable original backup plus verified S04 receipts. No
 * missing/unmanaged point, pending operation or foreign owner is ignored.
 */
export async function verifyM3ManagedTargetEvolution(ctx,transport,backup,active){
 const canonical=manifest(backup);
 if(ctx?.userScopeId!==backup.owner||active?.logicalKey!==backup.logicalKey||
  !NAME.test(active.physicalName??'')||!Number.isInteger(active.generation)||active.generation<1)
  throw bad('M3_TARGET_EVOLUTION_SCOPE_INVALID');
 const bound=markM3ResolvedBinding(canonical,{logicalKey:active.logicalKey,
  canonicalName:canonical.collection.physicalName,physicalName:active.physicalName,generation:active.generation});
 const observed=await qdrantM3Inventory(transport,bound);
 if(!observed.complete||!observed.exclusiveOwner)throw bad('M3_TARGET_EVOLUTION_INCOMPLETE');
 const registry=await new ManagedChatRegistry(ctx,canonical).read();
 assertM3ManagedCompleteness(registry,observed,bound);
 const original=new Map(backup.inventory.rows.map(p=>[String(p.id),p]));
 const current=new Map(observed.rows.map(p=>[String(p.id),p]));
 const changed=[];
 for(const [id,p] of current){
  const previous=original.get(id);
  if(!previous||JSON.stringify(previous)!==JSON.stringify(p))changed.push({recordId:p.payload.recordId,
    action:previous?'update':'insert',revision:p.payload.revision});
 }
 for(const [id,p] of original)if(!current.has(id))changed.push({recordId:p.payload.recordId,action:'delete',revision:null});
 // A physical mismatch with no changed record cannot be explained by a
 // managed write. Refuse rather than silently accepting a different index.
 if(!changed.length)throw bad('M3_TARGET_EVOLUTION_UNEXPLAINED');
 const ledger=new OperationLedger(ctx);await ledger.setup();
 const names=(await fs.readdir(ledger.root)).filter(n=>n.endsWith('.json'));
 if(names.some(n=>!UUID.test(n.slice(0,-5))))throw bad('M3_TARGET_EVOLUTION_LEDGER_UNTRUSTED');
 if(names.length>50000)throw bad('M3_TARGET_EVOLUTION_LEDGER_LIMIT');
 const verified=[];
 for(const name of names){
  const receipt=await ledger.read(name.slice(0,-5));
  if(receipt.plan?.collectionKey!==backup.logicalKey)continue;
  if(!['VERIFIED','FAILED'].includes(receipt.state))throw bad('M3_TARGET_EVOLUTION_UNSETTLED');
  if(receipt.state==='VERIFIED'&&receipt.plan.physicalCollectionName===active.physicalName&&
    receipt.plan.routingGeneration===active.generation)verified.push(receipt.plan);
 }
 for(const change of changed){
  if(!verified.some(p=>p.recordId===change.recordId&&
    (change.action==='insert'?p.action==='insert':
     change.action==='delete'?p.action==='delete':['update','metadata'].includes(p.action))&&
    (change.revision===null||p.targetRevision===change.revision)))
   throw bad('M3_TARGET_EVOLUTION_RECEIPT_MISSING');
 }
 return {verified:true,physicalName:active.physicalName,logicalKey:active.logicalKey,
  schemaVerified:true,inventoryVerified:true,exclusiveOwner:true,
  count:observed.count,inventoryDigest:observed.digest,evolutionVerified:true};
}

/** Complete read-only journal -> immutable target receipt -> live Qdrant proof.
 * Does NOT expose aliased reads through F02 until the rest of the generation
 * contract is integrated; callers must separately authorize each operation.
 */
export async function resolveM3VerifiedTarget(ctx,canonical,{transport,backup}={}){
 if(ctx?.userScopeId!==backup?.owner)throw bad('M3_TARGET_OWNER_INVALID');
 const j=new M3CutoverJournal(ctx,{logicalKey:canonical?.collection?.key});
 const events=await j.events();
 const last=events.at(-1);
 if(last?.state!=='PUBLISHED'||last.backupDigest!==sha(backup))
  throw bad('M3_TARGET_JOURNAL_BACKUP_MISMATCH');
 return j.resolveVersioned(canonical,{verifyTarget:active=>verifyM3TargetReceipt(ctx,{
  transport,backup,operationId:last.operationId,active})});
}

/** Read-side binding resolver, also used by guarded M1 planning after M3e.
 * The browser never supplies a backup, operation ID or physical target; they
 * come from the journal/receipt and fresh schema/inventory proof. Subsequent
 * mutations must independently pass S04 generation and ledger checks.
 */
export async function resolveM3ReadBinding(ctx,canonical,{transport}={}){
 const journal=new M3CutoverJournal(ctx,{backend:'qdrant',logicalKey:canonical?.collection?.key});
 // Preserve normal canonical reads without creating private journal directories.
 try{await fs.lstat(journal.dir);}catch(e){if(e.code==='ENOENT')return canonical;throw e;}
 const active=await journal.resolve(canonical);
 if(active.generation===0)return canonical;
 const events=await journal.events();
 const latest=events.at(-1);
 if(latest?.state!=='PUBLISHED'||!UUID.test(latest.operationId))throw bad('M3_READ_JOURNAL_UNVERIFIED');
 const store=new M3Store(ctx);
 let receipt;try{receipt=await store.read('target',latest.operationId);}catch(e){if(e?.code==='ENOENT')throw bad('M3_READ_TARGET_RECEIPT_INVALID');throw e;}
 if(receipt.logicalKey!==active.logicalKey||receipt.physicalName!==active.physicalName||
   receipt.generation!==active.generation||receipt.owner!==ctx.userScopeId)
   throw bad('M3_READ_TARGET_RECEIPT_INVALID');
 const backup=await store.read('backup',receipt.backupId);
 if(latest.backupDigest!==sha(backup)||backup.owner!==ctx.userScopeId)
   throw bad('M3_READ_BACKUP_PROOF_INVALID');
 return journal.resolveVersioned(canonical,{verifyTarget:active=>verifyM3TargetReceipt(ctx,{
  transport,backup,operationId:latest.operationId,active,allowManagedEvolutions:true})});
}

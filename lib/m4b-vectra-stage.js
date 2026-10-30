/** M4b: stage a new Vectra physical generation without touching the original.
 * A disposable test factory may be injected, but production uses server-only
 * Vectra LocalIndex construction and reopens the committed index for readback.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {markM3ResolvedBinding} from './m3-versioned-binding.js';
import {f07VectraLocation,f07SchemaSeal} from './f07-vectra.js';
import {m4bVectraLifecycleAdapter} from './m4b-vectra-contract.js';
const H=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const fail=code=>{throw Object.assign(new Error(code),{code,status:409});};
async function freshIndex(ctx,binding,makeIndex){
 const folder=await f07VectraLocation(ctx,binding);
 try{await fs.lstat(folder);fail('M4B_TARGET_ALREADY_EXISTS');}catch(e){if(e.code!=='ENOENT')throw e;}
 if(typeof makeIndex!=='function')fail('M4B_TARGET_FACTORY_REQUIRED');
 const index=await makeIndex(folder);
 if(typeof index?.createIndex!=='function'||typeof index?.listItems!=='function'||
    typeof index?.beginUpdate!=='function'||typeof index?.endUpdate!=='function'||
    typeof index?.insertItem!=='function')fail('M4B_TARGET_SDK_UNSUPPORTED');
 await index.createIndex({version:1});
 if(await index.isIndexCreated()!==true)fail('M4B_TARGET_NOT_CREATED');
 return index;
}
export async function stageM4bVectraTarget({ctx,canonical,operationId,originalBackup,
 empty=false,proofConsumed=false,makeIndex}={}){
 if(canonical?.backend!=='vectra'||canonical.authorized!==true||canonical.provenance!=='SERVER_VERIFIED'||
  originalBackup?.backend!=='vectra'||originalBackup.logicalKey!==canonical.collection?.key||
  originalBackup.scope?.userScopeId!==ctx?.userScopeId||
  H(originalBackup.inventory?.rows)!==originalBackup.inventory?.digest||
  JSON.stringify(originalBackup.embedding)!==JSON.stringify(canonical.embedding)||proofConsumed!==true)
   fail('M4B_STAGE_PROOF_REQUIRED');
 const physicalName='vh2_'+randomBytes(24).toString('hex');
 const binding=markM3ResolvedBinding(canonical,{logicalKey:canonical.collection.key,
  physicalName,canonicalName:canonical.collection.physicalName,generation:1});
 const index=await freshIndex(ctx,binding,makeIndex);
 const backend={index,s08ServerSchema:f07SchemaSeal(binding)};
 const adapter=m4bVectraLifecycleAdapter({backend,binding,ctx,writerBoundary:async fn=>fn(),
  requireLifecycleProof:async ({kind,operationId:asked})=>({authorized:kind==='restoreToNew'&&
    asked===operationId,consumed:proofConsumed,backupVerified:true,operationId})});
 const initial=await adapter.getInventory();if(initial.count!==0)fail('M4B_STAGE_NOT_EMPTY');
 const items=empty?[]:originalBackup.inventory.rows.map(r=>r.payload);
 if(items.length>20000)fail('M4B_STAGE_LIMIT');
 if(items.length){
  const pack={format:'VH_VECTRA_LOGICAL_V1',backend:'vectra',collectionKey:canonical.collection.key,
   physicalName:originalBackup.physicalName,scope:canonical.scope,embedding:canonical.embedding,
   items,count:items.length,logicalFingerprint:H(items)};
  const restored=await adapter.restoreToNew({...pack,checksum:H(pack)},{operationId});
  if(restored.status!=='VERIFIED'||restored.restoredCount!==items.length)
   fail('M4B_STAGE_RESTORE_UNVERIFIED');
 }
 // Freshly reconstructed LocalIndex read, not only an in-memory object that
 // could report unflushed state. No cleanup on failure after stage dispatch.
 const folder=await f07VectraLocation(ctx,binding);
 const reopened=await makeIndex(folder);
 const reader=m4bVectraLifecycleAdapter({backend:{index:reopened,s08ServerSchema:f07SchemaSeal(binding)},
  binding,ctx,writerBoundary:async fn=>fn()});
 const first=await reader.getInventory(),second=await reader.getInventory();
 if(first.count!==items.length||first.count!==second.count||
  first.logicalFingerprint!==second.logicalFingerprint||first.logicalFingerprint!==H(items))
  fail('M4B_STAGE_READBACK_MISMATCH');
 return {verified:true,physicalName,logicalKey:canonical.collection.key,
  inventoryVerified:true,schemaVerified:true,exclusiveOwner:true,count:first.count,
  inventoryDigest:H(first.items.map(r=>({id:r.physicalId,vector:r.vector,payload:r}))),
  logicalFingerprint:first.logicalFingerprint,generation:1,operationId,immutableTarget:true};
}
export async function stageM4bVectraTargetReadback(ctx,canonical,physicalName,backup,makeIndex){
 const binding=markM3ResolvedBinding(canonical,{logicalKey:canonical.collection.key,
  physicalName,canonicalName:canonical.collection.physicalName,generation:1});
 const folder=await f07VectraLocation(ctx,binding),index=await makeIndex(folder);
 const adapter=m4bVectraLifecycleAdapter({backend:{index,s08ServerSchema:f07SchemaSeal(binding)},
  binding,ctx,writerBoundary:async fn=>fn()});
 const first=await adapter.getInventory(),second=await adapter.getInventory();
 if(first.count!==second.count||first.logicalFingerprint!==second.logicalFingerprint||
  first.count!==backup.inventory.count)fail('M4B_TARGET_READBACK_INVALID');
 return {count:first.count,inventoryDigest:H(first.items.map(r=>({id:r.physicalId,vector:r.vector,payload:r}))),schemaVerified:true};
}

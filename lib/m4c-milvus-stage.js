/** M4c Milvus generation staging: never overwrite the original collection.
 * A fresh server-generated name is provisioned only while holding a trusted
 * lifecycle claim. A failed remote dispatch is quarantined, not rolled back.
 */
import {randomBytes,createHash} from 'node:crypto';
import {markM3ResolvedBinding} from './m3-versioned-binding.js';
import {provisionDisposableMilvusV2Collection} from './s07-milvus.js';
import {m4cMilvusLifecycleAdapter} from './m4c-milvus-contract.js';
const H=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const fail=code=>{throw Object.assign(new Error(code),{code,status:409});};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function toBinding(canonical,physicalName){
 return markM3ResolvedBinding(canonical,{logicalKey:canonical.collection.key,
  physicalName,canonicalName:canonical.collection.physicalName,generation:1});
}
export async function stageM4cMilvusTarget({ctx,canonical,operationId,originalBackup,
 empty=false,proofConsumed=false,backend}={}){
 if(canonical?.backend!=='milvus'||canonical.authorized!==true||canonical.provenance!=='SERVER_VERIFIED'||
  !UUID.test(operationId??'')||originalBackup?.backend!=='milvus'||
  originalBackup.logicalKey!==canonical.collection?.key||
  originalBackup.scope?.userScopeId!==ctx?.userScopeId||
  H(originalBackup.inventory?.rows)!==originalBackup.inventory?.digest||
  JSON.stringify(originalBackup.embedding)!==JSON.stringify(canonical.embedding)||
  proofConsumed!==true||!backend?.client)fail('M4C_STAGE_PROOF_REQUIRED');
 const physicalName='vh2_'+randomBytes(24).toString('hex');
 const binding=toBinding(canonical,physicalName);
 // Provision only a previously absent collection. No catch-and-drop is safe
 // after a remote acknowledgement is lost.
 const created=await provisionDisposableMilvusV2Collection({client:backend.client,
  f03SourceProvisionAuthorized:true},binding);
 if(created?.physicalName!==physicalName||created?.status!=='PROVISIONED_SOURCE_BOUND_UNCERTIFIED')
  fail('M4C_STAGE_PROVISION_UNVERIFIED');
 const adapter=m4cMilvusLifecycleAdapter({backend,binding,writerBoundary:async fn=>fn(),
  requireLifecycleProof:async ({kind,operationId:asked})=>({authorized:kind==='restoreToNew'&&
   asked===operationId,consumed:proofConsumed,backupVerified:true,operationId})});
 const initial=await adapter.getInventory();
 if(initial.count!==0)fail('M4C_STAGE_NOT_EMPTY');
 const items=empty?[]:originalBackup.inventory.rows.map(r=>r.payload);
 if(items.length>20000)fail('M4C_STAGE_LIMIT');
 if(items.length){
  const pack={format:'VH_MILVUS_LOGICAL_V1',backend:'milvus',collectionKey:canonical.collection.key,
   physicalName:originalBackup.physicalName,scope:canonical.scope,embedding:canonical.embedding,
   items,count:items.length,logicalFingerprint:H(items)};
  const result=await adapter.restoreToNew({...pack,checksum:H(pack)},{operationId});
  if(result.status!=='VERIFIED'||result.restoredCount!==items.length)
   fail('M4C_STAGE_RESTORE_UNVERIFIED');
 }
 const first=await adapter.getInventory(),second=await adapter.getInventory();
 if(first.count!==items.length||first.logicalFingerprint!==second.logicalFingerprint||
    first.logicalFingerprint!==H(items))fail('M4C_STAGE_READBACK_MISMATCH');
 return {verified:true,physicalName,logicalKey:canonical.collection.key,
  inventoryVerified:true,schemaVerified:true,exclusiveOwner:true,count:first.count,
  inventoryDigest:H(first.items.map(r=>({id:r.physicalId,vector:r.vector,payload:r}))),
  logicalFingerprint:first.logicalFingerprint,generation:1,operationId,oldPhysicalRetained:true};
}
export async function stageM4cMilvusTargetReadback(ctx,canonical,physicalName,backup,backend){
 if(!backend?.client||canonical?.backend!=='milvus'||backup?.scope?.userScopeId!==ctx?.userScopeId)
  fail('M4C_STAGE_READBACK_PROOF_REQUIRED');
 const binding=toBinding(canonical,physicalName);
 const a=m4cMilvusLifecycleAdapter({backend,binding,writerBoundary:async fn=>fn()});
 const first=await a.getInventory(),second=await a.getInventory();
 if(first.count!==second.count||first.logicalFingerprint!==second.logicalFingerprint||
    first.count!==backup.inventory.count)fail('M4C_STAGE_READBACK_INVALID');
 return {count:first.count,inventoryDigest:H(first.items.map(r=>({id:r.physicalId,vector:r.vector,payload:r}))),
  schemaVerified:true};
}

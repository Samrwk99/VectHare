/** Server-internal fresh LanceDB target creation and exhaustive restore readback.
 * No HTTP route, user-provided physical name or cleanup on uncertain dispatch.
 */
import {randomBytes,createHash} from 'node:crypto';
import {f06ArrowSchema} from './f06-lancedb.js';
import {markM3ResolvedBinding} from './m3-versioned-binding.js';
import {m4aLanceLifecycleAdapter} from './m4a-lancedb-contract.js';
const sha=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const fail=code=>{throw Object.assign(new Error(code),{code,status:409});};

export async function stageM4aLanceTarget({db,canonical,operationId,originalBackup,empty=false,
  proofConsumed=false,arrowModule=null,createEmpty=null}={}){
 if(canonical?.backend!=='lancedb'||canonical.authorized!==true||canonical.provenance!=='SERVER_VERIFIED'||
   typeof db?.createEmptyTable!=='function'||typeof db?.openTable!=='function'||
   originalBackup?.backend!=='lancedb'||originalBackup.logicalKey!==canonical.collection.key||
   originalBackup.scope?.userScopeId!==canonical.scope.userScopeId||
   JSON.stringify(originalBackup.embedding)!==JSON.stringify(canonical.embedding)||proofConsumed!==true)
  fail('M4A_STAGE_PROOF_REQUIRED');
 const physicalName='vh2_'+randomBytes(24).toString('hex');
 const binding=markM3ResolvedBinding(canonical,{logicalKey:canonical.collection.key,
  physicalName,canonicalName:canonical.collection.physicalName,generation:1});
 // `createEmptyTable` must have O_EXCL semantics. Never reuse/recreate an old table.
 if(createEmpty)await createEmpty(db,binding);
 else {
  const arrow=arrowModule??await import('apache-arrow');
  const schema=f06ArrowSchema(arrow,canonical.embedding.dimension);
  await db.createEmptyTable(physicalName,schema,{mode:'create',existOk:false});
 }
 const adapter=m4aLanceLifecycleAdapter({db,binding,writerBoundary:async work=>work(),
  requireLifecycleProof:async ({kind,operationId:asked})=>({authorized:kind==='restoreToNew'&&
   asked===operationId,consumed:proofConsumed,backupVerified:true,operationId})});
 const inspected=await adapter.inspectSchema();
 const initial=await adapter.getInventory();
 if(inspected?.schemaInspected!==true||initial?.count!==0)fail('M4A_STAGE_NOT_EMPTY');
 const items=empty?[]:originalBackup.inventory?.rows?.map(p=>p.payload);
 if(!Array.isArray(items)||items.length>20000)fail('M4A_STAGE_BACKUP_INVALID');
 if(!empty){
  const pack={format:'VH_LANCEDB_LOGICAL_V1',backend:'lancedb',
   collectionKey:originalBackup.logicalKey,physicalName:originalBackup.physicalName,
   scope:originalBackup.scope,embedding:originalBackup.embedding,items,
   count:items.length,logicalFingerprint:sha(items)};
  const restored=await adapter.restoreToNew({...pack,checksum:sha(pack)},{operationId});
  if(restored.status!=='VERIFIED')fail('M4A_STAGE_RESTORE_UNVERIFIED');
 }
 const first=await adapter.getInventory(),second=await adapter.getInventory();
 if(first.count!==items.length||first.count!==second.count||
   first.logicalFingerprint!==second.logicalFingerprint||
   first.logicalFingerprint!==sha(items))fail('M4A_STAGE_READBACK_MISMATCH');
 return {verified:true,physicalName,logicalKey:canonical.collection.key,
  inventoryVerified:true,schemaVerified:true,exclusiveOwner:true,count:first.count,
  inventoryDigest:sha(first.items.map(r=>({id:r.physicalId,vector:r.vector,payload:r}))),
  logicalFingerprint:first.logicalFingerprint,
  generation:1,operationId,immutableTarget:true};
}

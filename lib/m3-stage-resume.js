/** Administrator-approved, one-use Qdrant stage continuation from a verified
 * deterministic-ID prefix. Never reuses the original claimed operation.
 * Original and target logical locks stay occupied through an in-place,
 * forensic lock transfer to the fresh operation. Ambiguous outcomes retain
 * both locks; no automatic replay, deletion or lock release occurs.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {M3Store,assertM3ManagedCompleteness,m3LedgerCheckpoint} from './m3-collections.js';
import {M2JobStore} from './m2-jobs.js';
import {M3ExecutionAudit} from './m3-execution-audit.js';
import {M3PhysicalProgress} from './m3-physical-progress.js';
import {inspectM3StageContinuation} from './m3-stage-continuation.js';
import {withM3AdoptedStageLocks} from './m3-logical-exclusion.js';
import {verifyM3PhysicalTarget,issueM3TargetReceipt} from './m3-target-receipts.js';
import {m3QdrantSmokeQueries} from './m3-lifecycle-transaction.js';
import {ManagedChatRegistry} from './f09b4-managed-registry.js';
import {getEmbeddingProfile} from './f09b5-embedding-profiles.js';
const H=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const KEY=/^[a-f0-9]{64}$/;
const fail=code=>Object.assign(new Error(code),{code,status:409});
export const M3_STAGE_RESUME_CONFIRM='CONTINUE VERIFIED QDRANT STAGE WITH NEW OPERATION';
async function privateDir(p){const st=await fs.lstat(p);
 if(!st.isDirectory()||st.isSymbolicLink()||(process.platform!=='win32'&&(st.mode&0o077)))throw fail('M3_STAGE_RESUME_PRIVATE_STORAGE_REQUIRED');}
async function privateFile(p){const st=await fs.lstat(p);
 if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>8192||st.size<2||
  (process.platform!=='win32'&&(st.mode&0o077)))throw fail('M3_STAGE_RESUME_APPROVAL_UNTRUSTED');
 let data;try{data=JSON.parse(await fs.readFile(p,'utf8'));}catch{throw fail('M3_STAGE_RESUME_APPROVAL_CORRUPT');}
 return data;}
/** This route receives ONLY the original UUID and empty body. The verdict,
 * proof hash, review UUID and approval come from an admin-owned config file.
 */
export async function continueM3VerifiedStage(req,oldOperationId,{deps={},adminRoot}={}){
 if(!req?.s03?.userScopeId||!req.user?.directories||!(req.user.admin===true||req.user.profile?.admin===true)||
  process.platform==='win32'||!UUID.test(oldOperationId??''))throw fail('M3_STAGE_RESUME_ADMIN_REQUIRED');
 const ctx=req.s03,root=adminRoot??process.env.SIMILHARITY_SERVER_CONFIG_DIR;
 if(!path.isAbsolute(root??''))throw fail('M3_STAGE_RESUME_PRIVATE_APPROVAL_REQUIRED');
 await privateDir(root);
 const approval=await privateFile(path.join(root,`m3-stage-resume-${oldOperationId}.json`));
 if(approval.schemaVersion!==1||approval.operationId!==oldOperationId||!UUID.test(approval.reviewId??'')||
  approval.confirmation!==M3_STAGE_RESUME_CONFIRM||approval.approved!==true||!KEY.test(approval.proofHash??''))
  throw fail('M3_STAGE_RESUME_APPROVAL_INVALID');
 const initial=await inspectM3StageContinuation(req,oldOperationId,deps);
 if(initial.proofHash!==approval.proofHash||initial.complete===true)
  throw fail('M3_STAGE_RESUME_PROOF_CHANGED_OR_ALREADY_COMPLETE');
 const store=deps.store?.(ctx)??new M3Store(ctx),old=await store.read('operation',oldOperationId);
 const originalBackup=await store.read('backup',old.backupId);
 const active=await (deps.getProfile??getEmbeddingProfile)(ctx);
 if(active?.configured!==true||JSON.stringify(active.profile)!==JSON.stringify(originalBackup.embedding))
  throw fail('M3_STAGE_RESUME_ACTIVE_MODEL_CHANGED');
 const targetBackup=await store.read('backup',initial.targetBackupId),rows=[...targetBackup.inventory.rows].sort((a,b)=>String(a.id).localeCompare(String(b.id)));
 if(rows.length!==initial.totalCount||targetBackup.inventory.digest!==H(rows)||
  targetBackup.owner!==ctx.userScopeId||!targetBackup.managed?.records)
  throw fail('M3_STAGE_RESUME_MANIFEST_CHANGED');
 // Both collections must be quiescent at the coordinator and S04 ledger,
 // independently of their retained physical writer locks.
 const jobs=deps.jobs?.(ctx)??new M2JobStore(ctx);
 for(const key of [old.logicalKey,old.targetLogicalKey]){
  await jobs.assertNoLease(key);
  const checkpoint=await (deps.ledgerCheckpoint??m3LedgerCheckpoint)(ctx,key,deps);
  if(!KEY.test(checkpoint?.digest??''))throw fail('M3_STAGE_RESUME_LEDGER_UNVERIFIED');
 }
 if(rows.length>20000)throw fail('M3_STAGE_RESUME_MANAGED_REGISTRY_CAP');
 const newOperationId=randomUUID(),ticket={...old,operationId:newOperationId,
  phase:'AUTHORIZED_ADMIN_STAGE_CONTINUATION',previousOperationId:oldOperationId,
  sourceFingerprint:initial.sourceFingerprint,expectedCount:initial.totalCount,
  createdAt:Date.now(),expiresAt:Date.now()+3_600_000};
 // The new claim is durable before lock ownership changes. If the process
 // dies here, old locks remain, so an administrator must investigate.
 await store.write('operation',ticket);await store.claim(newOperationId);
 const parent=path.join(ctx.vectorsPath,'.similharity');await privateDir(parent);
 const cases=path.join(parent,'m3-stage-resume');
 await fs.mkdir(cases,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});await privateDir(cases);
 const keys=[old.logicalKey,old.targetLogicalKey];
 const transport=deps.transport?await deps.transport(req,old):
  (typeof deps.backendPool?.getTrusted==='function'?await deps.backendPool.getTrusted(ctx,'qdrant',old.configId):null);
 if(typeof transport?._request!=='function')throw fail('M3_STAGE_RESUME_TRANSPORT_REQUIRED');
 return withM3AdoptedStageLocks(ctx,{oldOperationId,newOperationId,keys,caseRoot:cases,reviewId:approval.reviewId},
  async(oldHolder,targetHolder)=>{
   for(const key of keys){await jobs.assertNoLease(key);
    const checkpoint=await (deps.ledgerCheckpoint??m3LedgerCheckpoint)(ctx,key,deps);
    if(!KEY.test(checkpoint?.digest??''))throw fail('M3_STAGE_RESUME_LEDGER_CHANGED');
   }
   const retryProof=await inspectM3StageContinuation(req,oldOperationId,deps);
   if(retryProof.proofHash!==initial.proofHash)throw fail('M3_STAGE_RESUME_PROOF_CHANGED');
   const audit=new M3ExecutionAudit(ctx,{operationId:newOperationId,logicalKey:old.logicalKey,action:'rebuild'});
   await audit.checkpoint(oldHolder,'CLAIMED');
   await audit.checkpoint(oldHolder,'DISPATCH_PENDING');
   const progress=new M3PhysicalProgress(ctx,newOperationId),url=`/collections/${initial.physicalName}`;
   // Record the independently re-observed original prefix under the NEW ID;
   // these are observations, not redispatches or inherited write receipts.
   for(let start=0;start<initial.prefixCount;start+=32){
    const chunk=rows.slice(start,Math.min(start+32,initial.prefixCount));
    await progress.recordVerified({index:start/32,physicalName:initial.physicalName,
     targetBackupId:initial.targetBackupId,manifestDigest:initial.manifestDigest,
     chunkDigest:H(chunk),recordCount:chunk.length});
   }
   for(let start=initial.prefixCount;start<rows.length;start+=32){
    const chunk=rows.slice(start,start+32);
    const ack=await transport._request('PUT',`${url}/points?wait=true`,{points:chunk});
    if(ack?.result?.status!=='completed')throw fail('M3_STAGE_RESUME_DISPATCH_UNCERTAIN');
    const response=await transport._request('POST',`${url}/points`,{ids:chunk.map(p=>p.id),with_payload:true,with_vector:true});
    if(!Array.isArray(response?.result)||response.result.length!==chunk.length)
     throw fail('M3_STAGE_RESUME_READBACK_UNCERTAIN');
    const found=new Map(response.result.map(p=>[String(p.id),p]));
    if(found.size!==chunk.length||chunk.some(p=>{const r=found.get(String(p.id));return !r||
      JSON.stringify(p.payload)!==JSON.stringify(r.payload)||!Array.isArray(r.vector)||
      r.vector.length!==p.vector.length||r.vector.some((v,i)=>!Number.isFinite(v)||Math.abs(v-p.vector[i])>0.00002);}))
     throw fail('M3_STAGE_RESUME_READBACK_UNCERTAIN');
    await progress.recordVerified({index:start/32,physicalName:initial.physicalName,
     targetBackupId:initial.targetBackupId,manifestDigest:initial.manifestDigest,
     chunkDigest:H(chunk),recordCount:chunk.length});
   }
   const observed=await (deps.verifyPhysical??verifyM3PhysicalTarget)(transport,targetBackup,initial.physicalName);
   if(observed?.inventoryVerified!==true||observed?.schemaVerified!==true||
     observed?.inventoryDigest!==targetBackup.inventory.digest)
    throw fail('M3_STAGE_RESUME_FULL_INVENTORY_UNVERIFIED');
   const smoke=await (deps.smoke??m3QdrantSmokeQueries)(transport,targetBackup,initial.physicalName);
   if(smoke?.verified!==true)throw fail('M3_STAGE_RESUME_SMOKE_FAILED');
   const issued=await (deps.issueReceipt??issueM3TargetReceipt)(ctx,{transport,backup:targetBackup,
    operationId:newOperationId,targetPhysicalName:initial.physicalName,generation:1});
   if(issued?.receiptVerified!==true)throw fail('M3_STAGE_RESUME_TARGET_RECEIPT_UNVERIFIED');
   const binding={authorized:true,provenance:'SERVER_VERIFIED',backend:'qdrant',scope:targetBackup.scope,
    embedding:targetBackup.embedding,collection:{key:old.targetLogicalKey,physicalName:targetBackup.physicalName}};
   const registry=deps.targetRegistry?.(ctx,binding)??new ManagedChatRegistry(ctx,binding);
   await registry.lock(async()=>{const current=await registry.read();
    if(Object.keys(current.records).length!==0)throw fail('M3_STAGE_RESUME_REGISTRY_CHANGED');
    await registry.save({...registry.empty(),records:structuredClone(targetBackup.managed.records)});
   });
   const settled=await registry.read();
   if(settled.fingerprint!==targetBackup.managed.fingerprint)throw fail('M3_STAGE_RESUME_REGISTRY_UNVERIFIED');
   (deps.assertManaged??assertM3ManagedCompleteness)(settled,targetBackup.inventory,binding);
   await audit.checkpoint(oldHolder,'PHYSICAL_VERIFIED',{detail:{target:initial.physicalName,count:rows.length}});
   await store.write('stage',{schemaVersion:1,operationId:newOperationId,owner:ctx.userScopeId,
    oldLogicalKey:old.logicalKey,targetLogicalKey:old.targetLogicalKey,
    targetPhysicalName:initial.physicalName,targetBackupId:targetBackup.backupId,
    sourceFingerprint:old.sourceFingerprint,targetProfileHash:old.targetProfileHash,
    expectedCount:rows.length,receiptGeneration:1,targetRegistryFingerprint:settled.fingerprint,
    smokeVersion:smoke.version??'m3-smoke-v1',activated:false,createdAt:new Date().toISOString()});
   await audit.checkpoint(oldHolder,'COMMITTED');
   return {state:'VERIFIED_STAGED',operationId:newOperationId,previousOperationId:oldOperationId,
    stagedLogicalKey:old.targetLogicalKey,stagedPhysicalName:initial.physicalName,
    stagedBackupId:targetBackup.backupId,recordCount:rows.length,
    targetReceiptVerified:true,targetRegistryVerified:true,smokeVerified:true,
    oldCollectionRetained:true,originalOperationReplayed:false,validationStatus:'AWAITING_MANUAL_TEST'};
  });
}

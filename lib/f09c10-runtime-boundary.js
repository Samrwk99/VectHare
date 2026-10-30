/** F09c.10 — trusted, same-host cooperating-writer boundary for ALL S04 engines.
 * The caller supplies no lock path, backend name, or collection identity.
 * Normal v2 runtime mutations and S04-based diagnostics derive the same
 * physical-collection lock from the authenticated ledger context and plan.
 * This is not a remote/distributed lock and does not mediate raw legacy writes
 * or unrelated applications that bypass VectHare (accepted writer policy).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {CooperativeWriterBoundary} from './f09c5-writer-boundary.js';
import {OperationError} from './s04-contract.js';
import {M3LogicalExclusion} from './m3-logical-exclusion.js';

const fail=code=>new OperationError(code,'Trusted runtime writer boundary is unavailable');
async function privateDirectory(dir){
 const s=await fs.lstat(dir);
 if(!s.isDirectory()||s.isSymbolicLink()||(process.platform!=='win32'&&(s.mode&0o077)))
  throw fail('F09C10_LOCK_PARENT_UNTRUSTED');
}
export async function runtimeWriterBoundary(context,plan){
 if(!context?.userScopeId||typeof context.vectorsPath!=='string'||
  !path.isAbsolute(context.vectorsPath)||plan?.scope?.userScopeId!==context.userScopeId||
  !/^[a-f0-9]{64}$/.test(plan?.collectionKey||'')||
  !['qdrant','lancedb','vectra','milvus'].includes(plan?.backend))
  throw fail('F09C10_RUNTIME_SCOPE_INVALID');
 // Fail closed on untrusted/symlinked root. Never silently fall back to
 // the legacy operation-ledger lock or an in-memory process-local mutex.
 await privateDirectory(context.vectorsPath);
 const parent=path.join(context.vectorsPath,'.similharity');
 try{await fs.mkdir(parent,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
 await privateDirectory(parent);
 const physical=new CooperativeWriterBoundary({root:path.join(parent,'f09c10-writer-locks'),
  backend:plan.backend,physicalName:plan.physicalCollectionName});
 const logical=new M3LogicalExclusion(context,{backend:plan.backend,logicalKey:plan.collectionKey});
 return {root:physical.root,key:physical.key,backend:physical.backend,physicalName:physical.physicalName,withWriteBoundary(request,work){
  if(request?.collectionKey!==plan.collectionKey||request?.backend!==plan.backend||
     request?.physicalCollectionName!==plan.physicalCollectionName)throw fail('F09C10_RUNTIME_SCOPE_INVALID');
  return logical.withExclusion({operationId:request.operationId??null},()=>physical.withWriteBoundary(request,work))
   .catch(e=>{if(e?.code==='M3_LOGICAL_COLLECTION_BUSY')throw fail('F09C5_WRITER_BUSY');throw e;});
 }};
}

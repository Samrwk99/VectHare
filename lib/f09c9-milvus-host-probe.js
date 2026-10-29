/** F09c.9 — administrator-only local Milvus disposable acceptance probe.
 * No HTTP routes. Reuses F08/S07's guarded synthetic schema and lifecycle.
 * The cooperating-writer lock covers the entire lifecycle, including create.
 * A successful diagnostic is NEVER production CAS certification.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {collectionIdentity} from './s02-identity.js';
import {runF08MilvusAcceptance} from './f08-milvus-acceptance.js';
import {CooperativeWriterBoundary} from './f09c5-writer-boundary.js';

export const F09C9_CONSENT='CREATE_NEW_DISPOSABLE_LOCAL_MILVUS_COLLECTION';
const failure=code=>Object.assign(new Error(code),{code});
const addressPattern=/^(?:127\.0\.0\.1|localhost):([1-9][0-9]{0,4})$/;
const safeCode=e=>typeof e?.code==='string'&&/^F09C[589]_/.test(e.code)?e.code:'F09C9_BACKEND_ERROR_OR_UNCERTAIN';
export function validateF09c9Options({parent,address='127.0.0.1:19530',mode='preflight',consent=null}={}){
 if(typeof parent!=='string'||!path.isAbsolute(parent)||path.resolve(parent)!==parent||parent===path.parse(parent).root)
  throw failure('F09C9_ABSOLUTE_PRIVATE_PARENT_REQUIRED');
 const match=typeof address==='string'&&address.match(addressPattern);
 if(!match||Number(match[1])>65535)throw failure('F09C9_LOCAL_MILVUS_ADDRESS_REQUIRED');
 if(!['preflight','disposable'].includes(mode))throw failure('F09C9_MODE_INVALID');
 if(mode==='disposable'&&consent!==F09C9_CONSENT)throw failure('F09C9_CONSENT_REQUIRED');
 if(mode==='preflight'&&consent!==null)throw failure('F09C9_PREFLIGHT_CONSENT_FORBIDDEN');
 return {parent,address,mode};
}
async function privateParent(parent){
 let current=path.parse(parent).root;
 for(const part of path.relative(current,parent).split(path.sep).filter(Boolean)){
  current=path.join(current,part);
  const st=await fs.lstat(current);
  if(!st.isDirectory()||st.isSymbolicLink())throw failure('F09C9_PARENT_SYMLINK_OR_NOT_DIRECTORY');
 }
 if(await fs.realpath(parent)!==parent)throw failure('F09C9_PARENT_ALIAS');
 const stat=await fs.lstat(parent);
 if(process.platform!=='win32'&&(stat.mode&0o077)!==0)throw failure('F09C9_PARENT_NOT_PRIVATE');
}
/** An injected loadSdk and runAcceptance permit isolated deterministic tests.
 * The production CLI only uses the installed SDK and real F08 acceptance.
 */
export async function runMilvusF09c9HostProbe(options={},loadSdk=()=>import('@zilliz/milvus2-sdk-node'),runAcceptance=runF08MilvusAcceptance){
 const {parent,address,mode}=validateF09c9Options(options);
 await privateParent(parent);
 const result={checkpoint:'F09c.9',mode,status:'PREFLIGHT_ONLY',productionPermission:false,
  backendCertified:false,realHostCertified:false,cooperatingWritersOnly:true,
  externalWritersProtected:false,collection:null,collectionRetained:false,
  manualCleanupRequired:false,steps:[]};
 let MilvusClient;
 try{
  const sdk=await loadSdk();
  MilvusClient=sdk?.MilvusClient??sdk?.default?.MilvusClient;
  if(typeof MilvusClient!=='function')throw failure('F09C9_SDK_INVALID');
  result.steps.push({name:'milvus_sdk',status:'AVAILABLE'});
 }catch(e){result.status='SDK_UNAVAILABLE';result.steps.push({name:'milvus_sdk',status:'FAILED',detail:safeCode(e)});return result;}
 if(mode==='preflight')return result; // Must not instantiate a client or contact Milvus.
 // The collection name is derived from a unique server-owned scope by S02,
 // never from an operator-selectable collection or historical vector identity.
 const runId=randomUUID(),id=runId.replaceAll('-','');
 const context={userScopeId:`f09c9_operator_${id}`,vectorsPath:parent};
 const scope={userScopeId:context.userScopeId,collectionId:`f08_${id}`,type:'other',sourceId:`diagnostic_${id}`};
 const embedding={source:'diagnostic',model:'f08-milvus-four-dim',dimension:4,metric:'cosine'};
 const c=collectionIdentity({backend:'milvus',scope,embedding});
 result.collection=c.physicalName;
 result.collectionRetained=true; // Never drop/clear even on successful probe.
 result.manualCleanupRequired=true;
 const boundary=new CooperativeWriterBoundary({root:path.join(parent,'writer-locks'),backend:'milvus',physicalName:c.physicalName});
 const plan={backend:'milvus',physicalCollectionName:c.physicalName,collectionKey:c.key};
 let client;
 try{
  // Client may connect in constructor; do so ONLY after explicit consent.
  client=new MilvusClient({address,timeout:30000,maxRetries:0});
  if(client.connectPromise)await client.connectPromise;
  if(!['listCollections','createCollection','describeCollection','createIndex','loadCollection',
   'describeIndex','query','search','insert','upsert','deleteEntities'].every(k=>typeof client[k]==='function'))
   throw failure('F09C9_MILVUS_SDK_API_UNAVAILABLE');
  const guarded=await boundary.withWriteBoundary(plan,async()=>{
   const acceptance=await runAcceptance(context,{client},{runId});
   result.steps.push(...(Array.isArray(acceptance?.stages)?acceptance.stages.map(s=>({name:s.stage,status:s.status, ...(s.code?{detail:s.code}:{})})):[]));
   if(acceptance?.collection!==c.physicalName||acceptance?.productionWritesEnabled!==false||
      acceptance?.backendCertified!==false||acceptance?.success!==true)
    return {state:'UNCERTAIN'}; // lock retained even when the fixture reports failure
   return {state:'VERIFIED'};
  });
  if(guarded?.state!=='VERIFIED')throw failure('F09C9_DISPOSABLE_RESULT_UNCERTAIN');
  result.status='DISPOSABLE_MILVUS_OBSERVED_NO_PRODUCTION_CERTIFICATION';
 }catch(e){result.status='FAILED_OR_UNCERTAIN';result.steps.push({name:'disposable_sequence',status:'FAILED',detail:safeCode(e)});}
 finally{try{await client?.closeConnection?.();}catch{}}
 return result;
}

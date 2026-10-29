/** F05 extended, explicitly consented live Qdrant contract acceptance.
 * Random, newly-created diagnostic namespace only; never existing data or purge.
 * This provides host evidence, NOT production activation or external-writer CAS.
 */
import {randomUUID} from 'node:crypto';
import {attestF03QdrantIndexes} from './f03-provision.js';
import {collectionIdentity} from './s02-identity.js';
import {planMutation} from './s04-contract.js';
import {OperationLedger} from './s04-ledger.js';
import {MutationEngine} from './s04-engine.js';
import {qdrantV2Adapter,inspectQdrantV2Collection,provisionDisposableQdrantV2Collection} from './s06-qdrant.js';

const fail=(code)=>Object.assign(new Error(code),{code});
const stages=['provision','schema','owner_indexes','insert','readback','search','metadata','stale_revision','pagination','reopen','delete','empty_after_delete'];
export const F05_ACCEPTANCE_STAGES=Object.freeze(stages);
const CONFIRM='I ACCEPT F05 DISPOSABLE QDRANT TEST';
export const F05_ACCEPTANCE_CONSENT=CONFIRM;
const diagnosticScope=(user,id)=>({userScopeId:user,collectionId:`f05_${id}`,type:'other',sourceId:`diagnostic_${id}`});
/** Run against a true backend transport. Dependency injection is internal only. */
export async function runF05QdrantAcceptance(context,backend,{runId=randomUUID()}={}){
 if(!context?.userScopeId||!context?.vectorsPath||typeof backend?._request!=='function')throw fail('F05_HOST_CONTEXT_REQUIRED');
 if(!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(runId))throw fail('F05_RUN_ID_INVALID');
 const id=runId.replace(/-/g,'').toLowerCase(),scope=diagnosticScope(context.userScopeId,id);
 const embedding={source:'diagnostic',model:'f05-acceptance-4d',dimension:4,metric:'dot'};
 const collection=collectionIdentity({backend:'qdrant',scope,embedding});
 const binding={authorized:true,provenance:'SERVER_VERIFIED',backend:'qdrant',scope,embedding,
  collection:{key:collection.key,physicalName:collection.physicalName}};
 const transport={s06DisposableFixture:true,_request:(...args)=>backend._request(...args)};
 const evidence=[],recordId=randomUUID();let current='provision';
 const pass=(stage)=>{evidence.push({stage,status:'PASS'});};
 const mutate=async(action,revision,extra={})=>{
  const input={backend:'qdrant',scope,embedding,action,recordId,operationId:randomUUID(),expectedRevision:revision,...extra};
  const plan=planMutation(context,input),engine=new MutationEngine({atomicOnly:false,ledger:new OperationLedger(context),adapter:qdrantV2Adapter(transport,binding),
   authorize:async()=>({authorized:true,ownerVerified:true,mutationContractVerified:true,collectionKey:collection.key,backend:'qdrant'})});
  const payload=action==='delete'?undefined:action==='metadata'?{metadata:extra.metadata}:
   {text:extra.text,vector:extra.vector,metadata:extra.metadata};
  const result=await engine.execute(plan,payload);
  if(result.state!=='VERIFIED')throw fail('F05_MUTATION_UNCERTAIN');
  return result;
 };
 const originVector=[0.8,0.4,0.2,0.1];
 try{
  // Provision never opens a preexisting physical namespace for write.
  await provisionDisposableQdrantV2Collection(transport,binding);pass('provision');
  current='schema';
  const inspected=await inspectQdrantV2Collection(transport,binding);
  if(inspected.schemaInspected!==true)throw fail('F05_SCHEMA_NOT_VERIFIED');pass('schema');
  current='owner_indexes';await attestF03QdrantIndexes(transport,binding);pass('owner_indexes');
  current='insert';await mutate('insert',0,{text:'F05 disposable Qdrant memory',vector:originVector,metadata:{fixture:'F05'}});pass('insert');
  const a=qdrantV2Adapter(transport,binding);
  current='readback';const first=await a.getRecord(recordId);
  if(first?.revision!==1||first?.text!=='F05 disposable Qdrant memory'||first?.vector?.length!==4)throw fail('F05_READBACK_MISMATCH');pass('readback');
  current='search';const hits=await a.query({vector:originVector,topK:5});
  if(!hits.some(r=>r.recordId===recordId))throw fail('F05_SEARCH_MISMATCH');pass('search');
  current='metadata';await mutate('metadata',1,{metadata:{fixture:'F05',updated:true}});
  if((await a.getRecord(recordId))?.revision!==2)throw fail('F05_METADATA_REVISION_MISMATCH');pass('metadata');
  current='stale_revision';
  // A stale revision should fail before any backend mutation. This tests the
  // local adapter preflight, NOT protection from an independent external writer.
  const staleInput={backend:'qdrant',scope,embedding,action:'delete',recordId,operationId:randomUUID(),expectedRevision:1};
  const stalePlan=planMutation(context,staleInput);
  try{await a.deleteRecord(stalePlan);throw fail('F05_STALE_REVISION_ACCEPTED');}
  catch(e){if(e.code!=='S06_REVISION_CONFLICT')throw e;}
  if((await a.getRecord(recordId))?.revision!==2)throw fail('F05_STALE_MUTATED_RECORD');pass('stale_revision');
  current='pagination';const page=await a.listPage({limit:1,includeVectors:false});
  if(!page.items.some(r=>r.recordId===recordId)||page.inventoryVerified!==false)throw fail('F05_PAGE_MISMATCH');pass('pagination');
  current='reopen';const reopened=qdrantV2Adapter({s06DisposableFixture:true,_request:(...args)=>backend._request(...args)},binding);
  if((await reopened.getRecord(recordId))?.revision!==2)throw fail('F05_REOPEN_FAILED');pass('reopen');
  current='delete';await mutate('delete',2);pass('delete');
  current='empty_after_delete';if(await reopened.getRecord(recordId)!==null)throw fail('F05_DELETE_READBACK_MISMATCH');pass('empty_after_delete');
  return {success:true,acceptance:'F05_DISPOSABLE_CONTRACT_PASS',stages:evidence,
   remainingProductionBlockers:['EXTERNAL_WRITER_CAS_UNPROVEN','RESTART_CRASH_RECOVERY_UNPROVEN','HOST_SOURCE_SCOPE_NOT_EXERCISED','NORMAL_MEMORY_PIPELINE_NOT_CONNECTED'],
   externalWriterIsolationVerified:false,restartPersistenceVerified:false,productionWritesEnabled:false,
   collection:collection.physicalName,disposable:true,collectionRetained:true};
 }catch(error){
  evidence.push({stage:current,status:'FAILED_OR_UNCERTAIN',code:/^[A-Z0-9_]{2,90}$/.test(error?.code||'')?error.code:'F05_BACKEND_UNVERIFIED'});
  return {success:false,acceptance:'F05_FAILED_OR_UNCERTAIN',stages:evidence,productionWritesEnabled:false,
   collection:collection.physicalName,disposable:true,collectionRetained:true,
   warning:'A synthetic record may remain. Never automatically retry a mutation, drop or purge this collection.'};
 }
}
/** Route only accepts the fixed selector and user confirmation; the server
 * chooses every physical collection, owner, embedding, record and operation ID.
 */
export function registerF05AcceptanceRoutes(router,{backendPool,run=runF05QdrantAcceptance}={}){
 if(typeof backendPool?.get!=='function')throw Error('F05_BACKEND_POOL_REQUIRED');
 const active=new Set();
 router.post('/v2/diagnostics/qdrant-f05',async(req,res)=>{
  const b=req.body;
  const header=req.get?.('x-vecthare-f05-diagnostic')??req.headers?.['x-vecthare-f05-diagnostic'];
  const fetchSite=req.get?.('sec-fetch-site')??req.headers?.['sec-fetch-site'];
  if(header!=='1'||(fetchSite&&!['same-origin','none'].includes(fetchSite)))
   return res.status(403).json({success:false,code:'F05_SAME_ORIGIN_HEADER_REQUIRED',productionWritesEnabled:false});
  if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).some(k=>!['configId','consent'].includes(k))||
    b.configId!=='local'||b.consent!==CONFIRM)
   return res.status(403).json({success:false,code:'F05_DISPOSABLE_CONSENT_REQUIRED',productionWritesEnabled:false});
  if(!req?.s03?.userScopeId||!req.s03.vectorsPath)
   return res.status(403).json({success:false,code:'F05_HOST_AUTH_REQUIRED',productionWritesEnabled:false});
  const key=req.s03.userScopeId;
  if(active.has(key))return res.status(409).json({success:false,code:'F05_TEST_BUSY',productionWritesEnabled:false});
  active.add(key);
  try{
   const backend=await backendPool.get(req.s03,'qdrant','local');
   const result=await run(req.s03,backend);
   return res.status(result.success?200:409).json(result);
  }catch(e){return res.status(503).json({success:false,code:'F05_BACKEND_UNAVAILABLE',productionWritesEnabled:false});}
  finally{active.delete(key);}
 });
}

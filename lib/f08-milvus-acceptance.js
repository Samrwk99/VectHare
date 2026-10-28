/** F08 Milvus disposable acceptance: server-generated NEW collection only.
 * No existing collection, purge, drop or user-selected physical identifier. */
import {randomUUID} from 'node:crypto';
import {collectionIdentity} from './s02-identity.js';
import {planMutation} from './s04-contract.js';
import {OperationLedger} from './s04-ledger.js';
import {MutationEngine} from './s04-engine.js';
import {milvusV2Adapter,inspectMilvusV2Collection,provisionDisposableMilvusV2Collection} from './s07-milvus.js';
export const F08_ACCEPTANCE_CONSENT='I ACCEPT F08 DISPOSABLE MILVUS TEST';
export const F08_ACCEPTANCE_STAGES=Object.freeze(['provision','schema','insert','readback','search','metadata','stale_revision','pagination','reopen','delete','empty_after_delete']);
const fail=code=>Object.assign(new Error(code),{code});
export async function runF08MilvusAcceptance(context,backend,{runId=randomUUID()}={}){
 if(!context?.userScopeId||!context.vectorsPath||!backend?.client)throw fail('F08_HOST_CONTEXT_REQUIRED');
 if(!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(runId))throw fail('F08_RUN_ID_INVALID');
 const id=runId.replaceAll('-','').toLowerCase(),scope={userScopeId:context.userScopeId,collectionId:`f08_${id}`,type:'other',sourceId:`diagnostic_${id}`};
 const embedding={source:'diagnostic',model:'f08-milvus-four-dim',dimension:4,metric:'cosine'};
 const c=collectionIdentity({backend:'milvus',scope,embedding}),binding={authorized:true,provenance:'SERVER_VERIFIED',backend:'milvus',scope,embedding,collection:{key:c.key,physicalName:c.physicalName}};
 const fixture={client:backend.client,s07DisposableFixture:true},recordId=randomUUID(),vector=[0.5,0.25,0.125,0.0625];
 const evidence=[];let stage='provision';const pass=()=>evidence.push({stage,status:'PASS'});
 const adapter=milvusV2Adapter(fixture,binding);
 const mutate=async(action,expectedRevision,payload)=>{
  const plan=planMutation(context,{backend:'milvus',scope,embedding,action,recordId,operationId:randomUUID(),expectedRevision,...(payload||{})});
  const engine=new MutationEngine({ledger:new OperationLedger(context),adapter,authorize:async()=>({authorized:true,ownerVerified:true,mutationContractVerified:true,collectionKey:c.key,backend:'milvus'})});
  const result=await engine.execute(plan,payload);
  if(result.state!=='VERIFIED')throw fail('F08_MUTATION_UNCERTAIN');
 };
 try{
  await provisionDisposableMilvusV2Collection(fixture,binding);pass();
  stage='schema';const schema=await inspectMilvusV2Collection(fixture,binding);
  if(!schema.schemaInspected||!schema.indexVerified)throw fail('F08_SCHEMA_UNVERIFIED');pass();
  stage='insert';await mutate('insert',0,{text:'F08 disposable Milvus record',vector,metadata:{fixture:'F08'}});pass();
  stage='readback';const first=await adapter.getRecord(recordId);
  if(first?.revision!==1||first?.text!=='F08 disposable Milvus record'||first?.vector?.length!==4)throw fail('F08_READBACK_MISMATCH');pass();
  stage='search';if(!(await adapter.query({vector,topK:3})).some(x=>x.recordId===recordId))throw fail('F08_SEARCH_MISMATCH');pass();
  stage='metadata';await mutate('metadata',1,{metadata:{fixture:'F08',updated:true}});
  if((await adapter.getRecord(recordId))?.revision!==2)throw fail('F08_METADATA_MISMATCH');pass();
  stage='stale_revision';const stale=planMutation(context,{backend:'milvus',scope,embedding,action:'delete',recordId,operationId:randomUUID(),expectedRevision:1});
  try{await adapter.deleteRecord(stale);throw fail('F08_STALE_REVISION_ACCEPTED');}
  catch(e){if(e.code!=='S07_REVISION_CONFLICT')throw e;}
  if((await adapter.getRecord(recordId))?.revision!==2)throw fail('F08_STALE_MUTATED');pass();
  stage='pagination';const page=await adapter.listPage({limit:1});
  if(!page.items.some(x=>x.recordId===recordId)||page.inventoryVerified!==false)throw fail('F08_PAGE_UNVERIFIED');pass();
  stage='reopen';const reopened=milvusV2Adapter({client:backend.client,s07DisposableFixture:true},binding);
  if((await reopened.getRecord(recordId))?.revision!==2)throw fail('F08_REOPEN_MISMATCH');pass();
  stage='delete';await mutate('delete',2);pass();
  stage='empty_after_delete';if((await reopened.getRecord(recordId))!==null)throw fail('F08_DELETE_MISMATCH');pass();
  return {success:true,acceptance:'F08_DISPOSABLE_CONTRACT_PASS',stages:evidence,collection:c.physicalName,
   disposable:true,collectionRetained:true,productionWritesEnabled:false,backendCertified:false,
   externalWriterIsolationVerified:false,restartPersistenceVerified:false,
   remainingProductionBlockers:['EXTERNAL_WRITER_CAS_UNPROVEN','RESTART_CRASH_RECOVERY_UNPROVEN','NORMAL_MEMORY_PIPELINE_NOT_CONNECTED']};
 }catch(e){evidence.push({stage,status:'FAILED_OR_UNCERTAIN',code:/^[A-Z0-9_]{2,90}$/.test(e?.code||'')?e.code:'F08_BACKEND_UNVERIFIED'});
  return {success:false,acceptance:'F08_FAILED_OR_UNCERTAIN',stages:evidence,collection:c.physicalName,
   disposable:true,collectionRetained:true,productionWritesEnabled:false,backendCertified:false,
   externalWriterIsolationVerified:false,restartPersistenceVerified:false,
   warning:'A synthetic Milvus record may remain. Do not repeat, drop or purge this collection.'};}
}
export function registerF08AcceptanceRoutes(router,{backendPool,run=runF08MilvusAcceptance}={}){
 if(typeof backendPool?.get!=='function')throw Error('F08_BACKEND_POOL_REQUIRED');
 const active=new Set();
 router.post('/v2/diagnostics/milvus-f08',async(req,res)=>{
  const b=req?.body,h=req?.headers||{},header=req?.get?.('x-vecthare-f08-diagnostic')??h['x-vecthare-f08-diagnostic'];
  const site=req?.get?.('sec-fetch-site')??h['sec-fetch-site'];
  if(header!=='1'||(site&&!['same-origin','none'].includes(site)))
   return res.status(403).json({success:false,code:'F08_SAME_ORIGIN_HEADER_REQUIRED',productionWritesEnabled:false});
  if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).some(k=>!['configId','consent'].includes(k))||
    b.configId!=='default'||b.consent!==F08_ACCEPTANCE_CONSENT)
   return res.status(403).json({success:false,code:'F08_DISPOSABLE_CONSENT_REQUIRED',productionWritesEnabled:false});
  if(!req?.s03?.userScopeId||!req?.s03?.vectorsPath)
   return res.status(403).json({success:false,code:'F08_HOST_AUTH_REQUIRED',productionWritesEnabled:false});
  if(active.has(req.s03.userScopeId))return res.status(409).json({success:false,code:'F08_TEST_BUSY',productionWritesEnabled:false});
  active.add(req.s03.userScopeId);
  try{const backend=await backendPool.get(req.s03,'milvus','default');
   const result=await run(req.s03,backend);return res.status(result.success?200:409).json(result);
  }catch{return res.status(503).json({success:false,code:'F08_BACKEND_UNAVAILABLE',productionWritesEnabled:false});}
  finally{active.delete(req.s03.userScopeId);}
 });
}

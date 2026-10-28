/** F07 — disposable Vectra lifecycle. Never touches SillyTavern native Standard. */
import {randomUUID} from 'node:crypto';
import {collectionIdentity} from './s02-identity.js';
import {planMutation} from './s04-contract.js';
import {OperationLedger} from './s04-ledger.js';
import {MutationEngine} from './s04-engine.js';
import {f07VectraLocation,provisionF07VectraV2Collection,f07SchemaSeal} from './f07-vectra.js';
import {vectraV2Adapter} from './s08-vectra.js';
export const F07_ACCEPTANCE_CONSENT='I ACCEPT F07 DISPOSABLE VECTRA TEST';
export const F07_ACCEPTANCE_STAGES=Object.freeze(['provision','schema','insert','readback','search','metadata','stale_revision','pagination','reopen','delete','empty_after_delete']);
const refuse=code=>Object.assign(new Error(code),{code});
export async function runF07VectraAcceptance(context,makeIndex,{runId=randomUUID()}={}){
 if(!context?.userScopeId||!context?.vectorsPath||typeof makeIndex!=='function')throw refuse('F07_HOST_CONTEXT_REQUIRED');
 const id=runId.replaceAll('-','').toLowerCase();
 if(!/^[0-9a-f]{32}$/.test(id))throw refuse('F07_RUN_ID_INVALID');
 const scope={userScopeId:context.userScopeId,collectionId:`f07_${id}`,type:'other',sourceId:`diagnostic_${id}`};
 const embedding={source:'diagnostic',model:'f07-vectra-four-dimensional',dimension:4,metric:'cosine'};
 const identity=collectionIdentity({backend:'vectra',scope,embedding});
 const binding={authorized:true,provenance:'SERVER_VERIFIED',backend:'vectra',scope,embedding,
  collection:{key:identity.key,physicalName:identity.physicalName}};
 const evidence=[];let stage='provision',adapter=null;const recordId=randomUUID();
 const vector=[.25,.5,.75,.125],text='F07 disposable Vectra record';
 const pass=()=>evidence.push({stage,status:'PASS'});
 const mutate=async(action,revision,payload)=>{
  const plan=planMutation(context,{backend:'vectra',scope,embedding,action,recordId,
   operationId:randomUUID(),expectedRevision:revision,...(payload||{})});
  const engine=new MutationEngine({ledger:new OperationLedger(context),adapter,
   authorize:async()=>({authorized:true,ownerVerified:true,mutationContractVerified:true,collectionKey:identity.key,backend:'vectra'})});
  const result=await engine.execute(plan,payload);
  if(result.state!=='VERIFIED')throw refuse('F07_MUTATION_UNCERTAIN');
 };
 try{
  const folder=await f07VectraLocation(context,binding,{createRoot:true});
  const index=await makeIndex(folder);
  await provisionF07VectraV2Collection({folder,index},binding,context);pass();
  stage='schema';let transport={index,s08ServerSchema:f07SchemaSeal(binding),s08DisposableFixture:true};
  adapter=vectraV2Adapter(transport,binding);
  await adapter.inspectSchema();pass();
  stage='insert';await mutate('insert',0,{text,vector,metadata:{fixture:'F07'}});pass();
  stage='readback';if((await adapter.getRecord(recordId))?.revision!==1)throw refuse('F07_READBACK_FAILED');pass();
  stage='search';if(!(await adapter.query({vector,topK:3})).some(x=>x.recordId===recordId))throw refuse('F07_SEARCH_FAILED');pass();
  stage='metadata';await mutate('metadata',1,{metadata:{fixture:'F07',updated:true}});pass();
  stage='stale_revision';
  const stale=planMutation(context,{backend:'vectra',scope,embedding,action:'delete',recordId,
   operationId:randomUUID(),expectedRevision:1});
  try{await adapter.deleteRecord(stale);throw refuse('F07_STALE_REVISION_ACCEPTED');}
  catch(e){if(e.code!=='S08_REVISION_CONFLICT')throw e;}
  if((await adapter.getRecord(recordId))?.revision!==2)throw refuse('F07_STALE_MUTATED');pass();
  stage='pagination';const page=await adapter.listPage({limit:1});
  if(!page.items.some(x=>x.recordId===recordId)||page.inventoryVerified!==false)throw refuse('F07_PAGINATION_UNVERIFIED');pass();
  stage='reopen';const reopened=await makeIndex(folder);const fresh=vectraV2Adapter({index:reopened,s08ServerSchema:f07SchemaSeal(binding),s08DisposableFixture:true},binding);
  if((await fresh.getRecord(recordId))?.revision!==2)throw refuse('F07_REOPEN_FAILED');pass();
  stage='delete';await mutate('delete',2);pass();
  stage='empty_after_delete';if(await fresh.getRecord(recordId)!==null)throw refuse('F07_DELETE_FAILED');pass();
  return {success:true,acceptance:'F07_DISPOSABLE_CONTRACT_PASS',stages:evidence,collection:identity.physicalName,
   disposable:true,collectionRetained:true,productionWritesEnabled:false,backendCertified:false,
   nativeStandardCertified:false,externalWriterIsolationVerified:false,restartPersistenceVerified:false};
 }catch(e){evidence.push({stage,status:'FAILED_OR_UNCERTAIN',code:/^[A-Z0-9_]{2,90}$/.test(e?.code||'')?e.code:'F07_BACKEND_UNVERIFIED'});
  return {success:false,acceptance:'F07_FAILED_OR_UNCERTAIN',stages:evidence,collection:identity.physicalName,
   disposable:true,collectionRetained:true,productionWritesEnabled:false,backendCertified:false,nativeStandardCertified:false,
   warning:'Synthetic index/record may remain; no retries or purges.'};}
}
export function registerF07AcceptanceRoutes(router,{makeIndex,run=runF07VectraAcceptance}={}){
 if(typeof makeIndex!=='function')throw Error('F07_INDEX_FACTORY_REQUIRED');
 const active=new Set();
 router.post('/v2/diagnostics/vectra-f07',async(req,res)=>{
  const b=req.body,h=req.headers||{},header=req.get?.('x-vecthare-f07-diagnostic')??h['x-vecthare-f07-diagnostic'];
  const site=req.get?.('sec-fetch-site')??h['sec-fetch-site'];
  if(header!=='1'||(site&&!['same-origin','none'].includes(site)))
   return res.status(403).json({success:false,code:'F07_SAME_ORIGIN_HEADER_REQUIRED',productionWritesEnabled:false});
  if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).some(k=>k!=='consent')||b.consent!==F07_ACCEPTANCE_CONSENT)
   return res.status(403).json({success:false,code:'F07_DISPOSABLE_CONSENT_REQUIRED',productionWritesEnabled:false});
  if(!req.s03?.userScopeId||!req.s03?.vectorsPath)return res.status(403).json({success:false,code:'F07_HOST_AUTH_REQUIRED',productionWritesEnabled:false});
  if(active.has(req.s03.userScopeId))return res.status(409).json({success:false,code:'F07_TEST_BUSY',productionWritesEnabled:false});
  active.add(req.s03.userScopeId);
  try{const result=await run(req.s03,makeIndex);return res.status(result.success?200:409).json(result);}
  catch{return res.status(503).json({success:false,code:'F07_BACKEND_UNAVAILABLE',productionWritesEnabled:false});}
  finally{active.delete(req.s03.userScopeId);}
 });
}

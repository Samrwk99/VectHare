/** H01: safe opt-in real-backend acceptance for a NEW, random, isolated Qdrant
 * collection. No existing collection is opened for mutation or removed.
 * This is evidence gathering, NOT a production memory-write capability. */
import {randomUUID} from 'node:crypto';
import {collectionIdentity} from './s02-identity.js';
import {planMutation} from './s04-contract.js';
import {qdrantV2Adapter,provisionDisposableQdrantV2Collection} from './s06-qdrant.js';
import {MutationEngine} from './s04-engine.js';
import {OperationLedger} from './s04-ledger.js';

export class AcceptanceError extends Error {
 constructor(code,message,status=409){super(message);this.code=code;this.status=status;}
}
export async function runQdrantDisposableAcceptance(context,realBackend,{runId=randomUUID()}={}){
 if(!context?.userScopeId||!context?.vectorsPath||typeof realBackend?._request!=='function') {
  throw new AcceptanceError('H01_CONTEXT_REQUIRED','Authenticated user directory and initialized Qdrant required',403);
 }
 const id=runId.replace(/-/g,'');
 if(!/^[0-9a-f]{32}$/.test(id))throw new AcceptanceError('H01_INVALID_RUN_ID','Invalid run ID',400);
 const scope={userScopeId:context.userScopeId,collectionId:`diagnostic_${id}`,type:'other',sourceId:`qdrant_${id}`};
 const embedding={source:'diagnostic',model:'h01-exact-dot',dimension:4,metric:'dot'};
 const collection=collectionIdentity({backend:'qdrant',scope,embedding});
 const binding={authorized:true,provenance:'SERVER_VERIFIED',backend:'qdrant',scope,embedding,
  collection:{key:collection.key,physicalName:collection.physicalName}};
 // This wrapper's test flag is NEVER set on the real pooled backend instance.
 const transport={s06DisposableFixture:true,_request:(...args)=>realBackend._request(...args)};
 const stages=[];
 const mark=(name,detail)=>stages.push({name,result:detail});
 try{
  mark('provision','STARTED');
  const created=await provisionDisposableQdrantV2Collection(transport,binding);
  if(created.status!=='PROVISIONED_DISPOSABLE_ONLY')throw new AcceptanceError('H01_PROVISION_UNVERIFIED','Test collection creation not verified');
  mark('provision','PASS');
  const adapter=qdrantV2Adapter(transport,binding);
  const engine=new MutationEngine({atomicOnly:false,ledger:new OperationLedger(context),adapter,
   authorize:async plan=>({authorized:true,ownerVerified:true,mutationContractVerified:true,
    collectionKey:plan.collectionKey,backend:'qdrant'})});
  const rid=randomUUID();
  const insert={backend:'qdrant',scope,embedding,action:'insert',recordId:rid,
   operationId:randomUUID(),text:'h01 disposable memory',vector:[1,0,0,0],metadata:{fixture:'H01'}};
  const p1=planMutation(context,insert);
  mark('insert','STARTED');
  const inserted=await engine.execute(p1,{text:insert.text,vector:insert.vector,metadata:insert.metadata});
  if(inserted.state!=='VERIFIED')throw new AcceptanceError('H01_INSERT_UNVERIFIED','Insert/readback not verified');
  mark('insert','PASS');
  const got=await adapter.getRecord(rid);
  if(!got||got.text!==insert.text||got.revision!==1)throw new AcceptanceError('H01_READ_UNVERIFIED','Scoped readback mismatch');
  mark('get','PASS');
  const query=await adapter.query({vector:[1,0,0,0],topK:5});
  if(!query.some(r=>r.recordId===rid))throw new AcceptanceError('H01_QUERY_UNVERIFIED','Test point absent from similarity search');
  mark('query','PASS');
  const edit={backend:'qdrant',scope,embedding,action:'update',recordId:rid,expectedRevision:1,
   operationId:randomUUID(),text:'h01 edited disposable memory',vector:[0,1,0,0],metadata:{fixture:'H01',edited:true}};
  const p2=planMutation(context,edit);
  mark('edit','STARTED');
  const updated=await engine.execute(p2,{text:edit.text,vector:edit.vector,metadata:edit.metadata});
  if(updated.state!=='VERIFIED')throw new AcceptanceError('H01_UPDATE_UNVERIFIED','Update/readback not verified');
  mark('edit','PASS');
  if((await adapter.getRecord(rid))?.revision!==2)throw new AcceptanceError('H01_REVISION_UNVERIFIED','Revision readback mismatch');
  mark('revision','PASS');
  const p3=planMutation(context,{backend:'qdrant',scope,embedding,action:'delete',recordId:rid,
   expectedRevision:2,operationId:randomUUID()});
  mark('delete','STARTED');
  const deleted=await engine.execute(p3,null);
  if(deleted.state!=='VERIFIED'||await adapter.getRecord(rid)!==null)throw new AcceptanceError('H01_DELETE_UNVERIFIED','Delete/readback not verified');
  mark('delete','PASS');
  // We deliberately leave the new, empty disposable collection in place.
  // Do not call dropCollection or purgeAll as automatic cleanup.
  return {success:true,acceptance:'PASS_DISPOSABLE_ONLY',productionWritesEnabled:false,
   disposableCollection:collection.physicalName,stages,warning:'Empty disposable collection retained; no automatic physical purge performed'};
 }catch(error){
  return {success:false,code:error.code||'H01_BACKEND_TEST_FAILED',acceptance:'FAILED_OR_UNCERTAIN',
   productionWritesEnabled:false,disposableCollection:collection.physicalName,stages,
   warning:'Disposable collection and possibly one test record may remain. Never automatically purge an uncertain operation.'};
 }
}
export function registerH01AcceptanceRoutes(router,{backendPool}){
 const active=new Set();
 router.post('/v2/diagnostics/qdrant-contract',async(req,res)=>{
  if(req.body?.confirmDisposable!==true || !['default','local'].includes(req.body?.configId) ||
   Object.keys(req.body||{}).some(k=>!['confirmDisposable','configId'].includes(k))){
   return res.status(400).json({success:false,code:'H01_EXPLICIT_CONFIRMATION_REQUIRED'});
  }
  if(!req.s03?.userScopeId||!req.s03?.vectorsPath)return res.status(403).json({success:false,code:'H01_USER_UNVERIFIED'});
  const key=req.s03.userScopeId;
  if(active.has(key))return res.status(409).json({success:false,code:'H01_TEST_ALREADY_RUNNING'});
  active.add(key);
  try{
   const b=await backendPool.get(req.s03,'qdrant',req.body.configId);
   const result=await runQdrantDisposableAcceptance(req.s03,b);
   return res.status(result.success?200:409).json(result);
  }catch(error){return res.status(error.status||503).json({success:false,code:error.code||'H01_BACKEND_UNAVAILABLE',productionWritesEnabled:false});}
  finally{active.delete(key);}
 });
}

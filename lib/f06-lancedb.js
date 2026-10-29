/** F06 — source-selected LanceDB v2 schema provisioning and disposable acceptance.
 * This module NEVER promotes ordinary memory writes or opens legacy tables by
 * guess. A successfully-created table remains for inspection (no auto-drop).
 */
import {randomUUID} from 'node:crypto';
import {collectionIdentity} from './s02-identity.js';
import {planMutation} from './s04-contract.js';
import {OperationLedger} from './s04-ledger.js';
import {MutationEngine} from './s04-engine.js';
import {inspectLanceV2Table,lancedbV2Adapter} from './s08-lancedb.js';

export class F06LanceError extends Error {
 constructor(code,message,status=409){super(message);this.code=code;this.status=status;}
}
const safe=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
const fields=['physicalId','recordId','userScopeId','collectionId','type','sourceId','branchId',
 'text','textHash','metadata','metadataHash','embedding','vectorHash'];
/** An explicit Arrow schema avoids creating a fake first memory to infer types. */
export function f06ArrowSchema(arrow,dimension){
 if(!Number.isSafeInteger(dimension)||dimension<1||dimension>65536)
  throw new F06LanceError('F06_DIMENSION_INVALID','Fixed vector dimension required',400);
 for(const k of ['Schema','Field','Utf8','Int32','FixedSizeList','Float32'])
  if(typeof arrow?.[k]!=='function')throw new F06LanceError('F06_ARROW_UNAVAILABLE','Compatible Apache Arrow schema API required');
 return new arrow.Schema([
  ...fields.map(name=>new arrow.Field(name,new arrow.Utf8(),false)),
  new arrow.Field('schemaVersion',new arrow.Int32(),false),
  new arrow.Field('revision',new arrow.Int32(),false),
  new arrow.Field('vector',new arrow.FixedSizeList(dimension,new arrow.Field('item',new arrow.Float32(),false)),false),
 ]);
}
export async function provisionF06LanceV2Collection(backend,binding,{arrowModule}={}){
 if(binding?.backend!=='lancedb'||binding.authorized!==true||binding.provenance!=='SERVER_VERIFIED'||
  typeof binding?.collection?.physicalName!=='string'||!/^vh2_[a-f0-9]{48}$/.test(binding.collection.physicalName))
  throw new F06LanceError('F06_BINDING_UNVERIFIED','Only server-attested v2 LanceDB bindings may be provisioned',403);
 if(typeof backend?.getDatabase!=='function')throw new F06LanceError('F06_SOURCE_DATABASE_REQUIRED','Source-specific local LanceDB connection required');
 // The embedding source is canonicalized in F02. Never use a cached first DB.
 const db=await backend.getDatabase(binding.embedding.source);
 if(typeof db?.tableNames!=='function'||typeof db?.createEmptyTable!=='function'||typeof db?.openTable!=='function')
  throw new F06LanceError('F06_BACKEND_INCOMPATIBLE','LanceDB empty table creation API unavailable');
 const existing=await db.tableNames();
 if(!Array.isArray(existing))throw new F06LanceError('F06_TABLE_ENUMERATION_FAILED','Table existence cannot be established');
 if(existing.includes(binding.collection.physicalName))throw new F06LanceError('F06_COLLECTION_EXISTS','Existing LanceDB tables are never overwritten');
 // Load the actual Arrow API only after trusted source and preflight; never
 // fall back to inferred schema or write a dummy row into a legacy table.
 let arrow=arrowModule;
 if(!arrow){try{arrow=await import('apache-arrow');}catch{throw new F06LanceError('F06_ARROW_UNAVAILABLE','Install the supported apache-arrow plugin dependency');}}
 const schema=f06ArrowSchema(arrow,binding.embedding.dimension);
 // mode:create AND existOk:false must both be explicit to fail closed on a
 // second writer creating a table between discovery and create.
 await db.createEmptyTable(binding.collection.physicalName,schema,{mode:'create',existOk:false});
 const inspected=await inspectLanceV2Table({db},binding);
 const count=await inspected.table.countRows?.();
 if(count!==0)throw new F06LanceError('F06_COLLECTION_NONEMPTY','New v2 table unexpectedly contains records');
 return {status:'PROVISIONED_SOURCE_BOUND_UNCERTIFIED',physicalName:binding.collection.physicalName,
  schemaInspected:true,backendCertified:false,recordMutationsEnabled:false};
}

export const F06_ACCEPTANCE_CONSENT='I ACCEPT F06 DISPOSABLE LANCEDB TEST';
const stages=Object.freeze(['provision','schema','insert','readback','search','metadata','stale_revision','pagination','reopen','delete','empty_after_delete']);
export const F06_ACCEPTANCE_STAGES=stages;
const fail=code=>new F06LanceError(code,code);
/** Diagnostic only: new synthetic v2 table in authenticated user's LanceDB directory.
 * The F03 provisioner is reused to avoid inferred schemas, legacy table mutation,
 * accidental overwrites, and inconsistency between diagnostic/normal paths.
 */
export async function runF06LanceAcceptance(context,backend,{runId=randomUUID(),provision=provisionF06LanceV2Collection}={}){
 if(!context?.userScopeId||!context?.vectorsPath||typeof backend?.getDatabase!=='function')
  throw fail('F06_HOST_CONTEXT_REQUIRED');
 if(!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(runId))throw fail('F06_RUN_ID_INVALID');
 const id=runId.replaceAll('-','').toLowerCase();
 const scope={userScopeId:context.userScopeId,collectionId:`f06_${id}`,type:'other',sourceId:`diagnostic_${id}`};
 const embedding={source:'diagnostic',model:'f06-lancedb-four-dimensional',dimension:4,metric:'dot'};
 const identity=collectionIdentity({backend:'lancedb',scope,embedding});
 const binding={authorized:true,provenance:'SERVER_VERIFIED',backend:'lancedb',scope,embedding,
  collection:{key:identity.key,physicalName:identity.physicalName}};
 const evidence=[],recordId=randomUUID();let current='provision';
 const pass=stage=>evidence.push({stage,status:'PASS'});
 const vector=[Math.fround(.25),Math.fround(.5),Math.fround(.75),Math.fround(.125)];
 const payload={text:'F06 disposable LanceDB record',vector,metadata:{fixture:'F06'}};
 let db,adapter;
 const mutation=async(action,revision,extra={})=>{
  const p={backend:'lancedb',scope,embedding,action,recordId,operationId:randomUUID(),expectedRevision:revision,...extra};
  const plan=planMutation(context,p);
  const input=action==='delete'?undefined:action==='metadata'?{metadata:extra.metadata}:
   {text:extra.text,vector:extra.vector,metadata:extra.metadata};
  const engine=new MutationEngine({atomicOnly:false,ledger:new OperationLedger(context),adapter,
   authorize:async()=>({authorized:true,ownerVerified:true,mutationContractVerified:true,
    collectionKey:identity.key,backend:'lancedb'})});
  const result=await engine.execute(plan,input);
  if(result.state!=='VERIFIED')throw fail('F06_MUTATION_UNCERTAIN');
 };
 try{
  await provision(backend,binding);pass('provision');
  current='schema';db=await backend.getDatabase(embedding.source);
  const inspected=await inspectLanceV2Table({db},binding);
  if(!inspected.schemaInspected)throw fail('F06_SCHEMA_UNVERIFIED');pass('schema');
  adapter=lancedbV2Adapter({db,s08DisposableFixture:true},binding);
  current='insert';await mutation('insert',0,payload);pass('insert');
  current='readback';const first=await adapter.getRecord(recordId);
  if(first?.revision!==1||first?.text!==payload.text||first?.vector?.length!==4)
   throw fail('F06_READBACK_MISMATCH');pass('readback');
  current='search';const hits=await adapter.query({vector,topK:5});
  if(!hits.some(hit=>hit.recordId===recordId))throw fail('F06_SEARCH_MISMATCH');pass('search');
  current='metadata';await mutation('metadata',1,{metadata:{fixture:'F06',updated:true}});
  if((await adapter.getRecord(recordId))?.revision!==2)throw fail('F06_METADATA_REVISION_MISMATCH');pass('metadata');
  current='stale_revision';const stale=planMutation(context,{backend:'lancedb',scope,embedding,action:'delete',recordId,
   operationId:randomUUID(),expectedRevision:1});
  try{await adapter.deleteRecord(stale);throw fail('F06_STALE_REVISION_ACCEPTED');}
  catch(e){if(e.code!=='S08_REVISION_CONFLICT')throw e;}
  if((await adapter.getRecord(recordId))?.revision!==2)throw fail('F06_STALE_MUTATED');pass('stale_revision');
  current='pagination';const page=await adapter.listPage({limit:1});
  if(!page.items.some(row=>row.recordId===recordId)||page.inventoryVerified!==false)
   throw fail('F06_PAGINATION_FAILED');pass('pagination');
  current='reopen';db=await backend.getDatabase(embedding.source);
  const fresh=lancedbV2Adapter({db,s08DisposableFixture:true},binding);
  if((await fresh.getRecord(recordId))?.revision!==2)throw fail('F06_REOPEN_FAILED');pass('reopen');
  current='delete';await mutation('delete',2);pass('delete');
  current='empty_after_delete';if(await fresh.getRecord(recordId)!==null)throw fail('F06_DELETE_UNVERIFIED');pass('empty_after_delete');
  return {success:true,acceptance:'F06_DISPOSABLE_CONTRACT_PASS',stages:evidence,collection:identity.physicalName,
   disposable:true,collectionRetained:true,productionWritesEnabled:false,backendCertified:false,
   externalWriterIsolationVerified:false,restartPersistenceVerified:false};
 }catch(e){evidence.push({stage:current,status:'FAILED_OR_UNCERTAIN',code:/^[A-Z0-9_]{2,90}$/.test(e?.code||'')?e.code:'F06_BACKEND_UNVERIFIED'});
  return {success:false,acceptance:'F06_FAILED_OR_UNCERTAIN',stages:evidence,collection:identity.physicalName,
   disposable:true,collectionRetained:true,productionWritesEnabled:false,backendCertified:false,
   warning:'A synthetic record may remain. Inspect receipts and table; never auto-retry, overwrite or drop.'};}
}
export function registerF06AcceptanceRoutes(router,{backendPool,run=runF06LanceAcceptance}={}){
 if(typeof backendPool?.get!=='function')throw Error('F06_BACKEND_POOL_REQUIRED');
 const active=new Set();
 router.post('/v2/diagnostics/lancedb-f06',async(req,res)=>{
  const body=req.body,header=req.get?.('x-vecthare-f06-diagnostic')??req.headers?.['x-vecthare-f06-diagnostic'];
  const site=req.get?.('sec-fetch-site')??req.headers?.['sec-fetch-site'];
  if(header!=='1'||(site&&!['same-origin','none'].includes(site)))
   return res.status(403).json({success:false,code:'F06_SAME_ORIGIN_HEADER_REQUIRED',productionWritesEnabled:false});
  if(!safe(body)||Object.keys(body).some(k=>!['consent'].includes(k))||body.consent!==F06_ACCEPTANCE_CONSENT)
   return res.status(403).json({success:false,code:'F06_DISPOSABLE_CONSENT_REQUIRED',productionWritesEnabled:false});
  if(!req.s03?.userScopeId||!req.s03.vectorsPath)
   return res.status(403).json({success:false,code:'F06_HOST_AUTH_REQUIRED',productionWritesEnabled:false});
  if(active.has(req.s03.userScopeId))return res.status(409).json({success:false,code:'F06_TEST_BUSY',productionWritesEnabled:false});
  active.add(req.s03.userScopeId);
  try{const backend=await backendPool.get(req.s03,'lancedb','default');const result=await run(req.s03,backend);
   return res.status(result.success?200:409).json(result);
  }catch{return res.status(503).json({success:false,code:'F06_BACKEND_UNAVAILABLE',productionWritesEnabled:false});}
  finally{active.delete(req.s03.userScopeId);}
 });
}

/** F02 — authenticated, scoped v2 read execution.
 * A browser supplies only an owned saved-file selector and embedding config.
 * Every request re-attests the file; the S02 registry and backend schema must
 * also match. No legacy collection guessing, writing, full-inventory or export.
 * No capability response is itself a read authorization.
 */
import path from 'node:path';
import {attestHostSource} from './f01-host-sources.js';
import {CollectionRegistry} from './s02-registry.js';
import {guardM3CanonicalBinding} from './m3-cutover-journal.js';
import {resolveM3ReadBinding} from './m3-target-receipts.js';
import {M3CutoverJournal} from './m3-cutover-journal.js';
import {resolveM4aLanceReadBinding} from './m4a-lancedb-cutover.js';
import {collectionIdentity,canonicalEmbedding} from './s02-identity.js';
import {selectedM3Profile} from './m3-source-selection.js';
import {ReadError,readPageOptions,validateVector} from './s05-contract.js';
import {qdrantV2Adapter} from './s06-qdrant.js';
import {milvusV2Adapter} from './s07-milvus.js';
import {lancedbV2Adapter} from './s08-lancedb.js';
import {vectraV2Adapter} from './s08-vectra.js';

const BACKENDS=new Set(['qdrant','milvus','lancedb','vectra']);
const safeObject=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
const refused=(code,message,status=409)=>new ReadError(code,message,status);
const baseKeys=['backend','source','embedding','configId'];
function validateBody(body,operation){
 if(!safeObject(body))throw refused('F02_INVALID_REQUEST','Read request must be a JSON object',400);
 const extras=operation==='get'?['recordId']:operation==='list'?['page']:operation==='query'?['vector','topK']:[];
 if(Object.keys(body).some(key=>![...baseKeys,...extras].includes(key)))
  throw refused('F02_CLIENT_SCOPE_FORBIDDEN','Client may not provide collection/owner/physical scope or unrelated fields',403);
 if(!BACKENDS.has(body.backend))throw refused('F02_BACKEND_UNSUPPORTED','Backend is not supported by this read API',400);
 if(!safeObject(body.source)||!safeObject(body.embedding))throw refused('F02_SOURCE_REQUIRED','Saved-file selector and embedding required',400);
 if(body.configId!==undefined&&!['local','default'].includes(body.configId))
  throw refused('F02_CONFIG_INVALID','Unknown connection selector',400);
 if(body.backend!=='qdrant'&&body.configId==='local')throw refused('F02_CONFIG_INVALID','Local selector is Qdrant only',400);
 if(operation==='get' && (typeof body.recordId!=='string'||body.recordId.length>64))
  throw refused('F02_RECORD_ID_REQUIRED','Stable record UUID required',400);
 if(operation==='list') readPageOptions(body.page??{});
 if(operation==='query') {
  const e=canonicalEmbedding(body.embedding);
  validateVector(body.vector,e.dimension);
  if(body.topK!==undefined&&(!Number.isSafeInteger(body.topK)||body.topK<1||body.topK>100))
   throw refused('F02_TOPK_INVALID','topK must be 1..100',400);
 }
 return body;
}
/** Server-only binding. Reserved names are not evidence of a physical DB.
 * `bind` changes ONLY the private S02 name reservation; no vector operation.
 */
export async function resolveF02Binding(req,body,{reserve=false,readAlias=false}={}){
 // The HTTP handler has already checked the operation-specific fields.
 if(!req?.s03?.userScopeId||!req.s03.vectorsPath)throw refused('F02_HOST_AUTH_REQUIRED','Authenticated host context required',401);
 const attested=await attestHostSource(req,body.source);
 if(attested.status!=='HOST_FILE_OWNED'||attested.hostSourceOwnerVerified!==true||
  attested.scope?.userScopeId!==req.s03.userScopeId)
  throw refused('F02_SOURCE_NOT_ATTESTED','Saved source not authenticated',403);
 const backend=body.backend;
 const embedding=canonicalEmbedding(body.embedding);
 const identity=collectionIdentity({backend,scope:attested.scope,embedding});
 const registry=new CollectionRegistry(path.join(req.s03.vectorsPath,'.similharity'));
 const entry=reserve?await registry.reserve(identity):await registry.lookup(identity);
 if(!entry||entry.key!==identity.key||entry.physicalName!==identity.physicalName||entry.backend!==backend)
  throw refused('F02_COLLECTION_NOT_BOUND','Explicit v2 collection binding required; use Bind first',409);
 if(entry.status!=='RESERVED_NOT_ACTIVE')
  throw refused('F02_COLLECTION_STATE_INVALID','Collection registry has unexpected state',409);
 const binding=Object.freeze({authorized:true,provenance:'SERVER_VERIFIED',backend,
  scope:attested.scope,embedding,collection:{key:entry.key,physicalName:entry.physicalName}});
 // Only F02 read execution is permitted to defer the published-alias check.
 // Every mutation/provisioning caller still gets the strict canonical guard.
 if(!readAlias||reserve||!['qdrant','lancedb'].includes(backend))await guardM3CanonicalBinding(req.s03,binding);
 return {binding,identity,attested};
}
function makeAdapter(backend,transport,binding){
 switch(backend){
  case 'qdrant':return qdrantV2Adapter(transport,binding);
  case 'milvus':return milvusV2Adapter(transport,binding);
  case 'lancedb':return lancedbV2Adapter(transport,binding);
  case 'vectra':return vectraV2Adapter(transport,binding);
  default:throw refused('F02_BACKEND_UNSUPPORTED','Unknown backend',400);
 }
}
function errorCode(err){return typeof err?.code==='string'&&/^[A-Z0-9_]{1,90}$/.test(err.code)?err.code:'F02_READ_FAILED';}
function failure(res,error){
 const status=Number.isInteger(error?.status)&&error.status>=400&&error.status<=599?error.status:409;
 // Do not return backend error messages which may include secrets/paths/text.
 return res.status(status).json({success:false,code:errorCode(error),readAuthorized:false,
  inventoryVerified:false,productionWritesEnabled:false});
}
/** F09: reusable, authorization-preserving read engine. This function ALWAYS
 * re-attests the source, rechecks collection binding and inspects physical
 * schema. It never grants record mutations or complete inventory rights. */
export async function executeF02ScopedRead(req,body,operation,{backendPool,createVectra,attest=resolveF02Binding,makeReadAdapter=makeAdapter}={}){
 if(!['get','list','query'].includes(operation))throw refused('F02_OPERATION_DENIED','Read operation unavailable',409);
 validateBody(body,operation);
 if(body.backend==='qdrant'&&attest===resolveF02Binding){
  const selected=await selectedM3Profile(req,body.source);
  if(selected.selected&&JSON.stringify(canonicalEmbedding(body.embedding))!==JSON.stringify(selected.profile))
   throw refused('F02_SELECTED_EMBEDDING_REQUIRED','Read profile must match the source-selected model',409);
 }
 const selectionBefore=body.backend==='qdrant'&&attest===resolveF02Binding?
  await selectedM3Profile(req,body.source):null;
 const {binding:canonical}=await attest(req,body,{reserve:false,readAlias:['qdrant','lancedb'].includes(body.backend)});
 let transport;
   if(body.backend==='vectra'){
    if(typeof createVectra!=='function')throw refused('F02_VECTRA_NOT_CONFIGURED','Vectra v2 index binding unavailable');
    transport=await createVectra(req,canonical);
   }else {
    transport=await backendPool.get(req.s03,body.backend,body.configId??'default');
    if(body.backend==='lancedb'){
     // The legacy `.db` getter returns the FIRST opened source database and
     // may be null. Never read a source-selected collection from that handle.
     if(typeof transport?.getDatabase!=='function')throw refused('F02_LANCE_SOURCE_UNAVAILABLE','Source-specific LanceDB database required');
     transport={db:await transport.getDatabase(canonical.embedding.source)};
    }
   }
 // Authenticated journal + immutable target receipt + fresh live Qdrant proof.
 // No fallback to canonical on missing, malformed or stale alias evidence.
 const binding=attest===resolveF02Binding&&body.backend==='qdrant'
  ?await resolveM3ReadBinding(req.s03,canonical,{transport}):
  attest===resolveF02Binding&&body.backend==='lancedb'
  ?await resolveM4aLanceReadBinding(req.s03,canonical,{db:transport.db}):canonical;
 const adapter=makeReadAdapter(body.backend,transport,binding);
   if(typeof adapter.inspectSchema!=='function')throw refused('F02_SCHEMA_UNVERIFIED','Backend schema inspection unavailable');
 const schema=await adapter.inspectSchema();
   if(!schema||schema.schemaInspected===false)throw refused('F02_SCHEMA_UNVERIFIED','Collection schema not verified');
 let result;
   if(operation==='get')result=await adapter.getRecord(body.recordId);
   if(operation==='list')result=await adapter.listPage(body.page??{});
   if(operation==='query')result=await adapter.query({vector:body.vector,topK:body.topK??10});
 // A cutover that races with an in-flight read must not return stale data.
 if(['qdrant','lancedb'].includes(body.backend)&&attest===resolveF02Binding){
  const after=await selectedM3Profile(req,body.source);
  if((selectionBefore?.selectionGeneration??0)!==(after.selectionGeneration??0)||
    JSON.stringify(selectionBefore?.profile)!==JSON.stringify(after.profile))
   throw refused('F02_SOURCE_MODEL_SELECTION_CHANGED','Source model changed during read',409);
  const journal=new M3CutoverJournal(req.s03,{backend:body.backend,logicalKey:canonical.collection.key});
  if(binding.collection.generation!==undefined){
   await journal.assertCurrentVersioned(binding,canonical);
  }else{
   await guardM3CanonicalBinding(req.s03,canonical);
  }
 }
 return result;
}
export function registerF02Routes(router,{backendPool,createVectra,attest=resolveF02Binding,makeReadAdapter=makeAdapter}={}){
 if(!backendPool||typeof backendPool.get!=='function')throw Error('F02_BACKEND_POOL_REQUIRED');
 router.post('/v2/reads/bind',async(req,res)=>{
  try{
   const body=validateBody(req.body,'bind');
   const {identity}=await attest(req,body,{reserve:true});
   return res.json({success:true,bindingReserved:true,physicalCollectionProvisioned:false,
    backendCertified:false,inventoryVerified:false,productionWritesEnabled:false,
    collectionKey:identity.key,collectionName:identity.physicalName});
  }catch(error){return failure(res,error);}
 });
 return async function publicRead(operation,req,res){
  try{
   if(!['get','list','query'].includes(operation))throw refused('F02_OPERATION_DENIED','Read operation unavailable',409);
   const body=validateBody(req.body,operation);
   const result=await executeF02ScopedRead(req,body,operation,{backendPool,createVectra,attest,makeReadAdapter});
   // Never advertise full inventory, snapshot, or certified mutation rights.
   return res.json({success:true,operation,backend:body.backend,
    data:result,scopeVerified:true,inventoryVerified:false,consistency:'UNVERIFIED',
    productionWritesEnabled:false,backendCertified:false});
  }catch(error){return failure(res,error);}
 };
}

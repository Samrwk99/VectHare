/** F02 — authenticated, scoped v2 read execution.
 * A browser supplies only an owned saved-file selector and embedding config.
 * Every request re-attests the file; the S02 registry and backend schema must
 * also match. No legacy collection guessing, writing, full-inventory or export.
 * No capability response is itself a read authorization.
 */
import path from 'node:path';
import {attestHostSource} from './f01-host-sources.js';
import {CollectionRegistry} from './s02-registry.js';
import {collectionIdentity,canonicalEmbedding} from './s02-identity.js';
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
export async function resolveF02Binding(req,body,{reserve=false}={}){
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
   const {binding}=await attest(req,body,{reserve:false});
   let transport;
   if(body.backend==='vectra'){
    if(typeof createVectra!=='function')throw refused('F02_VECTRA_NOT_CONFIGURED','Vectra v2 index binding unavailable');
    transport=await createVectra(req,binding);
   }else transport=await backendPool.get(req.s03,body.backend,body.configId??'default');
   const adapter=makeReadAdapter(body.backend,transport,binding);
   if(typeof adapter.inspectSchema!=='function')throw refused('F02_SCHEMA_UNVERIFIED','Backend schema inspection unavailable');
   const schema=await adapter.inspectSchema();
   if(!schema||schema.schemaInspected===false)throw refused('F02_SCHEMA_UNVERIFIED','Collection schema not verified');
   let result;
   if(operation==='get')result=await adapter.getRecord(body.recordId);
   if(operation==='list')result=await adapter.listPage(body.page??{});
   if(operation==='query')result=await adapter.query({vector:body.vector,topK:body.topK??10});
   // Never advertise full inventory, snapshot, or certified mutation rights.
   return res.json({success:true,operation,backend:body.backend,
    data:result,scopeVerified:true,inventoryVerified:false,consistency:'UNVERIFIED',
    productionWritesEnabled:false,backendCertified:false});
  }catch(error){return failure(res,error);}
 };
}

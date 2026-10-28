/** F09 — normal-memory candidate preview. This is a READ-ONLY, host-scoped
 * bridge between the verified F02 adapter and v2 record-ID based consumers.
 * No hash identity, inference of ownership, automatic injection, or write.
 */
import {executeF02ScopedRead} from './f02-public-reads.js';
const object=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
const allowed=new Set(['backend','source','embedding','configId','vector','topK']);
const backends=new Set(['qdrant','lancedb','vectra','milvus']);
export class F09WorkflowError extends Error{
 constructor(code,status=409){super(code);this.code=code;this.status=status;}
}
export function validateF09Request(body){
 if(!object(body)||Object.keys(body).some(k=>!allowed.has(k))||!backends.has(body.backend)||
  !object(body.source)||!object(body.embedding)||!Array.isArray(body.vector))
  throw new F09WorkflowError('F09_INVALID_REQUEST',400);
 if(body.source.kind!=='chat'&&body.source.kind!=='group-chat'&&body.source.kind!=='lorebook')
  throw new F09WorkflowError('F09_SAVED_SOURCE_REQUIRED',400);
 if(!Number.isInteger(body.topK)||body.topK<1||body.topK>30)
  throw new F09WorkflowError('F09_LIMIT_INVALID',400);
 // F02 performs the complete source, embedding, vector and schema validation.
 return body;
}
export function prepareF09Candidates(rows,maxResults){
 if(!Array.isArray(rows))throw new F09WorkflowError('F09_BACKEND_RESPONSE_INVALID');
 const candidates=[];const ids=new Set();
 for(const row of rows){
  const id=row?.recordId;
  if(typeof id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)||ids.has(id))
   throw new F09WorkflowError('F09_RECORD_ID_INVALID');
  if(typeof row.text!=='string'||!row.text.trim()||row.text.length>64000)
   throw new F09WorkflowError('F09_RECORD_TEXT_INVALID');
  if(typeof row.score!=='number'||!Number.isFinite(row.score))
   throw new F09WorkflowError('F09_SCORE_INVALID');
  if(!Number.isSafeInteger(row.revision)||row.revision<1)
   throw new F09WorkflowError('F09_REVISION_INVALID');
  ids.add(id);
  candidates.push({recordId:id,revision:row.revision,score:row.score,text:row.text,
   contentType:typeof row.metadata?.contentType==='string'?row.metadata.contentType.slice(0,60):'memory'});
  if(candidates.length>maxResults)throw new F09WorkflowError('F09_RESULT_LIMIT_EXCEEDED');
 }
 return candidates;
}
export function registerF09WorkflowRoutes(router,{backendPool,createVectra,readScoped=executeF02ScopedRead}={}){
 if(typeof readScoped!=='function'||!backendPool)throw Error('F09_DEPENDENCIES_REQUIRED');
 router.post('/v2/workflows/preview',async(req,res)=>{
  try{
   const body=validateF09Request(req.body);
   if(!req?.s03?.userScopeId||!req.s03.vectorsPath)throw new F09WorkflowError('F09_AUTH_REQUIRED',403);
   const records=await readScoped(req,body,'query',{backendPool,createVectra});
   const candidates=prepareF09Candidates(records,body.topK);
   return res.json({success:true,backend:body.backend,candidates,
    scopeVerified:true,readOnly:true,completeInventory:false,
    automaticInjectionEnabled:false,productionWritesEnabled:false,
    recordIdentity:'V2_RECORD_UUID',legacyHashCompatible:false});
  }catch(error){
   const status=Number.isInteger(error?.status)&&error.status>=400&&error.status<=599?error.status:409;
   const code=typeof error?.code==='string'&&/^[A-Z0-9_]{2,90}$/.test(error.code)?error.code:'F09_READ_UNAVAILABLE';
   return res.status(status).json({success:false,code,productionWritesEnabled:false,automaticInjectionEnabled:false});
  }
 });
}

/** F09 — normal-memory candidate preview. This is a READ-ONLY, host-scoped
 * bridge between the verified F02 adapter and v2 record-ID based consumers.
 * No hash identity, inference of ownership, automatic injection, or write.
 */
import {executeF02ScopedRead} from './f02-public-reads.js';
import {selectedM3Profile,generateM3SelectedEmbedding} from './m3-source-selection.js';
import {getEmbeddingProfile} from './f09b5-embedding-profiles.js';
import {readPB12Groups} from './pb12-managed-groups.js';
import {applyPB13ManagedRetrievalGroups} from './pb13-group-retrieval.js';
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
  // World Info conditions cannot be inferred from a vector match. M6 owns
  // evaluation; never inject a condition-bearing or disabled entry as if active.
  const meta=row.metadata;
  const record=meta?.vecthareRecordV2;
  if(meta?.enabled===false||record?.lorebook?.enabled===false||
    (Array.isArray(record?.conditions)&&record.conditions.length>0)||
    (Array.isArray(record?.lorebook?.conditions)&&record.lorebook.conditions.length>0))continue;
  candidates.push({recordId:id,revision:row.revision,score:row.score,text:row.text,
   contentType:typeof row.metadata?.contentType==='string'?row.metadata.contentType.slice(0,60):'memory'});
  if(candidates.length>maxResults)throw new F09WorkflowError('F09_RESULT_LIMIT_EXCEEDED');
 }
 return candidates.sort((a,b)=>b.score-a.score||a.recordId.localeCompare(b.recordId));
}
export function registerF09WorkflowRoutes(router,{backendPool,createVectra,readScoped=executeF02ScopedRead}={}){
 if(typeof readScoped!=='function'||!backendPool)throw Error('F09_DEPENDENCIES_REQUIRED');
 for(const [route,injection] of [['/v2/workflows/preview',false],['/v2/workflows/retrieve',true]]) router.post(route,async(req,res)=>{
  try{
   const body=validateF09Request(req.body);
   if(!req?.s03?.userScopeId||!req.s03.vectorsPath)throw new F09WorkflowError('F09_AUTH_REQUIRED',403);
   const records=await readScoped(req,body,'query',{backendPool,createVectra});
   const candidates=prepareF09Candidates(records,body.topK);
   return res.json({success:true,backend:body.backend,candidates,
    scopeVerified:true,readOnly:true,completeInventory:false,
    automaticInjectionEnabled:false,automaticInjectionEligible:injection,productionWritesEnabled:false,
    recordIdentity:'V2_RECORD_UUID',legacyHashCompatible:false});
  }catch(error){
   const status=Number.isInteger(error?.status)&&error.status>=400&&error.status<=599?error.status:409;
   const code=typeof error?.code==='string'&&/^[A-Z0-9_]{2,90}$/.test(error.code)?error.code:'F09_READ_UNAVAILABLE';
   return res.status(status).json({success:false,code,productionWritesEnabled:false,automaticInjectionEnabled:false});
  }
 });
}

/** P-A.2: query text, never browser vectors, is accepted by this prompt-only route.
 * The host re-attests its source, selects the server-configured embedding, then
 * reuses F02's owned-source/generation/schema-checked query. No mutation paths.
 */
export function validateF09ManagedQuery(body){
 if(!object(body)||Object.keys(body).some(k=>!['backend','source','configId','queryText','topK'].includes(k))||
  !backends.has(body.backend)||!object(body.source)||
  !['chat','group-chat','lorebook'].includes(body.source.kind)||
  typeof body.queryText!=='string'||!body.queryText.trim()||body.queryText.length>10000||
  !Number.isInteger(body.topK)||body.topK<1||body.topK>30||
  (body.configId!==undefined&&!['local','default'].includes(body.configId)))
  throw new F09WorkflowError('F09_MANAGED_QUERY_INVALID',400);
 return body;
}
export function registerF09ManagedQueryRoute(router,{backendPool,createVectra,readScoped=executeF02ScopedRead,
 selectProfile=selectedM3Profile,embed=generateM3SelectedEmbedding,getProfile=getEmbeddingProfile,
 hostEmbed,readGroups=readPB12Groups}={}){
 if(!backendPool||typeof readScoped!=='function')throw Error('F09_MANAGED_DEPENDENCIES_REQUIRED');
 router.post('/v2/workflows/retrieve-text',async(req,res)=>{
  try{
   const body=validateF09ManagedQuery(req.body);
   if(!req?.s03?.userScopeId||!req.s03.vectorsPath)throw new F09WorkflowError('F09_AUTH_REQUIRED',403);
   const selected=await selectProfile(req,body.source);
   if(!selected?.configured||!selected.profile)throw new F09WorkflowError('F09_MANAGED_PROFILE_REQUIRED');
   if(!selected.selected&&selected.connectionState!=='VERIFIED')
    throw new F09WorkflowError('F09_MANAGED_PROFILE_TEST_REQUIRED');
   const embedding=selected.profile;
   const vector=await embed(req.s03,selected.scope,embedding,body.queryText,{
    hostEmbed:typeof hostEmbed==='function'?(source,text,model)=>hostEmbed(req,source,text,model):undefined});
   // Refuse profile cutovers during an embedding fetch: no stale result escapes.
   const after=await selectProfile(req,body.source);
   if(!after?.configured||(!after.selected&&after.connectionState!=='VERIFIED')||JSON.stringify(after.profile)!==JSON.stringify(embedding)||
      after.selectionGeneration!==selected.selectionGeneration||
      (!selected.selected&&after.profileRevision!==selected.profileRevision))
    throw new F09WorkflowError('F09_MANAGED_PROFILE_CHANGED');
   // Bounded overfetch keeps exclusive groups from needlessly emptying a prompt.
   // The route still returns at most the user-requested topK after group policy.
   const fetchLimit=Math.min(30,body.topK*3);
   const query={backend:body.backend,source:body.source,embedding,configId:body.configId,
    vector,topK:fetchLimit};
   const rows=await readScoped(req,query,'query',{backendPool,createVectra});
   // Catch source/profile switch while the backend query was in flight as well.
   const final=await selectProfile(req,body.source);
   if(!final?.configured||(!final.selected&&final.connectionState!=='VERIFIED')||JSON.stringify(final.profile)!==JSON.stringify(embedding)||
      final.selectionGeneration!==selected.selectionGeneration||
      (!selected.selected&&final.profileRevision!==selected.profileRevision))
    throw new F09WorkflowError('F09_MANAGED_PROFILE_CHANGED');
   const rawCandidates=prepareF09Candidates(rows,fetchLimit);
   // Re-attest the exact source, owner, generation and complete physical inventory
   // on the plugin. Missing/stale evidence blocks this managed prompt, rather
   // than silently ignoring durable group policies. No legacy hash coercion.
   const groupEvidence=await readGroups({...req,body:{backend:body.backend,source:body.source,
    configId:body.configId}}, {backendPool,createVectra});
   const candidates=applyPB13ManagedRetrievalGroups(rawCandidates,groupEvidence,{backend:body.backend,topK:body.topK});
   return res.json({success:true,backend:body.backend,candidates,
    groupRevision:groupEvidence.revision,groupGeneration:groupEvidence.generation,
    embeddingProfile:embedding,profileRevision:selected.selected?null:selected.profileRevision,
    sourceSelectionGeneration:selected.selectionGeneration,scopeVerified:true,readOnly:true,
    completeInventory:false,automaticInjectionEnabled:false,automaticInjectionEligible:true,
    productionWritesEnabled:false,recordIdentity:'V2_RECORD_UUID',legacyHashCompatible:false});
  }catch(error){
   const status=Number.isInteger(error?.status)&&error.status>=400&&error.status<=599?error.status:409;
   const code=typeof error?.code==='string'&&/^[A-Z0-9_]{2,90}$/.test(error.code)?error.code:'F09_MANAGED_READ_UNAVAILABLE';
   return res.status(status).json({success:false,code,productionWritesEnabled:false,automaticInjectionEnabled:false});
  }
 });
}

/** F09b.7: read-only, source-owned World Info link/condition/lifecycle diagnostics.
 * Explicit custom `vecthareLinks` UID references are a pilot-only source annotation,
 * NOT a SillyTavern native link schema. Never activates prompt content or mutates vectors.
 */
import {readOwnedBytes,derivedUuid} from './f09b6-saved-content.js';
import {executeF02ScopedRead} from './f02-public-reads.js';
import {contentFingerprint,canonicalEmbedding} from './s02-identity.js';
const err=(code,status=409)=>{throw Object.assign(new Error(code),{code,status});};
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const safeCode=e=>/^F09B7_[A-Z0-9_]+$/.test(e?.code||'')?e.code:'F09B7_REFUSED';
const allowedSources=new Set(['transformers','openai','togetherai','mistral','openrouter']);
export function validateF09b7Request(req){
 const b=req?.body;
 if(!object(b)||Object.keys(b).some(k=>!['backend','configId','source','embedding'].includes(k))||
  !['qdrant','lancedb','vectra','milvus'].includes(b.backend)||b.configId!==(b.backend==='qdrant'?'local':'default')||
  !object(b.source)||Object.keys(b.source).sort().join(',')!=='kind,name'||b.source.kind!=='lorebook'||
  typeof b.source.name!=='string'||!b.source.name||b.source.name.length>220||
  !object(b.embedding)||Object.keys(b.embedding).some(k=>!['source','model','dimension','metric'].includes(k)))err('F09B7_INVALID_SCOPE',403);
 try{canonicalEmbedding(b.embedding);}catch{err('F09B7_INVALID_EMBEDDING',400);}
 if(!allowedSources.has(b.embedding.source))err('F09B7_MANAGED_EMBEDDING_REQUIRED',403);
 const header=k=>req?.get?.(k)??req?.headers?.[k.toLowerCase()]??req?.headers?.[k];
 if(header('x-vecthare-f09b7-preview')!=='1'||(header('sec-fetch-site')&&!['same-origin','none'].includes(header('sec-fetch-site'))))err('F09B7_SAME_ORIGIN_REQUIRED',403);
 const origin=header('origin'),host=header('host');
 if(origin&&(!host||![`http://${host}`,`https://${host}`].includes(origin)))err('F09B7_ORIGIN_MISMATCH',403);
 if(!req?.s03?.userScopeId||!req?.s03?.vectorsPath||!req?.user?.directories)err('F09B7_HOST_UNVERIFIED',403);
 return b;
}
/** Entire saved book must validate, including entries disabled from activation. */
export function parseF09b7Topology(raw,sourceId){
 let data;try{data=JSON.parse(raw.toString('utf8'));}catch{err('F09B7_BOOK_INVALID');}
 if(!object(data)||!object(data.entries)||Object.keys(data.entries).length>80)err('F09B7_BOOK_UNSUPPORTED');
 const entries=[],seen=new Set();
 for(const item of Object.values(data.entries)){
  if(!object(item)||!Number.isSafeInteger(item.uid)||item.uid<0||
     typeof item.content!=='string'||item.content.length>64000||
     (item.disable!==undefined&&typeof item.disable!=='boolean')||
     (item.constant!==undefined&&typeof item.constant!=='boolean')||
     (item.key!==undefined&&(!Array.isArray(item.key)||item.key.length>30||item.key.some(k=>typeof k!=='string'||k.length>200)))||
     (item.keysecondary!==undefined&&(!Array.isArray(item.keysecondary)||item.keysecondary.length>30||item.keysecondary.some(k=>typeof k!=='string'||k.length>200)))||
     (item.selective!==undefined&&typeof item.selective!=='boolean')||
     (item.selectiveLogic!==undefined&&(!Number.isSafeInteger(item.selectiveLogic)||item.selectiveLogic<0||item.selectiveLogic>3)))err('F09B7_ENTRY_UNSUPPORTED');
  const uid=String(item.uid);if(seen.has(uid))err('F09B7_DUPLICATE_UID');seen.add(uid);
  const links=item.vecthareLinks??[];
  if(!Array.isArray(links)||links.length>8||links.some(id=>!Number.isSafeInteger(id)||id<0)||new Set(links).size!==links.length||links.includes(item.uid))err('F09B7_LINKS_UNSUPPORTED');
  const state=item.disable===true?'DISABLED_SOURCE':!item.content.trim()?'EMPTY_SOURCE':'ELIGIBLE_SAVED_ENTRY';
  entries.push({uid,recordId:derivedUuid(sourceId,'lorebook-entry',uid),text:item.content,
   fingerprint:contentFingerprint(item.content),state,links:links.map(String),
   conditions:{evaluated:false,mode:'NOT_EVALUATED',constant:item.constant===true,
    primaryKeywordCount:(item.key??[]).length,secondaryKeywordCount:(item.keysecondary??[]).length,
    selective:item.selective===true,selectiveLogic:item.selectiveLogic??null}});
 }
 return entries;
}
export async function executeF09b7(req,{readSource=readOwnedBytes,readScoped=executeF02ScopedRead,backendPool,createVectra}={}){
 const b=validateF09b7Request(req),first=await readSource(req,b.source);
 if(!first?.sourceId||!/^[a-f0-9]{64}$/.test(first.fileHash||''))err('F09B7_SOURCE_UNVERIFIED',403);
 const entries=parseF09b7Topology(first.bytes,first.sourceId);
 const base={backend:b.backend,configId:b.configId,source:b.source,embedding:b.embedding};
 const observed=[];
 for(const entry of entries){
  const record=await readScoped(req,{...base,recordId:entry.recordId},'get',{backendPool,createVectra});
  if(record!==null&&(!object(record)||record.recordId!==entry.recordId||
    !Number.isSafeInteger(record.revision)||record.revision<1||typeof record.text!=='string'))err('F09B7_READBACK_UNVERIFIED');
  observed.push(record);
 }
 const second=await readSource(req,b.source);
 if(first.sourceId!==second.sourceId||first.fileHash!==second.fileHash)err('F09B7_SOURCE_CHANGED');
 const available=new Map(entries.map(e=>[e.uid,e]));
 const results=entries.map((entry,index)=>{
  const record=observed[index];
  const lifecycle=entry.state!=='ELIGIBLE_SAVED_ENTRY'?entry.state:
   record===null?'MISSING_VECTOR':contentFingerprint(record.text)!==entry.fingerprint?'STALE_VECTOR':'IN_SYNC';
  const links=entry.links.map(uid=>({targetRecordId:available.get(uid)?.recordId??null,
   state:!available.has(uid)?'UNRESOLVED_TARGET':available.get(uid).state!=='ELIGIBLE_SAVED_ENTRY'?'TARGET_DISABLED_OR_EMPTY':'SOURCE_LINK_ONLY'}));
  return {recordId:entry.recordId,lifecycle,storedVectorPresent:record!==null,
   condition:entry.conditions,links,linkedTargetCount:links.length};
 });
 return {status:'READ_ONLY_LINK_CONDITION_LIFECYCLE_PREVIEW',sourceVerified:true,
  sourceRevisionFingerprint:first.fileHash,recordIdentity:'F09B6_STABLE_LORE_UID',
  entries:results,counts:{eligible:results.filter(x=>['IN_SYNC','MISSING_VECTOR','STALE_VECTOR'].includes(x.lifecycle)).length,
   disabled:results.filter(x=>x.lifecycle==='DISABLED_SOURCE').length,
   empty:results.filter(x=>x.lifecycle==='EMPTY_SOURCE').length,
   unresolvedLinks:results.reduce((n,x)=>n+x.links.filter(l=>l.state!=='SOURCE_LINK_ONLY').length,0)},
  conditionEvaluation:'NOT_EVALUATED',linkActivation:'NOT_PERFORMED',
  completeInventory:false,deletionAuthority:false,automaticMutationsEnabled:false,productionWritesEnabled:false};
}
export function registerF09b7Routes(router,deps={}){
 router.post('/v2/workflows/link-condition-preview',async(req,res)=>{
  try{return res.status(200).json({success:true,experimental:true,...await executeF09b7(req,deps)});}
  catch(e){return res.status(Number.isInteger(e?.status)&&e.status>=400&&e.status<=599?e.status:409).json({success:false,experimental:true,code:safeCode(e),productionWritesEnabled:false,retryable:false});}
 });
}

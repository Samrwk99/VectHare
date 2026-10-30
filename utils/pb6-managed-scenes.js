/** P-B.6: saved-chat-backed scene annotations (NOT a vector scene chunk).
 * SillyTavern owns the write; plugin independently reads the saved file.
 */
import {guardedVectorFetch} from './e02-vector-request-gateway.js';
const ROOT='/api/plugins/similharity/v2/pb6/scenes/read';
const HASH=/^[a-f0-9]{64}$/i;
const object=x=>x&&typeof x==='object'&&!Array.isArray(x);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function validateManagedScenesResponse(response){
 if(response?.success!==true||response.readOnly!==true||response.sourceAuthoritative!==true||
  response.storage!=='SAVED_CHAT_METADATA'||response.vectorSceneRecordsVerified!==false||
  !HASH.test(response.fileFingerprint??'')||!HASH.test(response.sceneRevision??'')||
  !Array.isArray(response.scenes)||response.scenes.length>256||
  !Number.isSafeInteger(response.messageCount)||response.messageCount<0||response.messageCount>100000)
  throw Error('PB6_SCENE_READBACK_UNVERIFIED');
 return response;
}
export async function readManagedScenes({source,headers={},fetchImpl=globalThis.fetch}){
 if(!source||!['chat','group-chat'].includes(source.kind))throw Error('PB6_SCENE_SOURCE_INVALID');
 const response=await guardedVectorFetch(ROOT,{method:'POST',credentials:'same-origin',cache:'no-store',
  headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({source})},fetchImpl);
 let data;try{data=await response.json();}catch{throw Error('PB6_SCENE_RESPONSE_INVALID');}
 if(!response.ok||!data?.success)throw Error(data?.code??'PB6_SCENE_READ_REFUSED');
 return validateManagedScenesResponse(data);
}
export function sceneLocator(message){
 if(!message||!['string','number'].includes(typeof message.send_date)||
  typeof message.name!=='string'||!message.name.trim()||typeof message.is_user!=='boolean')
  throw Error('PB6_SCENE_HOST_MESSAGE_IDENTITY_INVALID');
 return {sendDate:message.send_date,name:message.name,isUser:message.is_user};
}
/** For a newly-created/renamed/deleted scene, save host chat metadata and
 * immediately verify against the owner-attested readback. No vector mutation.
 * A rejected/throwing host save is *uncertain*: do not claim clean rollback.
 */
export async function commitManagedSceneEdit({context,chatMetadata,source,getCurrentSource,read,
 expected,scenes,confirm}={}){
 if(!context||typeof context.saveChat!=='function'||!object(chatMetadata)||
  !Array.isArray(context.chat)||!['chat','group-chat'].includes(source?.kind)||
  !Array.isArray(scenes)||scenes.length>256||!expected||!HASH.test(expected.fileFingerprint??''))
  throw Error('PB6_SCENE_EDIT_INVALID');
 validateHostSceneDraft(scenes,context.chat);
 const sourceKey=JSON.stringify(source);
 const stillSelected=async()=>{if(JSON.stringify(await getCurrentSource())!==sourceKey)
   throw Error('PB6_SCENE_SOURCE_CHANGED');};
 await stillSelected();
 const current=await read(source);
 if(current.fileFingerprint!==expected.fileFingerprint||current.sceneRevision!==expected.sceneRevision||
  !same(chatMetadata.vecthareManagedScenes??[],expected.scenes))throw Error('PB6_SCENE_STALE_REVISION');
 if(!await confirm())return {status:'CANCELLED',saved:false};
 await stillSelected();
 const preSave=await read(source);
 if(preSave.fileFingerprint!==expected.fileFingerprint||preSave.sceneRevision!==expected.sceneRevision||
  !same(chatMetadata.vecthareManagedScenes??[],expected.scenes))throw Error('PB6_SCENE_STALE_REVISION');
 // The host is authoritative for file persistence; touching only our namespaced
 // field preserves other extensions' metadata. No API can promise atomicity
 // between a running host save and concurrent external edits; readback catches
 // mismatches and never reports false success.
 chatMetadata.vecthareManagedScenes=scenes;
 try{
  const result=await context.saveChat();if(result===false)throw Error('PB6_HOST_SAVE_REFUSED');
 }catch(e){const err=new Error(`PB6_HOST_SAVE_OUTCOME_UNCERTAIN: ${e?.message||e}`);
  err.code='PB6_HOST_SAVE_OUTCOME_UNCERTAIN';err.sourceSaveUncertain=true;throw err;}
 try{
  await stillSelected();const after=await read(source);
  if(after.fileFingerprint===expected.fileFingerprint||!same(after.scenes,scenes)||
   after.sceneRevision===expected.sceneRevision)throw Error('PB6_SCENE_POSTSAVE_NOT_ATTESTED');
  return {status:'VERIFIED_SAVED_METADATA',saved:true,readback:after};
 }catch(e){const err=new Error(`PB6_SCENE_SAVED_READBACK_UNVERIFIED: ${e?.message||e}`);
  err.code='PB6_SCENE_SAVED_READBACK_UNVERIFIED';err.saved=true;throw err;}
}
/** Reject ambiguous or overlapping host-chat boundaries before touching host metadata. */
export function validateHostSceneDraft(scenes,chat){
 if(!Array.isArray(scenes)||scenes.length>256||!Array.isArray(chat))throw Error('PB6_SCENE_DRAFT_INVALID');
 const key=x=>JSON.stringify([String(x.sendDate),x.name,x.isUser]);
 const positions=new Map(),duplicates=new Set();
 for(let i=0;i<chat.length;i++){
  let loc;try{loc=sceneLocator(chat[i]);}catch{continue;}
  const k=key(loc);if(positions.has(k))duplicates.add(k);else positions.set(k,i);
 }
 const ids=new Set(),ranges=[];
 for(const s of scenes){
  if(!object(s)||Object.keys(s).sort().join('|')!==['end','id','start','title'].sort().join('|')||
   typeof s.id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s.id)||ids.has(s.id)||
   typeof s.title!=='string'||!s.title.trim()||s.title.length>160)throw Error('PB6_SCENE_DRAFT_INVALID');
  ids.add(s.id);
  const pair=[s.start,s.end].map(v=>{
   if(!object(v)||Object.keys(v).sort().join('|')!==['sendDate','name','isUser'].sort().join('|')||
    typeof v.name!=='string'||!['string','number'].includes(typeof v.sendDate)||typeof v.isUser!=='boolean')
    throw Error('PB6_SCENE_BOUNDARY_INVALID');
   const k=key(v);if(duplicates.has(k)||!positions.has(k))throw Error('PB6_SCENE_BOUNDARY_AMBIGUOUS');
   return positions.get(k);
  });
  if(pair[1]<=pair[0])throw Error('PB6_SCENE_RANGE_INVALID');ranges.push(pair);
 }
 ranges.sort((a,b)=>a[0]-b[0]);
 for(let i=1;i<ranges.length;i++)if(ranges[i][0]<=ranges[i-1][1])throw Error('PB6_SCENE_OVERLAP');
 return scenes;
}

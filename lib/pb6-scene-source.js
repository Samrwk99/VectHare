/** P-B.6: owner-attested readback of scene annotations saved by SillyTavern.
 * This is NOT an arbitrary vector metadata patch and NEVER dispatches writes.
 */
import {createHash} from 'node:crypto';
import {readOwnedBytes} from './f09b6-saved-content.js';
const isObject=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const fail=(code,status=409)=>{throw Object.assign(new Error(code),{code,status});};
const sha=v=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
const ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const locatorKey=v=>JSON.stringify([String(v.sendDate),v.name,v.isUser]);
export function validatePb6Scenes(scenes,messages){
 if(!Array.isArray(scenes)||scenes.length>256)fail('PB6_SCENE_SCHEMA_INVALID');
 const keys=new Map(),duplicateKeys=new Set();
 for(let i=0;i<messages.length;i++){
  const msg=messages[i];if(!isObject(msg))fail('PB6_CHAT_MESSAGE_INVALID');
  if(typeof msg.name!=='string'||typeof msg.is_user!=='boolean'||
    !['string','number'].includes(typeof msg.send_date))continue;
  const key=locatorKey({sendDate:msg.send_date,name:msg.name,isUser:msg.is_user});
  if(keys.has(key))duplicateKeys.add(key);else keys.set(key,i);
 }
 const usedIds=new Set(),ranges=[];
 for(const scene of scenes){
  if(!isObject(scene)||Object.keys(scene).sort().join('|')!==['end','id','start','title'].sort().join('|')||
   typeof scene.id!=='string'||!ID.test(scene.id)||usedIds.has(scene.id)||
   typeof scene.title!=='string'||scene.title.length>160||!scene.title.trim())fail('PB6_SCENE_SCHEMA_INVALID');
  usedIds.add(scene.id);
  const found=[];
  for(const loc of [scene.start,scene.end]){
   if(!isObject(loc)||Object.keys(loc).sort().join('|')!==['sendDate','name','isUser'].sort().join('|')||
     !['string','number'].includes(typeof loc.sendDate)||typeof loc.name!=='string'||
     !loc.name||loc.name.length>200||typeof loc.isUser!=='boolean')fail('PB6_SCENE_BOUNDARY_INVALID');
   const key=locatorKey(loc);
   if(duplicateKeys.has(key)||!keys.has(key))fail('PB6_SCENE_BOUNDARY_UNVERIFIED');
   found.push(keys.get(key));
  }
  if(found[1]<=found[0])fail('PB6_SCENE_BOUNDARY_ORDER_INVALID');
  ranges.push([found[0],found[1]]);
 }
 ranges.sort((a,b)=>a[0]-b[0]);
 for(let i=1;i<ranges.length;i++)if(ranges[i][0]<=ranges[i-1][1])fail('PB6_SCENE_OVERLAP_INVALID');
 return scenes;
}
export function parsePb6SceneSnapshot(bytes){
 if(!Buffer.isBuffer(bytes)||bytes.length>12*1024*1024)fail('PB6_SCENE_FILE_UNVERIFIED');
 const lines=bytes.toString('utf8').split(/\r?\n/).filter(Boolean);
 if(!lines.length||lines.length>100001)fail('PB6_SCENE_FILE_INVALID');
 let header,messages;
 try{header=JSON.parse(lines[0]);messages=lines.slice(1).map(x=>JSON.parse(x));}
 catch{fail('PB6_SCENE_FILE_INVALID');}
 if(!isObject(header))fail('PB6_SCENE_HEADER_INVALID');
 if(header.chat_metadata!==undefined&&!isObject(header.chat_metadata))fail('PB6_SCENE_HEADER_INVALID');
 const scenes=header.chat_metadata?.vecthareManagedScenes??[];
 validatePb6Scenes(scenes,messages);
 return {scenes,sceneRevision:sha(scenes),messageCount:messages.length};
}
export async function readPb6SavedScenes(req,{read=readOwnedBytes}={}){
 const b=req?.body;
 if(!isObject(b)||Object.keys(b).join('|')!=='source'||!isObject(b.source)||
    !['chat','group-chat'].includes(b.source.kind)||
    Object.keys(b.source).sort().join('|')!==
       (b.source.kind==='chat'?['kind','avatar','chatFile']:['kind','groupId','chatFile']).sort().join('|')||
    Object.values(b.source).some(x=>typeof x!=='string'||!x||x.length>220))fail('PB6_SOURCE_SELECTOR_INVALID',400);
 if(!req?.s03?.userScopeId)fail('PB6_AUTH_REQUIRED',403);
 const {bytes,fileHash}=await read(req,b.source);
 const parsed=parsePb6SceneSnapshot(bytes);
 return {readOnly:true,sourceAuthoritative:true,storage:'SAVED_CHAT_METADATA',fileFingerprint:fileHash,
  sceneRevision:parsed.sceneRevision,scenes:parsed.scenes,messageCount:parsed.messageCount,
  vectorSceneRecordsVerified:false};
}
export function registerPb6SceneRoutes(router,deps={}){
 router.post('/v2/pb6/scenes/read',async(req,res)=>{
  try{res.json({success:true,...await readPb6SavedScenes(req,deps)});}
  catch(e){res.status(Number.isInteger(e.status)?e.status:409).json({success:false,
    code:/^PB6_[A-Z0-9_]+$/.test(e.code??'')?e.code:'PB6_SCENE_READ_UNVERIFIED'});}
 });
}

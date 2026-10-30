/** F09b continuation: server-attested, read-only chat-to-v2 synchronization planner.
 * No browser-supplied message text, record IDs, owner IDs or physical names.
 * This NEVER commits mutations or claims complete inventory/deletion authority.
 */
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {attestHostSource,inspectF01OwnedFile} from './f01-host-sources.js';
import {executeF02ScopedRead} from './f02-public-reads.js';
import {canonicalEmbedding,contentFingerprint} from './s02-identity.js';

const BACKENDS=new Set(['qdrant','lancedb','vectra','milvus']);
const MAX_CHAT_BYTES=12*1024*1024;
const MAX_MESSAGES=80; // bounded per-request F02 get readback; never partial success
const object=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
const digest=x=>createHash('sha256').update(x).digest('hex');
export class F09bSyncError extends Error {
 constructor(code,status=409){super(code);this.code=code;this.status=status;}
}
export function validateF09bSyncBody(body){
 if(!object(body)||Object.keys(body).some(k=>!['backend','source','embedding','configId'].includes(k))||
  !BACKENDS.has(body.backend)||!object(body.source)||!object(body.embedding)||
  !['chat','group-chat'].includes(body.source.kind)||
  (body.configId!==undefined&&!['default','local'].includes(body.configId)))
  throw new F09bSyncError('F09B_SYNC_INVALID_REQUEST',400);
 try{canonicalEmbedding(body.embedding);}catch{throw new F09bSyncError('F09B_SYNC_INVALID_EMBEDDING',400);}
 return body;
}
function deterministicRecordUuid(sourceId,hostMessageKey){
 const bytes=Buffer.from(digest(JSON.stringify(['vecthare-saved-chat-v2',sourceId,hostMessageKey])).slice(0,32),'hex');
 bytes[6]=(bytes[6]&15)|0x80;bytes[8]=(bytes[8]&63)|0x80;
 const h=bytes.toString('hex');
 return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
/** Single owned file is read through its open descriptor, guarded by pre/post
 * inode, path, stat and size checks. No client-provided path is ever opened. */
export async function readAttestedChatSnapshot(req,source,{maxMessages=MAX_MESSAGES}={}){
 // Only trusted in-process M1 callers may opt into long source snapshots;
 // the legacy F09b route retains its original 80-message bound.
 if(!Number.isSafeInteger(maxMessages)||maxMessages<1||maxMessages>100000)
  throw new F09bSyncError('F09B_SYNC_CHAT_LIMIT',400);
 const attested=await attestHostSource(req,source);
 if(!attested.hostSourceOwnerVerified||!['chat','group-chat'].includes(attested.kind))
  throw new F09bSyncError('F09B_SYNC_SOURCE_UNVERIFIED',403);
 const observed=await inspectF01OwnedFile(req,source);
 const before=await fs.lstat(observed.filepath);
 if(!before.isFile()||before.isSymbolicLink()||before.nlink>1||before.size>MAX_CHAT_BYTES)
  throw new F09bSyncError('F09B_SYNC_FILE_UNSAFE',409);
 let bytes,handle;
 try{
  handle=await fs.open(observed.filepath,'r');
  const opened=await handle.stat();
  if(!opened.isFile()||opened.dev!==before.dev||opened.ino!==before.ino||opened.size!==before.size||opened.size>MAX_CHAT_BYTES)
   throw new F09bSyncError('F09B_SYNC_SOURCE_RACE');
  bytes=await handle.readFile();
  const closed=await handle.stat();
  if(closed.size!==opened.size||closed.mtimeMs!==opened.mtimeMs||closed.ino!==opened.ino)
   throw new F09bSyncError('F09B_SYNC_SOURCE_RACE');
 }finally{await handle?.close();}
 const after=await fs.lstat(observed.filepath);
 if(after.dev!==before.dev||after.ino!==before.ino||after.size!==before.size||after.mtimeMs!==before.mtimeMs||
    after.isSymbolicLink()||after.nlink>1||bytes.length!==before.size)
  throw new F09bSyncError('F09B_SYNC_SOURCE_RACE');
 const raw=bytes.toString('utf8');
 const lines=raw.split(/\r?\n/).filter(Boolean);
 if(lines.length<1||lines.length-1>maxMessages)throw new F09bSyncError('F09B_SYNC_CHAT_LIMIT');
 const messages=[],seenKeys=new Set();
 for(let index=1;index<lines.length;index++){
  let item;
  try{item=JSON.parse(lines[index]);}catch{throw new F09bSyncError('F09B_SYNC_MESSAGE_INVALID');}
  if(!object(item)||typeof item.mes!=='string')throw new F09bSyncError('F09B_SYNC_MESSAGE_INVALID');
  if(!item.mes.trim()||item.is_system===true||item.extra?.is_system===true)continue;
  if(item.mes.length>64000)throw new F09bSyncError('F09B_SYNC_MESSAGE_TOO_LARGE');
  // Unlike positional hashes, a unique, host-saved timestamp/speaker key
  // survives insertion/removal of unrelated messages and ordinary text edits.
  // Missing/duplicate keys are ambiguous: never fabricate stable IDs.
  const date=item.send_date;
  if((typeof date!=='string'&&typeof date!=='number')||!String(date).trim()||
     String(date).length>120||typeof item.name!=='string'||!item.name.trim()||item.name.length>200||
     typeof item.is_user!=='boolean')throw new F09bSyncError('F09B_SYNC_STABLE_KEY_MISSING');
  const key=JSON.stringify([String(date),item.name,item.is_user]);
  if(seenKeys.has(key))throw new F09bSyncError('F09B_SYNC_STABLE_KEY_COLLISION');
  seenKeys.add(key);
  messages.push({recordId:deterministicRecordUuid(attested.sourceId,key),
   contentHash:contentFingerprint(item.mes),text:item.mes,
   // P-B.5: source-attested exact message locator for the SillyTavern editor.
   // Never accepted as an M1 mutation selector; browser matches the host chat.
   chatLocator:{sendDate:date,name:item.name,isUser:item.is_user}});
 }
 return {sourceId:attested.sourceId,fileHash:digest(bytes),messages,sourceKind:attested.kind};
}
export function compareF09bSyncMessages(messages,found){
 if(!Array.isArray(messages)||!Array.isArray(found)||messages.length!==found.length)
  throw new F09bSyncError('F09B_SYNC_READBACK_INVALID');
 const changes=[];
 for(let i=0;i<messages.length;i++){
  const expected=messages[i],existing=found[i];
  if(existing===null){changes.push({recordId:expected.recordId,action:'CREATE_PENDING_EMBEDDING',expectedRevision:0});continue;}
  if(!object(existing)||existing.recordId!==expected.recordId||!Number.isSafeInteger(existing.revision)||existing.revision<1||
     typeof existing.text!=='string')throw new F09bSyncError('F09B_SYNC_READBACK_INVALID');
  changes.push({recordId:expected.recordId,action:contentFingerprint(existing.text)===expected.contentHash?'IN_SYNC':'UPDATE_PENDING_EMBEDDING',
   expectedRevision:existing.revision});
 }
 return changes;
}
export function registerF09bSyncRoutes(router,{backendPool,createVectra,readScoped=executeF02ScopedRead,
 readSnapshot=readAttestedChatSnapshot}={}){
 if(!backendPool||typeof readScoped!=='function')throw Error('F09B_SYNC_DEPENDENCIES_REQUIRED');
 router.post('/v2/workflows/chat-sync-plan',async(req,res)=>{
  try{
   const body=validateF09bSyncBody(req.body);
   if(!req?.s03?.userScopeId||!req.s03?.vectorsPath)throw new F09bSyncError('F09B_SYNC_AUTH_REQUIRED',403);
   const first=await readSnapshot(req,body.source);
   // Use ONLY independently F02-authorized get-by-ID: no incomplete list,
   // no hash endpoints and no claims about deleted/unknown records.
   const found=[];
   for(const item of first.messages){
    const readBody={...body,recordId:item.recordId};
    found.push(await readScoped(req,readBody,'get',{backendPool,createVectra}));
   }
   // Empty chats also require a real F02 collection binding/schema check.
   if(!first.messages.length)throw new F09bSyncError('F09B_SYNC_EMPTY_SOURCE_UNPROBED');
   const second=await readSnapshot(req,body.source);
   if(first.sourceId!==second.sourceId||first.fileHash!==second.fileHash||
      first.messages.length!==second.messages.length)
    throw new F09bSyncError('F09B_SYNC_SOURCE_CHANGED');
   const changes=compareF09bSyncMessages(first.messages,found);
   return res.json({success:true,status:'READ_ONLY_SYNC_PLAN',sourceVerified:true,
    sourceRevisionFingerprint:first.fileHash,recordIdentity:'V2_STABLE_HOST_MESSAGE_UUID',
    actions:changes,counts:{create:changes.filter(x=>x.action==='CREATE_PENDING_EMBEDDING').length,
     update:changes.filter(x=>x.action==='UPDATE_PENDING_EMBEDDING').length,
     inSync:changes.filter(x=>x.action==='IN_SYNC').length},
    sourceMessagesChecked:changes.length,completeInventory:false,deletionsPlanned:false,
    productionWritesEnabled:false,automaticMutationsEnabled:false,
    requires:['verified-embedding-generation','authorized-write-contract','backend-activation']});
  }catch(error){
   const status=Number.isInteger(error?.status)&&error.status>=400&&error.status<=599?error.status:409;
   const code=typeof error?.code==='string'&&/^[A-Z0-9_]{2,90}$/.test(error.code)?error.code:'F09B_SYNC_REFUSED';
   return res.status(status).json({success:false,code,productionWritesEnabled:false,automaticMutationsEnabled:false});
  }
 });
}

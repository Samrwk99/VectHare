/** F09b.6 — strictly server-read saved summary / lorebook source snapshots.
 * No browser text, IDs, vectors, paths or owner selectors. No auto inference of
 * missing summaries, legacy orphan cleanup or full lorebook inventory claim.
 */
import fs from 'node:fs/promises';
import {constants as C} from 'node:fs';
import {createHash} from 'node:crypto';
import {attestHostSource,inspectF01OwnedFile} from './f01-host-sources.js';
import {contentFingerprint} from './s02-identity.js';

const fail=(code,status=409)=>{throw Object.assign(new Error(code),{code,status});};
const sha=raw=>createHash('sha256').update(raw).digest('hex');
const obj=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
export function derivedUuid(sourceId,kind,key){
 const b=Buffer.from(sha(JSON.stringify(['F09B6-SOURCE-RECORD-V1',sourceId,kind,key])).slice(0,32),'hex');
 b[6]=(b[6]&15)|0x80;b[8]=(b[8]&63)|0x80;
 const h=b.toString('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
/** Verify the same inode, permissions, size and file identity before/after. */
export async function readOwnedBytes(req,source,{attest=attestHostSource,inspect=inspectF01OwnedFile}={}){
 const evidence=await attest(req,source);
 if(evidence?.hostSourceOwnerVerified!==true||evidence.status!=='HOST_FILE_OWNED')fail('F09B6_SOURCE_UNVERIFIED',403);
 const observed=await inspect(req,source);
 const before=await fs.lstat(observed.filepath);
 if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>(source.kind==='lorebook'?4:12)*1024*1024)fail('F09B6_UNSAFE_SOURCE');
 const fd=await fs.open(observed.filepath,C.O_RDONLY|(C.O_NOFOLLOW??0));let bytes;
 try{
  const opened=await fd.stat();
  if(!opened.isFile()||opened.ino!==before.ino||opened.dev!==before.dev||opened.size!==before.size||opened.mtimeMs!==before.mtimeMs)fail('F09B6_SOURCE_RACE');
  bytes=await fd.readFile();
  const afterFd=await fd.stat();
  if(afterFd.ino!==opened.ino||afterFd.dev!==opened.dev||afterFd.size!==opened.size||afterFd.mtimeMs!==opened.mtimeMs)fail('F09B6_SOURCE_RACE');
 }finally{await fd.close();}
 const after=await fs.lstat(observed.filepath);
 if(after.isSymbolicLink()||after.nlink!==1||after.ino!==before.ino||after.dev!==before.dev||after.size!==before.size||after.mtimeMs!==before.mtimeMs||bytes.length!==before.size)fail('F09B6_SOURCE_RACE');
 return {sourceId:evidence.sourceId,bytes,fileHash:sha(bytes)};
}
/** Summary must be the actual saved chat_metadata.summary string. This stage
 * intentionally does not pretend to generate a summarization model result. */
export function parseSummarySnapshot(raw,sourceId){
 const lines=raw.toString('utf8').split(/\r?\n/,2);
 let header;try{header=JSON.parse(lines[0]);}catch{fail('F09B6_CHAT_HEADER_INVALID');}
 if(!obj(header)||!obj(header.chat_metadata))fail('F09B6_SAVED_SUMMARY_UNAVAILABLE');
 const summary=header.chat_metadata.summary;
 if(typeof summary!=='string'||!summary.trim())fail('F09B6_SAVED_SUMMARY_UNAVAILABLE');
 if(summary.length>64000)fail('F09B6_SUMMARY_TOO_LARGE');
 return [{recordId:derivedUuid(sourceId,'saved-summary','chat_metadata.summary'),text:summary,
  contentHash:contentFingerprint(summary),kind:'saved-summary',sourceKey:'chat_metadata.summary'}];
}
export function parseLorebookSnapshot(raw,sourceId,{maxEntries=80}={}){
 if(!Number.isSafeInteger(maxEntries)||maxEntries<1||maxEntries>10000)fail('F09B6_LOREBOOK_MAX_ENTRIES_INVALID',400);
 let book;try{book=JSON.parse(raw.toString('utf8'));}catch{fail('F09B6_LOREBOOK_INVALID');}
 if(!obj(book)||!obj(book.entries)||Object.keys(book.entries).length>maxEntries)fail('F09B6_LOREBOOK_FORMAT_UNSUPPORTED');
 const entries=Object.values(book.entries),seen=new Set(),items=[];
 for(const entry of entries){
  if(!obj(entry)||!Number.isSafeInteger(entry.uid)||entry.uid<0||
     typeof entry.content!=='string'||entry.content.length>64000)fail('F09B6_LORE_ENTRY_INVALID');
  const key=String(entry.uid);
  if(seen.has(key))fail('F09B6_DUPLICATE_LORE_UID');seen.add(key);
  // Disabled entries are not automatically deleted or classified as orphans.
  if(entry.disable===true||!entry.content.trim())continue;
  items.push({recordId:derivedUuid(sourceId,'lorebook-entry',key),text:entry.content,
   contentHash:contentFingerprint(entry.content),kind:'lorebook-entry',sourceKey:key});
 }
 if(!items.length)fail('F09B6_SOURCE_EMPTY');
 return items;
}
export async function readF09b6Snapshot(req,source,options={}){
 if(!obj(source)||!['chat','group-chat','lorebook'].includes(source.kind))fail('F09B6_SOURCE_KIND_INVALID',400);
 const {sourceId,bytes,fileHash}=await readOwnedBytes(req,source,options);
 const items=source.kind==='lorebook'?parseLorebookSnapshot(bytes,sourceId):parseSummarySnapshot(bytes,sourceId);
 return {sourceId,fileHash,items,kind:source.kind==='lorebook'?'lorebook-entry':'saved-summary'};
}

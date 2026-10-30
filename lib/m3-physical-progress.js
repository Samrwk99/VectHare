/** M3v13: append-only physical-stage checkpoints.
 * A checkpoint means ONE Qdrant chunk was independently read back. It is
 * forensic progress evidence, not permission to replay an uncertain write.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {M3Store} from './m3-collections.js';
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY=/^[0-9a-f]{64}$/;
const NAME=/^vh2_[a-f0-9]{48}$/;
const fail=code=>Object.assign(new Error(code),{code,status:409});
async function privateDir(dir){const st=await fs.lstat(dir);
 if(!st.isDirectory()||st.isSymbolicLink()||(process.platform!=='win32'&&(st.mode&0o077)))throw fail('M3_PHYSICAL_PROGRESS_DIRECTORY_UNTRUSTED');}
async function syncDir(dir){if(process.platform==='win32')return;const h=await fs.open(dir,'r');try{await h.sync();}finally{await h.close();}}
export class M3PhysicalProgress{
 constructor(ctx,operationId){if(!ctx?.userScopeId||!path.isAbsolute(ctx.vectorsPath??'')||!UUID.test(operationId??''))throw fail('M3_PHYSICAL_PROGRESS_SCOPE_INVALID');
  this.ctx=ctx;this.operationId=operationId;
  this.root=path.join(ctx.vectorsPath,'.similharity','m3-physical-progress',operationId);}
 async setup(){for(const dir of [this.ctx.vectorsPath,path.join(this.ctx.vectorsPath,'.similharity'),path.dirname(this.root),this.root]){
  await fs.mkdir(dir,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});await privateDir(dir);}}
 async list(){await this.setup();const names=(await fs.readdir(this.root)).sort();
  if(names.length>625||names.some((name,i)=>name!==String(i).padStart(5,'0')+'.json'))throw fail('M3_PHYSICAL_PROGRESS_SEQUENCE_INVALID');
  const entries=[];let previous='GENESIS';
  for(let i=0;i<names.length;i++){
   const file=path.join(this.root,names[i]),st=await fs.lstat(file);
   if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>4096||(process.platform!=='win32'&&(st.mode&0o077)))throw fail('M3_PHYSICAL_PROGRESS_ENTRY_UNTRUSTED');
   let doc;try{doc=JSON.parse(await fs.readFile(file,'utf8'));}catch{throw fail('M3_PHYSICAL_PROGRESS_ENTRY_CORRUPT');}
   const {seal,...body}=doc;
   if(seal!==digest(body)||body.schemaVersion!==1||body.owner!==this.ctx.userScopeId||body.operationId!==this.operationId||
      body.index!==i||body.previous!==previous||!NAME.test(body.physicalName??'')||!UUID.test(body.targetBackupId??'')||
      !KEY.test(body.manifestDigest??'')||!KEY.test(body.chunkDigest??'')||!Number.isSafeInteger(body.recordCount)||body.recordCount<1||body.recordCount>32||
      !Number.isSafeInteger(body.verifiedAt)||body.verifiedAt<0)throw fail('M3_PHYSICAL_PROGRESS_ENTRY_CORRUPT');
   if(entries.length&&(body.physicalName!==entries[0].physicalName||body.targetBackupId!==entries[0].targetBackupId||
      body.manifestDigest!==entries[0].manifestDigest))throw fail('M3_PHYSICAL_PROGRESS_BINDING_CHANGED');
   entries.push(body);previous=digest(body);
  }
  return entries;
 }
 async recordVerified({index,physicalName,targetBackupId,manifestDigest,chunkDigest,recordCount}={}){
  if(!Number.isSafeInteger(index)||index<0||index>=625||!NAME.test(physicalName??'')||!UUID.test(targetBackupId??'')||
    !KEY.test(manifestDigest??'')||!KEY.test(chunkDigest??'')||!Number.isInteger(recordCount)||recordCount<1||recordCount>32)throw fail('M3_PHYSICAL_PROGRESS_RECORD_INVALID');
  const ticket=await new M3Store(this.ctx).read('operation',this.operationId);
  if(ticket.owner!==this.ctx.userScopeId||ticket.action!=='rebuild'||ticket.backend!=='qdrant')throw fail('M3_PHYSICAL_PROGRESS_TICKET_INVALID');
  const entries=await this.list();if(index!==entries.length)throw fail('M3_PHYSICAL_PROGRESS_OUT_OF_ORDER');
  if(entries.length&&(entries[0].physicalName!==physicalName||entries[0].targetBackupId!==targetBackupId||
   entries[0].manifestDigest!==manifestDigest))throw fail('M3_PHYSICAL_PROGRESS_BINDING_CHANGED');
  if(entries.reduce((n,e)=>n+e.recordCount,0)+recordCount>ticket.expectedCount)
   throw fail('M3_PHYSICAL_PROGRESS_COUNT_INVALID');
  const body={schemaVersion:1,owner:this.ctx.userScopeId,operationId:this.operationId,index,physicalName,
   targetBackupId,manifestDigest,chunkDigest,recordCount,previous:entries.length?digest(entries.at(-1)):'GENESIS',verifiedAt:Date.now()};
  const file=path.join(this.root,String(index).padStart(5,'0')+'.json');const h=await fs.open(file,'wx',0o600);
  try{await h.writeFile(JSON.stringify({...body,seal:digest(body)})+'\n');await h.sync();}finally{await h.close();}
  await syncDir(this.root);return body;
 }
}
/** Read-only owner-attested progress. Does NOT assert present physical state. */
export async function inspectM3PhysicalProgress(req,operationId,deps={}){
 if(!req?.s03?.userScopeId||!req.user?.directories||!UUID.test(operationId??''))throw fail('M3_PHYSICAL_PROGRESS_AUTH_REQUIRED');
 const store=deps.store?.(req.s03)??new M3Store(req.s03);
 const ticket=await store.read('operation',operationId);
 if(ticket.owner!==req.s03.userScopeId||ticket.action!=='rebuild'||ticket.backend!=='qdrant')throw fail('M3_PHYSICAL_PROGRESS_TICKET_INVALID');
 const entries=await new M3PhysicalProgress(req.s03,operationId).list();
 const total=entries.reduce((n,e)=>n+e.recordCount,0);
 if(total>ticket.expectedCount)throw fail('M3_PHYSICAL_PROGRESS_COUNT_INVALID');
 return {operationId,verifiedChunks:entries.length,verifiedRecordCount:total,expectedRecordCount:ticket.expectedCount,
  physicalName:entries[0]?.physicalName??null,readbackEvidenceOnly:true,
  automaticReplayAuthorized:false,physicalLockReleaseAuthorized:false,
  state:total===ticket.expectedCount&&entries.length?'WRITE_CHUNKS_READBACK_VERIFIED':'PARTIAL_OR_NOT_STARTED',
  warning:'A persisted checkpoint does not authorize restart, automatic replay or physical lock release.'};
}

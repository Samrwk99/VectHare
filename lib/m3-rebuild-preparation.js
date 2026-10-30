/** M3/M2-style durable, bounded pre-embedding worker for large source-scoped
 * rebuilds. This phase has NO database mutation: each verified embedding is
 * an immutable, owner-private checkpoint. A lost response can safely be
 * resumed by inspecting the checkpoint, never by replaying a physical write.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {M3Store} from './m3-collections.js';
import {previewM3ModelRebuild} from './m3-rebuild-preview.js';
import {getEmbeddingProfile,getStagedEmbeddingProfile,generateStagedEmbedding} from './f09b5-embedding-profiles.js';
import {readM1Snapshot,savedRecordIdentity} from './m1-saved-records.js';
import {contentFingerprint} from './s02-identity.js';
import {M2JobStore} from './m2-jobs.js';
const H=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
// Canonical UUID validation is exported from a single local check instead of
// accepting arbitrary path segments as checkpoint folder names.
const ID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const fail=code=>Object.assign(new Error(code),{code,status:409});
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
async function priv(p){const st=await fs.lstat(p);if(!st.isDirectory()||st.isSymbolicLink()||
 (process.platform!=='win32'&&(st.mode&0o077)))throw fail('M3_PREP_DIRECTORY_UNTRUSTED');}
async function flush(p){if(process.platform==='win32')return;const f=await fs.open(p,'r');try{await f.sync();}finally{await f.close();}}
export class M3RebuildPreparationStore{
 constructor(ctx,id){if(!ctx?.userScopeId||!path.isAbsolute(ctx?.vectorsPath??'')||!ID.test(id??''))throw fail('M3_PREP_SCOPE_INVALID');
  this.ctx=ctx;this.id=id;this.parent=path.join(ctx.vectorsPath,'.similharity','m3-rebuild-preparation');
  this.dir=path.join(this.parent,id);}
 async setup(){for(const p of [this.ctx.vectorsPath,path.join(this.ctx.vectorsPath,'.similharity'),this.parent,this.dir]){
  await fs.mkdir(p,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});await priv(p);}}
 file(i){if(!Number.isSafeInteger(i)||i<0||i>=20000)throw fail('M3_PREP_INDEX_INVALID');
  return path.join(this.dir,String(i).padStart(5,'0')+'.json');}
 async read(i){await this.setup();let st;try{st=await fs.lstat(this.file(i));}catch(e){if(e.code==='ENOENT')return null;throw e;}
  if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>1048576||
   (process.platform!=='win32'&&(st.mode&0o077)))throw fail('M3_PREP_CHECKPOINT_UNTRUSTED');
  let doc;try{doc=JSON.parse(await fs.readFile(this.file(i),'utf8'));}catch{throw fail('M3_PREP_CHECKPOINT_CORRUPT');}
  const {seal,...body}=doc;
  if(seal!==H(body)||body.owner!==this.ctx.userScopeId||body.operationId!==this.id||body.index!==i)
   throw fail('M3_PREP_CHECKPOINT_CORRUPT');return body;
 }
 async write(i,body){await this.setup();const data={...body,index:i,owner:this.ctx.userScopeId,operationId:this.id};
  const bytes=JSON.stringify({...data,seal:H(data)})+'\n';if(Buffer.byteLength(bytes)>1048576)throw fail('M3_PREP_CHECKPOINT_LIMIT');
  let fd;try{fd=await fs.open(this.file(i),'wx',0o600);}catch(e){if(e.code==='EEXIST')return this.read(i);throw e;}
  try{await fd.writeFile(bytes);await fd.sync();}finally{await fd.close();}await flush(this.dir);return data;
 }
}
async function sourceState(req,operationId,deps){
 if(!ID.test(operationId??'')||!req?.s03?.userScopeId||!req.user?.directories)throw fail('M3_PREP_AUTH_INVALID');
 const ctx=req.s03,store=deps.store?.(ctx)??new M3Store(ctx),ticket=await store.read('operation',operationId);
 if(ticket.owner!==ctx.userScopeId||ticket.action!=='rebuild'||ticket.backend!=='qdrant'||
  ticket.phase!=='PLANNED_STAGING_ONLY'||ticket.expectedCount<0||ticket.expectedCount>20000||
  !Number.isSafeInteger(ticket.expectedCount)||ticket.createdAt>Date.now()||ticket.expiresAt<Date.now())
  throw fail('M3_PREP_TICKET_INVALID');
 await store.assertUnclaimed(operationId);
 const backup=await store.read('backup',ticket.backupId);
 if(backup.owner!==ctx.userScopeId||backup.logicalKey!==ticket.logicalKey||
  backup.inventory.count!==ticket.expectedCount||backup.inventory.digest!==H(backup.inventory.rows)||
  backup.savedSourceFingerprint!==ticket.sourceFingerprint)throw fail('M3_PREP_BACKUP_CHANGED');
 const staged=await (deps.getStagedProfile??getStagedEmbeddingProfile)(ctx);
 const active=await (deps.getProfile??getEmbeddingProfile)(ctx);
 if(!staged?.configured||H(staged.profile)!==ticket.targetProfileHash||
  !active?.configured||!same(active.profile,backup.embedding))throw fail('M3_PREP_PROFILE_CHANGED');
 const request={...req,body:{backend:'qdrant',source:ticket.source,configId:ticket.configId,backupId:ticket.backupId}};
 const overview=await (deps.preview??previewM3ModelRebuild)(request,deps);
 if(overview.oldLogicalKey!==ticket.logicalKey||overview.newLogicalKey!==ticket.targetLogicalKey||
   overview.sourceFingerprint!==ticket.sourceFingerprint||overview.recordsToReembed!==ticket.expectedCount)
  throw fail('M3_PREP_SOURCE_CHANGED');
 const snapshot=await (deps.readSnapshot??readM1Snapshot)(req,ticket.source);
 if(snapshot.fileHash!==ticket.sourceFingerprint||snapshot.sourceId!==backup.sourceId||!Array.isArray(snapshot.messages))
  throw fail('M3_PREP_SAVED_SOURCE_CHANGED');
 await (deps.jobs?.(ctx)??new M2JobStore(ctx)).assertNoLease(ticket.logicalKey);
 await (deps.jobs?.(ctx)??new M2JobStore(ctx)).assertNoLease(ticket.targetLogicalKey);
 const messages=new Map();
 for(const msg of snapshot.messages){
  const id=savedRecordIdentity(ctx,{scope:backup.scope},msg).recordId;
  if(messages.has(id))throw fail('M3_PREP_DUPLICATE_SOURCE_ID');messages.set(id,msg);
 }
 const rows=[...backup.inventory.rows].sort((a,b)=>String(a.id).localeCompare(String(b.id)));
 if(rows.length!==ticket.expectedCount)throw fail('M3_PREP_COUNT_CHANGED');
 for(const row of rows){const msg=messages.get(row.payload.recordId);
  if(!msg||row.payload.text!==msg.text||msg.contentHash!==contentFingerprint(msg.text)||
   msg.contentHash!==row.payload.textHash)throw fail('M3_PREP_PROVENANCE_CHANGED');
 }
 return {ctx,ticket,backup,profile:staged.profile,rows,messages,snapshot};
}
function verifyCheckpoint(doc,i,row,ticket,profile){
 if(doc.index!==i||doc.recordId!==row.payload.recordId||doc.physicalId!==row.id||
  doc.contentHash!==row.payload.textHash||doc.revision!==row.payload.revision||
  doc.sourceFingerprint!==ticket.sourceFingerprint||doc.profileHash!==ticket.targetProfileHash||
  !Array.isArray(doc.vector)||doc.vector.length!==profile.dimension||
  doc.vector.some(n=>!Number.isFinite(n))||doc.vectorHash!==H(doc.vector))
  throw fail('M3_PREP_CHECKPOINT_STALE');
 return doc.vector;
}
export async function progressM3RebuildPreparation(req,id,deps={}){
 const {ctx,ticket,rows,profile}=await sourceState(req,id,deps);
 const storage=new M3RebuildPreparationStore(ctx,id);let completed=0;
 for(let i=0;i<rows.length;i++){const doc=await storage.read(i);if(doc){verifyCheckpoint(doc,i,rows[i],ticket,profile);completed++;}}
 return {operationId:id,state:completed===rows.length?'READY_TO_STAGE':'PREPARING',
  preparedCount:completed,totalCount:rows.length,remaining:rows.length-completed,
  readyForStageExecute:completed===rows.length,physicalWritesPerformed:false,
  validationStatus:'AWAITING_MANUAL_TEST'};
}
export async function stepM3RebuildPreparation(req,id,deps={}){
 const {ctx,ticket,backup,rows,messages,profile}=await sourceState(req,id,deps);
 const backupSourceId=backup.sourceId;
 const storage=new M3RebuildPreparationStore(ctx,id);let steps=0;
 for(let i=0;i<rows.length;i++){
  let doc=await storage.read(i);if(doc){verifyCheckpoint(doc,i,rows[i],ticket,profile);continue;}
  if(steps>=16)break;
  const row=rows[i],msg=messages.get(row.payload.recordId);
  const embed=deps.embed??(async(text,profile)=>generateStagedEmbedding(ctx,profile,text,{
   hostEmbed:(source,text,model)=>deps.hostEmbed?.(req,source,text,model)}));
  const vector=await embed(msg.text,profile);
  if(!Array.isArray(vector)||vector.length!==profile.dimension||vector.some(n=>!Number.isFinite(n)))
   throw fail('M3_PREP_EMBEDDING_INVALID');
  // Never persist a vector after a source/profile change while embedding ran.
  const again=await (deps.readSnapshot??readM1Snapshot)(req,ticket.source);
  if(again.fileHash!==ticket.sourceFingerprint||again.sourceId!==backupSourceId)
   throw fail('M3_PREP_SOURCE_CHANGED_DURING_EMBED');
  const current=await (deps.getStagedProfile??getStagedEmbeddingProfile)(ctx);
  if(!current?.configured||H(current.profile)!==ticket.targetProfileHash)throw fail('M3_PREP_PROFILE_CHANGED_DURING_EMBED');
  doc=await storage.write(i,{recordId:row.payload.recordId,physicalId:row.id,
   contentHash:row.payload.textHash,revision:row.payload.revision,
   sourceFingerprint:ticket.sourceFingerprint,profileHash:ticket.targetProfileHash,
   vectorHash:H(vector),vector});
  verifyCheckpoint(doc,i,row,ticket,profile);steps++;
 }
 return progressM3RebuildPreparation(req,id,deps);
}
export async function readM3PreparedRebuildVectors(req,id,deps={}){
 const {ctx,ticket,rows,profile}=await sourceState(req,id,deps);
 const storage=new M3RebuildPreparationStore(ctx,id),vectors=[];
 for(let i=0;i<rows.length;i++){
  const doc=await storage.read(i);if(!doc)throw fail('M3_PREP_VECTORS_INCOMPLETE');
  vectors.push(verifyCheckpoint(doc,i,rows[i],ticket,profile));
 }
 return new Map(rows.map((r,i)=>[r.payload.recordId,vectors[i]]));
}

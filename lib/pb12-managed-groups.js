/** P-B.12 durable, source-bound UUID group metadata.
 * Never imports legacy hash groups or mutates physical vectors.
 * Every read and write requires a complete independently verified physical
 * inventory; CAS + private on-disk lock + fsync protect durable revisions.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {inspectPB10PhysicalProof} from './pb10-physical-browse.js';
const KEY=/^[0-9a-f]{64}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const fail=(code,status=409)=>{throw Object.assign(new Error(code),{code,status});};
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const privateDir=async p=>{const s=await fs.lstat(p);if(!s.isDirectory()||s.isSymbolicLink()||(process.platform!=='win32'&&(s.mode&0o077)))fail('PB12_STORAGE_UNTRUSTED',403);};
const syncDir=async p=>{const d=await fs.open(p,'r');try{await d.sync();}finally{await d.close();}};
function checkGroups(groups,{allowOrphans=false,ids=new Set()}={}){
 if(!Array.isArray(groups)||groups.length>256)fail('PB12_GROUPS_INVALID',400);
 const seen=new Set();
 for(const group of groups){
  if(!object(group)||Object.keys(group).some(k=>!['id','members','name','mode','boost'].includes(k))||
   !UUID.test(group.id??'')||seen.has(group.id)||typeof group.name!=='string'||
   !group.name.trim()||group.name.length>120||!Array.isArray(group.members)||group.members.length>20000||
   (group.mode!==undefined&&!['exclusive','inclusive'].includes(group.mode))||
   (group.mode==='inclusive'&&(!Number.isFinite(group.boost)||group.boost<0||group.boost>1))||
   (group.mode!=='inclusive'&&group.boost!==undefined))
    fail('PB12_GROUP_INVALID',400);
  seen.add(group.id);
  const members=new Set();
  for(const m of group.members){
   if(typeof m!=='string'||!UUID.test(m)||members.has(m)||(!allowOrphans&&!ids.has(m)))
    fail('PB12_MEMBER_UNVERIFIED',409);
   members.add(m);
  }
 }
 return groups;
}
async function context(req,deps={}){
 const b=req?.body;
 if(!object(b)||Object.keys(b).some(k=>!['backend','source','configId','expectedRevision','expectedProof','expectedStoredGeneration','operationId','groups','action'].includes(k)))fail('PB12_SELECTOR_INVALID',400);
 if(!req?.s03?.userScopeId||!path.isAbsolute(req.s03.vectorsPath??'')||!req.user?.directories)fail('PB12_HOST_AUTH_REQUIRED',403);
 const {selector,proof,records}=await inspectPB10PhysicalProof({...req,body:{backend:b.backend,source:b.source,...(b.configId!==undefined?{configId:b.configId}:{})}},deps);
 const ctx=req.s03;
 const root=path.join(ctx.vectorsPath,'.similharity','pb12-groups');
 return {ctx,root,selector,proof,records,ids:new Set(records.map(r=>r.recordId)),
  file:path.join(root,proof.logicalKey+'.json'),lock:path.join(root,'.lock-'+proof.logicalKey)};
}
function empty(c){return {schemaVersion:1,owner:c.ctx.userScopeId,logicalKey:c.proof.logicalKey,
 backend:c.selector.backend,generation:c.proof.routingGeneration,revision:0,groups:[],lastOperationId:null};}
async function setup(c){await privateDir(c.ctx.vectorsPath);
 for(const p of [path.dirname(c.root),c.root]){await fs.mkdir(p,{recursive:false,mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});await privateDir(p);}}
async function read(c){await setup(c);
 let raw;try{const st=await fs.lstat(c.file);
  if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>4*1024*1024||
   (process.platform!=='win32'&&(st.mode&0o077)))fail('PB12_STORE_UNTRUSTED',403);
  raw=await fs.readFile(c.file,'utf8');
 }catch(e){if(e.code==='ENOENT')return empty(c);throw e;}
 let parsed;try{parsed=JSON.parse(raw);}catch{fail('PB12_STORE_CORRUPT');}
 const {checksum,...doc}=parsed;
 if(checksum!==hash(doc)||doc.schemaVersion!==1||doc.owner!==c.ctx.userScopeId||
  doc.logicalKey!==c.proof.logicalKey||doc.backend!==c.selector.backend||
  !Number.isSafeInteger(doc.generation)||doc.generation<0||
  !Number.isSafeInteger(doc.revision)||doc.revision<0||
  (doc.lastOperationId!==null&&!UUID.test(doc.lastOperationId??'')))fail('PB12_STORE_CORRUPT');
 checkGroups(doc.groups,{allowOrphans:true});return doc;
}
function proofDigest(c){return hash({owner:c.ctx.userScopeId,logicalKey:c.proof.logicalKey,
 backend:c.selector.backend,generation:c.proof.routingGeneration,
 source:c.proof.sourceFingerprint,registry:c.proof.registryFingerprint,
 inventory:c.proof.inventoryDigest,count:c.records.length});}
function response(c,doc){const valid=c.ids;const orphaned=doc.groups.flatMap(g=>g.members.filter(id=>!valid.has(id)).map(id=>({groupId:g.id,recordId:id})));
 return {sourceAuthoritative:true,verifiedPhysicalInventory:true,backend:c.selector.backend,
  logicalKey:c.proof.logicalKey,generation:c.proof.routingGeneration,
  storedGeneration:doc.generation,revision:doc.revision,proof:proofDigest(c),groups:doc.groups,recordCount:c.records.length,
  availableRecords:c.records.slice(0,200).map(r=>({recordId:r.recordId,textPreview:r.textPreview})),
  orphanedMembers:orphaned,requiresGenerationReview:doc.generation!==c.proof.routingGeneration,
  lastOperationId:doc.lastOperationId,legacyHashGroupsMigrated:false,productionCertified:false};}
export async function readPB12Groups(req,deps={}){const c=await context(req,deps);return response(c,await read(c));}
export async function updatePB12Groups(req,deps={}){
 const b=req.body;
 if(!['save','prune-orphans','review-generation'].includes(b.action)||!UUID.test(b.operationId??'')||
  !Number.isSafeInteger(b.expectedRevision)||b.expectedRevision<0||
  !KEY.test(b.expectedProof??'')||
  (b.action==='save'&&!Array.isArray(b.groups))||
  (b.action!=='save'&&b.groups!==undefined)||
  (b.action==='review-generation'&&(!Number.isSafeInteger(b.expectedStoredGeneration)||b.expectedStoredGeneration<0))||
  (b.action!=='review-generation'&&b.expectedStoredGeneration!==undefined))fail('PB12_INTENT_INVALID',400);
 const c=await context(req,deps);
 if(proofDigest(c)!==b.expectedProof)fail('PB12_PROOF_STALE');
 await setup(c);
 try{await fs.mkdir(c.lock,{mode:0o700});}
 catch(e){if(e.code==='EEXIST')fail('PB12_WRITE_BUSY');throw e;}
 let temp;
 try{
  const before=await read(c);
  if(before.lastOperationId===b.operationId)fail('PB12_OPERATION_ALREADY_COMMITTED');
  if(before.revision!==b.expectedRevision)fail('PB12_REVISION_STALE');
  const reviewing=b.action==='review-generation';
  if(reviewing){
   if(before.generation===c.proof.routingGeneration)fail('PB12_NO_GENERATION_CHANGE',400);
   if(before.generation!==b.expectedStoredGeneration)fail('PB12_GENERATION_STALE');
  }else if(before.generation!==c.proof.routingGeneration)fail('PB12_GENERATION_REVIEW_REQUIRED');
  // Explicit generation review may prune absent UUIDs only; it never maps
  // hashes, creates memberships or force-fetches records across generations.
  const groups=b.action==='save'?b.groups:before.groups.map(g=>({...g,members:g.members.filter(id=>c.ids.has(id))}));
  checkGroups(groups,{ids:c.ids});
  if(!reviewing&&JSON.stringify(before.groups)===JSON.stringify(groups))fail('PB12_NO_CHANGES',400);
  // A second proof obtained *inside* the lock closes the read/lock race.
  const again=await context(req,deps);
  if(proofDigest(again)!==b.expectedProof)fail('PB12_PROOF_STALE');
  const doc={...before,groups,generation:reviewing?c.proof.routingGeneration:before.generation,
   revision:before.revision+1,lastOperationId:b.operationId};
  const data=JSON.stringify({...doc,checksum:hash(doc)})+'\n';
  if(Buffer.byteLength(data)>4*1024*1024)fail('PB12_STORE_LIMIT');
  temp=path.join(c.root,'.tmp-'+randomUUID());
  const fd=await fs.open(temp,'wx',0o600);
  try{await fd.writeFile(data);await fd.sync();}finally{await fd.close();}
  await fs.rename(temp,c.file);temp=null;await syncDir(c.root);
  return {...response(again,doc),receipt:{operationId:b.operationId,action:b.action,
   revision:doc.revision,verified:true,durable:true}};
 }finally{if(temp)await fs.rm(temp,{force:true});await fs.rmdir(c.lock);}
}
export function registerPB12GroupRoutes(router,deps={}){
 router.post('/v2/pb12/groups/read',async(req,res)=>{
  try{res.json({success:true,...await readPB12Groups(req,deps)});}
  catch(e){res.status(Number.isInteger(e.status)?e.status:409).json({success:false,
   code:/^PB(10|12)_[A-Z0-9_]+$/.test(e.code??'')?e.code:'PB12_UNVERIFIED',retryable:false});}
 });
 router.post('/v2/pb12/groups/update',async(req,res)=>{
  try{res.json({success:true,...await updatePB12Groups(req,deps)});}
  catch(e){res.status(Number.isInteger(e.status)?e.status:409).json({success:false,
   code:/^PB(10|12)_[A-Z0-9_]+$/.test(e.code??'')?e.code:'PB12_UNVERIFIED',retryable:false});}
 });
}

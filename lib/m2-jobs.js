/** M2: persistent, bounded jobs over the M1 saved-source, scope-attested gateway.
 * A claimed item is NEVER automatically retried after dispatch begins. All
 * write decisions remain at M1; batch UI cannot supply text/vectors/owners.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {previewM1Records,planM1Record,executeM1Record,readM1HostEvidence,m1ManualTestReadiness} from './m1-saved-records.js';
import {OperationLedger} from './s04-ledger.js';
import {ManagedChatRegistry} from './f09b4-managed-registry.js';
import {resolveF02Binding} from './f02-public-reads.js';
import {getEmbeddingProfile} from './f09b5-embedding-profiles.js';
import {selectedM3Profile} from './m3-source-selection.js';
const sha=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const key=/^[a-f0-9]{64}$/;
const modes=['vectorize-current','vectorize-selected','vectorize-lorebook','revectorize-changed'];
const error=(code,status=409)=>Object.assign(new Error(code),{code,status});
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
function shape(v,keys){return plain(v)&&Object.keys(v).every(k=>keys.includes(k));}
function validate(req){if(!req?.s03?.userScopeId||!path.isAbsolute(req.s03?.vectorsPath??'')||!req.user?.directories)throw error('M2_HOST_AUTH_REQUIRED',403);}
function checkPlan(body){
 if(!shape(body,['backend','source','configId','mode','selectedIds','maxItems','maxEmbeddings','ratePerMinute']))throw error('M2_BODY_FIELDS_FORBIDDEN',400);
 if(body.backend!=='qdrant'||!modes.includes(body.mode)||!['default','local',undefined].includes(body.configId))throw error('M2_JOB_SELECTOR_INVALID',400);
 if(body.mode==='vectorize-lorebook'&&body.source?.kind!=='lorebook'||body.mode!=='vectorize-lorebook'&&body.source?.kind==='lorebook')throw error('M2_JOB_SOURCE_MISMATCH',400);
 if(body.selectedIds!==undefined&&(!Array.isArray(body.selectedIds)||body.selectedIds.length>80||body.selectedIds.some(x=>!uuid.test(x))||new Set(body.selectedIds).size!==body.selectedIds.length))throw error('M2_SELECTED_RECORDS_INVALID',400);
 if(body.mode==='vectorize-selected'&&(!body.selectedIds?.length))throw error('M2_SELECTION_REQUIRED',400);
 if(body.mode!=='vectorize-selected'&&body.selectedIds!==undefined)throw error('M2_SELECTION_FORBIDDEN',400);
 if(body.maxItems!==undefined&&(!Number.isInteger(body.maxItems)||body.maxItems<1||body.maxItems>80))throw error('M2_ITEM_BUDGET_INVALID',400);
 if(body.maxEmbeddings!==undefined&&(!Number.isInteger(body.maxEmbeddings)||body.maxEmbeddings<1||body.maxEmbeddings>80))throw error('M2_EMBED_BUDGET_INVALID',400);
 if(body.ratePerMinute!==undefined&&(!Number.isInteger(body.ratePerMinute)||body.ratePerMinute<1||body.ratePerMinute>120))throw error('M2_RATE_INVALID',400);
 return body;
}
async function privateDir(dir){const st=await fs.lstat(dir);
 if(!st.isDirectory()||st.isSymbolicLink()||(process.platform!=='win32'&&(st.mode&0o077)))throw error('M2_STORAGE_UNTRUSTED',403);}
async function syncDir(dir){const fh=await fs.open(dir,'r');try{await fh.sync();}finally{await fh.close();}}
export class M2JobStore{
 constructor(ctx){if(!ctx?.userScopeId||!path.isAbsolute(ctx.vectorsPath??''))throw error('M2_STORAGE_SCOPE_REQUIRED',403);
  this.ctx=ctx;this.root=path.join(ctx.vectorsPath,'.similharity','m2-jobs');}
 async setup(){await privateDir(this.ctx.vectorsPath);for(const dir of [path.dirname(this.root),this.root]){
  await fs.mkdir(dir,{mode:0o700,recursive:false}).catch(e=>{if(e.code!=='EEXIST')throw e;});await privateDir(dir);}}
 file(id){if(!uuid.test(id??''))throw error('M2_JOB_ID_INVALID',400);return path.join(this.root,id.toLowerCase()+'.json');}
 lockDir(id){return path.join(this.root,'.lock-'+id.toLowerCase());}
 leaseFile(logicalKey){if(!key.test(logicalKey??''))throw error('M2_LOGICAL_KEY_INVALID',400);
  return path.join(this.root,'.lease-'+logicalKey);}
 async acquireLease(logicalKey,id){await this.setup();const lease=this.leaseFile(logicalKey);
  let fh;try{fh=await fs.open(lease,'wx',0o600);}catch(e){if(e.code==='EEXIST')throw error('M2_COLLECTION_JOB_EXCLUDED');throw e;}
  try{await fh.writeFile(JSON.stringify({owner:this.ctx.userScopeId,jobId:id,logicalKey}));await fh.sync();}finally{await fh.close();}
  await syncDir(this.root);
 }
 async releaseLease(logicalKey,id){await this.setup();const lease=this.leaseFile(logicalKey);const st=await fs.lstat(lease);
  if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>512)throw error('M2_LEASE_UNTRUSTED',403);
  let data;try{data=JSON.parse(await fs.readFile(lease,'utf8'));}catch{throw error('M2_LEASE_CORRUPT');}
  if(data.owner!==this.ctx.userScopeId||data.jobId!==id||data.logicalKey!==logicalKey)throw error('M2_LEASE_OWNER_MISMATCH',403);
  await fs.unlink(lease);await syncDir(this.root);
 }
 async assertNoLease(logicalKey){await this.setup();try{await fs.lstat(this.leaseFile(logicalKey));throw error('M2_COLLECTION_JOB_EXCLUDED');}
  catch(e){if(e.code==='ENOENT')return true;throw e;}}

 async read(id){await this.setup();const file=this.file(id),st=await fs.lstat(file);
  if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>128*1024||(process.platform!=='win32'&&(st.mode&0o077)))throw error('M2_JOB_FILE_UNTRUSTED',403);
  let data;try{data=JSON.parse(await fs.readFile(file,'utf8'));}catch{throw error('M2_JOB_CORRUPT');}
  const {checksum,...job}=data;if(checksum!==sha(job)||job.schemaVersion!==1||job.owner!==this.ctx.userScopeId||job.jobId!==id||!Array.isArray(job.items)||job.items.length>80)throw error('M2_JOB_CORRUPT');return job;}
 async persist(job,{create=false}={}){await this.setup();if(job.owner!==this.ctx.userScopeId||!uuid.test(job.jobId)||job.items.length>80)throw error('M2_JOB_SCOPE_INVALID');
  const file=this.file(job.jobId),content=JSON.stringify({...job,checksum:sha(job)})+'\n';if(Buffer.byteLength(content)>128*1024)throw error('M2_JOB_TOO_LARGE');
  if(create){const fh=await fs.open(file,'wx',0o600);try{await fh.writeFile(content);await fh.sync();}finally{await fh.close();}}
  else {const tmp=path.join(this.root,'.tmp-'+randomUUID());try{const fh=await fs.open(tmp,'wx',0o600);try{await fh.writeFile(content);await fh.sync();}finally{await fh.close();}await fs.rename(tmp,file);}finally{await fs.rm(tmp,{force:true});}}
  await syncDir(this.root);return job;}
 async locked(id,fn){await this.setup();const lock=this.lockDir(id);
  // Never clear stale lock directories automatically after process death.
  try{await fs.mkdir(lock,{mode:0o700});}catch(e){if(e.code==='EEXIST')throw error('M2_JOB_LOCKED_REVIEW_REQUIRED');throw e;}
  try{return await fn();}finally{await fs.rmdir(lock);}}
 async isLocked(id){await this.setup();try{await privateDir(this.lockDir(id));return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
}
const storeFor=(req,deps)=>deps.store?.(req.s03)??new M2JobStore(req.s03);
const m1Req=(req,body)=>({...req,body});
export async function previewM2Job(req,deps={}){
 validate(req);const b=checkPlan(req.body);
 const preview=await (deps.preview??previewM1Records)(m1Req(req,{backend:'qdrant',source:b.source,configId:b.configId}),deps.m1??{});
 if(!key.test(preview.logicalKey??'')||!Array.isArray(preview.records)||preview.records.length>80||preview.completeSavedSource!==true)throw error('M2_INCOMPLETE_SOURCE');
 const seen=new Set(preview.records.map(r=>r.recordId));
 if(b.selectedIds?.some(id=>!seen.has(id)))throw error('M2_SELECTED_RECORD_NOT_SAVED',403);
 let rows=preview.records.filter(r=>b.mode!=='vectorize-selected'||b.selectedIds.includes(r.recordId));
 if(b.mode==='revectorize-changed')rows=rows.filter(r=>r.managedState==='ACTIVE'&&r.changed===true);
 const items=rows.map(r=>({recordId:r.recordId,contentHash:r.contentHash,
  action:b.mode==='revectorize-changed'?'revectorize':r.availableActions?.includes('insert')?'insert':null,
  state:'PENDING',operationId:null,reason:null})).filter(r=>r.action!==null);
 const excluded=rows.length-items.length;
 const limit=b.maxItems??80,embeddingBudget=b.maxEmbeddings??80;
 if(items.length>limit||items.length>embeddingBudget)throw error('M2_JOB_BUDGET_EXCEEDED',409);
 return {backend:'qdrant',source:b.source,configId:b.configId??'default',mode:b.mode,
  logicalKey:preview.logicalKey,fileFingerprint:preview.fileFingerprint,items,
  counts:{selected:rows.length,eligible:items.length,excluded,embeddingCalls:items.length},
  maxItems:limit,maxEmbeddings:embeddingBudget,ratePerMinute:b.ratePerMinute??120,requiresExplicitApply:true,executionAllowed:false};
}
export async function createM2Job(req,deps={}){
 validate(req);if(!shape(req.body,['intent','confirmation'])||req.body.confirmation!=='CREATE BOUNDED SAVED-SOURCE JOB')throw error('M2_JOB_CONFIRMATION_REQUIRED',403);
 const plan=await previewM2Job(m1Req(req,req.body.intent),deps);
 if(!plan.items.length)throw error('M2_NOTHING_TO_VECTORIZE');
 const now=new Date().toISOString(),job={schemaVersion:1,jobId:randomUUID(),owner:req.s03.userScopeId,
  backend:'qdrant',source:plan.source,configId:plan.configId,mode:plan.mode,logicalKey:plan.logicalKey,
  fileFingerprint:plan.fileFingerprint,maxItems:plan.maxItems,maxEmbeddings:plan.maxEmbeddings,ratePerMinute:plan.ratePerMinute,
  nextDispatchAt:0,
  cursor:0,items:plan.items,state:'PAUSED',createdAt:now,updatedAt:now,dispatched:0,completed:0,
  decisions:[],uncertain:null,version:1};
 const store=storeFor(req,deps);
 await store.acquireLease(job.logicalKey,job.jobId);
 try{await store.persist(job,{create:true});}catch(e){await store.releaseLease(job.logicalKey,job.jobId);throw e;}
 return publicJob(job);
}
function publicJob(job){return {jobId:job.jobId,backend:job.backend,mode:job.mode,state:job.state,
 cursor:job.cursor,total:job.items.length,completed:job.completed,dispatched:job.dispatched,
 items:job.items.map(({recordId,action,state,reason,operationId})=>({recordId,action,state,reason,operationId})),
 updatedAt:job.updatedAt,nextDispatchAt:job.nextDispatchAt??0,recoveryRequired:job.state==='BLOCKED_UNCERTAIN'};}
async function changeJob(req,deps,jobId,action){
 validate(req);const store=storeFor(req,deps);return store.locked(jobId,async()=>{
  const job=await store.read(jobId);if(job.state==='BLOCKED_UNCERTAIN'||job.items.some(i=>i.state==='DISPATCHING'))throw error('M2_UNCERTAIN_REVIEW_REQUIRED');
  if(action==='resume'){
   if(job.state!=='PAUSED'&&job.state!=='FAILED')throw error('M2_RESUME_STATE_DENIED');
   if(job.state==='FAILED')throw error('M2_FAILED_JOB_REQUIRES_NEW_PLAN');
   // Certification is still enforced for every item by executeM1Record.
   job.state='READY';
  }else if(action==='pause'){
   if(!['READY','PAUSED'].includes(job.state))throw error('M2_PAUSE_STATE_DENIED');job.state='PAUSED';
  }else if(action==='cancel'){
   if(!['READY','PAUSED','FAILED'].includes(job.state))throw error('M2_CANCEL_STATE_DENIED');job.state='CANCELLED';
  }
  job.updatedAt=new Date().toISOString();job.version++;await store.persist(job);
  if(job.state==='CANCELLED')await store.releaseLease(job.logicalKey,job.jobId);return publicJob(job);
 });
}
export const resumeM2Job=(req,id,deps={})=>changeJob(req,deps,id,'resume');
export const pauseM2Job=(req,id,deps={})=>changeJob(req,deps,id,'pause');
export const cancelM2Job=(req,id,deps={})=>changeJob(req,deps,id,'cancel');
export async function getM2Job(req,id,deps={}){validate(req);const store=storeFor(req,deps),job=await store.read(id);
 const blocked=await store.isLocked(id)||job.items.some(i=>i.state==='DISPATCHING');
 return {...publicJob(job),...(blocked?{state:'BLOCKED_UNCERTAIN',recoveryRequired:true}:{}),lockRequiresReview:blocked};}
/** One bounded item/HTTP call. UI or a host-side scheduler may call again; no
 * unattended/implicit retry. First save DISPATCHING before M1 plan/dispatch.
 * Any exception after that journal point requires manual evidence review.
 */
export async function stepM2Job(req,id,deps={}){
 validate(req);const store=storeFor(req,deps);
 return store.locked(id,async()=>{
  let job=await store.read(id);
  if(job.state!=='READY'||job.cursor>=job.items.length)throw error('M2_JOB_NOT_READY');
  if(job.items.some(i=>i.state==='DISPATCHING'))throw error('M2_UNCERTAIN_REVIEW_REQUIRED');
  const item=job.items[job.cursor];if(item.state!=='PENDING')throw error('M2_CHECKPOINT_CORRUPT');
  // Re-attest COMPLETE saved source and stable hash *before* taking a dispatch claim.
  const preview=await (deps.preview??previewM1Records)(m1Req(req,{backend:'qdrant',source:job.source,configId:job.configId}),deps.m1??{});
  if(preview.logicalKey!==job.logicalKey||preview.fileFingerprint!==job.fileFingerprint||
   !preview.completeSavedSource||!preview.records.some(r=>r.recordId===item.recordId&&r.contentHash===item.contentHash)){
   job.state='PAUSED';item.reason='M2_SAVED_SOURCE_CHANGED';job.updatedAt=new Date().toISOString();await store.persist(job);return publicJob(job);
  }
  if(job.dispatched>=job.maxItems||job.dispatched>=job.maxEmbeddings)throw error('M2_JOB_BUDGET_EXCEEDED');
  if(Date.now()<(job.nextDispatchAt??0))return publicJob(job);
  // Planning cannot dispatch a write. Validate live certification and obtain
  // the exact server-bound M1 plan BEFORE spending a one-way dispatch budget.
  const certification=deps.certify?await deps.certify(req,item):undefined;
  if(!(await m1ManualTestReadiness(item.action,certification))){job.state='PAUSED';item.reason='M1_CODE_GATE_REFUSED';
   job.updatedAt=new Date().toISOString();await store.persist(job);return publicJob(job);}
  let plan;
  try{plan=await (deps.plan??planM1Record)(m1Req(req,{backend:'qdrant',source:job.source,configId:job.configId,
   action:item.action,recordId:item.recordId}),job.logicalKey,deps.m1??{});
  }catch(e){job.state='PAUSED';item.reason=/^[A-Z0-9_]+$/.test(e.code??'')?e.code:'M2_PRE_DISPATCH_REFUSED';
   job.updatedAt=new Date().toISOString();await store.persist(job);return publicJob(job);}
  if(!uuid.test(plan?.operationId??'')||plan.recordId!==item.recordId||plan.logicalKey!==job.logicalKey){
   job.state='PAUSED';item.reason='M2_UNTRUSTED_M1_PLAN';await store.persist(job);return publicJob(job);}
  // Persist DISPATCHING and the M1 operation ID before calling the mutation
  // gateway. If the process crashes now, restart cannot retry this item.
  item.state='DISPATCHING';item.operationId=plan.operationId;item.reason=null;
  job.dispatched++;job.nextDispatchAt=Date.now()+Math.ceil(60000/job.ratePerMinute);
  job.updatedAt=new Date().toISOString();await store.persist(job);
  try{
   const result=await (deps.execute??executeM1Record)(m1Req(req,{operationId:plan.operationId,
    confirmation:'APPLY SAVED RECORD MUTATION'}),deps.m1??{});
   if(result?.state!=='VERIFIED'||result.operationId!==plan.operationId)throw error('M2_OUTCOME_UNVERIFIED');
   item.state='VERIFIED';item.reason=null;job.cursor++;job.completed++;
   job.state=job.cursor===job.items.length?'COMPLETED':'READY';
  }catch(e){
   // Once claimed, errors are ambiguous: there may be a physical write.
   item.state='UNCERTAIN';item.reason=/^[A-Z0-9_]+$/.test(e.code??'')?e.code:'M2_DISPATCH_OUTCOME_UNVERIFIED';
   job.state='BLOCKED_UNCERTAIN';job.uncertain={recordId:item.recordId,operationId:item.operationId,
    reason:item.reason,observedAt:new Date().toISOString()};
  }
  job.updatedAt=new Date().toISOString();job.version++;await store.persist(job);
  if(job.state==='COMPLETED')await store.releaseLease(job.logicalKey,job.jobId);return publicJob(job);
 });
}
export async function m2EvidenceBundle(req,id,deps={}){
 validate(req);const store=storeFor(req,deps),job=await store.read(id);
 if(job.state!=='BLOCKED_UNCERTAIN'&&!job.items.some(i=>i.state==='DISPATCHING')&&!await store.isLocked(id))throw error('M2_NO_UNCERTAIN_OPERATION');
 // No user-controlled admin verdict or backend outcome is ever accepted here.
 const opId=job.uncertain?.operationId;
 let ledger={status:'UNAVAILABLE',state:null,fingerprint:null};
 if(uuid.test(opId??'')){
  try{const receipt=await (deps.operationLedger?.(req.s03)??new OperationLedger(req.s03)).read(opId);
   if(receipt.plan?.collectionKey!==job.logicalKey)throw error('M2_LEDGER_SCOPE_CONFLICT',403);
   ledger={status:'LOCALLY_VERIFIED',state:receipt.state,fingerprint:sha(receipt),operationId:receipt.operationId};
  }catch(e){if(e.code==='M2_LEDGER_SCOPE_CONFLICT')throw e;}
 }
 let managed={status:'UNAVAILABLE',state:null,fingerprint:null};
 try{const profile=(await (deps.getProfile?deps.getProfile(req.s03):selectedM3Profile(req,job.source)))?.profile;
  if(profile){const {binding}=await (deps.bind??resolveF02Binding)(req,{backend:'qdrant',
   source:job.source,embedding:profile,configId:job.configId},{reserve:false,readAlias:true});
   if(binding.collection.key!==job.logicalKey||binding.scope.userScopeId!==req.s03.userScopeId)
    throw error('M2_REGISTRY_SCOPE_CONFLICT',403);
   const registry=deps.registry?.(req.s03,binding)??new ManagedChatRegistry(req.s03,binding);
   const doc=await registry.read(),record=doc.records[job.uncertain?.recordId];
   managed={status:'LOCALLY_VERIFIED',state:record?.state??'UNTRACKED',
    fingerprint:sha({record:record??null,registryFingerprint:doc.fingerprint})};
  }
 }catch(e){if(e.code==='M2_REGISTRY_SCOPE_CONFLICT')throw e;}
 const evidence={jobId:id,ownerScopeHash:sha(req.s03.userScopeId),backend:job.backend,
  logicalKey:job.logicalKey,mode:job.mode,fileFingerprint:job.fileFingerprint,
  cursor:job.cursor,state:job.state,uncertain:job.uncertain,ledger,managed,
  backendOutcome:'NOT_ESTABLISHED',replayAllowed:false,
  items:job.items.map(i=>({recordId:i.recordId,operationId:i.operationId,state:i.state,
   reason:i.reason})),updatedAt:job.updatedAt,lockRetained:await store.isLocked(id)};
 return {...evidence,evidenceHash:sha(evidence),reviewState:'REVIEW_REQUIRED',
  instructions:'Obtain authoritative backend and M1 ledger/registry evidence; do not replay or clear retained locks.'};
}
/** An admin-attested decision is submitted *out of band*, from a private
 * server-config root, and verified by one-use evidence hash. This endpoint
 * only requests re-reading that decision; the browser cannot submit a verdict.
 * Automatic adjudication is purposely NOT implemented for non-idempotent ops.
 */
export async function reviewM2Adjudication(req,id,deps={}){
 validate(req);if(!shape(req.body,[])||req.body===null)throw error('M2_REVIEW_BODY_FORBIDDEN',400);
 if(req.user?.profile?.admin!==true&&req.user?.admin!==true)throw error('M2_HOST_ADMIN_REQUIRED',403);
 const bundle=await m2EvidenceBundle(req,id,deps);
 const root=deps.adminRoot??process.env.SIMILHARITY_SERVER_CONFIG_DIR;
 if(!path.isAbsolute(root??''))throw error('M2_ADMIN_CONFIG_REQUIRED',403);
 await privateDir(root);
 const file=path.join(root,`m2-review-${id}.json`),st=await fs.lstat(file);
 if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>8192||(process.platform!=='win32'&&(st.mode&0o077)))throw error('M2_ADMIN_EVIDENCE_UNTRUSTED',403);
 const approval=JSON.parse(await fs.readFile(file,'utf8'));
 if(approval.schemaVersion!==1||approval.jobId!==id||approval.ownerScopeHash!==bundle.ownerScopeHash||
  approval.evidenceHash!==bundle.evidenceHash||!uuid.test(approval.reviewId??'')||
  !['APPLIED','NOT_APPLIED','ABANDON'].includes(approval.decision)||
  approval.backupVerified!==true||typeof approval.backendEvidenceFingerprint!=='string'||
  !/^[a-f0-9]{64}$/.test(approval.backendEvidenceFingerprint)||
  approval.authoritativeEvidenceVerified!==true||approval.adminApproved!==true)
  throw error('M2_ADMIN_PROOF_INSUFFICIENT',403);
 // The reviewer attests evidence. Resolution still never retries the uncertain operation.
 // Lock quarantine is retained; there is no automatic lock release.
 const store=storeFor(req,deps),job=await store.read(id);
 if(job.decisions.some(d=>d.reviewId===approval.reviewId))throw error('M2_REVIEW_REPLAY_DENIED');
 job.decisions.push({reviewId:approval.reviewId,decision:approval.decision,
  evidenceHash:bundle.evidenceHash,backendEvidenceFingerprint:approval.backendEvidenceFingerprint,
  at:new Date().toISOString(),previousHash:sha(job.decisions),decisionHash:sha([approval.reviewId,approval.decision,bundle.evidenceHash,sha(job.decisions)])});
 job.state='BLOCKED_UNCERTAIN';job.updatedAt=new Date().toISOString();job.version++;
 await store.persist(job);
 return {jobId:id,decision:approval.decision,state:'BLOCKED_UNCERTAIN',lockQuarantined:true,
  nextStep:'Server administrator must independently reconcile M1 ledger and registry before releasing a physical lock.'};
}
export function registerM2Routes(router,deps={}){
 const wrap=fn=>async(req,res)=>{try{res.json({success:true,...await fn(req,res)});}catch(e){res.status(e.status??409).json({success:false,
  code:/^M2_[A-Z0-9_]+$/.test(e.code??'')?e.code:'M2_OPERATION_REFUSED',retryable:false});}};
 router.post('/v2/m2/jobs/preview',wrap(req=>previewM2Job(req,deps)));
 router.post('/v2/m2/jobs/create',wrap(req=>createM2Job(req,deps)));
 router.get('/v2/m2/jobs/:jobId',wrap(req=>getM2Job(req,req.params.jobId,deps)));
 router.post('/v2/m2/jobs/:jobId/resume',wrap(req=>resumeM2Job(req,req.params.jobId,deps)));
 router.post('/v2/m2/jobs/:jobId/pause',wrap(req=>pauseM2Job(req,req.params.jobId,deps)));
 router.post('/v2/m2/jobs/:jobId/cancel',wrap(req=>cancelM2Job(req,req.params.jobId,deps)));
 router.post('/v2/m2/jobs/:jobId/step',wrap(req=>stepM2Job(req,req.params.jobId,deps)));
 router.get('/v2/m2/jobs/:jobId/evidence',wrap(req=>m2EvidenceBundle(req,req.params.jobId,deps)));
 router.post('/v2/m2/jobs/:jobId/review',wrap(req=>reviewM2Adjudication(req,req.params.jobId,deps)));
}

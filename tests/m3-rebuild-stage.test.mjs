import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {planM3RebuildStage,executeM3RebuildStage,inspectM3RebuildStage} from '../lib/m3-rebuild-stage.js';
import {M3Store} from '../lib/m3-collections.js';
import {collectionIdentity,contentFingerprint,recordIdentity} from '../lib/s02-identity.js';
import {makeSavedRecordV2,savedRecordIdentity} from '../lib/m1-saved-records.js';
const H=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const source={kind:'chat',avatar:'a.png',chatFile:'chat-a'};
const scope={userScopeId:'alice',collectionId:'a',type:'chat',sourceId:'chat-a',branchId:'branch'};
const oldProfile={source:'transformers',model:'old',dimension:3,metric:'cosine'};
const newProfile={source:'transformers',model:'new',dimension:4,metric:'cosine'};
const old=collectionIdentity({backend:'qdrant',scope,embedding:oldProfile});
const target=collectionIdentity({backend:'qdrant',scope,embedding:newProfile});
const binding=(identity,profile)=>({authorized:true,provenance:'SERVER_VERIFIED',backend:'qdrant',scope,
 embedding:profile,collection:{key:identity.key,physicalName:identity.physicalName}});
async function fixture(count=1){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'m3v8-stage-'));await fs.chmod(dir,0o700);
 const ctx={userScopeId:'alice',vectorsPath:dir};
 const messages=[],rows=[],managedRecords={};
 for(let i=0;i<count;i++){
  const msg={recordId:randomUUID(),text:i===0?'real saved message':`real saved message ${i}`};
  msg.contentHash=contentFingerprint(msg.text);messages.push(msg);
 }
 const snapshot={sourceId:scope.sourceId,fileHash:'a'.repeat(64),sourceKind:'chat',messages};
 for(const msg of messages){
  const {recordId}=savedRecordIdentity(ctx,binding(old,oldProfile),msg);
  const v2=makeSavedRecordV2({ctx,binding:binding(old,oldProfile),msg,snapshot,
   profile:oldProfile,revision:1,operationId:randomUUID()});
  const metadata={vecthareRecordV2:v2},physicalId=recordIdentity(scope,recordId).physicalId;
  const vector=[0.1,0.9,0.3];
  rows.push({id:physicalId,vector,payload:{...scope,recordId,physicalId,revision:1,text:msg.text,
   textHash:msg.contentHash,embedding:oldProfile,metadata,metadataHash:H(metadata),vectorHash:H(vector),vectorReference:vector}});
  managedRecords[recordId]={recordId,state:'ACTIVE',contentHash:msg.contentHash,revision:1,operationId:null};
 }
 rows.sort((a,b)=>String(a.id).localeCompare(String(b.id)));
 const backup={schemaVersion:1,backupId:randomUUID(),owner:'alice',backend:'qdrant',
  logicalKey:old.key,physicalName:old.physicalName,scope,embedding:oldProfile,source,configId:'default',
  sourceId:scope.sourceId,savedSourceFingerprint:snapshot.fileHash,
  managed:{fingerprint:'f'.repeat(64),records:managedRecords},
  operationCheckpoint:{count:0,digest:H([])},
  inventory:{rows,count:rows.length,digest:H(rows),complete:true,exclusiveOwner:true}};
 const store=new M3Store(ctx);await store.write('backup',backup);
 const req={s03:ctx,user:{directories:{}},body:{backend:'qdrant',source,configId:'default',backupId:backup.backupId}};
 const active={configured:true,profile:structuredClone(oldProfile)},staged={configured:true,profile:structuredClone(newProfile)};
 const calls=[];
 const deps={store:()=>store,getProfile:async()=>active,getStagedProfile:async()=>staged,
  bind:async (_,intent)=>({binding:binding(intent.embedding.model==='new'?target:old,intent.embedding)}),
  readSnapshot:async()=>structuredClone(snapshot),jobs:()=>({assertNoLease:async()=>true}),
  registry:()=>({read:async()=>structuredClone(backup.managed)}),
  ledgerCheckpoint:async()=>({count:0,digest:H([])}),
  transport:async()=>({_request:async()=>{throw Error('no physical I/O in stub')}}),
  inventory:async()=>({rows:structuredClone(backup.inventory.rows),digest:backup.inventory.digest,
   count:backup.inventory.count,complete:true,exclusiveOwner:true}),
  embed:async(text,profile)=>{calls.push(['embed',text,profile.model]);return [0.3,0.2,0.5,0.1];},
  smoke:async()=>({verified:true,version:'fixture-smoke'}),
  issueTargetReceipt:async()=>({receiptVerified:true}),
  verifyTargetReceipt:async(_ctx,{active})=>({receiptVerified:true,inventoryVerified:true,schemaVerified:true,physicalName:active.physicalName}),
  stage:async(_transport,manifest)=>{calls.push(['stage',manifest]);return {inventoryVerified:true,
   restoredCount:manifest.inventory.count,targetPhysicalName:'vh2_'+H(['m3-fresh-restore',manifest.backupId,'test']).slice(0,48)};}};
 return {req,ctx,store,active,staged,snapshot,backup,calls,deps,cleanup:()=>fs.rm(dir,{recursive:true,force:true})};
}
test('staged target is re-embedded from saved source and verified without changing active model',async()=>{
 const f=await fixture();try{
  const plan=await planM3RebuildStage(f.req,f.deps);
  assert.equal(plan.stagingAllowed,true);assert.equal(plan.activationAllowed,false);
  const result=await executeM3RebuildStage(f.req,plan.operationId,f.deps);
  assert.equal(result.state,'VERIFIED_STAGED');assert.equal(result.activationAllowed,false);
  assert.equal(result.stagedLogicalKey,target.key);assert.equal(result.recordCount,1);
  assert.equal(result.targetReceiptVerified,true);assert.equal(result.targetRegistryVerified,true);
  assert.deepEqual(f.calls[0],['embed','real saved message','new']);
  const b=f.calls[1][1],r=b.inventory.rows[0];
  assert.equal(b.embedding.model,'new');assert.equal(b.logicalKey,target.key);
  assert.equal(r.payload.metadata.vecthareRecordV2.embedding.model,'new');
  assert.deepEqual(r.vector,[0.3,0.2,0.5,0.1]);
  assert.equal(r.payload.revision,1);assert.equal(r.payload.text,'real saved message');
  assert.equal(f.active.profile.model,'old');
  const inspection=await inspectM3RebuildStage(f.req,plan.operationId,f.deps);
  assert.equal(inspection.state,'VERIFIED_STAGED');assert.equal(inspection.activationAllowed,false);
  await assert.rejects(()=>executeM3RebuildStage(f.req,plan.operationId,f.deps),{code:'M3_OPERATION_ALREADY_CLAIMED'});
 }finally{await f.cleanup();}
});
test('stale staged profile, source, or invalid embedding fails closed before physical mutation',async()=>{
 const f=await fixture();try{
  const p=await planM3RebuildStage(f.req,f.deps);
  f.staged.profile.model='different';
  await assert.rejects(()=>executeM3RebuildStage(f.req,p.operationId,f.deps));
  assert.equal(f.calls.length,0);
  f.staged.profile.model='new';f.snapshot.fileHash='b'.repeat(64);
  await assert.rejects(()=>executeM3RebuildStage(f.req,p.operationId,f.deps),{code:'M3_REBUILD_SOURCE_CHANGED'});
  f.snapshot.fileHash=f.backup.savedSourceFingerprint;
  f.deps.embed=async()=>[1];
  await assert.rejects(()=>executeM3RebuildStage(f.req,p.operationId,f.deps),{code:'M3_REBUILD_EMBEDDING_INVALID'});
  assert.equal(f.calls.filter(x=>x[0]==='stage').length,0);
 }finally{await f.cleanup();}
});
test('post-claim failure retains logical lock and forbids replay',async()=>{
 const f=await fixture();try{
  const p=await planM3RebuildStage(f.req,f.deps);
  f.deps.stage=async()=>{throw Object.assign(new Error('lost ack'),{code:'QDRANT_NETWORK_UNKNOWN'});};
  await assert.rejects(()=>executeM3RebuildStage(f.req,p.operationId,f.deps),/lost ack/);
  await assert.rejects(()=>executeM3RebuildStage(f.req,p.operationId,f.deps),{code:'M3_OPERATION_ALREADY_CLAIMED'});
 }finally{await f.cleanup();}
});
test('staged profile config does not alter active profile or leak credentials',async()=>{
 const {getEmbeddingProfile,saveEmbeddingProfile,getStagedEmbeddingProfile,saveStagedEmbeddingProfile}=await import('../lib/f09b5-embedding-profiles.js');
 const f=await fixture();try{
  await saveEmbeddingProfile(f.ctx,{...oldProfile});
  const stage=await saveStagedEmbeddingProfile(f.ctx,{...newProfile});
  assert.equal(stage.configured,true);
  assert.equal(stage.profile.model,'new');
  assert.equal((await getEmbeddingProfile(f.ctx)).profile.model,'old');
  assert.equal((await getStagedEmbeddingProfile(f.ctx)).profile.model,'new');
  await assert.rejects(()=>saveStagedEmbeddingProfile(f.ctx,{...oldProfile}),{code:'F09B5_STAGED_PROFILE_NOT_DISTINCT'});
  await assert.rejects(()=>saveStagedEmbeddingProfile(f.ctx,{...newProfile,credential:'bad\nsecret'}),{code:'F09B5_CREDENTIAL_INVALID'});
 }finally{await f.cleanup();}
});
test('Qdrant-shaped stage creates and verifies a distinct 4D physical collection',async()=>{
 const f=await fixture();try{
  const plan=await planM3RebuildStage(f.req,f.deps);
  delete f.deps.stage;delete f.deps.smoke;delete f.deps.issueTargetReceipt;
  let physical=null,created=false,rows=[],writes=0;
  const fields=['userScopeId','collectionId','type','sourceId','branchId','recordId','physicalId'];
  const indexes=Object.fromEntries(fields.map(k=>[k,{data_type:'keyword'}]));
  f.deps.transport=async()=>({_request:async(method,uri,body)=>{
   const match=uri.match(/^\/collections\/(vh2_[a-f0-9]{48})(.*)$/);
   assert.ok(match,'only a server-created collection name may be addressed');
   physical=match[1];const suffix=match[2];
   assert.notEqual(physical,f.backup.physicalName);
   if(method==='GET'&&suffix===''){
    if(!created)throw Object.assign(new Error('absent'),{httpStatus:404});
    return {result:{config:{params:{vectors:{size:4,distance:'Cosine'}}},payload_schema:indexes}};
   }
   if(method==='PUT'&&suffix===''){
    assert.equal(body.vectors.size,4);assert.equal(created,false);created=true;return {result:true};
   }
   if(method==='PUT'&&suffix.startsWith('/index'))return {result:true};
   if(method==='PUT'&&suffix==='/points?wait=true'){
    writes++;rows.push(...structuredClone(body.points));return {result:{status:'completed'}};
   }
   if(method==='POST'&&suffix==='/points/scroll')return {result:{points:structuredClone(rows),next_page_offset:null}};
   if(method==='POST'&&suffix==='/points/query')return {result:{points:rows.map(p=>({id:p.id,payload:p.payload}))}};
   throw Error(`unreviewed Qdrant call: ${method} ${uri}`);
  }});
  const finished=await executeM3RebuildStage(f.req,plan.operationId,f.deps);
  assert.equal(finished.state,'VERIFIED_STAGED');assert.equal(finished.activeProfileUnchanged,true);
  assert.equal(created,true);assert.equal(writes,1);assert.equal(rows.length,1);
  assert.equal(rows[0].payload.embedding.model,'new');assert.equal(rows[0].vector.length,4);
  const inspector=await inspectM3RebuildStage(f.req,plan.operationId,f.deps);
  assert.equal(inspector.receiptVerified,true);assert.equal(inspector.registryVerified,true);
 }finally{await f.cleanup();}
});
test('rebuild stage inspector fails closed if saved source or staged model changes',async()=>{
 const f=await fixture();try{
  const p=await planM3RebuildStage(f.req,f.deps);
  await executeM3RebuildStage(f.req,p.operationId,f.deps);
  f.snapshot.fileHash='b'.repeat(64);
  await assert.rejects(()=>inspectM3RebuildStage(f.req,p.operationId,f.deps),{code:'M3_REBUILD_STAGE_SOURCE_CHANGED'});
  f.snapshot.fileHash=f.backup.savedSourceFingerprint;
  f.staged.profile.model='changed-after-stage';
  await assert.rejects(()=>inspectM3RebuildStage(f.req,p.operationId,f.deps),{code:'M3_REBUILD_STAGE_PROFILE_CHANGED'});
 }finally{await f.cleanup();}
});
test('rebuild stage refuses missing immutable receipt and retains both locks after dispatch',async()=>{
 const f=await fixture();try{
  const p=await planM3RebuildStage(f.req,f.deps);
  f.deps.issueTargetReceipt=async()=>({receiptVerified:false});
  await assert.rejects(()=>executeM3RebuildStage(f.req,p.operationId,f.deps),{code:'M3_REBUILD_STAGED_RECEIPT_MISSING'});
  await assert.rejects(()=>executeM3RebuildStage(f.req,p.operationId,f.deps),{code:'M3_OPERATION_ALREADY_CLAIMED'});
  const inspected=await inspectM3RebuildStage(f.req,p.operationId,f.deps);
  assert.equal(inspected.state,'REVIEW_REQUIRED');assert.equal(inspected.physicalLockReleaseAuthorized,false);
 }finally{await f.cleanup();}
});
test('completed stage inspection rejects unverified physical readback even with a committed audit',async()=>{
 const f=await fixture();try{
  const p=await planM3RebuildStage(f.req,f.deps);
  await executeM3RebuildStage(f.req,p.operationId,f.deps);
  f.deps.verifyTargetReceipt=async()=>({receiptVerified:true,inventoryVerified:false,schemaVerified:true,
   physicalName:'vh2_'+ 'a'.repeat(48)});
  await assert.rejects(()=>inspectM3RebuildStage(f.req,p.operationId,f.deps),{code:'M3_REBUILD_STAGE_PHYSICAL_UNVERIFIED'});
 }finally{await f.cleanup();}
});

// M3v10: source-specific publication is a separate, one-use operation. The
// global profile remains old, and Qdrant evidence is pinned to the activation.
test('M3v10 source-scoped rebuild activation publishes verified target without globally switching models',async()=>{
 const {planM3RebuildActivation,executeM3RebuildActivation}=await import('../lib/m3-rebuild-activation.js');
 const {readM3SourceSelection,selectedM3Profile}=await import('../lib/m3-source-selection.js');
 const f=await fixture();try{
  const stagePlan=await planM3RebuildStage(f.req,f.deps);
  const stage=await executeM3RebuildStage(f.req,stagePlan.operationId,f.deps);
  const deps={...f.deps,
   attest:async()=>({status:'HOST_FILE_OWNED',hostSourceOwnerVerified:true,scope}),
   configuration:async()=>({version:1,profile:newProfile,credential:''}),
   verifyPhysical:async()=>({verified:true,inventoryVerified:true,schemaVerified:true,exclusiveOwner:true,
    physicalName:stage.stagedPhysicalName,inventoryDigest:'a'.repeat(64),count:1}),
   issueReceipt:async()=>({receiptVerified:true}),
   resolveTarget:async()=>({...binding(target,newProfile),collection:{...binding(target,newProfile).collection,
    physicalName:stage.stagedPhysicalName,generation:1}})};
  const plan=await planM3RebuildActivation({...f.req,body:{stageOperationId:stagePlan.operationId}},deps);
  assert.equal(plan.enabled,true);assert.equal(plan.validationStatus,'AWAITING_MANUAL_TEST');
  const applied=await executeM3RebuildActivation(f.req,plan.operationId,deps);
  assert.equal(applied.state,'VERIFIED');assert.equal(applied.sourceScoped,true);
  assert.equal(f.active.profile.model,'old');
  const selected=await readM3SourceSelection(f.ctx,scope);
  assert.equal(selected.toLogicalKey,target.key);
  assert.equal(selected.profile.model,'new');
  assert.equal(selected.config.credential,'');
  const effective=await selectedM3Profile(f.req,source,{attest:deps.attest,getBase:deps.getProfile});
  assert.equal(effective.selectionGeneration,1);
  assert.equal(effective.profile.model,'new');
  await assert.rejects(()=>executeM3RebuildActivation(f.req,plan.operationId,deps),{code:'M3_OPERATION_ALREADY_CLAIMED'});
 }finally{await f.cleanup();}
});

test('M3v10 stale source prevents activation without changing selected profile',async()=>{
 const {planM3RebuildActivation}=await import('../lib/m3-rebuild-activation.js');
 const {readM3SourceSelection}=await import('../lib/m3-source-selection.js');
 const f=await fixture();try{
  const plan=await planM3RebuildStage(f.req,f.deps);
  await executeM3RebuildStage(f.req,plan.operationId,f.deps);
  f.snapshot.fileHash='b'.repeat(64);
  const deps={...f.deps,attest:async()=>({status:'HOST_FILE_OWNED',hostSourceOwnerVerified:true,scope})};
  await assert.rejects(()=>planM3RebuildActivation({...f.req,body:{stageOperationId:plan.operationId}},deps),
   {code:'M3_REBUILD_STAGE_SOURCE_CHANGED'});
  assert.equal(await readM3SourceSelection(f.ctx,scope),null);
 }finally{await f.cleanup();}
});

test('M3v10 activation lost receipt response never commits selection or permits a second dispatch',async()=>{
 const {planM3RebuildActivation,executeM3RebuildActivation}=await import('../lib/m3-rebuild-activation.js');
 const {readM3SourceSelection}=await import('../lib/m3-source-selection.js');
 const f=await fixture();try{
  const stagePlan=await planM3RebuildStage(f.req,f.deps);
  const stage=await executeM3RebuildStage(f.req,stagePlan.operationId,f.deps);
  const deps={...f.deps,
   attest:async()=>({status:'HOST_FILE_OWNED',hostSourceOwnerVerified:true,scope}),
   configuration:async()=>({version:1,profile:newProfile,credential:''}),
   verifyPhysical:async()=>({verified:true,inventoryVerified:true,schemaVerified:true,exclusiveOwner:true,
    physicalName:stage.stagedPhysicalName,inventoryDigest:'a'.repeat(64),count:1}),
   issueReceipt:async()=>{throw Object.assign(new Error('lost ACK'),{code:'QDRANT_ACK_UNKNOWN'});}};
  const plan=await planM3RebuildActivation({...f.req,body:{stageOperationId:stagePlan.operationId}},deps);
  await assert.rejects(()=>executeM3RebuildActivation(f.req,plan.operationId,deps),/lost ACK/);
  assert.equal(await readM3SourceSelection(f.ctx,scope),null);
  await assert.rejects(()=>executeM3RebuildActivation(f.req,plan.operationId,deps),{code:'M3_OPERATION_ALREADY_CLAIMED'});
 }finally{await f.cleanup();}
});

test('M3v10 stage planning reserves only the server-derived owned target collection',async()=>{
 const f=await fixture();try{
  const original=f.deps.bind,seen=[];
  f.deps.bind=async(req,intent,opts)=>{seen.push({opts,source:intent.source,embedding:intent.embedding});return original(req,intent,opts);};
  const plan=await planM3RebuildStage(f.req,f.deps);
  assert.equal(plan.targetLogicalKey,target.key);
  assert.equal(seen[0].opts.reserve,true);
  assert.deepEqual(seen[0].source,source);
  assert.deepEqual(seen[0].embedding,newProfile);
 }finally{await f.cleanup();}
});


test('M3v12 large rebuild checkpoints 300 saved vectors in bounded steps and stages without re-embedding',async()=>{
 const {stepM3RebuildPreparation,progressM3RebuildPreparation,M3RebuildPreparationStore}=await import('../lib/m3-rebuild-preparation.js');
 const f=await fixture(300);try{
  const p=await planM3RebuildStage(f.req,f.deps);
  assert.equal(p.recordCount,300);assert.equal(p.requiresPreparation,true);
  let progress=await stepM3RebuildPreparation(f.req,p.operationId,f.deps);
  assert.equal(progress.preparedCount,16);assert.equal(progress.physicalWritesPerformed,false);
  // Restart with a new checkpoint-store instance: the next batch resumes at 16.
  assert.ok((await new M3RebuildPreparationStore(f.ctx,p.operationId).read(0)).vector.length===4);
  while(!progress.readyForStageExecute)progress=await stepM3RebuildPreparation(f.req,p.operationId,f.deps);
  assert.equal(progress.preparedCount,300);
  assert.equal((await progressM3RebuildPreparation(f.req,p.operationId,f.deps)).state,'READY_TO_STAGE');
  assert.equal(f.calls.filter(x=>x[0]==='embed').length,300);
  const staged=await executeM3RebuildStage(f.req,p.operationId,f.deps);
  assert.equal(staged.state,'VERIFIED_STAGED');assert.equal(staged.recordCount,300);
  assert.equal(f.calls.filter(x=>x[0]==='embed').length,300,'stage MUST consume checkpoints instead of re-embedding');
  assert.equal(f.calls.find(x=>x[0]==='stage')[1].inventory.rows.length,300);
 }finally{await f.cleanup();}
});

test('M3v12 tampered preembedding checkpoint is rejected before stage dispatch',async()=>{
 const {stepM3RebuildPreparation,M3RebuildPreparationStore}=await import('../lib/m3-rebuild-preparation.js');
 const f=await fixture(260);try{
  const p=await planM3RebuildStage(f.req,f.deps);
  await stepM3RebuildPreparation(f.req,p.operationId,f.deps);
  const file=new M3RebuildPreparationStore(f.ctx,p.operationId).file(0);
  const saved=JSON.parse(await fs.readFile(file,'utf8'));saved.vector[0]=999;
  await fs.writeFile(file,JSON.stringify(saved));
  await assert.rejects(()=>stepM3RebuildPreparation(f.req,p.operationId,f.deps),{code:'M3_PREP_CHECKPOINT_CORRUPT'});
  await assert.rejects(()=>executeM3RebuildStage(f.req,p.operationId,f.deps));
  assert.equal(f.calls.filter(x=>x[0]==='stage').length,0);
 }finally{await f.cleanup();}
});

test('M3v12 saved source change pauses resumable preparation without any physical write',async()=>{
 const {stepM3RebuildPreparation}=await import('../lib/m3-rebuild-preparation.js');
 const f=await fixture(258);try{
  const p=await planM3RebuildStage(f.req,f.deps);
  await stepM3RebuildPreparation(f.req,p.operationId,f.deps);
  f.snapshot.fileHash='b'.repeat(64);
  await assert.rejects(()=>stepM3RebuildPreparation(f.req,p.operationId,f.deps));
  assert.equal(f.calls.filter(x=>x[0]==='stage').length,0);
 }finally{await f.cleanup();}
});

test('M3v13 physical chunk checkpoint fires only after exact Qdrant readback, never after ack alone',async()=>{
 const {stageM3DisposableRestore}=await import('../lib/m3-collections.js');
 const f=await fixture();try{
  let created=false,points=[],callbackCount=0,reads=0;
  const qdrant={m3DisposableFixture:true,_request:async(method,uri,body)=>{
   if(method==='GET'&&uri.match(/^\/collections\/vh2_[a-f0-9]{48}$/)){
    if(!created)throw Object.assign(Error('404'),{httpStatus:404});
    return {result:true};
   }
   if(method==='PUT'&&uri.match(/^\/collections\/vh2_[a-f0-9]{48}$/)){created=true;return {result:true};}
   if(method==='PUT'&&uri.endsWith('/index?wait=true'))return {result:true};
   if(method==='PUT'&&uri.endsWith('/points?wait=true')){points=structuredClone(body.points);return {result:{status:'completed'}};}
   if(method==='POST'&&uri.endsWith('/points')){reads++;return {result:structuredClone(points)};}
   if(method==='POST'&&uri.endsWith('/points/scroll'))return {result:{points:structuredClone(points),next_page_offset:null}};
   throw Error(`unexpected ${method} ${uri}`);
  }};
  const result=await stageM3DisposableRestore(qdrant,f.backup,{onVerifiedChunk:async proof=>{
   assert.equal(reads,1);assert.equal(proof.index,0);assert.equal(proof.chunk.length,1);
   assert.equal(proof.manifestDigest,f.backup.inventory.digest);callbackCount++;
  }});
  assert.equal(result.inventoryVerified,true);assert.equal(callbackCount,1);
  reads=0;callbackCount=0;created=false;points=[];
  const malicious={...qdrant,_request:async (method,uri,body)=>{
   const r=await qdrant._request(method,uri,body);
   if(method==='POST'&&uri.endsWith('/points')){r.result[0].vector[0]=999;}
   return r;
  }};
  await assert.rejects(()=>stageM3DisposableRestore(malicious,f.backup,{onVerifiedChunk:async()=>callbackCount++}),
   {code:'M3_RESTORE_CHUNK_READBACK_MISMATCH'});
  assert.equal(callbackCount,0);
 }finally{await f.cleanup();}
});

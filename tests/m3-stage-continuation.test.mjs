import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {M3Store} from '../lib/m3-collections.js';
import {M3PhysicalProgress} from '../lib/m3-physical-progress.js';
import {inspectM3StageContinuation} from '../lib/m3-stage-continuation.js';
const H=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const A='a'.repeat(64),B='b'.repeat(64);
async function setup(){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'m3-cont-'));await fs.chmod(dir,0o700);
 const ctx={userScopeId:'alice',vectorsPath:dir},store=new M3Store(ctx),id=randomUUID(),oldId=randomUUID(),targetId=randomUUID();
 const model={dimension:2,metric:'cosine',source:'local',model:'new'},source={kind:'lorebook',name:'test'};
 const rows=Array.from({length:40},(_,i)=>({id:randomUUID(),vector:[i,2],payload:{index:i}})).sort((x,y)=>x.id.localeCompare(y.id));
 const manifest=H(rows),physicalName='vh2_'+H(['m3-fresh-restore',targetId,id]).slice(0,48);
 await store.write('operation',{schemaVersion:1,owner:'alice',operationId:id,backupId:oldId,action:'rebuild',
  backend:'qdrant',logicalKey:A,targetLogicalKey:B,expectedCount:40,source,configId:'default',
  sourceFingerprint:'saved',targetProfileHash:H(model)});
 await store.write('backup',{owner:'alice',backupId:oldId,logicalKey:A,physicalName:'old',embedding:model});
 await store.write('backup',{owner:'alice',backupId:targetId,derivedFromBackupId:oldId,logicalKey:B,
  purpose:'M3_NEW_MODEL_STAGED_NO_CUTOVER',physicalName:'reserved',sourceId:'src',embedding:model,
  inventory:{rows,count:40,digest:manifest}});
 await new M3PhysicalProgress(ctx,id).recordVerified({index:0,physicalName,targetBackupId:targetId,
  manifestDigest:manifest,chunkDigest:H(rows.slice(0,32)),recordCount:32});
 const req={s03:ctx,user:{directories:{}}};
 let points=rows.slice(0,32).map(x=>structuredClone(x));
 const deps={store:()=>store,audit:async()=>({claimed:true,lastStage:'DISPATCH_PENDING'}),
  readSnapshot:async()=>({fileHash:'saved',sourceId:'src'}),getStagedProfile:async()=>({profile:model}),
  transport:async()=>({_request:async(method,url)=>{
   if(method==='GET')return {result:{config:{params:{vectors:{size:2,distance:'Cosine'}}}}};
   if(method==='POST'&&url.endsWith('/points/scroll'))return {result:{points,next_page_offset:null}};
   throw Error('unexpected');
  }})};
 return {ctx,id,req,deps,rows,physicalName,changePoints:xs=>points=xs,close:()=>fs.rm(dir,{recursive:true,force:true})};
}
test('exact prefix readback certifies only observation, never resume or unlock',async()=>{
 const f=await setup();try{const v=await inspectM3StageContinuation(f.req,f.id,f.deps);
  assert.equal(v.prefixCount,32);assert.equal(v.nextChunkIndex,1);
  assert.equal(v.totalCount,40);assert.equal(v.automaticResumeAuthorized,false);
  assert.equal(v.lockReleaseAuthorized,false);assert.equal(v.classification,'EXACT_PREFIX_VERIFIED');
 }finally{await f.close();}
});
test('uncheckpointed, missing, corrupted and foreign physical points all refuse',async()=>{
 const f=await setup();try{
  f.changePoints(f.rows.slice(0,33));
  await assert.rejects(()=>inspectM3StageContinuation(f.req,f.id,f.deps),{code:'M3_CONTINUATION_UNACCOUNTED_POINTS'});
  f.changePoints(f.rows.slice(0,31));
  await assert.rejects(()=>inspectM3StageContinuation(f.req,f.id,f.deps),{code:'M3_CONTINUATION_UNACCOUNTED_POINTS'});
  const changed=f.rows.slice(0,32).map(x=>structuredClone(x));changed[0].payload.index=999;
  f.changePoints(changed);
  await assert.rejects(()=>inspectM3StageContinuation(f.req,f.id,f.deps),{code:'M3_CONTINUATION_POINT_CHANGED'});
 }finally{await f.close();}
});
test('source or profile changes invalidate exact physical frontier',async()=>{
 const f=await setup();try{
  f.deps.readSnapshot=async()=>({fileHash:'changed',sourceId:'src'});
  await assert.rejects(()=>inspectM3StageContinuation(f.req,f.id,f.deps),{code:'M3_CONTINUATION_SOURCE_CHANGED'});
  f.deps.readSnapshot=async()=>({fileHash:'saved',sourceId:'src'});
  f.deps.getStagedProfile=async()=>({profile:{dimension:2,metric:'cosine',model:'other'}});
  await assert.rejects(()=>inspectM3StageContinuation(f.req,f.id,f.deps),{code:'M3_CONTINUATION_MODEL_CHANGED'});
 }finally{await f.close();}
});

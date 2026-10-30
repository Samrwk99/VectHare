import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {CollectionRegistry} from '../lib/s02-registry.js';
import {inspectM3LifecycleRecovery} from '../lib/m3-execution-audit.js';
import {collectionIdentity,recordIdentity,contentFingerprint} from '../lib/s02-identity.js';
import {previewM4aLance,captureM4aLanceBackup,verifyM4aLanceBackup,
 validateM4aLanceSelector,registerM4aLanceRoutes,planM4aLanceDelete,executeM4aLanceDelete} from '../lib/m4a-lancedb-lifecycle.js';
const sha=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const scope={userScopeId:'alice',collectionId:'chat',type:'chat',sourceId:'saved-chat',branchId:'branch'};
const embedding={source:'transformers',model:'fixture',dimension:3,metric:'dot'};
const identity=collectionIdentity({backend:'lancedb',scope,embedding});
const binding={authorized:true,provenance:'SERVER_VERIFIED',backend:'lancedb',scope,embedding,
 collection:{key:identity.key,physicalName:identity.physicalName}};
const source={kind:'chat',avatar:'character.png',chatFile:'saved.jsonl'};
const makeRow=(recordId=randomUUID(),other={})=>{
 const text='saved line',vector=[0.25,0.5,0.75];
 const meta={vecthareRecordV2:{schemaVersion:2,recordId,
  identity:{userScopeId:'alice',sourceId:'saved-chat'},contentHash:contentFingerprint(text),revision:1}};
 return {physicalId:recordIdentity(scope,recordId).physicalId,recordId,...scope,schemaVersion:2,
  revision:1,text,textHash:contentFingerprint(text),metadata:JSON.stringify(meta),metadataHash:sha(meta),
  embedding:JSON.stringify(embedding),vector,vectorHash:sha(vector),...other};
};
async function fixture(){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'m4a-lifecycle-'));await fs.chmod(root,0o700);
 const ctx={userScopeId:'alice',vectorsPath:root};const rows=[];
 const table={schema:{fields:[...['physicalId','recordId','userScopeId','collectionId','type','sourceId','branchId','text','textHash',
   'metadata','metadataHash','embedding','vectorHash'].map(name=>({name,nullable:false})),
  {name:'schemaVersion'},{name:'revision'},{name:'vector',type:{listSize:3}}]},
  async countRows(){return rows.length},
  query(){let offset=0,limit=Infinity,sort=false;const q={orderBy(){sort=true;return q},
   offset(n){offset=n;return q},limit(n){limit=n;return q},async toArray(){let res=rows.slice();
    if(sort)res.sort((a,b)=>a.physicalId.localeCompare(b.physicalId));return structuredClone(res.slice(offset,offset+limit));}};
   return q;}};
 let removed=false,failAfterDrop=false;
 const db={async tableNames(){return removed?[]:[identity.physicalName]},async openTable(){if(removed)throw Error('TABLE_GONE');return table},
  async dropTable(name){assert.equal(name,identity.physicalName);removed=true;rows.splice(0);if(failAfterDrop)throw Error('LOST_ACK');}};
 const req={s03:ctx,user:{directories:{}},body:{backend:'lancedb',source}};
 const records={};const managed=()=>({records,fingerprint:sha(records)});
 let fileHash='original';let connectionCalls=0,lockCalls=0;
 const deps={getProfile:async()=>({configured:true,profile:embedding,selected:false}),
  bind:async()=>({binding}),readSnapshot:async()=>({sourceId:scope.sourceId,fileHash}),
  receipt:async()=>({state:'SCHEMA_VERIFIED_OFFLINE_UNCERTIFIED'}),
  registry:()=>({read:async()=>managed()}),jobs:()=>({assertNoLease:async()=>{}}),
  connection:async()=>{connectionCalls++;return {getDatabase:async()=>db}},
  ledgerCheckpoint:async()=>({count:0,digest:sha([])}),
  boundary:()=>({withWriteBoundary:async(plan,cb)=>{lockCalls++;return cb()}})};
 return {root,req,ctx,deps,rows,records,get connectionCalls(){return connectionCalls},
  get lockCalls(){return lockCalls},get removed(){return removed},failAfterDrop:()=>{failAfterDrop=true},
  setFileHash:x=>{fileHash=x},cleanup:()=>fs.rm(root,{recursive:true,force:true})};
}
test('M4a backup public selector refuses spoofed scope, arbitrary names and absent confirmation',()=>{
 for(const body of [{backend:'lancedb',source,physicalName:'escape'},
  {backend:'qdrant',source},{backend:'lancedb',source:{...source,owner:'someone'}},
  {backend:'lancedb',source,configId:'local'}])
  assert.throws(()=>validateM4aLanceSelector(body),{code:/M4A_.*INVALID/});
 assert.throws(()=>validateM4aLanceSelector({backend:'lancedb',source},{backup:true}),
  {code:'M4A_BACKUP_CONFIRMATION_REQUIRED'});
});
test('M4a read-only preview and durable backup use authenticated source, full physical inventory and immutable verification',async()=>{
 const f=await fixture();try{
  const p=await previewM4aLance(f.req,f.deps);assert.equal(p.recordCount,0);
  assert.equal(p.operationModes.backup,'ENABLED');assert.equal(p.operationModes.delete,'ENABLED');
  f.req.body={...f.req.body,confirmation:'CAPTURE OWNED LOGICAL BACKUP'};
  const b=await captureM4aLanceBackup(f.req,f.deps);
  assert.equal(b.state,'VERIFIED');assert.equal(b.count,0);
  const v=await verifyM4aLanceBackup(f.req,b.backupId,f.deps);
  assert.equal(v.backend,'lancedb');assert.equal(v.integrityVerified,true);
  assert.ok(f.lockCalls>=2);assert.ok(f.connectionCalls>=3);
  const dest=path.join(f.root,'.similharity','m3-lifecycle',`backup-${b.backupId}.json`);
  const doc=JSON.parse(await fs.readFile(dest,'utf8'));doc.inventory.count=5;
  await fs.writeFile(dest,JSON.stringify(doc)+'\n');
  await assert.rejects(()=>verifyM4aLanceBackup(f.req,b.backupId,f.deps),{code:'M3_DOCUMENT_CORRUPT'});
 }finally{await f.cleanup();}
});
test('M4a backup rejects physical foreign row, unmanaged row, changed source and missing schema receipt',async()=>{
 const f=await fixture();try{
  f.req.body.confirmation='CAPTURE OWNED LOGICAL BACKUP';
  f.rows.push(makeRow());
  await assert.rejects(()=>captureM4aLanceBackup(f.req,f.deps),{code:'M3_UNMANAGED_RECORDS_PRESENT'});
  const raw=f.rows[0];f.records[raw.recordId]={state:'ACTIVE',revision:1,contentHash:raw.textHash};
  const result=await captureM4aLanceBackup(f.req,f.deps);assert.equal(result.count,1);
  f.rows.push(makeRow(randomUUID(),{userScopeId:'intruder'}));
  await assert.rejects(()=>captureM4aLanceBackup(f.req,f.deps),{code:'S05_OWNER_MISMATCH'});
  f.rows.pop();f.setFileHash('changed');
  // A fresh snapshot is now authoritative; no stale client value is trusted.
  assert.equal((await captureM4aLanceBackup(f.req,f.deps)).count,1);
  f.deps.receipt=async()=>({state:'PREPARED'});
  await assert.rejects(()=>captureM4aLanceBackup(f.req,f.deps),{code:'M4A_PROVISION_RECEIPT_REQUIRED'});
 }finally{await f.cleanup();}
});
test('M4a HTTP registers separate guarded collection transition plan/execute routes',()=>{
 const methods=[];const router={post:(route)=>methods.push(['POST',route]),get:(route)=>methods.push(['GET',route])};
 registerM4aLanceRoutes(router);
 assert.equal(methods.length,7);
 assert.ok(methods.every(([,route])=>route.startsWith('/v2/m4a/lancedb/')));
 assert.equal(methods.some(([,route])=>/purge-all|\/backups\/restore/.test(route)),false);
 assert.ok(methods.some(([,route])=>route.endsWith('/transition/execute')));
 assert.ok(methods.some(([,route])=>route.endsWith('/delete/execute')));
});
test('M4a backup refuses when physical/logical collection writer boundary is already held',async()=>{
 const f=await fixture();try{
  delete f.deps.boundary;
  const {runtimeWriterBoundary}=await import('../lib/f09c10-runtime-boundary.js');
  const plan={backend:'lancedb',scope,collectionKey:identity.key,
   physicalCollectionName:identity.physicalName,operationId:randomUUID()};
  const boundary=await runtimeWriterBoundary(f.ctx,plan);
  await boundary.withWriteBoundary(plan,async()=>{
   await assert.rejects(()=>previewM4aLance(f.req,f.deps),
    e=>['F09C5_WRITER_BUSY','M3_LOGICAL_COLLECTION_BUSY'].includes(e?.code));
  });
  assert.equal((await previewM4aLance(f.req,f.deps)).recordCount,0);
 }finally{await f.cleanup();}
});

async function withOwnedBackup(f){
 const r=new CollectionRegistry(path.join(f.root,'.similharity'));
 await r.reserve({backend:'lancedb',scope,embedding});
 f.req.body={backend:'lancedb',source,confirmation:'CAPTURE OWNED LOGICAL BACKUP'};
 const saved=await captureM4aLanceBackup(f.req,f.deps);
 f.req.body={backend:'lancedb',source,backupId:saved.backupId};
 return saved;
}
test('M4a guarded LanceDB delete: immutable backup -> one-use plan -> tombstone and replay refusal',async()=>{
 const f=await fixture();try{
  // Use the real filesystem-based S02/M3 stores and real cooperative writer
  // boundary, not the fixture's in-memory lock stub.
  delete f.deps.boundary;
  const b=await withOwnedBackup(f);
  const plan=await planM4aLanceDelete(f.req,f.deps);
  assert.equal(plan.state,'PLANNED');assert.equal(plan.backupId,b.backupId);
  f.req.body={operationId:plan.operationId,confirmation:'DELETE OWNED LANCEDB COLLECTION'};
  const result=await executeM4aLanceDelete(f.req,f.deps);
  assert.equal(result.state,'VERIFIED');assert.equal(f.removed,true);
  const r=new CollectionRegistry(path.join(f.root,'.similharity'));
  assert.equal((await r.lookup({backend:'lancedb',scope,embedding})).status,'DELETED');
  const evidence=await inspectM3LifecycleRecovery(f.ctx,plan.operationId);
  assert.equal(evidence.lastStage,'COMMITTED');assert.equal(evidence.eventCount,4);
  await assert.rejects(()=>executeM4aLanceDelete(f.req,f.deps));
 }finally{await f.cleanup();}
});
test('M4a LanceDB delete refuses stale inventory and leaves replayable plan unclaimed',async()=>{
 const f=await fixture();try{
  delete f.deps.boundary;
  const backup=await withOwnedBackup(f);
  const plan=await planM4aLanceDelete(f.req,f.deps);
  f.rows.push(makeRow());
  f.req.body={operationId:plan.operationId,confirmation:'DELETE OWNED LANCEDB COLLECTION'};
  await assert.rejects(()=>executeM4aLanceDelete(f.req,f.deps),
   e=>['M3_UNMANAGED_RECORDS_PRESENT','M4A_DELETE_PHYSICAL_CHANGED'].includes(e?.code));
  assert.equal(f.removed,false);
  const evidence=await inspectM3LifecycleRecovery(f.ctx,plan.operationId);
  assert.equal(evidence.claimed,false);
  const another=await planM4aLanceDelete({ ...f.req,body:{backend:'lancedb',source,backupId:backup.backupId}},f.deps)
   .catch(e=>e);
  assert.ok(another.code); // stale snapshot cannot generate a new plan
 }finally{await f.cleanup();}
});
test('M4a LanceDB delete lost-ack retains physical and logical locks; cannot replay',async()=>{
 const f=await fixture();try{
  delete f.deps.boundary;
  await withOwnedBackup(f);
  const plan=await planM4aLanceDelete(f.req,f.deps);
  f.failAfterDrop();
  f.req.body={operationId:plan.operationId,confirmation:'DELETE OWNED LANCEDB COLLECTION'};
  await assert.rejects(()=>executeM4aLanceDelete(f.req,f.deps),/LOST_ACK/);
  const evidence=await inspectM3LifecycleRecovery(f.ctx,plan.operationId);
  assert.equal(evidence.claimed,true);assert.equal(evidence.lastStage,'DISPATCH_PENDING');
  assert.equal(evidence.physicalLockReleaseAuthorized,false);
  await assert.rejects(()=>executeM4aLanceDelete(f.req,f.deps),
   e=>['M3_LOGICAL_COLLECTION_BUSY','F09C5_WRITER_BUSY'].includes(e?.code));
 }finally{await f.cleanup();}
});
test('M4a LanceDB delete plan rejects any untrusted source selection, forged backup, stale saved source',async()=>{
 const f=await fixture();try{
  delete f.deps.boundary;const b=await withOwnedBackup(f);
  await assert.rejects(()=>planM4aLanceDelete({...f.req,body:{...f.req.body,physicalName:'evil'}},f.deps),
   {code:'M4A_DELETE_PLAN_SELECTOR_INVALID'});
  await assert.rejects(()=>planM4aLanceDelete({...f.req,body:{...f.req.body,backupId:randomUUID()}},f.deps));
  f.setFileHash('changed');
  await assert.rejects(()=>planM4aLanceDelete(f.req,f.deps),{code:'M4A_DELETE_BACKUP_OR_SOURCE_CHANGED'});
  assert.ok(b.backupId);
 }finally{await f.cleanup();}
});

test('M4a LanceDB deletion verifies one owned record and retains a full backup',async()=>{
 const f=await fixture();try{
  delete f.deps.boundary;
  const r=makeRow();f.rows.push(r);
  f.records[r.recordId]={state:'ACTIVE',revision:1,contentHash:r.textHash};
  const b=await withOwnedBackup(f);assert.equal(b.count,1);
  const p=await planM4aLanceDelete(f.req,f.deps);assert.equal(p.recordCount,1);
  f.req.body={operationId:p.operationId,confirmation:'DELETE OWNED LANCEDB COLLECTION'};
  const done=await executeM4aLanceDelete(f.req,f.deps);
  assert.equal(done.state,'VERIFIED');
  const original=await verifyM4aLanceBackup(f.req,b.backupId,f.deps);
  assert.equal(original.recordCount,1);assert.equal(original.integrityVerified,true);
 }finally{await f.cleanup();}
});

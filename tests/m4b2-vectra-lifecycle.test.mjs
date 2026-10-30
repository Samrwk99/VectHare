import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {collectionIdentity,recordIdentity,contentFingerprint} from '../lib/s02-identity.js';
import {m4bVectraLifecycleAdapter} from '../lib/m4b-vectra-contract.js';
import {validateM4bVectraSelector,previewM4bVectra,captureM4bVectraBackup,
 verifyM4bVectraBackup,planM4bVectraDelete,executeM4bVectraDelete} from '../lib/m4b-vectra-lifecycle.js';
import {planM4bVectraTransition,executeM4bVectraTransition} from '../lib/m4b-vectra-transactions.js';
import {resolveM4bVectraReadBinding} from '../lib/m4b-vectra-cutover.js';
const H=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const scope={userScopeId:'alice',collectionId:'chat',type:'chat',sourceId:'saved-chat',branchId:'branch'};
const embedding={source:'transformers',model:'fixture',dimension:3,metric:'dot'};
const identity=collectionIdentity({backend:'vectra',scope,embedding});
const binding={authorized:true,provenance:'SERVER_VERIFIED',backend:'vectra',scope,embedding,
 collection:{key:identity.key,physicalName:identity.physicalName}};
const source={kind:'chat',avatar:'character.png',chatFile:'saved.jsonl'};
const makeRow=(recordId=randomUUID(),overrides={})=>{
 const text='saved line',vector=[.25,.5,.75];
 const metadata={vecthareRecordV2:{schemaVersion:2,recordId,
  identity:{userScopeId:'alice',sourceId:'saved-chat'},contentHash:contentFingerprint(text),revision:1}};
 return {physicalId:recordIdentity(scope,recordId).physicalId,recordId,...scope,revision:1,
 text,textHash:contentFingerprint(text),metadata,metadataHash:H(metadata),embedding,vector,vectorHash:H(vector),...overrides};
};
async function setup(){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'m4b-lifecycle-'));await fs.chmod(root,0o700);
 const dir=path.join(root,'vectra-v2');await fs.mkdir(dir,{mode:0o700});
 const folder=path.join(dir,identity.physicalName);await fs.mkdir(folder,{mode:0o700});
 await fs.writeFile(path.join(folder,'index.json'),'{}',{mode:0o600});
 const rows=[];let removed=false,failDeletion=false;
 const idx={async isIndexCreated(){return !removed},async getItem(id){return rows.find(r=>r.id===id)??null},
  async listItems(){return structuredClone(rows)}};
 const connection={index:idx,s08ServerSchema:{schemaVersion:2,provenance:'SERVER_REGISTRY',
  collectionKey:identity.key,physicalName:identity.physicalName,embedding}};
 const ctx={userScopeId:'alice',vectorsPath:root};const req={s03:ctx,user:{directories:{}},body:{backend:'vectra',source}};
 const records={};let savedManaged=null;const managed=()=>savedManaged??({records,fingerprint:H(records)});
 let fileHash='initial';const s02={async lookup(){return {key:identity.key,physicalName:identity.physicalName,status:'RESERVED_NOT_ACTIVE'}},
  async tombstone(){if(failDeletion)throw Error('TOMBSTONE_FAILED');return {status:'DELETED'}}};
 const indexStores=new Map([[folder,rows]]);
 const makeVectraIndex=location=>{
  let entries=indexStores.get(location);
  return {async isIndexCreated(){return indexStores.has(location)},
   async createIndex(){await fs.mkdir(location,{mode:0o700});await fs.writeFile(path.join(location,'index.json'),'{}',{mode:0o600});entries=[];indexStores.set(location,entries);},
   async listItems(){return structuredClone(entries??[])},
   async getItem(id){return structuredClone((entries??[]).find(r=>r.id===id)??null)},
   async beginUpdate(){},async endUpdate(){},async cancelUpdate(){},
   async insertItem(row){entries.push(structuredClone(row));}};
 };
 const deps={getProfile:async()=>({configured:true,selected:false,profile:embedding}),bind:async()=>({binding}),
  readSnapshot:async()=>({sourceId:scope.sourceId,fileHash}),receipt:async()=>({state:'SCHEMA_VERIFIED_OFFLINE_UNCERTIFIED'}),
  registry:()=>({read:async()=>managed(),lock:async work=>work(),save:async doc=>{savedManaged={...doc,fingerprint:H(doc)}}}),
  jobs:()=>({assertNoLease:async()=>{}}),createVectra:async(_req,b)=>({index:makeVectraIndex(path.join(root,'vectra-v2',b.collection.physicalName)),
  s08ServerSchema:{schemaVersion:2,provenance:'SERVER_REGISTRY',collectionKey:b.collection.key,physicalName:b.collection.physicalName,embedding:b.embedding}}),
  boundary:()=>({withWriteBoundary:async(_plan,work)=>work()}),s02:()=>s02,makeVectraIndex,
  ledgerCheckpoint:async()=>({count:0,digest:H([])})};
 return {root,folder,rows,records,req,ctx,deps,binding,connection,
  add(row){rows.push({id:row.physicalId,vector:row.vector,metadata:Object.fromEntries(Object.entries(row).filter(([k])=>k!=='vector'))});
   records[row.recordId]={state:'ACTIVE',revision:row.revision,contentHash:row.textHash};},
  setHash:x=>{fileHash=x},failTombstone:()=>{failDeletion=true},clean:()=>fs.rm(root,{recursive:true,force:true})};
}
test('Vectra backup selector denies arbitrary path, vectors, owner and wrong backend',()=>{
 for(const input of [{backend:'vectra',source,folder:'/tmp'},
   {backend:'vectra',source:{...source,owner:'bob'}},{backend:'qdrant',source},
   {backend:'vectra',source,vector:[1,2,3]}])assert.throws(()=>validateM4bVectraSelector(input));
 assert.throws(()=>validateM4bVectraSelector({backend:'vectra',source},{backup:true}),
  {code:'M4B_BACKUP_CONFIRMATION_REQUIRED'});
});
test('Vectra full inventory and verified durable logical backup (including populated index)',async()=>{
 const f=await setup();try{
  f.add(makeRow());
  const preview=await previewM4bVectra(f.req,f.deps);assert.equal(preview.recordCount,1);
  f.req.body.confirmation='CAPTURE OWNED LOGICAL BACKUP';
  const backup=await captureM4bVectraBackup(f.req,f.deps);assert.equal(backup.count,1);
  const check=await verifyM4bVectraBackup(f.req,backup.backupId,f.deps);
  assert.equal(check.integrityVerified,true);
  const document=path.join(f.root,'.similharity','m3-lifecycle',`backup-${backup.backupId}.json`);
  const stored=JSON.parse(await fs.readFile(document,'utf8'));stored.inventory.count=20;
  await fs.writeFile(document,JSON.stringify(stored));
  await assert.rejects(()=>verifyM4bVectraBackup(f.req,backup.backupId,f.deps),{code:'M3_DOCUMENT_CORRUPT'});
 }finally{await f.clean();}
});
test('Vectra inventory refuses foreign and unregistered rows, symlink index, duplicate IDs',async()=>{
 const f=await setup();try{
  const a=makeRow();f.add(a);const idx=m4bVectraLifecycleAdapter({backend:f.connection,
   ctx:f.ctx,binding:f.binding,writerBoundary:async fn=>fn()});
  assert.equal((await idx.getInventory()).count,1);
  f.add(makeRow(randomUUID(),{userScopeId:'foreign'}));
  await assert.rejects(()=>idx.getInventory(),{code:'S05_OWNER_MISMATCH'});
  f.rows.pop();f.rows.push(structuredClone(f.rows[0]));
  await assert.rejects(()=>idx.getInventory(),{code:'M4B_DUPLICATE_ID'});
  f.rows.pop();await fs.rm(path.join(f.folder,'index.json'));
  await fs.symlink(path.join(f.root,'no-file'),path.join(f.folder,'index.json'));
  await assert.rejects(()=>idx.getInventory(),{code:'M4B_INDEX_FILE_UNTRUSTED'});
 }finally{await f.clean();}
});
test('Vectra one-use deletion requires matching backup, typed consent, verified physical absence and tombstone',async()=>{
 const f=await setup();try{
  f.add(makeRow());f.req.body.confirmation='CAPTURE OWNED LOGICAL BACKUP';
  const backup=await captureM4bVectraBackup(f.req,f.deps);
  f.req.body={backend:'vectra',source,backupId:backup.backupId};
  const plan=await planM4bVectraDelete(f.req,f.deps);
  assert.equal(plan.requiredConfirmation,'DELETE OWNED VECTRA COLLECTION');
  f.req.body={operationId:plan.operationId,confirmation:'DELETE OWNED VECTRA COLLECTION'};
  const outcome=await executeM4bVectraDelete(f.req,f.deps);
  assert.equal(outcome.registryTombstoned,true);
  await assert.rejects(()=>fs.stat(f.folder),{code:'ENOENT'});
  assert.equal((await verifyM4bVectraBackup(f.req,backup.backupId,f.deps)).integrityVerified,true);
  await assert.rejects(()=>executeM4bVectraDelete(f.req,f.deps));
 }finally{await f.clean();}
});
test('Vectra stale backup forbids delete after record change',async()=>{
 const f=await setup();try{
  f.add(makeRow());f.req.body.confirmation='CAPTURE OWNED LOGICAL BACKUP';
  const b=await captureM4bVectraBackup(f.req,f.deps);
  const r=makeRow();f.add(r);
  f.req.body={backend:'vectra',source,backupId:b.backupId};
  await assert.rejects(()=>planM4bVectraDelete(f.req,f.deps));
  assert.equal((await fs.stat(f.folder)).isDirectory(),true);
 }finally{await f.clean();}
});

test('Vectra scoped empty publishes new generation without deleting the original index',async()=>{
 const f=await setup();try{
  f.req.body.confirmation='CAPTURE OWNED LOGICAL BACKUP';
  const backup=await captureM4bVectraBackup(f.req,f.deps);
  f.req.body={backend:'vectra',source,backupId:backup.backupId,action:'empty'};
  const plan=await planM4bVectraTransition(f.req,f.deps);
  assert.equal(plan.requiredConfirmation,'EMPTY OWNED VECTRA COLLECTION');
  f.req.body={operationId:plan.operationId,confirmation:'EMPTY OWNED VECTRA COLLECTION'};
  const result=await executeM4bVectraTransition(f.req,f.deps);
  assert.equal(result.state,'VERIFIED');assert.equal(result.generation,1);
  assert.notEqual(result.physicalName,identity.physicalName);
  assert.equal((await fs.lstat(f.folder)).isDirectory(),true);
  // Post-publication resolver validates the immutable target receipt.
  const resolved=await resolveM4bVectraReadBinding(f.ctx,binding,{makeIndex:f.deps.makeVectraIndex,registry:f.deps.registry()});
  assert.equal(resolved.collection.physicalName,result.physicalName);
 }finally{await f.clean();}
});
test('Vectra populated index -> empty generation -> verified immediate restore retains both historical indexes',async()=>{
 const f=await setup();try{
  f.add(makeRow());f.req.body.confirmation='CAPTURE OWNED LOGICAL BACKUP';
  const backup=await captureM4bVectraBackup(f.req,f.deps);
  f.req.body={backend:'vectra',source,backupId:backup.backupId,action:'empty'};
  const planned=await planM4bVectraTransition(f.req,f.deps);
  f.req.body={operationId:planned.operationId,confirmation:'EMPTY OWNED VECTRA COLLECTION'};
  const emptied=await executeM4bVectraTransition(f.req,f.deps);
  assert.equal(emptied.verifiedEmpty,true);
  const alias=await resolveM4bVectraReadBinding(f.ctx,binding,{makeIndex:f.deps.makeVectraIndex,registry:f.deps.registry()});
  assert.equal(alias.collection.generation,1);
  f.req.body={backend:'vectra',source,backupId:backup.backupId,action:'restore'};
  const restoredPlan=await planM4bVectraTransition(f.req,f.deps);
  f.req.body={operationId:restoredPlan.operationId,confirmation:'RESTORE OWNED VECTRA COLLECTION'};
  const restored=await executeM4bVectraTransition(f.req,f.deps);
  assert.equal(restored.restoredCount,1);assert.equal(restored.generation,2);
  const refreshed=await resolveM4bVectraReadBinding(f.ctx,binding,{makeIndex:f.deps.makeVectraIndex,registry:f.deps.registry()});
  assert.equal(refreshed.collection.physicalName,restored.physicalName);
  assert.equal((await fs.stat(f.folder)).isDirectory(),true);
 }finally{await f.clean();}
});
test('Vectra lost deletion acknowledgement retains one-use claim and quarantine locks; no blind replay',async()=>{
 const f=await setup();try{
  f.add(makeRow());f.req.body.confirmation='CAPTURE OWNED LOGICAL BACKUP';
  const backup=await captureM4bVectraBackup(f.req,f.deps);
  f.req.body={backend:'vectra',source,backupId:backup.backupId};
  const plan=await planM4bVectraDelete(f.req,f.deps);
  f.failTombstone();
  f.req.body={operationId:plan.operationId,confirmation:'DELETE OWNED VECTRA COLLECTION'};
  await assert.rejects(()=>executeM4bVectraDelete(f.req,f.deps),/TOMBSTONE_FAILED/);
  const root=path.join(f.root,'.similharity');
  const claim=JSON.parse(await fs.readFile(path.join(root,'m3-lifecycle',`claimed-${plan.operationId}.json`),'utf8'));
  assert.equal(claim.operationId,plan.operationId);
  assert.equal((await fs.readdir(path.join(root,'m3-logical-locks'))).filter(s=>s.endsWith('.lock')).length,1);
  assert.equal((await fs.readdir(path.join(root,'f09c10-writer-locks'))).filter(s=>s.endsWith('.lock')).length,1);
  await assert.rejects(()=>executeM4bVectraDelete(f.req,f.deps));
 }finally{await f.clean();}
});
test('Vectra transition after journal preparation failure retains logical lock, old generation and claim',async()=>{
 const f=await setup();try{
  f.req.body.confirmation='CAPTURE OWNED LOGICAL BACKUP';
  const backup=await captureM4bVectraBackup(f.req,f.deps);
  f.req.body={backend:'vectra',source,backupId:backup.backupId,action:'empty'};
  const plan=await planM4bVectraTransition(f.req,f.deps);
  const deps={...f.deps,checkStage:async()=>{throw Error('SIMULATED_LOST_STAGE_ACK');}};
  f.req.body={operationId:plan.operationId,confirmation:'EMPTY OWNED VECTRA COLLECTION'};
  await assert.rejects(()=>executeM4bVectraTransition(f.req,deps),/SIMULATED_LOST_STAGE_ACK/);
  const root=path.join(f.root,'.similharity');
  assert.equal((await fs.readdir(path.join(root,'m3-logical-locks'))).filter(s=>s.endsWith('.lock')).length,1);
  assert.equal((await fs.stat(f.folder)).isDirectory(),true);
  await assert.rejects(()=>executeM4bVectraTransition(f.req,deps));
 }finally{await f.clean();}
});

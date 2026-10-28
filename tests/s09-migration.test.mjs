import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {buildMigrationManifest,verifyManifest,MigrationError} from '../lib/s09-manifest.js';
import {rehearseFixture,verifyFixtureSession,rollbackFixtureSession} from '../lib/s09-fixture.js';
const embedding={source:'transformers',model:'example',dimension:3,metric:'cosine'};
const a={userScopeId:'user-1',collectionId:'collection-1',type:'chat',sourceId:'chat-1'};
const b={...a,branchId:'branch-B'};
const c={...a,userScopeId:'user-2'};
function record(name,hash,scope,extra={}) {
 return {legacyPhysicalName:name,legacyHash:hash,recordId:randomUUID(),text:'test '+hash,vector:[1,0,0],metadata:{},...extra};
}
function mapping(r,scope,ev='server-evidence-001') {
 return {legacyPhysicalName:r.legacyPhysicalName,legacyHash:r.legacyHash,scope,evidenceId:ev};
}
function input(records,ownerMappings,extra={}) {
 return {backend:'qdrant',embedding,records,ownerMappings,inventoryEvidence:{reference:'snapshot-claim-001'},...extra};
}
function code(fn,expected) {assert.throws(fn,e=>e.code===expected);}
async function asyncCode(fn,expected){await assert.rejects(fn,e=>e.code===expected);}
const one=()=>{const r=record('legacy_A',11,a);return input([r],[mapping(r,a)]);};
test('S09 refuses ownerVerified client metadata without separate owner mapping',()=>{
 const i=one();i.ownerMappings=[];i.records[0].ownerVerified=true;i.records[0].scope=a;
 const m=buildMigrationManifest(i);assert.equal(m.mappedCount,0);assert.equal(m.quarantinedCount,1);assert.equal(m.cutoverAllowed,false);
});
test('S09 stable manifest and source integrity verification',()=>{
 const i=one(),m=buildMigrationManifest(i);assert.equal(m.mappedCount,1);assert.equal(m.unresolved.length,0);
 assert.equal(m.evidenceStatus,'UNVERIFIED_CLAIMS');assert.equal(m.snapshotConsistency,'UNPROVEN');
 assert.equal(verifyManifest(m,i),true);
});
test('S09 detects modified manifest even with reused original input',()=>{
 const i=one(),original=buildMigrationManifest(i);const m=JSON.parse(JSON.stringify(original));m.mappings[0].scope.userScopeId='attacker';
 code(()=>verifyManifest(m,i),'S09_MANIFEST_TAMPERED');
});
test('S09 detects changed input despite unchanged manifest',()=>{
 const i=one(),m=buildMigrationManifest(i);i.records[0].text='changed';
 code(()=>verifyManifest(m,i),'S09_SOURCE_CHANGED');
});
test('S09 quarantines duplicate physical hash locator, including first occurrence',()=>{
 const r1=record('legacy_A',99,a),r2=record('legacy_A',99,b);
 const m=buildMigrationManifest(input([r1,r2],[mapping(r1,a)]));
 assert.equal(m.mappedCount,0);assert.equal(m.quarantinedCount,2);
 assert.ok(m.unresolved.some(e=>e.code==='S09_DUPLICATE_LEGACY_LOCATOR'));
});
test('S09 permits equal content hashes in different legacy physical collections and branches',()=>{
 const r1=record('legacy_A',99,a),r2=record('legacy_B',99,b);
 const m=buildMigrationManifest(input([r1,r2],[mapping(r1,a),mapping(r2,b,'server-evidence-002')]));
 assert.equal(m.mappedCount,2);assert.notEqual(m.mappings[0].targetPhysicalId,m.mappings[1].targetPhysicalId);
 assert.notEqual(m.mappings[0].targetPhysicalName,m.mappings[1].targetPhysicalName);
});
test('S09 refuses ambiguous independent owner mapping claims',()=>{
 const i=one();i.ownerMappings.push(mapping(i.records[0],c,'server-evidence-002'));
 const m=buildMigrationManifest(i);assert.equal(m.mappedCount,0);
 assert.ok(m.unresolved.some(x=>x.code==='S09_OWNER_MAPPING_CONFLICT'));
});
test('S09 quarantines missing or malformed evidence ref',()=>{
 const i=one();i.ownerMappings[0].evidenceId='client';
 const m=buildMigrationManifest(i);assert.equal(m.mappedCount,0);
});
test('S09 refuses large or malformed hashes without JS numeric truncation',()=>{
 const i=one();i.records[0].legacyHash='9007199254740993';i.ownerMappings[0].legacyHash='9007199254740993';
 const m=buildMigrationManifest(i);assert.equal(m.mappedCount,0);
 assert.ok(m.unresolved.some(x=>x.code==='S09_HASH_OUT_OF_RANGE'));
});
test('S09 detects conflicting stable physical target IDs across legacy collections',()=>{
 const r1=record('legacy_A',100,a),r2={...r1,legacyPhysicalName:'legacy_B',legacyHash:101};
 const m=buildMigrationManifest(input([r1,r2],[mapping(r1,a),mapping(r2,a)]));
 assert.equal(m.mappedCount,0);
 assert.ok(m.unresolved.some(x=>x.code==='S09_TARGET_ID_COLLISION'));
});
test('S09 dangling references quarantine owners, rather than dropping links',()=>{
 const r1=record('legacy_A',1,a,{references:[{legacyPhysicalName:'legacy_A',legacyHash:2}]});
 const m=buildMigrationManifest(input([r1],[mapping(r1,a)]));
 assert.equal(m.mappedCount,0);assert.ok(m.unresolved.some(x=>x.code==='S09_DANGLING_REFERENCE'));
});
test('S09 blocks cross-user legacy links instead of silently migrating leaked references',()=>{
 const r1=record('legacy_A',1,a,{references:[{legacyPhysicalName:'legacy_B',legacyHash:2}]}),r2=record('legacy_B',2,c);
 const m=buildMigrationManifest(input([r1,r2],[mapping(r1,a),mapping(r2,c,'server-evidence-002')]));
 assert.equal(m.mappedCount,1);assert.ok(m.unresolved.some(x=>x.code==='S09_CROSS_TENANT_REFERENCE'));
});
test('S09 quarantines transitive references of ambiguous records',()=>{
 const r1=record('legacy_A',1,a), r2=record('legacy_A',2,a,{references:[{legacyPhysicalName:'legacy_A',legacyHash:1}]}),r3=record('legacy_A',1,a);
 const m=buildMigrationManifest(input([r1,r2,r3],[mapping(r1,a),mapping(r2,a)]));
 assert.equal(m.mappedCount,0);assert.equal(m.quarantinedCount,3);
});
test('S09 rejects unsafe or ambiguous physical legacy collection names',()=>{
 const i=one();i.records[0].legacyPhysicalName='chat:ambiguous';i.ownerMappings[0].legacyPhysicalName='chat:ambiguous';
 assert.equal(buildMigrationManifest(i).mappedCount,0);
});
test('S09 rejects excessive inventory rather than truncate',()=>{
 code(()=>buildMigrationManifest(input(Array(20001).fill(null),[])),'S09_INPUT_INVALID');
});
test('S09 requires explicit disposable permission before staging',async()=>{
 const i=one(),m=buildMigrationManifest(i);
 await asyncCode(()=>rehearseFixture({input:i,manifest:m,directory:'/tmp',disposable:false}),'S09_FIXTURE_ONLY');
});
test('S09 isolated staging independently reads backup and staged files, never cuts over',async()=>{
 const i=one(),m=buildMigrationManifest(i);
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'s09-rehearsal-'));
 try {
  const {session,receipt}=await rehearseFixture({input:i,manifest:m,directory:base,disposable:true});
  assert.equal(receipt.cutoverAllowed,false);assert.equal(receipt.backendSnapshotVerified,false);
  assert.deepEqual((await verifyFixtureSession(session)).status,'STAGED_REHEARSAL_ONLY');
  const staged=JSON.parse(await fs.readFile(path.join(session,'staged.json'),'utf8'));
  assert.equal(staged.staged[0].v2Record.physicalId,m.mappings[0].targetPhysicalId);
  assert.equal(staged.staged[0].v2Record.revision,1);
  assert.equal((await fs.readdir(base)).length,1);
  const result=await rollbackFixtureSession(session);assert.equal(result.backupPreserved,true);
  assert.equal(result.productionRollbackPerformed,false);
  assert.ok((await fs.stat(path.join(session,'backup.json'))).size>0);
  assert.ok((await fs.stat(path.join(session,'staged.rolled-back.json'))).size>0);
 } finally {await fs.rm(base,{recursive:true,force:true});}
});
test('S09 refuses fixture staging when unresolved items exist',async()=>{
 const i=one();i.ownerMappings=[];const m=buildMigrationManifest(i);
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'s09-rehearsal-'));
 try {await asyncCode(()=>rehearseFixture({input:i,manifest:m,directory:dir,disposable:true}),'S09_QUARANTINE_PRESENT');}
 finally {await fs.rm(dir,{recursive:true,force:true});}
});
test('S09 staging refuses nonempty destination',async()=>{
 const i=one(),m=buildMigrationManifest(i);
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'s09-rehearsal-'));
 try {await fs.writeFile(path.join(dir,'do-not-delete'),'original');
  await asyncCode(()=>rehearseFixture({input:i,manifest:m,directory:dir,disposable:true}),'S09_TARGET_NOT_EMPTY');
  assert.equal(await fs.readFile(path.join(dir,'do-not-delete'),'utf8'),'original');
 } finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('S09 fixture verification rejects tampered staged records',async()=>{
 const i=one(),m=buildMigrationManifest(i);
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'s09-rehearsal-'));
 try {const {session}=await rehearseFixture({input:i,manifest:m,directory:dir,disposable:true});
  const file=path.join(session,'staged.json');const value=JSON.parse(await fs.readFile(file,'utf8'));
  value.staged[0].v2Record.text='tampered';await fs.writeFile(file,JSON.stringify(value));
  await asyncCode(()=>verifyFixtureSession(session),'S09_FIXTURE_TAMPERED');
 }finally {await fs.rm(dir,{recursive:true,force:true});}
});
test('S09 refuses incomplete legacy vector data instead of producing an invalid v2 record',async()=>{
 const i=one();delete i.records[0].vector;
 const m=buildMigrationManifest(i);
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'s09-rehearsal-'));
 try {await asyncCode(()=>rehearseFixture({input:i,manifest:m,directory:dir,disposable:true}),'S09_LEGACY_PAYLOAD_UNVERIFIABLE');}
 finally {await fs.rm(dir,{recursive:true,force:true});}
});
test('S09 fixture rejects symlinked directory',async()=>{
 const i=one(),m=buildMigrationManifest(i);
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'s09-rehearsal-'));
 const link=dir+'-link';
 try {await fs.symlink(dir,link);
  await asyncCode(()=>rehearseFixture({input:i,manifest:m,directory:link,disposable:true}),'S09_UNTRUSTED_DIRECTORY');
 }finally{await fs.rm(link,{force:true});await fs.rm(dir,{recursive:true,force:true});}
});
test('S09 plugin keeps legacy write-route blocks and no migration endpoints exposed',async()=>{
 const src=await fs.readFile(new URL('../index.js',import.meta.url),'utf8');
 assert.match(src,/S01_MUTATION_BLOCKED/);
 assert.doesNotMatch(src,/s09\/cutover|s09\/migrate|s09\/restore/);
});

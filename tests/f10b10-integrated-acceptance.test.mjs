import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {assessF10b10,F10B10_KINDS,F10B10_BACKENDS} from '../lib/f10b10-integrated-acceptance.js';
const sha=s=>createHash('sha256').update(s).digest('hex');
const build={pluginVersion:'3.2.10-s10.45-f10b10',extensionVersion:'2.2.0-alpha.s11.46-f10b10',pluginSourceFingerprint:'a'.repeat(64)};
const row={id:'r1',revision:2,vectorSha256:'b'.repeat(64),metadataSha256:'c'.repeat(64)};
async function fixture(){const root=await fs.mkdtemp(path.join(os.tmpdir(),'f10b10-'));await fs.chmod(root,0o700);return root;}
async function evidence(root,backend='qdrant',opts={}){
 const dir=path.join(root,backend);await fs.mkdir(dir,{mode:0o700});
 const doc={schemaVersion:1,checkpoint:'F10b.10',backend,environment:'DISPOSABLE_HOST_ONLY',runId:randomUUID(),backupId:randomUUID(),
  ...build,sourceCollection:'vh_original_test',restoredCollection:'vh_new_disposable',cooperatingWritersOnly:true,
  productionActivationRequested:false,uncertainOperationsReplayed:false,uncertainLocksForceReleased:false,
  unrelatedDirectWritersProtected:false,artifacts:[]};
 for(const kind of F10B10_KINDS){if(kind===opts.missing)continue;
  const data=kind.endsWith('_inventory')?{schemaVersion:1,backend,runId:doc.runId,backupId:doc.backupId,records:(opts.mismatch&&kind==='restored_inventory')?[{...row,revision:3}]:[row]}:
   {schemaVersion:1,kind,backend,runId:doc.runId,backupId:doc.backupId,sourceCollection:doc.sourceCollection,
    restoredCollection:doc.restoredCollection,result:'PASS',uncertainOrPendingOperations:false,retainedLockReleasedWithoutTerminalReceipt:false};
  if(kind===opts.badReceipt) data.backupId=randomUUID();
  const file=kind+'.json';const raw=JSON.stringify(data);await fs.writeFile(path.join(dir,file),raw,{mode:0o600});
  doc.artifacts.push({kind,file,sha256:sha(raw),result:'PASS'});
 }
 if(opts.manifest)Object.assign(doc,opts.manifest);
 await fs.writeFile(path.join(dir,'manifest.json'),JSON.stringify(doc),{mode:0o600});return {dir,doc};
}
const run=root=>assessF10b10({evidenceRoot:root,build});
function use(name,fn){test(name,async()=>{const root=await fixture();try{await fn(root);}finally{await fs.rm(root,{recursive:true,force:true});}});}
use('missing all four backends yields explicit NO GO',async r=>{const x=await run(r);assert.equal(x.reviewReady.length,0);assert.equal(x.overall,'NO_GO_PRODUCTION');
 assert.equal(Object.keys(x.results).length,4);assert.equal(x.productionMutationsEnabled,false);});
use('complete evidence is review-only and not production',async r=>{await evidence(r);const x=await run(r);
 assert.equal(x.results.qdrant.status,'READY_FOR_INDEPENDENT_REVIEW');assert.equal(x.productionCertified,false);assert.equal(x.lockForceReleaseAllowed,false);});
use('four complete host submissions never auto-authorize',async r=>{for(const b of F10B10_BACKENDS)await evidence(r,b);const x=await run(r);
 assert.equal(x.reviewReady.length,4);assert.equal(x.productionRestoreEnabled,false);assert.equal(x.automaticSyncEnabled,false);});
use('missing crash/restart evidence refuses readiness',async r=>{await evidence(r,'qdrant',{missing:'crash_restart'});
 assert.equal((await run(r)).results.qdrant.status,'BLOCKED_INCOMPLETE_EVIDENCE');});
use('mismatched restored vector inventory refuses readiness',async r=>{await evidence(r,'lancedb',{mismatch:true});
 assert.equal((await run(r)).results.lancedb.status,'BLOCKED_INVENTORY_MISMATCH');});
use('cross-stage different backup UUID is refused',async r=>{await evidence(r,'vectra',{badReceipt:'native_restore'});
 await assert.rejects(run(r),{code:'F10B10_RECEIPT_MISMATCH'});});
use('tampered native restore receipt is refused',async r=>{const {dir}=await evidence(r);
 await fs.writeFile(path.join(dir,'native_restore.json'),'{}');await assert.rejects(run(r),{code:'F10B10_TAMPERED_ARTIFACT'});});
use('old build evidence cannot be used for this baseline',async r=>{await evidence(r,'milvus',{manifest:{pluginVersion:'3.2.10-s10.44-f10b9'}});
 await assert.rejects(run(r),{code:'F10B10_INVALID_MANIFEST'});});
use('existing source collection as restore target refused',async r=>{await evidence(r,'milvus',{manifest:{restoredCollection:'vh_original_test'}});
 await assert.rejects(run(r),{code:'F10B10_INVALID_MANIFEST'});});
use('cannot assert uncertain receipt auto retry or force release',async r=>{await evidence(r,'qdrant',{manifest:{uncertainOperationsReplayed:true}});
 await assert.rejects(run(r),{code:'F10B10_INVALID_MANIFEST'});});
use('independent writers not silently guaranteed',async r=>{await evidence(r,'qdrant',{manifest:{unrelatedDirectWritersProtected:true}});
 await assert.rejects(run(r),{code:'F10B10_INVALID_MANIFEST'});});
use('symlink evidence file refused',async r=>{const {dir}=await evidence(r);
 await fs.rm(path.join(dir,'rollback.json'));await fs.symlink(path.join(dir,'quiescence.json'),path.join(dir,'rollback.json'));
 await assert.rejects(run(r),{code:'F10B10_UNTRUSTED_FILE'});});
use('hardlinked evidence file refused',async r=>{const {dir}=await evidence(r);
 await fs.link(path.join(dir,'quiescence.json'),path.join(r,'external.bin'));
 await assert.rejects(run(r),{code:'F10B10_UNTRUSTED_FILE'});});
use('unexpected evidence files refused',async r=>{const {dir}=await evidence(r);
 await fs.writeFile(path.join(dir,'extra.json'),'{}',{mode:0o600});
 await assert.rejects(run(r),{code:'F10B10_UNEXPECTED_FILES'});});
use('untrusted ancestor symlink refused',async r=>{const link=path.join(os.tmpdir(),'f10b10-link-'+randomUUID());await fs.symlink(r,link);
 try{await assert.rejects(assessF10b10({evidenceRoot:link,build}),{code:'F10B10_UNTRUSTED_ANCESTOR'});}
 finally{await fs.unlink(link);}});
use('record inventory duplicate identity refuses even if checksum valid',async r=>{const {dir,doc}=await evidence(r);
 const file='source_inventory.json',data=JSON.stringify({schemaVersion:1,backend:'qdrant',runId:doc.runId,backupId:doc.backupId,records:[row,row]});
 await fs.writeFile(path.join(dir,file),data);doc.artifacts.find(i=>i.kind==='source_inventory').sha256=sha(data);
 await fs.writeFile(path.join(dir,'manifest.json'),JSON.stringify(doc));await assert.rejects(run(r),{code:'F10B10_INVALID_INVENTORY'});});

use('source inventory from different capture is refused',async r=>{const {dir,doc}=await evidence(r);
 const file='source_inventory.json',data=JSON.stringify({schemaVersion:1,backend:'qdrant',runId:doc.runId,backupId:randomUUID(),records:[row]});
 await fs.writeFile(path.join(dir,file),data);doc.artifacts.find(i=>i.kind==='source_inventory').sha256=sha(data);
 await fs.writeFile(path.join(dir,'manifest.json'),JSON.stringify(doc));
 await assert.rejects(run(r),{code:'F10B10_INVALID_INVENTORY'});});

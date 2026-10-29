import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {assessF10b5HostEvidence,F10B5_REQUIRED_EVIDENCE} from '../lib/f10b5-acceptance.js';
const sha=b=>createHash('sha256').update(b).digest('hex');
const build={pluginVersion:'3.2.10-s10.40-f10b5',extensionVersion:'2.2.0-alpha.s11.41-f10b5',pluginSourceFingerprint:'a'.repeat(64)};
const owner={backend:'qdrant',environment:'DISPOSABLE_HOST_ONLY',schemaVersion:1,checkpoint:'F10b.5',
 hostRunId:randomUUID(),...build,restoreDestinationNewEmpty:true,productionActivationRequested:false,
 unresolvedOperationsReplayed:false,retainedLocksManuallyRemoved:false,unrelatedWritersProtected:false,
 cooperatingWritersOnly:true,artifacts:[]};
const record={id:'safe-123',revision:1,vectorSha256:'b'.repeat(64),metadataSha256:'c'.repeat(64)};
async function setup(){const root=await fs.mkdtemp(path.join(os.tmpdir(),'f10b5-'));
 await fs.chmod(root,0o700);return root;}
async function setDoc(root,backend='qdrant',config={}){
 const folder=path.join(root,backend);await fs.mkdir(folder,{mode:0o700});
 const doc={...owner,backend,hostRunId:randomUUID(),artifacts:[]};
 for(const kind of F10B5_REQUIRED_EVIDENCE){
  if(config.missing===kind)continue;
  const file=kind+'.json',data=kind.includes('inventory')?JSON.stringify({schemaVersion:1,backend,records:
   config.mismatch&&kind==='restored_inventory'?[{...record,revision:2}]:[record]}):
   JSON.stringify({testFixture:kind,disposable:true});
  await fs.writeFile(path.join(folder,file),data,{mode:0o600});doc.artifacts.push({kind,file,sha256:sha(data),result:'PASS'});
 }
 Object.assign(doc,config.manifest||{});
 await fs.writeFile(path.join(folder,'host-evidence.json'),JSON.stringify(doc),{mode:0o600});
 return {folder,doc};
}
const verify=root=>assessF10b5HostEvidence({evidenceRoot:root,build});
const tempTest=(name,fn)=>test(name,async()=>{const root=await setup();try{await fn(root);}finally{await fs.rm(root,{recursive:true,force:true});}});
tempTest('no evidence leaves all four backends blocked',async root=>{
 const out=await verify(root);assert.equal(out.overall,'NO_GO_PRODUCTION');
 assert.equal(Object.values(out.results).filter(x=>x.status==='BLOCKED_MISSING_HOST_EVIDENCE').length,4);
 assert.equal(out.productionCertified,false);
});
tempTest('complete local evidence only makes manual review eligible',async root=>{
 await setDoc(root);const out=await verify(root);assert.equal(out.results.qdrant.status,'READY_FOR_INDEPENDENT_MANUAL_REVIEW');
 assert.equal(out.results.qdrant.productionCertified,false);assert.equal(out.retainedLockReleaseAllowed,false);
});
tempTest('all four complete never auto certify',async root=>{
 for(const b of ['qdrant','lancedb','vectra','milvus'])await setDoc(root,b);
 const out=await verify(root);assert.equal(out.allBackendsReadyForManualReview,true);
 assert.equal(out.overall,'NO_GO_PRODUCTION');assert.equal(out.productionRestoreEnabled,false);
});
tempTest('missing native backup artifact prevents readiness',async root=>{
 await setDoc(root,'qdrant',{missing:'physical_native_backup'});
 const r=(await verify(root)).results.qdrant;assert.equal(r.status,'BLOCKED_INCOMPLETE');
 assert.deepEqual(r.missing,['physical_native_backup']);
});
tempTest('mismatched restored inventory blocks',async root=>{
 await setDoc(root,'qdrant',{mismatch:true});assert.equal((await verify(root)).results.qdrant.status,'BLOCKED_INVENTORY_MISMATCH');
});
tempTest('tampered artifact is refused',async root=>{
 const {folder}=await setDoc(root);await fs.writeFile(path.join(folder,'restart_persistence.json'),'altered');
 await assert.rejects(verify(root),{code:'F10B5_ARTIFACT_TAMPERED'});
});
tempTest('stale plugin build is refused',async root=>{
 await setDoc(root,'qdrant',{manifest:{pluginVersion:'3.2.10-s10.39-f10b4'}});
 await assert.rejects(verify(root),{code:'F10B5_MANIFEST_INVALID'});
});
tempTest('production permission request is refused',async root=>{
 await setDoc(root,'qdrant',{manifest:{productionActivationRequested:true}});
 await assert.rejects(verify(root),{code:'F10B5_MANIFEST_INVALID'});
});
tempTest('admission of replay or removed lock is refused',async root=>{
 await setDoc(root,'qdrant',{manifest:{unresolvedOperationsReplayed:true}});
 await assert.rejects(verify(root),{code:'F10B5_MANIFEST_INVALID'});
});
tempTest('out-of-scope external writer certification refused',async root=>{
 await setDoc(root,'qdrant',{manifest:{unrelatedWritersProtected:true}});
 await assert.rejects(verify(root),{code:'F10B5_MANIFEST_INVALID'});
});
tempTest('symlink artifact refused',async root=>{
 const {folder}=await setDoc(root);await fs.rm(path.join(folder,'rollback_rehearsal.json'));
 await fs.symlink(path.join(folder,'restart_persistence.json'),path.join(folder,'rollback_rehearsal.json'));
 await assert.rejects(verify(root),{code:'F10B5_FILE_UNTRUSTED'});
});
tempTest('unexpected file in evidence directory refused',async root=>{
 const {folder}=await setDoc(root);await fs.writeFile(path.join(folder,'secret.txt'),'bad');
 await assert.rejects(verify(root),{code:'F10B5_UNEXPECTED_FILES'});
});
tempTest('duplicate inventory ID refused',async root=>{
 const {folder,doc}=await setDoc(root);const file='restored_inventory.json';
 const changed=JSON.stringify({schemaVersion:1,backend:'qdrant',records:[record,record]});
 await fs.writeFile(path.join(folder,file),changed);doc.artifacts.find(x=>x.kind==='restored_inventory').sha256=sha(changed);
 await fs.writeFile(path.join(folder,'host-evidence.json'),JSON.stringify(doc));
 await assert.rejects(verify(root),{code:'F10B5_INVENTORY_INVALID'});
});
tempTest('hard link to evidence is refused',async root=>{
 const {folder}=await setDoc(root);await fs.link(path.join(folder,'restart_persistence.json'),path.join(root,'outside.txt'));
 await assert.rejects(verify(root),{code:'F10B5_FILE_UNTRUSTED'});
});
tempTest('forged ready/certified label cannot authorize',async root=>{
 await setDoc(root,'qdrant',{manifest:{status:'PRODUCTION_CERTIFIED',releaseApproved:true}});
 const out=await verify(root);assert.equal(out.results.qdrant.status,'READY_FOR_INDEPENDENT_MANUAL_REVIEW');
 assert.equal(out.productionCertified,false);
});
tempTest('symlink in evidence root ancestor is rejected',async root=>{
 const top=path.dirname(root),alias=path.join(top,'f10b5-link-'+randomUUID());
 await fs.symlink(root,alias);
 try{await assert.rejects(assessF10b5HostEvidence({evidenceRoot:alias,build}),{code:'F10B5_ANCESTOR_UNTRUSTED'});}
 finally{await fs.unlink(alias);}
});

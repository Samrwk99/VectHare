import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {CooperativeWriterBoundary,assessWriterBoundary} from '../lib/f09c5-writer-boundary.js';
import {MutationEngine} from '../lib/s04-engine.js';
import {OperationLedger} from '../lib/s04-ledger.js';
import {planMutation} from '../lib/s04-contract.js';
import {sample} from './s04-contract.test.mjs';
const plan={backend:'qdrant',physicalCollectionName:'vh-test',collectionKey:'a'.repeat(64)};
async function fixture(fn){const home=await fs.mkdtemp(path.join(os.tmpdir(),'vh-f09c5-'));try{
 const root=path.join(home,'gate');await fn({home,root,b:new CooperativeWriterBoundary({root,backend:'qdrant',physicalName:'vh-test'})});
}finally{await fs.rm(home,{recursive:true,force:true});}}
test('F09c.5: cooperating writers serialize on the same physical collection',()=>fixture(async({root,b})=>{
 let release;const held=new Promise(r=>{release=r;});let entered=false;
 const active=b.withWriteBoundary(plan,async()=>{entered=true;await held;return {state:'VERIFIED'};});
 while(!entered)await new Promise(r=>setTimeout(r,2));
 const rival=new CooperativeWriterBoundary({root,backend:'qdrant',physicalName:'vh-test'});
 await assert.rejects(()=>rival.withWriteBoundary(plan,async()=>{}),e=>e.code==='F09C5_WRITER_BUSY');
 release();await active;
 assert.equal((await rival.withWriteBoundary(plan,async()=>({state:'VERIFIED'}))).state,'VERIFIED');
}));
test('F09c.5: mismatched physical collection and backend denied before callback',()=>fixture(async({b})=>{
 let writes=0;for(const p of [{...plan,backend:'milvus'},{...plan,physicalCollectionName:'other'},{...plan,collectionKey:'wrong'}])
  await assert.rejects(()=>b.withWriteBoundary(p,async()=>{writes++;}),e=>e.code==='F09C5_SCOPE_MISMATCH');
 assert.equal(writes,0);
}));
test('F09c.5: uncertain dispatch leaves persistent fail-closed lock',()=>fixture(async({b})=>{
 assert.equal((await b.withWriteBoundary(plan,async()=>({state:'UNCERTAIN'}))).state,'UNCERTAIN');
 await assert.rejects(()=>b.withWriteBoundary(plan,async()=>({state:'VERIFIED'})),e=>e.code==='F09C5_WRITER_BUSY');
}));
test('F09c.5: thrown error leaves lock for manual review (no TTL or stale break)',()=>fixture(async({b})=>{
 await assert.rejects(()=>b.withWriteBoundary(plan,async()=>{throw Error('backend crashed');}),/backend crashed/);
 await assert.rejects(()=>b.withWriteBoundary(plan,async()=>({state:'VERIFIED'})),e=>e.code==='F09C5_WRITER_BUSY');
}));
test('F09c.5: symlinked lock root and world-readable parent rejected',()=>fixture(async({home,root,b})=>{
 await fs.symlink(home,root);
 await assert.rejects(()=>b.withWriteBoundary(plan,async()=>({state:'VERIFIED'})),e=>e.code==='F09C5_UNTRUSTED_DIRECTORY');
 await fs.rm(root);await fs.chmod(home,0o755);
 await assert.rejects(()=>b.withWriteBoundary(plan,async()=>({state:'VERIFIED'})),e=>e.code==='F09C5_UNTRUSTED_DIRECTORY');
}));
test('F09c.5: cannot claim deployment certification with self-reported checkboxes',()=>{
 const fields=['networkWriteIsolation','localWriteIsolation','credentialExclusivity','legacyRoutesMediated','crashRecoveryVerified','realHostRacesVerified'];
 const r=assessWriterBoundary(Object.fromEntries(fields.map(k=>[k,true])));
 assert.equal(r.productionPermission,false);assert.equal(r.externalWritersBlocked,false);assert.equal(r.certified,false);
});
test('F09c.5: engine encloses entire mutation in optional cooperating-writer gate',()=>fixture(async({home,b})=>{
 const context={userScopeId:'alice',vectorsPath:home};
 const req=planMutation(context,{...sample('insert'),operationId:randomUUID()});
 const bound=new CooperativeWriterBoundary({root:b.root,backend:req.backend,physicalName:req.physicalCollectionName});
 const record={recordId:req.recordId,physicalId:req.physicalId,scope:req.scope,revision:1,textHash:req.textHash,
  vectorHash:req.vectorHash,metadataHash:req.metadataHash,vector:[.1,.2,.3]};
 let writes=0;
 const adapter={getRecord:async()=>writes?record:null,insertRecord:async()=>{writes++;},updateRecord:async()=>{},deleteRecord:async()=>{}};
 const auth=async p=>({authorized:true,ownerVerified:true,mutationContractVerified:true,collectionKey:p.collectionKey,backend:p.backend});
 const e=new MutationEngine({ledger:new OperationLedger(context),adapter,authorize:auth,atomicOnly:false,writerBoundary:bound});
 const p={text:'hello',vector:[.1,.2,.3],metadata:{tag:'safe'}};
 assert.equal((await e.execute(req,p)).state,'VERIFIED');assert.equal(writes,1);
}));
test('F09c.5: lock is shared across separate OS processes (not just JS objects)',()=>fixture(async({root,b})=>{
 const childScript=`import {CooperativeWriterBoundary} from ${JSON.stringify(new URL('../lib/f09c5-writer-boundary.js',import.meta.url).href)};\n`+
 `const b=new CooperativeWriterBoundary({root:${JSON.stringify(root)},backend:'qdrant',physicalName:'vh-test'});\n`+
 `await b.withWriteBoundary(${JSON.stringify(plan)},async()=>{process.stdout.write('HELD\\n');await new Promise(r=>setTimeout(r,650));return {state:'VERIFIED'};});`;
 const c=spawn(process.execPath,['--input-type=module','-e',childScript],{stdio:['ignore','pipe','pipe']});
 try {await new Promise((resolve,reject)=>{let output='';c.stdout.on('data',buf=>{output+=buf;if(output.includes('HELD'))resolve();});c.on('exit',code=>reject(Error('child exited '+code)));});
  await assert.rejects(()=>b.withWriteBoundary(plan,async()=>({state:'VERIFIED'})),e=>e.code==='F09C5_WRITER_BUSY');
 }finally{await new Promise(resolve=>c.once('exit',resolve));}
 assert.equal((await b.withWriteBoundary(plan,async()=>({state:'VERIFIED'}))).state,'VERIFIED');
}));
test('F09c.5: independent lock roots are NOT enforced as a shared gateway',()=>fixture(async({home,b})=>{
 let release;const held=new Promise(r=>{release=r;});let entered=false;
 const a=b.withWriteBoundary(plan,async()=>{entered=true;await held;return {state:'VERIFIED'};});
 while(!entered)await new Promise(r=>setTimeout(r,2));
 const other=new CooperativeWriterBoundary({root:path.join(home,'different-gate'),backend:'qdrant',physicalName:'vh-test'});
 // This succeeds: real deployment must force all writers onto one trusted root.
 assert.equal((await other.withWriteBoundary(plan,async()=>({state:'VERIFIED'}))).state,'VERIFIED');
 release();await a;
}));
test('F09c.5: OS process termination retains fail-closed persistent lock',()=>fixture(async({root,b})=>{
 const code=`import {CooperativeWriterBoundary} from ${JSON.stringify(new URL('../lib/f09c5-writer-boundary.js',import.meta.url).href)};`+
 `const b=new CooperativeWriterBoundary({root:${JSON.stringify(root)},backend:'qdrant',physicalName:'vh-test'});`+
 `await b.withWriteBoundary(${JSON.stringify(plan)},async()=>{process.stdout.write('IN_FLIGHT\\n');await new Promise(()=>{});});`;
 const c=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','pipe','pipe']});
 try{await new Promise((resolve,reject)=>{let data='';c.stdout.on('data',buf=>{data+=buf;if(data.includes('IN_FLIGHT'))resolve();});c.on('exit',()=>reject(Error('child exited before dispatch')));});
 }finally{c.kill('SIGKILL');await new Promise(resolve=>c.once('exit',resolve));}
 await assert.rejects(()=>b.withWriteBoundary(plan,async()=>({state:'VERIFIED'})),e=>e.code==='F09C5_WRITER_BUSY');
}));

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {MutationEngine} from '../lib/s04-engine.js';
import {OperationLedger} from '../lib/s04-ledger.js';
import {planMutation} from '../lib/s04-contract.js';
import {runtimeWriterBoundary} from '../lib/f09c10-runtime-boundary.js';
import {sample} from './s04-contract.test.mjs';

async function sandbox(work){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'vh-f09c10-'));
 try{return await work({userScopeId:'alice',vectorsPath:root});}
 finally{await fs.rm(root,{recursive:true,force:true});}
}
function planned(ctx,backend='qdrant',action='insert',other={}){
 return planMutation(ctx,{...sample(action),backend,operationId:randomUUID(),...other});
}
function payload(){return {text:'hello',vector:[.1,.2,.3],metadata:{tag:'safe'}};}
function record(p){return {recordId:p.recordId,physicalId:p.physicalId,scope:p.scope,revision:p.targetRevision,
 textHash:p.textHash,vectorHash:p.vectorHash,metadataHash:p.metadataHash,vector:[.1,.2,.3]};}
function engine(ctx,{onInsert=async()=>{},read=async()=>null}={}){
 const adapter={getRecord:read,insertRecord:onInsert,updateRecord:async()=>{},deleteRecord:async()=>{}};
 return new MutationEngine({atomicOnly:false,ledger:new OperationLedger(ctx),adapter,
 authorize:async p=>({authorized:true,ownerVerified:true,mutationContractVerified:true,
 collectionKey:p.collectionKey,backend:p.backend})});
}
test('F09c.10: each of four backend S04 runtime inserts automatically uses the trusted lock',async()=>sandbox(async ctx=>{
 for(const backend of ['qdrant','lancedb','vectra','milvus']){
  const p=planned(ctx,backend);let entered=false;
  const e=engine(ctx,{onInsert:async()=>{entered=true;}});
  assert.equal((await e.execute(p,payload())).state,'UNCERTAIN');
  // Readback deliberately returned null: uncertain after physical dispatch -> retain gate.
  assert.equal(entered,true);
  const gate=await runtimeWriterBoundary(ctx,p);
  await assert.rejects(()=>gate.withWriteBoundary(p,async()=>({state:'VERIFIED'})),e=>e.code==='F09C5_WRITER_BUSY');
 }
}));
test('F09c.10: two independent mutation engines cannot overlap a collection even before intent',async()=>sandbox(async ctx=>{
 const p=planned(ctx);let release,entered=false;
 const held=new Promise(r=>release=r);
 const a=engine(ctx,{onInsert:async()=>{entered=true;await held;}});
 const pending=a.execute(p,payload());
 while(!entered)await new Promise(r=>setTimeout(r,2));
 const b=engine(ctx);
 const other=planned(ctx);
 await assert.rejects(()=>b.execute(other,payload()),e=>e.code==='F09C5_WRITER_BUSY');
 // A rejected competing writer must not even create an operation receipt.
 await assert.rejects(()=>new OperationLedger(ctx).read(other.operationId),e=>e.code==='ENOENT');
 release();assert.equal((await pending).state,'UNCERTAIN');
}));
test('F09c.10: verified mutation releases gate and allows next source-bound operation',async()=>sandbox(async ctx=>{
 const p=planned(ctx);let stored=null;
 const e=engine(ctx,{onInsert:async()=>{stored=record(p);},read:async()=>stored});
 assert.equal((await e.execute(p,payload())).state,'VERIFIED');
 const gate=await runtimeWriterBoundary(ctx,p);
 assert.equal((await gate.withWriteBoundary(p,async()=>({state:'VERIFIED'}))).state,'VERIFIED');
}));
test('F09c.10: stale/pre-dispatch failure releases gate but never dispatches',async()=>sandbox(async ctx=>{
 const p=planned(ctx,'qdrant','delete');let writes=0;
 const e=engine(ctx,{onInsert:async()=>{writes++;}});
 await assert.rejects(()=>e.execute(p,null),error=>error.code==='S04_REVISION_OR_OWNER_MISMATCH');
 assert.equal(writes,0);
 const gate=await runtimeWriterBoundary(ctx,p);
 assert.equal((await gate.withWriteBoundary(p,async()=>({state:'VERIFIED'}))).state,'VERIFIED');
}));
test('F09c.10: lock path not supplied by browser, mismatched user or symlinked root refused',async()=>sandbox(async ctx=>{
 const p=planned(ctx);
 await assert.rejects(()=>runtimeWriterBoundary({...ctx,userScopeId:'bob'},p),e=>e.code==='F09C10_RUNTIME_SCOPE_INVALID');
 const sibling=ctx.vectorsPath+'-link';await fs.symlink(ctx.vectorsPath,sibling);
 try{await assert.rejects(()=>runtimeWriterBoundary({...ctx,vectorsPath:sibling},p),e=>e.code==='F09C10_LOCK_PARENT_UNTRUSTED');}
 finally{await fs.unlink(sibling);}
}));
test('F09c.10: shared lock namespace is derived deterministically across engine types',async()=>sandbox(async ctx=>{
 const p=planned(ctx,'vectra');const a=await runtimeWriterBoundary(ctx,p);
 const b=await runtimeWriterBoundary(ctx,{...p,operationId:randomUUID()});
 assert.equal(a.root,b.root);assert.equal(a.key,b.key);
 const foreign=planned(ctx,'lancedb');const c=await runtimeWriterBoundary(ctx,foreign);
 assert.notEqual(a.key,c.key);
}));
test('F09c.10: all normal runtime mutation call sites use S04 engine (shared gate)',async()=>{
 const root=new URL('../lib/',import.meta.url);
 const routes=['f04-pilot-mutations.js','f06-lancedb-pilot.js','f07-vectra-pilot.js',
 'f08-milvus.js','f09b3-chat-sync-execute.js','f09b4-chat-lifecycle.js','f09b6-content-workflows.js'];
 for(const filename of routes){const content=await fs.readFile(new URL(filename,root),'utf8');
  assert.match(content,/new MutationEngine\(/,`${filename} must stay on guarded S04 write path`);
  assert.doesNotMatch(content,/\.insertRecord\(|\.updateRecord\(|\.deleteRecord\(/,
   `${filename} must not introduce direct unguarded write routes`);
 }
});
test('F09c.10: independently launched mutation engine cannot bypass in-flight S04 write',async()=>sandbox(async ctx=>{
 const {spawn}=await import('node:child_process');
 const p=planned(ctx),script=`import {MutationEngine} from ${JSON.stringify(new URL('../lib/s04-engine.js',import.meta.url).href)};`+
 `import {OperationLedger} from ${JSON.stringify(new URL('../lib/s04-ledger.js',import.meta.url).href)};`+
 `const p=${JSON.stringify(p)},ctx=${JSON.stringify(ctx)};`+
 `const a={getRecord:async()=>null,insertRecord:async()=>{process.stdout.write('DISPATCH_STARTED\\n');await new Promise(()=>{setInterval(()=>{},1000);});},updateRecord:async()=>{},deleteRecord:async()=>{}};`+
 `const e=new MutationEngine({atomicOnly:false,ledger:new OperationLedger(ctx),adapter:a,authorize:async()=>({authorized:true,ownerVerified:true,mutationContractVerified:true,collectionKey:p.collectionKey,backend:p.backend})});`+
 `await e.execute(p,${JSON.stringify(payload())});`;
 const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['ignore','pipe','pipe']});
 let stderr='';child.stderr.on('data',b=>stderr+=b.toString());
 try{
  await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(Error('child lock did not start: '+stderr)),7000);
   child.stdout.on('data',buffer=>{output+=buffer.toString();if(output.includes('DISPATCH_STARTED')){clearTimeout(timer);resolve();}});
   child.on('exit',code=>{clearTimeout(timer);reject(Error('child died before dispatch '+code+': '+stderr));});});
  const second=planned(ctx);
  await assert.rejects(()=>engine(ctx).execute(second,payload()),e=>e.code==='F09C5_WRITER_BUSY');
 }finally{child.kill('SIGKILL');await new Promise(r=>{if(child.exitCode!==null||child.signalCode!==null)r();else child.once('exit',r);});}
 const third=planned(ctx);
 await assert.rejects(()=>engine(ctx).execute(third,payload()),e=>e.code==='F09C5_WRITER_BUSY');
}));

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runLanceF09c7HostProbe,validateF09c7Options,F09C7_CONSENT} from '../lib/f09c7-lancedb-host-probe.js';
async function fixture(fn){const parent=await fs.mkdtemp(path.join(os.tmpdir(),'vh-f09c7-'));try{await fn(parent);}finally{await fs.rm(parent,{recursive:true,force:true});}}
function mockSdk({staleBypass=false,throwAt=null,badReadback=false}={}){
 const calls=[];let dbPath=null;
 const sdk={async connect(dir){dbPath=dir;calls.push('connect');const tables=new Map();
  return {async tableNames(){calls.push('tableNames');return [...tables.keys()];},async createTable(name,initial){
   calls.push('createTable');if(throwAt==='create')throw Error('native write unknown');
   const rows=new Map(initial.map(r=>[r.id,{...r}]));
   const table={query(){let where='';return {where(s){where=s;return this;},async toArray(){calls.push('read');
    const id=Number(/id\s*=\s*(\d+)/.exec(where)?.[1]);const row=rows.get(id);return row?[{...row}]:[];}};},
    async add(items){calls.push('add');if(throwAt==='add')throw Error('timeout');for(const r of items)rows.set(r.id,{...r});},
    async update({where,values}){calls.push('update');if(throwAt==='update')throw Error('timeout');
     const id=Number(/id\s*=\s*(\d+)/.exec(where)?.[1]),rev=Number(/revision\s*=\s*(\d+)/.exec(where)?.[1]);
     if(rows.has(id)&&(staleBypass||rows.get(id).revision===rev)) rows.set(id,{...rows.get(id),...values});},
    async delete(where){calls.push('delete');if(throwAt==='delete')throw Error('timeout');
     const id=Number(/id\s*=\s*(\d+)/.exec(where)?.[1]);rows.delete(id);}};
   if(badReadback)rows.delete(1);tables.set(name,table);return table;}};}};
 return {sdk,calls,get dbPath(){return dbPath;}};
}
test('F09c.7: invalid parent or missing explicit disposable consent refused before native SDK',async()=>{
 for(const parent of ['relative/path','/','/tmp/../tmp',''])assert.throws(()=>validateF09c7Options({parent}),/F09C7_ABSOLUTE_PRIVATE_PARENT_REQUIRED/);
 assert.throws(()=>validateF09c7Options({parent:'/tmp/x',mode:'disposable'}),/F09C7_CONSENT_REQUIRED/);
 assert.throws(()=>validateF09c7Options({parent:'/tmp/x',mode:'preflight',consent:F09C7_CONSENT}),/F09C7_CONSENT_NOT_ALLOWED/);
 assert.throws(()=>validateF09c7Options({parent:'/tmp/x',mode:'unknown'}),/F09C7_MODE_INVALID/);
});
test('F09c.7: preflight does not create a database or mutation',()=>fixture(async parent=>{
 const mock=mockSdk();const before=await fs.readdir(parent);
 const r=await runLanceF09c7HostProbe({parent},async()=>mock.sdk);
 assert.equal(r.status,'PREFLIGHT_ONLY');assert.equal(r.productionPermission,false);
 assert.equal(r.realHostCertified,false);assert.equal(r.cooperatingWritersOnly,true);assert.equal(r.externalWritersProtected,false);
 assert.deepEqual(await fs.readdir(parent),before);assert.deepEqual(mock.calls,[]);
}));
test('F09c.7: SDK unavailable returns non-authorizing error and never creates data',()=>fixture(async parent=>{
 const r=await runLanceF09c7HostProbe({parent,mode:'disposable',consent:F09C7_CONSENT},async()=>{throw Error('native missing');});
 assert.equal(r.status,'SDK_UNAVAILABLE');assert.deepEqual(await fs.readdir(parent),[]);
}));
test('F09c.7: disposable table create, add, update, stale refusal, scoped delete verified',()=>fixture(async parent=>{
 const m=mockSdk();const r=await runLanceF09c7HostProbe({parent,mode:'disposable',consent:F09C7_CONSENT},async()=>m.sdk);
 assert.equal(r.status,'DISPOSABLE_LANCEDB_OBSERVED_NO_PRODUCTION_CERTIFICATION');
 assert.equal(r.steps.filter(s=>s.status==='PASS').length,5);
 assert.equal(r.disposablePath,m.dbPath);assert.ok(r.disposablePath.startsWith(parent+path.sep));
 assert.equal(r.atomicBackendCertified,false);assert.equal(r.productionPermission,false);
 assert.equal(r.manualCleanupRequired,true);assert.equal((await fs.readdir(parent)).some(s=>s.startsWith('vh_f09c7_disposable_')),true);
 assert.equal(m.calls.filter(c=>c==='update').length,2);
}));
test('F09c.7: stale update bypass detected and retained for investigation',()=>fixture(async parent=>{
 const m=mockSdk({staleBypass:true});const r=await runLanceF09c7HostProbe({parent,mode:'disposable',consent:F09C7_CONSENT},async()=>m.sdk);
 assert.equal(r.status,'FAILED_OR_UNCERTAIN');assert.equal(r.steps.at(-1).detail,'F09C7_STALE_REVISION_NOT_REFUSED');
 assert.equal(r.manualCleanupRequired,true);assert.equal(m.calls.includes('delete'),false);
 const locks=(await fs.readdir(path.join(parent,'writer-locks'))).filter(n=>n.endsWith('.lock'));
 assert.equal(locks.length,1);
}));
test('F09c.7: ambiguous native timeout persists cooperative lock, no retry',()=>fixture(async parent=>{
 const m=mockSdk({throwAt:'add'});const r=await runLanceF09c7HostProbe({parent,mode:'disposable',consent:F09C7_CONSENT},async()=>m.sdk);
 assert.equal(r.status,'FAILED_OR_UNCERTAIN');assert.equal(r.steps.at(-1).detail,'F09C7_BACKEND_ERROR_OR_UNCERTAIN');
 assert.equal(m.calls.filter(c=>c==='add').length,1);assert.equal(m.calls.includes('update'),false);
 assert.equal((await fs.readdir(path.join(parent,'writer-locks'))).filter(n=>n.endsWith('.lock')).length,1);
}));
test('F09c.7: early failed create leaves evidence; no silent cleanup',()=>fixture(async parent=>{
 const m=mockSdk({throwAt:'create'});const r=await runLanceF09c7HostProbe({parent,mode:'disposable',consent:F09C7_CONSENT},async()=>m.sdk);
 assert.equal(r.status,'FAILED_OR_UNCERTAIN');assert.equal(r.manualCleanupRequired,true);assert.ok(await fs.stat(r.disposablePath));
}));
test('F09c.7: unexpected missing saved row is a hard refusal',()=>fixture(async parent=>{
 const m=mockSdk({badReadback:true});const r=await runLanceF09c7HostProbe({parent,mode:'disposable',consent:F09C7_CONSENT},async()=>m.sdk);
 assert.equal(r.status,'FAILED_OR_UNCERTAIN');assert.equal(r.steps.at(-1).detail,'F09C7_CREATE_READBACK_FAILED');
}));
test('F09c.7: symlinked parent refused, even with valid consent',()=>fixture(async parent=>{
 const link=path.join(path.dirname(parent),'vh-f09c7-link-'+path.basename(parent));await fs.symlink(parent,link);
 try {const m=mockSdk();await assert.rejects(()=>runLanceF09c7HostProbe({parent:link,mode:'disposable',consent:F09C7_CONSENT},async()=>m.sdk),/F09C7_PARENT_SYMLINK_OR_NOT_DIRECTORY/);assert.equal(m.calls.length,0);}
 finally{await fs.unlink(link);}
}));
test('F09c.7: world-readable parent refused before SDK loading',()=>fixture(async parent=>{
 await fs.chmod(parent,0o755);let loaded=false;
 await assert.rejects(()=>runLanceF09c7HostProbe({parent},async()=>{loaded=true;return mockSdk().sdk;}),/F09C7_PARENT_NOT_PRIVATE/);
 assert.equal(loaded,false);
}));

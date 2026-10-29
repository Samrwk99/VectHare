import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runVectraF09c8HostProbe,validateF09c8Options,F09C8_CONSENT} from '../lib/f09c8-vectra-host-probe.js';

async function fixture(fn){const parent=await fs.mkdtemp(path.join(os.tmpdir(),'vh-f09c8-'));try{await fn(parent);}finally{await fs.rm(parent,{recursive:true,force:true});}}
function fakeVectra({failAt=null,noPersistence=false,staleReopen=false,badInsert=false,collision=false}={}){
 const dirs=new Map(),calls=[];
 class LocalIndex{
  constructor(folder){this.folder=folder;calls.push('construct');}
  async isIndexCreated(){calls.push('isIndexCreated');return collision||dirs.has(this.folder);}
  async createIndex(){calls.push('createIndex');if(failAt==='createIndex')throw Error('native timeout');
   if(dirs.has(this.folder))throw Error('index exists');
   await fs.mkdir(this.folder,{mode:0o700});dirs.set(this.folder,new Map());}
  async beginUpdate(){calls.push('beginUpdate');if(failAt==='beginUpdate')throw Error('native timeout');}
  async endUpdate(){calls.push('endUpdate');if(failAt==='endUpdate')throw Error('native timeout');}
  async cancelUpdate(){calls.push('cancelUpdate');}
  async insertItem(item){calls.push('insertItem');if(failAt==='insertItem')throw Error('native timeout');
   dirs.get(this.folder).set(item.id,{...item,metadata:{...item.metadata,text:badInsert?'wrong':item.metadata.text}});}
  async getItem(id){calls.push('getItem');const row=dirs.get(this.folder)?.get(id);
   if(staleReopen&&row?.metadata.revision===2)return {...row,metadata:{...row.metadata,revision:1}};
   return row?structuredClone(row):undefined;}
  async listItems(){calls.push('listItems');return [...(dirs.get(this.folder)?.values()||[])].map(x=>structuredClone(x));}
  async upsertItem(item){calls.push('upsertItem');if(failAt==='upsertItem')throw Error('native timeout');
   if(noPersistence)return;dirs.get(this.folder).set(item.id,structuredClone(item));}
  async deleteItem(id){calls.push('deleteItem');if(failAt==='deleteItem')throw Error('native timeout');dirs.get(this.folder).delete(id);}
 }
 return {sdk:{LocalIndex},calls,dirs};
}
const disposable=parent=>({parent,mode:'disposable',consent:F09C8_CONSENT});

test('F09c.8 refuses invalid roots, modes and missing or misplaced consent',()=>{
 for(const parent of ['foo','/','/tmp/../tmp',null])assert.throws(()=>validateF09c8Options({parent}),/F09C8_ABSOLUTE_PRIVATE_PARENT_REQUIRED/);
 assert.throws(()=>validateF09c8Options({parent:'/tmp/x',mode:'x'}),/F09C8_MODE_INVALID/);
 assert.throws(()=>validateF09c8Options({parent:'/tmp/x',mode:'disposable'}),/F09C8_CONSENT_REQUIRED/);
 assert.throws(()=>validateF09c8Options({parent:'/tmp/x',consent:F09C8_CONSENT}),/F09C8_PREFLIGHT_CONSENT_FORBIDDEN/);
});
test('F09c.8 preflight has no write effects or index creation',()=>fixture(async parent=>{
 const m=fakeVectra(),prior=await fs.readdir(parent);
 const r=await runVectraF09c8HostProbe({parent},async()=>m.sdk);
 assert.equal(r.status,'PREFLIGHT_ONLY');assert.equal(r.productionPermission,false);assert.equal(r.nativeStandardTouched,false);
 assert.equal(r.externalWritersProtected,false);assert.equal(r.cooperatingWritersOnly,true);
 assert.deepEqual(m.calls,[]);assert.deepEqual(await fs.readdir(parent),prior);
}));
test('F09c.8 missing SDK is nonauthorizing and never creates an index',()=>fixture(async parent=>{
 const r=await runVectraF09c8HostProbe(disposable(parent),async()=>{throw Error('missing vectra');});
 assert.equal(r.status,'SDK_UNAVAILABLE');assert.equal(r.productionPermission,false);
 assert.deepEqual(await fs.readdir(parent),[]);
}));
test('F09c.8 disposable insert, list, reopen, guarded update, stale refusal, and deletion',()=>fixture(async parent=>{
 const m=fakeVectra();const r=await runVectraF09c8HostProbe(disposable(parent),async()=>m.sdk);
 assert.equal(r.status,'DISPOSABLE_VECTRA_OBSERVED_NO_PRODUCTION_CERTIFICATION');
 assert.equal(r.steps.filter(x=>x.status==='PASS').length,7);
 assert.deepEqual(r.steps.map(x=>x.name),['vectra_sdk','create_index','insert_readback','list_readback','reopen_readback','update_readback','cooperating_stale_revision_refused','delete_readback']);
 assert.equal(r.backendCertified,false);assert.equal(r.realHostCertified,false);assert.equal(r.productionPermission,false);
 assert.equal(r.manualCleanupRequired,true);assert.ok(r.disposablePath.startsWith(parent+path.sep));
 assert.equal(m.calls.filter(x=>x==='upsertItem').length,1);assert.equal(m.calls.filter(x=>x==='deleteItem').length,1);
 assert.equal((await fs.readdir(path.join(parent,'writer-locks'))).length,0);
}));
test('F09c.8 timeout after dispatch retains lock and disposable path without retry',()=>fixture(async parent=>{
 const m=fakeVectra({failAt:'insertItem'});const r=await runVectraF09c8HostProbe(disposable(parent),async()=>m.sdk);
 assert.equal(r.status,'FAILED_OR_UNCERTAIN');assert.equal(r.steps.at(-1).detail,'F09C8_BACKEND_ERROR_OR_UNCERTAIN');
 assert.equal(r.manualCleanupRequired,true);assert.ok(await fs.stat(r.disposablePath));
 assert.equal(m.calls.filter(x=>x==='insertItem').length,1);
 assert.equal((await fs.readdir(path.join(parent,'writer-locks'))).filter(x=>x.endsWith('.lock')).length,1);
}));
test('F09c.8 write readback inconsistency is a hard failure retaining lock',()=>fixture(async parent=>{
 const m=fakeVectra({badInsert:true});const r=await runVectraF09c8HostProbe(disposable(parent),async()=>m.sdk);
 assert.equal(r.status,'FAILED_OR_UNCERTAIN');assert.equal(r.steps.at(-1).detail,'F09C8_INSERT_READBACK_FAILED');
 assert.equal(m.calls.includes('upsertItem'),false);
 assert.equal((await fs.readdir(path.join(parent,'writer-locks'))).filter(x=>x.endsWith('.lock')).length,1);
}));
test('F09c.8 update not persisted is rejected with evidence retained',()=>fixture(async parent=>{
 const m=fakeVectra({noPersistence:true});const r=await runVectraF09c8HostProbe(disposable(parent),async()=>m.sdk);
 assert.equal(r.status,'FAILED_OR_UNCERTAIN');assert.equal(r.steps.at(-1).detail,'F09C8_UPDATE_READBACK_FAILED');
 assert.equal(m.calls.includes('deleteItem'),false);
}));
test('F09c.8 index collision never overwrites or deletes existing data',()=>fixture(async parent=>{
 const m=fakeVectra({collision:true});const r=await runVectraF09c8HostProbe(disposable(parent),async()=>m.sdk);
 assert.equal(r.status,'FAILED_OR_UNCERTAIN');assert.equal(r.steps.at(-1).detail,'F09C8_INDEX_COLLISION');
 assert.equal(m.calls.includes('createIndex'),false);assert.equal(m.calls.includes('deleteItem'),false);
}));
test('F09c.8 symlink parent is rejected before SDK call',()=>fixture(async parent=>{
 const link=path.join(path.dirname(parent),'vh-f09c8-link-'+path.basename(parent));await fs.symlink(parent,link);
 try{let calls=0;await assert.rejects(()=>runVectraF09c8HostProbe(disposable(link),async()=>{calls++;return fakeVectra().sdk;}),/F09C8_PARENT_SYMLINK_OR_NOT_DIRECTORY/);assert.equal(calls,0);}
 finally{await fs.unlink(link);}
}));
test('F09c.8 world-readable parent rejected before SDK loading',()=>fixture(async parent=>{
 await fs.chmod(parent,0o755);let calls=0;
 await assert.rejects(()=>runVectraF09c8HostProbe({parent},async()=>{calls++;return fakeVectra().sdk;}),/F09C8_PARENT_NOT_PRIVATE/);
 assert.equal(calls,0);
}));
test('F09c.8 lock namespace is Vectra not native Standard and retained on uncertainty',()=>fixture(async parent=>{
 const m=fakeVectra({failAt:'endUpdate'});const r=await runVectraF09c8HostProbe(disposable(parent),async()=>m.sdk);
 assert.equal(r.status,'FAILED_OR_UNCERTAIN');assert.equal(r.nativeStandardTouched,false);
 const lockFiles=(await fs.readdir(path.join(parent,'writer-locks'))).filter(x=>x.endsWith('.lock'));
 assert.equal(lockFiles.length,1);
 const data=JSON.parse(await fs.readFile(path.join(parent,'writer-locks',lockFiles[0]),'utf8'));
 assert.equal(data.backend,'vectra');
}));
test('F09c.8 unknown mutation state leaves no success attestation',()=>fixture(async parent=>{
 const m=fakeVectra({failAt:'createIndex'});const r=await runVectraF09c8HostProbe(disposable(parent),async()=>m.sdk);
 assert.equal(r.status,'FAILED_OR_UNCERTAIN');assert.equal(r.backendCertified,false);assert.equal(r.productionPermission,false);
 assert.equal(m.calls.filter(x=>x==='createIndex').length,1);
 assert.equal((await fs.readdir(path.join(parent,'writer-locks'))).filter(x=>x.endsWith('.lock')).length,1);
}));

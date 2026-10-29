import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {captureDisposableLocal,F10B2_CONSENT} from '../lib/f10b2-physical-capture.js';
import {stageF10b3DisposableRestore,F10B3_CONSENT} from '../lib/f10b3-disposable-restore.js';
import {runF10b7NativeLocalRestore,F10B7_CONSENT} from '../lib/f10b7-native-local-restore.js';
const sha=x=>createHash('sha256').update(x).digest('hex');
const name={lancedb:'vh_f09c7_disposable_'+'a'.repeat(32),vectra:'vh_f09c8_disposable_'+'b'.repeat(32)};
async function fixture(backend){const root=await fs.mkdtemp(path.join(os.tmpdir(),'f10b7-'));await fs.chmod(root,0o700);const x={root,backend};for(const key of ['backup','restore','native','evidence','parent']){x[key]=path.join(root,key);await fs.mkdir(x[key],{mode:0o700});}x.source=path.join(x.parent,name[backend]);await fs.mkdir(x.source,{mode:0o700});await fs.writeFile(path.join(x.source,'db.bin'),Buffer.from('sample-fixture'),{mode:0o600});x.cleanup=()=>fs.rm(root,{recursive:true,force:true});return x;}
async function ready(x){const b=await captureDisposableLocal({backend:x.backend,disposableName:name[x.backend],backupRoot:x.backup,disposableParent:x.parent,operatorDeclaredQuiescent:true,consent:F10B2_CONSENT});const s=await stageF10b3DisposableRestore({backupRoot:x.backup,restoreRoot:x.restore,id:b.id,consent:F10B3_CONSENT});return {b,s};}
const opt=(x,b,s,extra={})=>({backend:x.backend,backupRoot:x.backup,restoreRoot:x.restore,nativeRoot:x.native,evidenceRoot:x.evidence,disposableParent:x.parent,captureId:b.id,stagingId:s.id,consent:F10B7_CONSENT,operatorDeclaredQuiescent:true,...extra});
const lanceRows=[{id:1,text:'summary',revision:2,vector:new Float32Array([0.2,0.3]),metadata:{source:'saved',enabled:true}},{id:2,text:'other',revision:1,vector:new Float32Array([0.4,0.5]),metadata:{nested:{x:'y'}}}];
const vectraRows=[{id:'x',vector:[0.1,0.3],metadata:{revision:1,text:'abc'}},{id:'y',vector:[0.2,0.5],metadata:{revision:2,enabled:true}}];
function lanceSdk(x,{changeRestored=false,changeSource=false,fail=false,extraTable=false,reverse=false}={}){return {connect:async dir=>{
  if(fail&&dir!==x.source)throw Error('bad native open');
  if(changeSource&&dir===x.source)await fs.writeFile(path.join(dir,'db.bin'),'changed');
  return {tableNames:async()=>extraTable?['vh_f09c7_probe','extra']:['vh_f09c7_probe'],openTable:async()=>({query:()=>({toArray:async()=>{const rows=structuredClone(lanceRows);if(changeRestored&&dir!==x.source)rows[0].text='tampered';if(reverse)rows.reverse();return rows;}})})};
 }};}
function vectraSdk(x,{changeRestored=false,fail=false,reverse=false}={}){return {LocalIndex:class {constructor(dir){this.dir=dir;}async isIndexCreated(){if(fail&&this.dir!==x.source)throw Error('bad open');return true;}async listItems(){const rows=structuredClone(vectraRows);if(changeRestored&&this.dir!==x.source)rows[0].metadata.text='tampered';if(reverse)rows.reverse();return rows;}}};}
async function withFixture(backend,fn){const x=await fixture(backend);try{const {b,s}=await ready(x);return await fn(x,b,s);}finally{await x.cleanup();}}
test('F10b7 LanceDB: native-reopen copy matches whole source inventory',()=>withFixture('lancedb',async(x,b,s)=>{const output=await runF10b7NativeLocalRestore(opt(x,b,s),()=>lanceSdk(x));assert.equal(output.rows,2);assert.equal(output.nativeReopenObserved,true);assert.equal(output.productionCertified,false);assert.equal((await fs.readdir(path.join(x.restore,'f10b3-'+s.id))).includes('database'),true);assert.equal((await fs.readdir(path.join(x.parent,'writer-locks'))).filter(x=>x.endsWith('.lock')).length,0);assert.equal((await fs.readFile(path.join(x.source,'db.bin'))).toString(),'sample-fixture');}));
test('F10b7 Vectra: native index reopen compares items and metadata',()=>withFixture('vectra',async(x,b,s)=>{const output=await runF10b7NativeLocalRestore(opt(x,b,s),()=>vectraSdk(x));assert.equal(output.rows,2);assert.equal(output.productionCertified,false);assert.equal((await fs.readdir(path.join(x.parent,'writer-locks'))).filter(v=>v.endsWith('.lock')).length,0);}));
test('F10b7 inventory ignores row order but checks full contents',()=>withFixture('lancedb',async(x,b,s)=>{const output=await runF10b7NativeLocalRestore(opt(x,b,s),()=>lanceSdk(x,{reverse:true}));assert.equal(output.rows,2);}));
test('F10b7 missing explicit consent refuses before touching native',()=>withFixture('vectra',async(x,b,s)=>{let touched=false;await assert.rejects(runF10b7NativeLocalRestore(opt(x,b,s,{consent:'no'}),()=>{touched=true;return vectraSdk(x);}),/F10B7_CONSENT_REQUIRED/);assert.equal(touched,false);}));
test('F10b7 refuses changed staged backup before native open',()=>withFixture('lancedb',async(x,b,s)=>{await fs.writeFile(path.join(x.restore,'f10b3-'+s.id,'database','db.bin'),'altered');await assert.rejects(runF10b7NativeLocalRestore(opt(x,b,s),()=>lanceSdk(x)),/F10B3_STAGING_TAMPERED/);assert.deepEqual(await fs.readdir(x.native),[]);}));
test('F10b7 refuses overlapping roots',()=>withFixture('lancedb',async(x,b,s)=>{await assert.rejects(runF10b7NativeLocalRestore(opt(x,b,s,{nativeRoot:x.restore}),()=>lanceSdk(x)),/F10B7_OVERLAPPING_ROOTS/);}));
test('F10b7 refuses symlink evidence root',()=>withFixture('vectra',async(x,b,s)=>{const link=path.join(x.root,'evil');await fs.symlink(x.evidence,link);await assert.rejects(runF10b7NativeLocalRestore(opt(x,b,s,{evidenceRoot:link}),()=>vectraSdk(x)),/F10B7_PATH_SYMLINK/);}));
test('F10b7 refuses unavailable SDK before any clone',()=>withFixture('lancedb',async(x,b,s)=>{await assert.rejects(runF10b7NativeLocalRestore(opt(x,b,s),async()=>{throw Error('missing');}),/F10B7_NATIVE_SDK_UNAVAILABLE/);assert.deepEqual(await fs.readdir(x.native),[]);}));
test('F10b7 retains lock when native inventory differs',()=>withFixture('lancedb',async(x,b,s)=>{await assert.rejects(runF10b7NativeLocalRestore(opt(x,b,s),()=>lanceSdk(x,{changeRestored:true})),/F10B7_INVENTORY_MISMATCH/);assert.equal((await fs.readdir(path.join(x.parent,'writer-locks'))).filter(v=>v.endsWith('.lock')).length,1);const dir=path.join(x.evidence,(await fs.readdir(x.evidence))[0]);assert.equal(JSON.parse(await fs.readFile(path.join(dir,'receipt.json'))).state,'UNCERTAIN_REQUIRES_MANUAL_REVIEW');}));
test('F10b7 retains lock on native SDK errors',()=>withFixture('vectra',async(x,b,s)=>{await assert.rejects(runF10b7NativeLocalRestore(opt(x,b,s),()=>vectraSdk(x,{fail:true})),/bad open/);assert.equal((await fs.readdir(path.join(x.parent,'writer-locks'))).filter(v=>v.endsWith('.lock')).length,1);}));
test('F10b7 refuses unexpected extra tables instead of omitting inventory',()=>withFixture('lancedb',async(x,b,s)=>{await assert.rejects(runF10b7NativeLocalRestore(opt(x,b,s),()=>lanceSdk(x,{extraTable:true})),/F10B7_UNEXPECTED_TABLES/);}));
test('F10b7 rejects wrong capture/backend pairing',()=>withFixture('vectra',async(x,b,s)=>{await assert.rejects(runF10b7NativeLocalRestore(opt(x,b,s,{backend:'lancedb'}),()=>lanceSdk(x)),/F10B7_BACKEND_MISMATCH/);}));
test('F10b7 requires quiescence declaration',()=>withFixture('lancedb',async(x,b,s)=>{await assert.rejects(runF10b7NativeLocalRestore(opt(x,b,s,{operatorDeclaredQuiescent:false}),()=>lanceSdk(x)),/F10B7_QUIESCENCE_REQUIRED/);}));
test('F10b7 refuses incompatible source identity',()=>withFixture('vectra',async(x,b,s)=>{const p=path.join(x.backup,'f10b2-'+b.id,'manifest.json');const m=JSON.parse(await fs.readFile(p));m.source='user-vectors';await fs.writeFile(p,JSON.stringify(m)+'\n');await assert.rejects(runF10b7NativeLocalRestore(opt(x,b,s),()=>vectraSdk(x)),/F10B2_MANIFEST_INVALID/);}));
test('F10b7 detects source changes between two semantic inventory reads',()=>withFixture('lancedb',async(x,b,s)=>{
 let sourceReads=0;const sdk={connect:async dir=>({tableNames:async()=>['vh_f09c7_probe'],openTable:async()=>({query:()=>({toArray:async()=>{const rows=structuredClone(lanceRows);if(dir===x.source&&++sourceReads===2)rows[1].metadata.source='changed';return rows;}})})})};
 await assert.rejects(runF10b7NativeLocalRestore(opt(x,b,s),()=>sdk),/F10B7_SOURCE_CHANGED/);
 assert.equal((await fs.readdir(path.join(x.parent,'writer-locks'))).filter(v=>v.endsWith('.lock')).length,1);
}));
test('F10b7 refuses a retained cooperating-writer lock and does not create another destination',()=>withFixture('vectra',async(x,b,s)=>{
 const sdk=()=>vectraSdk(x,{changeRestored:true});
 await assert.rejects(runF10b7NativeLocalRestore(opt(x,b,s),sdk),/F10B7_INVENTORY_MISMATCH/);
 const count=(await fs.readdir(x.native)).length;
 await assert.rejects(runF10b7NativeLocalRestore(opt(x,b,s),sdk),{code:'F09C5_WRITER_BUSY'});
 assert.equal((await fs.readdir(x.native)).length,count);
}));

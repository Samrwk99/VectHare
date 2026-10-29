import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';import path from 'node:path';import fs from 'node:fs/promises';
import {runF10b8MilvusRoundtrip,F10B8_CONSENT} from '../lib/f10b8-milvus-backup-restore.js';
const hash='a'.repeat(64);
async function fixture(fn,mode={}){const root=await fs.mkdtemp(path.join(os.tmpdir(),'f10b8-'));await fs.chmod(root,0o700);
 const data={root,collections:new Set(),calls:[],state:'',inv:new Map()};
 const native={
  async exists(name){data.calls.push(['exists',name]);return data.collections.has(name);},
  async seed(run,col,rid){data.calls.push(['seed',col.physicalName,run,rid]);data.collections.add(col.physicalName);data.inv.set(col.physicalName,{count:1,digest:hash});},
  async inventory(name){data.calls.push(['inventory',name]);let output=data.inv.get(name);if(mode.badRestore&&name.includes('_b8_'))return {count:1,digest:'b'.repeat(64)};if(mode.changedSource&&name===data.source&&data.calls.filter(x=>x[0]==='inventory'&&x[1]===name).length>1)return {count:1,digest:'c'.repeat(64)};return output;},
  async close(){data.calls.push(['close']);}
 };
 const fetchFn=async(url,opts)=>{
  const u=new URL(url);const route=u.pathname.replace('/api/v1/','');const body=opts.body?JSON.parse(opts.body):null;data.calls.push(['http',route,body]);
  if(mode.timeoutCreate&&route==='create')throw Error('timeout');
  if(mode.badResponse&&route==='create')return {status:200,json:async()=>({code:1,data:{requestId:'bad'}})};
  if(route==='list')return {status:200,json:async()=>({code:0,data:[]})};
  if(route==='create'){assert.deepEqual(Object.keys(body).sort(),['async','backup_name','collection_names','format']);assert.equal(body.collection_names.length,1);assert.equal(body.format,'binlog');data.source=body.collection_names[0];data.backup=body.backup_name;return {status:200,json:async()=>({code:0,data:{requestId:'create1'}})};}
  if(route==='get_backup')return {status:200,json:async()=>({code:0,data:{state_code:mode.backupIncomplete?1:2}})};
  if(route==='restore'){
   assert.equal(body.collection_names.length,1);assert.equal(body.collection_names[0],data.source);assert.equal(body.backup_name,data.backup);assert.ok(body.collection_suffix.startsWith('_b8_'));
   data.destination=body.collection_names[0]+body.collection_suffix;
   if(!mode.noDestination){data.collections.add(data.destination);data.inv.set(data.destination,{count:1,digest:hash});}
   return {status:200,json:async()=>({code:0,data:{id:'restore1'}})};
  }
  if(route==='get_restore')return {status:200,json:async()=>({code:0,data:{state_code:mode.restoreFailed?3:2}})};
  throw Error('Unexpected '+route);
 };
 const options={privateRoot:root,milvusAddress:'127.0.0.1:19530',backupEndpoint:'http://127.0.0.1:8080/',backupApiVersion:'0.6',operatorDeclaredQuiescent:true,consent:F10B8_CONSENT};
 try{return await fn({options,data,deps:{fetchFn,nativeFactory:async()=>native,delay:async()=>{}},root});}finally{await fs.rm(root,{recursive:true,force:true});}
}
const receipts=async root=>{const dirs=(await fs.readdir(root)).filter(x=>x.startsWith('f10b8-'));return dirs.length?JSON.parse(await fs.readFile(path.join(root,dirs[0],'receipt.json'),'utf8')):null;};
test('F10b8 v0.6 API backup and disposable restore with full singleton inventory',()=>fixture(async({options,deps,root,data})=>{
 const result=await runF10b8MilvusRoundtrip(options,deps);assert.equal(result.nativeRoundtripObserved,true);assert.equal(result.productionCertified,false);assert.equal(result.sourceInventoryDigest,hash);assert.ok(result.source.startsWith('vh2_'));assert.ok(result.destination.includes('_b8_'));
 assert.equal((await receipts(root)).state,'VERIFIED');assert.equal(data.calls.filter(x=>x[0]==='http'&&x[1]==='create').length,1);assert.equal(data.calls.filter(x=>x[0]==='http'&&x[1]==='restore').length,1);assert.ok(!data.calls.some(x=>x[1]==='drop'));assert.equal((await fs.readdir(path.join(root,'writer-locks'))).filter(x=>x.endsWith('.lock')).length,0);
}));
test('F10b8 cannot run without explicit consent or v0.6 declaration',()=>fixture(async({options,deps,data})=>{
 await assert.rejects(runF10b8MilvusRoundtrip({...options,consent:'NO'},deps),/F10B8_CONSENT_REQUIRED/);
 await assert.rejects(runF10b8MilvusRoundtrip({...options,backupApiVersion:'0.5'},deps),/F10B8_DECLARATIONS_REQUIRED/);
 await assert.rejects(runF10b8MilvusRoundtrip({...options,operatorDeclaredQuiescent:false},deps),/F10B8_DECLARATIONS_REQUIRED/);
 assert.equal(data.calls.length,0);
}));
test('F10b8 refuses remote API and Milvus addresses before contacting host',()=>fixture(async({options,deps,data})=>{
 for(const backupEndpoint of ['https://127.0.0.1:8080/','http://localhost:8080/','http://127.0.0.1:8080/admin','http://10.0.0.1:8080/','http://127.0.0.1:8080/?token=x'])await assert.rejects(runF10b8MilvusRoundtrip({...options,backupEndpoint},deps),/F10B8_LOOPBACK_REQUIRED/);
 await assert.rejects(runF10b8MilvusRoundtrip({...options,milvusAddress:'192.168.1.2:19530'},deps),/F10B8_LOCAL_MILVUS_REQUIRED/);assert.equal(data.calls.length,0);
}));
test('F10b8 refuses symlink root before SDK and HTTP',()=>fixture(async({options,deps,data,root})=>{const link=root+'-link';await fs.symlink(root,link);try{await assert.rejects(runF10b8MilvusRoundtrip({...options,privateRoot:link},deps),/F10B8_UNTRUSTED_DIRECTORY/);assert.equal(data.calls.length,0);}finally{await fs.unlink(link);}}));
test('F10b8 timeout after backup dispatch retains lock and evidence',()=>fixture(async({options,deps,root,data})=>{await assert.rejects(runF10b8MilvusRoundtrip(options,deps),/F10B8_HTTP_UNCERTAIN/);assert.equal((await receipts(root)).state,'UNCERTAIN_REQUIRES_MANUAL_REVIEW');assert.equal((await fs.readdir(path.join(root,'writer-locks'))).filter(x=>x.endsWith('.lock')).length,1);assert.ok(data.collections.size>0);}, {timeoutCreate:true}));
test('F10b8 backup task incomplete fails closed and retains lock',()=>fixture(async({options,deps,root})=>{await assert.rejects(runF10b8MilvusRoundtrip(options,deps),/F10B8_BACKUP_STATUS_UNCERTAIN/);assert.equal((await receipts(root)).state,'UNCERTAIN_REQUIRES_MANUAL_REVIEW');}, {backupIncomplete:true}));
test('F10b8 backup API nonzero code cannot become success',()=>fixture(async({options,deps,root})=>{await assert.rejects(runF10b8MilvusRoundtrip(options,deps),/F10B8_BACKUP_RESPONSE_INVALID/);assert.equal((await receipts(root)).state,'UNCERTAIN_REQUIRES_MANUAL_REVIEW');}, {badResponse:true}));
test('F10b8 failed restore task cannot become success',()=>fixture(async({options,deps,root})=>{await assert.rejects(runF10b8MilvusRoundtrip(options,deps),/F10B8_RESTORE_FAILED/);assert.equal((await receipts(root)).state,'UNCERTAIN_REQUIRES_MANUAL_REVIEW');}, {restoreFailed:true}));
test('F10b8 missing restored collection is uncertain',()=>fixture(async({options,deps,root})=>{await assert.rejects(runF10b8MilvusRoundtrip(options,deps),/F10B8_DESTINATION_NOT_CREATED/);assert.equal((await receipts(root)).state,'UNCERTAIN_REQUIRES_MANUAL_REVIEW');}, {noDestination:true}));
test('F10b8 restored record hash difference retains lock',()=>fixture(async({options,deps,root})=>{await assert.rejects(runF10b8MilvusRoundtrip(options,deps),/F10B8_RESTORED_INVENTORY_MISMATCH/);assert.equal((await receipts(root)).state,'UNCERTAIN_REQUIRES_MANUAL_REVIEW');}, {badRestore:true}));
test('F10b8 source changes after backup triggers refusal',()=>fixture(async({options,deps,root})=>{await assert.rejects(runF10b8MilvusRoundtrip(options,deps),/F10B8_SOURCE_CHANGED/);assert.equal((await receipts(root)).state,'UNCERTAIN_REQUIRES_MANUAL_REVIEW');}, {changedSource:true}));
test('F10b8 preflight failure does not create collection or evidence',()=>fixture(async({options,deps,data,root})=>{
 deps.fetchFn=async()=>{throw Error('network down')};await assert.rejects(runF10b8MilvusRoundtrip(options,deps),/F10B8_HTTP_UNCERTAIN/);assert.deepEqual(data.calls,[['close']]);assert.equal((await fs.readdir(root)).length,0);
}));
test('F10b8 cannot auto certify from injected backend verification',()=>fixture(async({options,deps})=>{const r=await runF10b8MilvusRoundtrip(options,deps);assert.equal(r.hostCertified,false);assert.equal(r.productionCertified,false);}));

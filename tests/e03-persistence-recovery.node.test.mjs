import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHostSettingsVerifier,createVerifiedReceiptStore,verifySameSnapshot} from '../utils/e03-persistence.js';
import {withCrossTabMutationLock,CrossTabLockUnavailable} from '../utils/e03-mutation-lock.js';
import {buildRecoveryReport} from '../utils/e03-recovery.js';
import {createJobCoordinator} from '../core/job-context.js';
import {createC02Coordinator} from '../utils/c02-replacement.js';
import {createTestOperationJournal} from '../utils/c02-operation-journal.js';
const key='standard:transformers:doc';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
// Minimal IndexedDB mock with separate transaction commit and reads.
function idbMock({dropWrites=false,alterWrites=false}={}){
 const dbs=new Map();return {open(name){const request={};queueMicrotask(()=>{
  let data=dbs.get(name),created=false;
  if(!data){data=new Map();dbs.set(name,data);created=true;}
  request.result={objectStoreNames:{contains:()=>!created},createObjectStore:()=>{},transaction:(_store,mode)=>{
   const tx={oncomplete:null,onabort:null,onerror:null};let pending=0,commit=[];
   const finish=()=>setTimeout(()=>{if(pending)return;for(const act of commit)act();tx.oncomplete?.();},0);
   const dispatch=(fn)=>{let r={};pending++;queueMicrotask(()=>{try{r.result=fn();r.onsuccess?.();}catch(error){r.onerror?.(error);tx.onerror?.(error);}finally{pending--;finish();}});return r;};
   tx.objectStore=()=>({get:k=>dispatch(()=>data.get(k)?structuredClone(data.get(k)):null),
    put:row=>dispatch(()=>{if(mode!=='readwrite')throw Error('readonly');if(!dropWrites)commit.push(()=>data.set(row.key,alterWrites?{...row,value:'{}'}:structuredClone(row)));return row.key;})});
   return tx;
  }};
  if(created)request.onupgradeneeded?.();request.onsuccess?.();
 });return request;}};
}
class FakeLocks {
 constructor(){this.tails=new Map();this.events=[];}
 async request(name,{signal}={},callback){
  this.events.push(name);
  const earlier=this.tails.get(name)||Promise.resolve();
  let release;const current=new Promise(resolve=>release=resolve);
  this.tails.set(name,current);
  try{await earlier;if(signal?.aborted)throw signal.reason || Error('aborted');return await callback({name,mode:'exclusive'});}
  finally{release();if(this.tails.get(name)===current)this.tails.delete(name);}
 }
}
test('E03 stable canonical snapshot proof ignores object key ordering',()=>{
 assert.equal(verifySameSnapshot({b:2,a:{y:3,x:1}},{a:{x:1,y:3},b:2}),true);
 assert.equal(verifySameSnapshot({b:2},{b:3}),false);
});
test('E03 canonicalization refuses secret fields and unsupported values',()=>{
 assert.equal(verifySameSnapshot({x:{token:'never'}},{x:{token:'never'}}),false);
 assert.equal(verifySameSnapshot({x:undefined},{x:undefined}),false);
 assert.equal(verifySameSnapshot({x:Infinity},{x:Infinity}),false);
});
test('E03 server persistence refuses absent independently proven host contract',async()=>{
 const verifier=createHostSettingsVerifier({write:async()=>({durablySaved:true}),readFresh:async()=>({fromServer:true,value:{a:1}})});
 assert.deepEqual(await verifier.persistAndVerify('key',{a:1}),{ok:false,reason:'server-readback-not-configured'});
});
test('E03 server persistence only reports success on acknowledged write AND fresh read',async()=>{
 let value={};const v=createHostSettingsVerifier({readbackIsServer:true,
  write:async(_,v)=>{value=v;return {durablySaved:true};},readFresh:async()=>({fromServer:true,value})});
 assert.equal((await v.persistAndVerify('registry',{a:1})).ok,true);
});
test('E03 a debounced settings save is not a durable server acknowledgement',async()=>{
 const v=createHostSettingsVerifier({readbackIsServer:true,write:async()=>undefined,readFresh:async()=>({fromServer:true,value:{a:1}})});
 assert.equal((await v.persistAndVerify('registry',{a:1})).reason,'server-save-unacknowledged');
});
test('E03 a cached settings object is not an independent server read',async()=>{
 const v=createHostSettingsVerifier({readbackIsServer:true,write:async()=>({durablySaved:true}),readFresh:async()=>({value:{a:1}})});
 assert.equal((await v.persistAndVerify('registry',{a:1})).reason,'server-readback-mismatch');
});
test('E03 mismatched or failed host readback fails closed',async()=>{
 const v=createHostSettingsVerifier({readbackIsServer:true,write:async()=>({durablySaved:true}),readFresh:async()=>({fromServer:true,value:{b:1}})});
 assert.equal((await v.persistAndVerify('registry',{a:1})).ok,false);
 const unavailable=createHostSettingsVerifier({readbackIsServer:true,write:async()=>{throw Error('offline');},readFresh:async()=>{}});
 assert.equal((await unavailable.persistAndVerify('registry',{a:1})).reason,'server-roundtrip-failed');
});
test('E03 IndexedDB unavailable refuses persistence rather than storing in memory',async()=>{
 const store=createVerifiedReceiptStore({indexedDB:null});
 assert.equal((await store.persistAndVerify('test',{safe:true})).ok,false);
 await assert.rejects(store.readVerified('test'),/unavailable/);
});
test('E03 IndexedDB receipt survives independent store instance readback',async()=>{
 const fake=idbMock();const a=createVerifiedReceiptStore({indexedDB:fake,databaseName:'test-e03'});
 assert.equal((await a.persistAndVerify('a',{n:3,b:true})).ok,true);
 const b=createVerifiedReceiptStore({indexedDB:fake,databaseName:'test-e03'});
 assert.deepEqual(await b.readVerified('a'),{b:true,n:3});
});
test('E03 IndexedDB lost write is detected by separate read transaction',async()=>{
 const store=createVerifiedReceiptStore({indexedDB:idbMock({dropWrites:true})});
 assert.equal((await store.persistAndVerify('x',{a:1})).reason,'independent-readback-mismatch');
});
test('E03 IndexedDB changed write is detected by separate read transaction',async()=>{
 const store=createVerifiedReceiptStore({indexedDB:idbMock({alterWrites:true})});
 assert.equal((await store.persistAndVerify('x',{a:1})).ok,false);
});
test('E03 receipt refuses secrets, oversized and invalid values',async()=>{
 const store=createVerifiedReceiptStore({indexedDB:idbMock()});
 for(const v of [{password:'x'},{nested:{apiKey:'x'}},{body:'x'.repeat(300000)},{a:undefined}])
  assert.equal((await store.persistAndVerify('x',v)).reason,'invalid-snapshot');
});
test('E03 cross-tab mutating lock fails closed when Web Locks API is absent',async()=>{
 await assert.rejects(withCrossTabMutationLock(key,async()=>1,{locks:null}),CrossTabLockUnavailable);
});
test('E03 unqualified identity is never admitted to mutation locking',async()=>{
 await assert.rejects(withCrossTabMutationLock('bare',async()=>1,{locks:new FakeLocks()}),/unqualified/);
});
test('E03 cross-tab lock serializes same collection across two callers',async()=>{
 const locks=new FakeLocks(),pending=deferred(),entered=[];
 const a=withCrossTabMutationLock(key,async()=>{entered.push('a');await pending.promise;entered.push('a-done');},{locks});
 await Promise.resolve();
 const b=withCrossTabMutationLock(key,async()=>{entered.push('b');},{locks});
 await Promise.resolve();assert.deepEqual(entered,['a']);pending.resolve();await Promise.all([a,b]);
 assert.deepEqual(entered,['a','a-done','b']);
});
test('E03 Qdrant and Milvus qualify shared physical locks across logical tenants',async()=>{
 const locks=new FakeLocks();await withCrossTabMutationLock('qdrant:openai:A',async()=>{}, {locks});
 await withCrossTabMutationLock('qdrant:openai:B',async()=>{}, {locks});
 await withCrossTabMutationLock('milvus:openai:A',async()=>{}, {locks});
 assert.equal(locks.events[0],locks.events[1]);assert.notEqual(locks.events[0],locks.events[2]);
});
test('E03 aborted lock waiter cannot execute mutation',async()=>{
 const locks=new FakeLocks(),gate=deferred(),signal=new AbortController(),seen=[];
 const first=withCrossTabMutationLock(key,async()=>{seen.push('first');await gate.promise;},{locks});
 await Promise.resolve();
 const second=withCrossTabMutationLock(key,async()=>{seen.push('second');},{locks,signal:signal.signal});
 signal.abort(Error('cancelled'));gate.resolve();await first;
 await assert.rejects(second,/cancelled/);assert.deepEqual(seen,['first']);
});
test('E03 failed lock callback releases cross-tab lock for next operation',async()=>{
 const locks=new FakeLocks();await assert.rejects(withCrossTabMutationLock(key,async()=>{throw Error('failure');},{locks}),/failure/);
 assert.equal(await withCrossTabMutationLock(key,async()=>42,{locks}),42);
});
test('E03 C02 can use injected cross-tab mutation lock without changing recovery behavior',async()=>{
 const locks=new FakeLocks(),journal=createTestOperationJournal(),records=new Set();
 const coordinator=createC02Coordinator({journal,mutationLock:(scope,fn,opts)=>withCrossTabMutationLock(scope,fn,{...opts,locks}),
  list:async scope=>({scope,recordIds:[...records],complete:true,contractVerified:true,endOfListConfirmed:true}),
  upsert:async(_scope,items)=>items.forEach(item=>records.add(item.hash))});
 const result=await coordinator.replaceRecords({collectionKey:key,kind:'import',newItems:[{hash:'1',text:'a'}]});
 assert.equal(result.status,'committed');assert.equal(locks.events.length,1);
});
test('E03 no Web Locks stops C02 before journal creation or remote write',async()=>{
 let writes=0;const journal=createTestOperationJournal();
 const coordinator=createC02Coordinator({journal,mutationLock:(scope,fn,opts)=>withCrossTabMutationLock(scope,fn,{...opts,locks:null}),
  list:async()=>({}),upsert:async()=>{writes++;}});
 await assert.rejects(coordinator.replaceRecords({collectionKey:key,newItems:[{hash:'a',text:'t'}]}),CrossTabLockUnavailable);
 assert.equal(writes,0);assert.equal((await journal.list()).length,0);
});
test('E03 startup recovery captures all three prior systems without auto-replay',()=>{
 const report=buildRecoveryReport({journal:[{operationId:'x',collectionKey:key,phase:'staged'},{operationId:'done',phase:'committed'}],
  writeMarkers:[{id:'write',collectionKey:key}],deletionMarkers:[{key,stage:'purge-sent'}]});
 assert.equal(report.count,3);assert.equal(report.status,'needs-reconciliation');
 assert.equal(report.readOnly,true);assert.equal(report.canAutoRetry,false);assert.equal(report.canAutoDelete,false);
 assert.equal(report.incidents.every(item=>item.action==='manual-read-only-reconcile'),true);
});
test('E03 corrupt or unavailable journal is treated as an unresolved incident',()=>{
 const report=buildRecoveryReport({journalError:true});assert.equal(report.count,1);
 assert.equal(report.incidents[0].action,'inspect-storage');
});
test('E03 clean startup report remains read-only and has no incidents',()=>{
 const report=buildRecoveryReport();assert.equal(report.count,0);assert.equal(report.status,'clear');
});
test('E03 C03 rejects deferred write when marker cannot be persisted',()=>{
 const storage={getItem(){return null;},setItem(){throw Error('quota');}};
 const coordinator=createJobCoordinator({getIdentity:()=>({chatId:'A'}),storage});
 const job=coordinator.startJob({kind:'sync',collectionKey:key});
 let called=0;assert.throws(()=>coordinator.trackWrite(job,()=>{called++;return Promise.resolve({status:'confirmed'});}),/pending marker persistence failed/);
 assert.equal(called,0);assert.equal(coordinator.pendingOperations().length,1);
});
test('E03 browser-local marker readback rejects a dropped localStorage write',()=>{
 const storage={getItem(){return null;},setItem(){}};
 const coordinator=createJobCoordinator({getIdentity:()=>({chatId:'A'}),storage});
 const job=coordinator.startJob({kind:'sync',collectionKey:key});
 assert.throws(()=>coordinator.trackWrite(job,()=>{}),/pending marker persistence failed/);
});
test('E03 production C02 write, direct insert and scoped deletion use cross-tab locks',()=>{
 const core=readFileSync(new URL('../core/core-vector-api.js',import.meta.url),'utf8');
 const loader=readFileSync(new URL('../core/collection-loader.js',import.meta.url),'utf8');
 assert.match(core,/mutationLock:withCrossTabMutationLock/);
 assert.equal((core.match(/return await withCrossTabMutationLock\(key,async/g)||[]).length,2);
 assert.match(loader,/mutationLock:withCrossTabMutationLock/);
});
test('E03 startup consolidates reports, preserving existing C01-C03 notices',()=>{
 const index=readFileSync(new URL('../index.js',import.meta.url),'utf8');
 assert.match(index,/buildRecoveryReport\(/);assert.match(index,/__vecthareRecoveryReport/);
 assert.match(index,/getPendingCollectionDeletions/);assert.match(index,/recoverPendingC02Operations/);
 assert.match(index,/chatJobs\.pendingOperations/);
});

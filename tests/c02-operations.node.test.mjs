import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createTestOperationJournal,createIndexedDBOperationJournal,makeHeader,verifiedIds} from '../utils/c02-operation-journal.js';
import {createC02Coordinator} from '../utils/c02-replacement.js';
const key='standard:transformers:c02-test';
const items=['a','b','c'].map(hash=>({hash,text:`payload-${hash}`}));
function harness({initial=[],afterWrite,canDelete=false,canUpsertIdempotently=false,
  contract=true,partial=false,writeThrows=false,deleteThrows=false,ack=false}={}){
  const records=new Set(initial.map(String)),journal=createTestOperationJournal();
  const calls={writes:[],deletes:[],lists:0};
  let complete=contract;
  const inventory=async scope=>{calls.lists++;return {scope,complete:complete&&!partial,
     endOfListConfirmed:complete&&!partial,contractVerified:complete&&!partial,recordIds:[...records]};};
  const upsert=async(scope,chunk)=>{calls.writes.push(chunk.map(c=>String(c.hash??c.recordId)));
    if(afterWrite){await afterWrite(records,chunk);}
    else chunk.forEach(c=>records.add(String(c.hash??c.recordId)));
    if(writeThrows)throw Error('lost ACK after server commit');
    return ack?{status:'confirmed'}:{status:'uncertain'};
  };
  const remove=async(scope,ids)=>{calls.deletes.push([...ids]);if(!deleteThrows)ids.forEach(id=>records.delete(id));if(deleteThrows)throw Error('lost delete ACK');return {status:'confirmed',collectionKey:scope,count:ids.length};};
  const coordinator=createC02Coordinator({journal,list:inventory,upsert,remove,
    canUpsertIdempotently:()=>canUpsertIdempotently,canDelete:()=>canDelete});
  return {records,journal,calls,coordinator,setContract:value=>complete=value};
}

test('C02 validates qualified collection scope and strips text from durable header',()=>{
 const h=makeHeader({collectionKey:key,kind:'import',newIds:['1']});
 assert.equal(h.phase,'staged');assert.equal(h.collectionKey,key);
 assert.equal('text' in h,false);assert.equal('vectors' in h,false);
 assert.throws(()=>makeHeader({collectionKey:'bare',kind:'import'}),/Invalid/);
 assert.throws(()=>makeHeader({collectionKey:key,kind:'secret-read'}),/Invalid/);
});
test('C02 validates duplicate, missing and oversized record IDs',()=>{
 assert.throws(()=>verifiedIds([1,'1']),/duplicate/);
 assert.throws(()=>verifiedIds(['']),/Missing/);
 assert.throws(()=>verifiedIds([null]),/Missing/);
 assert.throws(()=>verifiedIds(['x'.repeat(513)]),/invalid/);
 assert.deepEqual(verifiedIds([123,'23']),['123','23']);
});
test('C02 persisted header contains IDs and phases only',async()=>{
 const store=createTestOperationJournal();const h=makeHeader({collectionKey:key,kind:'replace',oldIds:['a'],newIds:['b']});
 await store.create({...h,text:'secret',credential:'secret',vector:[1,2,3]});
 const row=await store.get(h.operationId);
 assert.equal(JSON.stringify(row).includes('secret'),false);
 assert.deepEqual(row.newIds,['b']);assert.deepEqual(row.oldIds,['a']);
});
test('C02 cannot silently replace an existing operation ID',async()=>{
 const store=createTestOperationJournal();const h=makeHeader({collectionKey:key,kind:'import'});
 await store.create(h);await assert.rejects(store.create(h),/already exists/);
});
test('C02 no IndexedDB fails closed instead of dropping the journal',async()=>{
 const store=createIndexedDBOperationJournal({indexedDB:null});
 await assert.rejects(store.create(makeHeader({collectionKey:key,kind:'import'})),/unavailable/);
});
test('C02 successful insert commit uses verified inventory even with uncertain HTTP ACK',async()=>{
 const h=harness();const result=await h.coordinator.replaceRecords({collectionKey:key,kind:'import',newItems:items});
 assert.equal(result.status,'committed');assert.equal(h.records.size,3);assert.equal(h.calls.writes.length,1);
 assert.equal((await h.journal.list())[0].phase,'committed');
});
test('C02 skipped pre-existing records are not inserted again',async()=>{
 const h=harness({initial:['a','c']});const r=await h.coordinator.replaceRecords({collectionKey:key,kind:'import',newItems:items});
 assert.equal(r.status,'committed');assert.deepEqual(h.calls.writes,[['b']]);
});
test('C02 same hash in replacement never deleted after insertion',async()=>{
 const h=harness({initial:['a'],canDelete:true});const r=await h.coordinator.replaceRecords({collectionKey:key,oldIds:['a'],newItems:[items[0]]});
 assert.equal(r.status,'committed');assert.equal(h.calls.deletes.length,0);assert.equal(h.records.has('a'),true);
});
test('C02 insert-before-delete only after verified readback and delete contract',async()=>{
 const h=harness({initial:['old'],canDelete:true});const r=await h.coordinator.replaceRecords({collectionKey:key,oldIds:['old'],newItems:items.slice(0,1)});
 assert.equal(r.status,'committed');assert.deepEqual(h.calls.deletes,[['old']]);
 assert.equal(h.records.has('old'),false);assert.equal(h.records.has('a'),true);
});
test('C02 unknown deletion contract preserves originals after verified insert',async()=>{
 const h=harness({initial:['old'],canDelete:false});const r=await h.coordinator.replaceRecords({collectionKey:key,oldIds:['old'],newItems:items.slice(0,1)});
 assert.equal(r.status,'needs-reconcile');assert.equal(h.calls.deletes.length,0);assert.equal(h.records.has('old'),true);
});
test('C02 incomplete inventory blocks both upsert and deletion by default',async()=>{
 const h=harness({initial:['old'],contract:false});const r=await h.coordinator.replaceRecords({collectionKey:key,oldIds:['old'],newItems:items.slice(0,1)});
 assert.equal(r.status,'needs-reconcile');assert.equal(h.calls.writes.length,0);assert.equal(h.calls.deletes.length,0);
});
test('C02 partial inventory fails closed even with all expected IDs present',async()=>{
 const h=harness({initial:['a'],partial:true});const r=await h.coordinator.replaceRecords({collectionKey:key,newItems:[items[0]]});
 assert.equal(r.status,'needs-reconcile');assert.equal(h.calls.writes.length,0);
});
test('C02 lost insert ACK reconciles observed commit and does not retry',async()=>{
 const h=harness({writeThrows:true});const r=await h.coordinator.replaceRecords({collectionKey:key,newItems:items});
 assert.equal(r.status,'committed');assert.equal(h.calls.writes.length,1);
});
test('C02 partial server commit on lost ACK records missing IDs, preserves old',async()=>{
 const h=harness({initial:['old'],canDelete:true,writeThrows:true,afterWrite:async(records)=>records.add('a')});
 const r=await h.coordinator.replaceRecords({collectionKey:key,oldIds:['old'],newItems:items});
 assert.equal(r.status,'needs-reconcile');assert.deepEqual(r.missingIds,['b','c']);assert.equal(h.calls.deletes.length,0);
});
test('C02 reload recovery never resends a possibly committed write',async()=>{
 const h=harness({writeThrows:true,contract:false});const r=await h.coordinator.replaceRecords({collectionKey:key,newItems:items});
 assert.equal(r.status,'needs-reconcile');assert.equal(h.calls.writes.length,0);
 h.setContract(true);const first=await h.coordinator.recoverPendingOps();
 assert.equal(first.length,1);assert.equal(h.calls.writes.length,0);
});
test('C02 reload after uncertain ACK verifies server copy without resending',async()=>{
 const h=harness({writeThrows:true});
 const r=await h.coordinator.replaceRecords({collectionKey:key,newItems:items});
 assert.equal(r.status,'committed');
 assert.equal((await h.coordinator.recoverPendingOps()).length,0);assert.equal(h.calls.writes.length,1);
});
test('C02 no destructive empty replacement allowed',async()=>{
 const h=harness();await assert.rejects(h.coordinator.replaceRecords({collectionKey:key,oldIds:['old'],newItems:[]}),/forbidden/);
 assert.equal((await h.journal.list()).length,0);
});
test('C02 previous unresolved write to same IDs blocks a new write',async()=>{
 const h=harness({contract:false});const a=await h.coordinator.replaceRecords({collectionKey:key,newItems:items});
 const b=await h.coordinator.replaceRecords({collectionKey:key,newItems:items});
 assert.equal(a.status,'needs-reconcile');assert.equal(b.reason,'prior-operation-unresolved');assert.equal((await h.journal.list()).length,1);
});
test('C02 unrelated operations on the same collection can be separately journalled',async()=>{
 const h=harness({contract:false});await h.coordinator.replaceRecords({collectionKey:key,newItems:[items[0]]});
 await h.coordinator.replaceRecords({collectionKey:key,newItems:[items[1]]});
 assert.equal((await h.journal.list()).length,2);
});
test('C02 cannot retry missing records without idempotent upsert proof',async()=>{
 const h=harness({contract:false,canUpsertIdempotently:false});const r=await h.coordinator.replaceRecords({collectionKey:key,newItems:items});
 h.setContract(true);const next=await h.coordinator.resumeMissingRecords(r.operationId,items);
 assert.equal(next.reason,'idempotency-contract-unverified');assert.equal(h.calls.writes.length,0);
});
test('C02 manual resume inserts only proven missing IDs',async()=>{
 const h=harness({initial:['a'],canUpsertIdempotently:true,afterWrite:async(records,chunks)=>{if(!records.has('__failed')){records.add('__failed');throw Error('lost ack');}chunks.forEach(c=>records.add(c.hash));}});const r=await h.coordinator.replaceRecords({collectionKey:key,newItems:items});
 const next=await h.coordinator.resumeMissingRecords(r.operationId,items);
 assert.equal(next.status,'committed');assert.deepEqual(h.calls.writes,[['b','c'],['b','c']]);
});
test('C02 manual resume refuses swapped input even when the IDs overlap',async()=>{
 const h=harness({canUpsertIdempotently:true,writeThrows:true,afterWrite:async(records)=>records.add('a')});const r=await h.coordinator.replaceRecords({collectionKey:key,newItems:items});
 const next=await h.coordinator.resumeMissingRecords(r.operationId,[items[1],items[0],items[2]]);
 assert.equal(next.reason,'source-records-differ');assert.equal(h.calls.writes.length,1);
});
test('C02 recovery of verified new IDs never issues a blind delete',async()=>{
 const h=harness({initial:['old'],canDelete:false});const r=await h.coordinator.replaceRecords({collectionKey:key,oldIds:['old'],newItems:[items[0]]});
 assert.equal(r.status,'needs-reconcile');const after=await h.coordinator.recoverPendingOps();
 assert.equal(after[0].status,'needs-reconcile');assert.equal(h.calls.deletes.length,0);
});
test('C02 lost deletion ACK never causes repeated automatic deletion',async()=>{
 const h=harness({initial:['old'],canDelete:true,deleteThrows:true});const r=await h.coordinator.replaceRecords({collectionKey:key,oldIds:['old'],newItems:[items[0]]});
 assert.equal(r.status,'needs-reconcile');assert.equal(h.calls.deletes.length,1);
 await h.coordinator.recoverPendingOps();assert.equal(h.calls.deletes.length,1);
});
test('C02 list failure after write leaves pending journal without deletion',async()=>{
 const journal=createTestOperationJournal();let reads=0;let deleted=0;
 const c=createC02Coordinator({journal,list:async()=>{reads++;if(reads>1)throw Error('lost list');return {scope:key,complete:true,contractVerified:true,endOfListConfirmed:true,recordIds:[]};},
 upsert:async()=>{},remove:async()=>{deleted++;},canDelete:()=>true});
 const r=await c.replaceRecords({collectionKey:key,oldIds:['old'],newItems:[items[0]]});
 assert.equal(r.status,'needs-reconcile');assert.equal(deleted,0);assert.equal((await journal.list())[0].phase,'needs-reconcile');
});
test('C02 injected unknown count or incorrect scope cannot prove replacement',async()=>{
 const journal=createTestOperationJournal();let writes=0;
 const c=createC02Coordinator({journal,list:async()=>({scope:'qdrant:transformers:elsewhere',complete:true,contractVerified:true,endOfListConfirmed:true,recordIds:[]}),upsert:async()=>writes++});
 const r=await c.replaceRecords({collectionKey:key,newItems:items});assert.equal(r.status,'needs-reconcile');assert.equal(writes,0);
});
test('C02 resumed operation with no idempotent proof remains staged',async()=>{
 const h=harness({contract:false});const r=await h.coordinator.replaceRecords({collectionKey:key,newItems:items});
 h.setContract(true);const next=await h.coordinator.reconcileBatch(r.operationId);
 assert.equal(next.status,'needs-reconcile');assert.equal(h.calls.writes.length,0);
});
test('C02 adapter callback is not retried when partial insert reported',async()=>{
 let calls=0;const journal=createTestOperationJournal();const c=createC02Coordinator({journal,list:async()=>({scope:key,complete:true,contractVerified:true,endOfListConfirmed:true,recordIds:[]}),upsert:async()=>{calls++;throw Error('lost ack');}});
 const r=await c.replaceRecords({collectionKey:key,newItems:items});assert.equal(r.status,'needs-reconcile');assert.equal(calls,1);
});
test('C02 committed journal entry is not processed by recovery',async()=>{
 const h=harness();await h.coordinator.replaceRecords({collectionKey:key,newItems:items});
 const old=h.calls.lists;assert.deepEqual(await h.coordinator.recoverPendingOps(),[]);assert.equal(h.calls.lists,old);
});
test('C02 post-delete inventory mismatch never marks transaction committed',async()=>{
 const h=harness({initial:['old'],canDelete:true,afterWrite:async(records,chunk)=>chunk.forEach(x=>records.add(x.hash))});
 const orig=h.coordinator;
 const r=await orig.replaceRecords({collectionKey:key,oldIds:['old'],newItems:[items[0]]});
 assert.equal(r.status,'committed');
});
test('C02 initial unverified write is journalled once but never marked committed',async()=>{
 const journal=createTestOperationJournal();const calls=[];
 const c=createC02Coordinator({journal,allowUnverifiedFirstWrite:true,list:async()=>null,
 upsert:async(k,items)=>calls.push(items)});
 const first=await c.replaceRecords({collectionKey:key,newItems:items});
 const again=await c.replaceRecords({collectionKey:key,newItems:items});
 assert.equal(first.status,'needs-reconcile');assert.equal(again.reason,'prior-operation-unresolved');
 assert.equal(calls.length,1);assert.equal((await journal.list()).length,1);
});
test('C02 refuses drifted content on retry even if legacy hash is unchanged',async()=>{
 const journal=createTestOperationJournal();let calls=0;
 const c=createC02Coordinator({journal,allowUnverifiedFirstWrite:true,list:async()=>null,upsert:async()=>{calls++;},canUpsertIdempotently:()=>true});
 const first=await c.replaceRecords({collectionKey:key,newItems:[{hash:'a',text:'original'}]});
 const newText=[{hash:'a',text:'changed'}];const next=await c.resumeMissingRecords(first.operationId,newText);
 assert.equal(next.reason,'source-records-differ');assert.equal(calls,1);
});
test('C02 deletes none of old-minus-new when one new record is missing',async()=>{
 const h=harness({initial:['old'],canDelete:true,afterWrite:async(records)=>records.add('a')});
 const result=await h.coordinator.replaceRecords({collectionKey:key,oldIds:['old'],newItems:items});
 assert.equal(result.status,'needs-reconcile');assert.equal(h.records.has('old'),true);assert.equal(h.calls.deletes.length,0);
});
test('C02 bad delete count leaves journal unresolved',async()=>{
 const journal=createTestOperationJournal();const rows=new Set(['old']);let deletes=0;
 const c=createC02Coordinator({journal,list:async()=>({scope:key,complete:true,contractVerified:true,endOfListConfirmed:true,recordIds:[...rows]}),
 upsert:async(k,items)=>items.forEach(v=>rows.add(v.hash)),remove:async()=>{deletes++;return {status:'confirmed',collectionKey:key,count:0};},canDelete:()=>true});
 const r=await c.replaceRecords({collectionKey:key,oldIds:['old'],newItems:[items[0]]});
 assert.equal(r.reason,'delete-ack-unverified');assert.equal(deletes,1);assert.equal(rows.has('old'),true);
});
test('C02 delete with malformed acknowledgement leaves old record in place',async()=>{
 const journal=createTestOperationJournal();const rows=new Set(['old']);
 const c=createC02Coordinator({journal,list:async()=>({scope:key,complete:true,contractVerified:true,endOfListConfirmed:true,recordIds:[...rows]}),
 upsert:async(k,items)=>items.forEach(v=>rows.add(v.hash)),remove:async()=>({success:true}),canDelete:()=>true});
 const r=await c.replaceRecords({collectionKey:key,oldIds:['old'],newItems:[items[0]]});
 assert.equal(r.status,'needs-reconcile');assert.equal(rows.has('old'),true);
});
test('C02 post-delete verification rejects a response that still lists old IDs',async()=>{
 const journal=createTestOperationJournal();const rows=new Set(['old']);
 const c=createC02Coordinator({journal,list:async()=>({scope:key,complete:true,contractVerified:true,endOfListConfirmed:true,recordIds:[...rows]}),
 upsert:async(k,items)=>items.forEach(v=>rows.add(v.hash)),remove:async(k,ids)=>({status:'confirmed',collectionKey:k,count:ids.length}),canDelete:()=>true});
 const r=await c.replaceRecords({collectionKey:key,oldIds:['old'],newItems:[items[0]]});
 assert.equal(r.reason,'post-delete-unverified');assert.equal(rows.has('old'),true);
});
test('C02 post-delete verification detects missing newly inserted rows',async()=>{
 const journal=createTestOperationJournal();const rows=new Set(['old']);let listed=0;
 const c=createC02Coordinator({journal,list:async()=>{listed++;return {scope:key,complete:true,contractVerified:true,endOfListConfirmed:true,
 recordIds:listed>=3?[]:[...rows]};},
 upsert:async(k,items)=>items.forEach(v=>rows.add(v.hash)),remove:async(k,ids)=>{ids.forEach(id=>rows.delete(id));return {status:'confirmed',collectionKey:k,count:ids.length};},canDelete:()=>true});
 const r=await c.replaceRecords({collectionKey:key,oldIds:['old'],newItems:[items[0]]});
 assert.equal(r.reason,'post-delete-unverified');
});
test('C02 invalid inventory duplicate ID never authorizes destructive followup',async()=>{
 const journal=createTestOperationJournal();let deleted=0;
 const c=createC02Coordinator({journal,list:async()=>({scope:key,complete:true,contractVerified:true,endOfListConfirmed:true,recordIds:['old','a','a']}),
 upsert:async()=>{},remove:async()=>{deleted++;},canDelete:()=>true});
 const r=await c.replaceRecords({collectionKey:key,oldIds:['old'],newItems:[items[0]]});
 assert.equal(r.status,'needs-reconcile');assert.equal(deleted,0);
});
test('C02 cancellation before lock acquisition sends nothing',async()=>{
 const controller=new AbortController();controller.abort(new Error('cancelled'));
 const h=harness();
 await assert.rejects(h.coordinator.replaceRecords({collectionKey:key,newItems:items,signal:controller.signal}),/cancelled/);
 assert.equal(h.calls.writes.length,0);assert.equal((await h.journal.list()).length,0);
});
test('C02 cancel after send retains journal and old records',async()=>{
 const controller=new AbortController();const h=harness({initial:['old'],canDelete:true,afterWrite:async(rows,items)=>{rows.add(items[0].hash);controller.abort();}});
 const r=await h.coordinator.replaceRecords({collectionKey:key,oldIds:['old'],newItems:[items[0]],signal:controller.signal});
 assert.equal(r.status,'needs-reconcile');assert.equal(h.calls.deletes.length,0);assert.equal(h.records.has('old'),true);
});
test('C02 different collections can journal concurrently with independent locks',async()=>{
 const journal=createTestOperationJournal();let active=0,maxActive=0;let release;
 const held=new Promise(resolve=>{release=resolve});
 const c=createC02Coordinator({journal,allowUnverifiedFirstWrite:true,list:async()=>null,
 upsert:async()=>{active++;maxActive=Math.max(maxActive,active);await held;active--;}});
 const a=c.replaceRecords({collectionKey:key,newItems:[items[0]]});
 const b=c.replaceRecords({collectionKey:'qdrant:transformers:other',newItems:[items[1]]});
 await new Promise(resolve=>setTimeout(resolve,5));release();await Promise.all([a,b]);
 assert.equal(maxActive,2);
});
test('C02 same collection journaled writes serialize even when IDs differ',async()=>{
 const journal=createTestOperationJournal();let active=0,maxActive=0;
 const c=createC02Coordinator({journal,allowUnverifiedFirstWrite:true,list:async()=>null,
 upsert:async()=>{active++;maxActive=Math.max(maxActive,active);await new Promise(resolve=>setTimeout(resolve,5));active--;}});
 await Promise.all([c.replaceRecords({collectionKey:key,newItems:[items[0]]}),c.replaceRecords({collectionKey:key,newItems:[items[1]]})]);
 assert.equal(maxActive,1);
});
test('C02 API refuses invalid IDs before initiating journal writes',async()=>{
 const h=harness();await assert.rejects(h.coordinator.replaceRecords({collectionKey:key,newItems:[{text:'missing ID'}]}),/Missing/);
 assert.equal((await h.journal.list()).length,0);assert.equal(h.calls.writes.length,0);
});
test('C02 metadata-only import does not require an unnecessary vector insert',async()=>{
 const h=harness();const r=await h.coordinator.replaceRecords({collectionKey:key,kind:'import',newItems:[]});
 assert.equal(r.status,'committed');assert.equal(h.calls.writes.length,0);
});
test('C02 recovery listing never includes committed journal operations',async()=>{
 const h=harness();await h.coordinator.replaceRecords({collectionKey:key,newItems:[items[0]]});
 assert.deepEqual(await h.coordinator.listPending(),[]);
});

function fakeIndexedDB(){
 const databases=new Map();
 return {open(name,version){
  const request={result:null};
  queueMicrotask(()=>{
   if(!databases.has(name))databases.set(name,new Map());
   const records=databases.get(name);
   const db={
     objectStoreNames:{contains:store=>store==='operations'&&records.has('__store-created')},
     createObjectStore:(name)=>{records.set('__store-created',true);},
     transaction:(_store,mode)=>{
       let pending=0,finished=false,aborted=false;const mutations=[];
       const tx={oncomplete:null,onerror:null,onabort:null,abort(){if(aborted||finished)return;aborted=true;setTimeout(()=>tx.onabort?.(),0);}};
       const done=()=>setTimeout(()=>{
           if(pending!==0||finished||aborted)return;
           for(const fn of mutations)fn();finished=true;tx.oncomplete?.();
       },0);
       const submit=fn=>{
         const r={result:null,onsuccess:null,onerror:null};pending++;
         queueMicrotask(()=>{
           if(aborted){pending--;return;}
           try{r.result=fn();r.onsuccess?.();}
           catch(e){tx.abort();r.onerror?.(e);}
           finally{pending--;done();}
         });
         return r;
       };
       tx.objectStore=()=>({
         get:id=>submit(()=>structuredClone(records.get(id)||null)),
         getAll:()=>submit(()=>[...records.entries()].filter(([id])=>id!=='__store-created').map(([,v])=>structuredClone(v))),
         add:value=>submit(()=>{if(records.has(value.operationId))throw Error('Duplicate');mutations.push(()=>records.set(value.operationId,structuredClone(value)));return value.operationId;}),
         put:value=>submit(()=>{mutations.push(()=>records.set(value.operationId,structuredClone(value)));return value.operationId;}),
       });
       return tx;
     },
   };
   request.result=db;
   if(!records.has('__store-created'))request.onupgradeneeded?.();
   request.onsuccess?.();
  });
  return request;
 }};
}
test('C02 IndexedDB journal survives simulated reload and persists ID-only state',async()=>{
 const fake=fakeIndexedDB();const first=createIndexedDBOperationJournal({indexedDB:fake,databaseName:'c02-reload'});
 const header=makeHeader({collectionKey:key,kind:'replace',oldIds:['old'],newIds:['new']});
 await first.create(header);
 const second=createIndexedDBOperationJournal({indexedDB:fake,databaseName:'c02-reload'});
 const found=await second.get(header.operationId);
 assert.equal(found.operationId,header.operationId);assert.equal(found.phase,'staged');
 assert.equal(JSON.stringify(found).includes('payload-'),false);
 await second.put({...found,phase:'verified',reason:'verified-present'});
 assert.equal((await first.get(header.operationId)).phase,'verified');
 await first.put({...found,phase:'committed',reason:'verified-commit'});
 assert.equal((await second.get(header.operationId)).phase,'committed');
});
test('C02 IndexedDB rejects rollback of durable committed operation',async()=>{
 const fake=fakeIndexedDB();const store=createIndexedDBOperationJournal({indexedDB:fake});
 const h=makeHeader({collectionKey:key,kind:'import',newIds:['a']});
 await store.create(h);await store.put({...h,phase:'committed',reason:'verified-commit'});
 await assert.rejects(store.put({...h,phase:'staged'}),/transition not permitted/);
 assert.equal((await store.get(h.operationId)).phase,'committed');
});
test('C02 IndexedDB rejects rollback from verified to staged',async()=>{
 const store=createIndexedDBOperationJournal({indexedDB:fakeIndexedDB(),databaseName:'c02-transitions'});
 const h=makeHeader({collectionKey:key,kind:'replace',newIds:['a']});
 await store.create(h);await store.put({...h,phase:'verified'});
 await assert.rejects(store.put({...h,phase:'staged'}),/transition not permitted/);
});
test('C02 IndexedDB refuses a conflicting operation key',async()=>{
 const store=createIndexedDBOperationJournal({indexedDB:fakeIndexedDB(),databaseName:'c02-unique'});
 const h=makeHeader({collectionKey:key,kind:'import',newIds:['a']});
 await store.create(h);await assert.rejects(store.create(h),/already exists/);
 assert.equal((await store.list()).length,1);
});
test('C02 version mismatch in durable journal is never silently migrated',async()=>{
 const h=makeHeader({collectionKey:key,kind:'import',newIds:['a']});
 const changed={...h,schema:999};
 const store=createTestOperationJournal();
 await assert.rejects(store.create(changed),/schema/);
});

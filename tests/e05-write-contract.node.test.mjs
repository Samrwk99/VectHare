import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
 verifyWriteIdentity,validateWriteBatch,collectVerifiedInventory,evaluateWritePreflight,
 evaluateWriteReadback,verifyInsertedPoint,executeVerifiedInsert,
} from '../utils/e05-verified-write-contract.js';
import {validateProbeEnvironment,runDisposableProbe} from '../tools/e05-disposable-probe.mjs';

const scope={backend:'lancedb',collectionId:'e05_clean',source:'transformers',model:''};
const r=(hash,text='text')=>({hash,text,vector:[1,0.2],metadata:{kind:'chat'}});
const pages=(records,{fail=false,duplicate=false,drift=false}={})=>{
 let count=0;
 return async({offset,limit})=>{
   count++;
   if(fail)throw Error('server offline');
   const rows=(duplicate ? [...records,...records.slice(0,1)] : records);
   const list=drift && count>1 ? [...records,r(666,'concurrent')] : rows;
   return {success:true,items:list.slice(offset,offset+limit).map(x=>({...x})),offset,limit,
       total:list.length,hasMore:offset+limit<list.length};
 };
};
for(const backend of ['standard','lancedb'])test(`E05 verifies valid ${backend} batch`,()=>{
 assert.deepEqual(validateWriteBatch([r(1),r(2,'two')],{backend}).hashes,['1','2']);
});
for(const [label,items] of [
 ['duplicate-hash',[r(1),r(1)]],['empty-vector',[{...r(1),vector:[]}]],
 ['nonfinite-vector',[{...r(1),vector:[1,Infinity]}]],
 ['mixed-dimensions',[r(1),{...r(2),vector:[1]}]],
 ['invalid-text',[{...r(1),text:''}]],['empty-batch',[]],
])test(`E05 refuses ${label} before write`,()=>assert.throws(()=>validateWriteBatch(items,{backend:'lancedb'})));
test('E05 disallows lossy LanceDB collection/table names',()=>{
 assert.throws(()=>verifyWriteIdentity({...scope,collectionId:'user:chat'}),/lancedb-lossy-table-name/);
 assert.throws(()=>verifyWriteIdentity({...scope,collectionId:'user/chat'}),/lancedb-lossy-table-name/);
 assert.equal(verifyWriteIdentity(scope).collectionId,'e05_clean');
});
test('E05 collects two stable pages and two independent sweeps',async()=>{
 const rows=[r(1),r(2,'two'),r(3,'three')];const calls=[];
 const load=pages(rows);
 const result=await collectVerifiedInventory(async arg=>{calls.push(arg);return load(arg);},{limit:2});
 assert.equal(result.count,3);assert.equal(result.rows.get('3').text,'three');assert.equal(calls.length,4);
 assert.deepEqual(calls.map(c=>c.offset),[0,2,0,2]);
});
test('E05 detects duplicate physical hash in inventory',async()=>{
 await assert.rejects(collectVerifiedInventory(pages([r(1)],{duplicate:true})),/duplicate-physical-hash/);
});
test('E05 fails closed on empty-on-error',async()=>{
 await assert.rejects(collectVerifiedInventory(pages([],{fail:true})),/server offline/);
});
test('E05 refuses concurrent inventory drift',async()=>{
 await assert.rejects(collectVerifiedInventory(pages([r(1)],{drift:true})),/count-drift|inventory-changed/);
});
for(const defect of ['success','total','offset','hasMore','limit','items'])test(`E05 rejects malformed ${defect} field`,async()=>{
 const load=pages([r(1)]);
 await assert.rejects(collectVerifiedInventory(async arg=>{
   const page=await load(arg);
   if(defect==='success')page.success=false;
   else if(defect==='items')page.items='no';
   else if(defect==='hasMore')page.hasMore='false';
   else if(defect==='total')page.total=null;
   else if(defect==='offset')page.offset=4;
   else if(defect==='limit')page.limit=0;
   return page;
 }),/E05 evidence unavailable/);
});
test('E05 identifies preexisting hash collision',async()=>{
 const inventory=await collectVerifiedInventory(pages([r(8)]));
 assert.deepEqual(evaluateWritePreflight(inventory,[r(8)]),{safe:false,collisions:['8']});
});
test('E05 verifies insert, preserving all other records',async()=>{
 const before=await collectVerifiedInventory(pages([r(1)]));
 const after=await collectVerifiedInventory(pages([r(1),r(2,'new')]));
 assert.equal(evaluateWriteReadback(before,after,[r(2,'new')]).verified,true);
});
test('E05 refuses echoed success when inserted record is missing',async()=>{
 const before=await collectVerifiedInventory(pages([]));
 const after=await collectVerifiedInventory(pages([]));
 const result=evaluateWriteReadback(before,after,[r(2)]);
 assert.equal(result.verified,false);assert.deepEqual(result.missing,['2']);
});
test('E05 detects unexpected deletion and update of unrelated records',async()=>{
 const before=await collectVerifiedInventory(pages([r(1),r(5)]));
 const after=await collectVerifiedInventory(pages([r(5,'modified'),r(2)]));
 const out=evaluateWriteReadback(before,after,[r(2)]);
 assert.equal(out.verified,false);assert.ok(out.unexpected.includes('1'));assert.ok(out.unexpected.includes('5'));
});
test('E05 verifies vector and metadata from independent point lookup',()=>{
 assert.equal(verifyInsertedPoint(r(1),{...r(1),vector:[1.00000001,.2]}),true);
 assert.equal(verifyInsertedPoint(r(1),{...r(1),vector:{'0':1,'1':0.2}}),true);
 assert.equal(verifyInsertedPoint(r(1),{...r(1),vector:{'0':1,'2':0.2}}),false);
 assert.equal(verifyInsertedPoint(r(1),{...r(1),vector:[1,0.7]}),false);
 assert.equal(verifyInsertedPoint(r(1),{...r(1),metadata:{kind:'different'}}),false);
 assert.equal(verifyInsertedPoint(r(1),null),false);
});
const journal=()=>{
 const records=new Map();return {
  async create(x){records.set(x.operationId,structuredClone(x));return structuredClone(x);},
  async put(x){records.set(x.operationId,structuredClone(x));return structuredClone(x);},
  async get(id){return records.has(id)?structuredClone(records.get(id)):null;},
  records,
 };
};
const lock=async(_key,fn)=>fn();
test('E05 never dispatches when contract evidence is absent',async()=>{
 let requests=0;
 const result=await executeVerifiedInsert({scope,items:[r(1)],listPage:pages([]),getPoint:async()=>r(1),insert:async()=>requests++,journal:journal(),lock});
 assert.equal(result.status,'blocked');assert.equal(requests,0);
});
test('E05 journal is written before insertion and verified after readback',async()=>{
 const records=[],state=[]; const j=journal();
 const result=await executeVerifiedInsert({scope,items:[r(1)],contractAccepted:true,
    listPage:pages(state),getPoint:async()=>r(1),journal:j,lock,insert:async()=>{
      records.push(...j.records.values());state.push(r(1));
    }});
 assert.equal(result.status,'verified');assert.equal(state.length,1);
 assert.equal((await j.get(result.operationId)).phase,'verified');
});
test('E05 point readback mismatch remains needs-reconcile despite successful list',async()=>{
 const state=[];const j=journal();let times=0;
 const result=await executeVerifiedInsert({scope,items:[r(1)],contractAccepted:true,
  listPage:pages(state),getPoint:async()=>({...r(1),vector:[0.1,0.2]}),journal:j,lock,
  insert:async()=>{times++;state.push(r(1));}});
 assert.equal(result.status,'needs-reconcile');assert.equal(times,1);
 assert.deepEqual(result.proof.pointFailures,['1']);
});
test('E05 uncertain failed insert is not retried',async()=>{
 let times=0;
 const j=journal();const result=await executeVerifiedInsert({scope,items:[r(1)],contractAccepted:true,
 listPage:pages([]),getPoint:async()=>r(1),journal:j,lock,insert:async()=>{times++;throw Error('offline');}});
 assert.equal(result.status,'needs-reconcile');assert.equal(times,1);
 assert.equal((await j.get(result.operationId)).phase,'needs-reconcile');
});
test('E05 refuses duplicate existing record before insert',async()=>{
 let times=0;
 const result=await executeVerifiedInsert({scope,items:[r(1)],contractAccepted:true,
 listPage:pages([r(1)]),getPoint:async()=>r(1),journal:journal(),lock,insert:async()=>{times++;}});
 assert.equal(result.reason,'existing-hash-collision');assert.equal(times,0);
});
test('E05 a lost journal readback blocks before insert',async()=>{
 const j=journal();j.get=async()=>null;let times=0;
 const out=await executeVerifiedInsert({scope,items:[r(1)],contractAccepted:true,
 listPage:pages([]),getPoint:async()=>r(1),journal:j,lock,insert:async()=>times++});
 assert.equal(out.reason,'journal-not-verified');assert.equal(times,0);
});
for(const origin of ['https://127.0.0.1:8000/','http://192.168.0.10:8000/','http://evil.com/','http://user:pass@localhost:8000/','http://localhost:8000/abc'])
 test(`E05 probe refuses unsafe origin ${origin}`,()=>assert.throws(()=>validateProbeEnvironment({origin,backend:'lancedb',env:{VECTHARE_PROBE_DISPOSABLE:'1'}})));
test('E05 probes require disposable acknowledgment',()=>assert.throws(()=>validateProbeEnvironment({origin:'http://localhost:8000/',backend:'standard',env:{}})));
function fakeProbeTransport(){
 const state=new Map();const calls=[];
 const fetchImpl=async(url,opts)=>{
   calls.push({url,opts});const u=new URL(url),route=u.pathname.replace('/api/plugins/similharity','');
   const data=opts.body?JSON.parse(opts.body):{};
   let payload={success:true};
   if(route==='/health')payload={status:'ok',plugin:'similharity',version:'unverified'};
   else if(route==='/chunks/list'){
     const rows=state.get(data.collectionId)||[];
     payload={success:true,items:rows.slice(data.offset,data.offset+data.limit),total:rows.length,offset:data.offset,limit:data.limit,hasMore:data.offset+data.limit<rows.length};
   }else if(route==='/chunks/insert'){
     state.set(data.collectionId,[...state.get(data.collectionId)||[],...data.items]);payload.inserted=data.items.length;
   }else if(route==='/chunks/delete'){
     state.set(data.collectionId,(state.get(data.collectionId)||[]).filter(r=>!data.hashes.includes(r.hash)));payload.deleted=data.hashes.length;
   }else if(route.startsWith('/chunks/')){
     payload.chunk=(state.get(u.searchParams.get('collectionId'))||[]).find(r=>String(r.hash)===route.split('/').at(-1));
   }
   return {ok:true,status:200,json:async()=>payload};
 };
 return {fetchImpl,calls,state};
}
test('E05 disposable local probe succeeds but grants no runtime permission',async()=>{
 const t=fakeProbeTransport();
 const report=await runDisposableProbe({backend:'lancedb',origin:'http://127.0.0.1:8000/',
  env:{VECTHARE_PROBE_DISPOSABLE:'1'},fetchImpl:t.fetchImpl,nonce:()=> 'abc123',now:()=>2000000000000});
 assert.equal(report.status,'PASS_SINGLE_RUN');assert.equal(report.pluginSourceAttested,false);
 assert.equal(report.requiresServerRestartRepeat,true);
 assert.deepEqual(Object.values(report.checks),[true,true,true,true,true]);
 assert.ok(t.calls.every(call=>!call.url.endsWith('/purge-all')));
});
test('E05 failed delete reports uncertainty, not success',async()=>{
 const t=fakeProbeTransport();
 const fetchImpl=async(url,opts)=>url.includes('/chunks/delete')?{ok:false,status:500,json:async()=>({error:'fail'})}:t.fetchImpl(url,opts);
 const report=await runDisposableProbe({backend:'standard',origin:'http://localhost:8000/',
  env:{VECTHARE_PROBE_DISPOSABLE:'1'},fetchImpl,nonce:()=> 'abc123',now:()=>2000000000000});
 assert.equal(report.status,'FAIL_OR_UNVERIFIED');assert.match(report.cleanup,/UNCERTAIN/);
});

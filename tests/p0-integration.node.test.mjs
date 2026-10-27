import test from 'node:test';
import assert from 'node:assert/strict';
import {guardDelete,purgeAllAndResetSettings,isGeneratedDiagnosticCollectionId} from '../core/destructive-safety.js';
import {createWriteBarrier,PurgeInProgress,withCollectionLock} from '../utils/keyed-mutex.js';
import {applyVerifiedReplacement} from '../utils/replacement-safety.js';
import {beginOperation,settleOperation} from '../utils/operation-outcomes.js';
import {FaultBackend} from './helpers/fake-backend.js';
import {redactSecrets,redactError} from '../utils/security.js';
const a='qdrant:openai:record:A', b='milvus:openai:record:A';
const evidence={ownership:{verified:true,key:a},inventory:{complete:true,scope:a},metadata:{available:true}};

test('P0-3 orphan cleanup rejects missing, incomplete, stale, wrong-tenant and invalid identity evidence',()=>{
  assert.equal(guardDelete({key:a,operation:'orphan-cleanup',...evidence}).allowed,true);
  for(const changed of [
    {inventory:{complete:false,scope:a}},
    {inventory:{complete:true,scope:b}},
    {inventory:{complete:undefined,scope:a}},
    {metadata:{available:false}},
    {metadata:{}},
    {ownership:{verified:false,key:a}},
    {ownership:{verified:true,key:b}},
    {outcome:{status:'uncertain'}},
  ]) assert.equal(guardDelete({key:a,operation:'orphan-cleanup',...evidence,...changed}).allowed,false,JSON.stringify(changed));
  assert.equal(guardDelete({key:'qdrant:unknown:id',operation:'orphan-cleanup',...evidence}).allowed,false);
  assert.equal(guardDelete({key:'legacy',operation:'orphan-cleanup',...evidence}).allowed,false);
  assert.equal(guardDelete({key:a,operation:'targeted-delete',...evidence,metadata:{available:false}}).allowed,false);
  assert.equal(guardDelete({key:a,operation:'overwrite',...evidence,inventory:{complete:false,scope:a}}).allowed,false);
});
test('P0-3 registered diagnostic IDs must have exact reserved shape',()=>{
  assert.equal(isGeneratedDiagnosticCollectionId('vh:test:storage_1700000000000'),true);
  assert.equal(isGeneratedDiagnosticCollectionId('favorite_vh:test:storage_1700000000000'),false);
  assert.equal(isGeneratedDiagnosticCollectionId('vh:test:storage_999'),false);
});
test('P0-3 global purge without verified source cannot send request or reset settings',async()=>{
  const settings={enabled:true,secret:'keep',vecthare_collection_registry:['standard:openai:a']};let requests=0,persist=0;
  await assert.rejects(purgeAllAndResetSettings({settings,requestPurge:()=>{requests++;},persistSettings:()=>persist++}),/no verified backend purge contract/);
  assert.equal(requests,0);assert.equal(persist,0);assert.equal(settings.secret,'keep');
});
test('P0-9/P0-5 integrated late ACK: incomplete inventory and concurrent global purge never delete original or other tenant',async()=>{
  const db=new FaultBackend();db.seed(a,['old-A','shared']);db.seed(b,['shared']);
  const barrier=createWriteBarrier();const admitted=barrier.enter();
  let release;const hold=new Promise(resolve=>release=resolve);
  let signaled;const inserted=new Promise(resolve=>signaled=resolve);
  const inFlight=withCollectionLock(a,async()=>{
    await db.insert(a,['new-A']);signaled();await hold;
    barrier.leave(admitted,{uncertain:true});
  });
  await inserted;
  assert.equal(guardDelete({key:a,operation:'orphan-cleanup',...evidence,inventory:{complete:false,scope:a}}).allowed,false);
  let purges=0;
  const drain=barrier.closeAndDrain({timeoutMs:3});
  assert.throws(()=>barrier.enter(),PurgeInProgress);
  const drained=await drain;
  if(drained.verified){purges++;await db.purge(a);}
  assert.equal(drained.verified,false);assert.equal(purges,0);
  release();await inFlight;
  assert.equal((await barrier.closeAndDrain({timeoutMs:5})).verified,false);
  assert.deepEqual(db.ids(a),['new-A','old-A','shared']);
  assert.deepEqual(db.ids(b),['shared']);
  const op=beginOperation('insert',a);assert.equal(settleOperation(op,{status:'uncertain',reason:'transport-after-send'}),'uncertain');
  assert.equal(settleOperation(op,{status:'confirmed',reason:'verified-success'}),'uncertain');
  barrier.reopen();
});
test('P0-5 verified readback removes only obsolete A hashes and preserves B shared records',async()=>{
  const db=new FaultBackend();db.seed(a,['old-A','shared']);db.seed(b,['shared']);
  const result=await applyVerifiedReplacement({key:a,oldItems:['old-A','shared'],newItems:['new-A','shared'],
    insert:ids=>db.insert(a,ids),verify:ids=>db.verify(a,ids),remove:ids=>db.remove(a,ids)});
  assert.equal(result.status,'confirmed');assert.deepEqual(result.deleted,['old-A']);
  assert.deepEqual(db.ids(a),['new-A','shared']);assert.deepEqual(db.ids(b),['shared']);
});
test('P0-5 deletion failure after successful insert remains uncertain; new and old remain when pre-commit reject',async()=>{
  const db=new FaultBackend();db.seed(a,['old']);db.queueFault('remove','reject');
  const result=await applyVerifiedReplacement({key:a,oldItems:['old'],newItems:['new'],
    insert:ids=>db.insert(a,ids),verify:ids=>db.verify(a,ids),remove:ids=>db.remove(a,ids)});
  assert.equal(result.status,'uncertain');assert.deepEqual(db.ids(a),['new','old']);
});
test('P0-5 cancellation before insert leaves original, and cancellation before delete preserves originals',async()=>{
  const db=new FaultBackend();db.seed(a,['old']);
  const pre=new AbortController();pre.abort();
  await assert.rejects(applyVerifiedReplacement({key:a,oldItems:['old'],newItems:['new'],insert:ids=>db.insert(a,ids),verify:ids=>db.verify(a,ids),remove:ids=>db.remove(a,ids),signal:pre.signal}));
  assert.deepEqual(db.ids(a),['old']);
  const mid=new AbortController();
  const out=await applyVerifiedReplacement({key:a,oldItems:['old'],newItems:['new'],insert:ids=>db.insert(a,ids),
    verify:async(ids)=>{const v=await db.verify(a,ids);mid.abort();return v;},remove:ids=>db.remove(a,ids),signal:mid.signal});
  assert.equal(out.status,'uncertain');assert.ok(db.ids(a).includes('old'));
});
test('P0-9 cancelled queued mutex waiter does not start',async()=>{
  let release;const latch=new Promise(r=>release=r);let secondStarted=false,signalFirst;
  const first=withCollectionLock(a,async()=>{signalFirst();await latch;});
  await new Promise(r=>{signalFirst=r;});
  const ctrl=new AbortController();
  const second=withCollectionLock(a,async()=>{secondStarted=true;},{signal:ctrl.signal});
  ctrl.abort();await assert.rejects(second);release();await first;
  assert.equal(secondStarted,false);
});
test('P0-9 cancelled middle waiter cannot let later same-key work overtake active holder',async()=>{
  const events=[];
  let firstEntered, releaseFirst;
  const entered=new Promise(resolve=>{firstEntered=resolve;});
  const hold=new Promise(resolve=>{releaseFirst=resolve;});
  const first=withCollectionLock(a,async()=>{
    events.push('A-start');firstEntered();await hold;events.push('A-end');
  });
  await entered;
  const ctrl=new AbortController();
  const middle=withCollectionLock(a,async()=>{events.push('B-start');},{signal:ctrl.signal});
  const third=withCollectionLock(a,async()=>{events.push('C-start');});
  ctrl.abort();
  await assert.rejects(middle,{name:'AbortError'});
  // The caller is already notified, but the cancelled queue position must
  // still keep C behind A until the first callback actually completes.
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(events,['A-start']);
  releaseFirst();
  await Promise.all([first,third]);
  assert.deepEqual(events,['A-start','A-end','C-start']);
  await withCollectionLock(a,async()=>{events.push('D-start');});
  assert.equal(events.at(-1),'D-start');
});
test('P0-9 abort after callback starts cannot release key before callback finishes',async()=>{
  const events=[];
  let entered,release;
  const callbackStarted=new Promise(resolve=>{entered=resolve;});
  const hold=new Promise(resolve=>{release=resolve;});
  const ctrl=new AbortController();
  const active=withCollectionLock(a,async()=>{
    events.push('active-start');entered();await hold;events.push('active-end');
    return 'completed';
  },{signal:ctrl.signal});
  await callbackStarted;
  const next=withCollectionLock(a,async()=>{events.push('next-start');});
  ctrl.abort();
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(events,['active-start']);
  release();
  assert.equal(await active,'completed');
  await next;
  assert.deepEqual(events,['active-start','active-end','next-start']);
});
test('P0-9 cancelled waiter preserves serialization when active holder throws',async()=>{
  const events=[];
  let entered, release;
  const firstStarted=new Promise(resolve=>{entered=resolve;});
  const hold=new Promise(resolve=>{release=resolve;});
  const first=withCollectionLock(a,async()=>{
    events.push('A-start');entered();await hold;events.push('A-fail');throw Error('deliberate');
  });
  await firstStarted;
  const ctrl=new AbortController();
  const middle=withCollectionLock(a,async()=>{events.push('B-start');},{signal:ctrl.signal});
  const third=withCollectionLock(a,async()=>{events.push('C-start');});
  ctrl.abort();await assert.rejects(middle,{name:'AbortError'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(events,['A-start']);
  release();await assert.rejects(first,/deliberate/);await third;
  assert.deepEqual(events,['A-start','A-fail','C-start']);
});
test('P0-6 complex case variants, error messages, circular report and connection URL sanitized without modifying original',()=>{
  const item={PASSWORD:'nOSK', nested:{milvusToken:'nOTH',qdrant_api_key:'nOONE',connection:'postgres://alice:nOUSE@localhost/db'}, errors:['Bearer nOBEARER','https://host/path?token=nOQUERY']};
  item.loop=item;
  const out=JSON.stringify(redactSecrets(item));
  for(const secret of ['nOSK','nOTH','nOONE','nOUSE','nOBEARER','nOQUERY'])assert.ok(!out.includes(secret),secret);
  assert.equal(item.PASSWORD,'nOSK');
  assert.equal(out.includes('CIRCULAR'),true);
  assert.ok(!JSON.stringify(redactError(new Error('Bearer nOSECRET'))).includes('nOSECRET'));
});

/** C03 fault tests: chat-scoped job ownership, independent cancellation,
 * late writes, FIFO locks, session history, lifecycle and purge barriers. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createJobCoordinator,StaleJobError} from '../core/job-context.js';
import {createScopedActivationHistory} from '../utils/activation-history.js';
import {createWriteBarrier,PurgeInProgress} from '../utils/keyed-mutex.js';

const deferred = () => {let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const tick = () => new Promise(resolve=>setImmediate(resolve));
const memoryStorage = () => {const map=new Map();return {getItem:key=>map.get(key)??null,setItem:(key,val)=>map.set(key,val),raw:map};};
const make = (storage=memoryStorage()) => {
    let identity={chatId:'chat-A',originId:'integrity-A',groupId:'',characterId:'char'};
    const coordinator=createJobCoordinator({getIdentity:()=>identity,storage});
    return {coordinator,storage,setIdentity:id=>{identity={...identity,...id};}};
};
const start = (coordinator,kind='sync',key='standard:transformers:chat-A') => coordinator.startJob({kind,collectionKey:key});

test('C03 #31: snapshot is frozen and carries the qualified target',()=>{
    const {coordinator}=make();const job=start(coordinator);
    assert.equal(job.snapshot.collectionKey,'standard:transformers:chat-A');
    assert.ok(Object.isFrozen(job.snapshot));assert.ok(Object.isFrozen(job));
    job.assertCurrent();job.finish();assert.equal(coordinator.activeJobs,0);
});
test('C03 #31: stable integrity UUID survives a filename rename',()=>{
    const h=make();const job=start(h.coordinator);
    h.setIdentity({chatId:'renamed-chat-file'});
    assert.equal(job.assertCurrent(),true);job.finish();
});
test('C03 #31: changing integrity UUID invalidates a job even with same filename',()=>{
    const h=make();const job=start(h.coordinator);
    h.setIdentity({originId:'integrity-B'});
    assert.throws(()=>job.assertCurrent(),StaleJobError);
});
test('C03 #31: character and group ownership are part of the snapshot',()=>{
    const h=make();const job=start(h.coordinator);
    h.setIdentity({groupId:'group-B'});
    assert.throws(()=>job.assertCurrent(),StaleJobError);
});
test('C03 #1/#32: switching chats cancels all old active jobs',()=>{
    const h=make();const a=start(h.coordinator,'sync'),b=start(h.coordinator,'repair');
    h.coordinator.cancelAll('chat-changed');h.setIdentity({chatId:'chat-B',originId:'integrity-B'});
    assert.equal(a.signal.aborted,true);assert.equal(b.signal.aborted,true);
    assert.equal(h.coordinator.activeJobs,0);
    assert.throws(()=>a.assertCurrent(),StaleJobError);
});
test('C03 #27: stopping one of two jobs leaves the other running',()=>{
    const h=make();const a=start(h.coordinator,'sync'),b=start(h.coordinator,'repair');
    a.cancel('stop-one');
    assert.equal(a.signal.aborted,true);assert.equal(b.signal.aborted,false);
    assert.equal(b.assertCurrent(),true);b.finish();
});
test('C03 #27: cancelKinds cancels only named kinds',()=>{
    const h=make();const a=start(h.coordinator,'retrieval'),b=start(h.coordinator,'sync');
    h.coordinator.cancelKinds(['retrieval'],'generation-end');
    assert.equal(a.signal.aborted,true);assert.equal(b.assertCurrent(),true);b.finish();
});
test('C03 #51: generation revision invalidates old retrieval, not active sync',()=>{
    const h=make();const a=h.coordinator.startJob({kind:'retrieval',generationScoped:true});const b=start(h.coordinator);
    h.coordinator.bumpGeneration();
    assert.throws(()=>a.assertCurrent(),StaleJobError);
    assert.equal(b.assertCurrent(),true);b.finish();
});
test('C03 #51: a stale generation cannot regain current status',()=>{
    const h=make();const a=h.coordinator.startJob({kind:'retrieval',generationScoped:true});
    h.coordinator.bumpGeneration();const b=h.coordinator.startJob({kind:'retrieval',generationScoped:true});
    assert.throws(()=>a.assertCurrent(),StaleJobError);assert.equal(b.assertCurrent(),true);b.finish();
});
test('C03 #49/#92: aborted queued middle waiter never unlocks a held collection',async()=>{
    const h=make(),gate=deferred(),order=[],ab=new AbortController();
    const first=start(h.coordinator),second=start(h.coordinator),third=start(h.coordinator);
    const a=first.withLock(async()=>{order.push('A-start');await gate.promise;order.push('A-end');});
    await tick();const b=second.withLock(async()=>{order.push('B');});const c=third.withLock(async()=>{order.push('C');});
    second.cancel('queued-cancel');
    await assert.rejects(b,StaleJobError);await tick();
    assert.deepEqual(order,['A-start']);gate.resolve();await Promise.all([a,c]);
    assert.deepEqual(order,['A-start','A-end','C']);
    first.finish();second.finish();third.finish();
});
test('C03 #49: distinct collection locks can run independently',async()=>{
    const h=make(),gate=deferred();let other=false;
    const a=start(h.coordinator,'sync','standard:x:A'),b=start(h.coordinator,'sync','standard:x:B');
    const holding=a.withLock(async()=>gate.promise);await tick();
    await b.withLock(async()=>{other=true;});assert.equal(other,true);gate.resolve();await holding;
});
test('C03 #49: holder exception releases the next waiter',async()=>{
    const h=make(),order=[];const a=start(h.coordinator),b=start(h.coordinator);
    const first=a.withLock(async()=>{order.push('first');throw Error('boom');});
    const next=b.withLock(async()=>{order.push('next');});
    await assert.rejects(first,/boom/);await next;assert.deepEqual(order,['first','next']);
});
test('C03 #91: only positive acknowledgement removes the persisted pending marker',async()=>{
    const h=make(),job=start(h.coordinator);
    const result=await h.coordinator.trackWrite(job,Promise.resolve({status:'confirmed'}));
    assert.equal(result.status,'confirmed');assert.equal(h.coordinator.pendingOperations().length,0);
    assert.equal(JSON.parse(h.storage.raw.values().next().value).operations.length,0);
});
test('C03 #91: undefined acknowledgement stays uncertain',async()=>{
    const h=make(),job=start(h.coordinator);
    await h.coordinator.trackWrite(job,Promise.resolve(undefined));
    assert.equal(h.coordinator.pendingOperations()[0].status,'uncertain');
});
test('C03 #91: transport error retains an uncertain write marker',async()=>{
    const h=make(),job=start(h.coordinator);
    await assert.rejects(h.coordinator.trackWrite(job,Promise.reject(Error('lost-ack'))),/lost-ack/);
    assert.equal(h.coordinator.pendingOperations()[0].status,'uncertain');
});
test('C03 #91: client abort and late confirmed ACK do not erase uncertain write',async()=>{
    const h=make(),job=start(h.coordinator),network=deferred();
    const result=h.coordinator.trackWrite(job,network.promise);
    job.cancel('chat-switched');network.resolve({status:'confirmed'});
    await assert.rejects(result,StaleJobError);
    assert.equal(h.coordinator.pendingOperations().length,1);
});
test('C03 #91: explicit uncertain adapter result remains a reconciliation marker',async()=>{
    const h=make(),job=start(h.coordinator);
    const response=await h.coordinator.trackWrite(job,Promise.resolve({status:'uncertain',requiresReconciliation:true}));
    assert.equal(response.status,'uncertain');assert.equal(h.coordinator.pendingOperations().length,1);
});
test('C03 #218: awaitInFlightWrites does not declare success before a late write settles',async()=>{
    const h=make(),job=start(h.coordinator),net=deferred();
    const write=h.coordinator.trackWrite(job,net.promise);
    let completed=false;
    const drain=h.coordinator.awaitInFlightWrites().then(r=>{completed=true;return r;});
    await tick();assert.equal(completed,false);
    net.resolve({status:'confirmed'});await write;
    const result=await drain;assert.equal(result.settled,1);assert.equal(result.uncertain,false);
});
test('C03 #218: late lost ACK causes purge drainage to report uncertainty',async()=>{
    const h=make(),job=start(h.coordinator),net=deferred();
    const write=h.coordinator.trackWrite(job,net.promise);
    const drain=h.coordinator.awaitInFlightWrites();
    net.reject(Error('timeout'));await assert.rejects(write,/timeout/);
    const result=await drain;assert.equal(result.uncertain,true);
});
test('C03 #21: teardown aborts jobs and persists pending write evidence',async()=>{
    const h=make(),job=start(h.coordinator),net=deferred();
    const write=h.coordinator.trackWrite(job,net.promise);h.coordinator.teardown();
    assert.equal(job.signal.aborted,true);assert.equal(h.coordinator.activeJobs,0);
    assert.equal(JSON.parse(h.storage.raw.values().next().value).operations[0].status,'uncertain');
    net.resolve({status:'confirmed'});await assert.rejects(write,StaleJobError);
});
test('C03 #21: startup restores interrupted writes as uncertain without replay',()=>{
    const store=memoryStorage();store.setItem('vecthare:c03:pending-operations',JSON.stringify({version:1,operations:[{id:'prior',collectionKey:'standard:x:a',kind:'write',status:'in-flight'}]}));
    const h=make(store);assert.equal(h.coordinator.pendingOperations()[0].status,'uncertain');
});
test('C03 #21: corrupt persisted operation checkpoint fails closed',()=>{
    const store=memoryStorage();store.setItem('vecthare:c03:pending-operations','{"version":-1}');
    const h=make(store);assert.equal(h.coordinator.pendingOperations()[0].id,'invalid-checkpoint');
});
test('C03 #21: no automatic replay of a stored lost ACK',()=>{
    const store=memoryStorage();store.setItem('vecthare:c03:pending-operations',JSON.stringify({version:1,operations:[{id:'previous',collectionKey:'qdrant:x:foo',kind:'write',status:'uncertain'}]}));
    const h=make(store);assert.equal(h.coordinator.activeJobs,0);assert.equal(h.coordinator.pendingOperations().length,1);
});
test('C03 #218: barrier rejects new writes after admission closes',async()=>{
    const barrier=createWriteBarrier();barrier.close();
    assert.throws(()=>barrier.enter(),PurgeInProgress);
    assert.deepEqual(await barrier.closeAndDrain({timeoutMs:10}),{drained:true,verified:true,uncertain:false});
    barrier.reopen();const token=barrier.enter();barrier.leave(token);
});
test('C03 #75: separate chats cannot share activation-frequency history',()=>{
    const history=createScopedActivationHistory();
    history.record({chatId:'A',collectionKey:'qdrant:x:1',hash:42,messageCount:8});
    assert.equal(history.snapshot({chatId:'A',collectionKey:'qdrant:x:1'})['42'].count,1);
    assert.equal(history.snapshot({chatId:'B',collectionKey:'qdrant:x:1'})['42'],undefined);
});
test('C03 #75: same hash in two collections has separate counters',()=>{
    const history=createScopedActivationHistory();
    history.record({chatId:'A',collectionKey:'qdrant:x:1',hash:'same',messageCount:5});
    assert.equal(history.snapshot({chatId:'A',collectionKey:'qdrant:x:2'}).same,undefined);
});
test('C03 #75: session counters do not influence conversation counters',()=>{
    const history=createScopedActivationHistory();
    history.record({chatId:'A',collectionKey:'qdrant:x:1',scope:'session',hash:'same',messageCount:5});
    assert.equal(history.snapshot({chatId:'A',collectionKey:'qdrant:x:1',scope:'conversation'}).same,undefined);
    assert.equal(history.snapshot({chatId:'A',collectionKey:'qdrant:x:1',scope:'session'}).same.count,1);
    history.clearSession();assert.equal(history.snapshot({chatId:'A',collectionKey:'qdrant:x:1',scope:'session'}).same,undefined);
});
test('C03 #75: incomplete owner or invalid scope cannot create history',()=>{
    const history=createScopedActivationHistory();
    assert.equal(history.record({chatId:'',collectionKey:'c',hash:1}),false);
    assert.equal(history.record({chatId:'x',collectionKey:'c',scope:'global',hash:1}),false);
});
test('C03 #21/#81: runtime has idempotent init, listener registry and cache revision gates',()=>{
    const idx=fs.readFileSync(new URL('../index.js',import.meta.url),'utf8');
    const scene=fs.readFileSync(new URL('../ui/scene-markers.js',import.meta.url),'utf8');
    assert.match(idx,/__vecthareRuntimeInitialized/);
    assert.match(idx,/__vecthareEventListeners/);
    assert.match(idx,/pendingWrites = chatJobs\.pendingOperations/);
    assert.match(scene,/sceneCacheRefreshVersion/);
    assert.match(scene,/if \(!isCurrent\(\)\) return/);
});
test('C03 #51/#1: retrieval and manual sync assert current identity after awaits',()=>{
    const code=fs.readFileSync(new URL('../core/chat-vectorization.js',import.meta.url),'utf8');
    assert.match(code,/const injection=injectChunksIntoPrompt/);
    assert.match(code,/const budgetPlan=await planBudgetedInjection[^;]*;\s*job\.assertCurrent\(\)/);
    assert.match(code,/const result = await synchronizeChat[^;]*;\s*job\.assertCurrent\(\)/);
});

test('C03 #51: chat A query result arriving after switch cannot reach prompt or search debugger',async()=>{
    const vm=await import('node:vm');
    const source=fs.readFileSync(new URL('../core/chat-vectorization.js',import.meta.url),'utf8');
    const a=source.indexOf('export async function rearrangeChat(');
    const b=source.indexOf('/**\n * Vectorizes entire chat',a);
    assert.ok(a>=0 && b>a);
    let identity={chatId:'A',originId:'stable-A'};
    const jobs=createJobCoordinator({getIdentity:()=>identity});
    const filter=deferred();let promptWrites=0,debugWrites=0;
    const stubs={
        console:{log(){},warn(){},debug(){},error(){}},
        chatJobs:jobs,StaleJobError,
        clearVectHarePrompts(){},getCurrentChatId:()=>identity.chatId,
        gatherCollectionsToQuery:()=>['standard:x:c'],
        buildSearchQuery:()=> 'hello world',extractChatKeywords:()=>[{text:'hello'}],
        getCollectionMeta:()=>({}),getRequiredConditionDepth:()=>0,
        getContext:()=>({groupId:null,name2:'alice',characterId:1}),
        buildSearchContext:()=>({collectionDecisions:[]}),
        filterActiveCollections:()=>filter.promise,
        setLastSearchDebug:()=>{debugWrites++;},
        setExtensionPrompt:()=>{promptWrites++;},
        toastr:{error(){}},
    };
    const scope=vm.createContext(stubs);
    const fn=vm.runInContext(`${source.slice(a,b).replace('export async function','async function')}\nrearrangeChat`,scope);
    const call=fn([{mes:'hello'}],{enabled_world_info:false,query:2,top_k:2},'normal');
    await tick();
    identity={chatId:'B',originId:'stable-B'};
    filter.resolve(['standard:x:c']);
    await call;
    assert.equal(promptWrites,0);assert.equal(debugWrites,0);
});

test('C03 #51: a superseding generation also rejects late retrieval without chat switch',async()=>{
    const vm=await import('node:vm');
    const source=fs.readFileSync(new URL('../core/chat-vectorization.js',import.meta.url),'utf8');
    const a=source.indexOf('export async function rearrangeChat('),b=source.indexOf('/**\n * Vectorizes entire chat',a);
    const jobs=createJobCoordinator({getIdentity:()=>({chatId:'A',originId:'A'})}),filter=deferred();
    let debug=0;
    const scope=vm.createContext({console:{log(){},warn(){},debug(){},error(){}},chatJobs:jobs,StaleJobError,
        clearVectHarePrompts(){},getCurrentChatId:()=> 'A',gatherCollectionsToQuery:()=>['c'],
        buildSearchQuery:()=> 'hello',extractChatKeywords:()=>[{text:'hello'}],getCollectionMeta:()=>({}),
        getRequiredConditionDepth:()=>0,getContext:()=>({groupId:null,name2:'alice'}),
        buildSearchContext:()=>({collectionDecisions:[]}),filterActiveCollections:()=>filter.promise,
        setLastSearchDebug:()=>{debug++;},toastr:{error(){}}});
    const fn=vm.runInContext(`${source.slice(a,b).replace('export async function','async function')}\nrearrangeChat`,scope);
    const call=fn([{mes:'hello'}],{enabled_world_info:false,query:2},'normal');
    await tick();jobs.bumpGeneration('new-generation');filter.resolve(['c']);await call;
    assert.equal(debug,0);
});

test('C03 #92: cancelled queued insert is rejected before backend work can start',async()=>{
    const h=make(),hold=deferred(),abort=new AbortController(),calls=[];
    const owner=start(h.coordinator),queued=start(h.coordinator);
    const a=owner.withLock(async()=>{calls.push('owner');await hold.promise;});
    await tick();const b=queued.withLock(async()=>{calls.push('should-not-run');});
    queued.cancel('stop');await assert.rejects(b,StaleJobError);
    hold.resolve();await a;assert.deepEqual(calls,['owner']);
    const api=fs.readFileSync(new URL('../core/core-vector-api.js',import.meta.url),'utf8');
    assert.match(api,/withCollectionLock\(key,async\(\)=>\{/);
    assert.equal((api.match(/\}, \{signal:abortSignal\}\);/g)||[]).length,2,'both insert and delete locks receive the signal');
});

test('C03 #81: delayed scene cache read from chat A cannot replace cache for B',async()=>{
    const vm=await import('node:vm');
    const src=fs.readFileSync(new URL('../ui/scene-markers.js',import.meta.url),'utf8');
    const a=src.indexOf('export async function refreshSceneCache('),b=src.indexOf('\n}\n',a);
    assert.ok(a>=0 && b>a);
    let current='A';const pending=deferred();
    const context=vm.createContext({console:{log(){},error(){}},getCurrentCollectionId:()=>current,
        currentChatIdentity:()=>({chatId:current}),getSavedHashes:()=>pending.promise});
    const fn=vm.runInContext(`let cachedSceneChunks=[];let currentSettings={};let sceneCacheRefreshVersion=0;${src.slice(a,b+2).replace('export async function','async function')}\nrefreshSceneCache`,context);
    const first=fn();await tick();
    current='B';vm.runInContext('cachedSceneChunks=[{hash:"current-B"}]',context);
    pending.resolve({metadata:[{isScene:true,hash:'stale-A',sceneStart:1,sceneEnd:3}]});
    await first;
    assert.equal(vm.runInContext('cachedSceneChunks[0].hash',context),'current-B');
});

test('C03 #91: uncertain sync insert still counts against per-pass batch limit',()=>{
    const src=fs.readFileSync(new URL('../core/chat-vectorization.js',import.meta.url),'utf8');
    const a=src.indexOf('const writeReceipt = await chatJobs.trackWrite(');
    const b=src.indexOf('} catch (itemError)',a);
    assert.ok(a>=0 && b>a);
    const block=src.slice(a,b);
    assert.match(block,/itemsFailed\+\+/);
    assert.doesNotMatch(block,/continue;/,'unknown ACK must not bypass itemsProcessed and the batch limit');
});

test('C03 #91: long runs compact old uncertain markers without losing their count',async()=>{
    const h=make(),job=start(h.coordinator);
    for(let i=0;i<190;i++) await h.coordinator.trackWrite(job,Promise.resolve({status:'uncertain'}));
    const retained=h.coordinator.pendingOperations();
    assert.ok(retained.length<=160,'persistence must remain bounded during large chats');
    assert.equal(retained.reduce((sum,op)=>sum+(op.count||1),0),190);
    const restart=make(h.storage);
    assert.equal(restart.coordinator.pendingOperations().reduce((sum,op)=>sum+(op.count||1),0),190);
});

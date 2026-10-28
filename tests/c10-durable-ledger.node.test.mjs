import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDurableFrequencyLedger} from '../utils/durable-frequency-ledger.js';
function storage(){const records=new Map();return {get length(){return records.size;},key:i=>[...records.keys()][i]??null,
    getItem:key=>records.get(key)??null,setItem:(key,value)=>records.set(key,String(value)),removeItem:key=>records.delete(key)};}
const args=(values={})=>({chatId:'chat1',collectionKey:'standard:transformers:docs',recordId:'r1',turnId:'uid1',scope:'conversation',messageCount:11,
    receipt:{status:'included',verified:true,recordIds:['r1']},...values});
test('C10 durable ledger requires browser storage before counting',()=>{
    const l=createDurableFrequencyLedger({local:null,session:null});
    assert.equal(l.isAvailable(),false);assert.equal(l.recordActivation(args()).status,'storage-unavailable');
    assert.equal(l.snapshot(args()).r1,undefined);
});
test('C10 verified receipt persists and survives module reload',()=>{
    const local=storage(),session=storage();const a=createDurableFrequencyLedger({local,session});
    assert.equal(a.recordActivation(args()).status,'recorded');
    const b=createDurableFrequencyLedger({local,session});
    assert.deepEqual(b.snapshot(args()).r1,{count:1,lastActivation:11});
});
test('C10 same turn cannot spend twice after reload',()=>{
    const local=storage();createDurableFrequencyLedger({local}).recordActivation(args());
    assert.equal(createDurableFrequencyLedger({local}).recordActivation(args()).status,'duplicate');
});
test('C10 failed receipt and dry run do not spend durable allowance',()=>{
    const local=storage(),l=createDurableFrequencyLedger({local});
    assert.equal(l.recordActivation(args({receipt:{status:'registered'}})).status,'unverified');
    assert.equal(l.recordActivation(args({dryRun:true})).status,'dry-run');
    assert.equal(l.snapshot(args()).r1,undefined);
});
test('C10 distinct turn IDs increment durable count',()=>{
    const local=storage(),l=createDurableFrequencyLedger({local});l.recordActivation(args());
    l.recordActivation(args({turnId:'uid2',messageCount:12}));
    assert.deepEqual(l.snapshot(args()).r1,{count:2,lastActivation:12});
});
test('C10 storage acknowledgement failure returns unavailable',()=>{
    const fake={length:0,key(){return null;},getItem(){return null;},setItem(){},removeItem(){}};
    const l=createDurableFrequencyLedger({local:fake});
    assert.equal(l.recordActivation(args()).status,'storage-unavailable');
});
test('C10 session clear preserves conversation history',()=>{
    const local=storage(),session=storage(),l=createDurableFrequencyLedger({local,session});
    l.recordActivation(args());l.recordActivation(args({scope:'session'}));
    l.clearSession();assert.equal(l.snapshot(args()).r1.count,1);
    assert.equal(l.snapshot(args({scope:'session'})).r1,undefined);
});
test('C10 cross-collection identities cannot share counts',()=>{
    const local=storage(),l=createDurableFrequencyLedger({local});
    l.recordActivation(args());
    assert.equal(l.snapshot(args({collectionKey:'qdrant:other:docs'})).r1,undefined);
});
test('C10 unverified receipt may reconcile without blind double count',()=>{
    const local=storage(),l=createDurableFrequencyLedger({local});
    l.recordActivation(args({receipt:{status:'unknown'}}));
    assert.equal(l.recordActivation(args()).status,'recorded');
    assert.equal(l.recordActivation(args()).status,'duplicate');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {planRegistryMigration,commitRegistryMigration} from '../utils/c04-registry-migration.js';
import {recordId} from '../utils/record-identity.js';
import {planPhysicalIdMigration,applyPhysicalIdMigration} from '../utils/c07-physical-migration.js';
import {createC02Coordinator} from '../utils/c02-replacement.js';
import {createTestOperationJournal} from '../utils/c02-operation-journal.js';
const key='qdrant:transformers:final15-test-owned';
const newA=recordId(key,'uid-A'),newB=recordId(key,'uid-B');
function inventory(records) {return {scope:key,contractVerified:true,complete:true,endOfListConfirmed:true,expectedCount:records.length,records};}
const row=(id,text)=>({collectionKey:key,recordId:id,text,metadata:{},vector:[1,0]});
const ids=(oldA='old-a',oldB='old-b')=>[{oldId:oldA,localId:'uid-A',verified:true},{oldId:oldB,localId:'uid-B',verified:true}];
test('Step15: C04 many-to-one registry migration rejects identical-source metadata',()=>{
 const settings={vecthare_collection_registry:['old-a','old-b'],collections:{'old-a':{enabled:false},'old-b':{enabled:false}},chatCollectionPolicies:{},vecthare_chunk_meta_by_collection:{}};
 const original=structuredClone(settings);
 const plan=planRegistryMigration(settings,{mapping:{'old-a':key,'old-b':key}});
 assert.equal(plan.status,'conflict');
 assert.equal(commitRegistryMigration(settings,plan,{approved:true,persist:()=>true}).status,'blocked');
 assert.deepEqual(settings,original);
});
test('Step15: C07 migration cannot overwrite another live source record before confirmed replacement',()=>{
 const occupied=newA;
 const plan=planPhysicalIdMigration({collectionKey:key,inventory:inventory([row('old-a','first'),row(occupied,'second')]),identities:ids('old-a',occupied)});
 assert.equal(plan.status,'blocked');
 assert.equal(plan.reason,'target-id-overlaps-other-source');
});
test('Step15: C07 -> actual C02 journal -> collection write/readback/delete -> commit',async()=>{
 const records=new Map([['old-a',row('old-a','first')],['old-b',row('old-b','second')]]);
 const source=inventory([...records.values()]);
 const plan=planPhysicalIdMigration({collectionKey:key,inventory:source,identities:ids()});
 assert.equal(plan.status,'ready');
 const journal=createTestOperationJournal();const calls=[];
 const c02=createC02Coordinator({journal,
  list:async scope=>({scope,contractVerified:true,complete:true,endOfListConfirmed:true,recordIds:[...records.keys()]}),
  upsert:async(scope,items)=>{calls.push('upsert');for(const item of items)records.set(item.recordId,{...item,collectionKey:scope});return {status:'confirmed'};},
  remove:async(scope,recordIds)=>{calls.push('delete');recordIds.forEach(id=>records.delete(id));return {status:'confirmed',collectionKey:scope,count:recordIds.length};},
  canDelete:()=>true,canUpsertIdempotently:()=>true});
 const result=await applyPhysicalIdMigration(plan,{approved:true,verifiedContracts:true,currentInventory:source,replaceRecords:request=>c02.replaceRecords(request)});
 assert.equal(result.status,'committed');assert.deepEqual(calls,['upsert','delete']);
 assert.equal(records.has(newA),true);assert.equal(records.has(newB),true);
 assert.equal(records.has('old-a'),false);assert.equal(records.has('old-b'),false);
 assert.equal((await journal.list())[0].kind,'physical-id-migration');
});
test('Step15: C07 -> C02 lost acknowledgement retains originals and durable reconciliation marker',async()=>{
 const records=new Map([['old-a',row('old-a','first')],['old-b',row('old-b','second')]]);
 const source=inventory([...records.values()]);const plan=planPhysicalIdMigration({collectionKey:key,inventory:source,identities:ids()});
 const journal=createTestOperationJournal();let removed=0;
 const c02=createC02Coordinator({journal,
  list:async scope=>({scope,contractVerified:true,complete:true,endOfListConfirmed:true,recordIds:[...records.keys()]}),
  upsert:async(scope,items)=>{records.set(items[0].recordId,{...items[0],collectionKey:scope});throw Error('lost acknowledgement');},
  remove:async()=>{removed++;return {status:'confirmed',collectionKey:key,count:2};},canDelete:()=>true});
 const result=await applyPhysicalIdMigration(plan,{approved:true,verifiedContracts:true,currentInventory:source,replaceRecords:request=>c02.replaceRecords(request)});
 assert.equal(result.status,'needs-reconcile');assert.equal(removed,0);
 assert.equal(records.has('old-a'),true);assert.equal(records.has('old-b'),true);
 assert.equal((await journal.list())[0].phase,'needs-reconcile');
});

import {createPromptReceiptTracker,wrapPromptBlock} from '../utils/prompt-receipts.js';
import {createDurableFrequencyLedger} from '../utils/durable-frequency-ledger.js';
import {exportVerifiedNDJSON} from '../utils/c11-bounded-export.js';
import {deleteCollectionSafely} from '../utils/c01-deletion.js';
function memoryStorage(){const map=new Map();return {get length(){return map.size;},key:i=>[...map.keys()][i]??null,
 getItem:key=>map.get(key)??null,setItem:(key,v)=>map.set(key,String(v)),removeItem:key=>map.delete(key)};}
test('Step15: C10 final prompt receipt -> C08 durable frequency records only confirmed inclusion across reload',()=>{
 const local=memoryStorage();const nonce='a'.repeat(32),block=wrapPromptBlock('<context>one</context>',nonce,0);
 const ledger=createDurableFrequencyLedger({local});let currentChat='chat-one';
 const tracker=createPromptReceiptTracker({getChatId:()=>currentChat});
 const args={chatId:'chat-one',collectionKey:key,recordId:'r-1',turnId:'user-turn-1',scope:'conversation',messageCount:5};
 const register=()=>tracker.register({chatId:'chat-one',turnId:args.turnId,nonce,groups:[{tag:'one',text:block,recordIds:['r-1']}]});
 assert.equal(register().status,'registered');
 assert.equal(ledger.recordActivation({...args,receipt:tracker.current()}).status,'unverified');
 assert.equal(tracker.observe('chat',{chat:[{role:'system',content:'unrelated'}]}).status,'notIncluded');
 assert.equal(ledger.snapshot(args)['r-1'],undefined);
 register();const receipt=tracker.observe('chat',{chat:[{role:'system',content:block}]});
 assert.equal(receipt.verified,true);assert.equal(receipt.status,'included');
 assert.equal(ledger.recordActivation({...args,receipt}).status,'recorded');
 assert.deepEqual(createDurableFrequencyLedger({local}).snapshot(args)['r-1'],{count:1,lastActivation:5});
 assert.equal(createDurableFrequencyLedger({local}).recordActivation({...args,receipt}).status,'duplicate');
});
test('Step15: stale chat receipt cannot count current chat frequency',()=>{
 const local=memoryStorage(),nonce='b'.repeat(32),block=wrapPromptBlock('safe prompt',nonce,0);
 let currentChat='A';const tracker=createPromptReceiptTracker({getChatId:()=>currentChat});
 tracker.register({chatId:'A',nonce,groups:[{tag:'one',text:block,recordIds:['r-1']}]});
 currentChat='B';const receipt=tracker.observe('chat',{chat:[{content:block}]});
 assert.equal(receipt.verified,false);assert.equal(receipt.reason,'chat-changed');
 const ledger=createDurableFrequencyLedger({local});
 assert.equal(ledger.recordActivation({chatId:'A',collectionKey:key,recordId:'r-1',turnId:'turn',scope:'conversation',receipt}).status,'unverified');
 assert.equal(ledger.snapshot({chatId:'A',collectionKey:key})['r-1'],undefined);
});
test('Step15: C11 completed NDJSON receipt does not bypass C01 protected backup durability contract',async()=>{
 const emitted=[];let closed=false,aborted=false;
 const receipt=await exportVerifiedNDJSON({key,contractVerified:true,writer:{write:async bytes=>emitted.push(new TextDecoder().decode(bytes)),close:async()=>{closed=true;},abort:async()=>{aborted=true;}},
  countRecords:async()=>({scope:key,contractVerified:true,count:1}),
  readPage:async()=>({scope:key,contractVerified:true,items:[{collectionKey:key,recordId:'r-1',text:'data'}],endOfList:true})});
 assert.equal(receipt.complete,true);assert.equal(closed,true);assert.equal(aborted,false);
 assert.equal(emitted.filter(line=>line.includes('vecthare-export-receipt')).length,1);
 const store={registry:[key],collections:{[key]:{protected:true}},tombstones:{}};
 let purges=0;
 const result=await deleteCollectionSafely({key,store,persist:async()=>true,contractVerified:true,
   inventory:async()=>({scope:key,status:'complete',complete:true,endOfListConfirmed:true,recordIds:['r-1']}),
   backup:async()=>receipt,purge:async()=>{purges++;return {status:'confirmed',scope:key};},
   verifyEmpty:async()=>({scope:key,status:'confirmed',complete:false,empty:false})});
 assert.equal(result.reason,'protected-collection-export-unverified');assert.equal(purges,0);
});
test('Step15: C11 failed page aborts export and cannot emit a completeness receipt',async()=>{
 const output=[];let aborted=false,closed=false;
 await assert.rejects(exportVerifiedNDJSON({key,contractVerified:true,writer:{write:async bytes=>output.push(new TextDecoder().decode(bytes)),close:async()=>{closed=true;},abort:async()=>{aborted=true;}},
  countRecords:async()=>({scope:key,contractVerified:true,count:2}),
  readPage:async()=>({scope:key,contractVerified:true,items:[{collectionKey:key,recordId:'r-1',text:'data'}],endOfList:true})}),/incomplete inventory/);
 assert.equal(aborted,true);assert.equal(closed,false);
 assert.equal(output.some(line=>line.includes('vecthare-export-receipt')),false);
});

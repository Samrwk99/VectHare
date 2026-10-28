/** E04: read-only host integration and provenance safety contracts. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import {createPromptReceiptTracker,wrapPromptBlock} from '../utils/prompt-receipts.js';
import {createWorldInfoSnapshotStore} from '../utils/world-info-identity.js';
import {preflightVerifiedCollectionExport,downloadVerifiedCollectionNDJSON} from '../core/c11-export.js';
import {expandRequiredLinks,resolveExclusiveCollections} from '../core/retrieval-planner.js';
const nonce='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const group=wrapPromptBlock('Some retrieved memory',nonce,0);
const receipt=()=>{const events=[];const tracker=createPromptReceiptTracker({getChatId:()=> 'chat-a',onReceipt:r=>events.push(r)});
 tracker.register({chatId:'chat-a',nonce,turnId:'u-1',groups:[{tag:'VH',text:group,recordIds:['r-1'],frequencyEntries:[{recordId:'r-1'}]}]});
 return {tracker,events};};

test('E04 prompt: different chat messages cannot be combined into a false inclusion',()=>{
 const {tracker,events}=receipt();const cut=group.indexOf('Some');
 const result=tracker.observe('chat',{chat:[{content:group.slice(0,cut)},{content:group.slice(cut)}]});
 assert.equal(result.status,'notIncluded');assert.deepEqual(result.recordIds,[]);assert.equal(events.length,1);
});
test('E04 prompt: parts within a single structured message can represent one complete block',()=>{
 const {tracker}=receipt();const cut=group.indexOf('Some');
 // Segments are separated with a line break by the host's text-part join.
 const result=tracker.observe('chat',{chat:[{role:'system',content:[{text:group.slice(0,cut-1)},{text:group.slice(cut)}]}]});
 assert.equal(result.status,'included');
});
test('E04 prompt: complete marker in one message still certifies inclusion',()=>{
 const {tracker}=receipt();assert.equal(tracker.observe('chat',{chat:[{content:'intro'},{content:group}]}).status,'included');
});
test('E04 prompt: object/string spoof does not stand in for assembled chat content',()=>{
 const {tracker}=receipt();assert.equal(tracker.observe('chat',{chat:[{data:{content:group}}]}).status,'notIncluded');
});
test('E04 prompt: dry run cannot consume or close pending receipt',()=>{
 const {tracker}=receipt();assert.equal(tracker.observe('chat',{chat:[{content:group}],dry_run:true}).verified,false);
 assert.equal(tracker.hasPending(),true);
});

test('E04 WI: explicit empty activatedEntries clears stale prior scan',()=>{
 const store=createWorldInfoSnapshotStore();store.capture('a',[{world:'World',uid:1}]);
 assert.equal(store.capture('a',{activatedEntries:[]}),true);assert.deepEqual(store.previous('a').entries,[]);
});
test('E04 WI: explicit empty Set and Map clear stale prior scan',()=>{
 const store=createWorldInfoSnapshotStore();store.capture('a',[{world:'World',uid:1}]);
 assert.equal(store.capture('a',new Set()),true);assert.equal(store.previous('a').entries.length,0);
 store.capture('a',[{world:'World',uid:1}]);assert.equal(store.capture('a',new Map()),true);
 assert.equal(store.previous('a').entries.length,0);
});
test('E04 WI: unknown payload cannot overwrite observed world-info scope',()=>{
 const store=createWorldInfoSnapshotStore();store.capture('a',[{world:'World',uid:1}]);
 assert.equal(store.capture('a',{nonsense:[]}),false);assert.equal(store.previous('a').entries.length,1);
});
test('E04 WI: empty nested observation cannot erase other chat previous-scan cache',()=>{
 const store=createWorldInfoSnapshotStore();store.capture('a',[{world:'A',uid:1}]);store.capture('b',[{world:'B',uid:2}]);
 store.capture('a',{activeEntries:[]});assert.equal(store.previous('a').entries.length,0);
 assert.equal(store.previous('b').entries.length,1);
});
test('E04 WI: exactly one winner from two already-active exclusive lorebooks',()=>{
 const ids=['lorebook-A','lorebook-B','lorebook-C'];const metas={
 'lorebook-A':{exclusiveWhenActive:true,retrievalPriority:1},
 'lorebook-B':{exclusiveWhenActive:true,retrievalPriority:9},'lorebook-C':{}};
 assert.deepEqual(resolveExclusiveCollections(ids,id=>metas[id]).ids,['lorebook-B']);
});

const key='standard:transformers:docs';const settings={vector_backend:'standard',source:'transformers'};
const adapter=(count={scope:key,contractVerified:true,count:3})=>({listScopedPage:async()=>({}),countScopedRecords:async()=>count});
const ready=over=>preflightVerifiedCollectionExport({key,settings,adapter:adapter(),capability:()=>true,...over});
test('E04 export: qualified verified count can pass read-only preflight',async()=>{
 assert.deepEqual(await ready(),{ready:true,scope:key,count:3});
});
test('E04 export: zero count is valid when independently verified',async()=>{
 assert.equal((await ready({adapter:adapter({scope:key,contractVerified:true,count:0})})).ready,true);
});
test('E04 export: unknown capability refuses before any count query',async()=>{
 let calls=0;const result=await ready({capability:()=>false,adapter:{countScopedRecords(){calls++;}}});
 assert.equal(result.ready,false);assert.equal(calls,0);
});
test('E04 export: wrong tenant count refuses',async()=>{
 assert.equal((await ready({adapter:adapter({scope:'standard:transformers:other',count:3,contractVerified:true})})).ready,false);
});
test('E04 export: request echoes without count attestation refuse',async()=>{
 assert.equal((await ready({adapter:adapter({scope:key,count:3})})).ready,false);
});
test('E04 export: swallowed backend count error cannot masquerade as zero',async()=>{
 const result=await ready({adapter:{listScopedPage(){},countScopedRecords(){throw Error('unreachable');}}});
 assert.equal(result.reason,'independent-count-failed');
});
test('E04 export: aborted preflight refuses without query',async()=>{
 let calls=0;const result=await ready({signal:{aborted:true},adapter:{listScopedPage(){},countScopedRecords(){calls++;}}});
 assert.equal(result.reason,'aborted');assert.equal(calls,0);
});
test('E04 export: missing adapter cannot open browser save file',async()=>{
 await assert.rejects(downloadVerifiedCollectionNDJSON({key,settings,capability:()=>true}),/no backup file opened/);
});
test('E04 export: mismatched backend is refused before counting',async()=>{
 assert.equal((await ready({key:'qdrant:transformers:docs'})).reason,'qualified-export-route-mismatch');
});

test('E04 C09: disabled scoped linked record must not be injected',async()=>{
 const seed={collectionId:'a',hash:'a1',metadata:{links:[{type:'hard',target:'a2'}]}};
 const result=await expandRequiredLinks([seed],[],{getByIds:async()=>({status:'confirmed',complete:true,items:[{collectionId:'a',hash:'a2',metadata:{disabled:true}}]})});
 assert.equal(result.items.length,1);assert.equal(result.reasons[0].code,'get-by-ids-scope-mismatch');
});
test('E04 C09: linked record with metadata enabled=false is also rejected',async()=>{
 const seed={collectionId:'a',hash:'a1',metadata:{links:[{type:'hard',target:'a2'}]}};
 const result=await expandRequiredLinks([seed],[],{getByIds:async()=>({status:'confirmed',complete:true,items:[{collectionId:'a',hash:'a2',metadata:{enabled:false}}]})});
 assert.equal(result.items.length,1);
});

test('E04 static: live frequency remains gated until actual host acceptance',()=>{
 const source=fs.readFileSync(new URL('../utils/activation-frequency-ledger.js',import.meta.url),'utf8');
 assert.match(source,/C08_FINAL_INCLUSION_RECEIPT_AVAILABLE = false/);
});
test('E04 static: WI integration uses one-winner C09 resolver',()=>{
 const source=fs.readFileSync(new URL('../core/world-info-integration.js',import.meta.url),'utf8');
 assert.match(source,/resolveExclusiveCollections\(collections\.map\(c=>c\.id\),getCollectionMeta\)/);
});

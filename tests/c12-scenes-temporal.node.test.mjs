import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {calculateGroupAge,normalizeSceneTimeline,resolveTemporalPolicy,weightChunksByCollection} from '../utils/c12-scene-temporal.js';
import {planSceneEdit,updateSceneAndReindex} from '../utils/c12-scene-update.js';
const applyTemporalDecay=(score,age,p)=>p.enabled ? score*Math.max(p.minRelevance??0,Math.pow(0.5,Math.max(0,age)/p.halfLife)) : score;
const applyNostalgiaBoost=(score,age,p)=>p.enabled ? score*(1+(p.maxBoost-1)*(1-Math.pow(0.5,Math.max(0,age)/p.halfLife))) : score;
const keyA='standard:transformers:chatA',keyB='standard:transformers:chatB';
const scene={hash:55,text:'original scene',metadata:{isScene:true,sceneId:'scene-55',sceneStart:0,sceneEnd:2,containedHashes:[3,4],summary:'old',title:'Scene'}};
const chunk=(key,id,age,score=.8)=>({collectionId:key,hash:id,score,metadata:{source:'chat',messageId:age}});
const mockOps={
    applyDecay:(chunks,current,p)=>chunks.map(x=>({...x,originalScore:x.score,score:applyTemporalDecay(x.score,current-x.metadata.messageId,p),decayApplied:true,messageAge:current-x.metadata.messageId})),
    applyNostalgia:(chunks,current,p)=>chunks.map(x=>({...x,originalScore:x.score,score:applyNostalgiaBoost(x.score,current-x.metadata.messageId,p),nostalgiaApplied:true,messageAge:current-x.metadata.messageId})),
    applySceneDecay:(chunks,current,scenes,p)=>chunks.map(x=>({...x,originalScore:x.score,score:applyTemporalDecay(x.score,current-x.metadata.messageId,p),sceneAwareDecay:true,messageAge:current-x.metadata.messageId})),
};

test('C12 #93 grouped age uses most recent member (not first or hash)',()=>{
 assert.equal(calculateGroupAge({messageIds:[0,4,10]},15),5);
 assert.equal(calculateGroupAge({messageIds:[10,4,0]},15),5);
 assert.equal(calculateGroupAge({sceneStart:3,sceneEnd:8},15),7);
 assert.equal(calculateGroupAge({messageId:0},15),15);
 assert.equal(calculateGroupAge({},15),null);
});
for(const meta of [{messageIds:[1,16]},{messageIds:['x']},{messageIds:[-1]},{messageId:Infinity}])
 test('C12 group age refuses corrupt or future metadata',()=>assert.equal(calculateGroupAge(meta,15),null));
test('C12 #94 policy isolates collection settings even for equal hash',()=>{
 const input=[chunk(keyA,55,0),chunk(keyB,55,0)];
 const result=weightChunksByCollection(input,100,{...mockOps,getPolicy:key=>({enabled:true,type:key===keyA?'decay':'nostalgia',mode:'exponential',halfLife:10,minRelevance:0,maxBoost:2})});
 assert.ok(result[0].score<.8);assert.ok(result[1].score>.8);
 assert.equal(result[0].temporalPolicyCollection,keyA);assert.equal(result[1].temporalPolicyCollection,keyB);
 assert.equal(input[0].score,.8);assert.equal(input[1].score,.8);
});
test('C12 #94 disabled collection retains score while sibling uses weighting',()=>{
 const result=weightChunksByCollection([chunk(keyA,1,0),chunk(keyB,2,0)],100,{...mockOps,getPolicy:key=>({enabled:key===keyA,type:'decay',mode:'exponential',halfLife:1,minRelevance:0})});
 assert.ok(result[0].score<.8);assert.equal(result[1].score,.8);
});
test('C12 #94 missing settings use documented conservative default',()=>{
 const p=resolveTemporalPolicy(keyA,{getPolicy:()=>undefined});assert.equal(p.enabled,false);assert.equal(p.type,'decay');
});
test('C12 #94 nostalgia never receives scene-aware decay',()=>{
 const p=resolveTemporalPolicy(keyA,{getPolicy:()=>({type:'nostalgia',enabled:true,sceneAware:true})});assert.equal(p.sceneAware,false);
});
test('C12 #84 timeline only includes matching chat and collection',()=>{
 const entries=[{chatOriginId:'chat-1',collectionKey:keyA,sceneId:'one',sceneStart:0,sceneEnd:2},
 {chatOriginId:'chat-2',collectionKey:keyA,sceneId:'foreign-chat',sceneStart:3,sceneEnd:4},
 {chatOriginId:'chat-1',collectionKey:keyB,sceneId:'foreign-collection',sceneStart:4,sceneEnd:5}];
 assert.deepEqual(normalizeSceneTimeline('chat-1',keyA,entries,10),[{start:0,end:2,sceneId:'one'}]);
});
test('C12 #84 scene-aware weighting calls timeline for chat even with no scene vector hits',()=>{
 let called=0, timelineUsed=[];
 const result=weightChunksByCollection([chunk(keyA,1,0)],10,{...mockOps,getPolicy:()=>({enabled:true,sceneAware:true,mode:'linear'}),getTimeline:key=>{called++;return [{start:0,end:2}];},applySceneDecay:(items,current,scenes,p)=>{timelineUsed=scenes;return mockOps.applySceneDecay(items,current,scenes,p);}});
 assert.equal(called,1);assert.equal(timelineUsed.length,1);assert.equal(result[0].sceneAwareDecay,true);
});
test('C12 #84 overlapping timelines are rejected as untrusted',()=>{
 const entries=[{chatOriginId:'c',collectionKey:keyA,sceneStart:0,sceneEnd:5}, {chatOriginId:'c',collectionKey:keyA,sceneStart:4,sceneEnd:6}];
 assert.deepEqual(normalizeSceneTimeline('c',keyA,entries,10),[]);
});
test('C12 #84 out-of-range boundaries are ignored',()=>{
 assert.deepEqual(normalizeSceneTimeline('c',keyA,[{chatOriginId:'c',collectionKey:keyA,sceneStart:1,sceneEnd:21}],5),[]);
});
test('C12 #235 summary changes are classified as reindex; title-only edits do not embed',()=>{
 assert.equal(planSceneEdit(scene,{summary:'new'}).kind,'reindex');
 assert.equal(planSceneEdit(scene,{title:'another'}).kind,'metadata');
 assert.equal(planSceneEdit(scene,{keywords:['one']}).kind,'metadata');
 assert.equal(planSceneEdit(scene,{summary:'old'}).kind,'metadata');
});
for(const patch of [{sceneStart:42},{sceneId:'changed'}, {summary:null},{keywords:'x'},{unexpected:true},{}])
 test('C12 rejects immutable, invalid or ambiguous scene edits',()=>assert.throws(()=>planSceneEdit(scene,patch)));
test('C12 #235 metadata-only changes never re-embed and need scoped point proof',async()=>{
 let writeCount=0,local=0;
 const result=await updateSceneAndReindex({scene,patch:{title:'updated'},collectionKey:keyA,
    commitMetadata:async()=>({status:'confirmed',scope:keyA,recordId:'55'}),
    replaceRecords:()=>{writeCount++;},commitLocal:()=>{local++;}});
 assert.equal(result.status,'committed');assert.equal(result.kind,'metadata');assert.equal(local,1);assert.equal(writeCount,0);
});
test('C12 #235 unverified metadata ack leaves local settings untouched',async()=>{
 let local=0;
 const result=await updateSceneAndReindex({scene,patch:{title:'new'},collectionKey:keyA,
    commitMetadata:async()=>({status:'confirmed',scope:keyB,recordId:'55'}),commitLocal:()=>{local++;}});
 assert.equal(result.status,'needs-reconcile');assert.equal(local,0);
});
test('C12 #235 failed reindex preserves original and old scene membership',async()=>{
 let remap=0,local=0;
 const receipt=await updateSceneAndReindex({scene,patch:{summary:'new'},collectionKey:keyA,
     buildReplacement:()=>({hash:99,metadata:{...scene.metadata,sceneId:'scene-55'}}),
     replaceRecords:async()=>({status:'needs-reconcile',operationId:'op1'}),
     remapReferences:()=>{remap++;return {status:'prepared',collectionKey:keyA,referencePlanId:'p1'};},commitLocal:()=>{local++;}});
 assert.equal(receipt.status,'needs-reconcile');assert.equal(remap,1);assert.equal(local,0);assert.equal(scene.metadata.summary,'old');
 assert.deepEqual(scene.metadata.containedHashes,[3,4]);
});
test('C12 #235 reindex requires verified remap before local commit',async()=>{
 let local=0;
 const result=await updateSceneAndReindex({scene,patch:{summary:'new'},collectionKey:keyA,
     buildReplacement:()=>({hash:99,metadata:{...scene.metadata,sceneId:'scene-55'}}),
     replaceRecords:async()=>({status:'committed',operationId:'op2'}),
     remapReferences:async()=>({status:'uncertain',collectionKey:keyA}),commitLocal:()=>{local++;}});
 assert.equal(result.status,'needs-reconcile');assert.equal(local,0);
});
test('C12 #235 success requires both replacement and reference-remap receipts',async()=>{
 let saved;
 const result=await updateSceneAndReindex({scene,patch:{summary:'new'},collectionKey:keyA,
     buildReplacement:()=>({hash:99,metadata:{...scene.metadata,sceneId:'scene-55'}}),
     replaceRecords:async()=>({status:'committed',referencesCommitted:true,collectionKey:keyA}),
     remapReferences:async()=>({status:'prepared',collectionKey:keyA,referencePlanId:'p1'}),commitLocal:async m=>{saved=m;}});
 assert.equal(result.status,'committed');assert.equal(saved.summary,'new');assert.equal(result.hash,99);
});
test('C12 runtime editor never treats unverified backend response as local success',()=>{
 const source=fs.readFileSync(new URL('../core/scenes.js',import.meta.url),'utf8');
 assert.match(source,/updateSceneAndReindex/);assert.doesNotMatch(source,/saveChunkMetadata\(sceneHash, updatedMeta\)/);
 const ui=fs.readFileSync(new URL('../ui/chunk-visualizer.js',import.meta.url),'utf8');
 assert.match(ui,/if \(!receipt.success\) throw/);
});
test('C12 runtime stage references chat timeline independent of scene hits',()=>{
 const source=fs.readFileSync(new URL('../core/chat-vectorization.js',import.meta.url),'utf8');
 assert.match(source,/getSceneTimeline\(chatOriginId,qualified,chat\)/);
 assert.match(source,/weightChunksByCollection/);
});

test('C12 cannot commit scene reindex without atomic reference proof',async()=>{
 const outcome=await updateSceneAndReindex({scene,patch:{summary:'new'},collectionKey:keyA,
  buildReplacement:()=>({hash:99,metadata:{...scene.metadata,sceneId:'scene-55'}}),
  remapReferences:async()=>({status:'prepared',collectionKey:keyA,referencePlanId:'plan'}),
  replaceRecords:async()=>({status:'committed'}),commitLocal:()=>{throw Error('must not reach');}});
 assert.equal(outcome.status,'needs-reconcile');assert.equal(scene.metadata.summary,'old');
});
test('C12 metadata success acknowledgement plus failed local save is reconciliation, not false success',async()=>{
 const outcome=await updateSceneAndReindex({scene,patch:{title:'new'},collectionKey:keyA,
  commitMetadata:async()=>({status:'confirmed',scope:keyA,recordId:'55'}),commitLocal:()=>{throw Error('quota');}});
 assert.equal(outcome.status,'needs-reconcile');
});
test('C12 oversized member arrays do not crash stage or invent age',()=>{
 assert.equal(calculateGroupAge({messageIds:Array(10001).fill(1)},100),null);
 assert.equal(calculateGroupAge({messageIds:[null,1]},100),null);
});

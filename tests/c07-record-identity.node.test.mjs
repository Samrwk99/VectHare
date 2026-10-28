import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';
import {
 fingerprint, recordId, diagnosticRecordKey, stampMessageUids, messageReference,
 groupRecordLocalId, checkCollision, reconcilePositions, reconcileSceneBoundaries, remapReferences,
 MESSAGE_UID_FIELD, embeddingProfileFingerprint
} from '../utils/record-identity.js';
import {createDebugData,recordChunkFate} from '../ui/search-debug.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const source=path=>readFileSync(resolve(root,path),'utf8');
const k1='standard:transformers:alpha';
const k2='qdrant:transformers:alpha';
const uid=n=>'u'.repeat(13)+String(n);
const msg=(index,name='Speaker')=>({mes:`Message ${index}`,name,extra:{[MESSAGE_UID_FIELD]:uid(index)}});

test('C07 qualified record identity isolates the same hash across backends and collections',()=>{
 assert.notEqual(recordId(k1,'hash:33'),recordId(k2,'hash:33'));
 assert.notEqual(recordId(k1,'hash:33'),recordId('standard:transformers:beta','hash:33'));
 assert.equal(diagnosticRecordKey(k1,33),recordId(k1,'hash:33'));
 assert.throws(()=>recordId('bare','hash:33'),/Unverified/);
});
test('C07 IDs escape delimiters and reject absent local IDs',()=>{
 assert.equal(recordId(k1,'a# b'),`${k1}#a%23%20b`);
 assert.throws(()=>recordId(k1,''),/Missing/);
});
test('C07 rejects a foreign metadata recordId instead of merging two collections',()=>{
 assert.equal(diagnosticRecordKey(k1,22,{recordId:recordId(k2,'22')}),recordId(k1,'hash:22'));
 assert.equal(diagnosticRecordKey(k1,22,{recordId:recordId(k1,'ref')}),recordId(k1,'ref'));
});
test('C07 fingerprint is deterministic, versioned, order-insensitive, unicode-capable',()=>{
 assert.equal(fingerprint({a:1,b:'🙂'}),fingerprint({b:'🙂',a:1}));
 assert.match(fingerprint('🐈'),/^vh-fp2-fnv64:[a-f0-9]{16}$/);
 assert.notEqual(fingerprint('A'),fingerprint('B'));
});
test('C07 fingerprint supports plain HTTP without subtle crypto',()=>{
 assert.equal(fingerprint(['text',1]),fingerprint(['text',1]));
});
test('C07 stamps message UIDs only for non-system chat messages',()=>{
 const chat=[{mes:'hello'}, {is_system:true,mes:'system'}, {mes:'more'}];
 let i=0;const result=stampMessageUids(chat,{createUid:()=>uid(++i)});
 assert.deepEqual(result.touched,[0,2]);
 assert.equal(chat[1].extra,undefined);
 assert.notEqual(chat[0].extra[MESSAGE_UID_FIELD],chat[2].extra[MESSAGE_UID_FIELD]);
});
test('C07 restamping is idempotent and preserves existing stable UIDs',()=>{
 const chat=[msg(1),msg(2)];
 let calls=0;const result=stampMessageUids(chat,{createUid:()=>{calls++;return uid(8);}});
 assert.equal(result.changed,false); assert.equal(calls,0);
});
test('C07 duplicate UIDs in a copied chat are separated',()=>{
 const chat=[msg(1),msg(1)];
 const result=stampMessageUids(chat,{createUid:()=>uid(3)});
 assert.deepEqual(result.touched,[1]);
 assert.equal(chat[0].extra[MESSAGE_UID_FIELD],uid(1));
 assert.equal(chat[1].extra[MESSAGE_UID_FIELD],uid(3));
});
test('C07 fail closed when UID generator cannot create a unique valid UID',()=>{
 assert.throws(()=>stampMessageUids([{mes:'hey'}],{createUid:()=> '1'}),/unique/);
});
test('C07 copied UID is distinct in different chat scopes',()=>{
 assert.notEqual(messageReference('chat-A',msg(1)),messageReference('chat-B',msg(1)));
 assert.throws(()=>messageReference('',msg(1)),/chat ID/);
});
test('C07 legacy message with no stamped UID cannot claim stable identity',()=>{
 assert.throws(()=>messageReference('chat-A',{mes:'hi'}),/Missing stable/);
});
test('C07 grouped membership is order-sensitive and position-independent',()=>{
 const a=messageReference('chat-A',msg(1)),b=messageReference('chat-A',msg(2));
 assert.equal(groupRecordLocalId([a,b]),groupRecordLocalId([a,b]));
 assert.notEqual(groupRecordLocalId([a,b]),groupRecordLocalId([b,a]));
 assert.throws(()=>groupRecordLocalId([]),/membership/);
});
test('C07 identical hash and identical text are deterministic duplicates, not collisions',()=>{
 const c=checkCollision([{hash:4,raw:'same'},{hash:4,raw:'same'}]);
 assert.equal(c.safe,true); assert.equal(c.duplicates.length,1);assert.equal(c.distinctHashes,1);
});
test('C07 distinct text with a matching hash blocks Standard-compatible inserts',()=>{
 const c=checkCollision([{hash:4,raw:'A'},{hash:4,raw:'B'}]);
 assert.equal(c.safe,false);assert.equal(c.collisions.length,1);
});
test('C07 positional reconciliation survives a message insertion',()=>{
 const chat=[msg(4),msg(1),msg(2)];
 const r={metadata:{messageRefs:[messageReference('chat-A',chat[1]),messageReference('chat-A',chat[2])]}};
 const result=reconcilePositions([r],'chat-A',chat);
 assert.equal(result[0].status,'ready');
 assert.deepEqual(result[0].metadata.messageIds,[1,2]);
 assert.equal(result[0].metadata.startIndex,1);
 assert.equal(result[0].metadata.endIndex,2);
});
test('C07 unresolved/stale refs block updates rather than guessing by position',()=>{
 const result=reconcilePositions([{metadata:{messageRefs:[messageReference('chat-A',msg(3))]}}],'chat-A',[msg(1)]);
 assert.equal(result[0].status,'blocked');
});
test('C07 duplicate UID in chat blocks ambiguous positional proposals',()=>{
 const duplicate=[msg(1),msg(1)];
 const result=reconcilePositions([{metadata:{messageRefs:[messageReference('chat-A',msg(1))]}}],'chat-A',duplicate);
 assert.equal(result[0].status,'blocked');
});
test('C07 reference remap updates scalar and array links, parent and scene IDs',()=>{
 const result=remapReferences({parentHash:10,linkedHashes:[10,20],disabledByScene:20,summaryHash:10}, {'10':100,'20':200},{requireMapped:true});
 assert.equal(result.status,'ready');
 assert.equal(result.metadata.parentHash,100);
 assert.deepEqual(result.metadata.linkedHashes,[100,200]);
 assert.equal(result.metadata.disabledByScene,200);
});
test('C07 strict remap refuses missing refs without partial mutation',()=>{
 const source={parentHash:10,linkedHashes:[10,20]};
 const result=remapReferences(source,{'10':100},{requireMapped:true});
 assert.equal(result.status,'blocked');assert.equal(result.metadata,source);
 assert.deepEqual(result.unresolved,['20']);
});
test('C07 invalid replacement mapping blocks reference remap',()=>{
 const r=remapReferences({parentId:1},{'1':null},{requireMapped:true});
 assert.equal(r.status,'blocked');
});
test('C07 diagnostic fates do not mix identical hashes from two collections',()=>{
 const d=createDebugData();
 recordChunkFate(d,7,'vector_search','passed',null,{collectionId:k1});
 recordChunkFate(d,7,'vector_search','passed',null,{collectionId:k2});
 assert.equal(Object.keys(d.chunkFates).length,2);
 recordChunkFate(d,7,'threshold','dropped','bad');
 assert.equal(Object.keys(d.chunkFates).length,3);
 assert.equal(d.chunkFates[`${k1}#hash:7`].finalFate,null);
 assert.equal(d.chunkFates[`${k2}#hash:7`].finalFate,null);
 assert.ok(d.chunkFates['unresolved#hash:7'].ambiguous);
});
test('C07 export keeps new reference fields for backups',()=>{
 const s=source('core/collection-export.js');
 for (const field of ['recordId','messageRefs','logicalGroupIds','contentFingerprint','sceneStartRef','sceneEndRef'])
  assert.ok(s.includes(`'${field}'`),`missing ${field}`);
});
test('C07 backend metadata joins expose ambiguous duplicate hashes',()=>{
 const s=source('core/core-vector-api.js');
 assert.match(s,/ambiguousHashes/);
 assert.match(s,/metadataStatus: ambiguousHashes\.size \? 'ambiguous'/);
});
test('C07 physical backend hash remains unchanged pending C02 migration',()=>{
 const s=source('core/chat-vectorization.js');
 assert.match(s,/hash: getStringHash\(combinedRaw\)/);
 assert.match(s,/hash: m\.hash/);
});

// Run the real, extracted chat grouping functions with a host-free environment.
import vm from 'node:vm';
function functionSource(file, prefix) {
 const s=source(file),start=s.indexOf(prefix),end=s.indexOf('\n}\n',start);
 assert.ok(start>=0 && end>start,`Cannot extract ${prefix}`);
 return s.slice(start,end+2);
}
function actualChatGrouping({hash=(text)=> [...text].reduce((v,c)=> v*31+c.codePointAt(0),0)}={}) {
 const context=vm.createContext({
  getStringHash:hash, getTextWithoutAttachments:m=>String(m.mes||'').trim(),
  substituteParams:x=>x,cleanText:x=>x,
  extractBM25Keywords:()=>[],groupConversationTurns:messages=>messages.map(m=>[m]),
  getVerifiedChatOriginId:()=> 'verified-chat', messageReference, recordId, fingerprint,
  groupRecordLocalId, checkCollision, embeddingProfileFingerprint,
 });
 const code=[
  functionSource('core/chat-vectorization.js','function groupMessagesByStrategy('),
  functionSource('core/chat-vectorization.js','function collectGroupedItems('),
  'collectGroupedItems'
 ].join('\n');
 return vm.runInContext(code,context);
}
test('C07 integrated chat grouping stores durable references without changing legacy hashes',()=>{
 const chat=[msg(1)];const grouped=actualChatGrouping()(chat,{vector_backend:'standard',source:'transformers',chunking_strategy:'per_message'},'col',true);
 assert.equal(grouped.length,1);
 assert.equal(grouped[0].hash,[...'Message 1'].reduce((v,c)=>v*31+c.codePointAt(0),0));
 assert.equal(grouped[0].metadata.messageRefs[0],messageReference('verified-chat',chat[0]));
 assert.match(grouped[0].metadata.recordId,/standard:transformers:col#hash%3A/);
 assert.ok(grouped[0].metadata.logicalGroupIds.length);
});
test('C07 integrated duplicate messages merge membership into one storage record',()=>{
 const chat=[{...msg(1),mes:'identical'}, {...msg(2),mes:'identical'}];
 const grouped=actualChatGrouping()(chat,{vector_backend:'standard',source:'transformers',chunking_strategy:'per_message'},'col',true);
 assert.equal(grouped.length,1);
 assert.deepEqual(Array.from(grouped[0].metadata.messageIds),[0,1]);
 assert.equal(grouped[0].metadata.messageRefs.length,2);
 assert.equal(grouped[0].metadata.logicalGroupIds.length,2);
});
test('C07 integrated distinct-text collision prevents a write',()=>{
 const hash=()=>42,chat=[msg(1),msg(2)];
 assert.throws(()=>actualChatGrouping({hash})(chat,{vector_backend:'standard',source:'transformers'},'col',true),/write blocked/);
});
test('C07 integrated legacy fallback keeps old positional metadata and records absence of durable refs',()=>{
 const chat=[{mes:'legacy text',name:'Alice'}];
 const grouped=actualChatGrouping()(chat,{vector_backend:'standard',source:'transformers'},'col',false);
 assert.equal(grouped.length,1);
 assert.ok(!grouped[0].metadata.messageRefs);
 assert.equal(grouped[0].metadata.speaker,'Alice');
});
test('C07 integrated grouped speaker members and UIDs retain original order',()=>{
 const chat=[msg(1,'Alice'),msg(2,'Bob')];
 const grouped=actualChatGrouping()(chat,{vector_backend:'standard',source:'transformers',chunking_strategy:'message_batch',batch_size:2},'col',true);
 assert.equal(grouped.length,1);
 assert.deepEqual(Array.from(grouped[0].metadata.speakers),['Alice','Bob']);
 assert.equal(grouped[0].metadata.messageRefs.length,2);
 assert.deepEqual(Array.from(grouped[0].metadata.messageIds),[0,1]);
});
function actualDurableUidSave(context, {fail=false}={}) {
 const vmContext=vm.createContext({
  getVerifiedChatOriginId:()=> 'verified-chat',stampMessageUids,
  StaleJobError:class extends Error{},
  console:{warn:()=>{}},
 });
 const fn=vm.runInContext(`${functionSource('core/chat-vectorization.js','async function ensureDurableMessageUids(')}\nensureDurableMessageUids`,vmContext);
 const job={assertCurrent(){if(fail) throw new Error('stale');}};
 return fn(context.chat,context,job);
}
test('C07 durability integration saves new message UIDs before accepting them',async()=>{
 let saves=0;const chat=[{mes:'new'}];
 const result=await actualDurableUidSave({chat,saveChat:async()=>{saves++;}});
 assert.equal(result,true);assert.equal(saves,1);
 assert.ok(chat[0].extra[MESSAGE_UID_FIELD]);
});
test('C07 durability integration skips stamping without host save capability',async()=>{
 const chat=[{mes:'new'}];const result=await actualDurableUidSave({chat});
 assert.equal(result,false);assert.equal(chat[0].extra,undefined);
});
test('C07 durability integration rolls back new UIDs on failed save',async()=>{
 const chat=[{mes:'new',extra:{foo:123}}];
 const result=await actualDurableUidSave({chat,saveChat:async()=>{throw new Error('offline');}});
 assert.equal(result,false);assert.deepEqual(chat[0].extra,{foo:123});
});

test('C07 anchored scenes follow inserted messages, not obsolete indices',()=>{
 const a=msg(1),b=msg(2),scene={metadata:{isScene:true,sceneStart:0,sceneEnd:1,sceneStartRef:messageReference('chat-A',a),sceneEndRef:messageReference('chat-A',b)}};
 const result=reconcileSceneBoundaries([scene],'chat-A',[msg(9),a,b])[0];
 assert.equal(result.status,'ready');assert.equal(result.metadata.sceneStart,1);assert.equal(result.metadata.sceneEnd,2);
});
test('C07 anchored scenes do not cross a copied chat integrity boundary',()=>{
 const a=msg(1),scene={metadata:{sceneStart:0,sceneEnd:0,sceneStartRef:messageReference('chat-A',a),sceneEndRef:messageReference('chat-A',a)}};
 assert.equal(reconcileSceneBoundaries([scene],'chat-B',[a])[0].status,'blocked');
});
test('C07 scene with reordered boundaries blocks instead of reversing time',()=>{
 const a=msg(1),b=msg(2),scene={metadata:{sceneStartRef:messageReference('chat-A',b),sceneEndRef:messageReference('chat-A',a)}};
 const outcome=reconcileSceneBoundaries([scene],'chat-A',[a,b])[0];
 assert.equal(outcome.status,'blocked');
});
test('C07 legacy scenes remain explicitly legacy for migration rather than claiming UID durability',()=>{
 assert.equal(reconcileSceneBoundaries([{metadata:{sceneStart:1,sceneEnd:2}}],'chat-A',[msg(1),msg(2)])[0].status,'legacy');
});
test('C07 duplicated boundary UIDs are never resolved to the last duplicate',()=>{
 const a=msg(1),scene={metadata:{sceneStartRef:messageReference('chat-A',a),sceneEndRef:messageReference('chat-A',a)}};
 assert.equal(reconcileSceneBoundaries([scene],'chat-A',[a,msg(1)])[0].status,'blocked');
});

test('C07 world-info entries prefer persisted entryUid over chunk hash',()=>{
 assert.match(source('core/world-info-integration.js'),/uid: meta\.entryUid \?\? meta\.uid \?\? meta\.hash/);
});
test('C07 chat save explicit rejection rolls back provisional message UID',async()=>{
 const chat=[{mes:'new'}];
 const result=await actualDurableUidSave({chat,saveChat:async()=>false});
 assert.equal(result,false);assert.equal(chat[0].extra,undefined);
});
test('C07 stale post-save job does not remove an accepted UID',async()=>{
 const chat=[{mes:'new'}];
 await assert.rejects(actualDurableUidSave({chat,saveChat:async()=>{}},{fail:true}),/stale/);
 assert.ok(chat[0].extra[MESSAGE_UID_FIELD]);
});

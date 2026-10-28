import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {chunkText, CHUNKER_VERSION, validateOverlap, applyTextOverlap, adaptiveChatGroups,
    parseUploadedScenes, planChunkStrategyRebuild, getChatStrategies} from '../core/chunking.js';
import {validateChunkStrategy,requireSupportedChunkStrategy} from '../utils/feature-support.js';
import {getChunkingStrategies, CHUNKING_STRATEGIES} from '../core/content-types.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const src=p=>readFileSync(resolve(root,p),'utf8');
const docs={strategy:'adaptive',chunkSize:10,chunkOverlap:3};
const messages=[
  {mes:'A short greeting',index:0,is_user:true,name:'User'},
  {mes:'The reply contains a surprisingly long sentence and several more words.',index:1,is_user:false,name:'Alice'},
  {mes:'Another user sentence here',index:2,is_user:true,name:'User'},
];

test('C13 #57 overlap=0 preserves strategy natural segmentation',async()=>{
  const base=await chunkText('AAA. BBB. CCC. DDD.',{strategy:'sentence',chunkSize:10,chunkOverlap:0});
  assert.equal(base.length,2);
  assert.equal(base.map(x=>x.text).join(' '),'AAA. BBB. CCC. DDD.');
});
test('C13 #57 overlapping windows produce exact shared spans',async()=>{
  const text='0123456789abcdefghijklmnop';
  const out=await chunkText(text,{strategy:'adaptive',chunkSize:10,chunkOverlap:3});
  assert.ok(out.length>=3);
  for(let i=1;i<out.length;i++) assert.equal(out[i].text.slice(0,3),out[i-1].text.slice(-3));
  assert.ok(out.every(x=>x.text.length>0&&x.text.length<=10));
});
test('C13 #57 zero overlap remains deterministic and backward compatible',()=>{
  const blocks=['one','two'];
  assert.deepEqual(applyTextOverlap(blocks,20,0),blocks);
  assert.deepEqual(applyTextOverlap(blocks,20,0),applyTextOverlap(blocks,20,0));
});
test('C13 #57 end windows cannot be empty or identical',()=>{
  for(const [size,overlap] of [[2,1],[7,6],[12,3]]) {
    const out=applyTextOverlap(['ABCDEFGHIJKLMNOPQRSTUVWXYZ'],size,overlap);
    assert.ok(out.length);
    assert.ok(out.every(x=>x.text&&x.text.length<=size));
    for(let i=1;i<out.length;i++) assert.notEqual(out[i].text,out[i-1].text);
  }
});
test('C13 #57 no empty split when text is shorter than requested size',async()=>{
  const out=await chunkText('short',{strategy:'adaptive',chunkSize:100,chunkOverlap:20});
  assert.equal(out.length,1);assert.equal(out[0].text,'short');
});
test('C13 #57 invalid overlap rejects before partial chunking',()=>{
  for(const [size,overlap] of [[0,0],[10,10],[10,11],[10,-1],[10,1.2],[10,NaN],['10',1],[Infinity,1]])
    assert.throws(()=>validateOverlap(size,overlap),/chunkSize|chunkOverlap/);
});
test('C13 #57 only size-aware strategies advertise overlap control',()=>{
  for(const name of ['adaptive','sentence','dialogue']) assert.equal(CHUNKING_STRATEGIES[name].needsOverlap,true);
  for(const name of ['per_message','message_batch','paragraph','per_scene']) assert.equal(CHUNKING_STRATEGIES[name].needsOverlap,false);
});
test('C13 #57 sentence strategy actually uses overlap',async()=>{
  const a=await chunkText('aa. bb. cc. dd. ee. ff.',{strategy:'sentence',chunkSize:9,chunkOverlap:0});
  const b=await chunkText('aa. bb. cc. dd. ee. ff.',{strategy:'sentence',chunkSize:9,chunkOverlap:2});
  assert.notDeepEqual(a.map(c=>c.text),b.map(c=>c.text));
  assert.ok(b.every(c=>c.text.length<=9));
});
test('C13 #57 dialogue strategy uses bounded overlap',async()=>{
  const b=await chunkText('She said "one" and then "two" before "three".',{strategy:'dialogue',chunkSize:15,chunkOverlap:3});
  assert.ok(b.length>1&&b.every(x=>x.text.length<=15));
});
test('C13 #57 unsupported unit-based overlap is not misadvertised',()=>{
  assert.equal(CHUNKING_STRATEGIES.per_entry.needsOverlap,false);
  assert.ok(!getChunkingStrategies('chat',{kind:'live_chat'}).some(x=>x.needsOverlap));
});

test('C13 #107 adaptive chat is not a per-message fallback',async()=>{
  const grouped=await chunkText(messages,{strategy:'adaptive',chunkSize:35});
  const per=await chunkText(messages,{strategy:'per_message'});
  assert.notDeepEqual(grouped.map(c=>c.text),per.map(c=>c.text));
  assert.ok(grouped.some(c=>Array.isArray(c.metadata.messageIds)));
});
test('C13 #107 chat grouping is deterministic and versioned',()=>{
  assert.equal(CHUNKER_VERSION,2);
  assert.deepEqual(adaptiveChatGroups(messages,{chunkSize:60}),adaptiveChatGroups(messages,{chunkSize:60}));
  assert.ok(adaptiveChatGroups(messages,{chunkSize:60}).every(c=>c.metadata.chunkerVersion===2));
});
test('C13 #107 varying chunk sizes changes boundaries',()=>{
  const small=adaptiveChatGroups(messages,{chunkSize:40});
  const large=adaptiveChatGroups(messages,{chunkSize:120});
  assert.ok(small.length>large.length);
});
test('C13 #107 long messages split into bounded segments, retaining message ID',()=>{
  const chunks=adaptiveChatGroups([{text:'x'.repeat(500),raw:'x'.repeat(500),index:4,is_user:true}],{chunkSize:50});
  assert.ok(chunks.length>5);
  assert.ok(chunks.every(c=>c.text.length<=50&&c.metadata.messageIds.includes(4)));
  assert.ok(chunks.every(c=>c.metadata.segmentOffsets.length>0));
});
test('C13 #107 message references survive regrouping',()=>{
  const g=adaptiveChatGroups([{text:'hello',messageRef:'chat-1:uid-one',index:8,is_user:true},
    {text:'hello',messageRef:'chat-1:uid-two',index:9}],{chunkSize:200});
  assert.equal(g.length,1);
  assert.deepEqual(g[0].metadata.messageRefs,['chat-1:uid-one','chat-1:uid-two']);
  assert.deepEqual(g[0].metadata.messageIds,[8,9]);
});
test('C13 #107 empty chat yields no false chunks',async()=>{
  assert.deepEqual(adaptiveChatGroups([]),[]);
  assert.deepEqual(await chunkText([],{strategy:'adaptive'}),[]);
});
test('C13 #107 explicit versioned rebuild requires separate qualified collection',()=>{
  const input={oldCollectionKey:'standard:transformers:old',newCollectionKey:'standard:transformers:new',
    strategy:'adaptive',sourceRecordCount:10};
  const plan=planChunkStrategyRebuild(input);
  assert.equal(plan.status,'dry-run');assert.equal(plan.requiresVerifiedC02Commit,true);
  assert.equal(plan.automaticActivation,false); assert.equal(plan.preservesOriginal,true);
  assert.ok(Object.isFrozen(plan));
});
test('C13 #107 plan rejects in-place identity migration, invalid keys, unknown count',()=>{
  const base={oldCollectionKey:'standard:transformers:a',newCollectionKey:'standard:transformers:b',strategy:'adaptive',sourceRecordCount:3};
  for(const change of [{newCollectionKey:base.oldCollectionKey},{oldCollectionKey:'legacy'},
    {sourceRecordCount:null},{sourceRecordCount:-1},{newChunkerVersion:1},
    {strategy:'unknown'}]) assert.throws(()=>planChunkStrategyRebuild({...base,...change}),/C13/);
});
test('C13 #107 live chat cannot silently switch to adaptive',()=>{
  assert.equal(validateChunkStrategy('adaptive','chat',{kind:'live_chat',existingCollection:true}).supported,false);
  assert.throws(()=>requireSupportedChunkStrategy('adaptive','chat',{kind:'live_chat'}),/new versioned collection/);
  assert.equal(validateChunkStrategy('adaptive','chat',{uploaded:true,kind:'upload'}).supported,true);
});
test('C13 #107 chat settings UI excludes in-place adaptive selection',()=>{
  assert.ok(!getChunkingStrategies('chat',{kind:'live_chat'}).some(x=>x.id==='adaptive'));
  assert.ok(getChunkingStrategies('chat',{kind:'upload',uploaded:true}).some(x=>x.id==='adaptive'));
});
test('C13 #107 legacy chat strategies still pass their support gates',()=>{
  for(const s of ['per_message','message_batch','conversation_turns','per_scene'])
    assert.equal(validateChunkStrategy(s,'chat',{kind:'live_chat'}).supported,true);
});
test('C13 #107 changes to live chat grouping require review, not fallback',()=>{
  assert.match(src('core/chat-vectorization.js'),/requireSupportedChunkStrategy\(strategy, 'chat', \{kind:'live_chat',existingCollection:true\}\)/);
  assert.match(src('core/content-vectorization.js'),/chunkerVersion: CHUNKER_VERSION/);
});

test('C13 #148 no uploaded scenes without explicit markers',()=>{
  assert.throws(()=>parseUploadedScenes([{mes:'hello'},{mes:'world'}]),/no complete scene markers/);
  assert.equal(validateChunkStrategy('per_scene','chat',{kind:'upload',uploaded:true}).supported,false);
});
test('C13 #148 paired upload flags produce a scene with correct membership',()=>{
  const out=parseUploadedScenes([{mes:'A',name:'Alice',sceneStart:true},{mes:'B',is_user:true},{mes:'C',sceneEnd:true}]);
  assert.equal(out.length,1);assert.equal(out[0].metadata.isScene,true);
  assert.equal(out[0].metadata.sceneEnd,2);assert.deepEqual(out[0].metadata.messageIds,[0,1,2]);
});
test('C13 #148 independent adjacent scenes preserve their boundaries',()=>{
  const out=parseUploadedScenes([{mes:'A',sceneStart:true},{mes:'B',sceneEnd:true},
      {mes:'C',sceneStart:true},{mes:'D',sceneEnd:true}]);
  assert.deepEqual(out.map(c=>[c.metadata.sceneStart,c.metadata.sceneEnd]),[[0,1],[2,3]]);
});
test('C13 #148 explicit metadata range scenes are parsed',()=>{
  const out=parseUploadedScenes([{mes:'A'},{mes:'B'},{mes:'C'}],{scenes:[{start:0,end:1,title:'Intro'}]});
  assert.equal(out[0].metadata.sceneTitle,'Intro');
  assert.equal(out[0].metadata.messageIds.length,2);
});
test('C13 #148 allows text markers only when explicitly delimited',()=>{
  assert.equal(parseUploadedScenes([{mes:'[SCENE START] hello'},{mes:'[SCENE END] goodbye'}]).length,1);
});
test('C13 #148 malformed markers fail at selection, not vector insertion',()=>{
  const samples=[ [{mes:'X',sceneEnd:true}], [{mes:'X',sceneStart:true}],
    [{mes:'X',sceneStart:true},{mes:'Y',sceneStart:true},{mes:'Z',sceneEnd:true}] ];
  for(const sample of samples) assert.throws(()=>parseUploadedScenes(sample),/C13/);
});
test('C13 #148 overlapping metadata scenes are rejected',()=>{
  assert.throws(()=>parseUploadedScenes([{mes:'A'},{mes:'B'},{mes:'C'}],
    {scenes:[{start:0,end:1},{start:1,end:2}]}),/overlapping/);
});
test('C13 #148 invalid and non-integer indexes are rejected',()=>{
  for(const range of [{start:-1,end:2},{start:2,end:9},{start:1.1,end:2},{start:2,end:1}])
    assert.throws(()=>parseUploadedScenes([{mes:'A'},{mes:'B'},{mes:'C'}],{scenes:[range]}),/invalid/);
});
test('C13 #148 uploaded scene options appear only when markers detected',()=>{
  const yes=getChunkingStrategies('chat',{kind:'upload',uploaded:true,sceneMarkersPresent:true});
  const no=getChunkingStrategies('chat',{kind:'upload',uploaded:true,sceneMarkersPresent:false});
  assert.ok(yes.some(s=>s.id==='per_scene'));
  assert.ok(!no.some(s=>s.id==='per_scene'));
});
test('C13 #148 live scenes retain marker-managed strategy',()=>{
  assert.equal(validateChunkStrategy('per_scene','chat',{kind:'live_chat'}).supported,true);
  assert.equal(validateChunkStrategy('per_scene','document',{kind:'upload',sceneMarkersPresent:true}).supported,false);
});
test('C13 #148 actual chunkText emits scene metadata, not empty fallback',async()=>{
  const out=await chunkText([{mes:'A',sceneStart:true},{mes:'B',sceneEnd:true}],{strategy:'per_scene'});
  assert.equal(out.length,1);assert.equal(out[0].metadata.isScene,true);
  assert.equal(out[0].metadata.chunkerVersion,2);
});
test('C13 #148 scene metadata index attached after normalization',()=>{
  assert.match(src('core/content-vectorization.js'),/sceneStart: m\.sceneStart === true/);
  assert.match(src('ui/content-vectorizer.js'),/updateChunkingSection\(getContentType\('chat'\)\)/);
});
test('C13 UI and runtime use the same strategy support contract',()=>{
  assert.match(src('core/content-types.js'),/validateChunkStrategy/);
  assert.match(src('core/content-vectorization.js'),/requireSupportedChunkStrategy/);
});
test('C13 import new collection creates separate destination and keeps owner in review',()=>{
  assert.match(src('core/content-vectorization.js'),/if \(settings\.strategy === 'adaptive' \|\| settings\.strategy === 'per_scene'\)/);
  assert.match(src('core/content-vectorization.js'),/source\.type === 'file'/);
});

test('C13 overlap preserves semantic base chunk membership',()=>{
  const result=applyTextOverlap(['Paragraph A.','Paragraph B.'],20,3);
  assert.equal(result.length,2);
  assert.equal(result[0].text,'Paragraph A.');
  assert.equal(result[1].text,' A. Paragraph B.');
  assert.equal(result[1].metadata.sourceBlock,1);
});
test('C13 overlap preserves every source character in bounded segments',()=>{
  const source='abcdefghij'.repeat(19);
  const out=applyTextOverlap([source],19,5);
  const reconstruction=out.map(x=>x.text.slice(x.metadata.overlapPrefixLength)).join('');
  assert.equal(reconstruction,source);
  assert.ok(out.every(x=>x.text.length<=19));
});
test('C13 Unicode overlap does not create lone surrogate halves',()=>{
  const sample='🐈🙂🐢🐬🐕🦊🐠🐌';
  const chunks=applyTextOverlap([sample],7,2);
  const restored=chunks.map(c=>c.text.slice(c.metadata.overlapPrefixLength)).join('');
  assert.equal(restored,sample);
  for(const c of chunks) assert.equal([...c.text].join(''),c.text);
});
test('C13 Unicode adaptive message boundaries preserve code points',()=>{
  const sample='🦄'.repeat(12);
  const items=adaptiveChatGroups([{text:sample,index:1,is_user:true}],{chunkSize:13});
  const parts=items.flatMap(x=>x.text.match(/\[User\]: ([^\n]*)/g)||[]).map(x=>x.slice(8));
  assert.equal(parts.join(''),sample);
  assert.ok(items.every(x=>x.text.length<=13));
});
test('C13 oversize single word does not bypass requested chunk limit',async()=>{
  const chunks=await chunkText('Q'.repeat(1001),{strategy:'adaptive',chunkSize:60,chunkOverlap:0});
  assert.ok(chunks.length>5);
  assert.ok(chunks.every(x=>x.text.length<=60));
  assert.equal(chunks.map(x=>x.text).join(''),'Q'.repeat(1001));
});
test('C13 new upload uses actual default overlap in metadata',()=>{
  const source=src('core/content-vectorization.js');
  assert.match(source,/const effectiveOverlap =/);
  assert.match(source,/chunkOverlap: effectiveOverlap/);
  assert.match(source,/getChunkingStrategy\(chosenStrategy\)\?\.defaultOverlap/);
});
test('C13 explicit JSON metadata ranges remain untouched through preparation',()=>{
  const source=src('core/content-vectorization.js');
  const signature='function prepareChatContent(rawContent, settings) {';
  const start=source.indexOf(signature),end=source.indexOf('\n}\n',start);
  assert.ok(start>=0&&end>start);
  const sandbox=vm.createContext({cleanText:x=>x,cleanMessages:x=>x});
  const prepare=vm.runInContext(`${source.slice(start,end+2)}\nprepareChatContent`,sandbox);
  const raw={messages:[{mes:'A',sceneStart:true,is_user:true},{mes:'B',sceneEnd:true}],
    metadata:{scenes:[{start:0,end:1,title:'Chapter'}]}};
  const prepared=prepare(raw,{strategy:'per_scene'});
  assert.equal(prepared.text.length,2);
  assert.equal(prepared.text[0].sceneStart,true);
  assert.equal(prepared.text[1].sceneEnd,true);
  assert.equal(parseUploadedScenes(prepared.text,prepared.sourceMetadata)[0].metadata.sceneTitle,'Chapter');
});
test('C13 refuses metadata indexes invalidated by removing system messages',()=>{
  const source=src('core/content-vectorization.js');
  const signature='function prepareChatContent(rawContent, settings) {';
  const start=source.indexOf(signature),end=source.indexOf('\n}\n',start);
  const prepare=vm.runInNewContext(`${source.slice(start,end+2)}\nprepareChatContent`,{cleanText:x=>x,cleanMessages:x=>x});
  assert.throws(()=>prepare({messages:[{mes:'system',is_system:true},{mes:'A'}],metadata:{scenes:[{start:0,end:1}]}},
    {strategy:'per_scene'}),/ambiguous/);
});

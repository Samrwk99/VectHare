import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {parseCollectionKey,formatCollectionKey,resolveCollectionKey} from '../utils/collection-keys.js';
import {validateOperation,requireConfirmedDeleteAck} from '../utils/backend-operation-validation.js';
import {BACKEND_CAPABILITIES,hasVerifiedCapability} from '../utils/backend-contracts.js';
import {beginOperation,settleOperation,getOperationEvents,clearOperationEvents,canAuthorizeDestructiveFollowup} from '../utils/operation-outcomes.js';
import {createWriteBarrier,withCollectionLock,PurgeInProgress} from '../utils/keyed-mutex.js';
import {planReplacement,applyVerifiedReplacement} from '../utils/replacement-safety.js';
import {redactSecrets} from '../utils/security.js';
import {phase0Flags,isFeatureEnabled,snapshotRegistryBeforeMigration} from '../utils/phase0-rollout.js';
import {parseSafePng,readLimitedStream,MAX_PNG_BYTES} from '../utils/safe-png.js';
import {validateChunkStrategy,requireSupportedChunkStrategy,requireSupportedClassifierMode,classifierCapabilities} from '../utils/feature-support.js';
import {FaultBackend} from './helpers/fake-backend.js';
const KEY='qdrant:openai:chat:with:colons';
const root=new URL('../',import.meta.url);
const source=(p)=>fs.readFileSync(new URL(p,root),'utf8');

test('P0-10 contract ledger is explicit, pinned-or-unknown and cannot self-certify',()=>{
  for(const backend of ['standard','qdrant','milvus','lancedb']){
    const fixture=JSON.parse(source(`tests/contracts/${backend}.json`));
    assert.equal(fixture.backend,backend);
    for(const [cap,value] of Object.entries(BACKEND_CAPABILITIES[backend])){
      assert.ok(['verified','unsupported','unknown'].includes(value));
      assert.equal(hasVerifiedCapability(backend,cap),value==='verified');
    }
    assert.equal(hasVerifiedCapability(backend,'purgeAcknowledgement'),false);
  }
});
test('P0-2 qualified identity with colons and invalid values',()=>{
  assert.deepEqual(parseCollectionKey(KEY),{backend:'qdrant',source:'openai',collectionId:'chat:with:colons'});
  assert.equal(formatCollectionKey(parseCollectionKey(KEY)),KEY);
  assert.equal(parseCollectionKey('unknown:openai:c'),null);
  assert.equal(parseCollectionKey('qdrant:invalid:c'),null);
  assert.throws(()=>formatCollectionKey({backend:'qdrant',source:'openai',collectionId:''}));
});
test('P0-2 ambiguity and legacy keys never guess ownership',()=>{
  const a='qdrant:openai:c',b='milvus:openai:c';
  assert.deepEqual(resolveCollectionKey('c',{registry:[a,b]}).status,'ambiguous');
  assert.equal(resolveCollectionKey('c',{registry:[a,b],backend:'qdrant'}).key,a);
  assert.equal(resolveCollectionKey('c',{registry:['c']} ).status,'none');
  assert.equal(resolveCollectionKey(a,{registry:[a,'qdrant:openai:c']} ).status,'unique');
  assert.equal(resolveCollectionKey('missing',{registry:[a,b]}).status,'none');
});
test('P0-1/P0-4 faults classify 200 false, 500, partial, no ACK, transport timeouts',()=>{
  const c={supported:true,countAcknowledgement:true};
  assert.equal(validateOperation({kind:'insert',sent:true,httpStatus:200,payload:{success:false},capabilities:c}).status,'uncertain');
  assert.equal(validateOperation({kind:'insert',sent:true,httpStatus:500,payload:{},capabilities:c}).status,'uncertain');
  assert.equal(validateOperation({kind:'delete',sent:true,httpStatus:200,payload:{deleted:2},expectedCount:3,capabilities:c}).status,'uncertain');
  assert.equal(validateOperation({kind:'delete',sent:true,httpStatus:200,payload:{success:true},capabilities:c}).status,'uncertain');
  assert.equal(validateOperation({kind:'delete',sent:true,httpStatus:200,payload:{deleted:3},expectedCount:3,capabilities:c}).status,'confirmed');
  assert.equal(validateOperation({kind:'delete',sent:true,httpStatus:200,payload:{deleted:3},expectedCount:3,capabilities:{supported:true}}).status,'uncertain');
  assert.equal(validateOperation({kind:'insert',sent:true,httpStatus:200,payload:{},capabilities:{supported:false}}).status,'unsupported');
  assert.equal(validateOperation({kind:'read',sent:true,httpStatus:200,payload:{results:[]},capabilities:{supported:true}}).status,'confirmed');
  assert.equal(validateOperation({kind:'read',sent:true,httpStatus:200,payload:{},capabilities:{supported:true}}).status,'failed');
  assert.equal(validateOperation({kind:'insert',sent:true,transportError:Error('lost'),capabilities:{supported:true}}).status,'uncertain');
  assert.throws(()=>requireConfirmedDeleteAck({status:'uncertain'}));
});
test('P0-12 operation IDs unique, terminal outcomes immutable, no secret keys in emitted events',()=>{
  clearOperationEvents();
  const a=beginOperation('insert',KEY),b=beginOperation('insert',KEY);
  assert.notEqual(a.operationId,b.operationId);
  assert.equal(settleOperation(a,{status:'uncertain',reason:'transport-after-send',authorization:'abcSECRET',expected:2}),'uncertain');
  assert.equal(settleOperation(a,{status:'confirmed',reason:'verified-success'}),'uncertain');
  assert.equal(canAuthorizeDestructiveFollowup(a),false);
  const log=JSON.stringify(getOperationEvents());assert.ok(!log.includes('abcSECRET'));
  assert.equal(getOperationEvents().at(-1).reason,'late-response');
});
test('P0-11 defaults conservative; snapshots do not mutate source registry',()=>{
  assert.equal(Object.values(phase0Flags).some(Boolean),false);
  assert.equal(isFeatureEnabled('imaginaryCapability',{imaginaryCapability:true}),false);
  const list=['standard:openai:x'];const snap=snapshotRegistryBeforeMigration(list);list.push('other');
  assert.deepEqual(snap.entries,['standard:openai:x']);
});
test('P0-9 same-key writes serialize; other keys progress independently',async()=>{
  const events=[];let release;
  const gate=new Promise(r=>release=r);
  const one=withCollectionLock(KEY,async()=>{events.push('start1');await gate;events.push('end1');});
  const two=withCollectionLock(KEY,async()=>{events.push('start2');});
  const other=withCollectionLock('standard:openai:different',async()=>{events.push('other');});
  await other;assert.deepEqual(events,['start1','other']);release();await Promise.all([one,two]);
  assert.deepEqual(events,['start1','other','end1','start2']);
});
test('P0-9 exceptions release locks and write barrier refuses unverified drains',async()=>{
  await assert.rejects(withCollectionLock(KEY,()=>{throw Error('failed');}),/failed/);
  await withCollectionLock(KEY,()=>{});
  const barrier=createWriteBarrier(),token=barrier.enter();
  let result=await barrier.closeAndDrain({timeoutMs:2});assert.equal(result.verified,false);
  assert.throws(()=>barrier.enter(),PurgeInProgress);
  barrier.leave(token,{uncertain:true});result=await barrier.closeAndDrain({timeoutMs:2});
  assert.equal(result.drained,true);assert.equal(result.verified,false);
  barrier.reopen();barrier.resetUncertainAfterReconciliation();
  assert.equal((await barrier.closeAndDrain({timeoutMs:2})).verified,true);
});
test('P0-5 set difference removes only obsolete IDs',()=>{
  const p=planReplacement([{hash:'1'},{hash:2}],[{hash:'2'},{hash:'3'}]);
  assert.deepEqual(p.toDelete,['1']);assert.deepEqual(p.newIds,['2','3']);
});
test('P0-1/P0-5 successful insert-readback-delete never removes retained IDs',async()=>{
  const fake=new FaultBackend();fake.seed(KEY,['old','retained']);
  const newItems=['retained','fresh'];
  const result=await applyVerifiedReplacement({key:KEY,oldItems:['old','retained'],newItems,
    insert:ids=>fake.insert(KEY,ids),verify:ids=>fake.verify(KEY,ids),remove:ids=>fake.remove(KEY,ids)});
  assert.equal(result.status,'confirmed');assert.deepEqual(result.deleted,['old']);
  assert.deepEqual(fake.ids(KEY),['fresh','retained']);
  assert.deepEqual(fake.history.map(x=>x.kind),['insert','verify','remove']);
});
for(const fault of ['commit-lost-ack','partial','ambiguous-200','reject']){
  test(`P0-1/P0-5 ${fault} insertion prevents deletion and preserves originals`,async()=>{
    const fake=new FaultBackend();fake.seed(KEY,['original']);fake.queueFault('insert',fault);
    const out=await applyVerifiedReplacement({key:KEY,oldItems:['original'],newItems:['new'],insert:ids=>fake.insert(KEY,ids),verify:ids=>fake.verify(KEY,ids),remove:ids=>fake.remove(KEY,ids)});
    assert.equal(out.status,'uncertain');assert.equal(out.requiresReconciliation,true);
    assert.ok(fake.ids(KEY).includes('original'));
    assert.ok(!fake.history.some(x=>x.kind==='remove'));
  });
}
for(const fault of ['throw','incomplete','cross-tenant']){
  test(`P0-1/P0-5 ${fault} readback prevents deletion`,async()=>{
    const fake=new FaultBackend();fake.seed(KEY,['original']);fake.queueFault('verify',fault);
    const out=await applyVerifiedReplacement({key:KEY,oldItems:['original'],newItems:['new'],insert:ids=>fake.insert(KEY,ids),verify:ids=>fake.verify(KEY,ids),remove:ids=>fake.remove(KEY,ids)});
    assert.equal(out.status,'uncertain');assert.ok(fake.ids(KEY).includes('original'));
    assert.ok(!fake.history.some(x=>x.kind==='remove'));
  });
}
test('P0-6 recursive report/export secrets and auth headers scrubbed',()=>{
  const output=JSON.stringify(redactSecrets({apiKey:'supersecret',nested:{authorization:'Bearer xxxsecret',url:'https://site?access_token=topsecret'},errors:['Bearer specialsecret']}));
  for(const s of ['supersecret','xxxsecret','topsecret','specialsecret'])assert.ok(!output.includes(s),s);
  assert.ok(output.includes('[REDACTED]'));
});
test('P0-7 unsupported runtime modes are rejected rather than silently downgraded',()=>{
  assert.equal(validateChunkStrategy('adaptive','chat',{kind:'live_chat'}).supported,false);
  assert.equal(validateChunkStrategy('adaptive','chat',{kind:'upload',uploaded:true}).supported,true);
  assert.equal(validateChunkStrategy('per_scene','chat',{uploaded:true}).supported,false);
  assert.throws(()=>requireSupportedChunkStrategy('adaptive','chat',{kind:'live_chat'}),/Unsupported/);
  assert.equal(requireSupportedClassifierMode({useEmbeddingSimilarity:true,source:'transformers'}),true);
  assert.throws(()=>requireSupportedClassifierMode({useEmbeddingSimilarity:true,source:'bananabread'}),/requires/);
  assert.equal(classifierCapabilities({source:'transformers'}).similaritySupported,true);
  assert.equal(classifierCapabilities({source:'bananabread'}).similaritySupported,false);
});
test('P0-8 quick wins have runtime/source regressions linked to each issue',()=>{
  const index=source('index.js'),conditional=source('core/conditional-activation.js'),
    qdrant=source('backends/qdrant.js'),milvus=source('backends/milvus.js'),lancedb=source('backends/lancedb.js');
  assert.match(index,/MESSAGE_SWIPED[^\n]*flagImmediateReverseSync/); // #106
  assert.match(conditional,/settings\.lookback/); // #80
  assert.match(conditional,/messageRoles/); // #73
  for(const backend of [qdrant,milvus,lancedb]) assert.match(backend,/hasVerifiedCapability\([\s\S]*?'tenantFilter'\)/); // #42
  assert.match(source('core/collection-export.js'),/redactSecrets/); // #118/#119
  assert.match(source('core/png-export.js'),/parseSafePng|readLimitedStream/); // #101
  assert.match(source('core/collection-ids.js'),/parseCollectionKey|resolveCollectionKey/); // #167/#18
  assert.match(source('core/content-vectorization.js'),/requireSupportedChunkStrategy/); // #47
  assert.match(source('core/emotion-classifier.js'),/requireSupportedClassifierMode/); // #120
});
test('P0-8 robust PNG input refuses invalid CRC and over-large source before allocation',async()=>{
  assert.throws(()=>parseSafePng(new Uint8Array(100)),/Invalid PNG signature/);
  assert.throws(()=>parseSafePng(new Uint8Array(MAX_PNG_BYTES+1)),/size/);
  const tooLong=new Uint8Array([137,80,78,71,13,10,26,10,255,255,255,255,73,68,65,84,0,0,0,0]);
  assert.throws(()=>parseSafePng(tooLong),/chunk length/);
  const stream=new ReadableStream({start(c){c.enqueue(new Uint8Array(5));c.close();}});
  await assert.rejects(readLimitedStream(stream,4),/safe limit/);
});

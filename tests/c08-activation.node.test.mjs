/** C08: WI identity context, rule depths, and post-receipt frequency accounting. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {normalizeWorldInfoEntry, normalizeWorldInfoEntries, activeWorldInfoMatches, createWorldInfoSnapshotStore} from '../utils/world-info-identity.js';
import {createFrequencyLedger, C08_FINAL_INCLUSION_RECEIPT_AVAILABLE} from '../utils/activation-frequency-ledger.js';
import {buildSearchContext, evaluateConditionRule, filterChunksByConditions} from '../core/conditional-activation.js';
import {getRequiredConditionDepth} from '../core/condition-rule-compat.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const src=name=>fs.readFileSync(path.join(root,name),'utf8');
function extracted(name,ctx={}) {
    const text=src('core/chat-vectorization.js');
    const m=text.match(new RegExp(`(?:async )?function ${name}\\(`));
    assert.ok(m,`function ${name} missing`);
    const start=m.index, end=text.indexOf('\n}\n',start);assert.ok(end>start);
    return vm.runInNewContext(`${text.slice(start,end+2)}\n${name}`,{console:{log(){},warn(){},debug(){}},...ctx});
}
const chat=Array.from({length:16},(_,i)=>({mes:i===4?'the elder dragon':`message ${i}`,is_user:i%2===0,name:i%2?'Bob':'Alice'}));
const active=[{world:'Fables',uid:0,key:['Dragon','Scale']},{world:'Creatures',uid:8,key:'Wolf'}];
const freqInput=(over={})=>({chatId:'chat-A',collectionKey:'standard:transformers:docs',recordId:'rec-1',turnId:'uid-001',messageCount:13,receipt:{status:'included',verified:true,recordIds:['rec-1']},...over});

test('C08 #135: WI event world and uid become one qualified lowercase id',()=>{
    assert.deepEqual(normalizeWorldInfoEntry({world:' Fables ',uid:0,key:['DRAGON','Scale']}),{world:'fables',uid:'0',id:'fables:0',key:['dragon','scale']});
});
test('C08 #135: missing world fails closed',()=>assert.equal(normalizeWorldInfoEntry({uid:0,key:'dragon'}),null));
test('C08 #135: missing uid fails closed',()=>assert.equal(normalizeWorldInfoEntry({world:'Fables',key:'dragon'}),null));
test('C08 #135: activated event arrays are unique and retain origin',()=>{
    assert.deepEqual(normalizeWorldInfoEntries([...active,active[0]]).map(e=>e.id),['fables:0','creatures:8']);
});
test('C08 #135: keyed WI map supports world.uid maps',()=>{
    const found=normalizeWorldInfoEntries(new Map([['Fables.0',{uid:0,key:['Dragon']}]]));
    assert.deepEqual(found.map(e=>e.id),['fables:0']);
});
test('C08 #135: nested activated payload accepted only if source is verifiable',()=>{
    assert.deepEqual(normalizeWorldInfoEntries({activatedEntries:[active[0]]}).map(e=>e.id),['fables:0']);
    assert.deepEqual(normalizeWorldInfoEntries({activatedEntries:[{uid:0}]}),[]);
});
test('C08 #142: world entry UID matches case-insensitively',()=>assert.equal(activeWorldInfoMatches('FABLES:0',active),true));
test('C08 #142: a world selection matches active entries from that world',()=>assert.equal(activeWorldInfoMatches('Fables',active),true));
test('C08 #142: a different world with same UID does not match',()=>assert.equal(activeWorldInfoMatches('Unrelated:0',active),false));
test('C08 #142: a keyword is not silently treated as an identity',()=>assert.equal(activeWorldInfoMatches('dragon',active),false));
test('C08 #142: legacy bare UID matches only when unique',()=>{
    assert.equal(activeWorldInfoMatches('0',active),true);
    assert.equal(activeWorldInfoMatches('0',[...active,{world:'Other',uid:0}]),false);
});
test('C08 #135: no previous WI scan is marked unavailable',()=>{
    const s=createWorldInfoSnapshotStore();assert.deepEqual(s.previous('chat-A'),{entries:[],source:'unavailable'});
});
test('C08 #135: empty observed WI list clears previous active entries',()=>{
    const s=createWorldInfoSnapshotStore();assert.equal(s.capture('A',active),true);
    assert.equal(s.capture('A',[]),true);assert.deepEqual(s.previous('A').entries,[]);
});
test('C08 #135: invalid event cannot poison prior WI snapshot',()=>{
    const s=createWorldInfoSnapshotStore();s.capture('A',active);
    assert.equal(s.capture('A',{uid:77}),false);assert.equal(s.previous('A').entries.length,2);
});
test('C08 #135: WI observations remain chat-scoped',()=>{
    const s=createWorldInfoSnapshotStore();s.capture('A',active);
    assert.equal(s.previous('A').entries.length,2);assert.equal(s.previous('B').entries.length,0);
    s.clear('A');assert.equal(s.previous('A').source,'unavailable');
});
test('C08 #73: role-filtered deep pattern uses matching role at same index',()=>{
    const ctx=buildSearchContext(chat,chat.length);
    assert.equal(ctx.messageRoles.length,ctx.recentMessages.length);
    assert.equal(evaluateConditionRule({type:'pattern',settings:{patterns:['elder dragon'],scanDepth:14,searchIn:'user'}},ctx),true);
    assert.equal(evaluateConditionRule({type:'pattern',settings:{patterns:['elder dragon'],scanDepth:14,searchIn:'assistant'}},ctx),false);
});
test('C08 #80: lookback applies to speaker rule even with long context',()=>{
    const ctx=buildSearchContext(chat,chat.length);
    assert.equal(evaluateConditionRule({type:'characterPresent',settings:{values:['Alice'],lookback:1}},ctx),false);
    assert.equal(evaluateConditionRule({type:'characterPresent',settings:{values:['Alice'],lookback:2}},ctx),true);
});
test('C08 #80: a numeric string lookback is handled exactly as an integer',()=>{
    const ctx=buildSearchContext(chat,chat.length);
    assert.equal(evaluateConditionRule({type:'speaker',settings:{values:['Alice'],lookback:'1'}},ctx),false);
    assert.equal(evaluateConditionRule({type:'speaker',settings:{values:['Alice'],lookback:'2'}},ctx),true);
});
test('C08 #141: deep condition required depth independent from query depth',()=>{
    assert.equal(getRequiredConditionDepth({enabled:true,rules:[{type:'characterPresent',settings:{lookback:42}}]},2),42);
    assert.equal(buildSearchContext(chat,16).recentMessages.length,16);
});
test('C08 #135: matching WI context satisfies a lorebook rule',()=>{
    const ctx=buildSearchContext(chat,2,[],{activeLorebookEntries:active});
    assert.equal(evaluateConditionRule({type:'lorebookActive',settings:{values:['fables:0']}},ctx),true);
    assert.equal(evaluateConditionRule({type:'lorebookActive',settings:{values:['fables:9']}},ctx),false);
});
test('C08 #135: no observed scan cannot satisfy a negated WI rule',()=>{
    const context=buildSearchContext(chat,2);
    assert.equal(context.activeLorebookSource,'unavailable');
    assert.equal(evaluateConditionRule({type:'lorebookActive',negate:true,settings:{values:['fables:0']}},context),false);
});
test('C08 #135: a verified empty WI scan allows an inactive check',()=>{
    const context=buildSearchContext(chat,2,[],{activeLorebookEntries:[],activeLorebookSource:'previous-observed-scan'});
    assert.equal(evaluateConditionRule({type:'lorebookActive',negate:true,settings:{values:['fables:0']}},context),true);
});
test('C08 #135: unverified WI objects do not become active',()=>{
    const ctx=buildSearchContext(chat,2,[],{activeLorebookEntries:[{key:'dragon',uid:0}]});
    assert.deepEqual(ctx.activeLorebookEntries,[]);
    assert.equal(ctx.activeLorebookSource,'unverified');
});
test('C08 #88: a candidate filtered by condition does not consume frequency',()=>{
    const ledger=createFrequencyLedger();assert.equal(ledger.snapshot(freqInput())['rec-1'],undefined);
});
test('C08 #88: an unknown final receipt is unverified, not counted',()=>{
    const ledger=createFrequencyLedger();const r=ledger.recordActivation(freqInput({receipt:{status:'unknown'}}));
    assert.equal(r.status,'unverified');assert.equal(ledger.pendingCount(),1);
    assert.equal(ledger.snapshot(freqInput())['rec-1'],undefined);
});
test('C08 #88: extension prompt registration is not proof of final inclusion',()=>{
    const ledger=createFrequencyLedger();assert.equal(ledger.recordActivation(freqInput({receipt:{status:'registered',verified:true,recordIds:['rec-1']}})).status,'unverified');
});
test('C08 #88: dry runs do not consume slots even with confirmed receipt',()=>{
    const ledger=createFrequencyLedger();assert.equal(ledger.recordActivation(freqInput({dryRun:true})).status,'dry-run');
    assert.equal(ledger.snapshot(freqInput())['rec-1'],undefined);
});
test('C08 #88: a valid final receipt records exactly once',()=>{
    const ledger=createFrequencyLedger();assert.equal(ledger.recordActivation(freqInput()).status,'recorded');
    assert.equal(ledger.recordActivation(freqInput()).status,'duplicate');
    assert.equal(ledger.snapshot(freqInput())['rec-1'].count,1);
});
test('C08 #88: regeneration and swipe on same user-turn do not spend another slot',()=>{
    const ledger=createFrequencyLedger();ledger.recordActivation(freqInput());
    for(const mode of ['swipe','regenerate','continue']) {
        assert.equal(ledger.recordActivation(freqInput({generationType:mode,jobId:`job-${mode}`})).status,'duplicate');
    }
    assert.equal(ledger.snapshot(freqInput())['rec-1'].count,1);
});
test('C08 #88: a later unknown receipt cannot downgrade a confirmed turn',()=>{
    const ledger=createFrequencyLedger();ledger.recordActivation(freqInput());
    assert.equal(ledger.recordActivation(freqInput({receipt:{status:'unknown'}})).status,'duplicate');
    assert.equal(ledger.pendingCount(),0);
    assert.equal(ledger.snapshot(freqInput())['rec-1'].count,1);
});
test('C08 #88: new user turn increments count and updates cooldown anchor',()=>{
    const ledger=createFrequencyLedger();ledger.recordActivation(freqInput());
    ledger.recordActivation(freqInput({turnId:'uid-002',messageCount:19}));
    assert.deepEqual(ledger.snapshot(freqInput())['rec-1'],{count:2,lastActivation:19});
});
test('C08 #88: wrong record ID in receipt is not proof',()=>{
    const ledger=createFrequencyLedger();assert.equal(ledger.recordActivation(freqInput({receipt:{status:'included',verified:true,recordIds:['rec-X']}})).status,'unverified');
});
test('C08 #88: receipt without verification cannot spend frequency',()=>{
    const ledger=createFrequencyLedger();assert.equal(ledger.recordActivation(freqInput({receipt:{status:'included',verified:false,recordIds:['rec-1']}})).status,'unverified');
});
test('C08 #88: chat, collection and record keys isolate frequencies',()=>{
    const ledger=createFrequencyLedger();ledger.recordActivation(freqInput());
    assert.equal(ledger.snapshot(freqInput({chatId:'chat-B'}))['rec-1'],undefined);
    assert.equal(ledger.snapshot(freqInput({collectionKey:'qdrant:s:docs'}))['rec-1'],undefined);
    assert.equal(ledger.snapshot(freqInput())['rec-2'],undefined);
});
test('C08 #88: conversation and session counters are independent',()=>{
    const ledger=createFrequencyLedger();ledger.recordActivation(freqInput({scope:'conversation'}));
    assert.equal(ledger.snapshot(freqInput({scope:'session'}))['rec-1'],undefined);
    ledger.recordActivation(freqInput({scope:'session'}));
    assert.equal(ledger.snapshot(freqInput({scope:'session'}))['rec-1'].count,1);
});
test('C08 #88: session reset cannot clear conversation history',()=>{
    const ledger=createFrequencyLedger();ledger.recordActivation(freqInput());ledger.recordActivation(freqInput({scope:'session'}));
    ledger.clearSession();assert.equal(ledger.snapshot(freqInput())['rec-1'].count,1);
    assert.equal(ledger.snapshot(freqInput({scope:'session'}))['rec-1'],undefined);
});
test('C08 #88: invalid identities never create a counter',()=>{
    const ledger=createFrequencyLedger();assert.equal(ledger.recordActivation(freqInput({collectionKey:null})).status,'invalid');
    assert.equal(ledger.recordActivation(freqInput({turnId:null})).status,'invalid');
});
test('C08 #88: pending receipt can reconcile without duplicate count',()=>{
    const ledger=createFrequencyLedger();ledger.recordActivation(freqInput({receipt:{status:'unknown'}}));
    assert.equal(ledger.recordActivation(freqInput()).status,'recorded');
    assert.equal(ledger.pendingCount(),0);
});
test('C08 #88: confirmed history enforces a maximum activation',()=>{
    const ledger=createFrequencyLedger();ledger.recordActivation(freqInput());
    const context=buildSearchContext(chat,16,[],{activationHistory:ledger.snapshot(freqInput())});
    assert.equal(evaluateConditionRule({type:'frequency',settings:{maxActivations:1}}, {...context,currentChunkHash:'rec-1'}),false);
});
test('C08 #88: confirmed history enforces cooldown',()=>{
    const ledger=createFrequencyLedger();ledger.recordActivation(freqInput({messageCount:15}));
    const context=buildSearchContext(chat,16,[],{activationHistory:ledger.snapshot(freqInput())});
    assert.equal(evaluateConditionRule({type:'frequency',settings:{maxActivations:5,cooldownMessages:3}}, {...context,currentChunkHash:'rec-1'}),false);
});
test('C08 #88: frequency-conditioned live candidates are gated until C10 receipt',async()=>{
    assert.equal(C08_FINAL_INCLUSION_RECEIPT_AVAILABLE,false);
    const condition={enabled:true,rules:[{type:'frequency',settings:{maxActivations:1}}]};
    const make=extracted('applyChunkConditions',{
        filterSceneDisabledChunks:items=>items,
        getChunkMetadata:()=>({conditions:condition}),
        buildSearchContext, getRequiredConditionDepth, filterChunksByConditions,
        worldInfoSnapshots:{previous:()=>({entries:[]})},chatIdForActivation:()=> 'chat-A',
        collectionKeyForFrequency:()=> 'standard:transformers:docs',
        activationFrequencyLedger:createFrequencyLedger(),C08_FINAL_INCLUSION_RECEIPT_AVAILABLE,
    });
    const result=await make([{hash:'rec-1',score:1}],chat,{query:2});
    assert.equal(result.length,0);
});
test('C08 #88: no frequency rules still allow normal chunk conditions',async()=>{
    const condition={enabled:true,rules:[{type:'pattern',settings:{patterns:['elder dragon'],scanDepth:14}}]};
    const make=extracted('applyChunkConditions',{
        filterSceneDisabledChunks:items=>items, getChunkMetadata:()=>({conditions:condition}),
        buildSearchContext,getRequiredConditionDepth,filterChunksByConditions,
        worldInfoSnapshots:{previous:()=>({entries:[]})},chatIdForActivation:()=> 'chat-A',
        collectionKeyForFrequency:()=> 'standard:transformers:docs',
        activationFrequencyLedger:createFrequencyLedger(),C08_FINAL_INCLUSION_RECEIPT_AVAILABLE,
    });
    const result=await make([{hash:'rec-1',score:1}],chat,{query:2});
    assert.equal(result.length,1);
});
test('C08 integration: collection and chunk paths both receive the WI snapshot',()=>{
    const source=src('core/chat-vectorization.js');
    assert.match(source,/activeLorebookEntries: worldInfoSnapshots\.previous\(chatIdForActivation\(\)\)\.entries/);
    assert.doesNotMatch(source,/settings\.activeLorebookEntries \|\|/,'unverified UI settings cannot spoof host WI activations');
    assert.match(src('index.js'),/onVhEvent\(event_types\.WORLD_INFO_ACTIVATED/);
});
test('C08 integration: old condition-stage accounting removed and post-injection path exists',()=>{
    const source=src('core/chat-vectorization.js');
    assert.doesNotMatch(source,/scopedActivationHistory\.record\(/);
    assert.match(source,/const injection = injectChunksIntoPrompt\(chunksToInject, settings, debugData\);[\s\S]*?activationFrequencyLedger\.recordActivation\(/);
});

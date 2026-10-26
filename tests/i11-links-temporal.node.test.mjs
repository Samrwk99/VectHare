/** I11: explicit/group links, configured soft boosts and live nostalgia dispatch. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { expandInclusiveGroups, mergeVirtualLinks, processChunkGroups } from '../core/chunk-groups.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = name => fs.readFileSync(path.join(root, name), 'utf8');
const quiet = { log() {}, warn() {}, error() {}, debug() {} };
function extractFunction(filename, name, scope = {}) {
    const text = source(filename);
    const start = text.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `Missing ${name}`);
    const end = text.indexOf('\n}\n', start);
    assert.ok(end > start, `No closing brace for ${name}`);
    return vm.runInNewContext(`${text.slice(start, end + 2).replace(/^export /, '')}\n${name}`, { console: quiet, ...scope });
}
const processChunkLinks = extractFunction('core/conditional-activation.js', 'processChunkLinks');
const chunks = () => [{hash: 10, score: 0.35}, {hash: 20, score: 0.4}, {hash: '00030', score: 0.2}];

test('#72 visualizer chunkLinks/targetHash + force/soft works with a Map', () => {
    const metadata = new Map([['10', { chunkLinks: [
        {targetHash: '20', mode: 'soft'},
        {targetHash: '00030', mode: 'force'}
    ]}]]);
    const result = processChunkLinks(chunks(), metadata, 0.2);
    assert.ok(Math.abs(result.chunks[1].score - 0.6) < 1e-9);
    assert.equal(result.chunks[1].softLinked, true);
    assert.deepEqual(Array.from(result.hardLinkedHashes), ['00030']);
    assert.deepEqual(Array.from(result.missingHardLinks), []);
});

test('#72 legacy links/target + hard/soft works with plain metadata object and string ids', () => {
    const meta = {10: { links: [{target: '00030', type: 'soft'}, {target: 'absent', type: 'hard'}]}};
    const result = processChunkLinks(chunks(), meta, 0.1);
    assert.ok(Math.abs(result.chunks[2].score - 0.3) < 1e-9);
    assert.deepEqual(Array.from(result.missingHardLinks), ['absent']);
});

test('#72 explicit links are reachable in both collection-group branches', () => {
    const src = source('core/chat-vectorization.js');
    const stage = src.slice(src.indexOf('async function applyGroupsAndLinksStage('), src.indexOf('\n/**', src.indexOf('async function applyGroupsAndLinksStage(')));
    assert.match(stage, /meta\.chunkLinks && meta\.chunkLinks\.length > 0/);
    assert.ok((stage.match(/meta\.chunkLinks && meta\.chunkLinks\.length > 0/g) ?? []).length >= 2);
});

test('#72 a legacy mirror under links and chunkLinks is applied only once', () => {
    const meta = new Map([['10', {links: [{target: '20', type: 'soft'}], chunkLinks: [{targetHash:'20',mode:'soft'}]}]]);
    const result = processChunkLinks(chunks(), meta, 0.2);
    assert.ok(Math.abs(result.chunks[1].score - 0.6) < 1e-9);
});

test('#134 inclusive group carries configured soft boost through merging and scoring', () => {
    const group = {id:'group1', name:'friends', mode:'inclusive', linkType:'soft', boost:0.4, members:['10','20']};
    const result = processChunkGroups([chunks()[0]], [group], new Map(), {softBoost:0.15});
    const links = mergeVirtualLinks(new Map(), result.virtualLinks);
    assert.equal(links.get('10').links[0].boost, 0.4);
    const scored = processChunkLinks(chunks(), links, 0.15);
    assert.equal(scored.chunks.find(c=>String(c.hash)==='20').score, 0.8);
});

test('#134 zero boost is valid; unset boost falls back to configured default', () => {
    const matches = new Set(['10']);
    const zero = expandInclusiveGroups([{id:'zero',mode:'inclusive',boost:0,linkType:'soft',members:['10','20']}], matches, 0.35);
    assert.equal(zero.get('10')[0].boost, 0);
    assert.equal(processChunkLinks(chunks(), mergeVirtualLinks(new Map(),zero),0.35).chunks[1].score, 0.4);
    const unset = expandInclusiveGroups([{id:'unset',mode:'inclusive',linkType:'soft',members:['10','20']}], matches, 0.35);
    assert.equal(unset.get('10')[0].boost, 0.35);
    const ui = source('ui/chunk-visualizer.js');
    assert.match(ui, /group\.boost \?\? 0\.15/);
    assert.doesNotMatch(ui, /parseFloat\(\$\(this\)\.val\(\)\) \|\| 0\.15/);
});

async function temporalRuntime() {
    const context = vm.createContext({console:quiet});
    const mod = new vm.SourceTextModule(source('core/temporal-decay.js'), {context});
    await mod.link(async spec => {
        const stubs = spec === './collection-metadata.js'
            ? {isChunkTemporallyBlind: () => false}
            : spec === './constants.js'
                ? {DEFAULT_DECAY_HALF_LIFE:50, DEFAULT_DECAY_FLOOR:0.3, DEFAULT_NOSTALGIA_MAX_BOOST:1.2}
                : null;
        assert.ok(stubs, `Unexpected temporal dependency ${spec}`);
        return new vm.SyntheticModule(Object.keys(stubs), function() {
            for(const [key,value] of Object.entries(stubs)) this.setExport(key,value);
        }, {context});
    });
    await mod.evaluate();
    return mod.namespace;
}

function temporalStage(temporal, traces) {
    return extractFunction('core/chat-vectorization.js','applyTemporalDecayStage', {
        applyDecayToResults: temporal.applyDecayToResults,
        applyNostalgiaToResults: temporal.applyNostalgiaToResults,
        applySceneAwareDecay: temporal.applySceneAwareDecay,
        addTrace: (...args) => traces.push(args),
        recordChunkFate: () => {}
    });
}

test('#229 live nostalgia boosts older messages, not decays; respects non-chat chunks', async () => {
    const temporal = await temporalRuntime();
    const traces = [];
    const stage = temporalStage(temporal, traces);
    const input = [
        {hash:1, score:0.5, metadata:{source:'chat',messageId:0}},
        {hash:2, score:0.5, metadata:{source:'chat',messageId:20}},
        {hash:3, score:0.5, metadata:{source:'document',messageId:0}}
    ];
    const chat = Array.from({length:21}, () => ({}));
    const settings = {temporal_decay:{enabled:true,type:'nostalgia',mode:'exponential',halfLife:10,maxBoost:1.8,sceneAware:true}};
    const result = stage(input,chat,settings,0,traces);
    assert.ok(result[0].score > 0.5, 'older message should gain relevance');
    assert.equal(result[0].nostalgiaApplied,true);
    assert.equal(result[0].decayApplied,false);
    assert.equal(result[1].score,0.5,'latest message unchanged');
    assert.equal(result[2].score,0.5,'non-chat record unchanged');
    assert.ok(traces.some(row => row[3]?.decayType === 'nostalgia'));
});

test('#229 standard decay still reduces older scores and preserves threshold filtering', async () => {
    const temporal = await temporalRuntime();
    const stage = temporalStage(temporal,[]);
    const input = [{hash:1,score:0.5,metadata:{source:'chat',messageId:0}}, {hash:2,score:0.5,metadata:{source:'chat',messageId:20}}];
    const chat = Array.from({length:21}, () => ({}));
    const settings = {temporal_decay:{enabled:true,type:'decay',mode:'exponential',halfLife:10,minRelevance:0.1}};
    const result = stage(input,chat,settings,0.25,{});
    assert.equal(result.length,1);
    assert.equal(result[0].hash,2);
    assert.equal(result[0].score,0.5);
});

/** I06: activation rule compatibility, filtering, and context regression tests. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { normalizeConditionRule, getRequiredConditionDepth, EVALUATED_CONDITION_TYPES } from '../core/condition-rule-compat.js';
import { buildSearchContext, evaluateConditionRule, filterChunksByConditions, validateConditionRule } from '../core/conditional-activation.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = file => fs.readFileSync(path.join(root, file), 'utf8');
const quiet = { log() {}, warn() {}, debug() {}, error() {} };
function getFunction(filename, name, context) {
    const text = src(filename);
    const start = text.indexOf(`function ${name}(`) >= 0 ? text.indexOf(`function ${name}(`) : text.indexOf(`async function ${name}(`);
    assert.ok(start >= 0, `missing ${name}`);
    const end = text.indexOf('\n}\n', start);
    assert.ok(end > start, `missing end of ${name}`);
    return vm.runInNewContext(`${text.slice(start, end + 2)}\n${name}`, { console: quiet, ...context });
}
const rule = (type, value, overrides={}) => ({type, settings:{value}, ...overrides});
const basic = buildSearchContext([{mes:'something',name:'User',is_user:true}], 1);

test('#132: legacy visualizer patterns/speakers/emotions produce evaluated typed settings', () => {
    assert.deepEqual(normalizeConditionRule(rule('pattern', 'dragon,castle')).settings.patterns, ['dragon','castle']);
    assert.equal(evaluateConditionRule(rule('pattern', 'dragon'), {...basic,recentMessages:['A dragon appears']}),true);
    assert.equal(evaluateConditionRule(rule('pattern', 'dragon'), {...basic,recentMessages:['No animal']}),false);
    assert.equal(evaluateConditionRule(rule('speaker', 'Alice'), {...basic,lastSpeaker:'Alice'}),true);
    assert.equal(evaluateConditionRule(rule('emotion','joy'), {...basic,recentMessages:['I am happy']}), true);
    assert.equal(evaluateConditionRule(rule('messageCount','>=12'), {...basic,messageCount:12}), true);
    assert.equal(evaluateConditionRule(rule('messageCount','<12'), {...basic,messageCount:12}), false);
    assert.equal(evaluateConditionRule(rule('randomChance','0'), basic), false);
    assert.equal(evaluateConditionRule(rule('randomChance','100'), basic), true);
    assert.equal(evaluateConditionRule(rule('isGroupChat','true'), {...basic,isGroupChat:true}), true);
    assert.ok(src('ui/chunk-visualizer.js').includes('normalizeConditionRule({'));
    assert.ok(src('ui/chunk-visualizer.js').includes('validateConditionRule(rule)'));
});

test('#133: canonical negate and legacy negated both affect evaluation, never mutate stored rule', () => {
    const legacy = rule('pattern', 'alpha', {negated: true});
    assert.equal(evaluateConditionRule(legacy, {...basic,recentMessages:['beta']}), true);
    assert.equal(evaluateConditionRule(legacy, {...basic,recentMessages:['alpha']}), false);
    assert.equal(legacy.negate, undefined);
    assert.equal(evaluateConditionRule(rule('pattern', 'alpha', {negate: true}), {...basic,recentMessages:['alpha']}), false);
    assert.ok(src('ui/chunk-visualizer.js').includes('negate: negated'));
});

test('#226: no accepted-but-unimplemented types; NOT cannot turn unsupported into a match', () => {
    for (const type of ['similarity','dependency','chunkActive','links','totallyUnknown']) {
        const unsupported = {type,value:'123',negate:true};
        assert.equal(validateConditionRule(unsupported).valid,false, type);
        assert.equal(evaluateConditionRule(unsupported, basic),false,type);
    }
    for (const type of EVALUATED_CONDITION_TYPES) {
        assert.equal(validateConditionRule({type,value:'1'}).errors.some(x=>x.includes('Unsupported')),false,type);
    }
});

test('#230: legacy timeOfDay ranges use actual start/end with midnight crossover', () => {
    const at = iso => ({...basic,timestamp: new Date(iso)});
    const day = rule('timeOfDay','09:00-17:00');
    assert.equal(evaluateConditionRule(day,at('2026-01-02T10:30:00')),true);
    assert.equal(evaluateConditionRule(day,at('2026-01-02T18:30:00')),false);
    const overnight = rule('timeOfDay','22:00-02:00');
    assert.equal(evaluateConditionRule(overnight,at('2026-01-02T23:30:00')),true);
    assert.equal(evaluateConditionRule(overnight,at('2026-01-03T01:30:00')),true);
    assert.equal(evaluateConditionRule(overnight,at('2026-01-03T15:00:00')),false);
    assert.equal(evaluateConditionRule(rule('timeOfDay','bad'),at('2026-01-02T12:00:00')),false);
    assert.equal(validateConditionRule(rule('timeOfDay','bad')).valid,false);
});

test('#231: character-present is exact, trimmed, case-insensitive, any and all', () => {
    const ctx = {...basic,messageSpeakers:['Annabelle',' BOB ']};
    assert.equal(evaluateConditionRule({type:'characterPresent',settings:{values:['Ann']}},ctx),false);
    assert.equal(evaluateConditionRule({type:'characterPresent',settings:{values:['bob']}},ctx),true);
    assert.equal(evaluateConditionRule({type:'characterPresent',settings:{values:['bob','annabelle'],matchType:'all'}},ctx),true);
    assert.equal(evaluateConditionRule({type:'characterPresent',settings:{values:['bob','ann'],matchType:'all'}},ctx),false);
});

test('#232: array-form lorebook keys and UID zero work in any/all without throwing', () => {
    const context = {...basic,activeLorebookEntries:[{key:['Dragons','Flame'],uid:0},{key:'Water',uid:42}]};
    for (const value of ['dragon','flame','0','water','42']) {
        assert.equal(evaluateConditionRule(rule('lorebookActive',value),context),true,value);
    }
    assert.equal(evaluateConditionRule({type:'lorebookActive',settings:{values:['0','water'],matchType:'all'}},context),true);
    assert.equal(evaluateConditionRule({type:'lorebookActive',settings:{values:['0','missing'],matchType:'all'}},context),false);
    assert.equal(evaluateConditionRule(rule('lorebookActive','0'), {...basic,activeLorebookEntries:[{key:[],uid:null}]}),false);
});

test('#141: required scan depths include triggers, collection and chunk rules independently of query depth', () => {
    const conditions = {enabled:true,rules:[{type:'pattern',settings:{patterns:['old'],scanDepth:55}}]};
    assert.equal(getRequiredConditionDepth(conditions,2),55);
    assert.equal(getRequiredConditionDepth({enabled:false,rules:conditions.rules},2),2);
    const text=src('core/chat-vectorization.js');
    assert.match(text,/collectionsToQuery\.reduce\(\(depth, id\)/);
    assert.match(text,/getRequiredConditionDepth\(meta\?\.conditions\)/);
    assert.match(text,/getRequiredConditionDepth\(c\.conditions, depth\)/);
    const make = getFunction('core/chat-vectorization.js','applyChunkConditions',{
        filterSceneDisabledChunks: items=>items, getChunkMetadata: ()=>({conditions}), buildSearchContext,
        filterChunksByConditions, getRequiredConditionDepth, currentChatIdentity:()=>({chatId:"chat-A"}),
        scopedActivationHistory:{snapshot:()=>({}),record:()=>true}, trackChunkActivation:()=>{}, window:{VectHare_ActivationHistory:{}},
    });
    const chat=Array.from({length:60},(_,i)=>({mes:i===8?'old memory':'other text',is_user:true}));
    const result = make([{hash:1,score:1}],chat,{query:2});
    assert.equal(result.length,1,'pattern looks 55 messages back despite query=2');
});

test('#225: only-selected lorebook policy cannot discard chat and document collections', () => {
    let checked;
    const gather = getFunction('core/chat-vectorization.js','gatherCollectionsToQuery', {
        getChatCollectionId:()=> 'chat-1', getCurrentChatId:()=> 'chat-1', getChatCollectionPolicy:()=>({selectedCollections:['lorebook-picked']}),
        isCollectionEnabled:()=>true,getCollectionRegistry:()=>['document-1','lorebook-picked','lorebook-other'],
        parseRegistryKey:key=>({collectionId:key}),
        applyChatCollectionPolicy:(ids,_,options)=>{
            checked=options;
            return ids.filter(id=> !id.includes('lorebook') || id==='lorebook-picked');
        },
    });
    const ids=gather({});
    assert.equal(checked.lorebooksOnly,true);
    assert.deepEqual(Array.from(ids),['chat-1','document-1','lorebook-picked']);
});

test('#136 #143 #144: stage uses real generation type, group flag and character, chunk evaluator uses them', async () => {
    const text=src('core/chat-vectorization.js');
    assert.match(text,/applyConditionsStage\(chunks, chat, \{[\s\S]*?generationType: type \|\| 'normal',[\s\S]*?isGroupChat: getContext\(\)\.groupId != null,[\s\S]*?currentCharacter: getContext\(\)\.name2/);
    let observed;
    const make = getFunction('core/chat-vectorization.js','applyChunkConditions',{
        filterSceneDisabledChunks: items=>items,
        getChunkMetadata: hash=> ({conditions: {
            enabled:true, logic:'AND', rules:[
                {type:'generationType',settings:{values:['swipe']}},
                {type:'isGroupChat',settings:{isGroup:true}},
            ]}}),
        buildSearchContext:(chat,depth,items,metadata)=>{observed=metadata;return buildSearchContext(chat,depth,items,metadata);},
        filterChunksByConditions,getRequiredConditionDepth,currentChatIdentity:()=>({chatId:"chat-A"}),
        scopedActivationHistory:{snapshot:()=>({}),record:()=>true},trackChunkActivation:()=>{},window:{VectHare_ActivationHistory:{}},
    });
    const chunks=await make([{hash:1,score:0.8}],[{mes:'Hello',name:'Alice'}],{
        generationType:'swipe',isGroupChat:true,currentCharacter:'Alice',query:2,
    });
    assert.equal(chunks.length,1);
    assert.equal(observed.currentCharacter,'Alice');
    assert.equal(observed.generationType,'swipe');
    assert.equal(observed.isGroupChat,true);
    assert.equal(evaluateConditionRule({type:'generationType',settings:{values:['swipe']}}, {...basic,generationType:'normal'}),false);
    assert.equal(evaluateConditionRule({type:'isGroupChat',settings:{isGroup:true}}, {...basic,isGroupChat:false}),false);
});

test('#141 role-filtered pattern evaluates properly aligned messages', () => {
    const chat=[{mes:'secret dragon',is_user:false},{mes:'nothing',is_user:true},{mes:'dragon user',is_user:true}];
    const context=buildSearchContext(chat,3);
    assert.deepEqual(context.messageRoles,['assistant','user','user']);
    assert.equal(evaluateConditionRule({type:'pattern',settings:{patterns:['dragon'],searchIn:'user',scanDepth:2}},context),true);
    assert.equal(evaluateConditionRule({type:'pattern',settings:{patterns:['secret'],searchIn:'user',scanDepth:3}},context),false);
});

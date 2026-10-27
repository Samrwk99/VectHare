/** I12 content vectorization controls and preparation regressions. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { getContentTypeDefaults } from '../core/content-types.js';
import { chunkText } from '../core/chunking.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=file=>fs.readFileSync(path.join(root,file),'utf8');
const ui=source('ui/content-vectorizer.js');
const core=source('core/content-vectorization.js');
const quiet={log(){},warn(){},error(){},debug(){}};
function extract(text,name,scope={}) {
    const re=new RegExp(`(?:async )?function ${name}\\(`);
    const match=re.exec(text);
    assert.ok(match,`missing ${name}`);
    const start=match.index;
    const end=text.indexOf('\n}\n',start);
    assert.ok(end>=start,`missing end of ${name}`);
    return vm.runInNewContext(`${text.slice(start,end+2)}\n${name}`,{console:quiet,...scope});
}
const cleanText=(text)=>text;
const defaults=()=>getContentTypeDefaults('character');
const character=extract(core,'prepareCharacterContent',{cleanText,getContentTypeDefaults:defaults});
const lorebook=extract(core,'prepareLorebookContent',{cleanText});
const json=v=>JSON.parse(JSON.stringify(v));

test('#149: switching content type rejects stale uploaded source and clear resets cached source',()=>{
    const src=ui.slice(ui.indexOf('function getSourceData()'),ui.indexOf('/**\n * Starts the vectorization process',ui.indexOf('function getSourceData()')));
    const ctx=vm.createContext({console:quiet,$:()=>({val:()=>null,data:()=>undefined}),getContentType:id=>({id}),getContext:()=>({})});
    vm.runInContext(`let currentContentType='character'; let sourceData={__contentType:'lorebook',type:'file',content:'wrong'}; ${src} this.readSource=getSourceData; this.changeType=id=>{currentContentType=id;};`,ctx);
    assert.equal(ctx.readSource(),null);
    ctx.changeType('lorebook');
    assert.equal(ctx.readSource()?.content,'wrong');
    assert.match(ui,/clearSelectedSource\(\);\s*currentContentType = type/);
    assert.match(ui,/sourceRevision !== sourceRevision|revision !== sourceRevision/);
});

test('#150: selected character field switches change actual preparation',()=>{
    const raw={character:{description:'about',personality:'kind',scenario:'cafe',first_mes:'hello'}};
    const selection={...defaults().fields,description:false,personality:true,scenario:false,first_mes:true};
    const prepared=character(raw,{strategy:'per_field',fields:selection});
    assert.deepEqual(json(prepared.text),{'Personality':'kind','First Message':'hello'});
    const combined=character(raw,{strategy:'paragraph',fields:selection}).text;
    assert.match(combined,/kind/); assert.match(combined,/hello/);
    assert.doesNotMatch(combined,/about|cafe/);
    assert.match(ui,/currentSettings\.fields\[\$\(this\)\.val\(\)\] = \$\(this\)\.prop\('checked'\)/);
});

test('#151: disabled lorebook entries excluded unless checkbox explicitly enabled',()=>{
    const data={entries:[{content:'visible',disable:false},{content:'hidden',disable:true},{content:'also',disable:false}]};
    const settings={strategy:'per_entry',cleaningPreset:'none'};
    assert.deepEqual(json(lorebook(data,settings).text),['visible','also']);
    assert.deepEqual(json(lorebook(data,{...settings,includeDisabled:true}).text),['visible','hidden','also']);
    assert.match(ui,/currentSettings\.includeDisabled = \$\(this\)\.prop\('checked'\)/);
});

test('#157: editing nested settings does not mutate other defaults or sessions',()=>{
    const first=getContentTypeDefaults('character');
    const second=getContentTypeDefaults('character');
    first.fields.description=false;
    assert.equal(second.fields.description,true);
    const chat1=getContentTypeDefaults('chat');
    const chat2=getContentTypeDefaults('chat');
    chat1.temporalDecay.halfLife=999;
    assert.equal(chat2.temporalDecay.halfLife,50);
    assert.equal(getContentTypeDefaults('chat').temporalDecay.halfLife,50);
});

test('#153: message-batch chunking honors job-specific batch size',async()=>{
    const messages=Array.from({length:5},(_,i)=>({text:`msg${i}`,is_user:i%2===0,index:i}));
    const two=await chunkText(messages,{strategy:'message_batch',batchSize:2});
    const three=await chunkText(messages,{strategy:'message_batch',batchSize:3});
    assert.equal(two.length,3);assert.equal(three.length,2);
    assert.deepEqual(two.map(c=>c.metadata.batchSize),[2,2,1]);
    assert.deepEqual(three.map(c=>c.metadata.batchSize),[3,2]);
    assert.match(ui,/id="vecthare_cv_batch_size"/);
    assert.equal((ui.match(/batchSize: currentSettings\.batchSize \?\? type\.defaults\.batchSize \?\? 4/g)??[]).length,1);
    assert.match(core,/batchSize: settings\.batchSize \?\? type\.defaults\.batchSize \?\? 4/);
});

test('#116: retired protect is no longer a default and old saved value is removed',()=>{
    const index=source('index.js');
    assert.doesNotMatch(index,/^\s*protect:\s*\d+/m);
    assert.match(index,/delete settings\.protect/);
    assert.match(index,/delete extension_settings\.vecthare\.protect/);
    assert.match(index,/deduplication_depth: 50/);
});

let cleanerPromise;
async function loadCleaner() {
    if(cleanerPromise)return cleanerPromise;
    cleanerPromise=(async()=>{
        const context=vm.createContext({console:quiet});
        const state={vecthare:{cleaning:{selectedPreset:'nuclear',customPatterns:[],enabledBuiltins:[]}}};
        const mod=new vm.SourceTextModule(source('core/text-cleaning.js'),{context});
        await mod.link(async spec=>{
            const exports=spec==='../../../../extensions.js'?{extension_settings:state}:spec==='../../../../utils.js'?{uuidv4:()=> 'fixed'}:null;
            assert.ok(exports,`unexpected import ${spec}`);
            return new vm.SyntheticModule(Object.keys(exports),function(){for(const [name,value] of Object.entries(exports))this.setExport(name,value);},{context});
        });
        await mod.evaluate();
        return {api:mod.namespace,state};
    })();
    return cleanerPromise;
}

test('#152: job cleaning preset overrides global preset without mutating saved global selection',async()=>{
    const {api,state}=await loadCleaner();
    const text='<b>bold</b> <thinking>secret</thinking>';
    assert.equal(api.cleanText(text,'none'),text);
    assert.equal(api.cleanText(text,'html_formatting'),'bold <thinking>secret</thinking>');
    assert.equal(api.cleanText(text,'ai_reasoning'),'<b>bold</b>');
    assert.equal(api.cleanText(text),'bold secret');
    assert.equal(state.vecthare.cleaning.selectedPreset,'nuclear');
    const messages=api.cleanMessages([{mes:text}], 'ai_reasoning');
    assert.equal(messages[0].mes,'<b>bold</b>');
    assert.match(core,/settings\.cleaningPreset \?\? 'none'/);
    assert.doesNotMatch(ui,/saveCleaningPresetToSettings\(presetId\)/);
});

test('#152: preview and vectorization use the same prepared content path',()=>{
    assert.match(ui,/resolveAndPrepareContent\(currentContentType, source, currentSettings\)/);
    assert.match(core,/await prepareContent\(contentType, rawContent, settings\)/);
    assert.match(core,/cleanMessages\(validMessages, settings\.cleaningPreset \?\? 'none'\)/);
});

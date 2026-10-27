/** I14: Text Cleaning Manager must never persist partial/invalid edits. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
let nextId=0;
const newId=()=>`id-${++nextId}`;
const quiet={log(){},warn(){},error(){},debug(){}};

async function loadCore(initial={selectedPreset:'custom',enabledBuiltins:[],customPatterns:[]}) {
    const extension_settings={vecthare:{cleaning:structuredClone(initial)}};
    const context=vm.createContext({console:quiet,RegExp,Set,Map,JSON,Object});
    const mod=new vm.SourceTextModule(read('core/text-cleaning.js'),{context});
    await mod.link(async name=>{
        if(name.includes('extensions.js')){
            const m=new vm.SyntheticModule(['extension_settings'],function(){this.setExport('extension_settings',extension_settings)},{context});return m;
        }
        if(name.includes('utils.js')){
            const m=new vm.SyntheticModule(['uuidv4'],function(){this.setExport('uuidv4',newId)},{context});return m;
        }
        throw Error(name);
    });
    await mod.evaluate();
    return {api:mod.namespace,extension_settings};
}
const plain=v=>JSON.parse(JSON.stringify(v));

test('#169: font/color wrappers keep multiline body while removing tags',async()=>{
    const {api}=await loadCore({selectedPreset:'html_formatting',enabledBuiltins:[],customPatterns:[]});
    const input='<font size="3">First\nsecond</font>\n<span style="color:red">A\nB</span>';
    const result=api.cleanText(input);
    assert.equal(result,'First\nsecond\nA\nB');
    assert.doesNotMatch(result,/<font|<span/);
});

test('#162: malformed regex or later malformed import never changes settings',async()=>{
    const {api,extension_settings}=await loadCore({selectedPreset:'none',enabledBuiltins:[],customPatterns:[{id:'old',pattern:'hi',flags:'g',enabled:true,name:'Old',replacement:''}]});
    const original=plain(extension_settings.vecthare.cleaning);
    for(const invalid of [
        JSON.stringify([{pattern:'valid',flags:'g'},{pattern:'(',flags:'g'}]),
        JSON.stringify([{pattern:'okay'},{name:'missing pattern'}]),
        JSON.stringify([{pattern:'valid'},{pattern:'oops',flags:'gg'}]),
        JSON.stringify({name:'Template',preset:'nuclear',enabledBuiltins:['strip_all_html'],customPatterns:[{pattern:'valid'},{pattern:'[',flags:'g'}]}),
        JSON.stringify({preset:'custom',enabledBuiltins:[],customPatterns:{pattern:'not-array'}}),
        JSON.stringify({preset:'unknown',customPatterns:[]}),
        JSON.stringify({preset:'custom',enabledBuiltins:['nonexistent'],customPatterns:[]}),
        JSON.stringify([null]),
        '{ bad json',
    ]) {
        const result=api.importPatterns(invalid);
        assert.equal(result.success,false,invalid);
        assert.deepEqual(plain(extension_settings.vecthare.cleaning),original,invalid);
    }
});

test('#162: both template and array imports validate and commit only once',async()=>{
    const {api,extension_settings}=await loadCore();
    const template=JSON.stringify({name:'test',preset:'nuclear',enabledBuiltins:['strip_font_tags'],customPatterns:[{name:'A',pattern:'foo',flags:'gi',enabled:false}]});
    const result=api.importPatterns(template);
    assert.equal(result.success,true);
    assert.equal(result.count,1);
    assert.equal(result.isTemplate,true);
    assert.equal(extension_settings.vecthare.cleaning.selectedPreset,'nuclear');
    assert.equal(extension_settings.vecthare.cleaning.customPatterns[0].enabled,false);
    assert.equal(api.importPatterns(JSON.stringify([{pattern:'foo'},{pattern:'bar'}])).count,1);
    assert.equal(extension_settings.vecthare.cleaning.customPatterns.length,2);
});

test('#163: draft imports never modify persisted state until explicit save',async()=>{
    const {api,extension_settings}=await loadCore();
    const original=plain(extension_settings.vecthare.cleaning);
    const result=api.preparePatternImport(JSON.stringify([{pattern:'new',flags:'g'}]),api.getCleaningSettings());
    assert.equal(result.success,true);
    assert.equal(result.settings.customPatterns.length,1);
    assert.deepEqual(plain(extension_settings.vecthare.cleaning),original);
    result.settings.customPatterns[0].name='unsaved';
    assert.deepEqual(plain(extension_settings.vecthare.cleaning),original);
    api.saveCleaningSettings(result.settings);
    assert.equal(extension_settings.vecthare.cleaning.customPatterns[0].name,'unsaved');
});

// Minimal jQuery event/render harness exercises the real modal callbacks without a browser.
async function loadUI(initial) {
    const core=await loadCore(initial);
    const handlers=new Map();
    const state={preset:initial.selectedPreset,builtins:[...(initial.enabledBuiltins||[])],items:structuredClone(initial.customPatterns||[]),saveCalls:0,alerts:[],html:'',closed:false};
    const saveOriginal=core.api.saveCleaningSettings;
    const fake$=function(selector){
        if(typeof selector==='object') return selector;
        return {
            on(event,fn){handlers.set(selector+':'+event,fn);return this},
            off(){return this},
            remove(){return this},fadeIn(){return this},
            fadeOut(_duration,fn){state.closed=true;fn?.call({remove(){}});return this},
            append(html){state.html=html;return this},
            html(html){if(html!==undefined){
                // Track the generated draft rows instead of writing to persistence.
                const rows=[...html.matchAll(/<div class="vecthare-tcm-custom-item" data-id="([^"]+)">([\s\S]*?)(?=<div class="vecthare-tcm-custom-item"|$)/g)];
                state.items=rows.map((row)=>{
                    const values=[...row[2].matchAll(/<input type="text" class="vecthare-tcm-custom-(?:name|pattern|replacement)" value="([^"]*)"/g)].map(m=>m[1]);
                    const find=(v)=>v?.replaceAll('&quot;','"').replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&');
                    return {id:row[1],enabled:row[2].includes('checked title="Enable/disable"'),name:find(values[0]),raw:find(values[1]),replacement:find(values[2])};
                });
            }return this;},
            val(v){if(v!==undefined){state.preset=v;return this}return state.preset},
            text(){return this},
            prop(){return this},
            click(){return this},
            length:1,
            each(fn){
                if(selector==='#vecthare_tcm_builtin_patterns input:checked')state.builtins.forEach(id=>fn.call({data:()=>id}));
                if(selector==='#vecthare_tcm_custom_patterns .vecthare-tcm-custom-item')state.items.forEach((p,i)=>{
                    const item={data:()=>p.id,find(sel){
                        if(sel.includes('pattern'))return {val:()=>p.raw??`/${p.pattern}/${p.flags||'g'}`,css:()=>{}};
                        if(sel.includes('enabled'))return {is:()=>p.enabled!==false};
                        if(sel.includes('name'))return {val:()=>p.name};
                        if(sel.includes('replacement'))return {val:()=>p.replacement||''};
                        throw Error(sel);
                    }};
                    return fn.call(item,i,item);
                });
                return this;
            },
            data(){return undefined},
        };
    };
    const context=vm.createContext({console:quiet,$:fake$,document:{createElement:()=>({set textContent(v){this._text=v},get innerHTML(){return (this._text||'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;')}})},toastr:{error:m=>state.alerts.push(m),success:m=>state.alerts.push(m),warning:m=>state.alerts.push(m)}});
    const ui=new vm.SourceTextModule(read('ui/text-cleaning-manager.js'),{context});
    await ui.link(async spec=>{
        if(spec.includes('text-cleaning.js')){
            const names=['BUILTIN_PATTERNS','CLEANING_PRESETS','getCleaningSettings','saveCleaningSettings','preparePatternImport','testPattern'];
            return new vm.SyntheticModule(names,function(){for(const n of names)this.setExport(n,n==='saveCleaningSettings'?s=>{state.saveCalls++;saveOriginal(s)}:core.api[n])},{context});
        }
        if(spec.includes('script.js'))return new vm.SyntheticModule(['saveSettingsDebounced'],function(){this.setExport('saveSettingsDebounced',()=>{})},{context});
        if(spec.includes('utils.js'))return new vm.SyntheticModule(['uuidv4'],function(){this.setExport('uuidv4',newId)},{context});
        throw Error(spec);
    });
    await ui.evaluate();
    ui.namespace.openTextCleaningManager();
    return {state,core,click:(selector)=>{const fn=handlers.get(selector+':click') || [...handlers.entries()].find(([key])=>key.endsWith(':click') && key.split(':click')[0].split(', ').includes(selector))?.[1];assert.ok(fn,selector);return fn()},deleteItem:(id)=>{const fn=handlers.get('#vecthare_tcm_custom_patterns [data-action="delete"]:click');assert.ok(fn);return fn.call({closest:()=>({data:()=>id})})},setItem:(id,patch)=>Object.assign(state.items.find(p=>p.id===id),patch)};
}

test('#161: invalid later pattern never persists earlier modal edits or preset selection',async()=>{
    const initial={selectedPreset:'custom',enabledBuiltins:[],customPatterns:[{id:'p1',name:'One',pattern:'ok',flags:'g',replacement:'',enabled:true},{id:'p2',name:'Two',pattern:'good',flags:'g',replacement:'',enabled:true}]};
    const {state,core,click,setItem}=await loadUI(initial);
    state.preset='nuclear';
    setItem('p1',{name:'CHANGED'});
    setItem('p2',{raw:'/(/g'});
    click('#vecthare_tcm_save');
    assert.equal(state.saveCalls,0);
    assert.deepEqual(plain(core.extension_settings.vecthare.cleaning),initial);
    assert.match(state.alerts.join(' '),/Invalid regex/);
    setItem('p2',{raw:'/good/g'});
    click('#vecthare_tcm_save');
    assert.equal(state.saveCalls,1);
    assert.equal(core.extension_settings.vecthare.cleaning.selectedPreset,'nuclear');
    assert.equal(core.extension_settings.vecthare.cleaning.customPatterns[0].name,'CHANGED');
});

test('#163: modal Add stays in draft and Close discards it',async()=>{
    const initial={selectedPreset:'custom',enabledBuiltins:[],customPatterns:[]};
    const {state,core,click}=await loadUI(initial);
    click('#vecthare_tcm_add_pattern');
    assert.equal(state.saveCalls,0);
    assert.deepEqual(plain(core.extension_settings.vecthare.cleaning),initial);
    assert.equal(state.items.length,1);
    click('#vecthare_tcm_cancel');
    assert.equal(state.closed,true);
    assert.deepEqual(plain(core.extension_settings.vecthare.cleaning),initial);
});

test('#163: modal Delete stays in draft and Close discards it',async()=>{
    const initial={selectedPreset:'custom',enabledBuiltins:[],customPatterns:[{id:'p1',name:'One',pattern:'ok',flags:'g',replacement:'',enabled:true}]};
    const {state,core,click,deleteItem}=await loadUI(initial);
    deleteItem('p1');
    assert.equal(state.items.length,0);
    assert.equal(state.saveCalls,0);
    assert.deepEqual(plain(core.extension_settings.vecthare.cleaning),initial);
    click('#vecthare_tcm_cancel');
    assert.equal(state.saveCalls,0);
});


test('#161: unknown regex flags and enabled empty patterns cannot be saved',async()=>{
    const initial={selectedPreset:'custom',enabledBuiltins:[],customPatterns:[{id:'p1',name:'One',pattern:'ok',flags:'g',replacement:'',enabled:true}]};
    const {state,core,click,setItem}=await loadUI(initial);
    setItem('p1',{raw:'/foo/z'});
    click('#vecthare_tcm_save');
    assert.equal(state.saveCalls,0);
    setItem('p1',{raw:'',enabled:true});
    click('#vecthare_tcm_save');
    assert.equal(state.saveCalls,0);
    assert.deepEqual(plain(core.extension_settings.vecthare.cleaning),initial);
});

test('#162: imported names are HTML attribute-escaped before rendering',async()=>{
    const {api}=await loadCore();
    const result=api.preparePatternImport(JSON.stringify([{pattern:'good',name:'" onfocus="evil <script>',replacement:'x'}]),api.getCleaningSettings());
    assert.equal(result.success,true);
    const {state}=await loadUI(result.settings);
    assert.match(state.html,/&quot; onfocus=&quot;evil &lt;script&gt;/);
    assert.doesNotMatch(state.html,/value="" onfocus=/);
});

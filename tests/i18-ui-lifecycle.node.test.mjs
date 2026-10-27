/** I18: repeated UI mounting, timer/observer lifetime and fresh settings. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import AsyncUtils from '../utils/async-utils.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = file => readFileSync(path.join(root,file),'utf8');
const quiet = {debug(){},log(){},warn(){},error(){}};
function section(code, from, until) {
    const start=code.indexOf(from);
    assert.ok(start>=0, `Missing ${from}`);
    const end=code.indexOf(until,start+from.length);
    assert.ok(end>start,`Missing terminator ${until}`);
    return code.slice(start,end);
}
function jqHarness() {
    const events = new Map();
    const counts={off:[],on:[]};
    function $(element) {
        const key=typeof element==='string'?element:'document';
        return {
            off(ev) { counts.off.push([key,ev]);
                if (ev.startsWith('.')) {
                    for(const event of [...events.keys()]) if(event.startsWith(key+'|') && event.split('|')[1].includes(ev)) events.delete(event);
                } else {
                    for(const event of [...events.keys()]) if (event.startsWith(`${key}|${ev}`)) events.delete(event);
                }
                return this;
            },
            on(ev,selector,handler) {
                counts.on.push([key,ev]);
                events.set(`${key}|${ev}${typeof selector==='string' ? '|'+selector : ''}`, handler || selector);
                return this;
            },
            fadeOut(){return this;},stop(){return this;},remove(){return this;},
            fadeIn(){return this;},hide(){return this;},show(){return this;},
            click(){return this;}
        };
    }
    return {$,events,counts};
}

test('#113: early resolve/reject clears the timeout without changing promise result',async()=> {
    const originalSet=globalThis.setTimeout;
    const originalClear=globalThis.clearTimeout;
    const allocated=[], cleared=[];
    try {
        globalThis.setTimeout=(fn,ms)=>{const id={fn,ms};allocated.push(id);return id;};
        globalThis.clearTimeout=id=>cleared.push(id);
        assert.equal(await AsyncUtils.timeout(Promise.resolve('ok'),100),'ok');
        await assert.rejects(AsyncUtils.timeout(Promise.reject(Error('original')),100),/original/);
        assert.equal(allocated.length,2);
        assert.deepEqual(cleared,allocated);
    } finally {globalThis.setTimeout=originalSet;globalThis.clearTimeout=originalClear;}
});

test('#113: timeout rejection still rejects with caller-supplied error and clears timer',async()=>{
    const originalSet=globalThis.setTimeout;
    const originalClear=globalThis.clearTimeout;
    let timer,cleared=false;
    try {
        globalThis.setTimeout=(fn)=>{timer={fn};queueMicrotask(fn);return timer;};
        globalThis.clearTimeout=id=>{assert.equal(id,timer);cleared=true;};
        await assert.rejects(AsyncUtils.timeout(new Promise(()=>{}),10,'custom timeout'),/custom timeout/);
        assert.ok(cleared);
    } finally {globalThis.setTimeout=originalSet;globalThis.clearTimeout=originalClear;}
});

test('#15: rebinding chunk detail controls cannot accumulate namespaced handlers',()=>{
    const code=section(source('ui/chunk-visualizer.js'),'function bindDetailEvents() {','/**\n * Parse plaintext keywords');
    const h=jqHarness();
    const context=vm.createContext({
        $:h.$,allChunksMap:new Map([['chosen',{hash:'h1',data:{text:'chunk text'}}]]),
        selectedChunkId:'chosen',debounce:fn=>fn
    });
    vm.runInContext(`${code}\nthis.bindDetailEvents=bindDetailEvents;`,context);
    context.bindDetailEvents();
    const first=new Map(h.events);
    assert.ok(first.size>15);
    context.bindDetailEvents();
    assert.equal(h.events.size,first.size);
    for(const event of h.events.keys()) assert.ok(event.includes('.vecthareDetail'),event);
});

test('#13: Content Vectorizer has dedicated, detachable document event namespace',()=>{
    const code=source('ui/content-vectorizer.js');
    const delegates=[...code.matchAll(/\$\(document\)\.on\('([^']+)',\s*'([^']+)'/g)];
    assert.ok(delegates.length>=12,'scope, fields and decay controls must all be bound');
    for(const m of delegates) assert.equal(m[1],'change.vecthareContentVectorizer');
    const open=section(code,'export function openContentVectorizer(','/**\n * Closes the modal');
    const close=section(code,'export function closeContentVectorizer(','/**\n * Creates the modal HTML');
    assert.match(open,/\$\(document\)\.off\('\.vecthareContentVectorizer'\)/);
    assert.match(close,/\$\(document\)\.off\('\.vecthareContentVectorizer'\)/);
});

test('#14: Database Browser keyboard handler binds once per open and detaches on close',()=>{
    const code=source('ui/database-browser.js');
    const keyboard=section(code,'function bindBrowserKeyboard() {','/**\n * Switches active tab');
    const close=section(code,'export function closeDatabaseBrowser() {','/**\n * Creates the browser modal');
    const h=jqHarness();let isOpen=true;
    const ctx=vm.createContext({$:h.$,document:{},browserState:{isOpen},console:quiet});
    vm.runInContext(`${keyboard}\n${close.replace('export function','function')}\nthis.bind=bindBrowserKeyboard;this.close=closeDatabaseBrowser;`,ctx);
    ctx.bind();ctx.bind();
    assert.equal(h.events.size,1);
    h.events.get('document|keydown.vecthare_browser')({key:'Escape'});
    assert.equal(h.events.size,0);
    ctx.bind();assert.equal(h.events.size,1);
    ctx.close();assert.equal(h.events.size,0);
    assert.doesNotMatch(close,/resetEventFlags/);
});

test('#14: activation editor subscribes to host chat event at most once',()=>{
    const code=source('ui/database-browser.js');
    const sectionText=section(code,'// One host listener for all activation-editor opens','// Injection position toggle');
    assert.match(sectionText,/if \(!activationChatListenerBound\)/);
    assert.match(sectionText,/activationChatListenerBound = true/);
    const listeners=[];
    const ctx=vm.createContext({activationChatListenerBound:false,eventSource:{on:(...args)=>listeners.push(args)},event_types:{CHAT_CHANGED:'changed'},refreshActivationLockButton:()=>{}});
    vm.runInContext(`function setup(){${sectionText}}this.setup=setup`,ctx);
    ctx.setup();ctx.setup();
    assert.equal(listeners.length,1);
});

test('#22: settings re-render replaces old UI and diagnostics key handler is idempotent',()=>{
    const code=source('ui/ui-manager.js');
    const render=section(code,'export function renderSettings(','/**\n * Initializes diagnostics modal');
    const oldIndex=render.indexOf("$('#vecthare_settings').remove();");
    const appendIndex=render.indexOf('$(`#${containerId}`).append(html);');
    assert.ok(oldIndex>=0&&oldIndex<appendIndex);
    assert.match(code,/\$\(document\)\.off\('keydown\.vecthareDiagnostics'\)\.on\('keydown\.vecthareDiagnostics'/);
});

test('#23: repeated Health Dashboard initialization registers only one timer and event set',()=>{
    const code=source('ui/health-dashboard.js');
    const init=section(code,'let healthDashboardInitialized = false;','/** Detach dashboard handlers');
    const dispose=section(code,'export function disposeHealthDashboard() {','/**\n * Get CSS styles');
    const h=jqHarness();
    let serial=0;const timers=new Set();
    const ctx=vm.createContext({$:h.$,document:{},console:quiet,
        openHealthDashboard(){},closeHealthDashboard(){},updateDashboard(){},
        setInterval:()=>{const id=++serial;timers.add(id);return id;},clearInterval:id=>timers.delete(id),
        getBackendMetrics:()=>({backends:[]}),getCurrentBackend:()=>'',getHealthClass:()=>'',
    });
    vm.runInContext(`${init.replace('export function','function')}\n${dispose.replace('export function','function')}\nthis.init=initializeHealthDashboard;this.dispose=disposeHealthDashboard;`,ctx);
    ctx.init();ctx.init();
    assert.equal(timers.size,1);assert.equal(h.events.size,4);
    ctx.dispose();assert.equal(timers.size,0);assert.equal(h.events.size,0);
    ctx.init();assert.equal(timers.size,1);assert.equal(h.events.size,4);
});

test('#24: scene markers observe only the current chat DOM node, even after repeat init',()=>{
    const code=source('ui/scene-markers.js');
    const init=section(code,'let sceneMarkersInitialized = false;','console.log(\'VectHare Scenes: Markers initialized\');')+"console.log('VectHare Scenes: Markers initialized');\n}";
    const listeners=new Map(),instances=[];
    let chat={id:'chat-1'},attached=0;
    class Observer { constructor(callback){this.callback=callback;this.started=[];this.disconnects=0;instances.push(this);}observe(node){this.started.push(node);}disconnect(){this.disconnects++;} }
    const ctx=vm.createContext({MutationObserver:Observer,eventSource:{on:(type,handler)=>{const arr=listeners.get(type)||[];arr.push(handler);listeners.set(type,arr);}},
        event_types:{CHAT_CHANGED:'change',APP_READY:'ready'},
        document:{getElementById:()=>chat},console:quiet,
        attachAllMarkers:()=>attached++,refreshSceneCache:async()=>{},updateAllMarkerStates:()=>{},setTimeout:()=>{},
        Node:{ELEMENT_NODE:1},attachMarkersToMessage:()=>{},
    });
    vm.runInContext(`${init.replace('export function','function')}\nthis.init=initializeSceneMarkers`,ctx);
    ctx.init();ctx.init();
    assert.equal(instances.length,1);assert.equal(listeners.get('change').length,1);
    assert.equal(listeners.get('ready').length,1);
    assert.equal(instances[0].started.length,1);
    chat={id:'chat-2'};
    listeners.get('change')[0]();
    assert.equal(instances[0].disconnects,1);
    assert.equal(instances[0].started.length,2);
    assert.equal(instances[0].started[1],chat);
    listeners.get('change')[0]();
    assert.equal(instances[0].started.length,2,'same DOM node not redundantly observed');
    assert.ok(attached>=2);
});

test('#20: initialization preserves a shared current settings identity for UI and background',()=>{
    const code=source('index.js');
    const merge=section(code,'    // Merge saved settings with defaults','    // Retire the inert legacy');
    const defaults={vector_backend:'standard',collections:{a:1},temporal_decay:{enabled:true}};
    const extension_settings={vecthare:{vector_backend:'qdrant',collections:{b:2}}};
    const saved=extension_settings.vecthare;
    const ctx=vm.createContext({defaultSettings:defaults,extension_settings,settings:{}});
    vm.runInContext(merge,ctx);
    assert.equal(ctx.settings,saved);
    assert.equal(ctx.settings.vector_backend,'qdrant');
    assert.equal(ctx.settings.collections.a,1);
    assert.equal(ctx.settings.collections.b,2);
    extension_settings.vecthare.vector_backend='milvus';
    assert.equal(ctx.settings.vector_backend,'milvus');
});

test('#26: manual vectorization and repair await their final resume-status check',async()=>{
    const code=source('index.js');
    const repair=section(code,'async function onRepairClick() {','/**\n * Action: Vectorize all messages');
    const sync=section(code,'async function onVectorizeAllClick() {','/**\n * VectHare+ Resume-on-load');
    let release;const gate=new Promise(resolve=>release=resolve);
    let resumed=0;
    const ctx=vm.createContext({settings:{},getBatchSize:()=>1,repairChatVectors:async()=>{},vectorizeAll:async()=>42,
        offerResumeOfUnfinishedVectorization:()=>{resumed++;return gate;}});
    vm.runInContext(`${repair}\n${sync}\nthis.repair=onRepairClick;this.sync=onVectorizeAllClick`,ctx);
    let finished=false;
    const run=ctx.sync().then(v=>{finished=true;return v;});
    await new Promise(r=>setImmediate(r));
    assert.equal(finished,false);assert.equal(resumed,1);
    release();assert.equal(await run,42);
    await ctx.repair();assert.equal(resumed,2);
});

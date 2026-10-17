/** Targeted Live Status regression checks; run with `node tests/live-status-regression.mjs`. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const root=new URL('..',import.meta.url).pathname;
let passed=0;
const check=(label,fn)=>{fn();passed++;console.log('PASS',label);};
const activity=fs.readFileSync(`${root}/ui/activity-status.js`,'utf8').replaceAll('export function ','function ').replaceAll('export async function ','async function ');
const ctx=vm.createContext({Date,Math,Number,Set,Map,console});
vm.runInContext(activity,ctx);
const snapshots=[];
const unsubscribe=ctx.subscribeActivity(s=>snapshots.push(s));
const id=ctx.startActivity('Vectorizing Chat',{total:100,unit:'messages',detail:'Starting…'});
check('new operation appears immediately in the shared status feed',()=>{
    assert.equal(snapshots.at(-1).operations[0].label,'Vectorizing Chat');
});
ctx.updateActivity(id,{completed:45,unit:'chunks',total:90,detail:'Embedding 45/90',metrics:{totalChunksToEmbed:90,embeddedChunks:45,speedPerSecond:3.2}});
check('progress, stage, metrics and unit remain available to the status UI',()=>{
    const current=snapshots.at(-1).operations[0];
    assert.equal(current.unit,'chunks');assert.equal(current.completed,45);assert.equal(current.total,90);
    assert.equal(current.metrics.embeddedChunks,45);assert.equal(ctx.activityPercent(current),50);
});
ctx.updateActivity(id,{error:'Connection failed'});
ctx.finishActivity(id,false,'Backend unavailable');
check('errors move into bounded operation history rather than disappear',()=>{
    const snap=ctx.getActivitySnapshot();
    assert.equal(snap.operations.length,0);assert.equal(snap.history[0].phase,'failed');
    assert.equal(snap.history[0].errors[0],'Connection failed');
});
unsubscribe();
check('activity subscription can be removed without changing progress state',()=>{
    const n=snapshots.length;const next=ctx.startActivity('Scan Chat');ctx.finishActivity(next,true);
    assert.equal(snapshots.length,n);
});
const live=fs.readFileSync(`${root}/ui/live-status.js`,'utf8');
const ui=fs.readFileSync(`${root}/ui/ui-manager.js`,'utf8');
const css=fs.readFileSync(`${root}/styles/live-status.css`,'utf8');
check('Live Status renders details and errors from existing progress tracker',()=>{
    for(const marker of ['totalChunksToEmbed','speedPerSecond','op.errors','vecthare_live_operations'])assert.ok(live.includes(marker));
});
check('database statistics are refreshed while modal is open, never estimated as bytes',()=>{
    assert.match(live,/databaseTimer=setInterval\(refreshDatabaseStats,12000\)/);
    assert.match(live,/stats\.error/);
    assert.match(live,/Storage bytes not exposed by backend/);
    assert.match(live,/stats\.chunkCount/);
});
check('Scan/Repair, Auto-Sync and purge feed central progress system',()=>{
    const index=fs.readFileSync(`${root}/index.js`,'utf8');
    const sync=fs.readFileSync(`${root}/core/chat-vectorization.js`,'utf8');
    assert.match(index,/startActivity\(repairing\?'Repair Chat Embeddings':'Scan Chat Embeddings'/);
    assert.match(index,/startActivity\('Purge All Vectors'/);
    assert.match(sync,/startActivity\('Auto-Sync Chat'/);
});
check('Android floating panel is hidden; dialog and compact inline bar remain accessible',()=>{
    assert.match(css,/@media\(max-width:768px\)/);
    assert.match(css,/\.vecthare-progress-panel\{display:none!important;/);
    assert.match(ui,/id="vecthare_live_status_button"/);
    assert.match(ui,/id="vecthare_inline_status_fill"/);
});
console.log(`\n${passed} Live Status checks passed`);

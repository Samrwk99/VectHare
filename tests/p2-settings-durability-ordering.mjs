import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../core/settings-durability.js',import.meta.url),'utf8')
  .replace(/^import\s+.*?\s+from\s+['"].+?['"];\s*$/gm,'')
  .replace(/^export /gm,'');
const clone=v=>JSON.parse(JSON.stringify(v));
const state={vecthare:{top_k:5,score_threshold:0,flag:false,collections:{'qdrant:llamacpp:A':{enabled:false,temporalDecay:{minRelevance:0},optional:undefined}}}};
let server={revision:0,snapshot:null,checksum:null};
const events=[];
const context=vm.createContext({JSON,Object,Array,Map,Set,Date,Promise,Math,Number,URL,structuredClone,
  console,document:undefined,extension_settings:state,getRequestHeaders:()=>({}),
  hostSaveSettings:async()=>{events.push('host-save');},setTimeout,clearTimeout,
  fetch:async(url,opts)=>{
    const route=String(url).split('/').at(-1),request=JSON.parse(opts.body||'{}');events.push(route);
    if(route==='previous')return {ok:true,status:200,json:async()=>({success:true,revision:server.revision?server.revision-1:0,snapshot:null,checksum:null})};
    if(route==='commit'){
      if(server.revision!==request.expectedRevision)return {ok:false,status:409,json:async()=>({error:'stale'})};
      server={revision:server.revision+1,snapshot:clone(request.snapshot),checksum:'digest'};
      return {ok:true,status:200,json:async()=>({success:true,revision:server.revision,checksum:server.checksum})};
    }
    return {ok:true,status:200,json:async()=>({success:true,...clone(server)})};
  }
});
vm.runInContext(source,context);
const call=name=>vm.runInContext(name+'()',context);
const snapshot=vm.runInContext('recoverySnapshot(extension_settings.vecthare)',context);
assert(!Object.hasOwn(snapshot.collections['qdrant:llamacpp:A'],'optional'), 'Undefined optional metadata must match JSON wire format');
assert.equal(snapshot.collections['qdrant:llamacpp:A'].temporalDecay.minRelevance,0);
await call('flushVectHareSettings');
assert.deepEqual(events,['get','get','commit','get','host-save'],'Host must never save before recovery CAS');
assert.equal(server.revision,1);
// Keys may be reordered after ST deserialization: no new revision should be created.
state.vecthare={collections:clone(state.vecthare.collections),flag:false,score_threshold:0,top_k:5};
events.length=0;
await call('flushVectHareSettings');
assert.equal(server.revision,1);
assert(!events.includes('commit'), 'Key order is not a configuration change');
// If another tab commits an independent revision, do not host-save this stale state.
server={revision:2,checksum:'external',snapshot:{top_k:900}};
events.length=0;
await assert.rejects(call('flushVectHareSettings'),/stale write blocked/i);
assert(!events.includes('host-save'),'Stale state must never overwrite ST host settings');
const comparison=await call('inspectSettingsRecovery');
assert(comparison.differingPaths.length>0);
assert.equal(comparison.committed.top_k,900);
assert.equal(state.vecthare.top_k,5,'Conflict inspection must be read-only');
console.log('PASS: non-secret mirror CAS precedes host save, JSON-safe serialization, canonical equality, stale-host protection, read-only conflict inspection');

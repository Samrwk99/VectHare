import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {applyEditedSettings} from '../core/settings-delta.js';
const input=fs.readFileSync(new URL('../index.js',import.meta.url),'utf8');
const start=input.indexOf('const defaultSettings = {');
const end=input.indexOf('\n};',start);
assert(start>=0&&end>start);
const expression=input.slice(start+'const defaultSettings = '.length,end+2);
const defaults=vm.runInNewContext(`(${expression})`,{extension_prompt_types:{IN_PROMPT:0},getDefaultDecaySettings:()=>({enabled:false,halfLife:50,minRelevance:.3})});
const systemKeys=new Set(['collections','vecthare_collection_registry','chatCollectionBindings','chatCollectionPolicies','pendingVectorizations']);
let total=0;
for(const [key,original] of Object.entries(defaults)){
 if(systemKeys.has(key))continue;
 const current=structuredClone(defaults);
 current.collections={'chat:B':{enabled:true}};
 current.vecthare_collection_registry=['standard:source:chatB'];
 const edited=structuredClone(defaults),base=structuredClone(defaults);
 let replacement;
 if(typeof original==='boolean')replacement=!original;
 else if(typeof original==='number')replacement=original+1;
 else if(typeof original==='string')replacement=`${original}-modified`;
 else if(Array.isArray(original))replacement=[...original,'extra'];
 else if(original&&typeof original==='object')replacement={...original,enabled:true};
 else continue;
 edited[key]=replacement;
 // Separate actor updates a different setting while the editor is open.
 if(key!=='top_k')current.top_k=13;
 else current.query=11;
 applyEditedSettings(edited,current,base);
 assert.deepEqual(current[key],replacement,`${key} saved different value`);
 assert.equal(current.collections['chat:B'].enabled,true,`${key} changed collection B`);
 assert.deepEqual(current.vecthare_collection_registry,['standard:source:chatB']);
 if(key!=='top_k')assert.equal(current.top_k,13,`${key} clobbered an unrelated value`);
 else assert.equal(current.query,11);
 const reloaded=JSON.parse(JSON.stringify(current));
 assert.deepEqual(reloaded[key],JSON.parse(JSON.stringify(replacement)),`${key} failed JSON save-reload roundtrip`);
 total++;
}
for(const [field,value] of Object.entries({bm25_b:0,score_threshold:0,world_info_threshold:0,hybrid_vector_weight:0,hybrid_text_weight:0,rate_limit_calls:0,memory_token_budget:0,default_decay_enabled:false})){
 const draft=structuredClone(defaults),baseline=structuredClone(defaults),persisted=structuredClone(defaults);
 draft[field]=value;
 applyEditedSettings(draft,persisted,baseline);
 assert.equal(JSON.parse(JSON.stringify(persisted))[field],value,`Boundary value for ${field} lost`);
}
console.log(`PASS: ${total} top-level defaults individually modified, diff-applied without clobbering other fields, and JSON round-tripped; zero/false boundaries checked`);
console.log('NOTICE: Data-store mechanics tested; UI control events, running services, restart and host persistence remain separate acceptance gates.');

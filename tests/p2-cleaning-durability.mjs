import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const code=fs.readFileSync(new URL('../core/text-cleaning.js',import.meta.url),'utf8')
  .replace(/^import\s+.*?\s+from\s+['"].+?['"];\s*$/gm,'')
  .replace(/^export /gm,'');
let saves=0;
const settings={vecthare:{cleaning:{selectedPreset:'none',customPatterns:[],enabledBuiltins:[]}}};
const ctx=vm.createContext({JSON,Object,Array,Map,Set,Math,Number,Date,RegExp,String,URL,console,
  structuredClone,extension_settings:settings,uuidv4:()=> 'id-test',saveVectHareSettingsDebounced:()=>{saves++;}});
vm.runInContext(code,ctx);
const call=source=>vm.runInContext(source,ctx);
const draft={selectedPreset:'comprehensive',enabledBuiltins:[],customPatterns:[]};
ctx.proposed=draft;
call('saveCleaningSettings(proposed)');
assert.equal(saves,1,'Cleaning settings must trigger central persistence');
draft.selectedPreset='none';
assert.equal(settings.vecthare.cleaning.selectedPreset,'comprehensive','Retained form draft must not silently mutate the stored recipe defaults');
call('addCustomPattern({pattern:"test",replacement:"",flags:"g"})');
assert.equal(saves,2);
assert.equal(settings.vecthare.cleaning.customPatterns.length,1);
assert.equal(settings.vecthare.cleaning.customPatterns[0].pattern,'test');
call('toggleBuiltinPattern("strip_font_tags",true)');
assert.equal(saves,3);
console.log('PASS: cleaning changes use durable save path and are detached from stale drafts');

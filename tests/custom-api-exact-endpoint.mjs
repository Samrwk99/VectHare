import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const root=new URL('../',import.meta.url);
let passed=0;
async function check(name,fn){await fn();passed++;console.log('PASS',name);}
async function load(path, mocks, extras={}){
  const ctx=vm.createContext({console,JSON,Math,Number,String,Set,Map,Date,URL,structuredClone,...extras});
  const mod=new vm.SourceTextModule(fs.readFileSync(new URL(path,root),'utf8'),{context:ctx});
  await mod.link(spec=>{
    const supplied=mocks[spec]||mocks[spec.split('/').at(-1)];
    if(!supplied)throw Error(`Missing mock for ${spec}`);
    return new vm.SyntheticModule(Object.keys(supplied),function(){for(const [k,v] of Object.entries(supplied))this.setExport(k,v)},{context:ctx});
  });
  await mod.evaluate();return mod.namespace;
}
const provider=await load('backends/provider-params.js',{
  'extensions.js':{extension_settings:{}},
  'textgen-settings.js':{textgen_types:{LLAMACPP:'llama',OLLAMA:'ollama'},textgenerationwebui_settings:{server_urls:{}}},
  'openai.js':{oai_settings:{}}
});
await check('Custom API defaults to legacy Base routing',()=>{
  const result=provider.getProviderSpecificParams({source:'custom',alt_endpoint_url:'http://localhost:9001'});
  assert.equal(result.customEndpointMode,'base');
});
await check('Exact mode passes exact URL, auth and mode without URL rewriting',()=>{
  const result=provider.getProviderSpecificParams({source:'custom',custom_endpoint_mode:'exact',alt_endpoint_url:'https://api.invalid/my/embed?auth=one',custom_api_key:'secret'});
  assert.equal(result.apiUrl,'https://api.invalid/my/embed?auth=one');
  assert.equal(result.customEndpointMode,'exact');
  assert.equal(result.apiKey,'secret');
});
await check('Other providers are not switched into Custom API mode',()=>{
  const result=provider.getProviderSpecificParams({source:'nanogpt',use_alt_endpoint:false,nanogpt_api_key:'secret'});
  assert.ok(!Object.hasOwn(result,'customEndpointMode'));
});
let oldPlugin=false;
const requestLog=[];
const overflow=await load('core/embedding-overflow.js',{
  'provider-params.js':{getProviderSpecificParams:provider.getProviderSpecificParams},
  'script.js':{getRequestHeaders:()=>({})},
},{fetch:async(url,opts)=>{
  const body=JSON.parse(opts.body);requestLog.push({url,body});
  if(url.endsWith('/capabilities'))return {ok:true,json:async()=>oldPlugin ? {success:true,modelId:body.model} : {success:true,endpointModeSupported:true,endpointMode:'exact',modelId:body.model,limits:null}};
  if(url.endsWith('/tokenize'))return {ok:false,status:422,text:async()=> 'No tokenizer for exact endpoint'};
  throw Error(`Unexpected ${url}`);
}});
const settings={source:'custom',custom_model:'remote-model',custom_endpoint_mode:'exact',alt_endpoint_url:'https://api.invalid/strange/path',embedding_max_tokens:64};
await check('Exact mode capability request carries routing mode',async()=>{
  await overflow.getEmbeddingBudget(settings);
  assert.equal(requestLog.at(-1).body.customEndpointMode,'exact');
});
await check('Old plugin without exact-mode support is rejected even if manual limit is set',async()=>{
  oldPlugin=true;
  await assert.rejects(overflow.getEmbeddingBudget(settings),/requires the matching Similharity plugin/i);
  oldPlugin=false;
});
await check('Unsupported exact tokenizer falls back to conservative splitting, not wrong endpoint',async()=>{
  const text='This message is deliberately longer than the configured exact endpoint budget.'.repeat(3);
  const parts=await overflow.prepareEmbeddingItems([{hash:1,text,metadata:{strategy:'per_message'}}],settings,s=>s.length);
  assert.ok(parts.length>1);
  assert.equal(parts.map(x=>x.text).join(''),text);
  assert.ok(requestLog.some(x=>x.url.endsWith('/tokenize')&&x.body.customEndpointMode==='exact'));
});
const source=path=>fs.readFileSync(new URL(path,root),'utf8');
await check('Mode saved per collection, propagated through direct insertion and visible in UI',()=>{
  assert.match(source('index.js'),/custom_endpoint_mode: 'base'/);
  assert.match(source('core/vectorization-profile.js'),/COPY_FIELDS = .*'custom_endpoint_mode'/);
  assert.match(source('core/vectorization-profile.js'),/profile\.chunking\?\.custom_endpoint_mode \|\| 'base'/);
  assert.match(source('core/core-vector-api.js'),/body\.customEndpointMode = settings\.custom_endpoint_mode \|\| 'base'/);
  assert.match(source('ui/ui-manager.js'),/id="vecthare_custom_endpoint_mode"/);
  assert.match(source('ui/ui-manager.js'),/settings\.custom_endpoint_mode = \$\(this\)\.val\(\)/);
});
console.log(`\n${passed} exact endpoint extension checks passed`);

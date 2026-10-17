/** No live server required. Run: node --experimental-vm-modules tests/p46-embedding-integration.mjs */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const root=new URL('../',import.meta.url);
let passes=0;
async function test(name,fn){await fn();passes++;console.log('PASS',name);}
async function load(path,imports,extra={}) {
  const context=vm.createContext({console,JSON,Math,Number,String,Set,Map,Date,URL,structuredClone,...extra});
  const mod=new vm.SourceTextModule(fs.readFileSync(new URL(path,root),'utf8'),{context,identifier:path});
  await mod.link(spec=>{
    const mocks=imports[spec]||imports[spec.split('/').at(-1)];
    if(!mocks)throw Error(`Unmocked import ${spec}`);
    return new vm.SyntheticModule(Object.keys(mocks),function(){for(const [key,value]of Object.entries(mocks))this.setExport(key,value)},{context});
  });
  await mod.evaluate();return mod.namespace;
}
const params=await load('backends/provider-params.js',{
 'extensions.js':{extension_settings:{}},
 'textgen-settings.js':{textgen_types:{LLAMACPP:'llamacpp',OLLAMA:'ollama',VLLM:'vllm',KOBOLDCPP:'koboldcpp'},textgenerationwebui_settings:{server_urls:{llamacpp:'http://127.0.0.1:8080',ollama:'http://127.0.0.1:11434',vllm:'http://127.0.0.1:8000',koboldcpp:'http://127.0.0.1:5001'}}},
 'openai.js':{oai_settings:{}}
});
await test('Custom API endpoint, model credential and URL are provider-specific',async()=>{
 const p=params.getProviderSpecificParams({source:'custom',alt_endpoint_url:'https://localhost:9009/api/v1',custom_api_key:'key1'});
 assert.equal(p.apiUrl,'https://localhost:9009/api/v1');assert.equal(p.apiKey,'key1');
});
await test('NanoGPT default API base URL and key forwarded, without pretending localhost',async()=>{
 const p=params.getProviderSpecificParams({source:'nanogpt',use_alt_endpoint:false,nanogpt_api_key:'key2'});
 assert.equal(p.apiUrl,'https://nano-gpt.com/api/v1');assert.equal(p.apiKey,'key2');
});
await test('llama.cpp preserves user-configured port',async()=>{
 const p=params.getProviderSpecificParams({source:'llamacpp',use_alt_endpoint:true,alt_endpoint_url:'http://127.0.0.1:9977'});
 assert.equal(p.apiUrl,'http://127.0.0.1:9977');
});
await test('vLLM forwards optional bearer key with endpoint',async()=>{
 const p=params.getProviderSpecificParams({source:'vllm',use_alt_endpoint:true,alt_endpoint_url:'http://myserver:8000',vllm_api_key:'secret'});
 assert.equal(p.apiUrl,'http://myserver:8000');assert.equal(p.apiKey,'secret');
});
const code=(path)=>fs.readFileSync(new URL(path,root),'utf8');
await test('NanoGPT and Custom API appear in dropdown and have dedicated model/key inputs',async()=>{
 const ui=code('ui/ui-manager.js');
 for(const id of ['nanogpt','custom']){
   assert.match(ui,new RegExp(`<option value="${id}"`));
   assert.match(ui,new RegExp(`id="vecthare_${id}_model"`));
   assert.match(ui,new RegExp(`id="vecthare_${id}_api_key"`));
 }
 assert.match(ui,/selectedProvider === 'custom'/);
});
await test('Standard native backend refuses unsafe Ollama fallback (and new providers)',async()=>{
 const source=code('backends/standard.js');assert.match(source,/\['nanogpt','custom','ollama'\]/);
});
const fetches=[];let publishedLimit=100, tokenizeAvailable=true;
const overflow=await load('core/embedding-overflow.js',{'provider-params.js':{getProviderSpecificParams:params.getProviderSpecificParams},'script.js':{getRequestHeaders:()=>({})}},{fetch:async(url,opts)=>{
 const body=JSON.parse(opts.body);fetches.push({url,body});
 if(url.endsWith('/capabilities'))return{ok:true,json:async()=>({modelId:body.model||'configured',limits:{reportedContextTokens:publishedLimit}})};
 if(url.endsWith('/tokenize')&&tokenizeAvailable)return{ok:true,json:async()=>({count:body.text.length})};
 return{ok:false,status:422,text:async()=> 'Unavailable'};
}});
await test('vLLM with manually verified embedding limit splits oversized chat chunk losslessly',async()=>{
 const settings={source:'vllm',vllm_model:'embed',use_alt_endpoint:true,alt_endpoint_url:'http://myserver:8000',embedding_max_tokens:35};
 const item={hash:42,text:'This is an overlong conversation for embedding. Here is some more detail to overflow!',metadata:{strategy:'per_message',messageId:4}};
 publishedLimit=35;
 const out=await overflow.prepareEmbeddingItems([item],settings,x=>x.length);
 assert.ok(out.length>1);assert.equal(out.map(i=>i.text).join(''),item.text);
 assert.ok(out.every(i=>i.metadata.parentHash===42));
});
await test('reported model context is not treated as verified embedding input limit',async()=>{
 publishedLimit=65536;
 await assert.rejects(overflow.getEmbeddingBudget({source:'vllm',vllm_model:'unverified-context',use_alt_endpoint:true,alt_endpoint_url:'http://model-context.invalid'}),/no verifiable embedding input limit/i);
});
await test('OpenRouter manual token limit refuses unsafe tokenizer-free splitting',async()=>{
 const settings={source:'openrouter',openrouter_model:'embed-x',embedding_max_tokens:48};
 tokenizeAvailable=false;
 const item={hash:7,text:'An embedding description that clearly exceeds the selected input token budget.',metadata:{strategy:'per_message'}};
 await assert.rejects(overflow.prepareEmbeddingItems([item],settings,String),/no verified embedding-model tokenizer/);
});
await test('Oversized embedding query fails loudly rather than silently truncating',async()=>{
 const settings={source:'custom',custom_model:'embed-remote',alt_endpoint_url:'https://example.com/api/v1',embedding_max_tokens:24};
 await assert.rejects(overflow.assertEmbeddingQueryFits('a'.repeat(300),settings),/exceeds.*safe limit/i);
});
await test('Unknown limit with no manual override fails closed',async()=>{
 publishedLimit=0;
 await assert.rejects(overflow.getEmbeddingBudget({source:'electronhub',electronhub_model:'text-embedding-3-small'}),/no verifiable embedding input limit/i);
});
console.log(`\n${passes} P46 extension regression checks passed`);

/** Targeted P1 regression checks; no running SillyTavern required.
 * node tests/p1-regression.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
const root=new URL('..',import.meta.url).pathname;
let passes=0;
async function test(name,fn){await fn();passes++;console.log('PASS',name);}
function moduleInVM(filename,env){
    const source=fs.readFileSync(path.join(root,filename),'utf8').replace(/^import\s+.*?\s+from\s+['"].*?['"];\s*$/gm,'').replace(/^export /gm,'');
    const context=vm.createContext({console,Date,Math,JSON,Number,String,Array,Set,Map,URL,structuredClone,...env});
    vm.runInContext(source,context,{filename});
    return context;
}
const fetches=[];
let activeModel='model-A', capabilityLimit=9;
const settings={source:'llamacpp',vector_backend:'qdrant',qdrant_multitenancy:false,
    use_alt_endpoint:true,alt_endpoint_url:'http://127.0.0.1:9977',chunking_strategy:'conversation_turns',batch_size:4,
    chunk_size:600,keyword_extraction_level:'balanced',secret:'private-secret'};
const meta=new Map();
const mockFetch=async(url,options={})=>{
    const body=options.body?JSON.parse(options.body):{};fetches.push({url,body});
    if(String(url).endsWith('/profile/set'))return {ok:true,json:async()=>({success:true})};
    if(String(url).endsWith('/profile/get'))return {ok:false,status:404};
    if(String(url).endsWith('/capabilities'))return {ok:true,json:async()=>({success:true,modelId:activeModel,modelPath:'/models/test.gguf',limits:{maxTokens:capabilityLimit}})};
    if(String(url).endsWith('/tokenize'))return {ok:true,json:async()=>({success:true,count:body.text.trim().split(/\s+/).length})};
    throw Error('unexpected request '+url);
};
const providerParams=s=>({apiUrl:s.alt_endpoint_url});
const ctx=moduleInVM('core/vectorization-profile.js',{
    extension_settings:{vecthare:{}},saveSettingsDebounced(){},getRequestHeaders:()=>({'Content-Type':'application/json'}),
    getProviderSpecificParams:providerParams,getModelField:()=>null,getCollectionMeta:k=>meta.get(k)||{},
    setCollectionMeta:(k,o)=>meta.set(k,{...(meta.get(k)||{}),...o}),fetch:mockFetch,
});
await test('collection profile captures actual configured llama.cpp model, no credentials',async()=>{
    const p=await ctx.makeCollectionProfile(settings);
    assert.equal(p.embedding.modelId,'model-A');assert.equal(p.chunking.chunking_strategy,'conversation_turns');
    assert.ok(!JSON.stringify(p).includes('private-secret'));assert.ok(!JSON.stringify(p).includes('127.0.0.1'));
    await ctx.saveCollectionProfile('qdrant:llamacpp:alice',p);
});
await test('changing URL and chunk defaults cannot silently overwrite saved strategy',async()=>{
    const other={...settings,alt_endpoint_url:'http://127.0.0.1:4096',chunking_strategy:'per_message'};
    const result=await ctx.applyAndVerifyProfile('qdrant:llamacpp:alice',other);
    assert.equal(result.settings.chunking_strategy,'conversation_turns');
    assert.equal(result.settings.alt_endpoint_url,other.alt_endpoint_url);
});
await test('model mismatch blocks writes',async()=>{
    activeModel='model-B';
    await assert.rejects(ctx.applyAndVerifyProfile('qdrant:llamacpp:alice',settings),/model mismatch/i);
    activeModel='model-A';
});
await test('unknown legacy collection remains read-only',async()=>{
    await assert.rejects(ctx.applyAndVerifyProfile('qdrant:llamacpp:legacy',settings),/no verified vectorization profile/i);
});
await test('backend mismatch blocks writes without changing saved profile',async()=>{
    await assert.rejects(ctx.applyAndVerifyProfile('qdrant:llamacpp:alice',{...settings,vector_backend:'standard'}),/backend/i);
});
const splitter=moduleInVM('core/embedding-overflow.js',{
    getProviderSpecificParams:providerParams,getRequestHeaders:()=>({'Content-Type':'application/json'}),fetch:mockFetch,
});
await test('short conversation pair is never split',async()=>{
    capabilityLimit=100;
    const items=[{text:'[User]: hello\n\n[Character]: hi',hash:15,metadata:{strategy:'conversation_turns',messageIds:[1,2]}}];
    const out=await splitter.prepareEmbeddingItems(items,settings,x=>x.length);
    assert.equal(out.length,1);assert.equal(out[0].text,items[0].text);
});
await test('overflow splits and preserves parent, message IDs, and section ordering',async()=>{
    capabilityLimit=12;
    const text='[User]: hello\n\n[Character]: one two three four five six seven eight nine ten eleven twelve thirteen';
    const out=await splitter.prepareEmbeddingItems([{text,hash:501,metadata:{strategy:'conversation_turns',messageIds:[4,5]}}],settings,x=>x.length);
    assert.ok(out.length>1);
    assert.ok(out.every((x,i)=>x.metadata.parentHash===501 && x.metadata.splitIndex===i && x.metadata.splitTotal===out.length));
    assert.ok(out.every(x=>x.metadata.messageIds.join(',')==='4,5'));
});
await test('single-message overflow can split without creating an unrelated message',async()=>{
    capabilityLimit=12;
    const out=await splitter.prepareEmbeddingItems([{text:'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen',hash:150,metadata:{strategy:'per_message',messageId:2}}],settings,x=>x.length);
    assert.ok(out.length>1);assert.ok(out.every(x=>x.metadata.messageId===2));
});
await test('actual capability can be increased without requiring profile migration',async()=>{
    capabilityLimit=4096;
    const p=ctx.getCollectionProfile('qdrant:llamacpp:alice');
    assert.equal(p.embedding.modelId,'model-A');
    assert.equal((await splitter.getEmbeddingBudget(settings))>1000,true);
});
await test('exclusive locks require chat AND character matching',async()=>{
    const source=fs.readFileSync(path.join(root,'core/collection-metadata.js'),'utf8');
    assert.match(source,/\(hasChatLocks && !chatAllowed\) \|\| \(hasCharacterLocks && !characterAllowed\)/);
});
await test('UI has requested scan button and blank disabled button',async()=>{
    const source=fs.readFileSync(path.join(root,'ui/ui-manager.js'),'utf8');
    assert.match(source,/id="vecthare_scan_chat"/);assert.match(source,/id="vecthare_future_action"[^>]*disabled/);
});
console.log(`\n${passes} P1 targeted tests passed`);

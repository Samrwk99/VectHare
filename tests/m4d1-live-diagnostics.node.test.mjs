import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=f=>fs.readFileSync(path.join(root,f),'utf8');
const providerSource=read('utils/diagnostic-provider-url.js');
const getUrl=vm.runInNewContext(providerSource.replace('export function','function')+'\ndiagnosticLlamaCppUrl', {URL});
const mockTextgen={server_urls:{LLAMACPP:'http://127.0.0.1:8766'}};
const settings={source:'llamacpp', use_alt_endpoint:false, llamacpp_url:'http://localhost:8080'};
const silent={log(){},warn(){},error(){}};
function fn(file,name,globals={}){
 const src=read(file);const re=new RegExp(`(?:export\\s+)?(?:async\\s+)?function ${name}\\(`);const m=re.exec(src);
 assert.ok(m,`${file} missing ${name}`);
 const end=src.indexOf('\n}\n',m.index);assert.ok(end>m.index);
 return vm.runInNewContext(src.slice(m.index,end+2).replace(/^export\s+/,'')+`\n${name}`,{console:silent,JSON,URL,...globals});
}
function providerParams(file,settingsValue,stUrl){
 const create=fn(file,'getPluginProviderParams',{
 diagnosticLlamaCppUrl:getUrl,
 textgen_types:{LLAMACPP:'LLAMACPP'},
 textgenerationwebui_settings:{server_urls:{LLAMACPP:stUrl}}
 });
 return create(settingsValue);
}
test('llama.cpp URL picks SillyTavern configured address, not hardcoded 8080',()=>{
 for (const file of ['diagnostics/production-tests.js','diagnostics/infrastructure.js']) {
  const result=providerParams(file,settings,'http://127.0.0.1:8766');
  assert.equal(result.apiUrl,'http://127.0.0.1:8766');
  assert.notEqual(result.apiUrl,'http://localhost:8080');
 }
});
test('llama.cpp diagnostics prioritise VectHare override and reject missing and invalid URL',()=>{
 for (const file of ['diagnostics/production-tests.js','diagnostics/infrastructure.js']) {
  assert.equal(providerParams(file,{...settings,use_alt_endpoint:true,alt_endpoint_url:'https://embedding.example:9934/base'},'http://127.0.0.1:8766').apiUrl,'https://embedding.example:9934/base');
  assert.throws(()=>providerParams(file,{source:'llamacpp',use_alt_endpoint:false,llamacpp_url:'http://localhost:8080'},undefined),/not configured/);
  assert.throws(()=>providerParams(file,{...settings,use_alt_endpoint:true,alt_endpoint_url:'file:\/\/private'},undefined),/HTTP\(S\)/);
 }
});
test('P19 embedding diagnostics use only server profile test and never browser URL or vector writes',async()=>{
 const calls=[];
 const run=fn('diagnostics/production-tests.js','testEmbeddingGeneration',{
  getRequestHeaders:()=>({'X-Test':'value'}),
  testEmbeddingProfile:async headers=>{calls.push(headers);return {status:'VECTOR_DIMENSION_VERIFIED',dimension:768};},
  fetch:async()=>{throw Error('legacy vector write must never be dispatched');}
 });
 const result=await run(settings);
 assert.equal(result.status,'pass');assert.equal(calls.length,1);
 assert.equal(calls[0]['X-Test'],'value');assert.match(result.message,/Database collection match and vector writes not tested/);
});
test('P19 missing profile is actionable, invalid provider response cannot pass',async()=>{
 const missing=fn('diagnostics/production-tests.js','testEmbeddingGeneration',{
  getRequestHeaders:()=>({}),testEmbeddingProfile:async()=>{throw Error('F09B5_PROFILE_NOT_CONFIGURED');}
 });
 const result=await missing(settings);assert.equal(result.status,'skipped');assert.match(result.message,/Configure/);
 const wrong=fn('diagnostics/production-tests.js','testEmbeddingGeneration',{
  getRequestHeaders:()=>({}),testEmbeddingProfile:async()=>({status:'TESTED',dimension:0})
 });
 assert.equal((await wrong(settings)).status,'fail');
});
test('retrieval tests actual backend query even when legacy full inventory is unsafe',async()=>{
 let called=0;
 const run=fn('diagnostics/production-tests.js','testVectorRetrieval',{
  getCurrentChatId:()=> 'chat',getChatCollectionId:()=> 'vecthare_chat_existing',
  getSavedHashes:()=>{throw Error('MUST NOT BE CALLED');},
  queryCollection:async()=>{called++;return {hashes:[1],metadata:[{type:'chat'}]}}
 });
 const result=await run({vector_backend:'qdrant'});
 assert.equal(result.status,'pass');assert.equal(called,1);
 assert.match(result.message,/does not certify/);
});
test('successful query with no matching results is a warning, not a false retrieval pass',async()=>{
 const run=fn('diagnostics/production-tests.js','testVectorRetrieval',{
  getCurrentChatId:()=> 'chat',getChatCollectionId:()=> 'vh:chat:valid',
  queryCollection:async()=>({hashes:[],metadata:[]})
 });
 const result=await run({vector_backend:'qdrant'});
 assert.equal(result.status,'warning');assert.match(result.message,/no vectors/);
});
test('chat vector count and duplicate checks show warning for unverified shared inventory',async()=>{
 const error=Object.assign(new Error('qdrant: shared-collection read unverified (authoritative-inventory-contract-unavailable)'),{code:'VECTHARE_E06_UNVERIFIED_READ'});
 const classification=e=>e?.code==='VECTHARE_E06_UNVERIFIED_READ';
 const base={getCurrentChatId:()=> 'chat',getChatCollectionId:()=> 'vecthare_chat_existing',getSavedHashes:async()=>{throw error},isUnverifiedInventoryRead:classification};
 const chat=fn('diagnostics/configuration.js','checkChatVectors',base);
 const duplicates=fn('diagnostics/production-tests.js','testDuplicateHashes',base);
 assert.equal((await chat({})).status,'warning');
 const d=await duplicates({});assert.equal(d.status,'warning');assert.equal(d.fixable,undefined);
});
test('fixture diagnostics label synthetic lorebook and hard-link cases',()=>{
 const src=read('diagnostics/activation-tests.js');
 assert.match(src,/Synthetic fixture \(not your live chat\/lorebook\)/);
 assert.match(src,/not a real broken link/);
});

/** Targeted P2 #35/36/37/38/39/41/42/43/45/46/51 safety regressions. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const src=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
let passed=0;
async function check(name,fn){await fn();passed++;console.log('PASS',name)}
await check('#35: capability cache is read, TTL-bound and keyed to embedding endpoint/model',()=>{
 const code=src('core/embedding-overflow.js');
 assert.match(code,/capabilityCache\.get\(key\)/);
 assert.match(code,/Date\.now\(\)-capabilities\.time >= CACHE_TTL_MS/);
 assert.match(code,/endpointKey\(settings\)/);
});
await check('#35: transient tokenizer failure is retried instead of permanently blacklisted',()=>{
 const code=src('core/embedding-overflow.js');
 assert.match(code,/TOKENIZER_RETRY_MS=120000/);
 assert.match(code,/Date\.now\(\)-unavailableAt<TOKENIZER_RETRY_MS/);
 assert.match(code,/tokenizersUnavailable\.delete\(providerKey\)/);
});
await check('#37: malformed plugin listing cannot become a confirmed empty collection',()=>{
 const code=src('backends/standard.js');
 assert.match(code,/!Array\.isArray\(result\.items\)/);
 assert.match(code,/result\.success === false/);
 assert.match(code,/response\.status !== 404 && response\.status !== 501/);
 assert.match(code,/Similharity chunk listing returned malformed or failed success data/);
});
await check('#41: all dynamic injection position tags are cleared before quiet generation',()=>{
 const code=src('core/chat-vectorization.js');
 const start=code.indexOf('export async function rearrangeChat('), end=code.indexOf("if (type === 'quiet')",start);
 assert.ok(start>=0&&end>start);
 assert.match(code.slice(start,end),/Object\.keys\(extension_prompts \|\| \{\}\)/);
 assert.match(code.slice(start,end),/for \(const tag of oldTags\) setExtensionPrompt\(tag, '', 0, 0, false\)/);
});
await check('#42 and #43: scorer and World Info accept valid numerical zero',()=>{
 for(const path of ['ui/ui-manager.js','core/core-vector-api.js','core/hybrid-search.js']){
  assert.doesNotMatch(src(path),/settings\.bm25_b \|\| 0\.75/);
 }
 assert.match(src('core/world-info-integration.js'),/settings\.world_info_threshold \?\? 0\.3/);
 assert.doesNotMatch(src('core/world-info-integration.js'),/settings\.world_info_threshold \|\| 0\.3/);
});
await check('#45: both activation and semantic lorebooks use authoritative classification',()=>{
 assert.match(src('core/collection-metadata.js'),/return !isLorebookCollection\(id\)/);
 const code=src('core/world-info-integration.js');
 assert.match(code,/if \(!isLorebookCollection\(collectionId\)\)/);
 assert.doesNotMatch(code,/if \(!collectionId\.includes\('lorebook'\)\)/);
});
await check('#46: exact lorebook name metadata takes precedence over lossy name slugs',()=>{
 const code=src('core/world-info-integration.js');
 const beginning=code.indexOf('function matchingLorebookKeys('), end=code.indexOf('\n/**',beginning+20);
 const fn=vm.runInNewContext(code.slice(beginning,end).replace('export function ', 'function ')+';isLorebookVectorized',{
  isLorebookCollection:key=>key.includes('lorebook_'),
  getCollectionMeta:key=>key.includes('one')?{sourceName:'One & Two'}:{sourceName:'One Two'},
  parseRegistryKey:key=>({collectionId:key}),String
 });
 assert.equal(fn('One & Two',{vecthare_collection_registry:['vecthare_lorebook_one_two_one']}),true);
 assert.equal(fn('One Two',{vecthare_collection_registry:['vecthare_lorebook_one_two_one']}),false);
 assert.match(code.slice(beginning,end),/meta\.sourceName === String\(lorebookName\)/);
 assert.match(code,/const matches=matchingLorebookKeys\(lorebookName,settings\)/);
});
await check('#46: lorebook stats resolve the saved qualified registry key, not a newly generated ID',async()=>{
 const code=src('core/world-info-integration.js');
 const start=code.indexOf('export async function getLorebookVectorStats(');
 const end=code.indexOf('\n// ============================================================================',start);
 const fn=vm.runInNewContext(code.slice(start,end).replace('export async function ', 'async function ')+';getLorebookVectorStats',{
   matchingLorebookKeys:()=>['qdrant:llamacpp:vecthare_lorebook_foo_123'],
   getCollectionMeta:()=>({sourceName:'Foo',chunkCount:12,createdAt:'2026-10-17',enabled:true,scope:'global'}),
   isCollectionEnabled:()=>true,
 });
 const data=await fn('Foo',{vecthare_collection_registry:['qdrant:llamacpp:vecthare_lorebook_foo_123']});
 assert.equal(data.collectionId,'qdrant:llamacpp:vecthare_lorebook_foo_123');
 assert.equal(data.chunkCount,12);
});
await check('#51: model partition controls escape backend model name/path and check actual inventory',()=>{
 const code=src('ui/database-browser.js');
 assert.match(code,/data-model-path="\$\{escapeHtml\(String\(model\.path/);
 assert.match(code,/\$\{escapeHtml\(String\(modelName\)\)\}/);
 assert.match(code,/if \(!modelInfo\) \{/);
 assert.match(code,/preferredModel: modelInfo\.path/);
});
await check('#36: pending deletion repair retains originating file and UUID throughout scheduling',()=>{
 const index=src('index.js'), repair=src('core/chat-repair.js');
 assert.match(index,/sourceChatUUID = getChatUUID\(\)/);
 assert.match(index,/pendingDeletionReconciliations/);
 assert.match(index,/pending\.sourceChatId=getCurrentChatId\(\)/);
 assert.match(index,/pending\.sourceChatId===sourceChatId/);
 assert.match(repair,/sourceChatUUID!==getChatUUID\(\)/);
 assert.match(repair,/Originating branch changed before deletion repair/);
});
await check('#38: model picker escapes injected html attributes and labels',()=>{
 const code=src('ui/database-browser.js');
 assert.match(code,/\$\{escapeHtml\(String\(model\.chunkCount\)\)\}/);
 assert.match(code,/\$\{escapeHtml\(String\(model\.path \?\? ""\)\)\}/);
});
await check('#39: endpoint URL blocks common credentials; recovery snapshot redacts them',()=>{
 const code=src('core/vectorization-profile.js');
 const block=code.slice(code.indexOf('export function assertPersistableEndpoint'),code.indexOf('\nfunction copySafe('));
 const fn=new Function(block.replace('export function ','function ')+';return assertPersistableEndpoint;')();
 for(const url of ['https://host/path?jwt=xyz','https://host/path?bearer=xyz',
  'https://host/path?refresh_token=x','https://host/path?session_token=x',
  'https://a:b@host/path'])assert.throws(()=>fn(url),/sensitive|credential/i,url);
 assert.doesNotThrow(()=>fn('https://host/embeddings?version=2'));
 assert.match(src('core/settings-durability.js'),/URL_SECRET=.*jwt\|bearer/);
 assert.match(src('core/settings-durability.js'),/\^jwt\$/);
 assert.match(src('core/vectorization-profile.js'),/assertPersistableEndpoint\(effective\.use_alt_endpoint/);
 assert.match(src('core/vectorization-profile.js'),/if\(!effective\.use_alt_endpoint\)delete chunking\.alt_endpoint_url/);
});
console.log(`${passed} focused P2 quick-batch checks passed`);

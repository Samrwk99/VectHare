/** Noncritical P2 security and backend contract regressions. No live ST required. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {escapeUntrustedHtml} from '../utils/safe-html.js';
const source = path => readFileSync(new URL('../'+path,import.meta.url),'utf8');
let passed=0;
async function test(name,check) {await check();passed++;console.log('PASS',name);}
await test('untrusted HTML and attribute values cannot create tags or attributes',()=>{
 const malicious='" onclick="run()"><img src=x onerror=alert(1)>&\'ignore';
 const escaped=escapeUntrustedHtml(malicious);
 assert.ok(!escaped.includes('<img'));
 assert.ok(!escaped.includes('" onclick'));
 assert.match(escaped,/&quot;/);
 assert.match(escaped,/&lt;img/);
 assert.match(escaped,/&amp;/);
});
await test('database backend error and external expression messages are escaped in HTML',()=>{
 const code=source('ui/database-browser.js');
 assert.match(code,/Search failed: \$\{escapeHtml\(String\(error\.message\)\)\}/);
 assert.match(code,/escapeHtml\(String\(expressionsStatus\.message\)\)/);
});
await test('diagnostics text and attributes are escaped, selectors match by dataset instead of interpolation',()=>{
 const code=source('ui/ui-manager.js');
 for(const key of ['check.name','check.message','check.fixAction','error.message'])
  assert.ok(code.includes(`escapeUntrustedHtml(${key})`) || code.includes(`escapeUntrustedHtml(${key} || '')`),key);
 assert.match(code,/element\.dataset\.fixAction === String\(check\.fixAction\)/);
 assert.doesNotMatch(code,/\$\(`\.diagnostic-item\[data-fix-action="\$\{/);
});
await test('health status renders backend names and remote errors safely',()=>{
 const code=source('ui/health-dashboard.js');
 assert.match(code,/escapeUntrustedHtml\(currentMetrics\.lastError\.message\)/);
 assert.match(code,/escapeUntrustedHtml\(name\)/);
 assert.match(code,/escapeUntrustedHtml\(currentBackend\)/);
});
await test('credential-bearing URLs including signed cloud URLs are refused before profile storage',()=>{
 const code=source('core/vectorization-profile.js');
 const text=code.slice(code.indexOf('export function assertPersistableEndpoint'),code.indexOf('\nfunction copySafe('));
 const probe=new Function(`${text.replace('export function ', 'function ')};return assertPersistableEndpoint;`)();
 for(const endpoint of ['https://example.com/path?api_key=abc','https://a.example/path?X-Amz-Signature=abc',
   'https://a.example/path?X-Goog-Credential=abc','https://a.example/path?apikey=abc',
   'https://joe:password@example.com/v1'])
  assert.throws(()=>probe(endpoint),/credential|sensitive/i,endpoint);
 assert.doesNotThrow(()=>probe('https://a.example/v1/embeddings?batch=1'));
});
await test('only verified embedding input limit or explicit override authorizes a split',()=>{
 const code=source('core/embedding-overflow.js');
 assert.match(code,/const verifiedMax=Number\.isSafeInteger\(serverMax\)/);
 assert.doesNotMatch(code,/manual\|\|published/);
});
await test('hybrid search rejects inconsistent hash and metadata arrays',()=>{
 assert.match(source('core/hybrid-search.js'),/vectorResults\.hashes\.length !== vectorResults\.metadata\.length/);
});
await test('scoped keyword inventory scans every Qdrant cursor page and counts only verified rows',async()=>{
 const {countCollectionKeywords}=await import('../core/keyword-inventory.js');
 const calls=[];
 const backend={listChunks:async(key,settings,opts)=>{
  calls.push({key,settings,opts});
  return opts.cursor==null?{items:[{hash:'a',metadata:{keywords:['Echo',{text:'Foo'}]}}],nextCursor:'next',pageMode:'cursor'}:
   {items:[{hash:'b',metadata:{keywords:['echo']}}],nextCursor:null,pageMode:'cursor'};
 }};
 const result=await countCollectionKeywords(backend,'qdrant:provider:chatA',{vector_backend:'qdrant',qdrant_multitenancy:true});
 assert.equal(result.get('echo'),2);
 assert.equal(result.get('foo'),1);
 assert.equal(calls.length,2);
 assert.ok(calls.every(c=>c.key==='qdrant:provider:chatA'));
});
await test('keyword inventory rejects failed, malformed and truncated pages',async()=>{
 const {countCollectionKeywords}=await import('../core/keyword-inventory.js');
 const base={vector_backend:'qdrant'};
 await assert.rejects(countCollectionKeywords({listChunks:async()=>{throw Error('HTTP 503')}},'a',base),/503/);
 await assert.rejects(countCollectionKeywords({listChunks:async()=>({items:[],nextCursor:1})},'a',base),/cursor endpoint/);
 const backend={listChunks:async()=>({items:[{hash:'x',metadata:{keywords:[]}}],pageMode:'cursor',nextCursor:1})};
 await assert.rejects(countCollectionKeywords(backend,'a',base),/cursor repeated/);
 const many={listChunks:async()=>({items:[{hash:'a',metadata:{keywords:[]}},{hash:'b',metadata:{keywords:[]}}],total:2})};
 await assert.rejects(countCollectionKeywords(many,'a',{vector_backend:'standard'},{maxItems:1}),/safety limit/);
});
await test('database keyword browser routes via saved per-collection profile, not direct raw plugin calls',()=>{
 const ui=source('ui/database-browser.js');
 assert.match(ui,/settingsForCollectionQuery\(key, browserState\.settings\)/);
 assert.match(ui,/await countCollectionKeywords\(backend, key, effective\)/);
 assert.match(ui,/getCollectionConfiguration\(key\)\.originalProfile/);
});
console.log(`${passed} P2 noncritical hardening checks passed`);

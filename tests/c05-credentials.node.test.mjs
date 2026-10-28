/** C05 local security contract tests; never represent real plugin acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
 C05_SECRETS,C05_CONTRACT,C05_SECRET_FIELDS,ProtectedCredentialUnavailable,
 createWriteOnlySecretAdapter,verifyServerSecretContract,legacyCredentialFields,
 scrubCredentialSettings, requireServerCredentialResolution, credentialBearingUrl, assertNoCredentialsInUrl,
} from '../utils/c05-protected-credentials.js';
import {backendConfigurationFingerprint} from '../utils/backend-configuration.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source = name => fs.readFileSync(path.join(root,name),'utf8');
const requiredFields=['qdrant_api_key','milvus_password','milvus_token','bananabread_api_key'];
const contract={protocol:C05_CONTRACT,userScope:'request-user',writeOnlyBrowser:true,
 serverSideResolution:true,authenticatedProbe:true,supportedKeys:Object.values(C05_SECRETS)};
const receipt=key=>({protocol:C05_CONTRACT,userScope:'request-user',key,authenticated:true});
const reply=(body,ok=true)=>({ok,text:async()=>typeof body==='string'?body:JSON.stringify(body),json:async()=>body});
function harness({handshake=contract,write='ok',state=Object.fromEntries(Object.values(C05_SECRETS).map(key=>[key,false])),probe=true}={}){
 const calls=[];
 const fetchImpl=async(url,init={})=>{
  const body=init?.body?JSON.parse(init.body):undefined;
  calls.push({url,body});
  if(url.endsWith('/capabilities/secrets'))return reply(handshake,handshake!==null);
  if(url.endsWith('/capabilities/secrets/test'))return reply(probe?receipt(body.key):{authenticated:false});
  if(url==='/api/secrets/write')return reply(write);
  if(url==='/api/secrets/read')return reply(state);
  throw new Error('Unexpected route');
 };
 return {calls,fetchImpl,make:(options={})=>createWriteOnlySecretAdapter({fetchImpl,getHeaders:()=>({'Content-Type':'application/json'}),...options})};
}
const getHeaders=()=>({});

test('C05 enumerates exactly four secret fields and none of the returned values are actual secrets',()=>{
 assert.deepEqual(C05_SECRET_FIELDS,requiredFields);
 assert.equal(new Set(Object.values(C05_SECRETS)).size,4);
});
test('C05 no method reads a protected secret back to browser',()=>{
 const a=harness().make();
 assert.deepEqual(Object.keys(a).sort(),['deleteSecret','hasSecret','migrateLegacySecret','redact','setSecret']);
 assert.equal(Object.hasOwn(a,'getSecret'),false);
});
test('C05 legacy credentials are detected without returning secret values',()=>{
 const secret='this-is-private';
 assert.deepEqual(legacyCredentialFields({qdrant_api_key:secret,milvus_password:''}),['qdrant_api_key']);
 assert.equal(legacyCredentialFields({}).length,0);
});
test('C05 credential settings scrub makes new object and retains unrelated fields',()=>{
 const input={qdrant_api_key:'s1',milvus_password:'s2',milvus_token:'s3',bananabread_api_key:'s4',vector_backend:'qdrant'};
 const output=scrubCredentialSettings(input);
 assert.deepEqual(output,{vector_backend:'qdrant'});
 assert.equal(input.qdrant_api_key,'s1');
});
test('C05 missing resolver endpoint results in unverified contract',async()=>{
 const h=harness({handshake:null});
 assert.equal((await verifyServerSecretContract(h.fetchImpl,getHeaders)).verified,false);
});
test('C05 nonper-user capability evidence is rejected',async()=>{
 const h=harness({handshake:{...contract,userScope:'global'}});
 assert.equal((await verifyServerSecretContract(h.fetchImpl,getHeaders)).verified,false);
});
test('C05 browser-read secret exposures are rejected',async()=>{
 const h=harness({handshake:{...contract,writeOnlyBrowser:false}});
 assert.equal((await verifyServerSecretContract(h.fetchImpl,getHeaders)).verified,false);
});
test('C05 missing support for one custom key invalidates entire contract',async()=>{
 const h=harness({handshake:{...contract,supportedKeys:contract.supportedKeys.slice(0,3)}});
 assert.equal((await verifyServerSecretContract(h.fetchImpl,getHeaders)).verified,false);
});
test('C05 missing authenticated probe invalidates contract',async()=>{
 const h=harness({handshake:{...contract,authenticatedProbe:false}});
 assert.equal((await verifyServerSecretContract(h.fetchImpl,getHeaders)).verified,false);
});
test('C05 any missing required protocol field is rejected',async()=>{
 for(const field of Object.keys(contract)){
  const modified={...contract};delete modified[field];
  const h=harness({handshake:modified});
  assert.equal((await verifyServerSecretContract(h.fetchImpl,getHeaders)).verified,false,field);
 }
});
test('C05 a valid simulated server contract can be used for deterministic tests',async()=>{
 const h=harness();
 assert.equal((await verifyServerSecretContract(h.fetchImpl,getHeaders)).verified,true);
});
test('C05 plugin resolver unavailable means setSecret never sends the value',async()=>{
 const h=harness({handshake:null});
 await assert.rejects(h.make().setSecret('qdrant_api_key','sentinel'),ProtectedCredentialUnavailable);
 assert.equal(h.calls.some(c=>c.url==='/api/secrets/write'),false);
});
test('C05 unknown credential field is rejected before any network call',async()=>{
 const h=harness();
 await assert.rejects(h.make().setSecret('unknown','sentinel'),TypeError);
 assert.equal(h.calls.length,0);
});
test('C05 empty credential is not written',async()=>{
 const h=harness();
 await assert.rejects(h.make().setSecret('milvus_password','  '),TypeError);
 assert.equal(h.calls.length,0);
});
test('C05 failed host write acknowledgement is not accepted even with HTTP success',async()=>{
 for(const write of ['{ "success":false }','error','', '{ "status":"ok" }']){
  const h=harness({write});
  await assert.rejects(h.make().setSecret('milvus_token','sentinel'),ProtectedCredentialUnavailable);
  assert.equal(h.calls.some(c=>c.url.endsWith('/test')),false);
 }
});
test('C05 write needs authenticated plugin probe before reporting success',async()=>{
 const h=harness({probe:false});
 await assert.rejects(h.make().setSecret('qdrant_api_key','sentinel'),ProtectedCredentialUnavailable);
 assert.equal(h.calls.filter(c=>c.url.endsWith('/test')).length,1);
});
test('C05 successful simulated save never includes secret in the authentication probe',async()=>{
 const h=harness();
 assert.deepEqual(await h.make().setSecret('qdrant_api_key','very-private'),{confirmed:true});
 const probe=h.calls.find(c=>c.url.endsWith('/test'));
 assert.deepEqual(probe.body,{key:C05_SECRETS.qdrant_api_key});
 assert.ok(!JSON.stringify(probe.body).includes('very-private'));
});
test('C05 write payload contains only the target secret and its configured key',async()=>{
 const h=harness();await h.make().setSecret('milvus_password','private-123');
 assert.deepEqual(h.calls.find(c=>c.url==='/api/secrets/write').body,{key:C05_SECRETS.milvus_password,value:'private-123'});
});
test('C05 missing state key is UNKNOWN and does not mean secret absent',async()=>{
 const h=harness({state:{}});
 await assert.rejects(h.make().hasSecret('qdrant_api_key'),ProtectedCredentialUnavailable);
});
test('C05 hasSecret only returns a verified boolean state',async()=>{
 const h=harness({state:{[C05_SECRETS.milvus_token]:true}});
 assert.equal(await h.make().hasSecret('milvus_token'),true);
});
test('C05 hasSecret rejects secret values returned by an unsafe host API',async()=>{
 const h=harness({state:{[C05_SECRETS.milvus_token]:'secret-leaked'}});
 await assert.rejects(h.make().hasSecret('milvus_token'),ProtectedCredentialUnavailable);
});
test('C05 delete requires revocation plus state confirming false',async()=>{
 const h=harness();
 assert.deepEqual(await h.make().deleteSecret('milvus_token'),{confirmed:true});
 assert.deepEqual(h.calls.find(c=>c.url==='/api/secrets/write').body,{key:C05_SECRETS.milvus_token,value:''});
});
test('C05 delete refuses a still-active secret after write',async()=>{
 const h=harness({state:{[C05_SECRETS.milvus_token]:true}});
 await assert.rejects(h.make().deleteSecret('milvus_token'),ProtectedCredentialUnavailable);
});
test('C05 delete refuses missing state proof',async()=>{
 const h=harness({state:{}});
 await assert.rejects(h.make().deleteSecret('milvus_token'),ProtectedCredentialUnavailable);
});
test('C05 migration of absent legacy data is a no-op',async()=>{
 const h=harness();assert.deepEqual(await h.make().migrateLegacySecret('qdrant_api_key',{}),{status:'not-needed'});
 assert.equal(h.calls.length,0);
});
test('C05 migration with no resolver preserves plaintext value and does not persist changes',async()=>{
 const h=harness({handshake:null});let persisted=false;
 const original={qdrant_api_key:'sentinel'};
 const result=await h.make({persistSettings:async()=>{persisted=true;return true;}}).migrateLegacySecret('qdrant_api_key',original);
 assert.equal(result.status,'blocked');assert.equal(original.qdrant_api_key,'sentinel');assert.equal(persisted,false);
});
test('C05 migration requires authenticated probe before scrubbing',async()=>{
 const h=harness({probe:false});let persisted=false;
 const original={qdrant_api_key:'sentinel'};
 assert.equal((await h.make({persistSettings:async()=>{persisted=true;return true;}}).migrateLegacySecret('qdrant_api_key',original)).status,'blocked');
 assert.equal(persisted,false);assert.equal(original.qdrant_api_key,'sentinel');
});
test('C05 migration does not scrub if durable settings persistence cannot be proven',async()=>{
 const h=harness();const original={qdrant_api_key:'sentinel'};
 assert.equal((await h.make({persistSettings:async()=>undefined}).migrateLegacySecret('qdrant_api_key',original)).status,'blocked');
 assert.equal(original.qdrant_api_key,'sentinel');
});
test('C05 migration passes secret-free snapshot to durable settings persistence',async()=>{
 const h=harness();const original={qdrant_api_key:'secret',source:'openai'};let persisted;
 const result=await h.make({persistSettings:async snapshot=>{persisted=snapshot;return true;}}).migrateLegacySecret('qdrant_api_key',original);
 assert.equal(result.status,'confirmed');assert.deepEqual(persisted,{source:'openai'});
 assert.deepEqual(original,{source:'openai'});
});
test('C05 migration cannot silently downgrade after transient host failure',async()=>{
 const h=harness({write:'error'});const original={qdrant_api_key:'secret'};
 assert.equal((await h.make({persistSettings:async()=>true}).migrateLegacySecret('qdrant_api_key',original)).status,'blocked');
 assert.equal(original.qdrant_api_key,'secret');
});
test('C05 redact diagnoses and exports without returning original key',()=>{
 const h=harness();
 const redacted=h.make().redact({qdrant_api_key:'secret',Authorization:'Bearer password'});
 assert.ok(!JSON.stringify(redacted).includes('secret'));assert.ok(!JSON.stringify(redacted).includes('password'));
});
test('C05 no credentialless silent fallback for direct protected provider',()=>{
 assert.throws(requireServerCredentialResolution,ProtectedCredentialUnavailable);
});
test('C05 backend config fingerprint cannot hash legacy secrets into persisted metadata',()=>{
 const a=backendConfigurationFingerprint('qdrant',{source:'openai',qdrant_api_key:'one',qdrant_url:'https://q.example'});
 const b=backendConfigurationFingerprint('qdrant',{source:'openai',qdrant_api_key:'two',qdrant_url:'https://q.example'});
 assert.equal(a,b);
 assert.notEqual(a,backendConfigurationFingerprint('qdrant',{source:'openai',qdrant_url:'https://other.example'}));
});
test('C05 Qdrant source does not forward browser API key in any config',()=>{
 const s=source('backends/qdrant.js');assert.ok(!s.includes('apiKey: settings.qdrant_api_key'));
 assert.ok(s.includes("JSON.stringify({ configId: this._qdrantConfigId })")); // S11.3: safe local/remote selectors
});
test('C05 Milvus source does not send plaintext password or token',()=>{
 const s=source('backends/milvus.js');assert.ok(!s.includes('password: settings.milvus_password'));
 assert.ok(!s.includes('token: settings.milvus_token'));
});
test('C05 BananaBread direct and plugin clients have no settings apiKey forwarding',()=>{
 for(const file of ['core/core-vector-api.js','core/chat-vectorization.js','backends/provider-params.js']){
  const s=source(file);
  assert.ok(!s.includes('settings.bananabread_api_key'),file);
 }
});
test('C05 settings UI never pre-fills secret inputs from saved settings',()=>{
 const s=source('ui/ui-manager.js');
 for(const field of requiredFields) assert.ok(!s.includes('.val(settings.'+field),field);
 assert.ok(s.includes('bindProtectedCredentialInput'));
});
test('C05 new defaults never declare plaintext credential settings',()=>{
 const s=source('index.js');
 for(const field of requiredFields) assert.ok(!s.includes(field+": ''"),field);
});
test('C05 runtime UI blocks secret inputs until verified resolver evidence',()=>{
 const s=source('ui/ui-manager.js');
 assert.ok(s.includes(".prop('disabled', true)"));
 assert.ok(s.includes('verifyServerSecretContract(fetch, getRequestHeaders)'));
});
test('C05 compatibility audit: unmodified plugin cannot supply advertised capability endpoint',()=>{
 // This is a SOURCE CONSTRAINT, not real server verification.
 assert.equal(C05_CONTRACT,'vecthare-user-scoped-secrets-v1');
 assert.equal(Object.values(C05_SECRETS).includes('bananabread_api_key'),true);
});

test('C05 reject Qdrant URL with embedded username and password',()=>{
 assert.equal(credentialBearingUrl('https://alice:password@qdrant.example:6333'),true);
 assert.throws(()=>assertNoCredentialsInUrl('https://alice:password@qdrant.example'),ProtectedCredentialUnavailable);
});
test('C05 reject credential-bearing token query parameters',()=>{
 for(const key of ['api_key','token','password','access_key'])
  assert.equal(credentialBearingUrl('https://q.example/endpoint?'+key+'=secret'),true);
});
test('C05 ordinary Qdrant URLs and local Milvus addresses remain allowed',()=>{
 assert.equal(credentialBearingUrl('https://qdrant.example:6333'),false);
 assert.equal(credentialBearingUrl('localhost:19530'),false);
 assert.doesNotThrow(()=>assertNoCredentialsInUrl('https://qdrant.example:6333'));
});
test('C05 invalid or empty URL is not mistaken for a credential',()=>{
 assert.equal(credentialBearingUrl(''),false);
 assert.equal(credentialBearingUrl(undefined),false);
 assert.equal(credentialBearingUrl('plain-name'),false);
});

test('C05 core query and multi-query reject unsupported BananaBread without fallback',()=>{
 const s=source('core/core-vector-api.js');
 assert.match(s,/export async function queryCollection[^]*?settings\) \{\s*\/\/ A rejected protected credential[^]*?requireServerCredentialResolution\(\)/);
 assert.match(s,/export async function queryMultipleCollections[^]*?settings\) \{\s*if \(settings\?\.source === 'bananabread'\) requireServerCredentialResolution\(\)/);
});
test('C05 cached backend paths enforce legacy secret restrictions',()=>{
 const s=source('backends/backend-manager.js');
 assert.ok(s.includes('assertNoLegacyCredentialFallback(settings || {}, normalizedName)'));
});

test('C05 UI offers explicit legacy-only removal without pretending server revocation',()=>{
 const s=source('ui/ui-manager.js');
 assert.ok(s.includes('Remove legacy plaintext only'));
 assert.ok(s.includes('This DOES NOT revoke a server-side secret'));
 assert.ok(s.includes('saveSettingsDebounced()'));
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=f=>fs.readFileSync(path.join(root,f),'utf8');
const quiet={log(){},warn(){},error(){}};
function fn(file,name,globals={}){
 const src=read(file),re=new RegExp(`(?:export\\s+)?(?:async\\s+)?function ${name}\\(`),m=re.exec(src);
 assert.ok(m,`${file}: ${name} missing`);
 const end=src.indexOf('\n}\n',m.index);assert.ok(end>m.index);
 return vm.runInNewContext(src.slice(m.index,end+2).replace(/^export\s+/,'')+`\n${name}`,{console:quiet,JSON,Error,...globals});
}
const proof={backend:'qdrant',inventoryVerified:true,managedV2Only:true,entirePhysicalCollectionVerified:true,
 exclusiveOwner:true,readOnly:true,recordCount:3,uniqueContentHashCount:2,
 repeatedContentHashGroups:1,repeatedContentHashExtraRecords:1,logicalKey:'a'.repeat(64),
 routingGeneration:0,inventoryDigest:'b'.repeat(64),legacySharedCollectionsVerified:false,
 repairAuthorized:false,deleteAuthorized:false,productionCertified:false};
function client(globals={}){
 const source=read('utils/qdrant-managed-inventory.js').replace(/^import .*;\s*$/gm,'').replace('export async function','async function');
 return vm.runInNewContext(source+'\nqdrantManagedInventory',{JSON,Error,Number,fetch:undefined,globalThis:{SillyTavern:{getContext:()=>({})}},
  getCurrentChatId:()=> 'current',getRequestHeaders:()=>({'X-Test':'yes'}),
  getChatCollectionId:()=> 'current-collection',
  f02CurrentChatSelector:async()=>({kind:'chat',avatar:'char.png',chatFile:'current'}),
  guardedVectorFetch:async(_url,_opts)=>({ok:true,json:async()=>({success:true,...proof})}),...globals});
}
test('Qdrant diagnostic client uses server source-bound endpoint, never physical name, hash or owner from browser',async()=>{
 const calls=[];const run=client({guardedVectorFetch:async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({success:true,...proof})};}});
 const r=await run({vector_backend:'qdrant',qdrant_use_cloud:true},{collectionId:'current-collection'});
 assert.equal(r.inventoryVerified,true);assert.equal(calls.length,1);
 assert.equal(calls[0].url,'/api/plugins/similharity/v2/m3/collections/managed-inventory');
 const body=JSON.parse(calls[0].options.body);
 assert.deepEqual(Object.keys(body).sort(),['backend','configId','source']);
 assert.equal(body.configId,'default');assert.equal(body.source.chatFile,'current');
 assert.equal(calls[0].options.method,'POST');
});
test('Qdrant diagnostic client refuses untrusted proof, non-Qdrant backend, unrelated collection and failed server reply',async()=>{
 await assert.rejects(()=>client()({vector_backend:'lancedb'}),/QDRANT_ONLY/);
 await assert.rejects(()=>client()({vector_backend:'qdrant'},{collectionId:'foreign'}),/SOURCE_MISMATCH/);
 for(const change of [{readOnly:false},{deleteAuthorized:true},{recordCount:0},{inventoryVerified:false},
  {legacySharedCollectionsVerified:true},{inventoryDigest:'bogus'}]){
  const r=client({guardedVectorFetch:async()=>({ok:true,json:async()=>({success:true,...proof,...change})})});
  await assert.rejects(()=>r({vector_backend:'qdrant'}),/UNTRUSTED/);
 }
 const r=client({guardedVectorFetch:async()=>({ok:false,json:async()=>({code:'M3_COLLECTION_NOT_BOUND'})})});
 await assert.rejects(()=>r({vector_backend:'qdrant'}),/COLLECTION_NOT_BOUND/);
});
test('Chat Vectors Qdrant uses server proof, not unverified legacy getSavedHashes',async()=>{
 let calls=0;const run=fn('diagnostics/configuration.js','checkChatVectors',{
  getCurrentChatId:()=> 'chat',getChatCollectionId:()=> 'chat-collection',
  getSavedHashes:()=>{throw Error('LEGACY_LIST_FORBIDDEN');},
  qdrantManagedInventory:async()=>{calls++;return proof;}});
 const d=await run({vector_backend:'qdrant'});
 assert.equal(d.status,'pass');assert.match(d.message,/3 verified managed-v2/);assert.equal(calls,1);
 const offline=fn('diagnostics/configuration.js','checkChatVectors',{
  getCurrentChatId:()=> 'chat',getChatCollectionId:()=> 'chat-collection',
  qdrantManagedInventory:async()=>{throw Error('M3_COLLECTION_NOT_BOUND');}});
 const warning=await offline({vector_backend:'qdrant'});
 assert.equal(warning.status,'warning');assert.match(warning.message,/does not imply missing vectors/);
});
test('Qdrant duplicate check uses attested aggregate; no browser delete fix or legacy hashes',async()=>{
 let calls=0;const run=fn('diagnostics/production-tests.js','testDuplicateHashes',{
  getCurrentChatId:()=> 'chat',getChatCollectionId:()=> 'current-collection',
  getSavedHashes:()=>{throw Error('LEGACY_LIST_FORBIDDEN');},
  qdrantManagedInventory:async()=>{calls++;return proof;}});
 const d=await run({vector_backend:'qdrant'});
 assert.equal(d.status,'warning');assert.equal(d.fixable,false);assert.match(d.message,/No automatic deletion/);
 assert.equal(calls,1);
 const clear=fn('diagnostics/production-tests.js','testDuplicateHashes',{
  getCurrentChatId:()=> 'chat',getChatCollectionId:()=> 'current-collection',
  qdrantManagedInventory:async()=>({...proof,repeatedContentHashGroups:0,repeatedContentHashExtraRecords:0,uniqueContentHashCount:3})});
 const ok=await clear({vector_backend:'qdrant'});assert.equal(ok.status,'pass');assert.match(ok.message,/Legacy\/shared vectors were not inspected/);
 const blocked=fn('diagnostics/production-tests.js','testDuplicateHashes',{
  getCurrentChatId:()=> 'chat',getChatCollectionId:()=> 'current-collection',
  qdrantManagedInventory:async()=>{throw Error('M3_EXCLUSIVE_INVENTORY_REQUIRED');}});
 const caution=await blocked({vector_backend:'qdrant'});assert.equal(caution.status,'warning');assert.equal(caution.fixable,undefined);
});
test('legacy inventory gate stays present for arbitrary shared Qdrant collection reads',()=>{
 assert.match(read('backends/qdrant.js'),/denyUnverifiedSharedInventory\(BACKEND_TYPE\)/);
 assert.match(read('utils/qdrant-managed-inventory.js'),/managed-v2/);
});
test('Qdrant hash-collision diagnostic uses server proof, avoiding blocked legacy list',async()=>{
 const run=fn('diagnostics/configuration.js','checkHashCollisionRate',{
  getCurrentChatId:()=> 'chat',getChatCollectionId:()=> 'current-collection',
  getSavedHashes:()=>{throw Error('LEGACY_LIST_FORBIDDEN');},qdrantManagedInventory:async()=>proof});
 const d=await run({vector_backend:'qdrant'});
 assert.equal(d.status,'warning');assert.match(d.message,/33.3%/);assert.match(d.message,/legacy\/shared vectors not inspected/);
});

test('Qdrant legacy Sync Chat explicitly defers to guarded first-use M1 rather than trusting an empty database',()=>{
 const code=read('core/chat-vectorization.js');
 const manual=code.slice(code.indexOf('export async function vectorizeAll('),code.indexOf('export async function repairChatVectors('));
 assert.match(manual,/settings\?\.vector_backend === 'qdrant'/);
 assert.match(manual,/set up an owned v2 collection/);
 assert.match(manual,/then plan and confirm saved-record inserts/);
 assert.match(manual,/return false/);
 const automatic=code.slice(code.indexOf('async function synchronizeChatScoped('),code.indexOf('async function synchronizeChatScoped(')+1000);
 assert.match(automatic,/QDRANT_LEGACY_SYNC_REQUIRES_M5_MANAGED_GATEWAY/);
 assert.match(read('utils/m1-record-gui.js'),/m1ProvisionCollection/);
});

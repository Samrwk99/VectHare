import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inspectVectorRequest,guardedVectorFetch,VectorOperationDenied} from '../utils/e02-vector-request-gateway.js';
import {S11_EXPECTED_PLUGIN, validateS11Discovery,discoverS11Plugin,s11PluginStatus,resetS11DiscoveryForTests} from '../utils/s11-plugin-compatibility.js';
import {observeChatFork,S11_CHAT_OBSERVATION_KEY} from '../utils/s11-chat-fork-observer.js';
const root='/api/plugins/similharity';
function reports(){
 const build={pluginVersion:S11_EXPECTED_PLUGIN.pluginVersion, contractVersion:2,sourceFingerprint:S11_EXPECTED_PLUGIN.sourceFingerprint,verification:'MATCHED_LOCAL_SOURCE_MANIFEST'};
 const operations=Object.fromEntries(['insert','delete','updateText','updateMetadata','operationSubmit'].map(v=>[v,'DENIED_NOT_LIVE_CERTIFIED']));
 const caps={...build,buildVerification:build.verification,capabilityClaimsArePermissions:false,productionCertified:false,publicV2MutationsEnabled:false,publicV2ReadsEnabled:false,publicV2ReadRoutesAvailable:true,guardedNewCollectionProvisioningAvailable:true,experimentalQdrantPilotMutationsAvailable:true,extendedQdrantDisposableAcceptanceAvailable:true,disposableLanceDBAcceptanceAvailable:true,sourceBoundLanceDBProvisioningAvailable:true,experimentalLanceDBPilotMutationsAvailable:true,sourceBoundVectraProvisioningAvailable:true,experimentalVectraPilotMutationsAvailable:true,disposableVectraAcceptanceAvailable:true,sourceBoundMilvusProvisioningAvailable:true,experimentalMilvusPilotMutationsAvailable:true,disposableMilvusAcceptanceAvailable:true,f10NonAuthoritativeEvidenceCaptureAvailable:true,backends:Object.fromEntries(['standard','lancedb','qdrant','milvus'].map(b=>[b,{operations}]))};
 const contracts={contractVersion:2,executionCertified:false,routes:{'POST /v2/operations/submit':'DENIED','POST /v2/reads/get':'GUARDED_F02_HOST_SOURCE_V2_SCHEMA_ONLY',
 'POST /v2/collections/preview':'F03_SOURCE_BOUND_NEW_COLLECTION_PREVIEW_ONLY',
 'POST /v2/collections/provision':'F03_EXPLICIT_SOURCE_BOUND_EMPTY_SCHEMA_CREATION_UNCERTIFIED',
 'POST /v2/collections/status':'F03_SOURCE_BOUND_PROVISION_RECEIPT_ONLY',
 'POST /v2/records/pilot-mutate':'F04_DISPOSABLE_QDRANT_CONSENTED_V2_RECORDS_UNCERTIFIED',
 'POST /v2/diagnostics/qdrant-f05':'F05_EXTENDED_LOCAL_QDRANT_DISPOSABLE_ACCEPTANCE_NOT_PRODUCTION',
 'POST /v2/diagnostics/lancedb-f06':'F06_LOCAL_LANCEDB_DISPOSABLE_ACCEPTANCE_NOT_PRODUCTION',
 'POST /v2/records/lancedb-pilot-mutate':'F06_SOURCE_BOUND_LANCEDB_LOCAL_PILOT_NOT_PRODUCTION',
 'POST /v2/diagnostics/vectra-f07':'F07_LOCAL_VECTRA_DISPOSABLE_ACCEPTANCE_NOT_PRODUCTION',
 'POST /v2/records/vectra-pilot-mutate':'F07_SOURCE_BOUND_LOCAL_PLUGIN_VECTRA_PILOT_NOT_NATIVE_STANDARD',
 'POST /v2/workflows/preview':'F09_SOURCE_BOUND_V2_CANDIDATE_PREVIEW_ONLY',
 'POST /v2/recovery/capture':'F10_TWO_PASS_SCOPED_EVIDENCE_NOT_FULL_BACKUP',
 'POST /v2/recovery/status':'F10_CHECKSUM_AND_SOURCE_BOUND_RECEIPT_ONLY',
 'POST /v2/recovery/download':'F10_NONAUTHORITATIVE_EVIDENCE_DOWNLOAD_ONLY',
 'POST /v2/diagnostics/milvus-f08':'F08_DISPOSABLE_MILVUS_ACCEPTANCE_NOT_PRODUCTION',
 'POST /v2/records/milvus-pilot-mutate':'F08_SOURCE_BOUND_LOCAL_MILVUS_PILOT_NOT_PRODUCTION'}};
 return {build,caps,contracts};
}
const stub=reports();
const store=()=>{const data=new Map();return {getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),data};};
test('S11 matching S10 inspection never claims certified writes or reads',()=>{
 const status=validateS11Discovery(stub.build,stub.caps,stub.contracts);
 assert.equal(status.compatible,true);assert.equal(status.readiness,'GUARDED_F02_READ_ONLY');assert.equal(status.writeEnabled,false);assert.equal(status.publicV2ReadsEnabled,false);assert.equal(status.hostAttested,false);
});
for(const property of ['pluginVersion','sourceFingerprint','verification'])test(`S11 rejects altered build ${property}`,()=>{
 const mutated={...stub.build,[property]:'forged'};
 assert.equal(validateS11Discovery(mutated,stub.caps,stub.contracts).compatible,false);
});
test('S11 refuses optimistic plugin capability or route responses',()=>{
 assert.equal(validateS11Discovery(stub.build,{...stub.caps,publicV2MutationsEnabled:true},stub.contracts).compatible,false);
 assert.equal(validateS11Discovery(stub.build,stub.caps,{...stub.contracts,routes:{...stub.contracts.routes,'POST /v2/reads/get':'ALLOWED'}}).compatible,false);
 assert.equal(validateS11Discovery(stub.build,{...stub.caps,backends:{...stub.caps.backends,qdrant:{operations:{...stub.caps.backends.qdrant.operations,insert:'ALLOWED'}}}},stub.contracts).compatible,false);
});
test('S11 discovery uses only three authenticated same-origin GETs',async()=>{
 resetS11DiscoveryForTests();let calls=[];
 const map={'/v2/build':stub.build,'/v2/capabilities':stub.caps,'/v2/contracts':stub.contracts};
 const result=await discoverS11Plugin({fetchImpl:async(u,o)=>{calls.push({u,o});return {ok:true,json:async()=>map[u.slice(root.length)]};}});
 assert.equal(result.compatible,true);
 assert.equal(calls.length,3);
 assert.ok(calls.every(({o})=>o.method==='GET'&&o.credentials==='same-origin'&&o.body===undefined));
 assert.equal(s11PluginStatus().readiness,'GUARDED_F02_READ_ONLY');
});
test('S11 failed discovery is conservative and never reuses prior success',async()=>{
 const result=await discoverS11Plugin({fetchImpl:async()=>{throw new Error('offline');}});
 assert.equal(result.compatible,false);assert.equal(s11PluginStatus().readiness,'BLOCKED');
});
for(const path of ['/v2/operations/submit','/v2/operations/reconcile','/v2/reads/get','/v2/reads/query','/v2/records/insert','/v2/collections/clear'])test(`S11 ${path} denied before network`,async()=>{
 let count=0;
 assert.throws(()=>guardedVectorFetch(root+path,{method:'POST',body:'{}'},async()=>{count++;return {ok:true};}),VectorOperationDenied);
 assert.equal(count,0);
});
for(const path of ['/v2/build','/v2/capabilities','/v2/contracts','/capabilities'])test(`S11 ${path} is GET only`,()=>{
 assert.equal(inspectVectorRequest(root+path,{method:'GET'}).allowed,true);
 assert.throws(()=>inspectVectorRequest(root+path,{method:'POST'}),VectorOperationDenied);
 assert.throws(()=>inspectVectorRequest(root+path,{method:'GET',body:'{}'}),VectorOperationDenied);
});
test('S11 unknown v2 paths cannot bypass legacy gateway',()=>{
 assert.throws(()=>inspectVectorRequest(root+'/v2/unknown/garbage',{method:'GET'}),VectorOperationDenied);
});
test('S11 branch observer keeps a single observed origin stable',()=>{
 const storage=store();
 const a=observeChatFork({chatId:'chat-A',integrity:'uuid-1',storage});
 const b=observeChatFork({chatId:'chat-A',integrity:'uuid-1',storage});
 assert.equal(a.originId,'uuid-1');assert.equal(b.originId,'uuid-1');
 assert.equal(JSON.parse(storage.getItem(S11_CHAT_OBSERVATION_KEY)).origins['uuid-1'],'chat-A');
});
test('S11 copied integrity quarantines both branches durably',()=>{
 const storage=store();
 observeChatFork({chatId:'chat-A',integrity:'uuid-1',storage});
 assert.equal(observeChatFork({chatId:'chat-B',integrity:'uuid-1',storage}).status,'QUARANTINED');
 assert.equal(observeChatFork({chatId:'chat-A',integrity:'uuid-1',storage}).originId,null);
 assert.ok(JSON.parse(storage.getItem(S11_CHAT_OBSERVATION_KEY)).quarantined.includes('uuid-1'));
});
test('S11 distinct persisted integrity IDs do not collide',()=>{
 const storage=store();
 assert.equal(observeChatFork({chatId:'branch-A',integrity:'uuid-A',storage}).originId,'uuid-A');
 assert.equal(observeChatFork({chatId:'branch-B',integrity:'uuid-B',storage}).originId,'uuid-B');
});
test('S11 corrupt or inaccessible registry fails closed',()=>{
 const storage=store();storage.setItem(S11_CHAT_OBSERVATION_KEY,'{bad json');
 assert.equal(observeChatFork({chatId:'chat-A',integrity:'id-1',storage}).originId,null);
 assert.equal(observeChatFork({chatId:'chat-A',integrity:'id-1',storage:null}).status,'UNVERIFIED');
});
test('S11 empty chat or integrity cannot count as branch ownership',()=>{
 const storage=store();assert.equal(observeChatFork({chatId:'',integrity:'uuid-1',storage}).originId,null);
 assert.equal(observeChatFork({chatId:'chat-A',integrity:'',storage}).originId,null);
});

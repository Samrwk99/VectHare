import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {deterministicRecordUUID,validateRecordV2} from '../lib/m0-record-schema.js';
import {BACKENDS,OPERATIONS,capability,capabilityMatrix} from '../lib/m0-capabilities.js';
import {registerM0GatewayRoutes,validatePlanIntent,planSavedMutation} from '../lib/m0-gateway.js';
import {isBlockedM0Path,m0WriteBoundary,M0_BLOCKED_PATHS} from '../lib/m0-write-boundary.js';
import {BACKEND_METHODS,assertAdapterContract,mockM0Backend,qdrantM0Reference} from '../lib/m0-backend-contract.js';
import {planMutation} from '../lib/s04-contract.js';
import {collectionIdentity} from '../lib/s02-identity.js';
const here=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(here,'..');
const sha=x=>createHash('sha256').update(x).digest('hex');
const id={userScopeId:'alice',sourceId:'chat-17',branchId:'branch-a',sourceEntryId:'message-01'};
const rid=deterministicRecordUUID(id);
function record(){return {schemaVersion:2,recordId:rid,identity:{...id},source:{kind:'chat',fileFingerprint:sha('chat'),saved:true},
 revision:1,contentHash:sha('hello'),embedding:{source:'transformers',model:'fixture',dimension:3,metric:'cosine',profileFingerprint:sha('profile')},
 tombstone:{state:'ACTIVE',deletedAt:null,operationId:null},
 links:[{sourceRecordUUID:rid,targetRecordUUID:randomUUID(),relationship:'related',scope:'owned-collection',sourceRevision:1}],
 conditions:[{id:'c1',type:'keyword',operator:'includes',value:'hello',enabled:true}],parent:null,summary:null,lorebook:null,metadata:{}};}
test('M0.2 stable identity independent of revisions and content and schema reserves future typed fields',()=>{
 assert.equal(deterministicRecordUUID(id),rid);assert.notEqual(deterministicRecordUUID({...id,branchId:'branch-b'}),rid);
 assert.equal(validateRecordV2(record()).recordId,rid);
 assert.throws(()=>validateRecordV2({...record(),revision:2}),{code:'M0_LINKS_INVALID'});
 assert.throws(()=>validateRecordV2({...record(),recordId:randomUUID()}),{code:'M0_RECORD_IDENTITY_INVALID'});
 assert.throws(()=>validateRecordV2({...record(),links:[{...record().links[0],scope:'foreign'}]}),{code:'M0_LINKS_INVALID'});
 assert.throws(()=>validateRecordV2({...record(),unknown:'unsafe'}),{code:'M0_RECORD_SHAPE_INVALID'});
});
test('M0.3 matrix has explicit backend-operation dimensions and never enables from offline/unbound evidence',()=>{
 const cells=capabilityMatrix();assert.equal(cells.length,BACKENDS.length*OPERATIONS.length);
 assert.ok(cells.every(c=>c.enabled===false&&['BLOCKED','UNSUPPORTED_BY_DESIGN'].includes(c.mode)));
 const c=capability({backend:'qdrant',operation:'insert',hostVersion:'st-test',policy:'ENABLED',prerequisites:[],
  evidence:{backend:'qdrant',operation:'insert',hostVersion:'other',realHostAccepted:true,disposableBackendAccepted:true,testRunId:'1'}});
 assert.equal(c.mode,'BLOCKED');assert.equal(c.reasonCode,'M0_CODE_OR_HOST_EVIDENCE_REQUIRED');
 assert.throws(()=>capability({backend:'not-real',operation:'insert'}));
});
test('M0.4 browser intent has no owner, text, vector, physical name or arbitrary endpoint',()=>{
 const valid={backend:'qdrant',source:{kind:'chat',avatar:'x',chatFile:'y'},recordId:rid,action:'insert'};
 assert.equal(validatePlanIntent(valid),valid);
 for(const extra of [{ownerId:'other'},{physicalCollectionName:'x'},{vector:[1,2,3]},{text:'spoof'},{url:'https://attacker'},{embedding:{dimension:3}}])
  assert.throws(()=>validatePlanIntent({...valid,...extra}),{code:'M0_BROWSER_FIELD_FORBIDDEN'});
 assert.throws(()=>validatePlanIntent({...valid,source:{...valid.source,ownerId:'other'}}),{code:'M0_SOURCE_SELECTOR_INVALID'});
});
test('M0.4 server re-attests binding and profile; plan response cannot execute',async()=>{
 const scope={userScopeId:'alice',collectionId:'c',type:'chat',sourceId:'s',branchId:'b'};
 const embedding={source:'transformers',model:'fixture',dimension:3,metric:'cosine'};
 const c=collectionIdentity({backend:'qdrant',scope,embedding});
 const req={s03:{userScopeId:'alice'},body:{backend:'qdrant',source:{kind:'chat',avatar:'a',chatFile:'b'},recordId:rid,action:'insert'}};
 const deps={getProfile:async()=>({configured:true,profile:embedding}),
  bind:async(_req,b)=>{assert.deepEqual(b.embedding,embedding);return {binding:{backend:'qdrant',scope,collection:{key:c.key}}};},
  getReceipt:async()=>({state:'SCHEMA_VERIFIED_OFFLINE_UNCERTIFIED'})};
 const plan=await planSavedMutation(req,c.key,deps);
 assert.equal(plan.executionAllowed,false);assert.equal(plan.sourceAttested,true);
 assert.equal(plan.logicalKey,c.key);assert.equal(plan.embeddingProfile.dimension,3);
 await assert.rejects(()=>planSavedMutation(req,'a'.repeat(64),deps),{code:'M0_COLLECTION_BINDING_MISMATCH'});
 const router={post(p,f){this[p]=f;},get(p,f){this[p]=f;}};registerM0GatewayRoutes(router,deps);
 let response;const res={status(code){this.code=code;return this;},json(v){response={httpStatus:this.code??200,...v};}};
 await router['/v2/mutations/execute']({},res);
 assert.equal(response.httpStatus,409);assert.equal(response.code,'M0_EXECUTION_NOT_CERTIFIED');assert.equal(response.executionAllowed,false);
});
test('M0.1 public legacy writers and pilot/diagnostic bypasses fail closed before registration',async()=>{
 const expected=['/chunks/insert','/chunks/delete','/chunks/purge','/purge-all',
 '/v2/workflows/chat-sync-pilot-apply','/v2/workflows/chat-lifecycle-pilot',
 '/v2/workflows/chat-orphan-pilot','/v2/workflows/saved-content-pilot',
 '/v2/records/pilot-mutate','/v2/records/lancedb-pilot-mutate',
 '/v2/records/vectra-pilot-mutate','/v2/records/milvus-pilot-mutate',
 '/v2/diagnostics/qdrant-contract','/v2/diagnostics/qdrant-f05',
 '/v2/diagnostics/lancedb-f06','/v2/diagnostics/milvus-f08',
 '/v2/diagnostics/vectra-f07','/v2/collections/provision'];
 expected.forEach(p=>assert.ok(isBlockedM0Path('POST',p),p));
 assert.ok(isBlockedM0Path('PUT','/v2/connections/qdrant'));
 assert.ok(isBlockedM0Path('DELETE','/v2/connections/milvus'));
 assert.ok(isBlockedM0Path('PUT','/v2/embeddings/profile'));
 assert.ok(isBlockedM0Path('DELETE','/v2/embeddings/profile'));
 assert.equal(isBlockedM0Path('GET','/v2/m0/capabilities'),false);
 const source=await fs.readFile(path.join(root,'index.js'),'utf8');
 assert.ok(source.indexOf('router.use(m0WriteBoundary)')<source.indexOf('registerF09b3SyncRoutes(router'));
 assert.ok(source.indexOf('router.use(m0WriteBoundary)')<source.indexOf('registerF03ProvisionRoutes(router'));
 assert.ok(source.indexOf('router.use(m0WriteBoundary)')<source.indexOf('registerF04PilotRoutes(router'));
 let result,visited=false;m0WriteBoundary({method:'POST',path:'/v2/workflows/saved-content-pilot'},
 {status(status){this.statusCode=status;return this;},json(value){result={status:this.statusCode,...value};}},()=>{visited=true;});
 assert.equal(result.status,409);assert.equal(visited,false);assert.equal(result.executionAllowed,false);
 assert.ok(M0_BLOCKED_PATHS.length>=8);
});
test('M0.5 twelve-method contract, mock fault injection and persistence semantics (fixture only)',async()=>{
 const a=mockM0Backend();assertAdapterContract(a);assert.deepEqual(BACKEND_METHODS.filter(k=>typeof a[k]!=='function'),[]);
 const p={recordId:rid,expectedRevision:1,operationId:randomUUID()};
 assert.equal((await a.insertRecord(p,{text:'hello',vector:[1,2,3]})).status,'VERIFIED');
 assert.equal((await a.insertRecord(p,{text:'duplicate',vector:[1,2,3]})).status,'REJECTED');
 assert.equal((await a.updateRecord({...p,expectedRevision:9},{text:'bad',vector:[1,2,3]})).status,'REJECTED');
 assert.equal((await a.updateRecord(p,{text:'updated',vector:[1,2,3]})).status,'VERIFIED');
 assert.equal((await a.getRecord(rid)).revision,2);
 const backup=await a.captureBackup();const b=mockM0Backend();assert.equal((await b.restoreToNew(backup)).status,'VERIFIED');
 assert.equal((await b.restoreToNew(backup)).status,'REJECTED');
 const fail=mockM0Backend({fault:s=>s==='insertRecord:after'?Error('lost ack'):null});
 await assert.rejects(()=>fail.insertRecord(p,{text:'hello',vector:[1,2,3]}),/lost ack/);
 assert.equal((await fail.getRecord(rid)).text,'hello'); // observed goal state != attribution
 assert.equal((await fail.inspectOperationOutcome(p.operationId)).proofOfDispatch,false);
 assert.equal((await a.deleteRecord({...p,expectedRevision:2})).status,'VERIFIED');
});
test('M0.6 Qdrant reference idempotent physical ID / explicit revision; NOT proof of atomic CAS',async()=>{
 const scope={userScopeId:'alice',collectionId:'c',type:'chat',sourceId:'chat-1',branchId:'b'};
 const embedding={source:'transformers',model:'fixture',dimension:3,metric:'cosine'};
 const c=collectionIdentity({backend:'qdrant',scope,embedding});
 const binding={authorized:true,provenance:'SERVER_VERIFIED',backend:'qdrant',scope,embedding,
  collection:{key:c.key,physicalName:c.physicalName}};
 const calls=[],rows=new Map();const backend={s06DisposableFixture:true,async _request(method,url,body){
  calls.push({method,url,body});
  if(method==='GET')return {result:{config:{params:{vectors:{size:3,distance:'Cosine'}}},status:'green'}};
  if(url.endsWith('/points/scroll')){
   const points=[...rows.values()].filter(p=>body.filter.must.every(x=>p.payload[x.key]===x.match.value));
   return {result:{points:points.slice(0,body.limit).map(x=>({...x,vector:body.with_vector?x.vector:undefined})),next_page_offset:null}};
  }
  if(method==='PUT'&&url.includes('/points?wait=true')){for(const p of body.points)rows.set(p.id,p);return {result:{status:'completed',operation_id:1}};}
  if(method==='POST'&&url.includes('/points/delete?wait=true')){
   for(const [id,p] of rows)if(body.filter.must.every(x=>p.payload[x.key]===x.match.value))rows.delete(id);
   return {result:{status:'completed',operation_id:2}};
  }
  throw Error('unsupported fixture request '+method+' '+url);
 }};
 const a=qdrantM0Reference(backend,binding),ctx={userScopeId:'alice'};
 assertAdapterContract(a);assert.equal(a.capabilities().productionCertified,false);
 const payload={text:'fixture',vector:[.1,.2,.3],metadata:{}};
 const insert=planMutation(ctx,{backend:'qdrant',scope,embedding,action:'insert',recordId:rid,operationId:randomUUID(),...payload});
 assert.equal((await a.insertRecord(insert,payload)).status,'VERIFIED');
 assert.equal((await a.getRecord(rid)).revision,1);
 const update=planMutation(ctx,{backend:'qdrant',scope,embedding,action:'update',recordId:rid,operationId:randomUUID(),expectedRevision:1,...payload});
 assert.equal(update.physicalId,insert.physicalId);
 assert.equal((await a.updateRecord(update,payload)).status,'VERIFIED');
 assert.equal((await a.getRecord(rid)).revision,2);
 assert.throws(()=>a.captureBackup(),{code:'M0_ADAPTER_OPERATION_NOT_CERTIFIED'});
 assert.equal(a.capabilities().idempotentGoalStateCertified,false);
 const real=qdrantM0Reference({...backend,s06DisposableFixture:false},binding);
 await assert.rejects(()=>real.insertRecord(insert,payload),{code:'S06_WRITE_NOT_ACTIVATED'});
 assert.ok(calls.some(c=>c.method==='PUT'));
});

test('M3v4 implementation evidence allows manual-test availability without claiming external host verification',async()=>{
 const evidence=Object.fromEntries(['gateway','ui','conformance','faultTests','securityTests'].map(x=>[x,'passed']));
 const ready=capability({backend:'qdrant',operation:'insert',policy:'ENABLED',implementationEvidence:evidence});
 assert.equal(ready.enabled,true);assert.equal(ready.mode,'ENABLED');
 assert.equal(ready.validationStatus,'AWAITING_MANUAL_TEST');
 assert.equal(ready.validationEvidenceFingerprint,null);
 assert.equal(ready.runtimePreflightRequired,true);
 const deficient=capability({backend:'qdrant',operation:'insert',policy:'ENABLED',
  implementationEvidence:{...evidence,securityTests:'failed'}});
 assert.equal(deficient.enabled,false);
 const delayed=capability({backend:'qdrant',operation:'delete',policy:'ENABLED',
  implementationEvidence:evidence,prerequisites:['MISSING_WRITE_GATEWAY']});
 assert.equal(delayed.enabled,false);
});

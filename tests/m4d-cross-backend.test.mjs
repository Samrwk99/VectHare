import {test} from 'node:test';
import assert from 'node:assert/strict';
import {registerM0GatewayRoutes,validatePlanIntent} from '../lib/m0-gateway.js';
import {BACKEND_METHODS} from '../lib/m0-backend-contract.js';
import {BACKENDS,OPERATIONS} from '../lib/m0-capabilities.js';

const core=['insert','update','revectorize','delete','collection-delete','scoped-purge','backup','restore'];
const plugins=['qdrant','lancedb','vectra','milvus'];
function routes(){
 const handlers=new Map();const r={get:(p,h)=>handlers.set(`GET ${p}`,h),post:(p,h)=>handlers.set(`POST ${p}`,h)};
 registerM0GatewayRoutes(r,{liveCapabilityEvidence:async()=>({hostVersion:null})});
 return handlers;
}
async function readCaps(){
 let result;await routes().get('GET /v2/m0/capabilities')({},
 {json:body=>{result=body;return body;}});return result;
}
test('M4d full 70-cell M0 route reflects all four plugin backends and eight core operations',async()=>{
 const result=await readCaps();assert.equal(result.success,true);
 assert.equal(result.cells.length,70);
 assert.equal(result.manualTestWritesEnabled,true);
 assert.equal(result.productionWritesEnabled,false);
 assert.equal(result.productionCertified,false);
 assert.deepEqual(new Set(result.cells.map(c=>c.backend)),new Set(BACKENDS));
 assert.deepEqual(new Set(result.cells.map(c=>c.operation)),new Set(OPERATIONS));
 for(const backend of plugins){
  const cells=result.cells.filter(c=>c.backend===backend&&core.includes(c.operation));
  assert.equal(cells.length,8,`${backend} core count`);
  for(const c of cells){assert.equal(c.mode,'ENABLED',`${backend}:${c.operation}`);
   assert.equal(c.validationStatus,'AWAITING_MANUAL_TEST');
   assert.equal(c.runtimePreflightRequired,true);}
 }
 assert.equal(result.cells.filter(c=>c.mode==='ENABLED').length,32);
 assert.equal(result.cells.filter(c=>c.mode==='BLOCKED').length,33);
 assert.equal(result.cells.filter(c=>c.mode==='UNSUPPORTED_BY_DESIGN').length,5);
 for(const c of result.cells.filter(c=>c.mode!=='ENABLED'))assert.equal(c.enabled,false);
});
test('M4d client intent cannot supply paths, owners, embeddings, or physical names across any backend',()=>{
 const id='2ffca8f4-9f0c-4c4f-8e62-478b243a160a';
 const source={kind:'chat',avatar:'character.png',chatFile:'saved.jsonl'};
 for(const backend of plugins){
  assert.equal(validatePlanIntent({backend,action:'insert',source,recordId:id}).backend,backend);
  for(const key of ['owner','userScopeId','physicalName','databasePath','vector','embedding','endpoint','token']){
   assert.throws(()=>validatePlanIntent({backend,action:'insert',source,recordId:id,[key]:'hostile'}),
    {code:'M0_BROWSER_FIELD_FORBIDDEN'},`${backend} ${key}`);
  }
  assert.throws(()=>validatePlanIntent({backend,action:'delete',source:{...source,owner:'other'},recordId:id}),
   {code:'M0_SOURCE_SELECTOR_INVALID'});
 }
});
test('M4d backend contract is complete and M0 mutation execution stays denied',async()=>{
 assert.equal(BACKEND_METHODS.length,12);assert.equal(new Set(BACKEND_METHODS).size,12);
 let code;const res={status(n){code=n;return this;},json(body){return body;}};
 const rejected=routes().get('POST /v2/mutations/execute')({},res);
 assert.equal(code,409);assert.equal(rejected.executionAllowed,false);
});

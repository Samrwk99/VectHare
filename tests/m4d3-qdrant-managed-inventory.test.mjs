import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readM3ManagedInventory,registerM3Routes} from '../lib/m3-collections.js';
const H=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const source={kind:'chat',avatar:'fixture.png',chatFile:'current-chat'};
const scope={userScopeId:'owner-a',sourceId:'saved-chat-a',type:'chat',collectionId:'source',branchId:'branch'};
const profile={source:'transformers',model:'unit',dimension:3,metric:'cosine'};
const collection={key:'a'.repeat(64),physicalName:'server-derived-collection',generation:0};
const binding={scope,collection,embedding:profile,authorized:true};
const recordId=randomUUID(),textHash='b'.repeat(64);
const makePoint=(id=recordId,hash=textHash)=>({id,vector:[1,2,3],payload:{recordId:id,textHash:hash,revision:1,
  metadata:{vecthareRecordV2:{schemaVersion:2,recordId:id,identity:{userScopeId:scope.userScopeId,sourceId:scope.sourceId},contentHash:hash,revision:1}}}});
function fixture(){
 const state={sourceHash:'c'.repeat(64),owner:scope.userScopeId,inventoryCalls:0,ledger:0,registry:'d'.repeat(64),locked:0,rows:[makePoint()],transportCalls:0};
 const req={body:{backend:'qdrant',source,configId:'default'},s03:{userScopeId:scope.userScopeId,vectorsPath:'/fixture'},user:{directories:{}}};
 const registry=()=>({read:async()=>({fingerprint:state.registry,records:Object.fromEntries(state.rows.map(r=>[r.payload.recordId,
  {state:'ACTIVE',recordId:r.payload.recordId,contentHash:r.payload.textHash,revision:1}]))})});
 const deps={getProfile:async()=>({configured:true,profile}),bind:async()=>({binding}),
  resolveLiveBinding:async()=>binding,readSnapshot:async()=>({sourceId:scope.sourceId,fileHash:state.sourceHash}),
  receipt:async()=>({state:'SCHEMA_VERIFIED_OFFLINE_UNCERTIFIED'}),registry,
  jobs:()=>({assertNoLease:async()=>{}}),transport:async()=>({}),
  ledgerCheckpoint:async()=>({digest:H([state.ledger])}),
  boundary:()=>({withWriteBoundary:async(_plan,fn)=>{state.locked++;return fn();}}),
  inventory:async()=>{state.inventoryCalls++;const rows=structuredClone(state.rows);return {rows,count:rows.length,digest:H(rows),complete:true,exclusiveOwner:true};}};
 return {state,req,deps};
}
test('verified managed inventory is read-only, double-scanned and returns aggregates without vectors or text',async()=>{
 const f=fixture();const r=await readM3ManagedInventory(f.req,f.deps);
 assert.equal(r.recordCount,1);assert.equal(r.uniqueContentHashCount,1);
 assert.equal(r.inventoryVerified,true);assert.equal(r.managedV2Only,true);
 assert.equal(r.deleteAuthorized,false);assert.equal(r.repairAuthorized,false);assert.equal(r.legacySharedCollectionsVerified,false);
 assert.equal(f.state.inventoryCalls,2);assert.equal(f.state.locked,1);
 assert.equal(JSON.stringify(r).includes('vector'),false);assert.equal(JSON.stringify(r).includes(textHash),false);
});
test('repeated content hashes do not authorize deletion and are not record-ID duplicates',async()=>{
 const f=fixture();f.state.rows.push(makePoint(randomUUID()));
 const r=await readM3ManagedInventory(f.req,f.deps);
 assert.equal(r.repeatedContentHashGroups,1);assert.equal(r.repeatedContentHashExtraRecords,1);
 assert.equal(r.repairAuthorized,false);
});
test('forged browser owner, path, vector and physical name are rejected before physical reads',async()=>{
 for(const key of ['ownerId','physicalName','vector','text','embedding','path','url']){
  const f=fixture();f.req.body[key]='attack';
  await assert.rejects(()=>readM3ManagedInventory(f.req,f.deps),{code:'M3_SOURCE_SELECTOR_INVALID'});
  assert.equal(f.state.inventoryCalls,0);
 }
});
test('foreign or unregistered records, duplicate record identity and unverified scans fail closed',async()=>{
 for(const change of [
  f=>f.state.rows.push({...makePoint(randomUUID()),payload:{...makePoint().payload,recordId:randomUUID()}}),
  f=>f.deps.inventory=async()=>({rows:f.state.rows,count:1,digest:'x',complete:false,exclusiveOwner:false}),
  f=>f.state.rows.push({...makePoint(),id:'untracked-id'})
 ]){const f=fixture();change(f);await assert.rejects(()=>readM3ManagedInventory(f.req,f.deps));}
});
test('changed readback, saved source, ledger, registry and generation all refuse attestation',async()=>{
 for(const change of [
  f=>{const old=f.deps.inventory;f.deps.inventory=async()=>{const r=await old();if(f.state.inventoryCalls===2){r.rows[0].vector=[9,9,9];r.digest=H(r.rows);}return r;};},
  f=>{const old=f.deps.readSnapshot;let n=0;f.deps.readSnapshot=async()=>({...await old(),fileHash:n++?'f'.repeat(64):'c'.repeat(64)});},
  f=>{let n=0;f.deps.ledgerCheckpoint=async()=>({digest:H([n++])});},
  f=>{let n=0;const old=f.deps.registry;f.deps.registry=()=>({read:async()=>({...await old().read(),fingerprint:n++?'e'.repeat(64):'d'.repeat(64)})});},
  f=>{let n=0;f.deps.resolveLiveBinding=async()=> n++ ? ({...binding,collection:{...collection,generation:2}}) : binding;}
 ]){const f=fixture();change(f);await assert.rejects(()=>readM3ManagedInventory(f.req,f.deps));}
});
test('route registration exposes only source-bound, read-only inventory proof',async()=>{
 const routes={};const router={post:(p,h)=>routes[p]=h,get:()=>{}};
 registerM3Routes(router,fixture().deps);
 assert.equal(typeof routes['/v2/m3/collections/managed-inventory'],'function');
 const f=fixture();let status=200,response;
 await routes['/v2/m3/collections/managed-inventory'](f.req,{json:x=>response=x,status:n=>{status=n;return {json:x=>response=x};}});
 assert.equal(status,200);assert.equal(response.success,true);assert.equal(response.inventoryVerified,true);
 const invalid=fixture();invalid.req.body.owner='other';
 await routes['/v2/m3/collections/managed-inventory'](invalid.req,{status:n=>{status=n;return {json:x=>response=x};},json:x=>response=x});
 assert.equal(status,400);assert.equal(response.success,false);assert.equal(response.readOnly,undefined);
});

test('empty provisioned owned-v2 collection has a verified zero count, never grants insertion or deletion',async()=>{
 const f=fixture();f.state.rows=[];
 const r=await readM3ManagedInventory(f.req,f.deps);
 assert.equal(r.recordCount,0);assert.equal(r.uniqueContentHashCount,0);
 assert.equal(r.repeatedContentHashExtraRecords,0);
 assert.equal(r.inventoryVerified,true);assert.equal(r.readOnly,true);
 assert.equal(r.repairAuthorized,false);assert.equal(r.deleteAuthorized,false);
 assert.equal(f.state.inventoryCalls,2);
});
test('unprovisioned first-use collection cannot be misrepresented as a proven empty inventory',async()=>{
 const f=fixture(); f.deps.receipt=async()=>null;
 await assert.rejects(()=>readM3ManagedInventory(f.req,f.deps),{code:'M3_PROVISION_RECEIPT_REQUIRED'});
 assert.equal(f.state.inventoryCalls,0);
});

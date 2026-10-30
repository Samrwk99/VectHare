import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {readPB12Groups,updatePB12Groups,registerPB12GroupRoutes} from '../lib/pb12-managed-groups.js';
const H=x=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
const ids=Array.from({length:5},()=>randomUUID());
const source={kind:'chat',avatar:'tester.png',chatFile:'test.jsonl'};
async function fixture(backend='qdrant'){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'pb12-groups-'));
 await fs.chmod(root,0o700);
 const state={revision:0,rows:ids.slice(),generation:0,owner:'owner'};
 const proof=()=>({backend,logicalKey:H('logical'),inventoryDigest:H(['inventory',state.revision,state.rows]),
  sourceFingerprint:H(['source',state.revision]),registryFingerprint:H(['registry',state.revision]),
  routingGeneration:state.generation,inventoryVerified:true,entirePhysicalCollectionVerified:true,
  exclusiveOwner:true,recordCount:state.rows.length,physicalRows:state.rows.map(id=>({id,payload:{
   physicalId:id,recordId:id,revision:1,text:'saved text',textHash:H('saved text'),metadataHash:H('{}'),metadata:{}},vector:[0.2]}))});
 const deps={readPhysical:{[backend]:proof}};
 const req=body=>({s03:{userScopeId:state.owner,vectorsPath:root},user:{directories:{}},body:{backend,source,...body}});
 const cleanup=()=>fs.rm(root,{recursive:true,force:true});
 return {state,root,deps,req,cleanup};
}
test('durable create/read/update has revisioned receipt and independent readback',async t=>{
 const f=await fixture();t.after(f.cleanup);
 const first=await readPB12Groups(f.req(),f.deps);
 assert.equal(first.revision,0);assert.equal(first.recordCount,5);
 const group={id:randomUUID(),name:'Scenes',members:[ids[0],ids[1]]};
 const operationId=randomUUID();
 const updated=await updatePB12Groups(f.req({action:'save',expectedRevision:first.revision,
  expectedProof:first.proof,operationId,groups:[group]}),f.deps);
 assert.equal(updated.receipt.verified,true);assert.equal(updated.receipt.durable,true);
 assert.equal(updated.revision,1);
 const fresh=await readPB12Groups(f.req(),f.deps);
 assert.deepEqual(fresh.groups,[group]);assert.equal(fresh.lastOperationId,operationId);
 await assert.rejects(()=>updatePB12Groups(f.req({action:'save',expectedRevision:first.revision,
  expectedProof:first.proof,operationId:randomUUID(),groups:[group]}),f.deps),/PB12_REVISION_STALE/);
 await assert.rejects(()=>updatePB12Groups(f.req({action:'save',expectedRevision:1,
  expectedProof:fresh.proof,operationId,groups:[]}),f.deps),/PB12_OPERATION_ALREADY_COMMITTED/);
});
test('explicit prune repairs only missing UUID members; read is preview-only',async t=>{
 const f=await fixture('milvus');t.after(f.cleanup);
 let r=await readPB12Groups(f.req(),f.deps);
 const group={id:randomUUID(),name:'chapter',members:[ids[0],ids[1]]};
 await updatePB12Groups(f.req({action:'save',expectedRevision:0,expectedProof:r.proof,
  operationId:randomUUID(),groups:[group]}),f.deps);
 f.state.rows=f.state.rows.filter(id=>id!==ids[1]);f.state.revision++;
 r=await readPB12Groups(f.req(),f.deps);
 assert.deepEqual(r.orphanedMembers,[{groupId:group.id,recordId:ids[1]}]);
 const patched=await updatePB12Groups(f.req({action:'prune-orphans',expectedRevision:r.revision,
  expectedProof:r.proof,operationId:randomUUID()}),f.deps);
 assert.deepEqual(patched.groups[0].members,[ids[0]]);
 assert.deepEqual((await readPB12Groups(f.req(),f.deps)).orphanedMembers,[]);
});
test('four backends, foreign UUID refusal, changed proof, pending generation, and owner scope',async t=>{
 for(const backend of ['qdrant','lancedb','vectra','milvus']){
  const f=await fixture(backend);t.after(f.cleanup);
  let r=await readPB12Groups(f.req(),f.deps);
  const group={id:randomUUID(),name:'group',members:[ids[0]]};
  await assert.rejects(()=>updatePB12Groups(f.req({action:'save',expectedRevision:0,
   expectedProof:r.proof,operationId:randomUUID(),groups:[{...group,members:[randomUUID()]}]}),f.deps),/PB12_MEMBER_UNVERIFIED/);
  f.state.revision++;
  await assert.rejects(()=>updatePB12Groups(f.req({action:'save',expectedRevision:0,
   expectedProof:r.proof,operationId:randomUUID(),groups:[group]}),f.deps),/PB12_PROOF_STALE/);
  r=await readPB12Groups(f.req(),f.deps);
  await updatePB12Groups(f.req({action:'save',expectedRevision:0,expectedProof:r.proof,
   operationId:randomUUID(),groups:[group]}),f.deps);
  f.state.generation++;
  r=await readPB12Groups(f.req(),f.deps);
  assert.equal(r.requiresGenerationReview,true);
  await assert.rejects(()=>updatePB12Groups(f.req({action:'save',expectedRevision:1,
   expectedProof:r.proof,operationId:randomUUID(),groups:[]}),f.deps),/PB12_GENERATION_REVIEW_REQUIRED/);
  await assert.rejects(()=>readPB12Groups({...f.req(),s03:{...f.req().s03,userScopeId:'foreign'}},f.deps),/PB12_STORE_CORRUPT/);
 }
});
test('file lock blocks concurrent metadata commits and incomplete inventory cannot authorize writes',async t=>{
 const f=await fixture();t.after(f.cleanup);
 const r=await readPB12Groups(f.req(),f.deps);
 const lock=path.join(f.root,'.similharity','pb12-groups','.lock-'+r.logicalKey);
 await fs.mkdir(lock,{mode:0o700});
 await assert.rejects(()=>updatePB12Groups(f.req({action:'save',expectedRevision:0,
  expectedProof:r.proof,operationId:randomUUID(),groups:[{id:randomUUID(),name:'ok',members:[]}]}),f.deps),/PB12_WRITE_BUSY/);
 await fs.rmdir(lock);
 f.deps.readPhysical.qdrant=()=>({...{
  backend:'qdrant',logicalKey:r.logicalKey,inventoryDigest:H('inv'),sourceFingerprint:H('src'),
  registryFingerprint:H('reg'),routingGeneration:0,recordCount:1,physicalRows:[]},
  inventoryVerified:true,entirePhysicalCollectionVerified:true,exclusiveOwner:true});
 await assert.rejects(()=>readPB12Groups(f.req(),f.deps),/PB10_PHYSICAL_PROOF_UNVERIFIED/);
});
test('physical evidence changing between preflight and locked commit aborts without metadata write',async t=>{
 const f=await fixture();t.after(f.cleanup);
 const before=await readPB12Groups(f.req(),f.deps);
 const old=f.deps.readPhysical.qdrant;let scans=0;
 f.deps.readPhysical.qdrant=()=>{scans++;if(scans===2){f.state.revision++;}return old();};
 await assert.rejects(()=>updatePB12Groups(f.req({action:'save',expectedRevision:0,
  expectedProof:before.proof,operationId:randomUUID(),groups:[{id:randomUUID(),name:'new',members:[ids[0]]}]}),f.deps),/PB12_PROOF_STALE/);
 const stored=await readPB12Groups(f.req(),f.deps);
 assert.equal(stored.revision,0);assert.deepEqual(stored.groups,[]);
});
test('API returns validated receipt and refuses malformed input',async t=>{
 const f=await fixture('vectra');t.after(f.cleanup);
 const router={routes:{},post(p,fn){this.routes[p]=fn;}};registerPB12GroupRoutes(router,f.deps);
 const res=()=>({statusCode:200,status(n){this.statusCode=n;return this;},json(v){this.body=v;}});
 let r=res();await router.routes['/v2/pb12/groups/read'](f.req(),r);
 assert.equal(r.body.success,true);
 r=res();await router.routes['/v2/pb12/groups/update'](f.req({action:'save'}),r);
 assert.equal(r.body.success,false);assert.equal(r.body.code,'PB12_INTENT_INVALID');
});
test('P-B.13 retrieval policy is durable, revision checked, and rejects unsupported mandatory/hard semantics',async t=>{
 const f=await fixture('qdrant');t.after(f.cleanup);
 const first=await readPB12Groups(f.req(),f.deps);
 const gid=randomUUID();
 const exclusive={id:gid,name:'Only one',members:[ids[0],ids[1]],mode:'exclusive'};
 const updated=await updatePB12Groups(f.req({action:'save',expectedRevision:first.revision,
  expectedProof:first.proof,operationId:randomUUID(),groups:[exclusive]}),f.deps);
 assert.deepEqual((await readPB12Groups(f.req(),f.deps)).groups,[exclusive]);
 const inclusive={...exclusive,mode:'inclusive',boost:0.15};
 const next=await updatePB12Groups(f.req({action:'save',expectedRevision:updated.revision,
  expectedProof:updated.proof,operationId:randomUUID(),groups:[inclusive]}),f.deps);
 assert.deepEqual((await readPB12Groups(f.req(),f.deps)).groups,[inclusive]);
 for(const invalid of [{...inclusive,mode:'mandatory'},{...inclusive,boost:2},
  {...exclusive,boost:0.2},{...inclusive,linkType:'hard'}]){
  await assert.rejects(()=>updatePB12Groups(f.req({action:'save',expectedRevision:next.revision,
   expectedProof:next.proof,operationId:randomUUID(),groups:[invalid]}),f.deps),/PB12_GROUP_INVALID/);
 }
});

test('generation review: explicit CAS adopts only verified surviving UUIDs and prunes absent members',async t=>{
 const f=await fixture('qdrant');t.after(f.cleanup);
 let r=await readPB12Groups(f.req(),f.deps);
 const group={id:randomUUID(),name:'generation group',members:[ids[0],ids[1]],mode:'inclusive',boost:0.2};
 await updatePB12Groups(f.req({action:'save',expectedRevision:r.revision,expectedProof:r.proof,
  operationId:randomUUID(),groups:[group]}),f.deps);
 f.state.generation=2;f.state.rows=f.state.rows.filter(id=>id!==ids[1]);f.state.revision++;
 r=await readPB12Groups(f.req(),f.deps);
 assert.equal(r.generation,2);assert.equal(r.storedGeneration,0);
 assert.equal(r.requiresGenerationReview,true);assert.equal(r.orphanedMembers.length,1);
 const op=randomUUID();const update={action:'review-generation',expectedRevision:r.revision,
  expectedProof:r.proof,expectedStoredGeneration:r.storedGeneration,operationId:op};
 await assert.rejects(()=>updatePB12Groups(f.req({...update,expectedStoredGeneration:1}),f.deps),/PB12_GENERATION_STALE/);
 await assert.rejects(()=>updatePB12Groups(f.req({...update,groups:[]}),f.deps),/PB12_INTENT_INVALID/);
 const result=await updatePB12Groups(f.req(update),f.deps);
 assert.equal(result.receipt.action,'review-generation');assert.equal(result.receipt.durable,true);
 assert.equal(result.requiresGenerationReview,false);assert.equal(result.storedGeneration,2);
 assert.deepEqual(result.groups,[{...group,members:[ids[0]]}]);
 const fresh=await readPB12Groups(f.req(),f.deps);
 assert.deepEqual(fresh.groups,result.groups);assert.equal(fresh.revision,result.revision);
 await assert.rejects(()=>updatePB12Groups(f.req(update),f.deps),/PB12_OPERATION_ALREADY_COMMITTED/);
 await assert.rejects(()=>updatePB12Groups(f.req({...update,operationId:randomUUID(),expectedRevision:fresh.revision,
  expectedProof:fresh.proof,expectedStoredGeneration:2}),f.deps),/PB12_NO_GENERATION_CHANGE/);
});
test('generation review refuses stale proofs, concurrent generation changes and unverified inventories',async t=>{
 const f=await fixture('vectra');t.after(f.cleanup);
 let r=await readPB12Groups(f.req(),f.deps);
 const group={id:randomUUID(),name:'scene',members:[ids[0]]};
 await updatePB12Groups(f.req({action:'save',expectedRevision:0,expectedProof:r.proof,
  operationId:randomUUID(),groups:[group]}),f.deps);
 f.state.generation=1;r=await readPB12Groups(f.req(),f.deps);
 const update={action:'review-generation',expectedRevision:r.revision,
  expectedProof:r.proof,expectedStoredGeneration:0,operationId:randomUUID()};
 f.state.revision++;
 await assert.rejects(()=>updatePB12Groups(f.req(update),f.deps),/PB12_PROOF_STALE/);
 r=await readPB12Groups(f.req(),f.deps);update.expectedProof=r.proof;
 const previous=f.deps.readPhysical.vectra;let count=0;
 f.deps.readPhysical.vectra=()=>{if(++count===2)f.state.generation++;return previous();};
 await assert.rejects(()=>updatePB12Groups(f.req(update),f.deps),/PB12_PROOF_STALE/);
 f.deps.readPhysical.vectra=()=>({...previous(),exclusiveOwner:false});
 await assert.rejects(()=>updatePB12Groups(f.req(update),f.deps),/PB10_PHYSICAL_PROOF_UNVERIFIED/);
 f.deps.readPhysical.vectra=previous;
 const stored=await readPB12Groups(f.req(),f.deps);
 assert.equal(stored.storedGeneration,0);assert.equal(stored.revision,1);
});

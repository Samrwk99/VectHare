import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {browsePB10Physical,registerPB10PhysicalRoutes} from '../lib/pb10-physical-browse.js';
const hash=x=>createHash('sha256').update(x).digest('hex');
const ctx={s03:{userScopeId:'local-test-owner'},user:{directories:{}}};
const sources={kind:'chat',avatar:'tester.png',chatFile:'chat.jsonl'};
const row=i=>({id:`physical_${i}`,payload:{physicalId:`physical_${i}`,recordId:`rec_${String(i).padStart(4,'0')}`,
 revision:1,text:`hello ${i}`,textHash:hash(`hello ${i}`),metadataHash:hash('{}'),metadata:{vecthareRecordV2:{}}},
 vector:[0.1,0.2]});
function fixture(n=111,backend='lancedb'){
 let revision=0,calls=0;
 const inventory=()=>{calls++;
  return {backend,logicalKey:hash('key'),inventoryDigest:hash('inventory'+revision),
   sourceFingerprint:hash('source'+revision),registryFingerprint:hash('registry'+revision),
   routingGeneration:0,inventoryVerified:true,entirePhysicalCollectionVerified:true,
   exclusiveOwner:true,recordCount:n,physicalRows:Array.from({length:n},(_,i)=>row(i))};};
 const req=(cursor=null)=>({...ctx,body:{backend,source:sources,...(cursor?{cursor}:{})}});
 const deps={readPhysical:{[backend]:inventory}};
 return {req,deps,bump:()=>revision++,calls:()=>calls};
}
test('complete 111-record owned physical inventory yields 50/50/11 without truncation',async()=>{
 const f=fixture();let cursor=null,total=0,seen=new Set();
 for(let i=0;i<3;i++){
  const p=await browsePB10Physical(f.req(cursor),f.deps);
  assert.equal(p.inventoryKind,'ENTIRE_OWNED_PHYSICAL_COLLECTION');
  assert.equal(p.physicalInventoryComplete,true);
  assert.equal(p.readOnly,true);
  assert.equal(p.offset,total);
  assert.equal(p.records.length,[50,50,11][i]);
  assert.equal(JSON.stringify(p).includes('vector'),false);
  p.records.forEach(r=>seen.add(r.recordId));total+=p.records.length;cursor=p.nextCursor;
 }
 assert.equal(total,111);assert.equal(seen.size,111);assert.equal(cursor,null);assert.equal(f.calls(),3);
});
test('zero physical records are distinguishable from unprovisioned',async()=>{
 const f=fixture(0,'qdrant'),p=await browsePB10Physical(f.req(),f.deps);
 assert.equal(p.totalRecords,0);assert.equal(p.pageComplete,true);assert.equal(p.nextCursor,null);
});
test('stale inventory, source and generation invalidate cursor',async()=>{
 const f=fixture(),first=await browsePB10Physical(f.req(),f.deps);
 f.bump();await assert.rejects(()=>browsePB10Physical(f.req(first.nextCursor),f.deps),/PB10_CURSOR_STALE/);
});
test('cross-source and tenant replay is refused',async()=>{
 const f=fixture(),p=await browsePB10Physical(f.req(),f.deps);
 await assert.rejects(()=>browsePB10Physical({...f.req(p.nextCursor),body:{backend:'lancedb',source:{...sources,chatFile:'other.jsonl'},cursor:p.nextCursor}},f.deps),/PB10_CURSOR_STALE/);
 await assert.rejects(()=>browsePB10Physical({...f.req(p.nextCursor),s03:{userScopeId:'another'}},f.deps),/PB10_CURSOR_STALE/);
});
test('tampering with a cursor and supplying arbitrary selectors is refused',async()=>{
 const f=fixture(),p=await browsePB10Physical(f.req(),f.deps);
 await assert.rejects(()=>browsePB10Physical(f.req(p.nextCursor.slice(0,-2)+'aa'),f.deps),/PB10_CURSOR_INVALID/);
 await assert.rejects(()=>browsePB10Physical({...f.req(),body:{backend:'lancedb',source:sources,physicalName:'forged'}},f.deps),/PB10_SELECTOR_INVALID/);
 await assert.rejects(()=>browsePB10Physical({...f.req(),body:{backend:'lancedb',source:sources,cursor:123}},f.deps),/PB10_SELECTOR_INVALID/);
});
test('refuses incomplete, duplicate and oversized physical scans',async()=>{
 const f=fixture(2);
 for(const mutate of [x=>{x.exclusiveOwner=false;},x=>{x.physicalRows[1].payload.recordId='rec_0000';},
  x=>{x.physicalRows[1].payload.physicalId='wrong';},x=>{x.recordCount=9;},
  x=>{x.physicalRows[0].payload.textHash='bad';}]){
  const original=f.deps.readPhysical.lancedb;
  f.deps.readPhysical.lancedb=()=>{const x=original();mutate(x);return x;};
  await assert.rejects(()=>browsePB10Physical(f.req(),f.deps),/PB10_/);
  f.deps.readPhysical.lancedb=original;
 }
 const big=fixture(20001);
 await assert.rejects(()=>browsePB10Physical(big.req(),big.deps),/PB10_PHYSICAL_PROOF_UNVERIFIED/);
});
test('all four backends use their own attested route and fail closed',async()=>{
 for(const backend of ['qdrant','lancedb','vectra','milvus']){
  const f=fixture(3,backend);const p=await browsePB10Physical(f.req(),f.deps);
  assert.equal(p.backend,backend);assert.equal(p.records.length,3);
  const nonowned=fixture(3,backend);nonowned.deps.readPhysical[backend]=()=>{throw Error('M4_OWNER_MISMATCH');};
  await assert.rejects(()=>browsePB10Physical(nonowned.req(),nonowned.deps),/M4_OWNER_MISMATCH/);
 }
});
test('route accepts only successful authenticated read and rejects bad body',async()=>{
 const router={post:(path,handler)=>router.handler=handler};const f=fixture(1);
 registerPB10PhysicalRoutes(router,f.deps);
 const res={code:200,status(n){this.code=n;return this;},json(x){this.data=x;}};
 await router.handler(f.req(),res);assert.equal(res.data.success,true);
 await router.handler({...f.req(),s03:null},res);assert.equal(res.code,403);assert.equal(res.data.code,'PB10_HOST_AUTH_REQUIRED');
});

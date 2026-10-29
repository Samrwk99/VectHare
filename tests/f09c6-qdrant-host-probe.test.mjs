import test from 'node:test';
import assert from 'node:assert/strict';
import {runQdrantF09c6HostProbe,validateQdrantF09c6Options,F09C6_CONSENT,F09C6_CLEANUP_CONSENT} from '../lib/f09c6-qdrant-host-probe.js';

const endpoint='http://127.0.0.1:6333/';
const json=(data,status=200)=>({ok:status>=200&&status<300,status,async json(){return data;}});
function mockQdrant({version='1.17.0',interruptAt='',existingCollection=false,forceStaleApplied=false}={}){
 const calls=[];const collections=new Map();let collectionCreated=null;
 const fetchFn=async(url,req)=>{
  const u=new URL(url); calls.push({path:u.pathname,query:u.search,method:req.method,body:req.body?JSON.parse(req.body):null,redirect:req.redirect});
  assert.equal(u.hostname,'127.0.0.1');assert.equal(req.redirect,'manual');
  if(req.method==='GET'&&u.pathname==='/')return json({version});
  const c=/^\/collections\/(vh_f09c6_disposable_[0-9a-f]{32})(?:\/points)?$/.exec(u.pathname);
  if(!c)return json({status:'error'},404);
  const [_,name]=c;const pointsPath=u.pathname.endsWith('/points');
  if(!pointsPath){
   if(req.method==='GET')return json(collections.has(name)||existingCollection?{result:{}}:{status:'error'},collections.has(name)||existingCollection?200:404);
   if(req.method==='PUT'){
    if(interruptAt==='create')throw new Error('lost create receipt');
    if(collections.has(name))throw new Error('collision');
    collections.set(name,new Map());collectionCreated=name;return json({result:true});
   }
   if(req.method==='DELETE'){
    if(interruptAt==='cleanup')throw new Error('lost delete receipt');
    collections.delete(name);return json({result:true});
   }
  }
  const store=collections.get(name);
  if(!store)return json({status:'error'},404);
  if(req.method==='POST')return json({result:req.body?JSON.parse(req.body).ids.map(id=>store.get(id)).filter(Boolean):[]});
  if(req.method==='PUT'){
   if(interruptAt==='mutation')throw new Error('lost mutation receipt');
   const body=JSON.parse(req.body),row=body.points[0],current=store.get(row.id);
   const matches=()=>!body.update_filter||body.update_filter.must.every(cond=>current?.payload?.[cond.key]===cond.match.value);
   if(forceStaleApplied||(body.update_mode==='insert_only'&&!current)||(body.update_mode==='update_only'&&current&&matches()))store.set(row.id,row);
   return json({result:{operation_id:calls.length,status:'completed'}});
  }
  throw new Error('Unexpected fetch');
 };
 return {fetchFn,calls,collections,get created(){return collectionCreated;}};
}

test('rejects non-loopback, redirects, unsupported modes and wrong consent before any fetch',async()=>{
 const wrong=['http://localhost:6333/','http://127.0.0.1/','https://127.0.0.1:6333/','http://127.0.0.2:6333/','http://127.0.0.1:6333/collections/a','http://user:password@127.0.0.1:6333/','http://127.0.0.1:6333/?x=1','http://127.0.0.1:6333/#x'];
 for(const url of wrong)assert.throws(()=>validateQdrantF09c6Options({endpoint:url}));
 assert.throws(()=>validateQdrantF09c6Options({endpoint,mode:'disposable'}));
 assert.throws(()=>validateQdrantF09c6Options({endpoint,mode:'other'}));
 assert.throws(()=>validateQdrantF09c6Options({endpoint,cleanupConsent:F09C6_CLEANUP_CONSENT}));
 assert.throws(()=>validateQdrantF09c6Options({endpoint,mode:'disposable',consent:F09C6_CONSENT,cleanupConsent:'wrong'}));
 let contacted=false;
 await assert.rejects(runQdrantF09c6HostProbe({endpoint:'http://example.com:6333/',mode:'disposable'},()=>{contacted=true;}));
 assert.equal(contacted,false);
});
test('read only preflight never writes or certifies production',async()=>{
 const mock=mockQdrant();const res=await runQdrantF09c6HostProbe({endpoint},mock.fetchFn);
 assert.equal(res.status,'PREFLIGHT_ONLY');assert.equal(res.serverVersion,'1.17.0');
 assert.deepEqual(mock.calls.map(c=>c.method),['GET']);assert.equal(res.productionPermission,false);assert.equal(res.atomicBackendCertified,false);
});
test('unsupported backend version prevents mutation',async()=>{
 const mock=mockQdrant({version:'1.16.9'});const res=await runQdrantF09c6HostProbe({endpoint,mode:'disposable',consent:F09C6_CONSENT},mock.fetchFn);
 assert.equal(res.status,'FAILED_OR_UNCERTAIN');assert.equal(res.steps.at(-1).detail,'F09C6_SERVER_VERSION_UNSUPPORTED');assert.equal(mock.calls.length,1);
});
test('disposable Qdrant candidate exercises insert, update, skipped stale update, skipped duplicate insert; no apply certification',async()=>{
 const mock=mockQdrant();const res=await runQdrantF09c6HostProbe({endpoint,mode:'disposable',consent:F09C6_CONSENT},mock.fetchFn);
 assert.equal(res.status,'CANDIDATE_HOST_OBSERVED_NO_PRODUCTION_CERTIFICATION');assert.equal(res.atomicBackendCertified,false);
 assert.deepEqual(res.steps.map(s=>s.name),['version_1_17_or_newer','fresh_disposable_collection','insert_only','revision_matched_update_only','stale_revision_rejected','existing_insert_only_rejected']);
 assert.equal(mock.collections.size,1);assert.equal(mock.created,res.createdDisposableCollection);
 const writes=mock.calls.filter(c=>c.method==='PUT'&&c.path.endsWith('/points'));
 assert.deepEqual(writes.map(w=>w.body.update_mode),['insert_only','update_only','update_only','insert_only']);
 assert.equal(writes[2].body.update_filter.must[0].match.value,1);
 assert.equal(writes.every(w=>w.query==='?wait=true&ordering=strong'),true);
});
test('explicit cleanup affects only this probe collection after successful sequence',async()=>{
 const mock=mockQdrant();const res=await runQdrantF09c6HostProbe({endpoint,mode:'disposable',consent:F09C6_CONSENT,cleanupConsent:F09C6_CLEANUP_CONSENT},mock.fetchFn);
 assert.equal(res.status,'CANDIDATE_HOST_OBSERVED_NO_PRODUCTION_CERTIFICATION');assert.equal(mock.collections.size,0);
 assert.equal(mock.calls.filter(c=>c.method==='DELETE').length,1);assert.equal(res.steps.at(-1).name,'disposable_cleanup');
});
test('create-response ambiguity leaves named collection for investigation without auto cleanup',async()=>{
 const mock=mockQdrant({interruptAt:'create'});const res=await runQdrantF09c6HostProbe({endpoint,mode:'disposable',consent:F09C6_CONSENT,cleanupConsent:F09C6_CLEANUP_CONSENT},mock.fetchFn);
 assert.equal(res.status,'FAILED_OR_UNCERTAIN');assert.match(res.createdDisposableCollection,/^vh_f09c6_disposable_/);
 assert.equal(mock.calls.filter(c=>c.method==='DELETE').length,0);
});
test('mutation-response ambiguity disables retries and automatic cleanup',async()=>{
 const mock=mockQdrant({interruptAt:'mutation'});const res=await runQdrantF09c6HostProbe({endpoint,mode:'disposable',consent:F09C6_CONSENT,cleanupConsent:F09C6_CLEANUP_CONSENT},mock.fetchFn);
 assert.equal(res.status,'FAILED_OR_UNCERTAIN');assert.equal(mock.calls.filter(c=>c.path.endsWith('/points')&&c.method==='PUT').length,1);
 assert.equal(mock.calls.filter(c=>c.method==='DELETE').length,0);
});
test('candidate detects broken stale-write enforcement',async()=>{
 const mock=mockQdrant({forceStaleApplied:true});const res=await runQdrantF09c6HostProbe({endpoint,mode:'disposable',consent:F09C6_CONSENT},mock.fetchFn);
 assert.equal(res.status,'FAILED_OR_UNCERTAIN');assert.equal(res.steps.at(-1).detail,'F09C6_STALE_CONDITION_BYPASS');
});
test('candidate refuses collection collision',async()=>{
 const mock=mockQdrant({existingCollection:true});const res=await runQdrantF09c6HostProbe({endpoint,mode:'disposable',consent:F09C6_CONSENT},mock.fetchFn);
 assert.equal(res.status,'FAILED_OR_UNCERTAIN');assert.equal(res.steps.at(-1).detail,'F09C6_COLLECTION_COLLISION');
 assert.deepEqual(mock.calls.map(c=>c.method),['GET','GET']);
});

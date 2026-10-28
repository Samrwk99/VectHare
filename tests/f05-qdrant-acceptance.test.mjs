import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runF05QdrantAcceptance,registerF05AcceptanceRoutes,F05_ACCEPTANCE_CONSENT,F05_ACCEPTANCE_STAGES} from '../lib/f05-qdrant-acceptance.js';
function fakeQdrant({failWrite=false}={}){
 const collections=new Map(),points=new Map(),calls=[];let mutations=0;
 return {collections,points,calls,get mutations(){return mutations;},async _request(method,route,body){
  calls.push({method,route,body});
  const name=route.match(/^\/collections\/(vh2_[a-f0-9]{48})/)?.[1];
  if(!name)throw Error('bad route');
  if(method==='GET'&&route===`/collections/${name}`){
   if(!collections.has(name))throw Object.assign(new Error('not found'),{httpStatus:404});
   return {result:{status:'green',config:{params:{vectors:collections.get(name).vectors}},payload_schema:collections.get(name).indexes}};
  }
  if(method==='PUT'&&route===`/collections/${name}`){if(collections.has(name))throw Error('pre-existing collection');collections.set(name,{vectors:body.vectors,indexes:{}});return {result:true};}
  if(method==='PUT'&&route===`/collections/${name}/index?wait=true`){collections.get(name).indexes[body.field_name]={data_type:'keyword'};return {result:{status:'completed',operation_id:1}};}
  const rows=points.get(name)??new Map();points.set(name,rows);
  if(method==='POST'&&route.endsWith('/points/scroll')){
   const all=[...rows.values()].filter(p=>body.filter.must.every(f=>p.payload[f.key]===f.match.value));
   const start=body.offset?Number(body.offset):0;
   return {result:{points:all.slice(start,start+body.limit).map(p=>({...p,vector:body.with_vector?p.vector:undefined})),next_page_offset:start+body.limit<all.length?start+body.limit:null}};
  }
  if(method==='POST'&&route.endsWith('/points/search'))return {result:[...rows.values()].filter(p=>body.filter.must.every(f=>p.payload[f.key]===f.match.value)).map(p=>({...p,score:0.87}))};
  if(method==='PUT'&&route.endsWith('/points?wait=true')){
   if(failWrite)throw Object.assign(new Error('connection dropped'),{code:'ECONNRESET'});
   mutations++;for(const p of body.points)rows.set(p.id,p);return {result:{operation_id:mutations,status:'completed'}};
  }
  if(method==='POST'&&route.endsWith('/points/delete?wait=true')){
   mutations++;for(const [id,p] of rows){if(body.filter.must.every(f=>p.payload[f.key]===f.match.value))rows.delete(id);}return {result:{operation_id:mutations,status:'completed'}};
  }
  throw Error('unhandled '+method+' '+route);
 }};
}
const withContext=async fn=>{const folder=await fs.mkdtemp(path.join(os.tmpdir(),'vh-f05-'));try{await fs.chmod(folder,0o700);return await fn({userScopeId:'f05-user',vectorsPath:folder});}finally{await fs.rm(folder,{recursive:true,force:true});}};
const router=()=>{const routes=new Map();return {routes,post:(p,fn)=>routes.set(p,fn)};};
const reply=()=>({code:200,body:null,status(n){this.code=n;return this;},json(b){this.body=b;return this;}});
test('F05 extends the disposable actual API contract without granting production writes',async()=>withContext(async ctx=>{
 const backend=fakeQdrant(),result=await runF05QdrantAcceptance(ctx,backend);
 assert.equal(result.success,true,JSON.stringify(result));
 assert.deepEqual(result.stages.map(s=>s.stage),F05_ACCEPTANCE_STAGES);
 assert.equal(result.externalWriterIsolationVerified,false);
 assert.equal(result.productionWritesEnabled,false);
 assert.deepEqual([...backend.points.values()].flatMap(v=>[...v.values()]),[]);
 assert.equal(backend.collections.size,1);
 assert.ok(backend.calls.every(c=>c.method!=='DELETE'&&!c.route.includes('purge')));
 assert.equal(backend.mutations,3); // one insert, metadata update and scoped deletion
}));
test('F05 uncertainty does not retry a backend write or drop a collection',async()=>withContext(async ctx=>{
 const backend=fakeQdrant({failWrite:true}),result=await runF05QdrantAcceptance(ctx,backend);
 assert.equal(result.success,false);
 assert.equal(result.productionWritesEnabled,false);
 assert.equal(result.stages.at(-1).status,'FAILED_OR_UNCERTAIN');
 assert.equal(backend.calls.filter(c=>c.route.endsWith('/points?wait=true')).length,1);
 assert.equal(backend.calls.some(c=>c.method==='DELETE'),false);
}));
test('F05 route validates exact consent, local selector and user identity before connecting',async()=>{
 const r=router();let connections=0;
 registerF05AcceptanceRoutes(r,{backendPool:{get:async()=>{connections++;return fakeQdrant();}}});
 const call=async(ctx,body)=>{const res=reply();await r.routes.get('/v2/diagnostics/qdrant-f05')({s03:ctx,body,headers:{'x-vecthare-f05-diagnostic':'1'}},res);return res;};
 for(const b of [{},{configId:'default',consent:F05_ACCEPTANCE_CONSENT},
  {configId:'local',consent:F05_ACCEPTANCE_CONSENT,collection:'victim'},
  {configId:'local',consent:'yes'}]){
  assert.equal((await call({userScopeId:'u',vectorsPath:'/tmp'},b)).code,403);
 }
 assert.equal((await call(null,{configId:'local',consent:F05_ACCEPTANCE_CONSENT})).code,403);
 assert.equal(connections,0);
});
test('F05 route accepts only disposable host run, and reports honest blockers',async()=>withContext(async ctx=>{
 const r=router();registerF05AcceptanceRoutes(r,{backendPool:{get:async()=>fakeQdrant()}});
 const res=reply();await r.routes.get('/v2/diagnostics/qdrant-f05')({s03:ctx,body:{configId:'local',consent:F05_ACCEPTANCE_CONSENT},headers:{'x-vecthare-f05-diagnostic':'1'}},res);
 assert.equal(res.code,200,JSON.stringify(res.body));
 assert.equal(res.body.success,true);
 assert.equal(res.body.restartPersistenceVerified,false);
 assert.ok(res.body.remainingProductionBlockers.includes('EXTERNAL_WRITER_CAS_UNPROVEN'));
}));
test('F05 real Qdrant HTTP transport path against disposable socket fixture',async()=>withContext(async ctx=>{
 const {createServer}=await import('node:http');
 const {createQdrantBackend}=await import('../qdrant-backend.js');
 const cols=new Map(),points=new Map();let writes=0;
 const server=createServer(async(req,res)=>{
  try{
   let incoming='';for await(const piece of req)incoming+=piece;
   const b=incoming?JSON.parse(incoming):{};
   const emit=(result,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify({result}));};
   if(req.method==='GET'&&req.url==='/collections')return emit({collections:[...cols.keys()].map(name=>({name}))});
   const name=req.url.match(/^\/collections\/(vh2_[a-f0-9]{48})/)?.[1];
   if(!name)return emit(null,404);
   if(req.method==='GET'&&req.url===`/collections/${name}`){
    if(!cols.has(name))return emit(null,404);
    const {vectors,indexes}=cols.get(name);return emit({config:{params:{vectors}},payload_schema:indexes,status:'green'});
   }
   if(req.method==='PUT'&&req.url===`/collections/${name}`){
    if(cols.has(name))return emit(null,409);
    cols.set(name,{vectors:b.vectors,indexes:{}});return emit(true);
   }
   if(req.method==='PUT'&&req.url===`/collections/${name}/index?wait=true`){
    cols.get(name).indexes[b.field_name]={data_type:'keyword'};return emit({status:'completed',operation_id:1});
   }
   const rows=points.get(name)??new Map();points.set(name,rows);
   if(req.method==='POST'&&req.url===`/collections/${name}/points/scroll`){
    const matched=[...rows.values()].filter(p=>b.filter.must.every(x=>p.payload[x.key]===x.match.value));
    return emit({points:matched.slice(0,b.limit).map(p=>({...p,vector:b.with_vector?p.vector:undefined})),next_page_offset:null});
   }
   if(req.method==='POST'&&req.url===`/collections/${name}/points/search`){
    return emit([...rows.values()].filter(p=>b.filter.must.every(x=>p.payload[x.key]===x.match.value)).map(p=>({...p,score:.8})));
   }
   if(req.method==='PUT'&&req.url===`/collections/${name}/points?wait=true`){
    writes++;for(const p of b.points)rows.set(p.id,p);return emit({status:'completed',operation_id:writes});
   }
   if(req.method==='POST'&&req.url===`/collections/${name}/points/delete?wait=true`){
    writes++;for(const [id,p] of rows)if(b.filter.must.every(x=>p.payload[x.key]===x.match.value))rows.delete(id);
    return emit({status:'completed',operation_id:writes});
   }
   return emit(null,404);
  }catch(e){res.writeHead(500);res.end(String(e.message));}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const backend=createQdrantBackend();await backend.initialize({url:`http://127.0.0.1:${server.address().port}`});
  const result=await runF05QdrantAcceptance(ctx,backend);
  assert.equal(result.success,true,JSON.stringify(result));
  assert.equal(result.stages.length,F05_ACCEPTANCE_STAGES.length);
  assert.equal(cols.size,1);
  assert.equal([...points.values()][0].size,0);
  assert.equal(writes,3);
 }finally{server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}
}));

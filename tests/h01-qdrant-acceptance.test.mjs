import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runQdrantDisposableAcceptance,registerH01AcceptanceRoutes} from '../lib/h01-qdrant-acceptance.js';
function mockQdrant({failAt=null}={}){
 const points=new Map(),calls=[];let schema=null;
 return {points,calls,async _request(method,p,body){
  calls.push({method,path:p,body});
  if(failAt && p.includes(failAt))throw Object.assign(new Error('backend down'),{httpStatus:503});
  if(method==='GET'&&p.startsWith('/collections/')){
   if(!schema)throw Object.assign(new Error('missing'),{httpStatus:404});
   return {result:{config:{params:{vectors:{size:4,distance:'Dot'}}},status:'green'}};
  }
  if(method==='PUT'&&p.startsWith('/collections/')&&!p.includes('/index')&&!p.includes('/points')){
   assert.equal(schema,null);schema=body;return {result:true};
  }
  if(method==='PUT'&&p.includes('/index?wait=true'))return{result:{status:'completed'}};
  if(method==='POST'&&p.includes('/points/scroll')){
   const matching=[...points.values()].filter(point=>body.filter.must.every(v=>point.payload[v.key]===v.match.value));
   return{result:{points:matching.slice(0,body.limit).map(point=>({...point,vector:body.with_vector?point.vector:undefined})),next_page_offset:null}};
  }
  if(method==='POST'&&p.includes('/points/search'))return {result:[...points.values()].filter(point=>body.filter.must.every(v=>point.payload[v.key]===v.match.value)).map(point=>({...point,score:0.8}))};
  if(method==='PUT'&&p.includes('/points?wait=true')){
   for(const point of body.points)points.set(point.id,point);
   return {result:{status:'completed',operation_id:1}};
  }
  if(method==='POST'&&p.includes('/points/delete?wait=true')){
   for(const [id,point] of points)if(body.filter.must.every(v=>point.payload[v.key]===v.match.value))points.delete(id);
   return {result:{status:'completed',operation_id:2}};
  }
  throw Error('unexpected '+method+' '+p);
 }};
}
const reply=()=>({statusCode:200,data:null,status(n){this.statusCode=n;return this;},json(x){this.data=x;return this;}});
test('H01 real API workflow mock: isolated creation, insert/search/edit/delete verified without physical purge',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'h01-accept-'));
 try{
  const backend=mockQdrant(),result=await runQdrantDisposableAcceptance({userScopeId:'alice',vectorsPath:dir},backend);
  assert.equal(result.success,true,JSON.stringify(result));
  assert.equal(result.productionWritesEnabled,false);
  assert.deepEqual(result.stages.filter(s=>s.result==='PASS').map(s=>s.name),['provision','insert','get','query','edit','revision','delete']);
  assert.equal(backend.points.size,0);
  assert.equal(backend.calls.some(x=>x.path.endsWith('/delete')||x.method==='DELETE'),false);
  assert.ok(backend.calls.every(x=>!x.path.includes('/purge')));
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('H01 failure after create keeps disposable collection and explicitly uncertain state',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'h01-accept-'));
 try{const backend=mockQdrant({failAt:'/points?wait=true'}),result=await runQdrantDisposableAcceptance({userScopeId:'alice',vectorsPath:dir},backend);
  assert.equal(result.success,false);assert.equal(result.productionWritesEnabled,false);assert.ok(result.disposableCollection.startsWith('vh2_'));
  assert.equal(backend.calls.some(x=>x.method==='DELETE'),false);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('H01 route refuses unconfirmed, forged and concurrent probes before backend dispatch',async()=>{
 const map=new Map();let gets=0;
 registerH01AcceptanceRoutes({post:(p,f)=>map.set(p,f)},{backendPool:{get:async()=>{gets++;return mockQdrant();}}});
 const route=map.get('/v2/diagnostics/qdrant-contract');
 for(const body of [{}, {confirmDisposable:true,configId:'local',apiKey:'bad'}, {confirmDisposable:true,configId:'remote'}]) {
  const res=reply();await route({body,s03:{userScopeId:'alice',vectorsPath:'/tmp'}},res);
  assert.equal(res.statusCode,400);
 }
 const res=reply();await route({body:{confirmDisposable:true,configId:'local'},s03:null},res);
 assert.equal(res.statusCode,403);assert.equal(gets,0);
});
test('H01 default run IDs are independent, never target caller-supplied collection IDs',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'h01-accept-'));
 try{
  const results=[];
  for(let i=0;i<2;i++)results.push(await runQdrantDisposableAcceptance({userScopeId:'bob',vectorsPath:dir},mockQdrant(),{runId:randomUUID()}));
  assert.notEqual(results[0].disposableCollection,results[1].disposableCollection);
  assert.equal(results.every(r=>r.success),true);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('H01 full Node HTTP Qdrant transport fixture (real fetch/JSON/request paths)',async()=>{
 const {createServer}=await import('node:http');
 const {createQdrantBackend}=await import('../qdrant-backend.js');
 const db=new Map(),points=new Map();
 const server=createServer(async(req,res)=>{
  try{
   let input='';for await(const chunk of req)input+=chunk;
   const data=input?JSON.parse(input):{};
   const respond=(result,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify({result}));};
   if(req.method==='GET'&&req.url==='/collections')return respond({collections:[...db.keys()].map(name=>({name}))});
   const name=req.url.match(/^\/collections\/(vh2_[a-f0-9]{48})/ )?.[1];
   if(!name)return respond({error:'not found'},404);
   if(req.method==='GET'&&req.url===`/collections/${name}`){
    if(!db.has(name))return respond({error:'not found'},404);
    return respond({config:{params:{vectors:db.get(name)}},status:'green'});
   }
   if(req.method==='PUT'&&req.url===`/collections/${name}`){
    if(db.has(name))return respond({error:'exists'},409);
    db.set(name,data.vectors);return respond(true);
   }
   if(req.method==='PUT'&&req.url===`/collections/${name}/index?wait=true`)return respond({status:'completed'});
   const existing=points.get(name)||new Map();points.set(name,existing);
   if(req.method==='POST'&&req.url===`/collections/${name}/points/scroll`){
    const matched=[...existing.values()].filter(point=>data.filter.must.every(m=>point.payload[m.key]===m.match.value));
    return respond({points:matched.slice(0,data.limit).map(p=>({...p,vector:data.with_vector?p.vector:undefined})),next_page_offset:null});
   }
   if(req.method==='POST'&&req.url===`/collections/${name}/points/search`){
    return respond([...existing.values()].filter(p=>data.filter.must.every(m=>p.payload[m.key]===m.match.value)).map(p=>({...p,score:0.98})));
   }
   if(req.method==='PUT'&&req.url===`/collections/${name}/points?wait=true`){
    for(const p of data.points)existing.set(p.id,p);return respond({status:'completed',operation_id:1});
   }
   if(req.method==='POST'&&req.url===`/collections/${name}/points/delete?wait=true`){
    for(const [id,p] of existing)if(data.filter.must.every(m=>p.payload[m.key]===m.match.value))existing.delete(id);
    return respond({status:'completed',operation_id:2});
   }
   return respond({error:'unsupported'},404);
  }catch(e){res.writeHead(500);res.end(e.message);}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url=`http://127.0.0.1:${server.address().port}`,dir=await fs.mkdtemp(path.join(os.tmpdir(),'h01-http-'));
 try{
  const backend=createQdrantBackend();await backend.initialize({url});
  const result=await runQdrantDisposableAcceptance({userScopeId:'termux-user',vectorsPath:dir},backend);
  assert.equal(result.success,true,JSON.stringify(result));
  assert.equal(points.get(result.disposableCollection).size,0);
  assert.equal(db.size,1);
 }finally{server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));await fs.rm(dir,{recursive:true,force:true});}
});

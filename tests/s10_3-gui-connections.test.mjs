import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setGuiConnection,getGuiConnection,deleteGuiConnection,describeConnection,validateGuiConnection,registerGuiConnectionRoutes} from '../lib/s10-gui-connections.js';
import {BackendPool} from '../lib/s03-backends.js';
async function tmp(fn){let dir=await fs.mkdtemp(path.join(os.tmpdir(),'vh-gui-config-'));
 try{const vec=path.join(dir,'vectors');await fs.mkdir(vec,{mode:0o700});return await fn({userScopeId:'test',vectorsPath:vec},dir);}
 finally{await fs.rm(dir,{recursive:true,force:true});}}
function rejects(fn,code){return assert.rejects(fn,e=>e.code===code);}
test('S10.3 local Qdrant defaults to loopback without environment/config files',async()=>tmp(async(ctx)=>{
 const pool=new BackendPool({qdrant:async()=>({async initialize(config){this.config=config;}})});
 const db=await pool.get(ctx,'qdrant','local');assert.equal(db.config.url,'http://127.0.0.1:6333');
}));
test('S10.3 user can configure custom localhost port via GUI storage, persists after restart',async()=>tmp(async(ctx)=>{
 await setGuiConnection(ctx,'qdrant',{configId:'local',host:'127.0.0.1',port:6345});
 const x=await getGuiConnection(ctx,'qdrant','local');assert.equal(x.url,'http://127.0.0.1:6345');
 const db=await new BackendPool({qdrant:async()=>({async initialize(c){this.config=c;}})}).get(ctx,'qdrant','local');
 assert.equal(db.config.url,'http://127.0.0.1:6345');
}));
test('S10.3 GUI cloud save keeps credential solely on server and redacts API responses',async()=>tmp(async(ctx,dir)=>{
 const config={configId:'default',url:'https://example.qdrant.io',apiKey:'very-secret-123'};
 const receipt=await setGuiConnection(ctx,'qdrant',config);
 assert.equal(receipt.hasCredential,true);assert.equal(JSON.stringify(receipt).includes(config.apiKey),false);
 const file=path.join(dir,'.similharity-private','connections.json');
 const data=await fs.readFile(file,'utf8');assert.equal(data.includes(config.apiKey),true);
 const st=await fs.stat(file);if(process.platform!=='win32')assert.equal(st.mode&0o077,0);
 const partial=await setGuiConnection(ctx,'qdrant',{configId:'default',url:'https://example.qdrant.io',apiKey:''});
 assert.equal(partial.hasCredential,true);
 assert.equal((await getGuiConnection(ctx,'qdrant','default')).apiKey,config.apiKey);
 const fresh=new BackendPool({qdrant:async()=>({async initialize(c){this.config=c;}})});
 const instance=await fresh.get(ctx,'qdrant','default');assert.equal(instance.config.apiKey,config.apiKey);
}));
test('S10.3 remote non-HTTPS, dangerous hosts, arbitrary local host and unknown fields refused',async()=>{
 for(const url of ['http://cloud.qdrant.io','https://localhost','https://127.0.0.1','https://metadata.google.internal','https://api.example.org/path'])
  assert.throws(()=>validateGuiConnection('qdrant',{configId:'default',url}),e=>e.code.startsWith('GUI_REMOTE'));
 for(const host of ['example.com','10.0.0.1','127.0.0.2'])
  assert.throws(()=>validateGuiConnection('qdrant',{configId:'local',host,port:6333}),e=>e.code==='GUI_LOCAL_HOST_RESTRICTED');
 assert.throws(()=>validateGuiConnection('qdrant',{configId:'local',host:'localhost',port:0}),e=>e.code==='GUI_PORT_INVALID');
});
test('S10.3 Milvus GUI has protected per-user configuration',async()=>tmp(async(ctx)=>{
 await setGuiConnection(ctx,'milvus',{configId:'default',address:'localhost:19530',ssl:false,token:'user:password'});
 const val=await getGuiConnection(ctx,'milvus','default');assert.equal(val.token,'user:password');
 assert.equal(describeConnection('milvus','default',val).token,undefined);
 await deleteGuiConnection(ctx,'milvus','default');assert.equal(await getGuiConnection(ctx,'milvus','default'),null);
}));
test('S10.3 users are isolated by authenticated host data directories',async()=>tmp(async(ctx,dir)=>{
 const second=path.join(dir,'second');await fs.mkdir(second);await fs.mkdir(path.join(second,'vectors'));
 await setGuiConnection(ctx,'qdrant',{configId:'default',url:'https://a.qdrant.io',apiKey:'userA'});
 const secondContext={userScopeId:'another',vectorsPath:path.join(second,'vectors')};
 assert.equal(await getGuiConnection(secondContext,'qdrant','default'),null);
 await setGuiConnection(secondContext,'qdrant',{configId:'default',url:'https://b.qdrant.io',apiKey:'userB'});
 assert.equal((await getGuiConnection(ctx,'qdrant','default')).apiKey,'userA');
}));
test('S10.3 GUI routes require a custom configuration header and keep vector writes disabled',async()=>tmp(async(ctx)=>{
 const handlers=new Map();let cleared=0;
 const router={get:(p,f)=>handlers.set('GET '+p,f),put:(p,f)=>handlers.set('PUT '+p,f),delete:(p,f)=>handlers.set('DELETE '+p,f)};
 registerGuiConnectionRoutes(router,{backendPool:{clear(){cleared++;}}});
 function res(){return {statusCode:200,data:null,status(n){this.statusCode=n;return this;},json(obj){this.data=obj;return this;}};}
 let response=res();await handlers.get('PUT /v2/connections/:backend')({s03:ctx,params:{backend:'qdrant'},body:{configId:'local',host:'localhost',port:6333},headers:{}},response);
 assert.equal(response.statusCode,403);assert.equal(cleared,0);
 response=res();await handlers.get('PUT /v2/connections/:backend')({s03:ctx,params:{backend:'qdrant'},body:{configId:'local',host:'localhost',port:6333},headers:{'x-vecthare-configuration':'1','sec-fetch-site':'same-origin'}},response);
 assert.equal(response.statusCode,200);assert.equal(response.data.writesEnabled,false);assert.equal(cleared,1);
 response=res();await handlers.get('GET /v2/connections/:backend')({s03:ctx,params:{backend:'qdrant'},query:{configId:'local'}},response);
 assert.equal(response.data.configured,true);
}));

test('S10.3 changing Qdrant cloud endpoint never carries the old API key to a different host',async()=>tmp(async(ctx)=>{
 await setGuiConnection(ctx,'qdrant',{configId:'default',url:'https://a.qdrant.io',apiKey:'key-for-a'});
 const status=await setGuiConnection(ctx,'qdrant',{configId:'default',url:'https://b.qdrant.io',apiKey:''});
 assert.equal(status.hasCredential,false);
 assert.equal((await getGuiConnection(ctx,'qdrant','default')).apiKey,undefined);
}));

test('S10.3 saved GUI localhost port initializes through real HTTP against a disposable Qdrant-shaped fixture',async()=>tmp(async(ctx)=>{
 const http=await import('node:http');
 const server=http.createServer((req,res)=>{
   if(req.method==='GET'&&req.url==='/collections'){
     res.writeHead(200,{'Content-Type':'application/json'});
     res.end(JSON.stringify({result:{collections:[]},status:'ok'}));
   }else{res.writeHead(404);res.end();}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
   const port=server.address().port;
   await setGuiConnection(ctx,'qdrant',{configId:'local',host:'127.0.0.1',port});
   const pool=new BackendPool();
   const backend=await pool.get(ctx,'qdrant','local');
   assert.equal(backend.baseUrl,`http://127.0.0.1:${port}`);
   assert.equal(await backend.healthCheck(),true);
 }finally{await new Promise(r=>server.close(r));}
}));

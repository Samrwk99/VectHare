import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { BackendPool, localQdrantConfiguration, readServerConnection } from '../lib/s03-backends.js';
import { validateClientConfig } from '../lib/s03-security.js';

const identity={userScopeId:'s10_2-alice', vectorsPath:'/tmp/s10_2-alice-vectors'};
async function withEnv(name,value,cb) {
  const before=process.env[name];
  if(value===undefined)delete process.env[name];else process.env[name]=value;
  try {return await cb();} finally {if(before===undefined)delete process.env[name];else process.env[name]=before;}
}
async function localServer(callback) {
  const calls=[];
  const server=http.createServer((req,res)=>{
    calls.push({method:req.method,url:req.url,apiKey:req.headers['api-key']??null});
    if(req.method==='GET' && req.url==='/collections'){
      res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({result:{collections:[]},status:'ok'}));
    }else{res.writeHead(405);res.end();}
  });
  await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}`;
  try {return await callback(url,calls);}finally{await new Promise(resolve=>server.close(resolve));}
}

test('S10.2 local and remote selectors are explicit; no browser endpoint or key accepted',()=>{
  assert.equal(validateClientConfig({configId:'local'}),'local');
  assert.equal(validateClientConfig({configId:'default'}),'default');
  assert.equal(validateClientConfig({}),'default');
  for(const body of [{configId:'local',url:'http://attacker:6333'},{configId:'local',apiKey:'secret'},
      {configId:'evil'},{configId:'Local'},{configId:'local',host:'127.0.0.1'}])
    assert.throws(()=>validateClientConfig(body));
});

test('S10.2 local preset uses fixed loopback default independent of the private config',()=>{
  assert.deepEqual(localQdrantConfiguration({}),{url:'http://127.0.0.1:6333'});
  assert.deepEqual(localQdrantConfiguration({SIMILHARITY_LOCAL_QDRANT_URL:'http://localhost:7333'}),{url:'http://localhost:7333'});
  assert.deepEqual(localQdrantConfiguration({SIMILHARITY_LOCAL_QDRANT_URL:'http://[::1]:6333'}),{url:'http://[::1]:6333'});
});

test('S10.2 refuses nonloopback, userinfo, path and invalid port in local preset',()=>{
  const bad=['https://127.0.0.1:6333','http://192.168.1.100:6333','http://10.0.0.1:6333',
    'http://127.0.0.1','http://127.0.0.1:6333/private','http://user:pass@127.0.0.1:6333',
    'http://127.0.0.1:6333?x=1','http://127.0.0.1:6333#h','http://attacker.test:6333',
    'http://127.0.0.1:99999'];
  for(const url of bad)assert.throws(()=>localQdrantConfiguration({SIMILHARITY_LOCAL_QDRANT_URL:url}),
    e=>e.code==='S03_LOCAL_QDRANT_INVALID',url);
});

test('S10.2 actual Qdrant initialization uses loopback GET and no writes or browser secrets',async()=>{
  await localServer(async(url,calls)=>{
    await withEnv('SIMILHARITY_LOCAL_QDRANT_URL',url,async()=>{
      await withEnv('SIMILHARITY_SERVER_CONFIG_DIR',undefined,async()=>{
        const pool=new BackendPool();
        const a=await pool.get(identity,'qdrant','local');
        assert.equal(a.baseUrl,url);assert.equal(a.apiKey,null);
        assert.strictEqual(a,await pool.get(identity,'qdrant','local'));
        assert.notStrictEqual(a,await pool.get({...identity,userScopeId:'s10_2-bob'},'qdrant','local'));
        assert.equal(await a.healthCheck(),true);
        assert.ok(calls.length>=3);assert.ok(calls.every(c=>c.method==='GET'&&c.url==='/collections'&&c.apiKey===null));
        await assert.rejects(()=>pool.get(identity,'qdrant','default'),e=>e.code==='S03_SERVER_CONFIG_MISSING');
        await assert.rejects(()=>pool.get(identity,'milvus','local'),e=>e.code==='S03_CONFIG_SELECTOR_UNKNOWN');
      });
    });
  });
});

test('S10.2 remote default never silently falls back to local Qdrant',async()=>{
  await withEnv('SIMILHARITY_SERVER_CONFIG_DIR',undefined,async()=>{
    await assert.rejects(()=>readServerConnection(identity,'qdrant'),e=>e.code==='S03_SERVER_CONFIG_MISSING');
  });
});

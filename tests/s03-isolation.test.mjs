import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { trustedUserId, authenticatedContext, forbidOwnerSpoof, validateClientConfig,
    lookupAuthorizedReservation, legacyReadBoundary, s03SensitiveRouteBoundary,
    exposedSafeSource } from '../lib/s03-security.js';
import { BackendPool, readServerConnection, configUserDirectory } from '../lib/s03-backends.js';
import { CollectionRegistry } from '../lib/s02-registry.js';

const rejection = (fn, code) => assert.rejects(fn,e => e.code===code);
const throws = (fn, code) => assert.throws(fn,e=>e.code===code);
const sample = {schemaVersion:1,backends:{qdrant:{url:'http://127.0.0.1:6333',apiKey:'private-A'},
    milvus:{address:'localhost:19530',token:'private-M',ssl:false}}};
async function fixture(callback) {
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'s03-user-'));
    const adminRoot=await fs.mkdtemp(path.join(os.tmpdir(),'s03-admin-'));
    await fs.chmod(root,0o700);
    await fs.chmod(adminRoot,0o700);
    const configDir=configUserDirectory(adminRoot,'alice');
    await fs.mkdir(configDir,{mode:0o700});
    const old=process.env.SIMILHARITY_SERVER_CONFIG_DIR;
    process.env.SIMILHARITY_SERVER_CONFIG_DIR=adminRoot;
    try { await callback({root,adminRoot,configDir,ctx:{userScopeId:'alice',vectorsPath:root},
        req:{user:{profile:{handle:'alice'},directories:{vectors:root}}}}); }
    finally {
        if(old===undefined)delete process.env.SIMILHARITY_SERVER_CONFIG_DIR;
        else process.env.SIMILHARITY_SERVER_CONFIG_DIR=old;
        await fs.rm(root,{recursive:true,force:true});
        await fs.rm(adminRoot,{recursive:true,force:true});
    }
}
async function provision(configDir, config=sample) {
    const file=path.join(configDir,'server-connections.json');
    await fs.writeFile(file,JSON.stringify(config),{mode:0o600});
    await fs.chmod(file,0o600);
    return file;
}
function response() {return {code:null,result:null,status(n){this.code=n;return this;},json(v){this.result=v;return this;}};}
function apply(middleware,req) { const res=response();let next=false;middleware(req,res,()=>next=true);return {res,next}; }

test('S03 rejects missing host user, unverified IDs and client owner impersonation',()=>{
    for(const req of [{},{body:{userScopeId:'alice'}},{user:{profile:{handle:'../alice'}}},
        {user:{id:123}},{user:{profile:{handle:''}}}]) throws(()=>trustedUserId(req),'S03_HOST_IDENTITY_UNVERIFIED');
    assert.equal(trustedUserId({user:{profile:{handle:'alice'}}}),'alice');
    throws(()=>forbidOwnerSpoof({scope:{userScopeId:'bob'}},{userScopeId:'alice'}),'S03_OWNER_CONFLICT');
    throws(()=>forbidOwnerSpoof({filters:{tenantId:'bob'}},{userScopeId:'alice'}),'S03_OWNER_CONFLICT');
    assert.equal(forbidOwnerSpoof({filters:{sourceId:'chatA'}},{userScopeId:'alice'}),undefined);
});

test('S03 resolves authenticated path from host only and refuses request-selected roots',async()=>fixture(async({root,req})=>{
    const a=await authenticatedContext({...req,body:{userScopeId:'fake',vectorsPath:'/etc'}});
    assert.deepEqual(a,{userScopeId:'alice',vectorsPath:root});
    await rejection(()=>authenticatedContext({user:req.user,body:{}, ...{user:{profile:{handle:'alice'},directories:{vectors:'relative'}}}}),
        'S03_USER_DIRECTORY_UNVERIFIED');
}));

test('S03 refuses two different host users mapped to the same physical vectors root',async()=>fixture(async({req})=>{
    await authenticatedContext(req);
    await rejection(()=>authenticatedContext({...req,user:{...req.user,profile:{handle:'bob'}}}),
        'S03_SHARED_USER_ROOT');
}));

test('S03 permits only default server-provisioned config selector',()=>{
    assert.equal(validateClientConfig({}), 'default');
    assert.equal(validateClientConfig({configId:'default'}), 'default');
    for(const invalid of [{url:'https://server'},{apiKey:'secret'},{token:'secret'},
        {configId:'evil'},{configId:'default',host:'localhost'},null,[]]) {
        assert.throws(()=>validateClientConfig(invalid));
    }
});

test('S03 server configuration must be private, regular, user-scoped',async()=>fixture(async({configDir,ctx,adminRoot})=>{
    await rejection(()=>readServerConnection(ctx,'qdrant'),'S03_SERVER_CONFIG_MISSING');
    const file=await provision(configDir);
    const config=await readServerConnection(ctx,'qdrant');
    assert.equal(config.apiKey,'private-A');
    assert.equal((await readServerConnection(ctx,'milvus')).token,'private-M');
    await fs.chmod(file,0o644);
    await rejection(()=>readServerConnection(ctx,'qdrant'),'S03_SERVER_CONFIG_UNTRUSTED');
    await fs.chmod(file,0o600);
    await fs.chmod(configDir,0o777);
    await rejection(()=>readServerConnection(ctx,'milvus'),'S03_SERVER_CONFIG_UNTRUSTED');
    await fs.chmod(configDir,0o700);
    const actual=path.join(adminRoot,'original.json');
    await fs.rename(file,actual);
    await fs.symlink(actual,file);
    await rejection(()=>readServerConnection(ctx,'qdrant'),'S03_SERVER_CONFIG_UNTRUSTED');
}));

test('S03 remote configurations reject unexpected fields and unsafe schemes',async()=>fixture(async({ctx,configDir})=>{
    const bad=[
        {qdrant:{url:'http://remote.test:6333'}},
        {qdrant:{url:'https://example.test/a'}},
        {qdrant:{url:'https://user:pass@example.test'}},
        {qdrant:{url:'https://remote.test',unknown:'ok'}},
        {milvus:{address:'remote.test:19530',ssl:false}},
        {milvus:{address:'localhost:19530',ssl:'true'}}
    ];
    for(const entry of bad) {
        await provision(configDir,{schemaVersion:1,backends:entry});
        await rejection(()=>readServerConnection(ctx,Object.keys(entry)[0]),'S03_SERVER_CONFIG_INVALID');
    }
}));

test('S03 backend pool isolates connections for users, directory roots and changed credentials',async()=>fixture(async({ctx,configDir,adminRoot})=>{
    await provision(configDir);
    let created=0;
    const factory=()=>({id:++created,async initialize(config){this.connection=config;},async healthCheck(){return true;}});
    const pool=new BackendPool({qdrant:factory,milvus:factory,lancedb:factory});
    const first=await pool.get(ctx,'qdrant');
    assert.strictEqual(first,await pool.get(ctx,'qdrant'));
    const bobDir=configUserDirectory(adminRoot,'bob');
    await fs.mkdir(bobDir,{mode:0o700});
    await provision(bobDir, {...sample,backends:{...sample.backends,qdrant:{...sample.backends.qdrant,apiKey:'private-B'}}});
    const second=await pool.get({...ctx,userScopeId:'bob'},'qdrant');
    assert.equal(second.connection.apiKey,'private-B');
    assert.notStrictEqual(first,second);
    const l=await pool.get(ctx,'lancedb');
    assert.equal(l.connection,ctx.vectorsPath);
    const m=await pool.get(ctx,'milvus');
    assert.notStrictEqual(m,first);
    await provision(configDir,{schemaVersion:1,backends:{...sample.backends,qdrant:{...sample.backends.qdrant,apiKey:'rotated'}}});
    const third=await pool.get(ctx,'qdrant');
    assert.notStrictEqual(third,first);
    assert.equal(third.connection.apiKey,'rotated');
    assert.equal(created,5);
}));

test('S03 same user concurrent requests share one initialization, failed init does not poison pool',async()=>fixture(async({ctx,configDir})=>{
    await provision(configDir);
    let count=0;
    const pool=new BackendPool({qdrant:()=>({async initialize(){count++;await Promise.resolve();}})});
    const [a,b,c]=await Promise.all([pool.get(ctx,'qdrant'),pool.get(ctx,'qdrant'),pool.get(ctx,'qdrant')]);
    assert.equal(a,b);assert.equal(b,c);assert.equal(count,1);
    let failures=0;
    const failPool=new BackendPool({qdrant:()=>({async initialize(){failures++;throw Error('offline');}})});
    await assert.rejects(()=>failPool.get(ctx,'qdrant'));
    await assert.rejects(()=>failPool.get(ctx,'qdrant'));
    assert.equal(failures,2);
}));

test('S03 request ownership protected at registry lookup, and reservation does not enable writes',async()=>fixture(async({root,ctx})=>{
    const registry=new CollectionRegistry(path.join(root,'.similharity'));
    const scope={userScopeId:'alice',collectionId:'chat-a',type:'chat',sourceId:'chat-a',branchId:'fork-b'};
    const embedding={source:'transformers',model:'model',dimension:384,metric:'cosine'};
    const input={backend:'qdrant',scope,embedding};
    const reservation=await registry.reserve(input);
    const result=await lookupAuthorizedReservation(ctx,input);
    assert.equal(result.entry.key,reservation.key);
    assert.equal(result.operational,false);
    const foreign={...input,scope:{...scope,userScopeId:'bob'}};
    await rejection(()=>lookupAuthorizedReservation(ctx,foreign),'S03_OWNER_CONFLICT');
    const unregistered=await lookupAuthorizedReservation(ctx,{...input,scope:{...scope,branchId:'fork-c'}});
    assert.equal(unregistered.entry,null);
    assert.notEqual(unregistered.identity.key,result.identity.key);
}));

test('S03 shared legacy reads and sensitive routes fail before backend invocation',()=>{
    for(const backend of ['qdrant','milvus'])for(const endpoint of ['/chunks/list','/chunks/query','/chunks/hybrid-query','/chunks/stats','/chunks/123']) {
        const req={method:endpoint==='/chunks/123'?'GET':'POST',path:endpoint,
            body:{backend},query:{backend}};
        const x=apply(legacyReadBoundary,req);
        assert.equal(x.next,false);assert.equal(x.res.code,409);
        assert.equal(x.res.result.code,'S03_SHARED_LEGACY_READ_UNVERIFIED');
    }
    assert.equal(apply(legacyReadBoundary,{method:'POST',path:'/chunks/list',body:{backend:'vectra'}}).next,true);
    for(const endpoint of ['/rerank','/open-folder']) {
        const x=apply(s03SensitiveRouteBoundary,{method:'POST',path:endpoint,body:{}});
        assert.equal(x.res.code,409);assert.equal(x.next,false);
    }
    const embed=apply(s03SensitiveRouteBoundary,{method:'POST',path:'/get-embedding',body:{apiUrl:'http://bad'}});
    assert.equal(embed.res.code,403);
});

test('S03 source name traversal refused',()=>{
    for(const s of ['../other','sub/a','',':','a\\b']) throws(()=>exposedSafeSource(s),'S03_INVALID_SOURCE');
    assert.equal(exposedSafeSource('transformers'),'transformers');
});

test('S03 no protected remote configuration is implicitly created from user vector files',async()=>fixture(async({ctx,root})=>{
    const userPath=path.join(root,'.similharity');
    await fs.mkdir(userPath,{mode:0o700});
    await provision(userPath);
    await rejection(()=>readServerConnection(ctx,'qdrant'),'S03_SERVER_CONFIG_MISSING');
}));

test('S03 no admin configuration setting produces explicit missing-config refusal',async()=>{
    const old=process.env.SIMILHARITY_SERVER_CONFIG_DIR;
    delete process.env.SIMILHARITY_SERVER_CONFIG_DIR;
    try {
        await rejection(()=>readServerConnection({userScopeId:'alice',vectorsPath:'/tmp'},'qdrant'),
            'S03_SERVER_CONFIG_MISSING');
    } finally {if(old!==undefined)process.env.SIMILHARITY_SERVER_CONFIG_DIR=old;}
});

test('S03 Qdrant backend factories have distinct mutable connection state',async()=>{
    const {createQdrantBackend}=await import('../qdrant-backend.js');
    const a=createQdrantBackend();const b=createQdrantBackend();
    assert.notStrictEqual(a,b);
    a._request=async()=>({result:{collections:[]}});
    b._request=async()=>({result:{collections:[]}});
    await a.initialize({url:'http://127.0.0.1:6333',apiKey:'A'});
    await b.initialize({url:'https://qdrant.example.com',apiKey:'B'});
    assert.equal(a.apiKey,'A');assert.equal(b.apiKey,'B');
    assert.notEqual(a.baseUrl,b.baseUrl);
});

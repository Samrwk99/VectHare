import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import qdrant from '../qdrant-backend.js';
import { s01MutationGuard, SafetyError } from '../lib/s01-safety.js';
import { safeLegacyPhysicalName } from '../lib/s02-identity.js';
import { exposedSafeSource, AccessError } from '../lib/s03-security.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const quiet = { log() {}, warn() {}, error() {}, debug() {} };
function resetQdrant() { qdrant.baseUrl = 'http://localhost:6333'; }
function fakeResponse() {
    return {
        code: null,
        data: null,
        status(n) { this.code = n; return this; },
        json(v) { this.data = v; return this; }
    };
}

async function mockModule(filename, imports) {
    const context = vm.createContext({ console: quiet, setTimeout, clearTimeout, AbortController, fetch: globalThis.fetch, URL });
    const source = await fs.readFile(path.join(root, filename), 'utf8');
    const mod = new vm.SourceTextModule(source, { context, identifier: filename });
    await mod.link(async (specifier) => {
        if (!(specifier in imports)) throw new Error(`Unexpected import ${specifier} for ${filename}`);
        const exported = imports[specifier];
        return new vm.SyntheticModule(Object.keys(exported), function () {
            for (const [key, val] of Object.entries(exported)) this.setExport(key, val);
        }, { context });
    });
    await mod.evaluate();
    return mod.namespace;
}

const denial = (fn) => assert.rejects(fn, e => e.code === 'S01_MUTATION_BLOCKED');

test('S01 middleware denies every legacy mutation URL before any handler, for every backend', () => {
    const urls = [
        ['POST', '/chunks/insert'],
        ['PATCH', '/chunks/123/text'],
        ['PATCH', '/chunks/123/metadata'],
        ['POST', '/chunks/delete'],
        ['POST', '/chunks/purge'],
        ['POST', '/purge-all'],
    ];
    for (const [method, route] of urls) {
        for (const backend of ['standard', 'vectra', 'lancedb', 'qdrant', 'milvus']) {
            const res = fakeResponse();
            let next = false;
            s01MutationGuard({ method, path: route, body: { backend } }, res, () => next = true);
            assert.equal(next, false, `unexpected network dispatch for ${backend}:${route}`);
            assert.equal(res.code, 409);
            assert.equal(res.data.success, false);
            assert.equal(res.data.code, 'S01_MUTATION_BLOCKED');
        }
    }
});

test('S01 middleware leaves nonmutating routes reachable', () => {
    for (const [method, route] of [['POST','/chunks/query'], ['POST','/chunks/list'], ['GET','/health'], ['GET','/chunks/123']]) {
        let called = false;
        s01MutationGuard({ method, path: route }, fakeResponse(), () => called = true);
        assert.equal(called, true);
    }
});

test('Qdrant dimension mismatch never attempts purge or write', async () => {
    resetQdrant();
    const calls = [];
    const old = qdrant._request;
    qdrant._request = async (method, url) => {
        calls.push(`${method} ${url}`);
        if (url === '/collections') return { result: { collections: [{ name: 'vecthare_main' }] } };
        return { result: { config: { params: { vectors: { size: 1536 } } } } };
    };
    try {
        await assert.rejects(qdrant.ensureCollection('vecthare_main', 768), e => e.code === 'DIMENSION_MISMATCH');
        assert.deepEqual(calls, ['GET /collections', 'GET /collections/vecthare_main']);
    } finally { qdrant._request = old; }
});

test('Qdrant unknown vector schema fails closed', async () => {
    resetQdrant();
    const old = qdrant._request;
    qdrant._request = async (_method, url) => url === '/collections'
        ? {result: {collections: [{name:'vecthare_main'}]}}
        : {result: {config: {params: {vectors: {named: {size:768}}}}}};
    try {
        await assert.rejects(qdrant.ensureCollection('vecthare_main', 768), e => e.code === 'SCHEMA_UNVERIFIABLE');
    } finally { qdrant._request = old; }
});

test('Qdrant matching collection schema succeeds without destructive changes', async () => {
    resetQdrant();
    const calls=[]; const old=qdrant._request;
    qdrant._request=async (method,url) => {
        calls.push(method);
        return url==='/collections'
            ? {result: {collections: [{name:'vecthare_main'}]}}
            : {result:{config:{params:{vectors:{size:768}}}}};
    };
    try { await qdrant.ensureCollection('vecthare_main', 768); assert.deepEqual(calls,['GET','GET']); }
    finally { qdrant._request=old; }
});

test('Qdrant direct legacy writes, purge and edits refuse without any network call', async () => {
    resetQdrant(); const old=qdrant._request; let requests=0;
    qdrant._request=async()=>{requests++; throw new Error('must not dispatch');};
    try {
        for (const [method,args] of [
            ['insertVectors', ['vecthare_main',[{hash:1,vector:[1,2]}]]],
            ['deleteVectors', ['vecthare_main',[1]]],
            ['purgeAll', ['vecthare_main']],
            ['purgeCollection', ['vecthare_main', {type:'chat',sourceId:'a'}]],
            ['updateItem', ['vecthare_main',1,{text:'x'}]],
            ['updateItemMetadata', ['vecthare_main',1,{x:1}]],
        ]) await denial(() => qdrant[method](...args));
        assert.equal(requests,0);
    } finally { qdrant._request=old; }
});

test('Qdrant failed search and get are errors rather than empty/absent', async () => {
    resetQdrant(); const old=qdrant._request;
    qdrant._request=async()=>{ throw new Error('backend unavailable'); };
    try {
        await assert.rejects(qdrant.queryCollection('vecthare_main',[1],10,{}), /backend unavailable/);
        await assert.rejects(qdrant.getItem('vecthare_main',1,{}), /backend unavailable/);
        await assert.rejects(qdrant.listItems('vecthare_main',{}), /backend unavailable/);
    } finally { qdrant._request=old; }
});

test('Qdrant POST failure is not transparently retried', async () => {
    resetQdrant(); let calls=0; const old=globalThis.fetch;
    globalThis.fetch=async()=>{calls++;return {ok:false,status:503,text:async()=>'{"message":"try later"}'};};
    try { await assert.rejects(qdrant._request('POST','/collections/vecthare_main/points/delete',{}),/503/); assert.equal(calls,1); }
    finally { globalThis.fetch=old; }
});

let milvus;
test('load Milvus adapter with dependency-isolated SDK mock', async () => {
    milvus=(await mockModule('milvus-backend.js', {
        '@zilliz/milvus2-sdk-node': { MilvusClient: class {}, DataType: {Int64:1,FloatVector:2,VarChar:3,JSON:4} },
        './lib/s01-safety.js': { SafetyError, denyUnsafeBackendMutation: (_backend,operation) => {throw new SafetyError('S01_MUTATION_BLOCKED',operation);} },
    })).default;
    assert.ok(milvus);
});

test('Milvus dimension mismatch preserves collection and no drop/create call', async () => {
    const calls=[];
    milvus.isConnected=true;
    milvus.client={
        listCollections: async()=>{calls.push('list');return {data:[{name:'vecthare_main'}]};},
        describeCollection: async()=>{calls.push('describe');return {schema:{fields:[{name:'vector',dim:1536}]}};},
        dropCollection: async()=>calls.push('DROP'),
        createCollection:async()=>calls.push('CREATE'),
    };
    await assert.rejects(milvus.ensureCollection('vecthare_main',768), e=>e.code==='DIMENSION_MISMATCH');
    assert.deepEqual(calls,['list','describe']);
});

test('Milvus missing vector field never drops collection', async () => {
    const calls=[];
    milvus.isConnected=true;
    milvus.client={
        listCollections: async()=>({data:[{name:'vecthare_main'}]}),
        describeCollection: async()=>({schema:{fields:[{name:'hash'}]}}),
        dropCollection: async()=>calls.push('DROP'),
    };
    await assert.rejects(milvus.ensureCollection('vecthare_main',768), e=>e.code==='SCHEMA_MISMATCH');
    assert.deepEqual(calls,[]);
});

test('Milvus description failures propagate and cannot recreate', async () => {
    const calls=[];milvus.isConnected=true;
    milvus.client={
        listCollections: async()=>({data:[{name:'vecthare_main'}]}),
        describeCollection: async()=>{throw new Error('describe down');},
        dropCollection: async()=>calls.push('DROP'),
        createCollection:async()=>calls.push('CREATE'),
    };
    await assert.rejects(milvus.ensureCollection('vecthare_main',768), /describe down/);
    assert.deepEqual(calls,[]);
});

test('Milvus direct insert/delete/update/purge are fail-closed', async () => {
    let calls=0;
    milvus.isConnected=true;
    milvus.client={delete:async()=>calls++,dropCollection:async()=>calls++};
    for (const [method,args] of [
        ['insertVectors',['vecthare_main',[{hash:1,vector:[1,2]}]]],
        ['deleteVectors',['vecthare_main',[1]]],
        ['updateItem',['vecthare_main',1,{text:'x'}]],
        ['purgeCollection',['vecthare_main',{}]],
        ['purgeCollection',['vecthare_main',{type:'chat',sourceId:'x'}]],
    ]) await denial(()=>milvus[method](...args));
    assert.equal(calls,0);
});

test('Milvus backend search/list/get failures propagate', async () => {
    milvus.isConnected=true;
    milvus.client={loadCollection:async()=>{throw new Error('backend unavailable');}};
    await assert.rejects(milvus.queryCollection('vecthare_main',[1],10),/backend unavailable/);
    await assert.rejects(milvus.listItems('vecthare_main'),/backend unavailable/);
    milvus.client.query=async()=>{throw new Error('backend unavailable');};
    await assert.rejects(milvus.getItem('vecthare_main',1),/backend unavailable/);
});

test('Milvus initialization only reads collections; never auto creates/drops', async () => {
    // isolate initialize with a custom class; earlier mock class has no listCollections.
    const calls=[];
    const alt=(await mockModule('milvus-backend.js', {
        '@zilliz/milvus2-sdk-node': { MilvusClient: class {async listCollections(){calls.push('list');return {data:[]};}},DataType:{} },
        './lib/s01-safety.js': {SafetyError,denyUnsafeBackendMutation:()=>{throw new Error('blocked');}},
    })).default;
    alt.ensureCollection=async()=>{calls.push('ensure');};
    await alt.initialize({address:'127.0.0.1:19530'});
    assert.deepEqual(calls,['list']);
});

// Tests actual index.init registration, including its fallback route handlers.
test('plugin registration keeps legacy mutation endpoints blocked even without middleware', async () => {
    const fakeBackend={};
    const noop={};
    const lib=(await import('../lib/s01-safety.js'));
    const namespace=await mockModule('index.js',{
        'node:path':{default:noop},
        'node:fs/promises':{default:noop},
        'node:child_process':{exec:()=>{throw new Error('shell call');}},
        'sanitize-filename':{default:(s)=>s},
        'vectra':{default:{LocalIndex:class {}}},
        './lancedb-backend.js':{default:fakeBackend},
        './qdrant-backend.js':{default:fakeBackend},
        './milvus-backend.js':{default:fakeBackend},
        './lib/s01-safety.js':{s01MutationGuard:lib.s01MutationGuard},
        './lib/s03-security.js':{
            authenticatedContext:async()=>({userScopeId:'tester',vectorsPath:'/tmp'}),
            forbidOwnerSpoof:()=>{},validateClientConfig:()=>{},lookupAuthorizedReservation:async()=>({}),
            legacyReadBoundary:(_r,_s,n)=>n(),s03SensitiveRouteBoundary:(_r,_s,n)=>n(),
            AccessError,exposedSafeSource
        },
        './lib/s03-backends.js':{BackendPool:class {}},
        './lib/s02-identity.js':{safeLegacyPhysicalName},
        './lib/s04-routes.js':{registerS04Routes:()=>{}},
        './lib/s05-routes.js':{registerS05Routes:()=>{}},
        './lib/s05-contract.js':{validateVector:()=>{}},
        './lib/s10-build.js':{loadS10Build:async()=>({pluginVersion:'3.2.10-s10.0',contractVersion:2,fingerprint:'test',verification:'MATCHED_LOCAL_SOURCE_MANIFEST'})},
        './lib/s10-contracts.js':{registerS10Routes:()=>{}},
        './lib/h01-qdrant-acceptance.js':{registerH01AcceptanceRoutes:()=>{}},
            './lib/f01-host-sources.js':{registerF01HostRoutes:()=>{}},
            './lib/f02-public-reads.js':{registerF02Routes:()=>()=>{}},
            './lib/f03-provision.js':{registerF03ProvisionRoutes:()=>{}},
        './lib/s10-gui-connections.js':{registerGuiConnectionRoutes:()=>{}}
    });
    const routes=new Map(); const middleware=[];
    const router={
        use:(fn)=>middleware.push(fn),
        get:(route,fn)=>routes.set(`GET ${route}`,fn),
        post:(route,fn)=>routes.set(`POST ${route}`,fn),
        patch:(route,fn)=>routes.set(`PATCH ${route}`,fn),
    };
    await namespace.init(router);
    assert.ok(middleware.length>=2);
    for(const key of ['POST /chunks/insert','POST /chunks/delete','POST /chunks/purge','POST /purge-all','PATCH /chunks/:hash/text','PATCH /chunks/:hash/metadata']){
        const fn=routes.get(key);assert.equal(typeof fn,'function',key);
        const res=fakeResponse();
        await fn({method:key.split(' ')[0],body:{backend:'vectra'},params:{hash:'1'}},res);
        assert.equal(res.code,409,key);
        assert.equal(res.data.code,'S01_MUTATION_BLOCKED');
    }
});

test('LanceDB direct destructive legacy methods refuse before database access', async () => {
    const lance=(await mockModule('lancedb-backend.js', {
        'node:path': {default: path},
        'node:fs/promises': {default: fs},
        '@lancedb/lancedb': {connect: async()=>{throw new Error('network should not be touched');}},
        './lib/s01-safety.js': {denyUnsafeBackendMutation: (_backend,operation)=>{throw new SafetyError('S01_MUTATION_BLOCKED',operation);}},
        './lib/s02-identity.js': {safeLegacyPhysicalName},
        './lib/s03-security.js': {exposedSafeSource,AccessError},
    })).default;
    for(const [method,args] of [
        ['deleteVectors',['chat',[1]]],
        ['purgeCollection',['chat']],
        ['purgeAll',[]],
        ['updateItem',['chat',1,{text:'changed'}]],
        ['updateItemMetadata',['chat',1,{tag:'x'}]],
    ]) await denial(()=>lance[method](...args));
});

test('LanceDB rejects entire malformed insert batch without opening database', async () => {
    let touched=0;
    const lance=(await mockModule('lancedb-backend.js', {
        'node:path': {default: path},
        'node:fs/promises': {default: fs},
        '@lancedb/lancedb': {connect: async()=>{touched++;return {}; }},
        './lib/s01-safety.js': {denyUnsafeBackendMutation: (_backend,operation)=>{throw new SafetyError('S01_MUTATION_BLOCKED',operation);}},
        './lib/s02-identity.js': {safeLegacyPhysicalName},
        './lib/s03-security.js': {exposedSafeSource,AccessError},
    })).default;
    lance.basePath='/throwaway';
    await assert.rejects(lance.insertVectors('chat',[{hash:1,vector:[1,2]}, {hash:2,vector:[NaN,2]}]),/Invalid vector/);
    assert.equal(touched,0);
});

test('Qdrant absent collection does not trigger automatic creation', async () => {
    resetQdrant(); const old=qdrant._request; const calls=[];
    qdrant._request=async(method,url)=>{calls.push(method);return {result:{collections:[]}};};
    try {
        await assert.rejects(qdrant.ensureCollection('vecthare_main',768),e=>e.code==='S01_COLLECTION_CREATION_BLOCKED');
        assert.deepEqual(calls,['GET']);
    } finally {qdrant._request=old;}
});

test('Milvus absent collection does not create a legacy shared collection', async () => {
    const calls=[];
    milvus.isConnected=true;
    milvus.client={listCollections:async()=>({data:[]}),createCollection:async()=>calls.push('create')};
    await assert.rejects(milvus.ensureCollection('vecthare_main',768),e=>e.code==='S01_COLLECTION_CREATION_BLOCKED');
    assert.deepEqual(calls,[]);
});

test('S02 LanceDB refuses ambiguous legacy collection before opening any database', async () => {
    let touched=0;
    const lance=(await mockModule('lancedb-backend.js', {
        'node:path': {default: path},
        'node:fs/promises': {default: fs},
        '@lancedb/lancedb': {connect: async()=>{touched++;return {}; }},
        './lib/s01-safety.js': {denyUnsafeBackendMutation: (_backend,operation)=>{throw new SafetyError('S01_MUTATION_BLOCKED',operation);}},
        './lib/s02-identity.js': {safeLegacyPhysicalName},
        './lib/s03-security.js': {exposedSafeSource,AccessError},
    })).default;
    lance.basePath='/throwaway';
    await assert.rejects(lance.listItems('chat:a/b'),e=>e.code==='S02_AMBIGUOUS_LEGACY_NAME');
    await assert.rejects(lance.getItem('chat:a:b',1),e=>e.code==='S02_AMBIGUOUS_LEGACY_NAME');
    assert.equal(touched,0);
});

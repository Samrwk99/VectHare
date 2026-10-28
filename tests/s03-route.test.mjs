import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { s01MutationGuard } from '../lib/s01-safety.js';
import { authenticatedContext, forbidOwnerSpoof, validateClientConfig,lookupAuthorizedReservation,
    legacyReadBoundary,s03SensitiveRouteBoundary,AccessError,exposedSafeSource } from '../lib/s03-security.js';
import { safeLegacyPhysicalName } from '../lib/s02-identity.js';
import { registerS04Routes } from '../lib/s04-routes.js';
import {registerS05Routes} from '../lib/s05-routes.js';
import {validateVector as validateS05Vector} from '../lib/s05-contract.js';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const noop={log(){},warn(){},error(){},debug(){}};
function resp(){return {statusCode:200,payload:null,status(n){this.statusCode=n;return this;},json(x){this.payload=x;return this;}};}
async function registered(pool) {
    const source=await fs.readFile(path.join(root,'index.js'),'utf8');
    const context=vm.createContext({ console:noop,setTimeout,clearTimeout,AbortController,fetch:globalThis.fetch,URL });
    const module=new vm.SourceTextModule(source,{context,identifier:'index.js'});
    await module.link(async(specifier)=>{
        const objects={
            'node:path':{default:path},'node:fs/promises':{default:fs},
            'sanitize-filename':{default:s=>s},'vectra':{default:{LocalIndex:class {}}},
            './lib/s01-safety.js':{s01MutationGuard},
            './lib/s03-security.js':{authenticatedContext,forbidOwnerSpoof,validateClientConfig,lookupAuthorizedReservation,
                legacyReadBoundary,s03SensitiveRouteBoundary,AccessError,exposedSafeSource},
            './lib/s03-backends.js':{BackendPool:class {constructor(){return pool;}}},
            './lib/s02-identity.js':{safeLegacyPhysicalName},
            './lib/s04-routes.js':{registerS04Routes},
            './lib/s05-routes.js':{registerS05Routes},
            './lib/s05-contract.js':{validateVector:validateS05Vector}
        };
        assert.ok(objects[specifier],`unexpected import: ${specifier}`);
        const obj=objects[specifier];
        return new vm.SyntheticModule(Object.keys(obj),function(){
            for(const [k,v]of Object.entries(obj))this.setExport(k,v);
        },{context});
    });
    await module.evaluate();
    const routes=new Map(),middleware=[];
    const router={use:f=>middleware.push(f),get:(p,f)=>routes.set(`GET ${p}`,f),
        post:(p,f)=>routes.set(`POST ${p}`,f),patch:(p,f)=>routes.set(`PATCH ${p}`,f)};
    await module.namespace.init(router);
    return async(method,endpoint,request={})=>{
        const req={method,path:endpoint,url:endpoint,body:{},query:{},params:{backend:'qdrant'},...request};
        const res=resp();
        for(const f of middleware){
            let next=false;
            await f(req,res,()=>{next=true});
            if(!next)return res;
        }
        const handler=routes.get(`${method} ${endpoint}`);
        assert.ok(handler,`no route ${method} ${endpoint}`);
        await handler(req,res);
        return res;
    };
}

async function disposable(fn){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'s03-route-'));try {await fn(dir);}finally{await fs.rm(dir,{recursive:true,force:true});}}

test('S03 actual init middleware denies unauthenticated identity even for an allowed read endpoint',async()=>{
    const call=await registered({async get(){throw Error('must not connect');}});
    const x=await call('GET','/collections');
    assert.equal(x.statusCode,401);assert.equal(x.payload.code,'S03_HOST_IDENTITY_UNVERIFIED');
});

test('S03 actual init rejects browser supplied config before any backend connection',async()=>disposable(async dir=>{
    let connections=0;
    const call=await registered({async get(){connections++;return {baseUrl:'http://127.0.0.1',healthCheck:async()=>true};}});
    const user={profile:{handle:'alice'},directories:{vectors:dir}};
    const x=await call('POST','/backend/init/:backend',{path:'/backend/init/qdrant',user,params:{backend:'qdrant'},
        body:{url:'https://attacker.test',apiKey:'secret'}});
    assert.equal(x.statusCode,403);assert.equal(x.payload.code,'S03_CLIENT_CONFIG_FORBIDDEN');assert.equal(connections,0);
    const ok=await call('POST','/backend/init/:backend',{path:'/backend/init/qdrant',user,params:{backend:'qdrant'},body:{configId:'default'}});
    assert.equal(ok.statusCode,200);assert.equal(ok.payload.mutationsEnabled,false);
    assert.equal(connections,1);
}));

test('S03 actual init blocks Qdrant legacy query before connection, but permits local source listing',async()=>disposable(async dir=>{
    let connections=0;
    const call=await registered({async get(){connections++;throw Error('no');}});
    const user={profile:{handle:'alice'},directories:{vectors:dir}};
    const deny=await call('POST','/chunks/query',{user,body:{backend:'qdrant',collectionId:'chat-a',queryVector:[1]}});
    assert.equal(deny.statusCode,409);assert.equal(deny.payload.code,'S03_SHARED_LEGACY_READ_UNVERIFIED');assert.equal(connections,0);
    const sources=await call('GET','/sources',{user});
    assert.equal(sources.statusCode,200);assert.deepEqual(JSON.parse(JSON.stringify(sources.payload.sources)),[]);
}));

test('S03 actual init keeps S01 route blocks even with authenticated user and v2 routes',async()=>disposable(async dir=>{
    const call=await registered({async get(){throw Error('must not connect');}});
    const user={profile:{handle:'alice'},directories:{vectors:dir}};
    const write=await call('POST','/chunks/insert',{user,body:{backend:'qdrant'}});
    assert.equal(write.statusCode,409);assert.equal(write.payload.code,'S01_MUTATION_BLOCKED');
    const health=await call('GET','/health');
    assert.equal(health.statusCode,200);assert.equal(health.payload.checkpoint,'S04');
    const owner=await call('POST','/v2/identity/resolve',{user,body:{backend:'qdrant',
        scope:{userScopeId:'bob',collectionId:'chat-a',type:'chat',sourceId:'chat-a'},
        embedding:{source:'transformers',model:'x',dimension:384,metric:'cosine'}}});
    assert.equal(owner.statusCode,403);assert.equal(owner.payload.code,'S03_OWNER_CONFLICT');
}));
test('S04 real index routes validate with authenticated context but always refuse public submit',async()=>disposable(async dir=>{
    let connections=0;
    const call=await registered({async get(){connections++;throw Error('must not connect');}});
    const user={profile:{handle:'alice'},directories:{vectors:dir}};
    const payload={backend:'qdrant',scope:{collectionId:'chat-a',type:'chat',sourceId:'chat-a'},
        embedding:{source:'transformers',model:'base',dimension:2,metric:'cosine'},
        action:'insert',text:'private sample',vector:[1,0]};
    const ready=await call('POST','/v2/operations/preflight',{user,body:payload});
    assert.equal(ready.statusCode,200);assert.equal(ready.payload.executionAllowed,false);
    assert.equal(ready.payload.authorized,false);
    assert.ok(!JSON.stringify(ready.payload).includes('private sample'));
    const denied=await call('POST','/v2/operations/submit',{user,body:{...payload,authorized:true}});
    assert.equal(denied.statusCode,409);assert.equal(denied.payload.code,'S04_MUTATION_NOT_ACTIVATED');
    assert.equal(connections,0);
}));

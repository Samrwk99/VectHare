/** E06 offline shared-backend acceptance; no live server and NO destructive probe. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {sharedTenantFromCollection,assertSharedReadOwnership,markSharedDisplayPage,
    denyUnverifiedSharedInventory,labelSharedQuery,SharedReadUnverified} from '../utils/e06-shared-read-contract.js';
import {guardedVectorFetch,VectorOperationDenied} from '../utils/e02-vector-request-gateway.js';
const owner={type:'chat',sourceId:'abc'};
for(const backend of ['qdrant','milvus']) {
    for(const name of ['vh:chat:abc',`vecthare_chat_abc`,`${backend}:transformers:vh:chat:abc`]) {
        test(`E06 ${backend} canonical tenant identity ${name}`,()=>assert.deepEqual(sharedTenantFromCollection(name,backend),owner));
    }
    for(const name of ['', 'abc','vh:chat:','vh:unknown:abc','vh:chat:unknown','vecthare_chat_','vh:chat:bad\nsource']) {
        test(`E06 ${backend} refuses ambiguous tenant ${JSON.stringify(name)}`,()=>assert.throws(()=>sharedTenantFromCollection(name,backend),/unverified|Invalid/));
    }
    test(`E06 ${backend} rejects a foreign qualified key`,()=>{
        const other=backend==='qdrant'?'milvus':'qdrant';
        assert.throws(()=>sharedTenantFromCollection(`${other}:transformers:vh:chat:abc`,backend),/route mismatch/);
    });
    test(`E06 ${backend} validates metadata owner exactly`,()=>{
        const r=[{hash:2,metadata:{...owner}},{hash:3,metadata:{...owner,unused:'ok'}}];
        assert.equal(assertSharedReadOwnership(r,owner,backend),r);
        for(const bad of [[{hash:2,metadata:{type:'chat'}}],[{hash:2,metadata:{type:'doc',sourceId:'abc'}}],[{hash:2,metadata:{type:'chat',sourceId:'different'}}]])
            assert.throws(()=>assertSharedReadOwnership(bad,owner,backend),e=>e.code==='VECTHARE_E06_UNVERIFIED_READ');
    });
    test(`E06 ${backend} display list is never authoritative`,()=>{
        const page={success:true,items:[{hash:9,metadata:{...owner}}],total:1,offset:0,hasMore:false};
        const result=markSharedDisplayPage(page,owner,backend);
        assert.equal(result.verifiedInventory,false);assert.equal(result.complete,false);
        assert.equal(page.complete,undefined,'original response unchanged');
        assert.throws(()=>markSharedDisplayPage({success:true,items:[{hash:2,metadata:{type:'other',sourceId:'abc'}}]},owner,backend),SharedReadUnverified);
        assert.throws(()=>markSharedDisplayPage({success:false,items:[]},owner,backend),SharedReadUnverified);
    });
    test(`E06 ${backend} refuses full inventory even if empty`,()=>{
        assert.throws(()=>denyUnverifiedSharedInventory(backend),/authoritative-inventory-contract-unavailable/);
        assert.equal(labelSharedQuery([],backend).readVerification,'UNVERIFIED_EMPTY');
        assert.equal(labelSharedQuery([{}],backend).inventoryComplete,false);
    });
    for(const operation of ['insert','delete','purge','purgeAll','patchText','patchMetadata']) {
        test(`E06 ${backend} ${operation} zero network calls`,async()=>{
            let hits=0;
            const path={insert:'/chunks/insert',delete:'/chunks/delete',purge:'/chunks/purge',purgeAll:'/purge-all',patchText:'/chunks/2/text',patchMetadata:'/chunks/2/metadata'}[operation];
            assert.throws(()=>guardedVectorFetch('/api/plugins/similharity'+path,{
                method:operation.startsWith('patch')?'PATCH':'POST',body:JSON.stringify({backend,collectionId:'vecthare_main',filters:owner})
            },async()=>{hits++;}),VectorOperationDenied);
            assert.equal(hits,0);
        });
    }
}
test('E06 Milvus shared get remains blocked even with a filter',async()=>{
    const query=new URLSearchParams({backend:'milvus',collectionId:'vecthare_main',filters:JSON.stringify(owner)});
    let calls=0;
    assert.throws(()=>guardedVectorFetch(`/api/plugins/similharity/chunks/7?${query}`,{},()=>{calls++;}),/milvus-point-owner-unverifiable/);
    assert.equal(calls,0);
});
test('E06 read-only guarded query still sends explicitly tenant-scoped request',async()=>{
    let seen;
    const result=await guardedVectorFetch('/api/plugins/similharity/chunks/query',{method:'POST',body:JSON.stringify({backend:'qdrant',collectionId:'vh:chat:abc',filters:owner,searchText:'x'})},async(_url,opts)=>{seen=JSON.parse(opts.body);return {ok:true};});
    assert.deepEqual(seen.filters,owner);assert.equal(result.ok,true);
});

import {validateE06ReadProbeEnvironment,runE06ReadProbe} from '../tools/e06-read-probe.mjs';
for(const origin of ['http://192.168.1.5:8000/','https://localhost:8000/','http://user:pass@localhost:8000/','http://localhost:8000/path']) {
    test(`E06 read probe refuses ${origin}`,()=>assert.throws(()=>validateE06ReadProbeEnvironment({backend:'qdrant',collectionId:'vh:chat:abc',origin,env:{VECTHARE_PROBE_DISPOSABLE:'1'}})));
}
test('E06 read probe requires disposable environment',()=>assert.throws(()=>validateE06ReadProbeEnvironment({backend:'qdrant',collectionId:'vh:chat:abc',origin:'http://localhost:8000/',env:{}})));
test('E06 read probe issues only GET health and POST list, never writes',async()=>{
    const calls=[];
    const report=await runE06ReadProbe({backend:'qdrant',collectionId:'vh:chat:abc',origin:'http://localhost:8000/',env:{VECTHARE_PROBE_DISPOSABLE:'1'},fetchImpl:async(url,opts={})=>{
        calls.push({url,opts});
        const data=url.endsWith('/health')?{status:'ok',plugin:'similharity',version:'3.2.0'}:
          {success:true,items:[{hash:4,metadata:{...owner}}],total:1,offset:0,limit:25,hasMore:false};
        return {ok:true,json:async()=>data};
    }});
    assert.equal(report.status,'UNVERIFIED_READ_ONLY');
    assert.equal(report.readCertified,false);
    assert.equal(report.authoritativeInventory,false);
    assert.equal(report.writesAttempted,0);
    assert.equal(calls.length,2);
    assert.deepEqual(calls.map(c=>c.opts.method||'GET'),['GET','POST']);
    assert.ok(calls.every(c=>!c.url.includes('delete')&&!c.url.includes('insert')&&!c.url.includes('purge')));
});
test('E06 read probe refuses a record with missing owner and never certifies',async()=>{
    const report=await runE06ReadProbe({backend:'milvus',collectionId:'vh:chat:abc',origin:'http://127.0.0.1:8000/',env:{VECTHARE_PROBE_DISPOSABLE:'1'},fetchImpl:async(url)=>({ok:true,json:async()=>url.endsWith('/health')?{status:'ok'}:{success:true,items:[{hash:2,metadata:{text:'unowned'}}]}})});
    assert.equal(report.status,'ERROR_OR_UNVERIFIED');assert.equal(report.writesAttempted,0);
});

// Exercise the real adapters with a transport stub, not only the E06 helper.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {adapterCollectionId,requireTenantScope,rejectUnscopedPointOperation} from '../utils/tenant-route.js';
import {requireListedItems,requireQueryItems,hybridEndpointUnsupported} from '../utils/backend-response-validation.js';
import {trustedQueryMetadata,mergeDefinedChunkMetadata} from '../utils/chunk-record-metadata.js';
const adapterRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
function fakeSharedAdapter(backend, payloads=[]) {
    const src=fs.readFileSync(path.join(adapterRoot,'backends',backend+'.js'),'utf8').replace(/^import .*?;\s*$/gm,'').replace('export class ','class ');
    const calls=[];
    const context=vm.createContext({console:{log(){},warn(){},error(){}},VectorBackend:class{},
        getRequestHeaders:()=>({}),getModelField:()=>null,getProviderSpecificParams:()=>({}),
        VECTOR_LIST_LIMIT:100,adapterCollectionId,requireTenantScope:()=>{},rejectUnscopedPointOperation,
        requireListedItems,requireQueryItems,hybridEndpointUnsupported,trustedQueryMetadata,mergeDefinedChunkMetadata,
        sharedTenantFromCollection,assertSharedReadOwnership,markSharedDisplayPage,denyUnverifiedSharedInventory,labelSharedQuery,
        hasVerifiedCapability:()=>false,
        fetch:async(url,opts)=>{calls.push({url,opts}); const reply=payloads.shift();
            assert.ok(reply,`No stub reply supplied for ${url}`);
            return {ok:true,status:200,json:async()=>reply};},
    });
    const type=backend==='qdrant'?'QdrantBackend':'MilvusBackend';
    return {backend:new (vm.runInContext(src+'\n'+type,context))(),calls};
}
test('E06 actual Milvus adapter refuses unowned query record',async()=>{
    const a=fakeSharedAdapter('milvus',[{success:true,results:[{hash:11,text:'unowned',score:0.9,metadata:{}}]}]);
    await assert.rejects(a.backend.queryCollection('vh:chat:abc','test',2,{source:'transformers'}),/missing-or-conflicting-record-owner/);
    assert.equal(a.calls.length,1);
    assert.deepEqual(JSON.parse(a.calls[0].opts.body).filters,owner);
});
test('E06 actual Milvus adapter permits result with matching explicit owner, without certifying inventory',async()=>{
    const a=fakeSharedAdapter('milvus',[{success:true,results:[{hash:11,text:'owned',score:0.9,metadata:{...owner}}]}]);
    const out=await a.backend.queryCollection('vh:chat:abc','test',2,{source:'transformers'});
    assert.deepEqual(Array.from(out.hashes),[11]);
    assert.equal(out.readVerification,'OWNER_FIELDS_CHECKED');
    assert.equal(out.inventoryComplete,false);
});
test('E06 actual Milvus adapter rejects missing owner in hybrid query',async()=>{
    const a=fakeSharedAdapter('milvus',[{success:true,results:[{hash:11,text:'unowned',score:0.9,metadata:{}}]}]);
    await assert.rejects(a.backend.hybridQuery('vh:chat:abc','test',2,{source:'transformers'}),/missing-or-conflicting-record-owner/);
});
test('E06 actual Qdrant adapter marks scoped list as not a verified inventory',async()=>{
    const a=fakeSharedAdapter('qdrant',[{success:true,items:[{hash:11,text:'owned',metadata:{...owner}}],total:1,offset:0,limit:25,hasMore:false}]);
    const page=await a.backend.listChunks('vh:chat:abc',{source:'transformers'},{limit:25});
    assert.equal(page.complete,false);assert.equal(page.verifiedInventory,false);
    assert.deepEqual(JSON.parse(a.calls[0].opts.body).filters,owner);
});
test('E06 real Milvus adapter refuses ambiguous tenant before network',async()=>{
    const a=fakeSharedAdapter('milvus');
    await assert.rejects(a.backend.queryCollection('bare-id','test',2,{source:'transformers'}),/ambiguous-tenant-identity/);
    assert.equal(a.calls.length,0);
});

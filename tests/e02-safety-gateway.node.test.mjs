/** E02 contract tests against the actual runtime transport gate.
 * No SillyTavern/plugin/backend contacted and NO dangerous probes executed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardedVectorFetch, inspectVectorRequest, VectorOperationDenied, e02Matrix } from '../utils/e02-vector-request-gateway.js';
import { E02_STATIC_COVERAGE } from '../tools/e02-verify.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const countFetch=()=>{
  const calls=[];
  return {calls,fetch:async (url,opts)=>{calls.push({url,opts});return {ok:true,status:200,json:async()=>({success:true})};}};
};
const send=(backend,route,payload={})=>['/api/plugins/similharity'+route,{method:'POST',body:JSON.stringify({backend,collectionId:'vh:chat:test',...payload})}];
const tenant={type:'chat',sourceId:'test'};
const mutationRoutes={
  insert:'/chunks/insert',delete:'/chunks/delete',purge:'/chunks/purge',purgeAll:'/purge-all',
  patchText:'/chunks/9/text',patchMetadata:'/chunks/9/metadata'
};
for(const backend of ['standard','lancedb','qdrant','milvus']){
  for(const [operation,route] of Object.entries(mutationRoutes)){
    test(`E02 ${backend} ${operation} makes ZERO network calls`,async()=>{
      const n=countFetch();
      const [url,options]=send(backend,route,{filters:tenant,hashes:[9],items:[{hash:9,text:'test',vector:[1,2]}]});
      if(operation.startsWith('patch')) options.method='PATCH';
      await assert.rejects(async()=>guardedVectorFetch(url,options,n.fetch),error=>error instanceof VectorOperationDenied && error.code==='VECTHARE_E02_OPERATION_DENIED');
      assert.equal(n.calls.length,0);
      assert.ok(['DENIED','UNPROBED'].includes(e02Matrix[backend][operation]));
    });
  }
}
for(const route of ['insert','delete','purge']){
  test(`E02 native Standard ${route} denied before network`,async()=>{
    const n=countFetch();
    await assert.rejects(async()=>guardedVectorFetch('/api/vector/'+route,{method:'POST',body:'{}'},n.fetch),/native-mutation-contract-unprobed/);
    assert.equal(n.calls.length,0);
  });
}
for(const backend of ['qdrant','milvus']){
  for(const op of ['list','query','hybrid-query','stats']){
    test(`E02 ${backend} ${op} requires real filters.type/sourceId`,async()=>{
      const n=countFetch();
      const route='/chunks/'+op;
      const input={backend,collectionId:'vh:chat:test',filter:{must:[{key:'content_type',match:{value:'test'}}]}};
      await assert.rejects(async()=>guardedVectorFetch(route.startsWith('/api/')?route:'/api/plugins/similharity'+route,{method:'POST',body:JSON.stringify(input)},n.fetch),/tenant-filters-required/);
      await assert.rejects(async()=>guardedVectorFetch('/api/plugins/similharity'+route,{method:'POST',body:JSON.stringify({...input,filters:{type:'chat',sourceId:'unknown'}})},n.fetch),/tenant-filters-required/);
      assert.equal(n.calls.length,0);
      const ok=await guardedVectorFetch('/api/plugins/similharity'+route,{method:'POST',body:JSON.stringify({...input,filters:tenant})},n.fetch);
      assert.equal(ok.ok,true);
      assert.equal(n.calls.length,1);
    });
  }
}
test('E02 rejects Milvus get even with requested tenant filters, because plugin omits ownership proof',async()=>{
  const n=countFetch();
  const params=new URLSearchParams({backend:'milvus',collectionId:'vecthare_main',filters:JSON.stringify(tenant)});
  await assert.rejects(async()=>guardedVectorFetch('/api/plugins/similharity/chunks/9?'+params,{},n.fetch),/milvus-point-owner-unverifiable/);
  assert.equal(n.calls.length,0);
});
test('E02 Qdrant get requires filters in query and accepts valid scoped request',async()=>{
  const n=countFetch();
  const base='/api/plugins/similharity/chunks/9?backend=qdrant&collectionId=vh%3Achat%3Atest';
  await assert.rejects(async()=>guardedVectorFetch(base,{},n.fetch),/tenant-filters-required/);
  assert.equal(n.calls.length,0);
  const response=await guardedVectorFetch(base+'&filters='+encodeURIComponent(JSON.stringify(tenant)),{},n.fetch);
  assert.equal(response.ok,true);
  assert.equal(n.calls.length,1);
});
test('E02 rejects unrecognised plugin routes without contacting server',async()=>{
  const n=countFetch();
  await assert.rejects(async()=>guardedVectorFetch('/api/plugins/similharity/backend/qdrant/collection-info',{method:'GET'},n.fetch),/unsupported-route-or-backend/);
  await assert.rejects(async()=>guardedVectorFetch('/api/plugins/similharity/chunks/unsupported/operation',{method:'DELETE'},n.fetch),/unsupported-route-or-backend/);
  assert.equal(n.calls.length,0);
});
test('E02 rejects non-empty credentials in browser backend initialization',async()=>{
  const n=countFetch();
  for(const data of [{apiKey:'private'},{token:'private'},{password:'private'},{authorization:'Bearer private'}]){
    await assert.rejects(async()=>guardedVectorFetch('/api/plugins/similharity/backend/init/qdrant',{method:'POST',body:JSON.stringify(data)},n.fetch),/browser-credential-forwarding/);
  }
  assert.equal(n.calls.length,0);
  const ok=await guardedVectorFetch('/api/plugins/similharity/backend/init/qdrant',{method:'POST',body:JSON.stringify({host:'localhost',port:6333})},n.fetch);
  assert.equal(ok.ok,true);
  assert.equal(n.calls.length,1);
});
test('E02 does not rewrite third-party network calls or intercept unrelated routes',async()=>{
  const n=countFetch();
  await guardedVectorFetch('/api/extra/classify',{method:'POST',body:'{}'},n.fetch);
  assert.equal(n.calls.length,1);
  assert.equal(inspectVectorRequest('/api/extra/classify',{method:'POST'}).intercepted,false);
});
test('E02 runtime statuses correspond exactly to preserved E01 source matrix',()=>{
  const evidence=JSON.parse(fs.readFileSync(path.join(root,'docs/e01/capability-matrix.json'),'utf8'));
  for(const [backend,operations] of Object.entries(e02Matrix)){
    assert.equal(Object.keys(operations).length,20);
    for(const [op,status] of Object.entries(operations)) assert.equal(status,evidence.backends[backend][op].status);
  }
  assert.equal(evidence.enforcement,'not connected to runtime','Original E01 document remains historical, not retconned');
});
test('E02 static audit covers every recorded E01 route edge and 12 aliased modules',()=>{
  assert.equal(E02_STATIC_COVERAGE.pass,true);
  assert.equal(E02_STATIC_COVERAGE.e01Sites,98);
  assert.ok(E02_STATIC_COVERAGE.aliasedModules>=12);
});
test('E02 Qdrant adapter uses the actual plugin tenant contract and checks returned ownership',()=>{
  const source=fs.readFileSync(path.join(root,'backends/qdrant.js'),'utf8');
  assert.equal((source.match(/body\.filter\s*=/g)||[]).length,0);
  assert.ok((source.match(/body\.filters\s*=\s*tenantFiltersFor/g)||[]).length>=5);
  assert.match(source,/verifyTenantResults\(requireQueryItems/);
  assert.match(source,/verifyTenantResults\(requireListedItems/);
});

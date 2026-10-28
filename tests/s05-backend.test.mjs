import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {qdrantV2Reads,milvusV2Reads} from '../lib/s05-backend-reads.js';
import {binding,recordFor} from './s05-contract.test.mjs';
import {collectionIdentity} from '../lib/s02-identity.js';
const mBinding={...binding,backend:'milvus',collection:((c)=>({key:c.key,physicalName:c.physicalName}))(collectionIdentity({backend:'milvus',scope:binding.scope,embedding:binding.embedding}))};
const wrongOwner={...recordFor(),sourceId:'other-source'};
test('S05 Qdrant query always sends full owner filter incl branch; verifies returned payload',async()=>{
 let request;
 const p=recordFor();const backend={_request:async(method,path,body)=>{request={method,path,body};return{result:[{id:p.physicalId,payload:p,score:0.9}]};}};
 const out=await qdrantV2Reads(backend,binding).query({vector:[1,2,3],topK:5});
 assert.equal(out.length,1);assert.equal(out[0].recordId,p.recordId);
 assert.equal(request.body.filter.must.length,5);
 assert.equal(request.body.filter.must.find(x=>x.key==='branchId').match.value,'branch-1');
 assert.ok(request.path.includes(mBinding.collection.physicalName)===false);
 await assert.rejects(()=>qdrantV2Reads({_request:async()=>({result:[{id:p.physicalId,payload:wrongOwner,score:0.9}]})},binding).query({vector:[1,2,3]}),{code:'S05_PHYSICAL_ID_MISMATCH'});
});
test('S05 Qdrant get returns null only for real empty response and refuses backend malformed',async()=>{
 const r=recordFor(),reader=qdrantV2Reads({_request:async()=>({result:{points:[{id:r.physicalId,payload:r,vector:r.vector}]}})},binding);
 assert.equal((await reader.getRecord(r.recordId)).recordId,r.recordId);
 assert.equal(await qdrantV2Reads({_request:async()=>({result:{points:[]}})},binding).getRecord(r.recordId),null);
 await assert.rejects(()=>qdrantV2Reads({_request:async()=>({result:{}})},binding).getRecord(r.recordId),{code:'S05_BACKEND_RESPONSE_INVALID'});
});
test('S05 Qdrant scoped cursor paging never returns authoritative inventory',async()=>{
 const r=recordFor();let requests=[];
 const backend={_request:async(m,p,b)=>{requests.push(b);return{result:{points:[{id:r.physicalId,payload:r}],next_page_offset:12}}}};
 const page=await qdrantV2Reads(backend,binding).listPage({limit:1,cursor:5});
 assert.equal(page.hasMore,true);assert.equal(page.nextCursor,12);assert.equal(page.inventoryVerified,false);
 assert.equal(requests[0].offset,5);assert.equal(requests[0].with_vector,false);
});
test('S05 Qdrant and Milvus deny invalid vectors before any backend call',async()=>{
 let n=0;const q=qdrantV2Reads({_request:async()=>{n++;return {result:[]};}},binding);
 await assert.rejects(()=>q.query({vector:[1,2]}),{code:'S05_VECTOR_INVALID'});
 const milvus=milvusV2Reads({client:{search:async()=>{n++;return {results:[]}},query:async()=>({data:[]})}},mBinding);
 await assert.rejects(()=>milvus.query({vector:[1,Infinity,3]}),{code:'S05_VECTOR_INVALID'});
 assert.equal(n,0);
});
test('S05 Milvus query includes complete owner columns and enforced scope',async()=>{
 const r=recordFor();let call;const client={query:async()=>({data:[]}),search:async(x)=>{call=x;return{results:[{...r,score:0.7}]}}};
 const results=await milvusV2Reads({client},mBinding).query({vector:[0.1,0.2,0.3]});
 assert.equal(results.length,1);assert.match(call.filter,/sourceId == "chat-17"/);
 assert.match(call.filter,/branchId == "branch-1"/);
 assert.ok(call.output_fields.includes('userScopeId'));assert.ok(call.output_fields.includes('collectionId'));
 assert.ok(call.output_fields.includes('revision'));
 await assert.rejects(()=>milvusV2Reads({client:{query:client.query,search:async()=>({results:[{...wrongOwner,score:0.5}]})}},mBinding).query({vector:[0.1,0.2,0.3]}),{code:'S05_OWNER_MISMATCH'});
});
test('S05 Milvus get is scoped by recordId and owner; missing owner refused',async()=>{
 const r=recordFor();let call;
 const client={search:async()=>({results:[]}),query:async(x)=>{call=x;return{data:[r]}}};
 assert.equal((await milvusV2Reads({client},mBinding).getRecord(r.recordId)).recordId,r.recordId);
 assert.match(call.filter,new RegExp(`recordId == "${r.recordId}"`));
 assert.ok(call.output_fields.includes('vector'));
 await assert.rejects(()=>milvusV2Reads({client:{...client,query:async()=>({data:[{...r,userScopeId:undefined}]})}},mBinding).getRecord(r.recordId),{code:'S05_OWNER_MISMATCH'});
});
test('S05 Milvus offset pagination declares consistency unverified and provides next cursor',async()=>{
 const rows=[recordFor(),recordFor()];let x;
 const client={search:async()=>({results:[]}),query:async(v)=>{x=v;return{data:rows}}};
 const page=await milvusV2Reads({client},mBinding).listPage({limit:1,cursor:10});
 assert.equal(page.items.length,1);assert.equal(page.nextCursor,11);assert.equal(page.hasMore,true);
 assert.equal(page.inventoryVerified,false);assert.equal(x.limit,2);assert.equal(x.offset,10);
 await assert.rejects(()=>milvusV2Reads({client:{search:client.search,query:async()=>({data:[wrongOwner]})}},mBinding).listPage({limit:1}),{code:'S05_OWNER_MISMATCH'});
});
test('S05 backend failures propagate and are not treated as no hits',async()=>{
 await assert.rejects(()=>qdrantV2Reads({_request:async()=>{throw new Error('network off');}},binding).listPage(),/network off/);
 await assert.rejects(()=>milvusV2Reads({client:{search:async()=>({results:[]}),query:async()=>{throw new Error('Milvus unavailable')}}},mBinding).listPage(),/Milvus unavailable/);
});

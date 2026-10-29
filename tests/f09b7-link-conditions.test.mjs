import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {parseF09b7Topology,executeF09b7,registerF09b7Routes} from '../lib/f09b7-link-conditions.js';
const sourceId='f01_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const embedding={source:'transformers',model:'test-model',dimension:3,metric:'dot'};
const source={kind:'lorebook',name:'test'};
const sha=x=>createHash('sha256').update(x).digest('hex');
const makeSource=(book)=>{const bytes=Buffer.from(JSON.stringify(book));return {sourceId,bytes,fileHash:sha(bytes)};};
const book={entries:{one:{uid:12,content:'Active source',key:['sun'],vecthareLinks:[17,99]},two:{uid:17,content:'Disabled source',disable:true},three:{uid:22,content:''}}};
const req={s03:{userScopeId:'alice',vectorsPath:'/tmp/fixture'},user:{directories:{root:'/tmp/fixture'}},
 headers:{'x-vecthare-f09b7-preview':'1'},body:{backend:'qdrant',configId:'local',source,embedding}};
test('F09b.7 parses stable UID links without text, inventing missing targets or evaluating conditions',()=>{
 const a=parseF09b7Topology(makeSource(book).bytes,sourceId);
 assert.equal(a.length,3);assert.equal(a[0].state,'ELIGIBLE_SAVED_ENTRY');assert.equal(a[1].state,'DISABLED_SOURCE');
 assert.equal(a[2].state,'EMPTY_SOURCE');assert.deepEqual(a[0].links,['17','99']);
 assert.equal(a[0].conditions.evaluated,false);
 assert.equal(parseF09b7Topology(makeSource({entries:{b:{uid:12,content:'Changed'}}}).bytes,sourceId)[0].recordId,a[0].recordId);
});
for(const invalid of [
 {entries:{a:{uid:12,content:'x',vecthareLinks:[12]}}},
 {entries:{a:{uid:12,content:'x',vecthareLinks:[17,17]}}},
 {entries:{a:{uid:12,content:'x',vecthareLinks:['17']}}},
 {entries:{a:{uid:12,content:'x'},b:{uid:12,content:'y'}}},
 {entries:{a:{uid:12,content:'x',key:'bad'}}},
 {entries:{a:{uid:12,content:'x',disable:'false'}}}
])test('F09b.7 rejects unsupported or ambiguous saved source topology',()=>{
 assert.throws(()=>parseF09b7Topology(makeSource(invalid).bytes,sourceId),e=>e.code?.startsWith('F09B7_'));
});
test('F09b.7 inspect is read-only, source reattested, and never leaks saved text',async()=>{
 const snap=makeSource(book), ids=parseF09b7Topology(snap.bytes,sourceId).map(x=>x.recordId);
 const reads=[];
 const result=await executeF09b7(req,{readSource:async()=>snap,readScoped:async(_req,b,op)=>{
  reads.push([b.recordId,op]);return b.recordId===ids[0]?{recordId:b.recordId,revision:1,text:'Active source'}:null;
 }});
 assert.equal(result.status,'READ_ONLY_LINK_CONDITION_LIFECYCLE_PREVIEW');
 assert.deepEqual(result.counts,{eligible:1,disabled:1,empty:1,unresolvedLinks:2});
 assert.deepEqual(result.entries.map(x=>x.lifecycle),['IN_SYNC','DISABLED_SOURCE','EMPTY_SOURCE']);
 assert.deepEqual(result.entries[0].links.map(x=>x.state),['TARGET_DISABLED_OR_EMPTY','UNRESOLVED_TARGET']);
 assert.deepEqual(reads.map(x=>x[0]),ids);assert.equal(result.productionWritesEnabled,false);
 assert.equal(JSON.stringify(result).includes('Active source'),false);
});
test('F09b.7 refuses changed source between scoped reads',async()=>{
 const original=makeSource(book),changed=makeSource({entries:{one:{uid:12,content:'Changed'}}});let n=0;
 await assert.rejects(executeF09b7(req,{readSource:async()=>++n===1?original:changed,readScoped:async()=>null}),e=>e.code==='F09B7_SOURCE_CHANGED');
});
test('F09b.7 blocks untrusted client overrides and cross-origin requests',async()=>{
 for(const bad of [{...req.body,recordId:'forged'},{...req.body,source:{...source,uid:12}},
 {...req.body,embedding:{...embedding,vector:[1,2,3]}}]){
  await assert.rejects(executeF09b7({...req,body:bad}),e=>e.code==='F09B7_INVALID_SCOPE');
 }
 await assert.rejects(executeF09b7({...req,headers:{}}),e=>e.code==='F09B7_SAME_ORIGIN_REQUIRED');
 await assert.rejects(executeF09b7({...req,headers:{...req.headers,origin:'https://evil.test',host:'localhost'}}),e=>e.code==='F09B7_ORIGIN_MISMATCH');
});
test('F09b.7 route redacts refusal and never authorizes mutations',async()=>{
 const handlers={};registerF09b7Routes({post:(path,handler)=>handlers[path]=handler});
 const res={code:200,status(n){this.code=n;return this;},json(o){this.body=o;return this;}};
 await handlers['/v2/workflows/link-condition-preview']({...req,body:{...req.body,vector:[1,2,3]}},res);
 assert.equal(res.code,403);assert.equal(res.body.productionWritesEnabled,false);assert.equal(res.body.retryable,false);
});

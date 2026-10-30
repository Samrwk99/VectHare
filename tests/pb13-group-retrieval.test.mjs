import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {applyPB13ManagedRetrievalGroups} from '../lib/pb13-group-retrieval.js';
import {registerF09ManagedQueryRoute} from '../lib/f09-workflows.js';
const [a,b,c]=Array.from({length:3},()=>randomUUID());
const gid=randomUUID();
const items=[{recordId:a,revision:1,text:'a',score:0.9},{recordId:b,revision:1,text:'b',score:0.8},{recordId:c,revision:1,text:'c',score:0.7}];
const evidence={sourceAuthoritative:true,verifiedPhysicalInventory:true,backend:'qdrant',
 requiresGenerationReview:false,generation:1,revision:2,orphanedMembers:[],groups:[]};
const run=(groups,source=items)=>applyPB13ManagedRetrievalGroups(source,{...evidence,groups},{backend:'qdrant',topK:3});
test('membership edit changes actual candidate output, not just stored metadata',()=>{
 const policy={id:gid,name:'choose one',mode:'exclusive',members:[a,b]};
 assert.deepEqual(run([policy]).map(x=>x.recordId),[a,c]);
 assert.deepEqual(run([{...policy,members:[b,c]}]).map(x=>x.recordId),[a,b]);
 assert.deepEqual(run([]).map(x=>x.recordId),[a,b,c]);
});
test('soft inclusive boosts only verified already-returned UUID members; no hard/mandatory inventions',()=>{
 const policy={id:gid,name:'boost',mode:'inclusive',boost:.2,members:[b,c,randomUUID()]};
 const rows=run([policy]);assert.deepEqual(rows.map(r=>r.recordId),[b,a,c]);
 assert.equal(rows[0].score,1);assert.equal(rows[1].score,.9);
 assert.equal(run([{id:gid,name:'old',members:[a,b]}]).length,3);
});
test('generation change, unavailable proof, foreign backend, forged group mode fail closed',()=>{
 for(const diff of [{requiresGenerationReview:true},{verifiedPhysicalInventory:false},{backend:'milvus'},
 {sourceAuthoritative:false},{generation:-1}]){
  assert.throws(()=>applyPB13ManagedRetrievalGroups(items,{...evidence,...diff},{backend:'qdrant',topK:3}),/UNVERIFIED/);
 }
 assert.throws(()=>run([{id:gid,name:'x',members:[a,b],mode:'mandatory'}]),/POLICY_INVALID/);
});
test('retrieval HTTP route uses plugin-owned readGroups and alters actual prompt candidates',async()=>{
 let handler,seen;const source={kind:'chat',avatar:'Nina.png',chatFile:'branch'};
 const profile={source:'llama_cpp',model:'bge-m3',dimension:3,metric:'cosine'};
 const group={id:gid,name:'policy',mode:'exclusive',members:[a,b]};
 registerF09ManagedQueryRoute({post:(route,fn)=>{handler=fn;}},{backendPool:{},
  selectProfile:async()=>({configured:true,selected:true,profile,scope:{},selectionGeneration:1}),
  embed:async()=>[1,0,0],readScoped:async()=>items,
  readGroups:async(req,deps)=>{seen=req.body;return {...evidence,groups:[group]};}});
 const res={code:200,status(n){this.code=n;return this;},json(x){this.body=x;return this;}};
 await handler({s03:{userScopeId:'u',vectorsPath:'/tmp'},body:{backend:'qdrant',configId:'default',source,queryText:'hi',topK:3}},res);
 assert.equal(res.code,200);assert.deepEqual(res.body.candidates.map(x=>x.recordId),[a,c]);
 assert.deepEqual(seen,{backend:'qdrant',source,configId:'default'});
 assert.equal(res.body.groupRevision,2);
});

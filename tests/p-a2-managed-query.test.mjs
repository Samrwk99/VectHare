import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {validateF09ManagedQuery,registerF09ManagedQueryRoute} from '../lib/f09-workflows.js';

const source={kind:'chat',avatar:'Nina.png',chatFile:'branch'};
const profile={source:'llama_cpp',model:'bge-m3',dimension:3,metric:'cosine'};
const request={backend:'qdrant',configId:'local',source,topK:3,queryText:'who is Nina?'};
const record={recordId:randomUUID(),revision:1,score:0.8,text:'Nina visited the library.'};
const response=()=>({statusCode:200,status(n){this.statusCode=n;return this;},json(data){this.body=data;return this;}});
const selected=()=>({configured:true,selected:false,profile,scope:{userScopeId:'alice'},
 selectionGeneration:0,profileRevision:'revision-a',connectionState:'VERIFIED'});
function fixture(options={}){
 let handler;const captured=[];
 registerF09ManagedQueryRoute({post:(route,fn)=>{assert.equal(route,'/v2/workflows/retrieve-text');handler=fn;}},{
 backendPool:{get:async()=>({})}, selectProfile:options.selectProfile|| (async()=>selected()),
 embed:options.embed|| (async(...args)=>{captured.push(['embed',...args]);return [1,0,0];}),
 readScoped:options.readScoped|| (async(...args)=>{captured.push(['read',...args]);return [record];}),
 readGroups:options.readGroups || (async()=>({sourceAuthoritative:true,verifiedPhysicalInventory:true,
 backend:'qdrant',requiresGenerationReview:false,generation:0,revision:0,groups:[],orphanedMembers:[]}))});
 return {captured,async call(body=request,s03={userScopeId:'alice',vectorsPath:'/home/alice/vectors'}){
  const res=response();await handler({body,s03},res);return res;
 }};
}
test('P-A.2 rejects browser vectors, chosen model, owner, physical collection and extra fields',()=>{
 assert.deepEqual(validateF09ManagedQuery(request),request);
 for(const extra of [{vector:[1,0,0]},{embedding:profile},{model:'hacker'},
  {physicalCollectionName:'shared'},{userScopeId:'bob'},{credential:'secret'},
  {queryText:'x'.repeat(10001)},{topK:31},{configId:'evil'},
  {source:{kind:'file',path:'/root'}}]){
  assert.throws(()=>validateF09ManagedQuery({...request,...extra}));
 }
});
test('P-A.2 embeds only on server, passes pinned identity into F02, returns UUID candidate',async()=>{
 const x=fixture();const res=await x.call();
 assert.equal(res.statusCode,200);assert.equal(res.body.scopeVerified,true);
 assert.equal(res.body.candidates[0].recordId,record.recordId);
 assert.equal(x.captured[0][0],'embed');assert.equal(x.captured[0][3],profile);
 assert.equal(x.captured[1][0],'read');assert.deepEqual(x.captured[1][2].embedding,profile);
 assert.deepEqual(x.captured[1][2].vector,[1,0,0]);
 assert.equal(x.captured[1][3],'query');
 assert.equal(JSON.stringify(res.body).includes('vector'),false);
});
test('P-A.2 does not embed without auth or tested managed profile',async()=>{
 const x=fixture();assert.equal((await x.call(request,null)).statusCode,403);
 assert.equal(x.captured.length,0);
 const absent=fixture({selectProfile:async()=>({configured:false})});
 assert.equal((await absent.call()).body.code,'F09_MANAGED_PROFILE_REQUIRED');
 const unverified=fixture({selectProfile:async()=>({...selected(),connectionState:'NOT_TESTED'})});
 assert.equal((await unverified.call()).body.code,'F09_MANAGED_PROFILE_TEST_REQUIRED');
});
test('P-A.2 suppresses results on model cutover or backend ownership refusal',async()=>{
 let count=0;const x=fixture({selectProfile:async()=>++count===1?selected():
  {...selected(),profile:{...profile,model:'other'},selectionGeneration:1}});
 const r=await x.call();assert.equal(r.body.code,'F09_MANAGED_PROFILE_CHANGED');
 assert.equal(x.captured.filter(c=>c[0]==='read').length,0);
 const denied=fixture({readScoped:async()=>{throw Object.assign(new Error('sensitive owner path'),{code:'F02_SOURCE_NOT_ATTESTED',status:403});}});
 const bad=await denied.call();assert.equal(bad.statusCode,403);
 assert.equal(bad.body.code,'F02_SOURCE_NOT_ATTESTED');assert.equal(JSON.stringify(bad.body).includes('sensitive'),false);
});

test('P04 condition-bearing World Info is not injected before M6 activation evaluation',async()=>{
 const {prepareF09Candidates}=await import('../lib/f09-workflows.js');
 const active={...record,recordId:randomUUID(),score:0.7,metadata:{contentType:'chat'}};
 const gated={...record,recordId:randomUUID(),score:0.99,metadata:{vecthareRecordV2:{lorebook:{conditions:[{type:'sillytavern-saved-fields',values:{constant:false}}]}}}};
 const disabled={...record,recordId:randomUUID(),score:0.98,metadata:{enabled:false}};
 const list=prepareF09Candidates([active,gated,disabled],3);
 assert.deepEqual(list.map(x=>x.recordId),[active.recordId]);
});
test('P04 stable candidate ordering ranks scores then record UUID',async()=>{
 const {prepareF09Candidates}=await import('../lib/f09-workflows.js');
 const a={...record,recordId:randomUUID(),score:0.7};
 const b={...record,recordId:randomUUID(),score:0.95};
 const c={...record,recordId:randomUUID(),score:0.7};
 const chosen=prepareF09Candidates([a,b,c],3);
 assert.equal(chosen[0].recordId,b.recordId);
 assert.deepEqual(chosen.slice(1).map(x=>x.recordId),[a.recordId,c.recordId].sort());
});


test('P-A.4 P04 refuses stale provider verification after embed and after backend read',async()=>{
 let n=0;const duringEmbed=fixture({selectProfile:async()=>{
  n++;return n===1?selected():{...selected(),connectionState:'NOT_TESTED'};
 }});
 const first=await duringEmbed.call();
 assert.equal(first.body.code,'F09_MANAGED_PROFILE_CHANGED');
 assert.equal(duringEmbed.captured.filter(c=>c[0]==='read').length,0);
 let m=0;const duringRead=fixture({selectProfile:async()=>{
  m++;return m<3?selected():{...selected(),connectionState:'NOT_TESTED'};
 }});
 const second=await duringRead.call();
 assert.equal(second.body.code,'F09_MANAGED_PROFILE_CHANGED');
 assert.equal(duringRead.captured.filter(c=>c[0]==='read').length,1);
 assert.equal(second.body.candidates,undefined);
});

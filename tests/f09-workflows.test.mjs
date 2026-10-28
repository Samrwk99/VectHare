import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {validateF09Request,prepareF09Candidates,registerF09WorkflowRoutes} from '../lib/f09-workflows.js';
const source={kind:'chat',avatar:'Nina.png',chatFile:'branch'};
const embedding={source:'transformers',model:'model-1',dimension:3,metric:'cosine'};
const request={backend:'qdrant',source,embedding,configId:'local',vector:[1,0,0],topK:3};
const r=(body,s03={userScopeId:'alice',vectorsPath:'/test-only'})=>({body,s03});
const response=()=>({statusCode:200,status(i){this.statusCode=i;return this},json(v){this.body=v;return this}});
function fixture(readScoped){const routes=new Map();registerF09WorkflowRoutes({post:(path,fn)=>routes.set(path,fn)},
 {backendPool:{get:async()=>({})},readScoped});return async(req)=>{const res=response();await routes.get('/v2/workflows/preview')(req,res);return res;};}
test('F09 accepts exactly one saved-file selector and a scoped numeric search',()=>{
 assert.deepEqual(validateF09Request(request),request);
 for(const body of [{...request,userScopeId:'attacker'},{...request,physicalCollectionName:'legacy'},
  {...request,operation:'insert'},{...request,source:{kind:'file',path:'/etc/passwd'}},
  {...request,topK:500},{...request,vector:'bad'}])assert.throws(()=>validateF09Request(body));
});
test('F09 maps strictly unique v2 record IDs, no numeric-hash fallback',()=>{
 const record={recordId:randomUUID(),text:'some text',score:0.8,revision:1,metadata:{contentType:'summary'}};
 assert.equal(prepareF09Candidates([record],2)[0].contentType,'summary');
 for(const rows of [[record,record],[{...record,recordId:'123'}],[{...record,score:NaN}],
  [{...record,revision:0}],[{...record,text:''}]]) assert.throws(()=>prepareF09Candidates(rows,2));
});
test('F09 route invokes server-attested F02 query only, never accesses writes or legacy hash paths',async()=>{
 let saw;
 const record={recordId:randomUUID(),text:'verified scoped v2 memory',score:0.8,revision:1};
 const invoke=fixture(async(req,body,operation,options)=>{
  saw={req,body,operation,options};return [record];
 });
 const answer=await invoke(r(request));
 assert.equal(answer.statusCode,200);assert.equal(answer.body.candidates[0].recordId,record.recordId);
 assert.equal(answer.body.productionWritesEnabled,false);assert.equal(answer.body.automaticInjectionEnabled,false);
 assert.equal(answer.body.completeInventory,false);assert.equal(answer.body.recordIdentity,'V2_RECORD_UUID');
 assert.equal(saw.operation,'query');assert.equal(saw.body.source.chatFile,'branch');
 assert.equal('userScopeId' in saw.body,false);
});
test('F09 refuses ownership, F02 adapter failure and client-supplied physical scope',async()=>{
 let called=0;const invoke=fixture(async()=>{called++;return [];});
 const denied=await invoke(r(request,null));assert.equal(denied.statusCode,403);assert.equal(called,0);
 const malformed=await invoke(r({...request,collectionId:'victim'}));assert.equal(malformed.statusCode,400);assert.equal(called,0);
 const failing=fixture(async()=>{throw Object.assign(new Error('password=private'),{code:'S05_OWNER_MISMATCH',status:403});});
 const result=await failing(r(request));assert.equal(result.statusCode,403);assert.equal(result.body.code,'S05_OWNER_MISMATCH');
 assert.equal(JSON.stringify(result.body).includes('private'),false);
});

test('F09 actual F02 integration re-attests owned saved chat, reserves v2 binding, filters by source and rejects copied branch scope',async()=>{
 const fs=await import('node:fs/promises');const os=await import('node:os');const path=await import('node:path');
 const {registerF02Routes}=await import('../lib/f02-public-reads.js');
 const {recordIdentity,contentFingerprint}=await import('../lib/s02-identity.js');
 const {createHash}=await import('node:crypto');
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'f09-integration-'));
 try{
  const root=path.join(tmp,'alice');const vectors=path.join(root,'vectors'),chats=path.join(root,'chats');
  const characters=path.join(root,'characters'),worlds=path.join(root,'worlds'),groups=path.join(root,'groups'),groupChats=path.join(root,'groupChats');
  for(const folder of [vectors,path.join(chats,'Nina'),characters,worlds,groups,groupChats])await fs.mkdir(folder,{recursive:true});
  await fs.writeFile(path.join(characters,'Nina.png'),'avatar');
  for(const name of ['one','branch'])await fs.writeFile(path.join(chats,'Nina',`${name}.jsonl`),JSON.stringify({chat_metadata:{integrity:'copied'}})+'\n');
  const user={profile:{handle:'alice'},directories:{root,vectors,chats,characters,worlds,groups,groupChats}};
  const ctx={user,s03:{userScopeId:'alice',vectorsPath:vectors}};
  const handlers=new Map(),router={post:(url,fn)=>handlers.set(url,fn)};
  let captured=[];
  const qdrant={async _request(method,route,payload){captured.push({method,route,payload});
   if(method==='GET')return {result:{config:{params:{vectors:{size:3,distance:'Cosine'}}},status:'green'}};
   if(route.endsWith('/points/search'))return {result:[]};
   throw Error('unexpected operation');
  }};
  const pool={get:async()=>qdrant};
  registerF02Routes(router,{backendPool:pool});registerF09WorkflowRoutes(router,{backendPool:pool});
  async function call(url,body){const out=response();await handlers.get(url)({...ctx,body},out);return out;}
  for(const chatFile of ['one','branch']){
   const b={...request,source:{kind:'chat',avatar:'Nina.png',chatFile}};
   const {vector,topK,...bindBody}=b;const bind=await call('/v2/reads/bind',bindBody);assert.equal(bind.statusCode,200,JSON.stringify(bind.body));
   const v=await call('/v2/workflows/preview',b);assert.equal(v.statusCode,200);
   assert.equal(v.body.productionWritesEnabled,false);
  }
  const paths=captured.filter(x=>x.route.endsWith('/points/search')).map(x=>x.route);
  assert.equal(paths.length,2);assert.notEqual(paths[0],paths[1]);
  // F01 rejects a missing owned source rather than reusing a stale identity.
  await fs.rm(path.join(chats,'Nina','one.jsonl'));
  const changed=await call('/v2/workflows/preview',{...request,source:{kind:'chat',avatar:'Nina.png',chatFile:'one'}});
  assert.ok(changed.statusCode>=400);assert.ok(changed.body.code?.startsWith('F01_'));
 }finally{await fs.rm(tmp,{recursive:true,force:true});}
});

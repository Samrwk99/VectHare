import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {derivedUuid,parseLorebookSnapshot,parseSummarySnapshot,readF09b6Snapshot} from '../lib/f09b6-saved-content.js';
import {executeF09b6,F09B6_CONSENT,registerF09b6Routes} from '../lib/f09b6-content-workflows.js';
import {collectionIdentity,contentFingerprint,recordIdentity} from '../lib/s02-identity.js';
const sha=x=>createHash('sha256').update(x).digest('hex');
const embedding={source:'transformers',model:'server-model',dimension:3,metric:'dot'};
const chatSource={kind:'chat',avatar:'Nina.png',chatFile:'one'};
const loreSource={kind:'lorebook',name:'my_lore'};
test('F09b6 saved-source snapshots derive stable UID identities and refuse unsupported or duplicate entries',()=>{
 const src='f01_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
 const v1=parseLorebookSnapshot(Buffer.from(JSON.stringify({entries:{0:{uid:14,content:'Alpha'},1:{uid:17,content:'Beta',disable:true}}})),src);
 const v2=parseLorebookSnapshot(Buffer.from(JSON.stringify({entries:{9:{uid:14,content:'Updated'},1:{uid:17,content:'Beta',disable:true}}})),src);
 assert.equal(v1.length,1);assert.equal(v1[0].recordId,v2[0].recordId);
 assert.equal(v1[0].recordId,derivedUuid(src,'lorebook-entry','14'));
 assert.equal(parseSummarySnapshot(Buffer.from(JSON.stringify({chat_metadata:{summary:'Known facts'}})),src)[0].kind,'saved-summary');
 assert.throws(()=>parseLorebookSnapshot(Buffer.from(JSON.stringify({entries:{a:{uid:2,content:'One'},b:{uid:2,content:'Two'}}})),src),e=>e.code==='F09B6_DUPLICATE_LORE_UID');
 assert.throws(()=>parseSummarySnapshot(Buffer.from('{}'),src),e=>e.code==='F09B6_SAVED_SUMMARY_UNAVAILABLE');
 assert.throws(()=>parseLorebookSnapshot(Buffer.from(JSON.stringify({entries:{a:{content:'No UID'}}})),src),e=>e.code==='F09B6_LORE_ENTRY_INVALID');
});
async function fixture(run){
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'f09b6-'));
 try{
  const root=path.join(tmp,'alice'),vectors=path.join(root,'vectors'),chats=path.join(root,'chats'),characters=path.join(root,'characters');
  const worlds=path.join(root,'worlds'),groups=path.join(root,'groups'),groupChats=path.join(root,'groupChats');
  for(const p of [vectors,path.join(chats,'Nina'),characters,worlds,groups,groupChats])await fs.mkdir(p,{recursive:true,mode:0o700});
  await fs.writeFile(path.join(characters,'Nina.png'),'avatar');
  const writeLore=async content=>fs.writeFile(path.join(worlds,'my_lore.json'),JSON.stringify({entries:{a:{uid:42,content}}}));
  const writeSummary=async summary=>fs.writeFile(path.join(chats,'Nina','one.jsonl'),JSON.stringify({chat_metadata:{summary}})+'\n'+JSON.stringify({mes:'hi',send_date:'1',name:'Nina',is_user:false})+'\n');
  await writeLore('Original lore');await writeSummary('Original summary');
  const req={user:{profile:{handle:'alice'},directories:{root,vectors,chats,characters,worlds,groups,groupChats}},
   s03:{userScopeId:'alice',vectorsPath:vectors},headers:{'x-vecthare-f09b6-pilot':'1'}};
  const records=new Map(),calls=[];let source=loreSource;
  const snapshot=async()=>readF09b6Snapshot(req,source);
  const first=await snapshot();
  const scope={userScopeId:'alice',collectionId:'world_info',type:'lore',sourceId:first.sourceId};
  const identifier=collectionIdentity({backend:'qdrant',scope,embedding});
  let binding={backend:'qdrant',scope,embedding,collection:{key:identifier.key,physicalName:identifier.physicalName}};
  const adapter={
   getRecord:async plan=>records.get(plan.recordId)??null,
   insertRecord:async(plan,payload)=>{calls.push('insert');records.set(plan.recordId,{recordId:plan.recordId,
    physicalId:recordIdentity(binding.scope,plan.recordId).physicalId,scope:binding.scope,revision:1,
    text:payload.text,textHash:contentFingerprint(payload.text),vector:payload.vector,
    vectorHash:sha(JSON.stringify(payload.vector)),metadata:payload.metadata,metadataHash:sha(JSON.stringify(payload.metadata))});},
   updateRecord:async(plan,payload)=>{calls.push('update');records.set(plan.recordId,{recordId:plan.recordId,
    physicalId:recordIdentity(binding.scope,plan.recordId).physicalId,scope:binding.scope,revision:plan.targetRevision,
    text:payload.text,textHash:contentFingerprint(payload.text),vector:payload.vector,
    vectorHash:sha(JSON.stringify(payload.vector)),metadata:payload.metadata,metadataHash:sha(JSON.stringify(payload.metadata))});},
   deleteRecord:async()=>{throw Error('F09B6_DELETE_FORBIDDEN');}
  };
  const deps={backendPool:{get:async()=>({})},embed:async()=>[0.5,0.25,0.125],
   readScoped:async(req,body)=>records.get(body.recordId)??null,
   bind:async()=>({binding}),getTransport:async()=>({}),verifyCollection:async()=>{},makeAdapter:()=>adapter};
  const body=mode=>({mode,backend:'qdrant',configId:'local',source,embedding});
  await run({req,body,deps,records,calls,writeLore,writeSummary,first,
   setSource:async next=>{
    source=next;const found=await snapshot();
    const nextScope={userScopeId:'alice',collectionId:next.kind==='lorebook'?'world_info':'chat_memory',
     type:next.kind==='lorebook'?'lore':'chat',sourceId:found.sourceId};
    const id=collectionIdentity({backend:'qdrant',scope:nextScope,embedding});
    binding={backend:'qdrant',scope:nextScope,embedding,collection:{key:id.key,physicalName:id.physicalName}};
    return found;
   }});
 }finally{await fs.rm(tmp,{recursive:true,force:true});}
}
test('F09b6 lorebook preview and exact one-item verified insert and update',()=>fixture(async({req,body,deps,records,calls,writeLore})=>{
 const preview=await executeF09b6({...req,body:body('preview')},deps);
 assert.equal(preview.status,'READ_ONLY_SAVED_CONTENT_PLAN');assert.deepEqual(preview.counts,{create:1,update:0,inSync:0});
 assert.equal(records.size,0);assert.ok(!JSON.stringify(preview).includes('Original lore'));
 const apply=await executeF09b6({...req,body:{...body('apply'),itemIndex:0,
  sourceRevisionFingerprint:preview.sourceRevisionFingerprint,experimentalConsent:F09B6_CONSENT}},deps);
 assert.equal(apply.status,'VERIFIED');assert.deepEqual(calls,['insert']);
 assert.equal([...records.values()][0].text,'Original lore');
 const after=await executeF09b6({...req,body:body('preview')},deps);
 assert.deepEqual(after.counts,{create:0,update:0,inSync:1});
 await writeLore('New lore');
 const changed=await executeF09b6({...req,body:body('preview')},deps);
 assert.deepEqual(changed.counts,{create:0,update:1,inSync:0});
 await assert.rejects(executeF09b6({...req,body:{...body('apply'),itemIndex:0,
  sourceRevisionFingerprint:preview.sourceRevisionFingerprint,experimentalConsent:F09B6_CONSENT}},deps),e=>e.code==='F09B6_STALE_PREVIEW');
 const updated=await executeF09b6({...req,body:{...body('apply'),itemIndex:0,
  sourceRevisionFingerprint:changed.sourceRevisionFingerprint,experimentalConsent:F09B6_CONSENT}},deps);
 assert.equal(updated.status,'VERIFIED');assert.deepEqual(calls,['insert','update']);
 assert.equal([...records.values()][0].text,'New lore');
}));
test('F09b6 saved chat header summary is source owned and can be inserted only with explicit consent',()=>fixture(async({req,body,deps,setSource,calls,records})=>{
 await setSource(chatSource);
 const preview=await executeF09b6({...req,body:{...body('preview'),source:chatSource}},deps);
 assert.equal(preview.sourceKind,'saved-summary');assert.equal(preview.actions.length,1);
 const saved={...body('apply'),source:chatSource,sourceRevisionFingerprint:preview.sourceRevisionFingerprint,
  experimentalConsent:F09B6_CONSENT,itemIndex:0};
 await assert.rejects(executeF09b6({...req,body:{...saved,text:'forged'}},deps),e=>e.code==='F09B6_CLIENT_SCOPE_FORBIDDEN');
 await assert.rejects(executeF09b6({...req,body:{...saved,recordId:'forged'}},deps),e=>e.code==='F09B6_CLIENT_SCOPE_FORBIDDEN');
 await assert.rejects(executeF09b6({...req,headers:{},body:saved},deps),e=>e.code==='F09B6_SAME_ORIGIN_REQUIRED');
 const result=await executeF09b6({...req,body:saved},deps);
 assert.equal(result.status,'VERIFIED');assert.deepEqual(calls,['insert']);
 assert.equal([...records.values()][0].text,'Original summary');
}));
test('F09b6 changed source during embedding refuses before physical write',()=>fixture(async({req,body,deps,writeLore,calls})=>{
 const preview=await executeF09b6({...req,body:body('preview')},deps);
 deps.embed=async()=>{await writeLore('Modified after preview');return [0.5,0.25,0.125];};
 await assert.rejects(executeF09b6({...req,body:{...body('apply'),sourceRevisionFingerprint:preview.sourceRevisionFingerprint,
  itemIndex:0,experimentalConsent:F09B6_CONSENT}},deps),e=>e.code==='F09B6_SOURCE_CHANGED');
 assert.equal(calls.length,0);
}));
test('F09b6 uncertain operation stays pending and is never replayed',()=>fixture(async({req,body,deps,calls})=>{
 const preview=await executeF09b6({...req,body:body('preview')},deps);
 const apply={...body('apply'),sourceRevisionFingerprint:preview.sourceRevisionFingerprint,itemIndex:0,experimentalConsent:F09B6_CONSENT};
 deps.makeAdapter=()=>({getRecord:async()=>null,insertRecord:async()=>{calls.push('uncertain');throw Error('timeout')},updateRecord:async()=>{},deleteRecord:async()=>{}});
 const uncertain=await executeF09b6({...req,body:apply},deps);
 assert.equal(uncertain.status,'UNCERTAIN');assert.equal(uncertain.retryable,false);
 await assert.rejects(executeF09b6({...req,body:apply},deps),e=>e.code==='F09B4_MANAGED_INTENT_BLOCKED');
 assert.deepEqual(calls,['uncertain']);
}));
test('F09b6 route redacts saved text and vector and error details',()=>fixture(async({req,body,deps})=>{
 const paths={};registerF09b6Routes({post:(name,fn)=>paths[name]=fn},deps);
 const responder=()=>({code:200,status(n){this.code=n;return this;},json(x){this.data=x;return this;}});
 const res=responder();await paths['/v2/workflows/saved-content-pilot']({...req,body:body('preview')},res);
 assert.equal(res.data.success,true);assert.ok(!JSON.stringify(res.data).includes('Original lore'));
 const rejected=responder();await paths['/v2/workflows/saved-content-pilot']({...req,body:{...body('preview'),vectors:[1,2,3]}},rejected);
 assert.equal(rejected.code,403);assert.equal(rejected.data.productionWritesEnabled,false);
}));
test('F09b6 refuses untracked preexisting source ID instead of adopting or overwriting legacy content',()=>fixture(async({req,body,deps,records,calls,first})=>{
 const id=first.items[0].recordId;
 records.set(id,{recordId:id,revision:1,text:'Unmanaged historical text',metadata:{}});
 const preview=await executeF09b6({...req,body:body('preview')},deps);
 assert.equal(preview.actions[0].action,'UPDATE_PENDING_EMBEDDING');
 await assert.rejects(executeF09b6({...req,body:{...body('apply'),itemIndex:0,
  sourceRevisionFingerprint:preview.sourceRevisionFingerprint,experimentalConsent:F09B6_CONSENT}},deps),
  e=>e.code==='F09B4_MANAGED_RECORD_UNTRACKED');
 assert.equal(calls.length,0);
}));
test('F09b6 refuses symlinked lorebook and identity assigned to another user',()=>fixture(async({req,body,deps})=>{
 const book=path.join(req.user.directories.worlds,'my_lore.json');
 await fs.rename(book,book+'.real');await fs.symlink(book+'.real',book);
 await assert.rejects(executeF09b6({...req,body:body('preview')},deps));
 await fs.rm(book);await fs.rename(book+'.real',book);
 await assert.rejects(executeF09b6({...req,s03:{...req.s03,userScopeId:'another-user'},body:body('preview')},deps));
}));
for(const backend of ['lancedb','vectra','milvus'])test(`F09b6 one-record saved lore pilot preserves exact ${backend} scoped binding`,()=>fixture(async({req,body,deps,first,calls,records})=>{
 const scope={userScopeId:'alice',collectionId:'world_info',type:'lore',sourceId:first.sourceId};
 const coll=collectionIdentity({backend,scope,embedding});
 const binding={backend,scope,embedding,collection:{key:coll.key,physicalName:coll.physicalName}};
 deps.bind=async()=>({binding});
 const request={...body('preview'),backend,configId:'default'};
 const preview=await executeF09b6({...req,body:request},deps);
 assert.equal(preview.counts.create,1);
 const applied=await executeF09b6({...req,body:{...request,mode:'apply',itemIndex:0,
  sourceRevisionFingerprint:preview.sourceRevisionFingerprint,experimentalConsent:F09B6_CONSENT}},deps);
 assert.equal(applied.status,'VERIFIED');assert.deepEqual(calls,['insert']);assert.equal(records.size,1);
 assert.equal([...records.values()][0].scope.sourceId,first.sourceId);
}));

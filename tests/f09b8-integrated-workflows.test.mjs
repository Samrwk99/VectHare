/** F09b.8 — multi-stage offline integration acceptance.
 * Shared scoped physical fixture across F09b.3/4/5/6/7; not a live host test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {executeF09b3Sync,F09B3_CONSENT} from '../lib/f09b3-chat-sync-execute.js';
import {executeF09b4Lifecycle,F09B4_DELETE_CONSENT} from '../lib/f09b4-chat-lifecycle.js';
import {executeF09b6,F09B6_CONSENT} from '../lib/f09b6-content-workflows.js';
import {executeF09b7} from '../lib/f09b7-link-conditions.js';
import {readAttestedChatSnapshot} from '../lib/f09b-chat-sync.js';
import {readF09b6Snapshot} from '../lib/f09b6-saved-content.js';
import {saveEmbeddingProfile,getEmbeddingProfile,generateManagedEmbedding} from '../lib/f09b5-embedding-profiles.js';
import {collectionIdentity,recordIdentity,contentFingerprint} from '../lib/s02-identity.js';
const sha=x=>createHash('sha256').update(x).digest('hex');
const embedding={source:'transformers',model:'f09b8-fixture',dimension:3,metric:'dot'};
const chat={kind:'chat',avatar:'Nina.png',chatFile:'one'};
const lore={kind:'lorebook',name:'my_lore'};
const headers={'x-vecthare-f09b3-pilot':'1','x-vecthare-f09b4-pilot':'1','x-vecthare-f09b6-pilot':'1','x-vecthare-f09b7-preview':'1'};
const book=entries=>({entries});
async function fixture(backend,run){
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'f09b8-integrated-'));
 try{
  const root=path.join(tmp,'alice'),dirs={root};
  for(const folder of ['vectors','chats','characters','worlds','groups','groupChats']){
   dirs[folder]=path.join(root,folder);await fs.mkdir(dirs[folder],{recursive:true,mode:0o700});
  }
  await fs.mkdir(path.join(dirs.chats,'Nina'),{recursive:true});
  await fs.writeFile(path.join(dirs.characters,'Nina.png'),'avatar');
  const writeChat=async(message='Chat secret')=>fs.writeFile(path.join(dirs.chats,'Nina','one.jsonl'),
   [JSON.stringify({chat_metadata:{summary:'Saved summary secret'}}),JSON.stringify({name:'Nina',is_user:false,send_date:'1000',mes:message})].join('\n')+'\n');
  const writeLore=async(entries={a:{uid:42,content:'World info secret',key:['sun'],vecthareLinks:[43]},b:{uid:43,content:'Inactive',disable:true}})=>
   fs.writeFile(path.join(dirs.worlds,'my_lore.json'),JSON.stringify(book(entries)));
  await writeChat();await writeLore();
  const req={user:{profile:{handle:'alice'},directories:dirs},s03:{userScopeId:'alice',vectorsPath:dirs.vectors},headers};
  const snapChat=()=>readAttestedChatSnapshot(req,chat),snapLore=()=>readF09b6Snapshot(req,lore);
  const collection=new Map(),operations=[];
  const idFor=async source=>{
   const snap=source.kind==='lorebook'?await snapLore():await snapChat();
   const scope={userScopeId:'alice',collectionId:source.kind==='lorebook'?'world_info':'chat_memory',type:source.kind==='lorebook'?'lore':'chat',sourceId:snap.sourceId};
   const identity=collectionIdentity({backend,scope,embedding});
   return {backend,scope,embedding,collection:{key:identity.key,physicalName:identity.physicalName}};
  };
  const key=(binding,recordId)=>binding.collection.key+':'+recordId;
  const adapter=binding=>({
   getRecord:async plan=>collection.get(key(binding,plan.recordId))??null,
   insertRecord:async(plan,payload)=>writeRecord(binding,plan,payload,'insert'),
   updateRecord:async(plan,payload)=>writeRecord(binding,plan,payload,'update'),
   deleteRecord:async plan=>{operations.push({verb:'delete',backend,collection:binding.collection.key,recordId:plan.recordId});collection.delete(key(binding,plan.recordId));}
  });
  const writeRecord=(binding,plan,payload,verb)=>{
   const value={recordId:plan.recordId,physicalId:recordIdentity(binding.scope,plan.recordId).physicalId,
    scope:binding.scope,revision:plan.targetRevision,text:payload.text,textHash:contentFingerprint(payload.text),
    vector:payload.vector,vectorHash:sha(JSON.stringify(payload.vector)),metadata:payload.metadata??{},
    metadataHash:sha(JSON.stringify(payload.metadata??{}))};
   operations.push({verb,backend,collection:binding.collection.key,recordId:plan.recordId});
   collection.set(key(binding,plan.recordId),value);
  };
  const deps={backendPool:{get:async()=>({})},embed:async(_provider,text)=>generateManagedEmbedding(req.s03,embedding,text,{hostEmbed:async()=>[0.5,0.25,0.125]}),
   readScoped:async(_req,b,op)=>{
    assert.equal(op,'get');const binding=await idFor(b.source);return collection.get(key(binding,b.recordId))??null;
   },bind:async(_req,b)=>({binding:await idFor(b.source)}),getTransport:async()=>({}),verifyCollection:async()=>{},makeAdapter:(_conn,binding)=>adapter(binding)};
  const configId=backend==='qdrant'?'local':'default';
  const base=source=>({backend,configId,source,embedding});
  await run({req,base,deps,collection,operations,idFor,writeChat,writeLore,snapChat,snapLore,key});
 }finally{await fs.rm(tmp,{recursive:true,force:true});}
}
for(const backend of ['qdrant','lancedb','vectra','milvus']){
 test(`F09b.8 ${backend}: managed profile -> saved chat write -> exact delete -> tombstone prevents resurrection`,()=>fixture(backend,async({req,base,deps,collection,operations,snapChat,idFor,key})=>{
  const saved=await saveEmbeddingProfile(req.s03,{...embedding});assert.equal(saved.serverManaged,true);
  const profile=await getEmbeddingProfile(req.s03);assert.deepEqual(profile.profile,embedding);
  const snap=await snapChat(),binding=await idFor(chat),body={...base(chat),experimentalConsent:F09B3_CONSENT,sourceRevisionFingerprint:snap.fileHash};
  const created=await executeF09b3Sync({...req,body},deps);
  assert.equal(created.status,'VERIFIED');assert.equal(created.productionWritesEnabled,false);
  assert.equal(collection.size,1);
  const messageId=snap.messages[0].recordId;
  assert.ok(collection.has(key(binding,messageId)));
  const deleted=await executeF09b4Lifecycle({...req,body:{...base(chat),action:'delete',messageIndex:0,
   sourceRevisionFingerprint:snap.fileHash,experimentalConsent:F09B4_DELETE_CONSENT}},deps);
  assert.equal(deleted.status,'VERIFIED');assert.equal(collection.size,0);
  await assert.rejects(executeF09b3Sync({...req,body},deps),e=>e.code==='F09B4_MANAGED_INTENT_BLOCKED');
  assert.deepEqual(operations.map(x=>x.verb),['insert','delete']);
  assert.ok(operations.every(x=>x.collection===binding.collection.key&&x.backend===backend));
 }));
 test(`F09b.8 ${backend}: saved lore insertion -> F09b.7 read-only lifecycle and stale-source refusal`,()=>fixture(backend,async({req,base,deps,collection,operations,writeLore})=>{
  await saveEmbeddingProfile(req.s03,{...embedding});
  const preview=await executeF09b6({...req,body:{...base(lore),mode:'preview'}},deps);
  assert.equal(preview.status,'READ_ONLY_SAVED_CONTENT_PLAN');assert.equal(preview.counts.create,1);
  const applied=await executeF09b6({...req,body:{...base(lore),mode:'apply',itemIndex:0,
   sourceRevisionFingerprint:preview.sourceRevisionFingerprint,experimentalConsent:F09B6_CONSENT}},deps);
  assert.equal(applied.status,'VERIFIED');assert.equal(collection.size,1);
  const inspected=await executeF09b7({...req,body:base(lore)}, {readScoped:deps.readScoped});
  assert.equal(inspected.status,'READ_ONLY_LINK_CONDITION_LIFECYCLE_PREVIEW');
  assert.equal(inspected.entries.length,2);assert.equal(inspected.entries[0].lifecycle,'IN_SYNC');
  assert.equal(inspected.entries[1].lifecycle,'DISABLED_SOURCE');
  assert.equal(inspected.entries[0].links[0].state,'TARGET_DISABLED_OR_EMPTY');
  assert.equal(inspected.conditionEvaluation,'NOT_EVALUATED');
  assert.equal(inspected.automaticMutationsEnabled,false);assert.equal(inspected.deletionAuthority,false);
  assert.equal(operations.length,1);assert.equal(JSON.stringify(inspected).includes('World info secret'),false);
  await writeLore({a:{uid:42,content:'Changed after preview',vecthareLinks:[999]},b:{uid:43,content:'Inactive',disable:true}});
  await assert.rejects(executeF09b6({...req,body:{...base(lore),mode:'apply',itemIndex:0,
   sourceRevisionFingerprint:preview.sourceRevisionFingerprint,experimentalConsent:F09B6_CONSENT}},deps),e=>e.code==='F09B6_STALE_PREVIEW');
  const stale=await executeF09b7({...req,body:base(lore)},{readScoped:deps.readScoped});
  assert.equal(stale.entries[0].lifecycle,'STALE_VECTOR');assert.equal(stale.entries[0].links[0].state,'UNRESOLVED_TARGET');
  assert.equal(operations.length,1);
 }));
}
test('F09b.8 changed chat during server embedding is refused before any backend write',()=>fixture('qdrant',async({req,base,deps,writeChat,snapChat,operations})=>{
 await saveEmbeddingProfile(req.s03,embedding);
 const snap=await snapChat();deps.embed=async()=>{await writeChat('Changed during embedding');return [1,0,0]};
 await assert.rejects(executeF09b3Sync({...req,body:{...base(chat),sourceRevisionFingerprint:snap.fileHash,
  experimentalConsent:F09B3_CONSENT}},deps),e=>e.code==='F09B3_SOURCE_CHANGED');
 assert.equal(operations.length,0);
}));
test('F09b.8 cross-workflow forged scope and profile mismatch are rejected with no write',()=>fixture('qdrant',async({req,base,deps,operations})=>{
 await saveEmbeddingProfile(req.s03,embedding);
 await assert.rejects(generateManagedEmbedding(req.s03,{...embedding,model:'other'},'some text',{hostEmbed:async()=>[1,0,0]}),e=>e.code==='F09B5_PROFILE_MISMATCH');
 await assert.rejects(executeF09b7({...req,body:{...base(lore),recordId:'untrusted'}},{readScoped:deps.readScoped}),e=>e.code==='F09B7_INVALID_SCOPE');
 await assert.rejects(executeF09b6({...req,body:{...base(lore),mode:'preview',source:{...lore,userScopeId:'bob'}}},deps),e=>e.code==='F09B6_CLIENT_SCOPE_FORBIDDEN');
 await assert.rejects(executeF09b3Sync({...req,body:{...base(chat),recordId:'untrusted',experimentalConsent:F09B3_CONSENT,sourceRevisionFingerprint:'0'.repeat(64)}},deps));
 assert.equal(operations.length,0);
}));

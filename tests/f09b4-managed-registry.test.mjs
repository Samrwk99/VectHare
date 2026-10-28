import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {ManagedChatRegistry} from '../lib/f09b4-managed-registry.js';
import {executeF09b3Sync,F09B3_CONSENT} from '../lib/f09b3-chat-sync-execute.js';
import {executeF09b4Lifecycle,F09B4_DELETE_CONSENT} from '../lib/f09b4-chat-lifecycle.js';
import {executeF09b4OrphanPilot,F09B4_ORPHAN_CONSENT} from '../lib/f09b4-chat-lifecycle.js';
import {readAttestedChatSnapshot} from '../lib/f09b-chat-sync.js';
import {collectionIdentity,recordIdentity,contentFingerprint} from '../lib/s02-identity.js';
const sha=x=>createHash('sha256').update(x).digest('hex');
const source={kind:'chat',avatar:'Nina.png',chatFile:'one'};
const embedding={source:'transformers',model:'fixture',dimension:3,metric:'dot'};
async function setup(fn){
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'f09b4-managed-'));
 try{
  const root=path.join(tmp,'alice');const dirs=Object.fromEntries(['vectors','chats','characters','worlds','groups','groupChats'].map(k=>[k,path.join(root,k)]));
  for(const p of Object.values(dirs))await fs.mkdir(p,{mode:0o700,recursive:true});
  await fs.mkdir(path.join(dirs.chats,'Nina'),{recursive:true});
  await fs.writeFile(path.join(dirs.characters,'Nina.png'),'avatar');
  const write=async(mes='hello')=>fs.writeFile(path.join(dirs.chats,'Nina','one.jsonl'),
   JSON.stringify({chat_metadata:{integrity:'not-authority'}})+'\n'+JSON.stringify({name:'Nina',is_user:false,send_date:'1000',mes})+'\n');
  await write();
  const req={user:{profile:{handle:'alice'},directories:{root,...dirs}},s03:{userScopeId:'alice',vectorsPath:dirs.vectors},headers:{'x-vecthare-f09b4-pilot':'1'}};
  const before=await readAttestedChatSnapshot(req,source);
  const scope={userScopeId:'alice',collectionId:'chat_memory',type:'chat',sourceId:before.sourceId};
  const collection=collectionIdentity({backend:'qdrant',scope,embedding});
  const binding={backend:'qdrant',scope,embedding,collection:{key:collection.key,physicalName:collection.physicalName}};
  const recordId=before.messages[0].recordId;
  const registry=new ManagedChatRegistry(req.s03,binding);
  const opId=randomUUID();
  await registry.begin({recordId,contentHash:before.messages[0].contentHash,revision:0,operationId:opId,action:'write',bootstrap:true});
  await registry.finish({recordId,contentHash:before.messages[0].contentHash,revision:1,operationId:opId,action:'write'});
  const records=new Map();const calls=[];
  records.set(recordId,{recordId,physicalId:recordIdentity(scope,recordId).physicalId,scope,revision:1,text:'hello',
   textHash:contentFingerprint('hello'),vector:[1,0,0],vectorHash:sha(JSON.stringify([1,0,0]))});
  const deps={bind:async()=>({binding}),readScoped:async(_req,b)=>records.get(b.recordId)??null,
   getTransport:async()=>({}),verifyCollection:async()=>{},makeAdapter:()=>({
    getRecord:async()=>records.get(recordId)??null,insertRecord:async()=>{throw Error('insert not allowed')},
    updateRecord:async()=>{throw Error('update not allowed')},deleteRecord:async()=>{calls.push('delete');records.delete(recordId)}})};
  const base={backend:'qdrant',source,embedding,configId:'local'};
  await fn({req,write,before,binding,registry,records,calls,deps,base,recordId});
 }finally{await fs.rm(tmp,{recursive:true,force:true});}
}
test('F09b4 managed registry protects intents, survives restart, and refuses corrupt/symlinked records',()=>setup(async({req,binding,registry,recordId})=>{
 const other=new ManagedChatRegistry(req.s03,binding);
 assert.equal((await other.read()).records[recordId].state,'ACTIVE');
 const op=randomUUID();
 await registry.begin({recordId,contentHash:contentFingerprint('hello'),revision:1,operationId:op,action:'delete'});
 await assert.rejects(other.guard(recordId),e=>e.code==='F09B4_MANAGED_INTENT_BLOCKED');
 await registry.finish({recordId,contentHash:contentFingerprint('hello'),revision:1,operationId:op,action:'delete'});
 await assert.rejects(other.guard(recordId),e=>e.code==='F09B4_MANAGED_INTENT_BLOCKED');
 await assert.rejects(other.begin({recordId,contentHash:contentFingerprint('hello'),revision:0,
  operationId:randomUUID(),action:'write',bootstrap:true}),e=>e.code==='F09B4_MANAGED_INTENT_BLOCKED');
 await fs.writeFile(registry.file,(await fs.readFile(registry.file,'utf8')).replace('DELETED','ACTIVE'));
 await assert.rejects(other.read(),e=>e.code==='F09B4_REGISTRY_CORRUPT');
}));
test('F09b4 only previews and deletes registered orphans using exact readback and explicit consent',()=>setup(async({req,write,registry,records,calls,deps,base,recordId})=>{
 await write('');
 const snap=await readAttestedChatSnapshot(req,source);
 const body={...base,mode:'preview'};
 const preview=await executeF09b4OrphanPilot({...req,body},deps);
 assert.equal(preview.status,'MANAGED_ORPHAN_PREVIEW');assert.equal(preview.orphanCount,1);
 assert.equal(preview.pendingCount,0);assert.equal(preview.orphans[0].textPreview,'hello');assert.equal(preview.tombstoneCount,0);assert.equal(preview.completeBackendInventory,false);
 await assert.rejects(executeF09b4OrphanPilot({...req,body:{...body,mode:'delete',orphanIndex:0,
  sourceRevisionFingerprint:preview.sourceRevisionFingerprint,registryFingerprint:preview.registryFingerprint,experimentalConsent:'no'}},deps),e=>e.code==='F09B4_ORPHAN_CONSENT_REQUIRED');
 await assert.rejects(executeF09b4OrphanPilot({...req,body:{...body,mode:'delete',orphanIndex:0,
  recordId,sourceRevisionFingerprint:preview.sourceRevisionFingerprint,registryFingerprint:preview.registryFingerprint,experimentalConsent:F09B4_ORPHAN_CONSENT}},deps),e=>e.code==='F09B4_ORPHAN_CLIENT_SCOPE_FORBIDDEN');
 const deleted=await executeF09b4OrphanPilot({...req,body:{...body,mode:'delete',orphanIndex:0,
  sourceRevisionFingerprint:preview.sourceRevisionFingerprint,registryFingerprint:preview.registryFingerprint,experimentalConsent:F09B4_ORPHAN_CONSENT}},deps);
 assert.equal(deleted.status,'VERIFIED');assert.deepEqual(calls,['delete']);assert.equal(records.size,0);
 assert.equal((await registry.read()).records[recordId].state,'DELETED');
 const next=await executeF09b4OrphanPilot({...req,body},deps);
 assert.equal(next.orphanCount,0);assert.equal(next.tombstoneCount,1);
 await assert.rejects(executeF09b4OrphanPilot({...req,body:{...body,mode:'delete',orphanIndex:0,
  sourceRevisionFingerprint:preview.sourceRevisionFingerprint,registryFingerprint:preview.registryFingerprint,experimentalConsent:F09B4_ORPHAN_CONSENT}},deps),e=>e.code==='F09B4_ORPHAN_REGISTRY_CHANGED');
}));
test('F09b4 refuses orphan deletion if source, registry, record text or revision changes',()=>setup(async({req,write,registry,records,calls,deps,base,recordId})=>{
 await write('');const snap=await readAttestedChatSnapshot(req,source);
 const p=await executeF09b4OrphanPilot({...req,body:{...base,mode:'preview'}},deps);
 const b={...base,sourceRevisionFingerprint:snap.fileHash,mode:'delete',orphanIndex:0,
  registryFingerprint:p.registryFingerprint,experimentalConsent:F09B4_ORPHAN_CONSENT};
 records.get(recordId).revision=2;
 await assert.rejects(executeF09b4OrphanPilot({...req,body:b},deps),e=>e.code==='F09B4_ORPHAN_RECORD_CHANGED');
 records.get(recordId).revision=1;
 await write('new content');
 await assert.rejects(executeF09b4OrphanPilot({...req,body:b},deps),e=>e.code==='F09B4_ORPHAN_SOURCE_CHANGED');
 assert.deepEqual(calls,[]);
}));
test('F09b4 uncertain orphan mutation preserves deletion intent and blocks retry',()=>setup(async({req,write,registry,records,calls,deps,base})=>{
 await write('');const snap=await readAttestedChatSnapshot(req,source);
 const preview=await executeF09b4OrphanPilot({...req,body:{...base,mode:'preview'}},deps);
 deps.makeAdapter=()=>({getRecord:async()=>records.values().next().value,
  insertRecord:async()=>{},updateRecord:async()=>{},deleteRecord:async()=>{calls.push('delete');throw Error('timeout')}});
 const b={...base,sourceRevisionFingerprint:snap.fileHash,mode:'delete',orphanIndex:0,
  sourceRevisionFingerprint:preview.sourceRevisionFingerprint,registryFingerprint:preview.registryFingerprint,experimentalConsent:F09B4_ORPHAN_CONSENT};
 const r=await executeF09b4OrphanPilot({...req,body:b},deps);
 assert.equal(r.status,'UNCERTAIN');assert.equal(r.retryable,false);
 const state=await registry.read();assert.equal(Object.values(state.records)[0].state,'DELETE_PENDING');
 const inspection=await executeF09b4OrphanPilot({...req,body:{...base,mode:'inspect',operationId:r.operationId}},deps);
 assert.equal(inspection.state,'UNCERTAIN');assert.equal(inspection.managedState,'DELETE_PENDING');
 assert.equal(inspection.automaticallyReconciled,false);
 await assert.rejects(executeF09b4OrphanPilot({...req,body:b},deps));
 assert.deepEqual(calls,['delete']);
}));

test('F09b4 manual deletion tombstone prevents F09b3 from silently recreating a still-saved message',()=>setup(async({req,before,deps,base,registry,records,recordId,calls})=>{
 const deleted=await executeF09b4Lifecycle({...req,body:{...base,sourceRevisionFingerprint:before.fileHash,
  messageIndex:0,action:'delete',experimentalConsent:F09B4_DELETE_CONSENT}},
  {...deps,embed:async()=>[1,0,0]});
 assert.equal(deleted.status,'VERIFIED');assert.equal((await registry.read()).records[recordId].state,'DELETED');
 const sync={...base,sourceRevisionFingerprint:before.fileHash,experimentalConsent:F09B3_CONSENT};
 await assert.rejects(executeF09b3Sync({...req,headers:{'x-vecthare-f09b3-pilot':'1'},body:sync},
  {...deps,embed:async()=>[1,0,0]}),e=>e.code==='F09B4_MANAGED_INTENT_BLOCKED');
 assert.deepEqual(calls,['delete']);assert.equal(records.size,0);
}));
test('F09b4 refuses symlinked managed registry rather than following it',()=>setup(async({registry,recordId})=>{
 const bytes=await fs.readFile(registry.file);
 await fs.rm(registry.file);
 const outside=path.join(path.dirname(registry.file),'outside.json');await fs.writeFile(outside,bytes);
 await fs.symlink(outside,registry.file);
 await assert.rejects(registry.read(),e=>e.code==='F09B4_REGISTRY_UNTRUSTED');
}));

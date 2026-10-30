import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {collectionIdentity,contentFingerprint} from '../lib/s02-identity.js';
import {savedRecordIdentity,previewM1Records,planM1Record,executeM1Record,validateM1Intent} from '../lib/m1-saved-records.js';
import {ManagedChatRegistry} from '../lib/f09b4-managed-registry.js';
import {f07SchemaSeal} from '../lib/f07-vectra.js';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const profile={source:'transformers',model:'fixture',dimension:3,metric:'dot'};
const source={kind:'chat',avatar:'alice.png',chatFile:'saved-chat'};
const scope={userScopeId:'alice',collectionId:'saved-chat',type:'chat',sourceId:'saved-chat'};
const id=collectionIdentity({backend:'vectra',scope,embedding:profile});
const binding={authorized:true,provenance:'SERVER_VERIFIED',backend:'vectra',scope,embedding:profile,collection:{key:id.key,physicalName:id.physicalName}};
const msg={recordId:'eabb4525-29cc-8bbc-af01-22decd92ae77',text:'saved hello',contentHash:contentFingerprint('saved hello')};
function fakeVectra(){
 const records=new Map();let lostAck=false,txn=false;
 const idx={async isIndexCreated(){return true;},async getItem(id){return structuredClone(records.get(id)??null);},
  async listItems(){return structuredClone([...records.values()]);},
  async beginUpdate(){if(txn)throw Error('already begun');txn=true;},
  async endUpdate(){if(!txn)throw Error('not begun');txn=false;if(lostAck)throw Error('response lost after durable mutation');},
  async cancelUpdate(){txn=false;},
  async insertItem(item){if(!txn||records.has(item.id))throw Error('insert invalid');records.set(item.id,structuredClone(item));},
  async upsertItem(item){if(!txn||!records.has(item.id))throw Error('update invalid');records.set(item.id,structuredClone(item));},
  async deleteItem(id){if(!txn||!records.has(id))throw Error('delete invalid');records.delete(id);}};
 return {backend:{index:idx,s08ServerSchema:f07SchemaSeal(binding)},records,setLostAck:x=>lostAck=x};
}
async function fixture(){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'m4b-m1-'));await fs.chmod(dir,0o700);
 const req={s03:{userScopeId:'alice',vectorsPath:dir},user:{directories:{}},body:null};
 const snapshot={sourceId:scope.sourceId,sourceKind:'chat',fileHash:hash('file-1'),messages:[{...msg}]};
 const db=fakeVectra();const deps={getProfile:async()=>({configured:true,profile}),
  bind:async()=>({binding}),readSnapshot:async()=>structuredClone(snapshot),
  getReceipt:async()=>({state:'SCHEMA_VERIFIED_OFFLINE_UNCERTIFIED'}),
  createVectra:async()=>db.backend,embed:async()=>[0.2,0.4,0.6]};
 return {req,dir,snapshot,deps,db,recordId:savedRecordIdentity(req.s03,binding,msg).recordId,
 cleanup:()=>fs.rm(dir,{recursive:true,force:true})};
}
test('M4b source-attested Vectra M1/S04 insert update revectorize delete with verified readback',async()=>{
 const f=await fixture();try{
  const {req,deps,recordId,db,snapshot}=f;
  assert.equal(validateM1Intent({backend:'vectra',source,action:'insert',recordId}).backend,'vectra');
  assert.throws(()=>validateM1Intent({backend:'vectra',source,action:'insert',recordId,configId:'local'}));
  req.body={backend:'vectra',source};assert.equal((await previewM1Records(req,deps)).backend,'vectra');
  async function action(type){req.body={backend:'vectra',source,recordId,action:type};
   const planned=await planM1Record(req,id.key,deps);
   req.body={operationId:planned.operationId,confirmation:'APPLY SAVED RECORD MUTATION'};
   const result=await executeM1Record(req,deps);
   assert.equal(result.state,'VERIFIED',JSON.stringify(result));return result;}
  await action('insert');assert.equal(db.records.size,1);
  assert.deepEqual([...db.records.values()][0].vector,[0.2,0.4,0.6].map(Math.fround));
  snapshot.messages[0].text='saved hello changed';snapshot.messages[0].contentHash=contentFingerprint('saved hello changed');snapshot.fileHash=hash('file-2');
  await action('update');assert.equal([...db.records.values()][0].metadata.revision,2);
  await action('revectorize');assert.equal([...db.records.values()][0].metadata.revision,3);
  await action('delete');assert.equal(db.records.size,0);
  assert.equal((await new ManagedChatRegistry(req.s03,binding).read()).records[recordId].state,'DELETED');
 }finally{await f.cleanup();}
});
test('M4b Vectra lost acknowledgement becomes UNCERTAIN; no ticket replay',async()=>{
 const f=await fixture();try{
  const {req,deps,recordId,db}=f;db.setLostAck(true);
  req.body={backend:'vectra',source,recordId,action:'insert'};
  const planned=await planM1Record(req,id.key,deps);
  req.body={operationId:planned.operationId,confirmation:'APPLY SAVED RECORD MUTATION'};
  const result=await executeM1Record(req,deps);
  assert.equal(result.state,'UNCERTAIN');assert.equal(db.records.size,1);
  assert.equal((await new ManagedChatRegistry(req.s03,binding).read()).records[recordId].state,'WRITE_PENDING');
  await assert.rejects(()=>executeM1Record(req,deps),{code:'M1_TICKET_ALREADY_CONSUMED'});
 }finally{await f.cleanup();}
});

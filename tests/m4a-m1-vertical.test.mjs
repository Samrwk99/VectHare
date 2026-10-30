import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {collectionIdentity,contentFingerprint} from '../lib/s02-identity.js';
import {savedRecordIdentity,previewM1Records,planM1Record,executeM1Record,validateM1Intent} from '../lib/m1-saved-records.js';
import {ManagedChatRegistry} from '../lib/f09b4-managed-registry.js';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const profile={source:'transformers',model:'fixture',dimension:3,metric:'dot'};
const source={kind:'chat',avatar:'alice.png',chatFile:'saved-chat'};
const scope={userScopeId:'alice',collectionId:'saved-chat',type:'chat',sourceId:'saved-chat'};
const id=collectionIdentity({backend:'lancedb',scope,embedding:profile});
const binding={authorized:true,provenance:'SERVER_VERIFIED',backend:'lancedb',scope,embedding:profile,
 collection:{key:id.key,physicalName:id.physicalName}};
const msg={recordId:'eabb4525-29cc-8bbc-af01-22decd92ae77',text:'saved hello',contentHash:contentFingerprint('saved hello')};
function fakeDB(){const records=new Map();let lostAck=false;
 const filter=(sql,row)=>sql.split(' AND ').every(s=>{
  const m=s.match(/^(\w+) = (?:'((?:[^']|'')*)'|([0-9]+))$/);
  if(!m)throw Error('INVALID_SQL_PREDICATE:'+s);
  return row[m[1]]===(m[2]===undefined?Number(m[3]):m[2].replaceAll("''","'"));
 });
 const table={schema:async()=>({fields:[
  ...['physicalId','recordId','userScopeId','collectionId','type','sourceId','branchId','text','textHash',
  'metadata','metadataHash','embedding','vectorHash'].map(name=>({name,nullable:false})),
  {name:'schemaVersion'},{name:'revision'},{name:'vector',type:{listSize:3}}]}),
  async countRows(){return records.size},
  query(){let where=null,limit=Infinity,offset=0,ordered=false;
   const q={where(x){where=x;return q},limit(x){limit=x;return q},offset(x){offset=x;return q},
    orderBy(){ordered=true;return q},async toArray(){let arr=[...records.values()].filter(r=>!where||filter(where,r));
    if(ordered)arr.sort((a,b)=>a.physicalId.localeCompare(b.physicalId));
    return structuredClone(arr.slice(offset,offset+limit));}};return q;},
  async add(rows){for(const r of rows){records.set(r.physicalId,structuredClone(r));if(lostAck)throw Error('ack lost after commit');}},
  async update({where,values}){let n=0;for(const [k,r] of records){if(filter(where,r)){records.set(k,structuredClone(values));n++;}}return {rowsUpdated:n};},
  async delete(where){for(const [k,r] of records){if(filter(where,r))records.delete(k);}},
 };
 const db={async tableNames(){return [id.physicalName]},async openTable(){return table}};
 const backend={async getDatabase(src){assert.equal(src,'transformers');return db;}};
 return {backend,records,setLostAck:x=>lostAck=x};
}
async function fixture(){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'m4a-m1-'));await fs.chmod(dir,0o700);
 const req={s03:{userScopeId:'alice',vectorsPath:dir},user:{directories:{}},body:null};
 const snapshot={sourceId:scope.sourceId,sourceKind:'chat',fileHash:hash('file-1'),messages:[{...msg}]};
 const db=fakeDB();const deps={getProfile:async()=>({configured:true,profile,connectionState:'VERIFIED'}),
  bind:async()=>({binding}),readSnapshot:async()=>structuredClone(snapshot),
  getReceipt:async()=>({state:'SCHEMA_VERIFIED_OFFLINE_UNCERTIFIED'}),
  backendPool:{getTrusted:async(_ctx,backend)=>{assert.equal(backend,'lancedb');return db.backend;}},
  embed:async()=>[0.2,0.4,0.6]};
 return {dir,req,snapshot,deps,db,recordId:savedRecordIdentity(req.s03,binding,msg).recordId,
 cleanup:()=>fs.rm(dir,{recursive:true,force:true})};
}
test('M4a M1 trusted source saves through real S04 ledger and S08 Lance adapter; insertion, update, revectorize, deletion',async()=>{
 const f=await fixture();try{
  const {req,deps,recordId,db,snapshot}=f;
  assert.equal(validateM1Intent({backend:'lancedb',source,action:'insert',recordId}).backend,'lancedb');
  assert.throws(()=>validateM1Intent({backend:'lancedb',source,action:'insert',recordId,configId:'local'}));
  req.body={backend:'lancedb',source};assert.equal((await previewM1Records(req,deps)).backend,'lancedb');
  async function action(type){req.body={backend:'lancedb',source,recordId,action:type};
   const planned=await planM1Record(req,id.key,deps);
   req.body={operationId:planned.operationId,confirmation:'APPLY SAVED RECORD MUTATION'};
   const result=await executeM1Record(req,deps);
   assert.equal(result.state,'VERIFIED',JSON.stringify(result));return result;
  }
  await action('insert');assert.equal(db.records.size,1);
  assert.deepEqual([...db.records.values()][0].vector,[0.2,0.4,0.6].map(Math.fround));
  snapshot.messages[0].text='saved hello changed';snapshot.messages[0].contentHash=contentFingerprint('saved hello changed');snapshot.fileHash=hash('file-2');
  await action('update');assert.equal([...db.records.values()][0].revision,2);
  await action('revectorize');assert.equal([...db.records.values()][0].revision,3);
  await action('delete');assert.equal(db.records.size,0);
  assert.equal((await new ManagedChatRegistry(req.s03,binding).read()).records[recordId].state,'DELETED');
 }finally{await f.cleanup();}
});
test('M4a M1 lost acknowledgement is UNCERTAIN; no auto-retry and pending registry retained',async()=>{
 const f=await fixture();try{
  const {req,deps,recordId,db}=f;db.setLostAck(true);
  req.body={backend:'lancedb',source,recordId,action:'insert'};
  const planned=await planM1Record(req,id.key,deps);
  req.body={operationId:planned.operationId,confirmation:'APPLY SAVED RECORD MUTATION'};
  const result=await executeM1Record(req,deps);
  assert.equal(result.state,'UNCERTAIN');assert.equal(db.records.size,1);
  assert.equal((await new ManagedChatRegistry(req.s03,binding).read()).records[recordId].state,'WRITE_PENDING');
  await assert.rejects(()=>executeM1Record(req,deps),{code:'M1_TICKET_ALREADY_CONSUMED'});
 }finally{await f.cleanup();}
});

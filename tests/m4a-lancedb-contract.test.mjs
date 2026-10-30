import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {m4aLanceLifecycleAdapter} from '../lib/m4a-lancedb-contract.js';
import {collectionIdentity,recordIdentity,contentFingerprint} from '../lib/s02-identity.js';
const sha=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const scope={userScopeId:'alice',collectionId:'chat',type:'chat',sourceId:'saved-chat',branchId:'branch'};
const embedding={source:'transformers',model:'fixture',dimension:3,metric:'dot'};
const identity=collectionIdentity({backend:'lancedb',scope,embedding});
const binding={authorized:true,provenance:'SERVER_VERIFIED',backend:'lancedb',scope,embedding,
 collection:{key:identity.key,physicalName:identity.physicalName}};
function tableFixture(){
 const rows=[];
 const table={rows,schema:{fields:[
  ...['physicalId','recordId','userScopeId','collectionId','type','sourceId','branchId','text','textHash',
   'metadata','metadataHash','embedding','vectorHash'].map(name=>({name,nullable:false})),
  {name:'schemaVersion'},{name:'revision'},{name:'vector',type:{listSize:3}}]},
  async countRows(){return rows.length},
  query(){let offset=0,limit=Infinity,sort=false,filter=null;const obj={
   orderBy(){sort=true;return obj},offset(n){offset=n;return obj},limit(n){limit=n;return obj},
   where(s){filter=s;return obj},async toArray(){let out=rows.slice();if(filter){
    const physical=/physicalId = '([^']+)'/.exec(filter)?.[1];if(physical)out=out.filter(x=>x.physicalId===physical);
   }if(sort)out.sort((a,b)=>a.physicalId.localeCompare(b.physicalId));return structuredClone(out.slice(offset,offset+limit));}};
   return obj;
  },async add(items){rows.push(...structuredClone(items));}
 };
 const db={names:new Set([binding.collection.physicalName]),table,
  async tableNames(){return [...this.names]},async openTable(name){if(!this.names.has(name))throw Error('missing');return table;},
  async dropTable(name){this.names.delete(name)}};
 return {db,table};
}
function row(recordId=randomUUID(),overrides={}){
 const text='saved text',vector=[0.25,0.5,0.75],metadata={source:'authoritative'};
 return {physicalId:recordIdentity(scope,recordId).physicalId,recordId,...scope,revision:1,
  schemaVersion:2,text,textHash:contentFingerprint(text),metadata:JSON.stringify(metadata),
  metadataHash:sha(metadata),embedding:JSON.stringify(embedding),vector,vectorHash:sha(vector),...overrides};
}
function adapter(db,options={}){return m4aLanceLifecycleAdapter({db,binding,
 writerBoundary:async work=>work(),...options});}

test('M4a contract includes 12 methods, complete owner-verified physical inventory and backup checksum',async()=>{
 const {db,table}=tableFixture();table.rows.push(row(),row());const a=adapter(db);
 assert.equal(typeof a.insertRecord,'function');assert.equal(typeof a.inspectOperationOutcome,'function');
 assert.deepEqual((await a.getInventory()).count,2);
 const backup=await a.captureBackup();assert.equal(backup.items.length,2);
 assert.equal(backup.checksum,sha((({checksum,...rest})=>rest)(backup)));
 assert.equal(a.capabilities().independentlyProductionCertified,false);
});
test('M4a full physical inventory fails on foreign rows, duplicate IDs, changing counts and bound violations',async()=>{
 const {db,table}=tableFixture();const a=adapter(db,{maxRecords:2});table.rows.push(row());
 table.rows.push(row(randomUUID(),{userScopeId:'intruder'}));
 await assert.rejects(()=>a.getInventory(),{code:'S05_OWNER_MISMATCH'});
 table.rows.pop();table.rows.push(structuredClone(table.rows[0]));
 await assert.rejects(()=>a.getInventory(),{code:'M4A_DUPLICATE_RECORD'});
 table.rows.push(row());await assert.rejects(()=>a.getInventory(),{code:'M4A_INVENTORY_BOUNDS'});
});
test('M4a destructive deletion requires real proof, original backup and unchanged inventory',async()=>{
 const {db,table}=tableFixture();table.rows.push(row());
 const guard=adapter(db);const backup=await guard.captureBackup();
 await assert.rejects(()=>guard.deleteCollection({backup,operationId:randomUUID()}),{code:'M4A_LIFECYCLE_NOT_CONNECTED'});
 const trusted=adapter(db,{requireLifecycleProof:async({operationId})=>({authorized:true,consumed:true,backupVerified:true,operationId})});
 table.rows.push(row());await assert.rejects(()=>trusted.deleteCollection({backup,operationId:randomUUID()}),{code:'M4A_BACKUP_STALE'});
 table.rows.pop();
 const tampered={...backup,items:[...backup.items,{not:'real'}]};
 await assert.rejects(()=>trusted.deleteCollection({backup:tampered,operationId:randomUUID()}),{code:'M4A_VERIFIED_BACKUP_REQUIRED'});
 assert.equal((await trusted.deleteCollection({backup,operationId:randomUUID()})).status,'VERIFIED');
 assert.equal(db.names.size,0);
});
test('M4a restoration requires a distinct authenticated empty target and does not overwrite rows',async()=>{
 const {db,table}=tableFixture();table.rows.push(row());const a=adapter(db),backup=await a.captureBackup();
 const approved=adapter(db,{requireLifecycleProof:async({operationId})=>({authorized:true,consumed:true,backupVerified:true,operationId})});
 await assert.rejects(()=>approved.restoreToNew(backup,{operationId:randomUUID()}),{code:'M4A_BACKUP_INVALID'});
 const targetBackup={...backup,physicalName:'vh2_'+('9'.repeat(48))};
 targetBackup.checksum=sha((({checksum,...rest})=>rest)(targetBackup));
 await assert.rejects(()=>approved.restoreToNew(targetBackup,{operationId:randomUUID()}),{code:'M4A_RESTORE_TARGET_NOT_EMPTY'});
});
test('M4a cannot invent NOT_APPLIED recovery or bypass missing writer locks',async()=>{
 const {db}=tableFixture(),a=adapter(db);
 assert.equal((await a.inspectOperationOutcome(randomUUID())).status,'UNCERTAIN');
 await assert.rejects(()=>a.inspectOperationOutcome('not-a-uuid'),{code:'M4A_OPERATION_ID_INVALID'});
 await assert.rejects(()=>adapter(db,{writerBoundary:null}).captureBackup(),{code:'M4A_WRITER_BOUNDARY_REQUIRED'});
});
test('M4a restore to a separate fresh v2 target roundtrips the complete physical inventory',async()=>{
 const {db,table}=tableFixture();table.rows.push(row());
 const origin=adapter(db),backup=await origin.captureBackup();
 // The prior generation's immutable source table has a different server-issued
 // physical name; the current target table was separately provisioned empty.
 backup.physicalName='vh2_'+('8'.repeat(48));
 backup.checksum=sha((({checksum,...rest})=>rest)(backup));
 table.rows.length=0;
 const restored=adapter(db,{requireLifecycleProof:async({operationId})=>({authorized:true,consumed:true,
  backupVerified:true,operationId})});
 const operationId=randomUUID();
 assert.deepEqual(await restored.restoreToNew(backup,{operationId}),
  {status:'VERIFIED',operationId,restoredCount:1});
 assert.equal(table.rows[0].schemaVersion,2);
 assert.equal((await restored.getInventory()).count,1);
});

test('M4d LanceDB rejects a mismatched one-use operation proof without dropping data',async()=>{
 const {db,table}=tableFixture();table.rows.push(row());const backup=await adapter(db).captureBackup();
 const mismatched=adapter(db,{requireLifecycleProof:async()=>({authorized:true,consumed:true,
  backupVerified:true,operationId:randomUUID()})});
 await assert.rejects(()=>mismatched.deleteCollection({backup,operationId:randomUUID()}),
  {code:'M4A_LIFECYCLE_PROOF_INVALID'});
 assert.equal(db.names.has(binding.collection.physicalName),true);
 assert.equal(table.rows.length,1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {PB4LifecycleSession,PB4_CONFIRMATIONS} from '../utils/pb4-collection-lifecycle.js';
const id='1f2d7534-2bb4-4f9d-8e9e-a97e5f59b0bd';
const key='a'.repeat(64);
const source={kind:'lorebook',name:'test'};
function harness(){let generation=2,count=5,mutation=0,deny=false,logical=key;
 const calls=[];
 const api={
  async preview(){calls.push('preview');return {ownerVerified:true,logicalKey:logical,routingGeneration:generation,recordCount:count,inventoryDigest:'stable'};},
  async backup(){calls.push('backup');return {backupId:id,logicalKey:logical,state:'VERIFIED',physicalBackupVerified:true};},
  async verify(){calls.push('verify');return {backupId:id,logicalKey:logical,integrityVerified:true};},
  async plan(_,action){calls.push('plan');return {operationId:id,backupId:id,action,executionAllowed:!deny};},
  async execute(){calls.push('execute');mutation++;return {operationId:id,state:'VERIFIED'};}
 };
 return {api,calls,mutations:()=>mutation,change:()=>generation++,deny:()=>deny=true,foreign:()=>logical='b'.repeat(64)};
}
async function prepared(h,action='delete'){
 const s=new PB4LifecycleSession({source,api:h.api});await s.inspect();await s.capture();await s.plan(action);return s;
}
test('P-B.4: fully backed up one-use delete, no implicit replay',async()=>{
 const h=harness(),s=await prepared(h);
 assert.equal(PB4_CONFIRMATIONS.delete,'DELETE OWNED COLLECTION');
 await assert.rejects(s.execute({phrase:'YES'}),/PB4_TYPED_CONFIRMATION_REQUIRED/);
 assert.equal(h.mutations(),0);
 const receipt=await s.execute({phrase:PB4_CONFIRMATIONS.delete});
 assert.equal(receipt.state,'VERIFIED');assert.equal(h.mutations(),1);
 await assert.rejects(s.execute({phrase:PB4_CONFIRMATIONS.delete}),/PB4_SELECTION_CHANGED/);
 assert.deepEqual(h.calls,['preview','preview','backup','verify','preview','verify','plan','execute']);
});
test('P-B.4: mutated collection generation blocks backup or plan',async()=>{
 const h=harness(),s=new PB4LifecycleSession({source,api:h.api});
 await s.inspect();h.change();await assert.rejects(s.capture(),/PB4_COLLECTION_CHANGED/);
 const h2=harness(),s2=new PB4LifecycleSession({source,api:h2.api});
 await s2.inspect();await s2.capture();h2.change();
 await assert.rejects(s2.plan('empty'),/PB4_COLLECTION_CHANGED/);assert.equal(h2.mutations(),0);
});
test('P-B.4: foreign backup key and disabled operation are refused',async()=>{
 const h=harness(),s=new PB4LifecycleSession({source,api:h.api});
 await s.inspect();h.foreign();await assert.rejects(s.capture(),/PB4_COLLECTION_CHANGED/);
 const h2=harness(),s2=new PB4LifecycleSession({source,api:h2.api});
 await s2.inspect();await s2.capture();h2.deny();
 await assert.rejects(s2.plan('delete'),/PB4_EXECUTION_NOT_AUTHORIZED/);assert.equal(h2.mutations(),0);
});
test('P-B.4: changing source/config, unsupported actions and no backup fail closed',async()=>{
 const h=harness(),s=new PB4LifecycleSession({source,api:h.api});
 await s.inspect();await assert.rejects(s.plan('delete'),/PB4_BACKUP_AND_INSPECTION_REQUIRED/);
 await assert.rejects(s.capture({kind:'lorebook',name:'different'}),/PB4_SELECTION_CHANGED/);
 await assert.rejects(s.capture(source,'local'),/PB4_SELECTION_CHANGED/);
 await s.capture();await assert.rejects(s.plan('purge'),/PB4_BACKUP_AND_INSPECTION_REQUIRED/);
 assert.equal(h.mutations(),0);
});
test('P-B.4: lost execution acknowledgement cannot replay the same plan',async()=>{
 const h=harness();h.api.execute=async()=>{h.calls.push('execute');throw Error('network timeout');};
 const s=await prepared(h,'empty');
 await assert.rejects(s.execute({phrase:PB4_CONFIRMATIONS.empty}),/network timeout/);
 await assert.rejects(s.execute({phrase:PB4_CONFIRMATIONS.empty}),/PB4_SELECTION_CHANGED/);
 assert.equal(h.calls.filter(x=>x==='execute').length,1);
});
test('P-B.4: failed reinspection invalidates old inventory proof',async()=>{
 const h=harness(),s=new PB4LifecycleSession({source,api:h.api});
 await s.inspect();h.api.preview=async()=>{throw Error('backend unavailable');};
 await assert.rejects(s.inspect(),/backend unavailable/);
 await assert.rejects(s.capture(),/PB4_INSPECT_FIRST/);
 assert.equal(h.mutations(),0);
});

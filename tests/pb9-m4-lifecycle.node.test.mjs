import test from 'node:test';
import assert from 'node:assert/strict';
import {PB9LifecycleSession,pb9M4Api,pb9Confirmation,PB9_BACKENDS} from '../utils/pb9-m4-lifecycle.js';
import {inspectVectorRequest} from '../utils/e02-vector-request-gateway.js';
const uuid='1f2d7534-2bb4-4f9d-8e9e-a97e5f59b0bd';
const key='a'.repeat(64),digest='b'.repeat(64);
const source={kind:'lorebook',name:'Example'};
function harness(backend='lancedb'){
 let count=5, generation=0, mode='ENABLED',executions=0,timeout=false;
 const calls=[];const api={
  async preview(){calls.push('preview');return {backend,ownerVerified:true,completePhysicalInventory:true,logicalKey:key,
   recordCount:count,inventoryDigest:digest,productionWritesEnabled:false,operationModes:{backup:'ENABLED',restore:'ENABLED',empty:'ENABLED',delete:mode},generation};},
  async backup(){calls.push('backup');return {backend,state:'VERIFIED',backupId:uuid,logicalKey:key,count,inventoryDigest:digest,physicalBackupVerified:true};},
  async verify(){calls.push('verify');return {backend,backupId:uuid,integrityVerified:true,logicalKey:key,inventoryDigest:digest,recordCount:count};},
  async plan(_backend,_source,action){calls.push('plan');return {backend,state:'PLANNED',action,operationId:uuid,backupId:uuid,logicalKey:key,recordCount:count,oneUse:true,
   expiresAt:Date.now()+300000,requiredConfirmation:pb9Confirmation(backend,action)};},
  async execute(_backend,action){calls.push('execute');executions++;if(timeout)throw Error('network timeout');return {backend,state:'VERIFIED',operationId:uuid,logicalKey:key,
   productionCertified:false,...(action==='delete'?{physicalAbsent:true,registryTombstoned:true}:{oldPhysicalRetained:true,verifiedEmpty:action==='empty'})};}
 };
 return {api,calls,mutate:()=>{count++;},denyDelete:()=>{mode='BLOCKED';}, timeout:()=>{timeout=true;},executions:()=>executions};
}
async function ready(backend='lancedb',action='empty'){
 const h=harness(backend),s=new PB9LifecycleSession({backend,source,api:h.api});
 await s.inspect();await s.capture();await s.plan(action);return {h,s};
}
test('P-B.9 M4 lifecycle uses all three source-owned backend contracts',async()=>{
 assert.deepEqual(PB9_BACKENDS,['lancedb','vectra','milvus']);
 for(const backend of PB9_BACKENDS){for(const action of ['empty','restore','delete']){
  const {h,s}=await ready(backend,action);
  await assert.rejects(s.execute({phrase:'YES'}),/PB9_TYPED_CONFIRMATION_REQUIRED/);
  const result=await s.execute({phrase:pb9Confirmation(backend,action)});
  assert.equal(result.state,'VERIFIED');assert.equal(h.executions(),1);
  await assert.rejects(s.execute({phrase:pb9Confirmation(backend,action)}),/PB9_SELECTION_CHANGED/);
  assert.deepEqual(h.calls,['preview','preview','backup','verify','preview','verify','plan','execute']);
 }}
});
test('P-B.9 physical changes invalidate backup/plan and stale evidence',async()=>{
 const h=harness(),s=new PB9LifecycleSession({backend:'lancedb',source,api:h.api});
 await s.inspect();h.mutate();await assert.rejects(s.capture(),/PB9_COLLECTION_CHANGED/);
 const h2=harness(),s2=new PB9LifecycleSession({backend:'lancedb',source,api:h2.api});
 await s2.inspect();await s2.capture();h2.mutate();
 await assert.rejects(s2.plan('restore'),/PB9_COLLECTION_CHANGED/);assert.equal(h2.executions(),0);
});
test('P-B.9 denied or changed source never dispatches deletion',async()=>{
 const h=harness('milvus'),s=new PB9LifecycleSession({backend:'milvus',source,api:h.api});
 await s.inspect();await s.capture();h.denyDelete();
 await assert.rejects(s.plan('delete'),/PB9_COLLECTION_CHANGED/);assert.equal(h.executions(),0);
 await assert.rejects(s.plan('purge'),/PB9_VERIFIED_BACKUP_REQUIRED/);
 await assert.rejects(s.plan('empty','vectra'),/PB9_SELECTION_CHANGED/);
 await assert.rejects(s.plan('empty','milvus',{kind:'lorebook',name:'Other'}),/PB9_SELECTION_CHANGED/);
});
test('P-B.9 lost acknowledgement cannot replay after dispatch',async()=>{
 const {h,s}=await ready('vectra','empty');h.timeout();
 await assert.rejects(s.execute({phrase:pb9Confirmation('vectra','empty')}),/network timeout/);
 await assert.rejects(s.execute({phrase:pb9Confirmation('vectra','empty')}),/PB9_SELECTION_CHANGED/);
 assert.equal(h.executions(),1);
});
test('P-B.9 rejects untrusted physical preview and mismatched backup',async()=>{
 const h=harness('milvus'),s=new PB9LifecycleSession({backend:'milvus',source,api:h.api});
 h.api.preview=async()=>({backend:'milvus',logicalKey:key,recordCount:5,ownerVerified:true,inventoryDigest:digest});
 await assert.rejects(s.inspect(),/PB9_PREVIEW_UNVERIFIED/);
 const h2=harness('milvus'),s2=new PB9LifecycleSession({backend:'milvus',source,api:h2.api});
 await s2.inspect();h2.api.backup=async()=>({...await h2.api.verify(),state:'VERIFIED',physicalBackupVerified:true,count:9});
 await assert.rejects(s2.capture(),/PB9_BACKUP_MISMATCH/);
});
test('P-B.9 HTTP adapter follows M4 exact routes, confirmation and rejects forged receipt',async()=>{
 for(const backend of PB9_BACKENDS){
  const prefix={lancedb:'m4a/lancedb',vectra:'m4b/vectra',milvus:'m4c/milvus'}[backend];
  const requests=[];
  const fetchMock=async(url,options)=>{
   requests.push({url,options});const body=JSON.parse(options.body);
   return {ok:true,async json(){return {success:true,backend,state:'PLANNED',operationId:uuid,backupId:uuid,
    action:'empty',logicalKey:key,recordCount:5,requiredConfirmation:pb9Confirmation(backend,'empty'),oneUse:true,expiresAt:Date.now()+99999};}};
  };
  const api=pb9M4Api(fetchMock);const p=await api.plan(backend,source,'empty',uuid,{});
  assert.equal(p.operationId,uuid);assert.match(requests[0].url,new RegExp(`/v2/${prefix}/collections/transition/plan$`));
  assert.deepEqual(Object.keys(JSON.parse(requests[0].options.body)).sort(),['action','backend','backupId','configId','source']);
  await assert.rejects(api.execute(backend,'empty',uuid,{}),/PB9_RECEIPT_UNVERIFIED/);
 }
});
test('P-B.9 E02 enforces M4 auth shape and rejects arbitrary destructive requests',()=>{
 for(const backend of PB9_BACKENDS){
  const prefix={lancedb:'m4a/lancedb',vectra:'m4b/vectra',milvus:'m4c/milvus'}[backend];
  const root='/api/plugins/similharity/v2/'+prefix;
  const request=(path,body)=>inspectVectorRequest(root+path,{method:'POST',body:JSON.stringify(body)});
  assert.equal(request('/collections/transition/plan',{backend,source,configId:'default',backupId:uuid,action:'empty'}).allowed,true);
  assert.throws(()=>request('/collections/transition/plan',{backend,source,configId:'default',backupId:uuid,action:'purge'}),/VECTHARE_E02_OPERATION_DENIED|safety gate/i);
  assert.throws(()=>request('/collections/delete/execute',{operationId:uuid,confirmation:'DELETE EVERYTHING'}),/safety gate/i);
  assert.throws(()=>request('/collections/preview',{backend,source,configId:'default',physicalName:'foreign'}),/safety gate/i);
 }
});
test('P-B.9 expired plan never dispatches and requires new planning',async()=>{
 const {h,s}=await ready('milvus','restore');s.pending.expiresAt=Date.now()-1;
 await assert.rejects(s.execute({phrase:pb9Confirmation('milvus','restore')}),/PB9_PLAN_EXPIRED/);
 assert.equal(h.executions(),0);
});
test('P-B.9 unverified deletion receipt cannot be displayed as successful',async()=>{
 const {h,s}=await ready('vectra','delete');h.api.execute=async()=>({backend:'vectra',state:'VERIFIED',operationId:uuid,logicalKey:key,productionCertified:false});
 await assert.rejects(s.execute({phrase:pb9Confirmation('vectra','delete')}),/PB9_RECEIPT_UNVERIFIED/);
 await assert.rejects(s.execute({phrase:pb9Confirmation('vectra','delete')}),/PB9_SELECTION_CHANGED/);
});

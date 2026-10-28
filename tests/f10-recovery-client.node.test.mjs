import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {inspectVectorRequest,VectorOperationDenied} from '../utils/e02-vector-request-gateway.js';
import {f10RecoveryRequest,validateF10Response,renderF10RecoveryPanel} from '../utils/f10-recovery-client.js';
const id=randomUUID(),checksum='a'.repeat(64);
const source={kind:'chat',avatar:'Nina.png',chatFile:'one'};
const embedding={source:'transformers',model:'test',dimension:3,metric:'cosine'};
const base={backend:'qdrant',source,embedding,configId:'local'};
const capture={...base,confirmCapture:'I UNDERSTAND THIS IS NOT A VERIFIED FULL BACKUP'};
const report={success:true,scopeVerified:true,captureId:id,checksum,recordCount:0,authoritativeInventory:false,
 verifiedFullBackup:false,snapshotConsistency:'UNPROVEN',migrationAllowed:false,restoreAllowed:false,productionWritesEnabled:false};
test('F10 gateway allows only scoped, explicitly acknowledged evidence request',()=>{
 for(const [op,body] of [['capture',capture],['status',{...base,captureId:id}],['download',{...base,captureId:id}]]){
  const url='/api/plugins/similharity/v2/recovery/'+op;
  assert.equal(inspectVectorRequest(url,{method:'POST',body:JSON.stringify(body)}).allowed,true);
  for(const changed of [{...body,userScopeId:'victim'}, {...body,collectionName:'legacy'},
    {...body,source:{...source,owner:'victim'}},{...body,embedding:{...embedding,apiKey:'secret'}}])
   assert.throws(()=>inspectVectorRequest(url,{method:'POST',body:JSON.stringify(changed)}),VectorOperationDenied);
  assert.throws(()=>inspectVectorRequest(url,{method:'GET'}),VectorOperationDenied);
 }
 assert.throws(()=>inspectVectorRequest('/api/plugins/similharity/v2/recovery/restore',
  {method:'POST',body:JSON.stringify(base)}),VectorOperationDenied);
});
test('F10 client rejects server claiming authoritative backup, restore and unchecked evidence',async()=>{
 let called;
 const result=await f10RecoveryRequest('capture',capture,{},async(url,opts)=>{
  called={url,opts};return {ok:true,status:200,json:async()=>report};
 });
 assert.equal(result.captureId,id);assert.equal(called.opts.credentials,'same-origin');
 for(const altered of [{authoritativeInventory:true},{verifiedFullBackup:true},{snapshotConsistency:'ATOMIC'},
   {restoreAllowed:true},{productionWritesEnabled:true},{recordCount:9999}])
  assert.throws(()=>validateF10Response('capture',{...report,...altered}),/F10_RESPONSE_OVERCLAIMS_CAPABILITIES/);
 assert.throws(()=>validateF10Response('download',{...report,captureIntegrityVerified:true,
  exportKind:'CERTIFIED_BACKUP',data:{captureId:id,records:[]}}),/F10_DOWNLOAD_INVALID/);
});
test('F10 UI renders inert controls without automatic network requests',()=>{
 const events=[];const doc={createElement:tag=>({tag,append(){},addEventListener(e){events.push(e);},setAttribute(){}})};
 const root={querySelector:()=>null,prepend(){}};
 assert.equal(renderF10RecoveryPanel(root,()=>({}),doc),true);
 assert.equal(events.filter(x=>x==='click').length,3);
});

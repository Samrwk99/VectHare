import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {inspectVectorRequest,VectorOperationDenied} from '../utils/e02-vector-request-gateway.js';
import {readSavedBrowserPage,validateSavedBrowserPage} from '../utils/pb1-saved-browser.js';
const source={kind:'chat',avatar:'alice.png',chatFile:'saved'};
const url='/api/plugins/similharity/v2/m1/records/browse';
const recordId=randomUUID();
const good={success:true,readOnly:true,sourceAuthoritative:true,inventoryKind:'SAVED_SOURCE_RECORDS',
 inventoryVerified:false,physicalInventoryComplete:false,completeSavedSource:true,
 logicalKey:'a'.repeat(64),fileFingerprint:'b'.repeat(64),registryFingerprint:'c'.repeat(64),routingGeneration:0,sourceSelectionGeneration:0,totalRecords:1,offset:0,nextCursor:null,pageComplete:true,
 records:[{recordId,physicalState:'MISSING',savedText:'hello',savedTextTruncated:false,availableActions:['insert'],revision:0}]};
const fetchResult=data=>async()=>({ok:true,status:200,async json(){return data;}});
test('P-B browser validates strictly scoped read route, refuses raw or unverified scope',()=>{
 const allowed=payload=>inspectVectorRequest(url,{method:'POST',body:JSON.stringify(payload)});
 assert.equal(allowed({backend:'qdrant',source,verifyPhysical:true}).allowed,true);
 for(const extra of [{ownerId:'another'},{physicalName:'foreign'},{vector:[1,2]},{offset:50},{verifyPhysical:false},{source:{...source,ownerId:'another'}}]){
  const payload={backend:'qdrant',source,verifyPhysical:true,...extra};
  assert.throws(()=>allowed(payload),VectorOperationDenied);
 }
 assert.throws(()=>allowed({backend:'milvus',configId:'local',source,verifyPhysical:true}),VectorOperationDenied);
});
test('P-B saved-source browser rejects false full-inventory claims and cross-page shape contradictions',()=>{
 assert.equal(validateSavedBrowserPage(good).records[0].savedText,'hello');
 for(const changed of [
  {inventoryVerified:true},{physicalInventoryComplete:true},{completeSavedSource:false},
  {registryFingerprint:'forged'},{routingGeneration:-1},{sourceSelectionGeneration:-2},
  {sourceAuthoritative:false},{readOnly:false},{nextCursor:'broken',pageComplete:false},
  {totalRecords:0},{records:[{...good.records[0],physicalState:'unknown'}]},
  {records:[good.records[0],good.records[0]],totalRecords:2},
  {records:[{...good.records[0],savedText:'x'.repeat(8200)}]}
 ])assert.throws(()=>validateSavedBrowserPage({...good,...changed}),/PB1_BROWSER_/);
});
test('P-B browser always requests server physical verification; never accepts a browser supplied physical name',async()=>{
 let body;
 const fetched=async(url,options)=>{body=JSON.parse(options.body);return fetchResult(good)(url,options);};
 const read=await readSavedBrowserPage({backend:'qdrant',source,headers:{'x-test':'1'},fetchImpl:fetched});
 assert.equal(read.records[0].recordId,recordId);
 assert.deepEqual(Object.keys(body).sort(),['backend','configId','source','verifyPhysical']);
 assert.equal(body.verifyPhysical,true);
 await assert.rejects(()=>readSavedBrowserPage({backend:'milvus',source,configId:'local',fetchImpl:fetched}),/PB1_BROWSER_SELECTOR_INVALID/);
});

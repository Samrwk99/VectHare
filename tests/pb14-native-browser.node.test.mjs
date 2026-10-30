import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inspectVectorRequest} from '../utils/e02-vector-request-gateway.js';
import {readPB14NativePage,validatePB14NativePage,PB14_URL} from '../utils/pb14-native-browser.js';
const K='a'.repeat(64),source={kind:'chat',avatar:'av.png',chatFile:'chat.jsonl'};
const record={recordId:'00000000-0000-4000-8000-000000000010',revision:1,textHash:K,
 metadataHash:K,textPreview:'ok',textTruncated:false,metadataKeys:[]};
const page={success:true,readOnly:true,backend:'qdrant',inventoryKind:'SCOPED_NATIVE_PHYSICAL_PAGE',
 inventoryVerified:false,physicalInventoryComplete:false,ownerVerified:false,
 scopeVerified:true,recordsVerified:true,consistency:'UNVERIFIED_BETWEEN_PAGES',
 logicalKey:K,routingGeneration:0,sourceFingerprint:K,registryFingerprint:K,
 records:[record],pageSize:50,examined:1,pageComplete:true,nextCursor:null,totalRecords:null};
test('gateway allows only narrowly source-scoped Qdrant page reader',()=>{
 const make=(b,method='POST')=>({method,body:JSON.stringify(b)});
 const base={backend:'qdrant',source};
 assert.equal(inspectVectorRequest(PB14_URL,make(base)).allowed,true);
 for(const changes of [{backend:'milvus'},{owner:'other'},{physicalName:'evil'},
  {vector:[1,2]},{cursor:'bad'},{source:{kind:'chat',avatar:'av.png',chatFile:'chat.jsonl',arbitrary:true}},
  {configId:'user-target'}])
  assert.throws(()=>inspectVectorRequest(PB14_URL,make({...base,...changes})),/denied/i);
 assert.throws(()=>inspectVectorRequest(PB14_URL,make(base,'GET')),/denied/i);
});
test('native validator refuses any invented completeness or excess record claims',()=>{
 assert.equal(validatePB14NativePage(page).examined,1);
 for(const bad of [{inventoryVerified:true},{physicalInventoryComplete:true},{ownerVerified:true},
  {consistency:'VERIFIED'},{pageSize:100},{totalRecords:1},{records:Array(51).fill(record)},
  {nextCursor:'bad'},{pageComplete:false},{examined:0},{sourceFingerprint:'wrong'}])
   assert.throws(()=>validatePB14NativePage({...page,...bad}),/PB14_NATIVE_PAGE_UNVERIFIED/);
});
test('client performs gateway checked no-store read without physical names',async()=>{
 let seen;
 const fetchImpl=async(u,opt)=>{seen={u,options:JSON.parse(opt.body)};return {ok:true,json:async()=>page};};
 const result=await readPB14NativePage({source,fetchImpl});
 assert.equal(result.inventoryVerified,false);assert.equal(seen.u,PB14_URL);
 assert.deepEqual(Object.keys(seen.options).sort(),['backend','configId','source']);
});

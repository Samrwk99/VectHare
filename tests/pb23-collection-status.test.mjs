import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {CollectionRegistry} from '../lib/s02-registry.js';
import {collectionIdentity} from '../lib/s02-identity.js';
import {inspectPB23CollectionStatus} from '../lib/pb23-collection-status.js';
import {registerF03ProvisionRoutes} from '../lib/f03-provision.js';
const scope={userScopeId:'alice',collectionId:'test',type:'chat',sourceId:'saved-chat'};
const body={backend:'qdrant',source:{kind:'chat',avatar:'a.png',chatFile:'test'},
 embedding:{source:'transformers',model:'test',dimension:3,metric:'cosine'},configId:'local'};
const id=collectionIdentity({backend:body.backend,scope,embedding:body.embedding});
async function fixture(run){const root=await fs.mkdtemp(path.join(os.tmpdir(),'pb23-'));
 try{await fs.chmod(root,0o700);const ctx={userScopeId:'alice',vectorsPath:root};
  const req={s03:ctx,user:{directories:{root}},body};
  const registry=new CollectionRegistry(path.join(root,'.similharity'));
  const opts={registry,attest:async()=>({status:'HOST_FILE_OWNED',hostSourceOwnerVerified:true,scope}),
   resolve:async()=>({logicalKey:id.key,physicalName:id.physicalName,generation:2}),
   receipt:async()=>({state:'SCHEMA_VERIFIED_OFFLINE_UNCERTIFIED',code:null})};
  await run({req,registry,opts});
 }finally{await fs.rm(root,{recursive:true,force:true});}}
test('P22 source-owned status distinguishes absent S02 binding from an empty physical collection',()=>fixture(async({req,opts})=>{
 const result=await inspectPB23CollectionStatus(req,body,opts);
 assert.equal(result.collectionState,'UNPROVISIONED');assert.equal(result.routingGeneration,null);
 assert.equal(result.physicalPresenceVerified,false);assert.equal(result.inventoryVerified,false);
 assert.equal(result.physicalCollectionProvisioned,false);
}));
test('P22 durable reservation and published generation report routing but not physical proof',()=>fixture(async({req,registry,opts})=>{
 await registry.reserve(id);
 const result=await inspectPB23CollectionStatus(req,body,opts);
 assert.equal(result.collectionState,'SCHEMA_RECEIPT_ONLY');assert.equal(result.routingGeneration,2);
 assert.equal(result.receiptState,'SCHEMA_VERIFIED_OFFLINE_UNCERTIFIED');
 assert.equal(result.physicalCollectionProvisioned,false);assert.equal(result.physicalPresenceVerified,false);
}));
test('P22 deleted S02 binding is explicitly tombstoned without claiming physical absence',()=>fixture(async({req,registry,opts})=>{
 await registry.reserve(id);
 await registry.tombstone(id,{operationId:randomUUID(),backupId:randomUUID(),physicalAbsent:true});
 const result=await inspectPB23CollectionStatus(req,body,{...opts,receipt:async()=>{throw Error('deleted receipt should not be read');}});
 assert.equal(result.collectionState,'DELETED_TOMBSTONED');assert.equal(result.physicalPresenceVerified,false);
 assert.equal(result.routingGeneration,null);
}));
test('P22 read-only status refuses foreign owner, untrusted journal and missing host',()=>fixture(async({req,registry,opts})=>{
 await registry.reserve(id);
 await assert.rejects(()=>inspectPB23CollectionStatus(req,body,{...opts,
  attest:async()=>({status:'HOST_FILE_OWNED',hostSourceOwnerVerified:true,scope:{...scope,userScopeId:'bob'}})}),e=>e.code==='PB23_SOURCE_UNVERIFIED');
 await assert.rejects(()=>inspectPB23CollectionStatus(req,body,{...opts,
  resolve:async()=>{throw Object.assign(Error('pending'),{code:'M3_JOURNAL_TRANSITION_REVIEW_REQUIRED'});}}),e=>e.code==='M3_JOURNAL_TRANSITION_REVIEW_REQUIRED');
 await assert.rejects(()=>inspectPB23CollectionStatus({...req,user:null},body,opts),e=>e.code==='PB23_HOST_AUTH_REQUIRED');
}));
test('P22 status distinguishes missing, incomplete and uncertain provisioning receipts',()=>fixture(async({req,registry,opts})=>{
 await registry.reserve(id);
 const noReceipt=await inspectPB23CollectionStatus(req,body,{...opts,receipt:async()=>null});
 assert.equal(noReceipt.collectionState,'RESERVED_NO_RECEIPT');
 for(const state of ['PREPARED','UNCERTAIN']){
  const status=await inspectPB23CollectionStatus(req,body,{...opts,receipt:async()=>({state,code:'REVIEW_REQUIRED'})});
  assert.equal(status.collectionState,'PROVISION_UNCERTAIN');assert.equal(status.receiptCode,'REVIEW_REQUIRED');
 }
}));
test('P22 existing status route returns S02 state with no new endpoint or backend dispatch',()=>fixture(async({req,registry,opts})=>{
 await registry.reserve(id);
 const handlers=new Map(),router={post:(route,fn)=>handlers.set(route,fn)};
 let usedBackend=0;
 registerF03ProvisionRoutes(router,{backendPool:{get:async()=>{usedBackend++;throw Error('not needed');}},
  sourceStatus:async(request,selector)=>inspectPB23CollectionStatus(request,selector,opts)});
 const res={statusCode:200,status(n){this.statusCode=n;return this;},json(value){this.body=value;return this;}};
 await handlers.get('/v2/collections/status')(req,res);
 assert.equal(res.statusCode,200);assert.equal(res.body.success,true);
 assert.equal(res.body.collectionState,'SCHEMA_RECEIPT_ONLY');assert.equal(usedBackend,0);
}));

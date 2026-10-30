import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {auditManagedSavedSource,verifyQdrantPhysicalProof} from '../utils/pb2-authoritative-audit.js';
const page=(n,offset,total,patch={})=>({success:true,readOnly:true,sourceAuthoritative:true,
 inventoryKind:'SAVED_SOURCE_RECORDS',completeSavedSource:true,inventoryVerified:false,
 physicalInventoryComplete:false,backend:'qdrant',sourceKind:'chat',logicalKey:'a'.repeat(64),
 fileFingerprint:'b'.repeat(64),registryFingerprint:'c'.repeat(64),routingGeneration:3,
 sourceSelectionGeneration:1,orphanReview:2,totalRecords:total,offset,
 records:n.map(id=>({recordId:id,physicalState:'VERIFIED'})),
 pageComplete:offset+n.length===total,nextCursor:offset+n.length===total?null:`YXNk.${offset+n.length}`,...patch});
const ids=n=>Array.from({length:n},()=>randomUUID());
test('P-B.2 traverses 111 saved records across signed pages; never certifies full physical inventory',async()=>{
 const rows=ids(111);const responses=[page(rows.slice(0,50),0,111),page(rows.slice(50,100),50,111),page(rows.slice(100),100,111),page(rows.slice(0,50),0,111)];
 let progress=0;const audit=await auditManagedSavedSource({readPage:async cursor=>{
  assert.equal(cursor,[null,'YXNk.50','YXNk.100',null][progress]);return responses[progress++];},onPage:({examined})=>assert.ok(examined<=111)});
 assert.equal(progress,4);assert.equal(audit.examined,111);assert.equal(audit.physicallyVerified,111);
 assert.equal(audit.inventoryVerified,false);assert.equal(audit.physicalInventoryComplete,false);
 assert.equal(audit.orphanReview,2);
});
test('P-B.2 a genuinely provisioned zero record source is successful (not an unknown absent binding)',async()=>{
 const report=await auditManagedSavedSource({readPage:async()=>page([],0,0)});
 assert.equal(report.total,0);assert.equal(report.examined,0);
});
test('P-B.2 rejects stale registry, generation, wrong totals, cursor replay and duplicate IDs',async()=>{
 const rows=ids(51),first=page(rows.slice(0,50),0,51),last=page(rows.slice(50),50,51);
 for(const broken of [{registryFingerprint:'f'.repeat(64)},{routingGeneration:7},
  {sourceSelectionGeneration:2},{totalRecords:52},{offset:49},{pageComplete:false,nextCursor:'YXNk.50'},
  {records:[rows[0]],offset:50}]){
  let step=0;await assert.rejects(auditManagedSavedSource({readPage:async()=>step++?{...last,...broken}:first}),/PB2_AUDIT_/);
 }
 await assert.rejects(auditManagedSavedSource({readPage:async()=>page(ids(51).slice(0,50),0,51),maxRows:50}),/EXPLICIT_ROW_LIMIT/);
});
test('P-B.2 final attestation rejects a source change after last page',async()=>{
 const rows=ids(1);let calls=0;
 await assert.rejects(auditManagedSavedSource({readPage:async()=>++calls===1?page(rows,0,1):page(rows,0,1,{fileFingerprint:'d'.repeat(64)})}),/PB2_AUDIT_CHANGED_DURING_FINAL_ATTESTATION/);
});
test('P-B.2 cancellation during await prevents stale-source UI result',async()=>{
 let active=true;
 await assert.rejects(auditManagedSavedSource({readPage:async()=>{active=false;return page([],0,0);},shouldContinue:()=>active}),/CANCELLED/);
});
const proof={success:true,backend:'qdrant',inventoryVerified:true,managedV2Only:true,
 entirePhysicalCollectionVerified:true,exclusiveOwner:true,readOnly:true,
 legacySharedCollectionsVerified:false,repairAuthorized:false,deleteAuthorized:false,
 productionCertified:false,logicalKey:'a'.repeat(64),inventoryDigest:'d'.repeat(64),
 recordCount:20,uniqueContentHashCount:18,repeatedContentHashGroups:2,
 repeatedContentHashExtraRecords:2,routingGeneration:1};
test('P-B.2 physical Qdrant proof is a distinct read-only exclusive inventory',()=>{
 assert.equal(verifyQdrantPhysicalProof(proof).recordCount,20);
 for(const violation of [{deleteAuthorized:true},{readOnly:false},{inventoryVerified:false},
  {legacySharedCollectionsVerified:true},{recordCount:21},{rows:[]},{physicalName:'forged'}])
  assert.throws(()=>verifyQdrantPhysicalProof({...proof,...violation}),/PB2_QDRANT_PHYSICAL_PROOF_UNVERIFIED/);
});
test('P-B.2 physical read endpoint is gateway-whitelisted but cannot smuggle owner, rows or vector writes',async()=>{
 const {inspectVectorRequest}=await import('../utils/e02-vector-request-gateway.js');
 const url='/api/plugins/similharity/v2/m3/collections/managed-inventory';
 const valid={backend:'qdrant',source:{kind:'chat',avatar:'test.png',chatFile:'saved'},configId:'default'};
 assert.equal(inspectVectorRequest(url,{method:'POST',body:JSON.stringify(valid)}).allowed,true);
 for(const payload of [{...valid,physicalName:'other'}, {...valid,source:{...valid.source,ownerId:'other'}},
  {...valid,rows:[]}, {...valid,vector:[0.3]}, {...valid,backend:'milvus'}])
  assert.throws(()=>inspectVectorRequest(url,{method:'POST',body:JSON.stringify(payload)}));
});

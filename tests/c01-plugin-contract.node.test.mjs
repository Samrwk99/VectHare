import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {hasVerifiedCapability} from '../utils/backend-contracts.js';
const manifest=JSON.parse(await readFile(new URL('./contracts/similharity-plugin-c01-source.json',import.meta.url),'utf8'));
test('C01 plugin source review never promotes source observations to deployed capability flags',()=>{
 assert.equal(manifest.deployedVersionVerified,false);
 assert.equal(manifest.noLiveDeletionAuthorized,true);
 assert.equal(manifest.capabilityDecision,'not-authorized');
 for(const b of ['standard','lancedb','qdrant','milvus']) {
  assert.notEqual(manifest.backendDeletion[b].status,'verified');
  for(const flag of ['purgeAcknowledgement','completeInventory','tenantFilter','count'])
   assert.equal(hasVerifiedCapability(b,flag),false,`${b}:${flag}`);
 }
});
test('C01 plugin source review records shared collection destructive and false-empty hazards',()=>{
 assert.equal(manifest.backendDeletion.qdrant.status,'unsafe');
 assert.equal(manifest.backendDeletion.milvus.status,'unsafe');
 assert.match(manifest.inventory.qdrant,/empty array/);
 assert.match(manifest.inventory.milvus,/empty array/);
 assert.notEqual(manifest.declaredPackageVersion,manifest.declaredRuntimeVersion);
});

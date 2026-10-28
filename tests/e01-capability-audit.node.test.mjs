import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyE01} from '../tools/e01-verify.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const json=f=>JSON.parse(fs.readFileSync(path.join(root,'docs/e01',f),'utf8'));

test('E01 audit has covered plugin and native vector requests',()=>{
 const result=verifyE01();
 assert.equal(result.pass,true);
 assert.equal(result.cells,80);
 assert.ok(result.routeEdges>=90);
});
test('E01 source-only statuses grant no new mutating permission',()=>{
 const {backends}=json('capability-matrix.json');
 for(const matrix of Object.values(backends)){
  for(const op of ['insert','delete','purge','purgeAll','patchText','patchMetadata'])
   assert.equal(matrix[op].effectiveMutationPermission,false);
 }
});
test('No backend pretends source-only verification is a live contract probe',()=>{
 const {backends}=json('capability-matrix.json');
 for(const matrix of Object.values(backends)){
  for(const cell of Object.values(matrix))assert.deepEqual(cell.liveProbeEvidence,[]);
 }
});
test('Qdrant and Milvus write/deletion risks remain denied',()=>{
 const {backends}=json('capability-matrix.json');
 for(const b of ['qdrant','milvus'])for(const op of ['insert','delete','purge','patchText','patchMetadata'])assert.equal(backends[b][op].status,'DENIED');
});

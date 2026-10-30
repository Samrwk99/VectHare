import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isBlockedM0Path} from '../lib/m0-write-boundary.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
// POST sometimes represents read/preview; adding a new literal route requires
// a deliberate classification rather than silently granting a write bypass.
const readonly=new Set([
 '/v2/m4c/milvus/collections/preview','/v2/m4c/milvus/backups/create',
 '/v2/m4c/milvus/collections/delete/plan',
 '/v2/m4c/milvus/collections/transition/plan',
 '/v2/m4b/vectra/collections/preview','/v2/m4b/vectra/backups/create',
 '/v2/m4b/vectra/collections/delete/plan','/v2/m4b/vectra/collections/transition/plan',
 '/v2/m4a/lancedb/collections/preview','/v2/m4a/lancedb/backups/create',
 '/v2/m4a/lancedb/collections/delete/plan', '/v2/m4a/lancedb/collections/transition/plan',
 '/v2/m2/jobs/preview','/v2/m3/collections/rebuild/source-profile','/v2/m3/collections/rebuild/activation-plan','/v2/m3/collections/rebuild/stage-plan','/v2/m3/collections/preview','/v2/m3/collections/managed-inventory','/v2/m3/collections/rebuild/preview','/v2/m3/backups/create',
 '/v2/sources/attest','/v2/workflows/chat-sync-plan','/v2/workflows/preview',
 '/v2/workflows/retrieve','/v2/m1/records/preview','/v2/m1/collections/prepare','/v2/reads/preflight','/v2/operations/preflight',
 '/v2/recovery/capture','/v2/recovery/status','/v2/recovery/download',
 '/v2/workflows/link-condition-preview','/v2/collections/preview','/v2/collections/status',
 '/v2/reads/bind','/v2/embeddings/test','/v2/identity/resolve',
 '/get-embedding','/batch-embeddings','/backend/init/:backend','/chunks/list',
 '/chunks/query','/chunks/hybrid-query','/chunks/stats'
]);
const explicitlyDenied=new Set([
 '/v2/operations/submit','/v2/operations/reconcile','/open-folder','/rerank',
 '/v2/mutations/execute','/v2/m1/collections/provision'
]);
const guarded=new Set(['/v2/m4c/milvus/collections/transition/execute','/v2/m4c/milvus/collections/delete/execute','/v2/m4b/vectra/collections/delete/execute','/v2/m4b/vectra/collections/transition/execute','/v2/m4a/lancedb/collections/transition/execute','/v2/m4a/lancedb/collections/delete/execute','/v2/m3/collections/rebuild/activation-execute','/v2/m3/collections/rebuild/stage-execute','/v2/m3/collections/execute','/v2/m3/operations/:operationId/quarantine-terminal','/v2/m3/operations/:operationId/quarantine-proven','/v2/m3/collections/rebuild/continue/:operationId','/v2/m3/operations/:operationId/abandon']);
const planned=new Set(['/v2/m3/collections/rebuild/preparation/:operationId/step',
 '/v2/embeddings/staged-profile','/v2/m3/collections/rollback/plan','/v2/collections/:logicalKey/records/plan','/v2/m3/collections/plan',
 '/v2/m2/jobs/create','/v2/m2/jobs/:jobId/resume','/v2/m2/jobs/:jobId/pause',
 '/v2/m2/jobs/:jobId/cancel','/v2/m2/jobs/:jobId/step','/v2/m2/jobs/:jobId/review']);
const dynamicallyRegistered=new Set(['f09-workflows.js','s05-routes.js','s10-contracts.js']);
test('M0.1 all literal HTTP mutation methods are inventoried and gated or read-only',async()=>{
 const files=['index.js',...(await fs.readdir(path.join(root,'lib'))).filter(f=>f.endsWith('.js')).map(f=>`lib/${f}`)];
 let seen=0;
 for(const file of files){
  const src=await fs.readFile(path.join(root,file),'utf8');
  const re=/router\.(post|put|patch|delete)\(\s*(['"`])([^'"`]+)\2/g;
  for(const match of src.matchAll(re)){
   const method=match[1].toUpperCase(),route=match[3];
   assert.ok(route.startsWith('/'),`${file} nonliteral or suspicious route: ${route}`);
   const matchPath=route.replace(':backend','qdrant').replace(':logicalKey','a'.repeat(64));
   assert.ok(isBlockedM0Path(method,matchPath)||readonly.has(route)||
     explicitlyDenied.has(route)||guarded.has(route)||planned.has(route),
     `${file} ${method} ${route} has no M0 classification`);
   seen++;
  }
  for(const match of src.matchAll(/router\.(post|put|patch|delete)\(\s*(?!['"`])/g)){
   assert.ok(dynamicallyRegistered.has(path.basename(file)),`${file} has dynamic unreviewed mutation route`);
  }
 }
 assert.ok(seen>=36,`too few inventoried routes: ${seen}`);
 const main=await fs.readFile(path.join(root,'index.js'),'utf8');
 assert.ok(main.indexOf('router.use(s01MutationGuard)')<main.indexOf('router.use(m0WriteBoundary)'));
 assert.ok(main.indexOf('router.use(m0WriteBoundary)')<main.indexOf("router.post('/chunks/insert'"));
 assert.ok(main.indexOf('router.use(m0WriteBoundary)')<main.indexOf('registerF04PilotRoutes(router'));
});

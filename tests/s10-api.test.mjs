import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {calculateSourceManifest,loadS10Build,runtimeSourceFiles} from '../lib/s10-build.js';
import {S10Capabilities,S10Contracts,registerS10Routes} from '../lib/s10-contracts.js';
import {s01MutationGuard} from '../lib/s01-safety.js';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const respond=()=>({statusCode:200,payload:null,status(n){this.statusCode=n;return this;},json(v){this.payload=v;return this;}});
async function fixture(fn) {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'s10-manifest-'));
 try{
   await fs.mkdir(path.join(dir,'lib'));
   for(const f of ['index.js','qdrant-backend.js','milvus-backend.js','lancedb-backend.js'])await fs.writeFile(path.join(dir,f),'export const x=1;\n');
   await fs.writeFile(path.join(dir,'lib','helper.js'),'export const y=2;\n');
   await fs.writeFile(path.join(dir,'package.json'),JSON.stringify({version:'3.2.10-s10.1'}));
   async function seal(){await fs.writeFile(path.join(dir,'S10-BUILD-MANIFEST.json'),JSON.stringify(await calculateSourceManifest(dir)));}
   await seal(); await fn({dir,seal});
 }finally{await fs.rm(dir,{recursive:true,force:true});}
}
test('S10 packaged executable fingerprint matches generated manifest and live package version',async()=>{
 const build=await loadS10Build(ROOT,'3.2.10-s10.8-f04');
 assert.equal(build.verification,'MATCHED_LOCAL_SOURCE_MANIFEST');
 assert.equal(build.deploymentAttested,false);
 assert.equal(build.liveBackendsCertified,false);
 assert.match(build.fingerprint,/^[0-9a-f]{64}$/);
 assert.ok(build.sourceFiles>=25);
 const calc=await calculateSourceManifest(ROOT);
 assert.equal(build.fingerprint,calc.sourceFingerprint);
 assert.equal(Object.keys(calc.files).length,(await runtimeSourceFiles(ROOT)).length);
});
test('S10 refuses modified executable source and does not accept version-only equality',async()=>fixture(async({dir})=>{
 await loadS10Build(dir,'3.2.10-s10.1');
 await fs.writeFile(path.join(dir,'lib','helper.js'),'export const y=99;\n');
 await assert.rejects(()=>loadS10Build(dir,'3.2.10-s10.1'),/S10_BUILD_SOURCE_MISMATCH/);
}));
test('S10 refuses an unexpected executable file, and cannot be bypassed by deleting a file',async()=>fixture(async({dir})=>{
 await fs.writeFile(path.join(dir,'lib','new-handler.js'),'export const leaked=3;');
 await assert.rejects(()=>loadS10Build(dir),/S10_BUILD_SOURCE_MISMATCH/);
 await fs.rm(path.join(dir,'lib','new-handler.js'));
 await fs.rm(path.join(dir,'lib','helper.js'));
 await assert.rejects(()=>loadS10Build(dir),/S10_BUILD_SOURCE_MISMATCH/);
}));
test('S10 rejects altered package, incompatible declared version or damaged manifest',async()=>fixture(async({dir,seal})=>{
 await assert.rejects(()=>loadS10Build(dir,'3.2.9-s09.0'),/S10_VERSION_MISMATCH/);
 await fs.writeFile(path.join(dir,'package.json'),JSON.stringify({version:'1.0.0'}));
 await assert.rejects(()=>loadS10Build(dir),/S10_BUILD_SOURCE_MISMATCH/);
 await seal();
 await fs.writeFile(path.join(dir,'S10-BUILD-MANIFEST.json'),'{}');
 await assert.rejects(()=>loadS10Build(dir),/S10_BUILD_SOURCE_MISMATCH/);
}));
test('S10 refuses symlinked executable files and symlinked manifest',async()=>fixture(async({dir,seal})=>{
 await fs.symlink(path.join(dir,'lib','helper.js'),path.join(dir,'lib','shadow.js'));
 await assert.rejects(()=>calculateSourceManifest(dir),/S10_SOURCE_SYMLINK/);
 await fs.rm(path.join(dir,'lib','shadow.js'));
 await fs.rename(path.join(dir,'S10-BUILD-MANIFEST.json'),path.join(dir,'manifest-copy.json'));
 await fs.symlink(path.join(dir,'manifest-copy.json'),path.join(dir,'S10-BUILD-MANIFEST.json'));
 await assert.rejects(()=>loadS10Build(dir),/S10_MANIFEST_INVALID/);
}));
test('S10 capability matrix never advertises an unproven backend mutation or native Standard',async()=>{
 const b=await loadS10Build(ROOT);
 const caps=S10Capabilities(b);
 assert.equal(caps.contractVersion,2);assert.equal(caps.productionCertified,false);
 assert.equal(caps.capabilityClaimsArePermissions,false);
 assert.equal(caps.sourceFingerprint,b.fingerprint);
 for(const name of ['standard','lancedb','qdrant','milvus']){
  const entry=caps.backends[name];
  for(const op of ['insert','updateText','updateMetadata','delete','scopedClear','verifiedInventory','verifiedExport','migrationCutover']) {
    assert.equal(entry.operations[op],'DENIED_NOT_LIVE_CERTIFIED',`${name}.${op}`);
  }
  assert.equal(entry.backendAcceptance,'UNPROBED');
 }
 assert.equal(caps.backends.standard.transport,'PLUGIN_VECTRA_NOT_NATIVE_SILLYTAVERN_STANDARD');
});
test('S10 route contracts give stable, authenticated inspection and explicit denied mutation endpoints',async()=>{
 const build=await loadS10Build(ROOT);
 const routes=new Map(),router={get:(p,f)=>routes.set('GET '+p,f),post:(p,f)=>routes.set('POST '+p,f)};
 registerS10Routes(router,build);
 for(const endpoint of ['/capabilities','/v2/capabilities','/v2/contracts','/v2/build']) {
  const res=respond();routes.get(`GET ${endpoint}`)({s03:{userScopeId:'alice'}},res);
  assert.equal(res.statusCode,200);assert.ok(res.payload);
 }
 assert.equal(S10Contracts().routes['POST /v2/records/insert'],'DENIED');
 for(const url of ['/v2/records/insert','/v2/records/update','/v2/records/delete','/v2/collections/clear','/v2/collections/migrate','/v2/operations/execute']){
  const r=respond();routes.get(`POST ${url}`)({s03:{userScopeId:'alice'},body:{authorized:true,liveCertified:true}},r);
  assert.equal(r.statusCode,409);assert.equal(r.payload.code,'S10_OPERATION_NOT_CERTIFIED');
  assert.equal(r.payload.executionAllowed,false);
 }
});
test('S10 future PUT/PATCH/DELETE legacy chunk paths fail closed without dispatch',()=>{
 for(const method of ['PUT','PATCH','DELETE'])for(const endpoint of ['/chunks/test','/chunks/test/metadata','/purge-all']){
  const res=respond();let next=false;
  s01MutationGuard({method,path:endpoint},res,()=>{next=true});
  assert.equal(next,false);assert.equal(res.statusCode,409);
  assert.equal(res.payload.code,'S01_MUTATION_BLOCKED');
 }
});

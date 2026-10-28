/** E05 static release assertions; no backend mutation or proof fabrication. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {E02_MATRIX_STATUS} from '../utils/e02-matrix-status.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=f=>fs.readFileSync(path.join(root,f),'utf8');
const checks={
  standardPreflight:()=>assert.match(read('backends/standard.js'),/validateWriteBatch\(items,\{backend:'standard'\}\)/),
  lancePreflight:()=>assert.match(read('backends/lancedb.js'),/validateWriteBatch\(items,\{backend:BACKEND_TYPE\}\)/),
  lanceIdentity:()=>assert.match(read('backends/lancedb.js'),/verifyWriteIdentity\(/),
  lanceDoubleSweep:()=>assert.match(read('backends/lancedb.js'),/collectVerifiedInventory\(/),
  noBlindNativeWrite:()=>assert.match(read('utils/e02-vector-request-gateway.js'),/native-mutation-contract-unprobed/),
  deniedUnsafeMutations:()=>{
    for(const backend of ['standard','lancedb','qdrant','milvus'])
      for(const op of ['insert','delete','purge','purgeAll','patchText','patchMetadata'])
        assert.ok(['DENIED','UNPROBED'].includes(E02_MATRIX_STATUS[backend][op]));
  },
  noPluginPatchShipped:()=>{
    for(const f of ['qdrant-backend.js','milvus-backend.js','lancedb-backend.js'])
      assert.ok(!fs.existsSync(path.join(root,f)));
  },
  noProbeAutoActivation:()=>assert.doesNotMatch(read('utils/e02-vector-request-gateway.js'),/runDisposableProbe/),
  noProbePurge:()=>assert.doesNotMatch(read('tools/e05-disposable-probe.mjs'),/request\(\s*['"]\/(?:purge-all|chunks\/purge)/),
  probeRequiresDisposable:()=>assert.match(read('tools/e05-disposable-probe.mjs'),/VECTHARE_PROBE_DISPOSABLE/),
  probeLocalOnly:()=>assert.match(read('tools/e05-disposable-probe.mjs'),/localhost','127\.0\.0\.1'/),
  probeReadback:()=>assert.match(read('tools/e05-disposable-probe.mjs'),/verifyInsertedPoint\(item,exact\.chunk\)/),
  noAckCountsAsProof:()=>assert.match(read('utils/e05-verified-write-contract.js'),/collectVerifiedInventory\(listPage\)/),
  journalMustReread:()=>assert.match(read('utils/e05-verified-write-contract.js'),/journal\.get\(op\.operationId\)/),
  noAutoretry:()=>assert.doesNotMatch(read('utils/e05-verified-write-contract.js'),/retry\(/),
  explicitUncertified:()=>assert.match(read('E05-CHECKLIST.md'),/NOT COMPLETE — live host probe/),
};
const result={checkpoint:'E05',offlineOnly:true,checks:{}};
for(const [name,fn] of Object.entries(checks)){
 try{fn();result.checks[name]=true;}catch(error){result.checks[name]=String(error.message);}
}
result.pass=Object.values(result.checks).every(x=>x===true);
console.log(JSON.stringify(result,null,2));
if(!result.pass)process.exitCode=1;

/** Offline static gates for E06; independent of external plugin deployment. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {E02_MATRIX_STATUS} from '../utils/e02-matrix-status.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const file=p=>fs.readFileSync(path.join(root,p),'utf8');
const checks={
  unchangedE02MutationGate:()=>{
    for(const b of ['qdrant','milvus'])for(const op of ['insert','delete','purge','purgeAll','patchText','patchMetadata'])
      assert.equal(E02_MATRIX_STATUS[b][op],'DENIED');
  },
  strictMilvusTenantIdentity:()=>assert.match(file('backends/milvus.js'),/sharedTenantFromCollection\(collectionId, BACKEND_TYPE/),
  milvusQueryOwner:()=>assert.match(file('backends/milvus.js'),/assertSharedReadOwnership\(requireQueryItems\(data, 'milvus'/),
  milvusHybridOwner:()=>assert.match(file('backends/milvus.js'),/assertSharedReadOwnership\(requireQueryItems\(data, 'Milvus hybrid'/),
  milvusListOwner:()=>assert.match(file('backends/milvus.js'),/markSharedDisplayPage\(data, \{type, sourceId\}, BACKEND_TYPE\)/),
  qdrantListOwner:()=>assert.match(file('backends/qdrant.js'),/markSharedDisplayPage\(data, body\.filters, BACKEND_TYPE\)/),
  sharedHashInventoryRefused:()=>{
    for(const b of ['qdrant','milvus'])assert.match(file(`backends/${b}.js`),/denyUnverifiedSharedInventory\(BACKEND_TYPE\)/);
  },
  noPluginPatch:()=>['qdrant-backend.js','milvus-backend.js','lancedb-backend.js'].forEach(x=>assert.ok(!fs.existsSync(path.join(root,x)))),
  noPurgeFeature:()=>assert.match(file('utils/e02-vector-request-gateway.js'),/matrix-\$\{status\.toLowerCase\(\)\}/),
};
const out={checkpoint:'E06',pluginModified:false,liveProbes:false,checks:{}};
for(const [name,fn] of Object.entries(checks)){try{fn();out.checks[name]=true;}catch(e){out.checks[name]=String(e.message);}}
out.pass=Object.values(out.checks).every(Boolean)&&Object.values(out.checks).every(x=>x===true);
console.log(JSON.stringify(out,null,2)); if(!out.pass)process.exitCode=1;

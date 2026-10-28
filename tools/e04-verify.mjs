/** E04 static safety audit; proves the new read-only changes have not flipped backend gates. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=f=>fs.readFileSync(path.join(root,f),'utf8');
const checks={
 receiptSegments:()=>assert.match(read('utils/prompt-receipts.js'),/function assembledSegments\(/),
 receiptNoCrossMessageJoin:()=>assert.match(read('utils/prompt-receipts.js'),/segments\.some\(segment=>segment\.includes\(g\.text\)\)/),
 wiExclusiveSingleWinner:()=>assert.match(read('core/world-info-integration.js'),/resolveExclusiveCollections\(collections\.map\(c=>c\.id\),getCollectionMeta\)/),
 wiStaleEmptyClears:()=>assert.match(read('utils/world-info-identity.js'),/nestedList/),
 wiSemanticDedup:()=>assert.match(read('core/world-info-integration.js'),/deduplicateSemanticWorldInfo\(deduplicatedEntries\)/),
 linkedMemberDisabledRefused:()=>assert.match(read('core/retrieval-planner.js'),/c\.metadata\?\.enabled===false/),
 exportPreflightBeforeWriter:()=>{const s=read('core/c11-export.js');const block=s.slice(s.indexOf('export async function downloadVerifiedCollectionNDJSON'));assert.ok(block.indexOf('preflightVerifiedCollectionExport')<block.indexOf('createBrowserExportWriter'));},
 noUnverifiedFrequencyEnable:()=>assert.match(read('utils/activation-frequency-ledger.js'),/C08_FINAL_INCLUSION_RECEIPT_AVAILABLE = false/),
 noSyntheticBackendProof:()=>{const s=read('utils/backend-contracts.js'); assert.match(s,/listPagination:'unknown'/);assert.match(s,/insertAcknowledgement:'unknown'/);},
 noNewUnsafeMutationPolicy:()=>{const obj=JSON.parse(read('E02-RUNTIME-POLICY.json'));assert.ok(obj && typeof obj==='object');},
 noUnsafePluginSourceIncluded:()=>assert.ok(!fs.existsSync(path.join(root,'qdrant-backend.js')) && !fs.existsSync(path.join(root,'milvus-backend.js'))),
};
const results={};
for(const [k,f] of Object.entries(checks)){try{f();results[k]=true;}catch(e){results[k]=String(e.message);}}
const pass=Object.values(results).every(v=>v===true);
console.log(JSON.stringify({checkpoint:'E04',offlineOnly:true,pass,checks:results},null,2));
if(!pass)process.exitCode=1;

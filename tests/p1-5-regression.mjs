/** P1.5 independent retrieval/correctness regressions.
 * node --experimental-vm-modules tests/p1-5-regression.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=p=>fs.readFileSync(path.join(root,p),'utf8');
let count=0;
const check=async(name,fn)=>{await fn();count++;console.log('PASS',name)};
const pure=async()=>import('../core/retrieval-policy.js');
const policy=await pure();
await check('preferred collection outranks a slightly higher-scoring nonpreferred candidate',()=>{
 const rows=[{collectionId:'qdrant:llamacpp:X',score:.92},{collectionId:'qdrant:llamacpp:Y',score:.7}];
 const result=policy.rankEligibleChunks(rows,{mode:'prefer_selected',selectedCollections:['qdrant:llamacpp:Y']},1);
 assert.equal(result[0].collectionId,'qdrant:llamacpp:Y');
});
await check('normal retrieval follows scores and honours requested top K',()=>{
 const r=policy.rankEligibleChunks([{collectionId:'X',score:.4},{collectionId:'Y',score:.8}],{mode:'normal'},1);
 assert.equal(r[0].collectionId,'Y'); assert.equal(r.length,1);
});
await check('grouped message references respect recent-context and protected ranges',()=>{
 const chunk={metadata:{messageIds:[8,9,10,11]}};
 assert.equal(policy.isChatChunkInRecentContext(chunk,12,3),true);
 assert.equal(policy.isChatChunkInRecentContext(chunk,12,0),false);
 assert.equal(policy.isChatChunkInRecentContext({metadata:{messageIds:[0,1]}},12,3),false);
});
await check('retrieval paths do not limit globally before eligibility filters',()=>{
 const s=source('core/chat-vectorization.js');
 assert.match(s,/DO NOT trim here/);assert.match(s,/rankEligibleChunks\(eligibleChunks/);
 assert.match(s,/retrievalFailures/);assert.match(s,/isChatChunkInRecentContext/);
});
await check('temporal and group retrieval operate with collection scope',()=>{
 const s=source('core/chat-vectorization.js');
 assert.match(s,/const byCollection = new Map\(\)/);assert.match(s,/getCollectionDecaySettings\(collectionId\)/);
 assert.match(s,/const groups = getCollectionMeta\(collectionId\)\?\.groups/);
});
await check('quiet generation clears all earlier multi-position injected prompts',()=>{
 const s=source('core/chat-vectorization.js');
 assert.match(s,/const oldTags = Object.keys\(extension_prompts \|\| \{\}\)/);
 assert.ok(s.indexOf('const oldTags')<s.indexOf("if (type === 'quiet')"));
});
await check('World Info passes qualified backend identity into queries',()=>{
 const s=source('core/world-info-integration.js');
 assert.match(s,/queryCollection\(collection.id, query, topK, settings\)/);
 assert.match(s,/world_info_threshold \?\? 0\.3/);
});
await check('unsupported backends cannot be selected with a matching plugin',()=>{
 const s=source('ui/ui-manager.js');const manager=source('backends/backend-manager.js');
 assert.match(s,/<option value="milvus" disabled/);assert.match(s,/<option value="lancedb" disabled/);
 assert.match(manager,/not supported by this version of Similharity/);
});
await check('multiple-collection export explicitly fails on incomplete reads',()=>{
 const s=source('core/collection-export.js');assert.match(s,/Multi-collection export incomplete/);
 assert.match(s,/settingsForCollectionQuery\(registryKey/);
});
const hybridCtx=vm.createContext({console,Math,Map,Set});
vm.runInContext(source('core/hybrid-search.js').replace(/^import .*?;\s*$/gm,'').replace(/^export /gm,''),hybridCtx);
await check('weighted hybrid singleton remains positive when a valid result exists',()=>{
 const rows=hybridCtx.weightedCombination([{hash:1,score:.83}],[],1,0);
 assert.equal(rows.length,1);assert.ok(rows[0].combinedScore>0);
});
await check('weighted hybrid preserves genuine zero, positive ties remain positive',()=>{
 const z=hybridCtx.weightedCombination([{hash:1,score:0}],[],1,0);
 assert.equal(z[0].combinedScore,0);
 const t=hybridCtx.weightedCombination([{hash:1,score:.9},{hash:2,score:.9}],[],1,0);
 assert.ok(t.every(x=>x.combinedScore>0));
});
await check('hybrid failed vector search propagates instead of returning empty result',()=>{
 assert.match(source('core/hybrid-search.js'),/throw new Error\(`Hybrid vector query failed/);
});
await check('incremental manifest updates carry revision checks',()=>{
 const s=source('core/vectorization-profile.js');assert.match(s,/expectedUpdatedAt:previous.updatedAt/);
 assert.match(s,/profileSaveStatus:'failed'/);assert.match(s,/manifest\/patch/);
});
console.log(`\n${count} P1.5 extension regressions passed`);

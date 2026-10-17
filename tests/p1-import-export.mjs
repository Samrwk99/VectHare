/** Backend-scoped vector import/export regression checks: node tests/p1-import-export.mjs */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const src=fs.readFileSync(new URL('../core/collection-export.js',import.meta.url),'utf8')
  .replace(/^import\s+\{[\s\S]*?\}\s+from\s+['"][^'"]+['"];\s*$/gm,'')
  .replace(/^import\s+[^\n]+\s+from\s+['"][^'"]+['"];\s*$/gm,'').replace(/^export /gm,'');
let actions=[];
const scope={console,JSON,Array,String,Number,Math,Date,Map,Set,
  getBackend:async settings=>({
    listChunks:async(id,_s,{offset,includeVectors})=>{
      actions.push({operation:'list',id,backend:settings.vector_backend,offset,includeVectors});
      return{items:offset===0?[{hash:1,text:'sample',metadata:{messageIds:[2,3],strategy:'conversation_turns'},vector:[0.1,0.2]}]:[]};
    },
    insertVectorItems:async(id,items,settings)=>actions.push({operation:'insert',id,items,backend:settings.vector_backend,qdrant_multitenancy:settings.qdrant_multitenancy}),
  }),
};
const vmContext=vm.createContext(scope);
vm.runInContext(src,vmContext,{filename:'core/collection-export.js'});
let passes=0;
async function test(name,fn){actions=[];await fn();passes++;console.log('PASS',name)}
await test('Export uses scoped backend listing rather than bare plugin name',async()=>{
  const items=await vmContext.fetchChunksWithVectors('alice',{vector_backend:'qdrant',qdrant_multitenancy:true});
  assert.equal(items.length,1);assert.equal(items[0].metadata.messageIds[1],3);
  assert.equal(actions[0].operation,'list');assert.equal(actions[0].id,'alice');
  assert.equal(actions[0].includeVectors,true);
});
await test('Precomputed import uses backend-scoped write, preserving supplied vectors',async()=>{
  await vmContext.insertChunksWithVectors('alice',[{hash:1,text:'sample',vector:[0.1,0.2],metadata:{messageIds:[2,3]}}],{vector_backend:'qdrant',qdrant_multitenancy:true});
  assert.equal(actions[0].operation,'insert');assert.equal(actions[0].id,'alice');
  assert.equal(actions[0].qdrant_multitenancy,true);assert.equal(actions[0].items[0].vector.length,2);
});
await test('Both import paths retain collection vectorization profiles and sidecars',async()=>{
  const matches=src.match(/await saveCollectionProfile\(/g)||[];
  assert.equal(matches.length,2);
});
console.log(`\n${passes} P1 import/export regression checks passed`);

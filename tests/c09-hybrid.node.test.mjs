import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {lexicalCandidates} from '../core/lexical-provider.js';
import {createBM25Scorer,tokenize} from '../core/bm25-scorer.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function hybridHarness(backend){
    const ctx=vm.createContext({console:{log(){},warn(){},error(){}},Math});
    const mod=new vm.SourceTextModule(fs.readFileSync(path.join(root,'core/hybrid-search.js'),'utf8'),{context:ctx});
    await mod.link(spec=>{
        const exports=spec==='../backends/backend-manager.js'?{getBackend:async()=>backend}:
            spec==='./bm25-scorer.js'?{createBM25Scorer,tokenize}:
            spec==='./lexical-provider.js'?{lexicalCandidates}:null;
        assert.ok(exports,`Unexpected import ${spec}`);
        return new vm.SyntheticModule(Object.keys(exports),function(){for(const [k,v] of Object.entries(exports))this.setExport(k,v);},{context:ctx});
    });
    await mod.evaluate();return mod.namespace.hybridSearch;
}
const snapshot={collectionKey:'a',version:'v1',verified:true,complete:true,expectedCount:2,items:[
    {collectionKey:'a',hash:101,text:'castle cobblestones'},{collectionKey:'a',hash:202,text:'dragon dragon ancient wyrm'}
]};
test('C09 #68 actual hybrid fuses a lexical-only candidate outside vector top K',async()=>{
    const backend={supportsHybridSearch:()=>false,queryCollection:async()=>({hashes:[101],metadata:[{text:'castle cobblestones',score:.8}]})};
    const run=await hybridHarness(backend);
    const result=await run('a','dragon',2,{}, {lexicalProvider:'clientScan',clientSnapshot:snapshot});
    assert.equal(result.lexicalMode,'clientScan');
    assert.ok(Array.from(result.hashes).includes(202),'independent lexical-only record must appear');
    assert.equal(result.metadata.length,2);
});
test('C09 #68 actual hybrid with missing independent provider labels vector-only',async()=>{
    const backend={supportsHybridSearch:()=>false,queryCollection:async()=>({hashes:[101],metadata:[{text:'castle',score:.8}]})};
    const run=await hybridHarness(backend);
    const result=await run('a','dragon',2,{},{});
    assert.equal(result.lexicalMode,'none');
    assert.equal(result.metadata[0].hybridSearch,false);
    assert.equal(result.metadata[0].explain.retrieval,'vector-only');
});
test('C09 #68 verified lexical-only provider still works when vector hit set empty',async()=>{
    const backend={supportsHybridSearch:()=>false,queryCollection:async()=>({hashes:[],metadata:[]})};
    const run=await hybridHarness(backend);
    const result=await run('a','dragon',2,{}, {lexicalProvider:'clientScan',clientSnapshot:snapshot});
    assert.deepEqual(Array.from(result.hashes),[202]);
});
test('C09 #68 native endpoint cannot run merely from adapter supportsHybridSearch flag',async()=>{
    let called=0;
    const backend={supportsHybridSearch:()=>true,hybridQuery:async()=>{called++;throw Error('unsafe');},queryCollection:async()=>({hashes:[101],metadata:[{text:'castle',score:.8}]})};
    const run=await hybridHarness(backend);
    const result=await run('a','dragon',2,{},{});
    assert.equal(called,0);assert.equal(result.lexicalMode,'none');
});

/** I07 backup/import PNG regression tests, exercised without a live backend. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { deflateRawSync, crc32 } from 'node:zlib';
import {parseSafePng,readLimitedStream,MAX_PNG_TEXT_BYTES} from '../utils/safe-png.js';
import { fileURLToPath } from 'node:url';
import { embedDataInPNG, extractDataFromPNG } from '../core/png-export.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');
const quiet = {log(){},warn(){},debug(){},error(){}};
const registry = new Set();
const metadata = new Map();
const chunks = new Map();
const imports=[];
const requests=[];
const state={ vecthare:{ collections:{} } };
const tracker = Object.fromEntries(['show','updateCurrentItem','updateProgress','updateChunks','complete','addError'].map(x=>[x,()=>{}]));
const settings={source:'transformers',model:'test-model',vector_backend:'qdrant'};
const exportedModules={
    '../utils/security.js': {redactSecrets:value=>value},
    '../utils/c04-ownership.js': {quarantineImportedOwnership:(meta)=>({...meta,enabled:false,ownershipReviewRequired:true})},
    '../utils/tenant-route.js': {adapterCollectionId:(key)=>key},
    '../../../../extensions.js': {extension_settings:state},
    '../../../../../script.js': {getRequestHeaders:()=>({}),saveSettingsDebounced:()=>{}},
    './core-vector-api.js':{getSavedHashes:async()=>({hashes:[]}),insertVectorItems:async(id,items)=>imports.push({id,items,reembed:true}),purgeVectorIndex:async()=>true,
      replaceVectorRecords:async(id,oldIds,items,settings,{upsertOverride}={})=>{if(upsertOverride)await upsertOverride(items);else imports.push({id,items,reembed:true});return {status:'committed'};}},
    './collection-metadata.js':{getCollectionMeta:id=>metadata.get(id),setCollectionMeta:(id,meta)=>metadata.set(id,meta), getChunkMetadata:()=>null, saveChunkMetadata:()=>{},getAllChunkMetadata:()=>({})},
    './collection-loader.js':{registerCollection:id=>registry.add(id),getCollectionRegistry:()=>Array.from(registry)},
    '../ui/progress-tracker.js':{progressTracker:tracker},
    '../../../../utils.js':{getStringHash:txt=>txt.length*19},
    './providers.js':{getConfiguredEmbeddingModel:settings=>settings.model || ''},
};
let modPromise;
async function mod() {
    if (modPromise) return modPromise;
    modPromise=(async()=>{
        const context=vm.createContext({console:quiet,fetch:async(url,opts)=>{
            const body=JSON.parse(opts.body);requests.push({url,body});
            if(url.endsWith('/list')) return {ok:true,json:async()=>({success:true,items:chunks.get(body.collectionId)||[]})};
            if(url.endsWith('/insert')) {imports.push({id:body.collectionId,items:body.items});return {ok:true,json:async()=>({success:true,inserted:body.items.length})};}
            throw new Error('unexpected request '+url);
        },Blob,URL,document:{},FileReader:class{}});
        const module=new vm.SourceTextModule(source('core/collection-export.js'),{context});
        await module.link(spec=>{
            assert.ok(exportedModules[spec],`Unknown dependency: ${spec}`);
            const values=exportedModules[spec];
            return new vm.SyntheticModule(Object.keys(values),function(){for(const[k,v]of Object.entries(values))this.setExport(k,v)},{context});
        });
        await module.evaluate();
        return module.namespace;
    })();
    return modPromise;
}
const json=o=>JSON.parse(JSON.stringify(o));
const pngBase=new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64'));

test('#212 malformed backup validation does not throw',async()=>{
 const m=await mod();
 for(const data of [null,1,{},[],{version:12},{version:'1.0.0',type:'multi',collections:{}},{version:'1.0.0',type:'multi',collections:[null]},{version:'1.0.0',collection:{id:'a'},chunks:[null]},{version:'1.0.0',collection:{id:'a'},chunks:[{text:123}]}]){
  const v=m.validateImportData(data); assert.equal(v.valid,false,JSON.stringify(data));
  assert.throws(()=>m.getExportInfo(data));
 }
});

test('#208/#100 vector dimension, partial data and finite numbers validated',async()=>{
 const m=await mod();const ok=(vector,dimension=2)=>m.validateImportData({version:'1.0.0',collection:{id:'X'},embedding:{source:'transformers',model:'test-model',dimension},chunks:[{text:'x',vector}]});
 assert.equal(ok([1,2]).valid,true);
 for(const bad of [[1],[1,2,3],[1,Infinity],[NaN,2],['1',2],[]]) assert.equal(ok(bad).valid,false,JSON.stringify(bad));
 assert.equal(ok([1,2],0).valid,false);
 assert.equal(m.validatePrecomputedVectors([{text:'x',vector:[1,2]},{text:'y'}]).valid,false);
});

test('#203/#204/#62 single/multi export carries vectors, grouping, scenes and activation policies',async()=>{
 const m=await mod();
 metadata.set('I07A',{enabled:false,lockMode:'exclusive',forceMode:'forced',exclusiveWhenActive:true,exclusiveScope:'all',displayName:'Émoji 🦊',groups:[{id:3}],scope:'chat'});
 metadata.set('I07B',{enabled:true,displayName:'B'});
 const record={hash:123,text:'hola 🦊',index:0,vector:[0.5,0.9],metadata:{messageIds:[2,3],messageHashes:[4,5],startIndex:1,endIndex:2,strategy:'grouped',isScene:true,sceneStart:0,sceneEnd:2,chunkGroup:'x',conditions:{enabled:true}}};
 chunks.set('I07A',[record]);chunks.set('I07B',[{hash:124,text:'bonjour',index:1,vector:[0.2,0.3],metadata:{}}]);
 const one=await m.exportCollection('I07A',settings);
 assert.equal(one.settings.enabled,false);
 assert.equal(one.settings.lockMode,'exclusive');assert.equal(one.settings.forceMode,'forced');assert.equal(one.settings.exclusiveWhenActive,true);assert.equal(one.settings.exclusiveScope,'all');
 assert.deepEqual(json(one.chunks[0].vector),[0.5,0.9]);
 assert.deepEqual(json(one.chunks[0].metadata.messageIds),[2,3]);
 assert.equal(one.chunks[0].metadata.isScene,true);
 const multiple=await m.exportMultipleCollections(['I07A','I07B'],settings);
 assert.equal(multiple.collections.length,2);
 assert.deepEqual(json(multiple.collections[0].chunks[0].vector),[0.5,0.9]);
 assert.equal(multiple.collections[0].settings.enabled,false);
 assert.equal(multiple.collections[1].embedding.dimension,2);
});

test('#203/#209/#213 backup import preserves policy and accepts empty collections',async()=>{
 const m=await mod();
 const empty={version:'1.0.0',collection:{id:'EMPTY',name:'Empty collection'},chunks:[],settings:{enabled:false,lockMode:'exclusive',forceMode:'forced',exclusiveWhenActive:true,exclusiveScope:'all'}};
 const count=imports.length;const ret=await m.importCollection(empty,settings);
 assert.equal(ret.success,true);assert.equal(ret.chunkCount,0);assert.equal(imports.length,count);
 assert.equal(metadata.get('EMPTY').enabled,false);assert.equal(metadata.get('EMPTY').lockMode,'exclusive');
 const full={version:'1.0.0',collection:{id:'FULL'},embedding:{source:'transformers',model:'test-model',dimension:2},settings:{enabled:false,forceMode:'forced'},chunks:[{text:'bonjour',index:2,vector:[0.2,0.3],metadata:{sceneStart:7,messageIds:[1,3]}}]};
 const result=await m.importMultipleCollections({type:'multi',collections:[empty,full]},settings);
 assert.equal(result.imported,2);assert.equal(result.failed,0);
 assert.equal(metadata.get('FULL').enabled,false);
 assert.equal(imports.at(-1).id,'FULL');assert.deepEqual(json(imports.at(-1).items[0].vector),[0.2,0.3]);
 assert.deepEqual(json(imports.at(-1).items[0].metadata.messageIds),[1,3]);
 assert.equal(m.validateImportData({version:'1.0.0',type:'multi',collections:[empty,full]},settings).valid,true);
});

test('#117/#210 PNG zlib is interoperable and preserves UTF-8',async()=>{
 const value={version:'1.0.0',generator:'VectHare',collection:{name:'名前 🦊 café'},chunks:[{text:'Привет мир'}]};
 const png=await embedDataInPNG(value,pngBase);const restored=await extractDataFromPNG(png);
 assert.deepEqual(restored,value);
 const needle=Buffer.from('vecthare\0','latin1');const idx=Buffer.from(png).indexOf(needle);
 assert.ok(idx>=0);
 if(png[idx-4]===0x7a){} // encoding is tested by decompressing below.
 const method=png[idx+needle.length];assert.equal(method,0);
 const data=Buffer.from(png).subarray(idx+needle.length+1);
 const {inflateSync}=await import('node:zlib');
 // Ignore CRC/trailing IEND; inflate consumes the first complete zlib stream.
 assert.equal(JSON.parse(inflateSync(data).toString()).collection.name,'名前 🦊 café');
});

test('#117 fallback tEXt Base64 Unicode survives large text without argument-spread overflow',async()=>{
 const src=source('core/png-export.js').replace(/^import .*\n/gm,'').replaceAll('export async function','async function').replaceAll('export function','function');
 const context=vm.createContext({parseSafePng,readLimitedStream,MAX_PNG_TEXT_BYTES,console:quiet,CompressionStream:undefined,DecompressionStream,TextDecoder,TextEncoder,Uint8Array,DataView,Blob,Response,URL,Image:class{},document:{},btoa,atob});
 const fn=vm.runInContext(`${src}\n({embedDataInPNG,extractDataFromPNG})`,context);
 const payload={generator:'VectHare',text:'漢字 🐇'.repeat(30000)};
 const png=await fn.embedDataInPNG(payload,pngBase);
 assert.deepEqual(json(await fn.extractDataFromPNG(png)),payload);
});

test('#123 repeat export replaces obsolete PNG metadata',async()=>{
 const first={generator:'VectHare',marker:'one'};const second={generator:'VectHare',marker:'two'};
 const p1=await embedDataInPNG(first,pngBase);const p2=await embedDataInPNG(second,p1);
 assert.equal((Buffer.from(p2).toString('latin1').match(/vecthare\x00/g)||[]).length,1);
 assert.deepEqual(await extractDataFromPNG(p2),second);
});

test('#210 existing raw-DEFLATE PNG files remain readable',async()=>{
 // Construct legacy zTXt chunk in a PNG by reusing the module's CRC routine from source.
 const s=source('core/png-export.js');
 const defs=s.slice(0,s.indexOf('// ============================================================================\n// COMPRESSION UTILITIES')).replace(/^import .*\n/gm,'');
 const ctx=vm.createContext({Uint8Array,Uint32Array,DataView,TextEncoder,TextDecoder,console:quiet});
 const crc=vm.runInContext(`${defs}\ncrc32`,ctx);
 const jsonPayload=JSON.stringify({generator:'VectHare',marker:'legacy'});
 const kw=Buffer.from('vecthare\0\0','latin1');const comp=deflateRawSync(Buffer.from(jsonPayload));const data=Buffer.concat([kw,comp]);
 const type=Buffer.from('zTXt');const header=Buffer.alloc(8);header.writeUInt32BE(data.length,0);type.copy(header,4);
 const crcBytes=Buffer.alloc(4);crcBytes.writeUInt32BE(crc(Buffer.concat([type,data])),0);
 const iend=pngBase.subarray(pngBase.length-12);
 const png=Buffer.concat([pngBase.subarray(0,pngBase.length-12),header,data,crcBytes,iend]);
 assert.deepEqual(await extractDataFromPNG(png),{generator:'VectHare',marker:'legacy'});
});

test('#154 character-card PNG loader decodes UTF-8 instead of Latin-1 byte strings',()=>{
 const src=source('ui/content-vectorizer.js');
 const start=src.indexOf('function extractCharaFromPng(bytes) {');
 const end=src.indexOf('\n}\n',start);
 assert.ok(start>=0&&end>start);
 const fn=vm.runInNewContext(`${src.slice(start,end+2)}\nextractCharaFromPng`,{parseSafePng,MAX_PNG_TEXT_BYTES,TextDecoder,Uint8Array,atob,console:quiet});
 const payload={spec:'chara_card_v2',data:{name:'月の狐 🦊',description:'café Привет'}};
 const base64=Buffer.from(JSON.stringify(payload),'utf8').toString('base64');
 const content=Buffer.concat([Buffer.from('chara\0'),Buffer.from(base64)]);
 const type=Buffer.from('tEXt');const len=Buffer.alloc(4);len.writeUInt32BE(content.length,0);
 const c=Buffer.alloc(4);c.writeUInt32BE(crc32(Buffer.concat([type,content]))>>>0);
 const image=Buffer.concat([Buffer.from(pngBase).subarray(0,8),len,type,content,c,Buffer.from(pngBase).subarray(-12)]);
 assert.deepEqual(JSON.parse(JSON.stringify(fn(new Uint8Array(image)))),payload.data);
});

test('#100 streamed embeddings reject non-finite numeric components',()=>{
 const src=source('core/core-vector-api.js');
 const match=src.match(/const isValidEmbedding = (embedding\.every\([^;]+\));/);
 assert.ok(match,'Streamed embedding validity check exists');
 const check=vm.runInNewContext(`embedding => ${match[1]}`,{});
 assert.equal(check([1,2.5,0]),true);
 assert.equal(check([1,Infinity]),false);
 assert.equal(check([-Infinity,2]),false);
 assert.equal(check([NaN,2]),false);
});

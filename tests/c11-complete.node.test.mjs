import {test} from 'node:test';
import assert from 'node:assert/strict';
import {exportVerifiedNDJSON,createBrowserExportWriter} from '../utils/c11-bounded-export.js';
import {exportCollectionNDJSON,downloadVerifiedCollectionNDJSON} from '../core/c11-export.js';
import {parseSafePng,readLimitedStream,MAX_PNG_BYTES} from '../utils/safe-png.js';
import {embedDataInPNG,extractDataFromPNG,validatePngExportSize} from '../core/png-export.js';
const key='standard:transformers:test';
const record=n=>({collectionKey:key,recordId:String(n),text:`row ${n}`,vector:[0.1,0.2]});
const createWriter=({collect=false,failAfter=Infinity}={})=>{
  const state={writes:0,closed:false,aborted:false,records:0,lines:[],bytes:0};
  return {state,async write(bytes){state.writes++;if(state.writes>failAfter)throw Error('disk-full');state.bytes+=bytes.length;
    if (collect)state.lines.push(JSON.parse(new TextDecoder().decode(bytes)));
    else if(bytes[0]===123 && new TextDecoder().decode(bytes.subarray(0,20)).includes('"type":"record"'))state.records++;
  },async close(){state.closed=true},async abort(){state.aborted=true}};
};
const source=(total=6,{limit=250,replay=false,scope=key,duplicate=false,shortPage=false,missingEnd=false,countDelta=0,invalidCount=false}={})=>{
 const state={reads:0,counts:0};
 return {state,countRecords:async()=>{state.counts++;return {scope:key,contractVerified:!invalidCount,count:total+(state.counts>1?countDelta:0)}},
 readPage:async({offset,limit:requested})=>{
   state.reads++;
   const begin=replay?0:offset;
   const size=shortPage?Math.min(requested,1):requested;
   const items=Array.from({length:Math.min(size,total-begin)},(_,j)=>record(duplicate?0:begin+j));
   return {scope,contractVerified:true,items,endOfList:missingEnd?false:begin+items.length>=total};
 }};
};
const run=async (s,writer=createWriter({collect:true}),args={})=>({receipt:await exportVerifiedNDJSON({key,contractVerified:true,...s,writer,...args}),writer});

test('C11 >120k verified records exported without one giant JSON array',async()=>{
 const count=120001, s=source(count), w=createWriter();
 const {receipt}=await run(s,w,{pageSize:500});
 assert.equal(receipt.complete,true);assert.equal(receipt.receivedCount,count);
 assert.equal(receipt.expectedCount,count);assert.equal(receipt.pages,241);
 assert.equal(s.state.reads,241);assert.equal(s.state.counts,2);
 assert.equal(w.state.writes,count+2);assert.equal(w.state.closed,true);
 assert.equal(w.state.aborted,false);assert.ok(w.state.bytes>count*25);
});
test('C11 exact, readable header/records/terminal receipt',async()=>{
 const {receipt,writer}=await run(source(3));const lines=writer.state.lines;
 assert.equal(lines[0].type,'vecthare-export-header');assert.equal(lines[0].expectedCount,3);
 assert.deepEqual(lines.slice(1,4).map(x=>x.record.recordId),['0','1','2']);
 assert.equal(lines.at(-1).type,'vecthare-export-receipt');assert.equal(lines.at(-1).complete,true);
 assert.equal(receipt.receivedCount,3);
});
test('C11 empty collection must prove explicit terminal and independent zero',async()=>{
 const {receipt,writer}=await run(source(0));assert.equal(receipt.receivedCount,0);assert.equal(writer.state.lines.length,2);
});
for (const [name,options,pattern] of [
 ['wrong scope',{scope:'qdrant:transformers:test'},/scope/],
 ['duplicate ids',{duplicate:true},/duplicate/],
 ['unconfirmed end',{missingEnd:true},/end-of-list|progress/],
 ['changed count',{countDelta:1},/count changed/],
 ['missing independent count',{invalidCount:true},/count unverified/],
 ['no progress',{shortPage:true,missingEnd:true},/duplicate|progress/],
]) test(`C11 refuses ${name} without completeness receipt`,async()=>{
 const w=createWriter();await assert.rejects(run(source(5,options),w),pattern);
 assert.equal(w.state.closed,false);
 assert.equal(w.state.aborted,true);
});
test('C11 rejects unverified contract before making network calls',async()=>{
 let called=false;const w=createWriter();await assert.rejects(exportVerifiedNDJSON({key,writer:w,readPage:()=>{called=true},countRecords:()=>{called=true}}),/verified/);
 assert.equal(called,false);assert.equal(w.state.writes,0);
});
test('C11 rejects bad and ambiguous collection identities',async()=>{
 const w=createWriter();await assert.rejects(exportVerifiedNDJSON({key:'test',contractVerified:true,readPage:()=>{},countRecords:()=>{},writer:w}),/qualified/);
});
test('C11 refuses max-pages exhaustion',async()=>{
 const w=createWriter();await assert.rejects(run(source(20),w,{pageSize:2,maxPages:3}),/max pages/);assert.equal(w.state.aborted,true);
});
test('C11 transactional writer aborted after storage failure; no complete receipt',async()=>{
 const w=createWriter({failAfter:3});await assert.rejects(run(source(5),w),/disk-full/);
 assert.equal(w.state.aborted,true);assert.equal(w.state.closed,false);
});
test('C11 cancels before export starts without writing',async()=>{
 const ctrl=new AbortController();ctrl.abort();const w=createWriter();await assert.rejects(run(source(5),w,{signal:ctrl.signal}),/aborted/);assert.equal(w.state.writes,0);assert.equal(w.state.aborted,true);
});
test('C11 refuses unreadable pagination adapters and missing capability',async()=>{
 let invoked=0;const w=createWriter();const adapter={countScopedRecords(){invoked++;return 0},listScopedPage(){invoked++;return {}}};
 await assert.rejects(exportCollectionNDJSON({key,settings:{vector_backend:'standard',source:'transformers'},adapter,writer:w}),/contract unverified/);
 assert.equal(invoked,0);
});
test('C11 adapter bridge uses independently scoped readback and verified capability',async()=>{
 const s=source(3),w=createWriter({collect:true});
 const adapter={countScopedRecords:async()=>s.countRecords(),listScopedPage:async(k,args)=>s.readPage(args)};
 const receipt=await exportCollectionNDJSON({key,settings:{vector_backend:'standard',source:'transformers'},adapter,writer:w,capability:()=>true});
 assert.equal(receipt.receivedCount,3);assert.equal(w.state.closed,true);
});
test('C11 adapter bridge refuses unqualified count or page even with capability flag',async()=>{
 const w=createWriter(),a={countScopedRecords:async()=>({count:1}),listScopedPage:async()=>({items:[record(1)],endOfList:true})};
 await assert.rejects(exportCollectionNDJSON({key,settings:{vector_backend:'standard',source:'transformers'},adapter:a,writer:w,capability:()=>true}),/count unverified/);
});
test('C11 download option gates capability before opening a save dialog',async()=>{
 await assert.rejects(downloadVerifiedCollectionNDJSON({key,settings:{source:'transformers',vector_backend:'standard'}}),/not verified/);
});
test('C11 PNG limited by chunk count before JSON serialization',async()=>{
 const x={chunks:Array.from({length:2501},()=>({text:'abc'}))};
 assert.throws(()=>validatePngExportSize(x),/JSON or verified NDJSON/);
 await assert.rejects(embedDataInPNG(x),/2,500/);
});
test('C11 PNG rejects oversized UTF8 metadata payload',async()=>{
 const x={generator:'VectHare',metadata:'🌲'.repeat(2_000_000)};
 await assert.rejects(embedDataInPNG(x),/6 MiB payload/);
});
test('C11 PNG rejects obvious excessive text payload',()=>{
 assert.throws(()=>validatePngExportSize({chunks:[{text:'x'.repeat(6*1024*1024+1)}]}),/payload limit/);
});
const base=new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=','base64'));
test('C11 small PNG round-trip, IHDR/IDAT/IEND integrity',async()=>{
 assert.deepEqual(parseSafePng(base).map(x=>x.type),['IHDR','IDAT','IEND']);
 const value={generator:'VectHare',chunks:[{text:'hello 🎉'}]};const result=await embedDataInPNG(value,base);
 assert.deepEqual(await extractDataFromPNG(result),value);
});
test('C11 PNG corrupt chunk length rejected',()=>{
 const bad=Uint8Array.from(base);bad[11]=255;assert.throws(()=>parseSafePng(bad),/chunk length/);
});
test('C11 PNG CRC mismatch rejected',()=>{
 const bad=Uint8Array.from(base);bad[44]^=1;assert.throws(()=>parseSafePng(bad),/CRC mismatch/);
});
test('C11 PNG truncated and trailing bytes rejected',()=>{
 assert.throws(()=>parseSafePng(base.slice(0,-4)),/chunk length|[Tt]runcated|terminator/);
 const bad=new Uint8Array(base.length+1);bad.set(base);assert.throws(()=>parseSafePng(bad),/terminator/);
});
test('C11 PNG unknown critical chunk forbidden (before CRC)',()=>{
 const bad=Uint8Array.from(base);bad.set(new TextEncoder().encode('ABCD'),12);
 assert.throws(()=>parseSafePng(bad),/Unsupported PNG chunk/);
});
test('C11 PNG memory and decompression bomb guard',async()=>{
 assert.throws(()=>parseSafePng(new Uint8Array(MAX_PNG_BYTES+1)),/size/);
 const bomb=new ReadableStream({start(c){c.enqueue(new Uint8Array(17));c.close()}});
 await assert.rejects(readLimitedStream(bomb,16),/safe limit/);
});

test('C11 rejects stale cursor and nonprogress with cursor pagination',async()=>{
 const w=createWriter();const s=source(4);
 await assert.rejects(exportVerifiedNDJSON({key,mode:'cursor',pageSize:2,contractVerified:true,
   countRecords:s.countRecords,writer:w,readPage:async()=>({scope:key,contractVerified:true,items:[record(0),record(1)],endOfList:false,nextCursor:'stale'})}),/duplicate|cursor/);
 assert.equal(w.state.aborted,true);
});
test('C11 hard-fails after wrong-tenant record with no receipt',async()=>{
 const w=createWriter({collect:true});const s=source(3);
 await assert.rejects(exportVerifiedNDJSON({key,contractVerified:true,writer:w,countRecords:s.countRecords,
   readPage:async args=>{const page=await s.readPage(args);page.items[0].collectionKey='qdrant:transformers:foreign';return page}}),/ownership/);
 assert.equal(w.state.closed,false);assert.equal(w.state.aborted,true);
});
test('C11 browser fallback enforces memory ceiling',async()=>{
 const w=await createBrowserExportWriter({maxFallbackBytes:10});
 await w.write(new Uint8Array(10));await assert.rejects(w.write(new Uint8Array(1)),/memory export limit/);
 await w.abort();
});
test('C11 route mismatch rejected before adapter invocation',async()=>{
 let called=false;const w=createWriter();
 await assert.rejects(exportCollectionNDJSON({key,settings:{source:'other',vector_backend:'standard'},
   adapter:{listScopedPage(){called=true}},writer:w,capability:()=>true}),/route mismatch/);
 assert.equal(called,false);
});
test('C11 selected page sizes over 2000 rejected',async()=>{
 await assert.rejects(run(source(0),createWriter(),{pageSize:2001}),/pagination configuration/);
});

test('C11 streaming export redacts credential-bearing metadata fields',async()=>{
 const w=createWriter({collect:true});const recordItem={collectionKey:key,recordId:'1',text:'ordinary data',metadata:{apiKey:'SENTINEL-secret',nested:{password:'SENTINEL-password'}}};
 await exportVerifiedNDJSON({key,contractVerified:true,writer:w,
   countRecords:async()=>({scope:key,count:1,contractVerified:true}),
   readPage:async()=>({scope:key,contractVerified:true,items:[recordItem],endOfList:true}),
   metadata:{authToken:'SENTINEL-header'}});
 const exported=JSON.stringify(w.state.lines);
 assert.equal(exported.includes('SENTINEL'),false);
 assert.equal(w.state.lines[1].record.text,'ordinary data');
});

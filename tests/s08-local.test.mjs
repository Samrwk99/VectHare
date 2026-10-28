import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {collectionIdentity} from '../lib/s02-identity.js';
import {planMutation} from '../lib/s04-contract.js';
import {walkInventory} from '../lib/s05-contract.js';
import {lancedbV2Adapter,inspectLanceV2Table,lanceV2ScopePredicate} from '../lib/s08-lancedb.js';
import {vectraV2Adapter,inspectVectraV2Index} from '../lib/s08-vectra.js';
const embedding={source:'transformers',model:'s08-test',dimension:3,metric:'cosine'};
const scope={userScopeId:'alice',collectionId:'chat-one',type:'chat',sourceId:'main',branchId:'b1'};
const payload={text:'s08 hello',vector:[0.5,0.25,0.125],metadata:{tag:'a'}};
function bind(backend,sc=scope){const c=collectionIdentity({backend,scope:sc,embedding});return {backend,authorized:true,provenance:'SERVER_VERIFIED',scope:sc,embedding,collection:{key:c.key,physicalName:c.physicalName}};}
function plan(backend,sc=scope,input={action:'insert',...payload}){return planMutation({userScopeId:sc.userScopeId},{backend,scope:sc,embedding,operationId:randomUUID(),...input});}
const schemaFields=()=>['physicalId','recordId','userScopeId','collectionId','type','sourceId','branchId','schemaVersion','revision','text','textHash','metadata','metadataHash','embedding','vectorHash','vector']
 .map(name=>({name,type:name==='vector'?{listSize:3}:{},nullable:false}));
function sqlFilter(expr,row){return expr.split(' AND ').every(part=>{
  const m=part.match(/^(\w+) = (.+)$/);if(!m)throw Error(`bad expression ${part}`);
  let value=m[2];value=value.startsWith("'")?value.slice(1,-1).replaceAll("''","'"):Number(value);
  return row[m[1]]===value;
 });}
function lanceMock({disposable=true,schema=schemaFields(),failure=null,ack='good',wrongTable=false}={}){
 const map=new Map(),calls=[];const bn=bind('lancedb');
 const table={schema:{fields:schema},
  query(){let predicate=null,max=Infinity,offset=0,sort=false;
   const q={where(str){predicate=str;return q;},limit(n){max=n;return q;},offset(n){offset=n;return q;},orderBy(){sort=true;return q;},
    async toArray(){calls.push(['read',predicate]);if(failure==='read')throw Error('read down');
     let rows=[...map.values()].filter(r=>!predicate||sqlFilter(predicate,r));
     if(sort)rows=rows.sort((a,b)=>a.physicalId.localeCompare(b.physicalId));
     return structuredClone(rows.slice(offset,offset+max));}};return q;},
  vectorSearch(vector){const q=table.query();const original=q.toArray;q.toArray=async()=> (await original()).map(r=>({...r,_distance:0.5}));return q;},
  async add(rows){calls.push(['add',rows]);if(failure==='add')throw Error('add down');for(const row of rows)map.set(row.physicalId,structuredClone(row));},
  async update({where,values}){calls.push(['update',where]);if(failure==='update')throw Error('update down');let n=0;
   for(const [key,row] of map){if(sqlFilter(where,row)){map.set(key,structuredClone(values));n++;}}
   return ack==='bad'?{}:{rowsUpdated:n};},
  async delete(where){calls.push(['delete',where]);if(failure==='delete')throw Error('delete down');
   for(const [key,row] of map)if(sqlFilter(where,row))map.delete(key);return {version:2};}
 };
 const db={async tableNames(){calls.push(['tableNames']);return wrongTable?['old_legacy_table']:[bn.collection.physicalName];},
   async openTable(n){calls.push(['openTable',n]);return table;}};
 return {db,map,calls,s08DisposableFixture:disposable};
}
function vectraMock({disposable=true,binding=bind('vectra'),failure=null,exists=true,schemaOverride=null}={}){
 const map=new Map(),calls=[];
 const idx={
  async isIndexCreated(){calls.push('exists');return exists;},
  async getItem(id){calls.push('get');if(failure==='read')throw Error('read down');return map.get(id)?structuredClone(map.get(id)):undefined;},
  async listItems(){calls.push('list');return [...map.values()].map(x=>structuredClone(x));},
  async queryItems(v,topK){calls.push('query');return [...map.values()].slice(0,topK).map(item=>({score:0.9,item:structuredClone(item)}));},
  async beginUpdate(){calls.push('begin');},async endUpdate(){calls.push('end');if(failure==='commit')throw Error('commit down');},
  async cancelUpdate(){calls.push('cancel');},
  async insertItem(item){calls.push('insert');if(failure==='insert')throw Error('insert down');if(map.has(item.id))throw Error('duplicate');map.set(item.id,structuredClone(item));return item;},
  async upsertItem(item){calls.push('upsert');if(failure==='upsert')throw Error('upsert down');map.set(item.id,structuredClone(item));return item;},
  async deleteItem(id){calls.push('delete');if(failure==='delete')throw Error('delete down');map.delete(id);}
 };
 return {index:idx,map,calls,s08DisposableFixture:disposable,s08ServerSchema:schemaOverride??{
  schemaVersion:2,provenance:'SERVER_REGISTRY',collectionKey:binding.collection.key,
  physicalName:binding.collection.physicalName,embedding}};
}
for(const [label,backend,adapter,mocker] of [
 ['LanceDB','lancedb',lancedbV2Adapter,lanceMock],
 ['Vectra','vectra',vectraV2Adapter,vectraMock]]){
 const binding=bind(backend);
 test(`S08 ${label} public mutations refuse before physical write`,async()=>{
  const tr=mocker({disposable:false}),a=adapter(tr,binding);
  await assert.rejects(()=>a.insertRecord(plan(backend),payload),{code:'S08_WRITE_NOT_ACTIVATED'});
  assert.ok(!tr.calls.some(c=>typeof c==='string'?['insert','upsert','delete'].includes(c):['add','update','delete'].includes(c[0])));
 });
 test(`S08 ${label} disposable insert, text update, metadata update, scoped delete`,async()=>{
  const tr=mocker(),a=adapter(tr,binding),p=plan(backend);
  assert.equal((await a.insertRecord(p,payload)).status,'VERIFIED');
  assert.equal((await a.getRecord(p.recordId)).revision,1);
  const upd={text:'next text',vector:[0.5,0.125,0.25],metadata:{tag:'new'}};
  const up=plan(backend,scope,{action:'update',recordId:p.recordId,expectedRevision:1,...upd});
  assert.equal((await a.updateRecord(up,upd)).status,'VERIFIED');
  assert.equal((await a.getRecord(p.recordId)).text,'next text');
  const mp={metadata:{tag:'metadata'}};
  assert.equal((await a.updateRecord(plan(backend,scope,{action:'metadata',recordId:p.recordId,expectedRevision:2,...mp}),mp)).status,'VERIFIED');
  assert.deepEqual((await a.getRecord(p.recordId)).metadata,{tag:'metadata'});
  assert.equal((await a.deleteRecord(plan(backend,scope,{action:'delete',recordId:p.recordId,expectedRevision:3}))).status,'VERIFIED');
  assert.equal(await a.getRecord(p.recordId),null);
 });
 test(`S08 ${label} stale revision and forged scope refuse changes`,async()=>{
  const tr=mocker(),a=adapter(tr,binding),p=plan(backend);await a.insertRecord(p,payload);
  const other={...scope,userScopeId:'bob'},bad=plan(backend,other,{action:'delete',recordId:p.recordId,expectedRevision:1});
  await assert.rejects(()=>a.deleteRecord(bad),{code:'S08_PLAN_INVALID'});
  const stale=plan(backend,scope,{action:'delete',recordId:p.recordId,expectedRevision:2});
  await assert.rejects(()=>a.deleteRecord(stale),{code:'S08_REVISION_CONFLICT'});
  assert.equal((await a.getRecord(p.recordId)).revision,1);
 });
 test(`S08 ${label} rejects altered payloads and non-float32 before writing`,async()=>{
  const tr=mocker(),a=adapter(tr,binding),p=plan(backend);
  await assert.rejects(()=>a.insertRecord(p,{...payload,text:'forged'}),{code:'S08_TEXT_MISMATCH'});
  const nonF32={...payload,vector:[0.1,0.2,0.3]};
  await assert.rejects(()=>a.insertRecord(plan(backend,scope,{action:'insert',...nonF32}),nonF32),{code:'S08_FLOAT32_REQUIRED'});
  assert.equal(tr.map.size,0);
 });
 test(`S08 ${label} read backend exception never becomes empty result`,async()=>{
  const tr=mocker({failure:'read'}),a=adapter(tr,binding);
  await assert.rejects(()=>a.getRecord(randomUUID()),/read down/);
 });
 test(`S08 ${label} bounded pagination cannot certify full export`,async()=>{
  const tr=mocker(),a=adapter(tr,binding);
  for(let i=0;i<260;i++){
   const pay={...payload,text:`row ${i}`,metadata:{i}},p=plan(backend,scope,{action:'insert',...pay});
   if(backend==='lancedb')tr.map.set(p.physicalId,{...p.scope,branchId:'b1',physicalId:p.physicalId,recordId:p.recordId,
    revision:1,schemaVersion:2,text:pay.text,textHash:p.textHash,metadata:JSON.stringify(pay.metadata),
    metadataHash:p.metadataHash,embedding:JSON.stringify(embedding),vectorHash:p.vectorHash,vector:pay.vector});
   else tr.map.set(p.physicalId,{id:p.physicalId,vector:pay.vector,metadata:{...p.scope,branchId:'b1',physicalId:p.physicalId,
    recordId:p.recordId,revision:1,schemaVersion:2,text:pay.text,textHash:p.textHash,metadata:pay.metadata,
    metadataHash:p.metadataHash,embedding,vectorHash:p.vectorHash}});
  }
  const first=await a.listPage({limit:100});assert.equal(first.items.length,100);assert.equal(first.hasMore,true);
  assert.equal(first.inventoryVerified,false);
  // Adapt a normalized page to raw records only for this exercise; inventory stays unverified.
  const walked=await walkInventory({binding,readPage:async options=>{
   const page=await a.listPage(options);
   return {items:page.items.map(r=>({...r,...r.scope,branchId:r.scope.branchId??'',vector:r.vector})),hasMore:page.hasMore,nextCursor:page.nextCursor};
  },limit:100,maxPages:10});
  assert.equal(walked.examined,260);assert.equal(walked.verifiedExportAllowed,false);
 });
}
test('S08 LanceDB predicate rejects injected scope and requires five ownership dimensions',()=>{
 assert.throws(()=>bind('lancedb',{...scope,sourceId:"test' OR 1=1"}),{code:'S02_INVALID_IDENTITY'});
 const sql=lanceV2ScopePredicate(bind('lancedb'));
 for(const field of ['userScopeId','collectionId','type','sourceId','branchId'])assert.ok(sql.includes(`${field} = `));
 assert.equal(sql.split(' AND ').filter(x=>x.includes(' = ')).length,5);
});
test('S08 LanceDB refuses legacy table alias and missing vector schema',async()=>{
 await assert.rejects(()=>inspectLanceV2Table(lanceMock({wrongTable:true}),bind('lancedb')),{code:'S08_COLLECTION_MISSING'});
 const damaged=schemaFields().filter(x=>x.name!=='userScopeId');
 await assert.rejects(()=>inspectLanceV2Table(lanceMock({schema:damaged}),bind('lancedb')),{code:'S08_SCHEMA_MISMATCH'});
 await assert.rejects(()=>inspectLanceV2Table(lanceMock({schema:schemaFields().map(x=>x.name==='vector'?{...x,type:{listSize:5}}:x)}),bind('lancedb')),{code:'S08_DIMENSION_MISMATCH'});
});
test('S08 LanceDB rejects ambiguous legacy names at old boundary',async()=>{
 const {default:backend}=await import('../lancedb-backend.js').catch(()=>({default:null}));
 if(backend)assert.equal(typeof backend.deleteVectors,'function');
 const {safeLegacyPhysicalName}=await import('../lib/s02-identity.js');
 assert.throws(()=>safeLegacyPhysicalName('lancedb','chat:branch'),{code:'S02_AMBIGUOUS_LEGACY_NAME'});
});
test('S08 LanceDB refuses uncertain update ack and retains uncertainty',async()=>{
 const b=bind('lancedb'),tr=lanceMock({ack:'bad'}),a=lancedbV2Adapter(tr,b),p=plan('lancedb');
 await a.insertRecord(p,payload);
 const up={...payload,text:'new text'};
 await assert.rejects(()=>a.updateRecord(plan('lancedb',scope,{action:'update',recordId:p.recordId,expectedRevision:1,...up}),up),{code:'S08_MUTATION_UNCERTAIN'});
});
test('S08 Vectra aborts transaction and propagates error on failed insert',async()=>{
 const b=bind('vectra'),tr=vectraMock({failure:'insert'}),a=vectraV2Adapter(tr,b);
 await assert.rejects(()=>a.insertRecord(plan('vectra'),payload),/insert down/);
 assert.ok(tr.calls.includes('cancel'));assert.ok(!tr.calls.includes('end'));
});
test('S08 Vectra rejects forged or absent registry-seal before index read',async()=>{
 const b=bind('vectra'),tr=vectraMock({schemaOverride:{}});
 await assert.rejects(()=>inspectVectraV2Index(tr,b),{code:'S08_SCHEMA_UNVERIFIED'});
 assert.deepEqual(tr.calls,[]);
});
test('S08 Vectra and LanceDB cannot claim native SillyTavern Standard routes',async()=>{
 const fs=await import('node:fs/promises');const source=await fs.readFile(new URL('../index.js',import.meta.url),'utf8');
 assert.ok(!source.includes("registerS08PublicMutations("));
 assert.ok(source.includes("case 'standard':"));
});

test('S08 both backends refuse cross-branch physical identity and owner spoofing',async()=>{
 for(const [backend,ctor,factory] of [['lancedb',lancedbV2Adapter,lanceMock],['vectra',vectraV2Adapter,vectraMock]]){
  const tr=factory(),a=ctor(tr,bind(backend)),p=plan(backend);
  await a.insertRecord(p,payload);
  const otherBranch={...scope,branchId:'b2'};
  assert.notEqual(plan(backend,otherBranch,{action:'insert',recordId:p.recordId,...payload}).physicalId,p.physicalId);
  const bad=plan(backend,otherBranch,{action:'delete',recordId:p.recordId,expectedRevision:1});
  await assert.rejects(()=>a.deleteRecord(bad),{code:'S08_PLAN_INVALID'});
  if(backend==='lancedb')tr.map.get(p.physicalId).userScopeId='mallory';
  else tr.map.get(p.physicalId).metadata.userScopeId='mallory';
  // A physical read query must not expose a record owned by a different scope.
  if(backend==='lancedb')assert.equal(await a.getRecord(p.recordId),null);
  else await assert.rejects(()=>a.getRecord(p.recordId),{code:'S05_OWNER_MISMATCH'});
 }
});

test('S08 both backends handle 1,090-record traversal without verified inventory claims',async()=>{
 for(const [backend,ctor,factory] of [['lancedb',lancedbV2Adapter,lanceMock],['vectra',vectraV2Adapter,vectraMock]]){
  const tr=factory(),a=ctor(tr,bind(backend));
  for(let i=0;i<1090;i++){
   const pay={...payload,text:`bulk ${i}`,metadata:{i}},p=plan(backend,scope,{action:'insert',...pay});
   const fields={...p.scope,branchId:'b1',physicalId:p.physicalId,recordId:p.recordId,revision:1,schemaVersion:2,
    text:pay.text,textHash:p.textHash,metadataHash:p.metadataHash,vectorHash:p.vectorHash,vector:pay.vector};
   if(backend==='lancedb')tr.map.set(p.physicalId,{...fields,metadata:JSON.stringify(pay.metadata),embedding:JSON.stringify(embedding)});
   else tr.map.set(p.physicalId,{id:p.physicalId,vector:pay.vector,metadata:{...fields,metadata:pay.metadata,embedding}});
  }
  const result=await walkInventory({binding:bind(backend),readPage:async options=>{
   const page=await a.listPage(options);
   return {items:page.items.map(r=>({...r,...r.scope,branchId:r.scope.branchId??''})),hasMore:page.hasMore,nextCursor:page.nextCursor};
  },limit:100,maxPages:15});
  assert.equal(result.examined,1090);
  assert.equal(result.completeTraversal,true);
  assert.equal(result.verifiedExportAllowed,false);
 }
});

test('S08 new adapters can use S04 ledger engine for disposable insert',async()=>{
 const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');
 const {MutationEngine}=await import('../lib/s04-engine.js');
 const {OperationLedger}=await import('../lib/s04-ledger.js');
 for(const [backend,ctor,factory] of [['lancedb',lancedbV2Adapter,lanceMock],['vectra',vectraV2Adapter,vectraMock]]){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),`s08-${backend}-`));
  try{
   const tr=factory(),p=plan(backend),context={userScopeId:scope.userScopeId,vectorsPath:dir};
   const engine=new MutationEngine({ledger:new OperationLedger(context),adapter:ctor(tr,bind(backend)),
    authorize:async intent=>({authorized:true,ownerVerified:true,mutationContractVerified:true,collectionKey:intent.collectionKey,backend:intent.backend})});
   const result=await engine.execute(p,payload);
   assert.equal(result.state,'VERIFIED');
   assert.equal(tr.map.size,1);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
 }
});

test('S08 legacy mutation gates remain explicit, new adapters not registered on HTTP',async()=>{
 const fs=await import('node:fs/promises');const src=await fs.readFile(new URL('../index.js',import.meta.url),'utf8');
 const {S01_BLOCKED_ROUTES}=await import('../lib/s01-safety.js').catch(()=>({S01_BLOCKED_ROUTES:null}));
 for(const route of ["'/chunks/insert'","'/chunks/delete'","'/chunks/purge'","'/purge-all'"])
  assert.ok(src.includes(route),`legacy route ${route} missing`);
 assert.ok(!src.includes('lancedbV2Adapter('));
 assert.ok(!src.includes('vectraV2Adapter('));
});

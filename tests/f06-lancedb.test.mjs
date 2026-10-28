import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {F06_ACCEPTANCE_CONSENT,F06_ACCEPTANCE_STAGES,f06ArrowSchema,provisionF06LanceV2Collection,
 runF06LanceAcceptance,registerF06AcceptanceRoutes} from '../lib/f06-lancedb.js';
import {collectionIdentity} from '../lib/s02-identity.js';
const arrow=Object.fromEntries(['Schema','Field','Utf8','Int32','FixedSizeList','Float32'].map(k=>[k,class {
 constructor(...args){if(k==='Schema')this.fields=args[0];else if(k==='Field'){
  this.name=args[0];this.type=args[1];this.nullable=args[2];
 }else if(k==='FixedSizeList')this.listSize=args[0];}
}]));
const filter=(expr,row)=>expr.split(' AND ').every(part=>{
 const m=part.match(/^(\w+) = (.+)$/);if(!m)throw Error('predicate invalid');
 const val=m[2].startsWith("'")?m[2].slice(1,-1).replaceAll("''", "'"):Number(m[2]);
 return row[m[1]]===val;
});
function fakeLance(){
 const dbs=new Map();let openings=[];
 function database(){const tables=new Map();return {tables,async tableNames(){return [...tables.keys()]},
  async openTable(name){if(!tables.has(name))throw Error('missing');return tables.get(name)},
  async createEmptyTable(name,schema,options){if(tables.has(name)||options.mode!=='create'||options.existOk!==false)throw Error('unsafe');
   const rows=new Map();const table={schema,rows,async countRows(){return rows.size},
    query(){let where=null,limit=Infinity,offset=0,ordered=false;const q={where(v){where=v;return q},limit(v){limit=v;return q},offset(v){offset=v;return q},
     orderBy(){ordered=true;return q},async toArray(){let values=[...rows.values()].filter(x=>!where||filter(where,x));
      if(ordered)values.sort((a,b)=>a.physicalId.localeCompare(b.physicalId));return structuredClone(values.slice(offset,offset+limit));}};return q;},
    vectorSearch(){const q=this.query();const prev=q.toArray;q.toArray=async()=> (await prev()).map(x=>({...x,_distance:0.02}));return q;},
    async add(records){for(const record of records){if(rows.has(record.physicalId))throw Error('duplicate');rows.set(record.physicalId,structuredClone(record));}},
    async update({where,values}){let n=0;for(const [id,row] of rows){if(filter(where,row)){rows.set(id,structuredClone(values));n++;}}return {rowsUpdated:n};},
    async delete(where){for(const [id,row] of rows){if(filter(where,row))rows.delete(id);}return {version:2};}
   };tables.set(name,table);return table;}};}
 return {dbs,openings,async getDatabase(src){openings.push(src);if(!dbs.has(src))dbs.set(src,database());return dbs.get(src);}};
}
const ctx={userScopeId:'alice',vectorsPath:'/fake/fixture'};
const scope={userScopeId:'alice',collectionId:'chat',type:'chat',sourceId:'file',branchId:'branch'};
const embedding={source:'transformers',model:'test',dimension:4,metric:'dot'};
const identity=collectionIdentity({backend:'lancedb',scope,embedding});
const binding={backend:'lancedb',authorized:true,provenance:'SERVER_VERIFIED',scope,embedding,
 collection:{key:identity.key,physicalName:identity.physicalName}};
const create=(backend,b)=>provisionF06LanceV2Collection(backend,b,{arrowModule:arrow});
test('F06 uses explicit nonnullable Arrow schema with fixed float32 vector length',()=>{
 const schema=f06ArrowSchema(arrow,4);assert.equal(schema.fields.length,16);
 const vector=schema.fields.find(x=>x.name==='vector');assert.equal(vector.type.listSize,4);
 assert.equal(vector.nullable,false);assert.throws(()=>f06ArrowSchema(arrow,0),{code:'F06_DIMENSION_INVALID'});
});
test('F06 LanceDB provision only creates a NEW source-specific table; never overwrites',async()=>{
 const backend=fakeLance(),created=await create(backend,binding);
 assert.equal(created.status,'PROVISIONED_SOURCE_BOUND_UNCERTIFIED');
 assert.deepEqual(backend.openings,['transformers']);
 assert.equal((await backend.getDatabase('transformers')).tables.size,1);
 await assert.rejects(()=>create(backend,binding),{code:'F06_COLLECTION_EXISTS'});
 const other={...binding,collection:{...binding.collection,physicalName:'legacy'}};
 await assert.rejects(()=>create(backend,other),{code:'F06_BINDING_UNVERIFIED'});
 assert.equal((await backend.getDatabase('transformers')).tables.size,1);
});
test('F06 full disposable lifecycle through S04 engine + S08 adapter; no production enablement',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'f06-lance-'));
 try{const backend=fakeLance(),result=await runF06LanceAcceptance({...ctx,vectorsPath:dir},backend,{provision:create});
  assert.equal(result.success,true,JSON.stringify(result));
  assert.deepEqual(result.stages.map(s=>s.stage),F06_ACCEPTANCE_STAGES);
  assert.equal(result.stages.every(s=>s.status==='PASS'),true);
  assert.equal(result.productionWritesEnabled,false);assert.equal(result.backendCertified,false);
  assert.equal(backend.dbs.get('diagnostic').tables.size,1);
  const table=[...backend.dbs.get('diagnostic').tables.values()][0];assert.equal(table.rows.size,0);
  assert.equal(backend.dbs.has('transformers'),false);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('F06 failure preserves isolated collection and reports uncertainty without claiming success',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'f06-lance-error-'));
 try{const backend=fakeLance(),result=await runF06LanceAcceptance({...ctx,vectorsPath:dir},backend,{provision:async()=>{throw Error('creation incomplete')}});
  assert.equal(result.success,false);assert.equal(result.stages.at(-1).stage,'provision');
  assert.equal(result.productionWritesEnabled,false);assert.equal(result.collectionRetained,true);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
function mockRouter(){const routes=new Map();return {routes,post:(p,h)=>routes.set(p,h)};}
function response(){return {statusCode:200,status(n){this.statusCode=n;return this},json(d){this.body=d;return this}};}
test('F06 route rejects browser-selected paths, missing consent, absent same-origin marker',async()=>{
 const router=mockRouter();let hits=0;
 registerF06AcceptanceRoutes(router,{backendPool:{async get(){hits++;return fakeLance();}},
  run:async()=>({success:true,productionWritesEnabled:false,backendCertified:false})});
 const call=async(body,headers={})=>{const res=response();await router.routes.get('/v2/diagnostics/lancedb-f06')({s03:ctx,body,headers},res);return res;};
 assert.equal((await call({consent:F06_ACCEPTANCE_CONSENT})).statusCode,403);
 assert.equal((await call({consent:F06_ACCEPTANCE_CONSENT,path:'/tmp/valuable'}, {'x-vecthare-f06-diagnostic':'1'})).statusCode,403);
 assert.equal((await call({consent:'ok'},{'x-vecthare-f06-diagnostic':'1'})).statusCode,403);
 assert.equal(hits,0);
 const good=await call({consent:F06_ACCEPTANCE_CONSENT},{'x-vecthare-f06-diagnostic':'1','sec-fetch-site':'same-origin'});
 assert.equal(good.statusCode,200);assert.equal(hits,1);
});

import {registerF06PilotRoutes,F06_PILOT_CONSENT,validateF06LancePilot} from '../lib/f06-lancedb-pilot.js';
import {randomUUID} from 'node:crypto';
import {OperationLedger} from '../lib/s04-ledger.js';
async function withReceipt(fn){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'f06-lance-pilot-'));
 try{await fs.chmod(dir,0o700);const folder=path.join(dir,'.similharity','f03-provisions');
  await fs.mkdir(folder,{recursive:true,mode:0o700});await fs.chmod(path.dirname(folder),0o700);
  await fs.writeFile(path.join(folder,identity.key+'.json'),JSON.stringify({schemaVersion:3,
   collectionKey:identity.key,physicalName:identity.physicalName,backend:'lancedb',userScopeId:scope.userScopeId,
   operationId:randomUUID(),state:'SCHEMA_VERIFIED_OFFLINE_UNCERTIFIED'}),{mode:0o600});
  return await fn({userScopeId:scope.userScopeId,vectorsPath:dir});
 }finally{await fs.rm(dir,{recursive:true,force:true});}}
const pilotBase={backend:'lancedb',configId:'default',source:{kind:'chat',avatar:'x.png',chatFile:'sample'},
 embedding,experimentalConsent:F06_PILOT_CONSENT};
const pilot=(action,recordId,expectedRevision,extra={})=>({...pilotBase,action,recordId,expectedRevision,
 operationId:randomUUID(),...extra});
async function pilotCall(router,ctx,payload,headers={'x-vecthare-f06-pilot':'1'}){
 const r=response();await router.routes.get('/v2/records/lancedb-pilot-mutate')({s03:ctx,body:payload,headers},r);return r;
}
test('F06 local LanceDB source-bound pilot verifies insert/update/metadata/delete with S04 receipts',()=>withReceipt(async context=>{
 const backend=fakeLance();await create(backend,binding);
 const router=mockRouter();let attestations=0;
 registerF06PilotRoutes(router,{backendPool:{get:async()=>backend},bind:async()=>{attestations++;return {binding}}});
 const id=randomUUID(),vector=[.25,.5,.75,.125];
 const input=pilot('insert',id,0,{text:'new owned v2 record',vector,metadata:{fixture:'pilot'}});
 const inserted=await pilotCall(router,context,input);
 assert.equal(inserted.statusCode,200,JSON.stringify(inserted.body));assert.equal(inserted.body.state,'VERIFIED');
 assert.equal((await new OperationLedger(context).read(input.operationId)).state,'VERIFIED');
 const repeated=await pilotCall(router,context,input);assert.equal(repeated.body.code,'S04_OPERATION_EXISTS');
 const stale=await pilotCall(router,context,pilot('delete',id,9));
 assert.equal(stale.body.code,'S04_REVISION_OR_OWNER_MISMATCH');
 const update=await pilotCall(router,context,pilot('update',id,1,{text:'edited record',vector:[.5,.25,.75,.125],metadata:{rev:2}}));
 assert.equal(update.body.state,'VERIFIED',JSON.stringify(update.body));
 const meta=await pilotCall(router,context,pilot('metadata',id,2,{metadata:{rev:3}}));
 assert.equal(meta.body.state,'VERIFIED',JSON.stringify(meta.body));
 const deleted=await pilotCall(router,context,pilot('delete',id,3));
 assert.equal(deleted.body.state,'VERIFIED',JSON.stringify(deleted.body));
 assert.equal((await backend.getDatabase('transformers')).tables.get(identity.physicalName).rows.size,0);
 assert.ok(attestations>=8);
}));
test('F06 pilot refuses path, cross-origin, unauthorized user and missing receipt before a record write',()=>withReceipt(async context=>{
 const backend=fakeLance();await create(backend,binding);
 const router=mockRouter();let hits=0;
 registerF06PilotRoutes(router,{backendPool:{get:async()=>{hits++;return backend;}},bind:async()=>({binding})});
 const body=pilot('insert',randomUUID(),0,{text:'test',vector:[.25,.5,.75,.125]});
 assert.throws(()=>validateF06LancePilot({body:{...body,physicalCollectionName:'important'},headers:{'x-vecthare-f06-pilot':'1'}}),
  {code:'F06_PILOT_REQUEST_INVALID'});
 assert.equal((await pilotCall(router,context,body,{})).statusCode,403);
 assert.equal((await pilotCall(router,context,body,{'x-vecthare-f06-pilot':'1','sec-fetch-site':'cross-site'})).statusCode,403);
 assert.equal((await pilotCall(router,{...context,userScopeId:'mallory'},body)).statusCode,403); // source binding belongs to alice
 assert.equal(hits,0);
 const file=path.join(context.vectorsPath,'.similharity','f03-provisions',identity.key+'.json');
 const receipt=JSON.parse(await fs.readFile(file,'utf8'));
 await fs.writeFile(file,JSON.stringify({...receipt,state:'UNCERTAIN'}));
 const result=await pilotCall(router,context,body);assert.equal(result.body.code,'F06_F03_RECEIPT_REQUIRED');
 assert.equal((await backend.getDatabase('transformers')).tables.get(identity.physicalName).rows.size,0);
}));
import {registerF02Routes} from '../lib/f02-public-reads.js';
test('F06 F02 LanceDB public reads select the requested embedding-source database, never first cached db',async()=>{
 const b={...binding};const src={kind:'chat',avatar:'abc.png',chatFile:'saved'};
 const body={backend:'lancedb',source:src,embedding,configId:'default'};
 const backend=fakeLance();await create(backend,b);
 const previous=await backend.getDatabase('unrelated');assert.notEqual(previous,await backend.getDatabase('transformers'));
 const router=mockRouter(),connections=[];
 const handler=registerF02Routes(router,{backendPool:{async get(){return backend;}},
  attest:async()=>({binding:b}),makeReadAdapter:(_backend,transport)=>{
   connections.push(transport.db);return {inspectSchema:async()=>({schemaInspected:true}),
    listPage:async()=>({items:[],hasMore:false,inventoryVerified:false})};}});
 const out=response();await handler('list',{s03:ctx,body:{...body,page:{limit:5}}},out);
 assert.equal(out.statusCode,200,JSON.stringify(out.body));
 assert.equal(connections[0],await backend.getDatabase('transformers'));
 assert.notEqual(connections[0],previous);
});

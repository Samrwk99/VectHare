import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runMilvusF09c9HostProbe,validateF09c9Options,F09C9_CONSENT} from '../lib/f09c9-milvus-host-probe.js';
const status={error_code:0};
function entries(expr){return expr.split(' && ').map(part=>{const m=part.match(/^([A-Za-z]+) == (.*)$/);if(!m)throw Error('invalid filter');return [m[1],JSON.parse(m[2])];});}
function mock({failInsert=false}={}){
 let name=null, fields=null, index=false;const records=new Map(),calls=[];
 const match=(r,expr)=>entries(expr).every(([k,v])=>r[k]===v);
 const result=(kind,fn,fields)=>async args=>{calls.push({kind,args});if(kind==='insert'&&failInsert)throw Object.assign(Error('injected'),{code:'ECONNRESET'});
  fn(args);return {status,[`${kind}_cnt`]:'1',err_index:[]};};
 const client={
 async listCollections(){calls.push({kind:'listCollections'});return {status,data:name?[{name}]:[]};},
 async createCollection(args){calls.push({kind:'createCollection',args});if(name)throw Error('exists');name=args.collection_name;fields=args.fields;return {status};},
 async describeCollection(args){calls.push({kind:'describeCollection',args});if(!name||args.collection_name!==name)throw Error('missing');return {status,schema:{fields,autoID:false}};},
 async createIndex(args){calls.push({kind:'createIndex',args});index=true;return {status};},
 async describeIndex(args){calls.push({kind:'describeIndex',args});return {status,index_descriptions:index?[{field_name:'vector',params:[{key:'metric_type',value:'COSINE'}]}]:[]};},
 async loadCollection(args){calls.push({kind:'loadCollection',args});return {status};},
 async query(args){calls.push({kind:'query',args});if(args.collection_name!==name)throw Error('other collection');return {status,data:[...records.values()].filter(r=>match(r,args.filter)).slice(args.offset??0,(args.offset??0)+(args.limit??100)).map(r=>structuredClone(r))};},
 async search(args){calls.push({kind:'search',args});return {status,results:[...records.values()].filter(r=>match(r,args.filter)).slice(0,args.limit).map(r=>({...structuredClone(r),score:.9}))};},
 insert:result('insert',a=>{for(const r of a.data)records.set(r.physicalId,structuredClone(r));}),
 upsert:result('upsert',a=>{for(const r of a.data)records.set(r.physicalId,structuredClone(r));}),
 deleteEntities:result('delete',a=>{for(const [id,r] of records)if(match(r,a.filter))records.delete(id);})
 };
 return {client,config:{address:'127.0.0.1:19530'},calls,records,get collection(){return name;}};
}

async function sandbox(fn){const parent=await fs.mkdtemp(path.join(os.tmpdir(),'vh-f09c9-'));try{return await fn(parent);}finally{await fs.rm(parent,{recursive:true,force:true});}}
function sdk(backend){const instantiations=[];class MilvusClient {constructor(opts){instantiations.push(opts);Object.assign(this,backend.client);this.closeConnection=async()=>{};}}return {module:{MilvusClient},instantiations};}
const disposable=parent=>({parent,mode:'disposable',consent:F09C9_CONSENT});
test('F09c.9 strict local address, mode, private root and explicit consent',()=>{
 for(const parent of ['x','/','/tmp/../tmp',null])assert.throws(()=>validateF09c9Options({parent}),/F09C9_ABSOLUTE_PRIVATE_PARENT_REQUIRED/);
 for(const address of ['https://127.0.0.1:19530','example.com:19530','0.0.0.0:19530','127.0.0.1:0','localhost:65536','::1:19530'])assert.throws(()=>validateF09c9Options({parent:'/tmp/private',address}),/F09C9_LOCAL_MILVUS_ADDRESS_REQUIRED/);
 assert.throws(()=>validateF09c9Options({parent:'/tmp/private',mode:'disposable'}),/F09C9_CONSENT_REQUIRED/);
 assert.throws(()=>validateF09c9Options({parent:'/tmp/private',consent:F09C9_CONSENT}),/F09C9_PREFLIGHT_CONSENT_FORBIDDEN/);
 assert.throws(()=>validateF09c9Options({parent:'/tmp/private',mode:'invalid'}),/F09C9_MODE_INVALID/);
});
test('F09c.9 preflight only loads SDK; does not instantiate client, contact server, create locks',()=>sandbox(async parent=>{
 const m=mock(),s=sdk(m),prior=await fs.readdir(parent);
 const r=await runMilvusF09c9HostProbe({parent},async()=>s.module);
 assert.equal(r.status,'PREFLIGHT_ONLY');assert.equal(r.productionPermission,false);
 assert.equal(r.backendCertified,false);assert.equal(r.externalWritersProtected,false);
 assert.equal(s.instantiations.length,0);assert.deepEqual(m.calls,[]);assert.deepEqual(await fs.readdir(parent),prior);
}));
test('F09c.9 no installed SDK returns bounded nonauthorizing result',()=>sandbox(async parent=>{
 const r=await runMilvusF09c9HostProbe(disposable(parent),async()=>{throw Error('missing')});
 assert.equal(r.status,'SDK_UNAVAILABLE');assert.equal(r.collection,null);assert.deepEqual(await fs.readdir(parent),[]);
}));
test('F09c.9 disposable covers real F08/S07 lifecycle with collection retained and no drops',()=>sandbox(async parent=>{
 const m=mock(),s=sdk(m);const r=await runMilvusF09c9HostProbe(disposable(parent),async()=>s.module);
 assert.equal(r.status,'DISPOSABLE_MILVUS_OBSERVED_NO_PRODUCTION_CERTIFICATION',JSON.stringify(r));
 assert.equal(r.productionPermission,false);assert.equal(r.realHostCertified,false);assert.equal(r.manualCleanupRequired,true);
 assert.equal(r.collection,m.collection);assert.ok(m.collection.startsWith('vh2_'));
 assert.ok(r.steps.some(x=>x.name==='stale_revision'&&x.status==='PASS'));
 assert.equal(m.records.size,0);assert.equal(m.calls.filter(c=>c.kind==='insert').length,1);
 assert.equal(m.calls.filter(c=>c.kind==='delete').length,1);
 assert.ok(m.calls.every(x=>x.kind!=='dropCollection'));
 assert.equal((await fs.readdir(path.join(parent,'writer-locks'))).filter(x=>x.endsWith('.lock')).length,0);
}));
test('F09c.9 uncertain insert retains writer lock, evidence, and collection',()=>sandbox(async parent=>{
 const m=mock({failInsert:true}),s=sdk(m),r=await runMilvusF09c9HostProbe(disposable(parent),async()=>s.module);
 assert.equal(r.status,'FAILED_OR_UNCERTAIN',JSON.stringify(r));assert.equal(r.collectionRetained,true);assert.equal(r.manualCleanupRequired,true);
 assert.equal(m.calls.filter(c=>c.kind==='insert').length,1);assert.equal(m.calls.filter(c=>c.kind==='delete').length,0);
 const locks=(await fs.readdir(path.join(parent,'writer-locks'))).filter(x=>x.endsWith('.lock'));assert.equal(locks.length,1);
 const entry=JSON.parse(await fs.readFile(path.join(parent,'writer-locks',locks[0]),'utf8'));assert.equal(entry.backend,'milvus');
}));
test('F09c.9 cannot certify fabricated success without exact scoped physical collection',()=>sandbox(async parent=>{
 const m=mock(),s=sdk(m);const r=await runMilvusF09c9HostProbe(disposable(parent),async()=>s.module,
 async()=>({success:true,collection:'victim',productionWritesEnabled:false,backendCertified:false,stages:[]}));
 assert.equal(r.status,'FAILED_OR_UNCERTAIN');assert.equal(m.calls.length,0);
 assert.equal((await fs.readdir(path.join(parent,'writer-locks'))).filter(x=>x.endsWith('.lock')).length,1);
}));
test('F09c.9 successful state cannot enable production permission even in injected scenario',()=>sandbox(async parent=>{
 const m=mock(),s=sdk(m);const r=await runMilvusF09c9HostProbe(disposable(parent),async()=>s.module,
 async(ctx,b,{runId})=>({success:true,collection:(await import('../lib/s02-identity.js')).collectionIdentity({backend:'milvus',scope:{userScopeId:ctx.userScopeId,collectionId:'f08_'+runId.replaceAll('-',''),type:'other',sourceId:'diagnostic_'+runId.replaceAll('-','')},embedding:{source:'diagnostic',model:'f08-milvus-four-dim',dimension:4,metric:'cosine'}}).physicalName,productionWritesEnabled:false,backendCertified:false,stages:[]}));
 assert.equal(r.status,'DISPOSABLE_MILVUS_OBSERVED_NO_PRODUCTION_CERTIFICATION');assert.equal(r.productionPermission,false);
}));
test('F09c.9 symlink root rejected before loading SDK',()=>sandbox(async parent=>{
 const link=path.join(path.dirname(parent),'vh-f09c9-link-'+path.basename(parent));await fs.symlink(parent,link);
 try{let loads=0;await assert.rejects(()=>runMilvusF09c9HostProbe(disposable(link),async()=>{loads++;return sdk(mock()).module;}),/F09C9_PARENT_SYMLINK_OR_NOT_DIRECTORY/);assert.equal(loads,0);}finally{await fs.unlink(link);}
}));
test('F09c.9 world-readable root rejected before loading SDK',()=>sandbox(async parent=>{
 await fs.chmod(parent,0o755);let loads=0;
 await assert.rejects(()=>runMilvusF09c9HostProbe({parent},async()=>{loads++;return sdk(mock()).module;}),/F09C9_PARENT_NOT_PRIVATE/);assert.equal(loads,0);
}));
test('F09c.9 invalid SDK contract cannot contact Milvus or provision data',()=>sandbox(async parent=>{
 const m=mock(),s=sdk(m);delete m.client.describeIndex;
 const r=await runMilvusF09c9HostProbe(disposable(parent),async()=>s.module);
 assert.equal(r.status,'FAILED_OR_UNCERTAIN');assert.equal(m.calls.length,0);
 assert.equal(r.productionPermission,false);
}));

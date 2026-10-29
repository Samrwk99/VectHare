/** F09c.7 administrator-only LanceDB disposable acceptance diagnostic.
 * No public routes; no production grant; never opens an existing database.
 * Each probe owns a fresh random directory and uses the F09c.5 cooperating lock.
 * Direct/uncooperating DB writers are outside the accepted guarantee.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {CooperativeWriterBoundary} from './f09c5-writer-boundary.js';
export const F09C7_CONSENT='CREATE_NEW_DISPOSABLE_LANCEDB';
const idPattern=/^vh_f09c7_disposable_[a-f0-9]{32}$/;
const sha=x=>createHash('sha256').update(x).digest('hex');
const err=code=>{const e=new Error(code);e.code=code;return e;};
export function validateF09c7Options(options={}){
 const {parent,mode='preflight',consent=null}=options;
 if(typeof parent!=='string'||!path.isAbsolute(parent)||parent!==path.resolve(parent)||parent===path.parse(parent).root)
  throw err('F09C7_ABSOLUTE_PRIVATE_PARENT_REQUIRED');
 if(!['preflight','disposable'].includes(mode))throw err('F09C7_MODE_INVALID');
 if(mode==='disposable'&&consent!==F09C7_CONSENT)throw err('F09C7_CONSENT_REQUIRED');
 if(mode==='preflight'&&consent!==null)throw err('F09C7_CONSENT_NOT_ALLOWED_IN_PREFLIGHT');
 return {parent,mode};
}
async function verifyParent(parent){
 // Verify *every* existing path component against symlink traversal. The
 // selected parent itself must be private; shared /tmp ancestors are allowed.
 let p=path.parse(parent).root;
 for(const c of path.relative(p,parent).split(path.sep).filter(Boolean)){
  p=path.join(p,c);const st=await fs.lstat(p);
  if(st.isSymbolicLink()||!st.isDirectory())throw err('F09C7_PARENT_SYMLINK_OR_NOT_DIRECTORY');
 }
 const st=await fs.lstat(parent);
 if(process.platform!=='win32'&&(st.mode&0o077)!==0)throw err('F09C7_PARENT_NOT_PRIVATE');
 if(await fs.realpath(parent)!==parent)throw err('F09C7_PARENT_ALIAS');
}
const readRows=async(table,predicate)=>{
 const rows=await table.query().where(predicate).toArray();
 return rows;
};
const sameRow=(rows,text,revision)=>rows.length===1&&rows[0].text===text&&Number(rows[0].revision)===revision;
const cleanError=e=>typeof e?.code==='string'&&/^F09C[57]_/.test(e.code)?e.code:'F09C7_BACKEND_ERROR_OR_UNCERTAIN';
export async function runLanceF09c7HostProbe(options={},loadSdk=()=>import('@lancedb/lancedb')){
 const {parent,mode}=validateF09c7Options(options);
 await verifyParent(parent);
 const result={checkpoint:'F09c.7',mode,status:'PREFLIGHT_ONLY',
  productionPermission:false,atomicBackendCertified:false,
  cooperatingWritersOnly:true,externalWritersProtected:false,
  realHostCertified:false,disposablePath:null,steps:[],
  manualCleanupRequired:false};
 let sdk;
 try{sdk=await loadSdk();if(typeof sdk?.connect!=='function')throw err('F09C7_SDK_INVALID');
  result.steps.push({name:'lancedb_sdk',status:'AVAILABLE'});
 }catch(e){result.status='SDK_UNAVAILABLE';result.steps.push({name:'lancedb_sdk',status:'FAILED',detail:cleanError(e)});return result;}
 if(mode==='preflight')return result;
 // mkdtemp is exclusive and never selects an existing database. The parent is
 // operator-provisioned and private. Never delete files automatically.
 const name='vh_f09c7_disposable_'+randomUUID().replaceAll('-','');
 if(!idPattern.test(name))throw err('F09C7_DISPOSABLE_NAME_INVALID');
 const dir=path.join(parent,name);
 try {await fs.mkdir(dir,{recursive:false,mode:0o700});}catch(e){
  result.status='FAILED_OR_UNCERTAIN';result.steps.push({name:'fresh_disposable_directory',status:'FAILED',detail:cleanError(e)});return result;
 }
 result.disposablePath=dir;result.manualCleanupRequired=true;
 result.steps.push({name:'fresh_disposable_directory',status:'CREATED'});
 const tableName='vh_f09c7_probe';
 const lock=new CooperativeWriterBoundary({root:path.join(parent,'writer-locks'),backend:'lancedb',physicalName:tableName+'_'+name.slice(-12)});
 const plan={backend:'lancedb',physicalCollectionName:lock.physicalName,collectionKey:sha(JSON.stringify([dir,tableName]))};
 // All mutations in this disposable sequence occur within the cooperating lock.
 // Errors preserve lock and disposable data to prevent silent retry or erasure.
 try{
  const out=await lock.withWriteBoundary(plan,async()=>{
   const db=await sdk.connect(dir);
   if((await db.tableNames()).includes(tableName))throw err('F09C7_TABLE_COLLISION');
   const row1={id:1,text:'probe-a',revision:1,vector:[0.1,0.2,0.3]};
   const table=await db.createTable(tableName,[row1]);
   if(!sameRow(await readRows(table,'id = 1'),'probe-a',1))throw err('F09C7_CREATE_READBACK_FAILED');
   result.steps.push({name:'create_readback',status:'PASS'});
   await table.add([{id:2,text:'probe-b',revision:1,vector:[0.2,0.3,0.4]}]);
   if(!sameRow(await readRows(table,'id = 2'),'probe-b',1))throw err('F09C7_ADD_READBACK_FAILED');
   result.steps.push({name:'add_readback',status:'PASS'});
   await table.update({where:'id = 1 AND revision = 1',values:{text:'probe-a2',revision:2}});
   if(!sameRow(await readRows(table,'id = 1'),'probe-a2',2))throw err('F09C7_UPDATE_READBACK_FAILED');
   result.steps.push({name:'update_readback',status:'PASS'});
   await table.update({where:'id = 1 AND revision = 1',values:{text:'stale-write',revision:3}});
   if(!sameRow(await readRows(table,'id = 1'),'probe-a2',2))throw err('F09C7_STALE_REVISION_NOT_REFUSED');
   result.steps.push({name:'stale_revision_refused',status:'PASS'});
   await table.delete('id = 2 AND revision = 1');
   if((await readRows(table,'id = 2')).length!==0||!sameRow(await readRows(table,'id = 1'),'probe-a2',2))
    throw err('F09C7_SCOPED_DELETE_READBACK_FAILED');
   result.steps.push({name:'scoped_delete_readback',status:'PASS'});
   return {state:'VERIFIED'};
  });
  if(out?.state!=='VERIFIED')throw err('F09C7_WRITE_NOT_VERIFIED');
  result.status='DISPOSABLE_LANCEDB_OBSERVED_NO_PRODUCTION_CERTIFICATION';
 }catch(e){result.status='FAILED_OR_UNCERTAIN';result.steps.push({name:'disposable_sequence',status:'FAILED',detail:cleanError(e)});}
 return result;
}

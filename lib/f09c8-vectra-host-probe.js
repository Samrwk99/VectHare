/** F09c.8 — administrator-only plugin Vectra host diagnostic.
 * Creates exactly one new disposable index in a private operator-selected parent.
 * Never opens normal vector data or SillyTavern native Standard indexes.
 * All probe writes share the F09c.5 cooperating-writer lock. Neither success
 * nor matching readback authorizes production mutations or external-writer CAS.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {CooperativeWriterBoundary} from './f09c5-writer-boundary.js';

export const F09C8_CONSENT='CREATE_NEW_DISPOSABLE_PLUGIN_VECTRA';
const sha=x=>createHash('sha256').update(x).digest('hex');
const error=code=>Object.assign(new Error(code),{code});
const safeCode=e=>typeof e?.code==='string'&&/^F09C[58]_/.test(e.code)?e.code:'F09C8_BACKEND_ERROR_OR_UNCERTAIN';
const NAME=/^vh_f09c8_disposable_[0-9a-f]{32}$/;
export function validateF09c8Options({parent,mode='preflight',consent=null}={}){
 if(typeof parent!=='string'||!path.isAbsolute(parent)||parent!==path.resolve(parent)||parent===path.parse(parent).root)
  throw error('F09C8_ABSOLUTE_PRIVATE_PARENT_REQUIRED');
 if(!['preflight','disposable'].includes(mode))throw error('F09C8_MODE_INVALID');
 if(mode==='disposable'&&consent!==F09C8_CONSENT)throw error('F09C8_CONSENT_REQUIRED');
 if(mode==='preflight'&&consent!==null)throw error('F09C8_PREFLIGHT_CONSENT_FORBIDDEN');
 return {parent,mode};
}
async function secureParent(parent){
 let p=path.parse(parent).root;
 for(const part of path.relative(p,parent).split(path.sep).filter(Boolean)){
  p=path.join(p,part);const st=await fs.lstat(p);
  if(!st.isDirectory()||st.isSymbolicLink())throw error('F09C8_PARENT_SYMLINK_OR_NOT_DIRECTORY');
 }
 if(await fs.realpath(parent)!==parent)throw error('F09C8_PARENT_ALIAS');
 const st=await fs.lstat(parent);
 if(process.platform!=='win32'&&(st.mode&0o077)!==0)throw error('F09C8_PARENT_NOT_PRIVATE');
}
function validateIndex(index){
 if(!index||['isIndexCreated','createIndex','beginUpdate','endUpdate','cancelUpdate',
  'insertItem','getItem','upsertItem','deleteItem','listItems'].some(k=>typeof index[k]!=='function'))
  throw error('F09C8_INDEX_API_UNSUPPORTED');
 return index;
}
async function transact(index,fn){
 await index.beginUpdate();
 try{await fn();await index.endUpdate();}
 catch(e){try{await index.cancelUpdate();}catch{}throw e;}
}
const isRecord=(item,id,revision,text)=>item?.id===id&&item?.metadata?.revision===revision&&item?.metadata?.text===text;
const sameIndexItem=(items,id)=>Array.isArray(items)&&items.filter(x=>x?.id===id).length===1;

export async function runVectraF09c8HostProbe(options={},loadSdk=()=>import('vectra')){
 const {parent,mode}=validateF09c8Options(options);
 await secureParent(parent);
 const result={checkpoint:'F09c.8',mode,status:'PREFLIGHT_ONLY',productionPermission:false,
  backendCertified:false,realHostCertified:false,cooperatingWritersOnly:true,
  externalWritersProtected:false,nativeStandardTouched:false,disposablePath:null,
  manualCleanupRequired:false,steps:[]};
 let sdk;
 try {
  sdk=await loadSdk();
  const LocalIndex=sdk?.LocalIndex??sdk?.default?.LocalIndex;
  if(typeof LocalIndex!=='function')throw error('F09C8_SDK_INVALID');
  sdk={LocalIndex};result.steps.push({name:'vectra_sdk',status:'AVAILABLE'});
 }catch(e){result.status='SDK_UNAVAILABLE';result.steps.push({name:'vectra_sdk',status:'FAILED',detail:safeCode(e)});return result;}
 if(mode==='preflight')return result;
 const name='vh_f09c8_disposable_'+randomUUID().replaceAll('-','');
 if(!NAME.test(name))throw error('F09C8_DISPOSABLE_NAME_INVALID');
 const folder=path.join(parent,name);
 // DO NOT create the index folder here; Vectra's createIndex owns it. Use a
 // fresh randomized name which must be absent (lstat, not access/follow).
 try{await fs.lstat(folder);throw error('F09C8_DISPOSABLE_COLLISION');}
 catch(e){if(e.code!=='ENOENT')throw e;}
 result.disposablePath=folder;
 const lock=new CooperativeWriterBoundary({root:path.join(parent,'writer-locks'),backend:'vectra',physicalName:name});
 const plan={backend:'vectra',physicalCollectionName:name,collectionKey:sha(JSON.stringify([parent,name,'plugin-vectra-only']))};
 // The Vectra lock namespace is distinct from native SillyTavern Standard.
 let mutationDispatched=false;
 try{
  const locked=await lock.withWriteBoundary(plan,async()=>{
   const index=validateIndex(new sdk.LocalIndex(folder));
   if(await index.isIndexCreated()!==false)throw error('F09C8_INDEX_COLLISION');
   mutationDispatched=true;result.manualCleanupRequired=true;
   await index.createIndex({version:1});
   if(await index.isIndexCreated()!==true)throw error('F09C8_CREATE_NOT_PERSISTED');
   result.steps.push({name:'create_index',status:'PASS'});
   const id=randomUUID(),vector=[0.1,0.2,0.3,0.4];
   const row1={id,vector,metadata:{revision:1,text:'f09c8-a',probe:'F09c.8'}};
   await transact(index,()=>index.insertItem(row1));
   if(!isRecord(await index.getItem(id),id,1,'f09c8-a'))throw error('F09C8_INSERT_READBACK_FAILED');
   result.steps.push({name:'insert_readback',status:'PASS'});
   if(!sameIndexItem(await index.listItems(),id))throw error('F09C8_LIST_READBACK_FAILED');
   result.steps.push({name:'list_readback',status:'PASS'});
   const reopened=validateIndex(new sdk.LocalIndex(folder));
   if(await reopened.isIndexCreated()!==true||!isRecord(await reopened.getItem(id),id,1,'f09c8-a'))
    throw error('F09C8_REOPEN_READBACK_FAILED');
   result.steps.push({name:'reopen_readback',status:'PASS'});
   // Revision check is made while holding the cooperating lock; the Vectra
   // driver itself does NOT provide an external-writer CAS guarantee.
   const original=await reopened.getItem(id);
   if(original?.metadata?.revision!==1)throw error('F09C8_REVISION_CONFLICT');
   await transact(reopened,()=>reopened.upsertItem({...original,metadata:{...original.metadata,revision:2,text:'f09c8-b'}}));
   if(!isRecord(await reopened.getItem(id),id,2,'f09c8-b'))throw error('F09C8_UPDATE_READBACK_FAILED');
   result.steps.push({name:'update_readback',status:'PASS'});
   // The stale revision MUST refuse before dispatch; the absence of an
   // atomic Vectra CAS is explicitly recorded as a scope limitation.
   const staleExpectedRevision=1;
   const after=await reopened.getItem(id);
   if(after?.metadata?.revision===staleExpectedRevision)throw error('F09C8_STALE_REVISION_NOT_REFUSED');
   if(!isRecord(after,id,2,'f09c8-b'))throw error('F09C8_STALE_GUARD_CHANGED_RECORD');
   result.steps.push({name:'cooperating_stale_revision_refused',status:'PASS'});
   if((await reopened.getItem(id))?.metadata?.revision!==2)throw error('F09C8_DELETE_REVISION_MISMATCH');
   await transact(reopened,()=>reopened.deleteItem(id));
   const afterDelete=new sdk.LocalIndex(folder);
   if(await afterDelete.getItem(id)!==undefined&&await afterDelete.getItem(id)!==null)
    throw error('F09C8_DELETE_READBACK_FAILED');
   if((await afterDelete.listItems()).some(x=>x?.id===id))throw error('F09C8_DELETE_LIST_FAILED');
   result.steps.push({name:'delete_readback',status:'PASS'});
   return {state:'VERIFIED'};
  });
  if(locked?.state!=='VERIFIED')throw error('F09C8_UNKNOWN_RESULT');
  result.status='DISPOSABLE_VECTRA_OBSERVED_NO_PRODUCTION_CERTIFICATION';
 }catch(e){result.status='FAILED_OR_UNCERTAIN';result.steps.push({name:'disposable_sequence',status:'FAILED',detail:safeCode(e)});
  // Preserve uncertain evidence. A failure prior to lock acquisition may leave
  // no folder; never claim a missing folder is a completed cleanup.
  result.manualCleanupRequired ||= mutationDispatched;
 }
 return result;
}

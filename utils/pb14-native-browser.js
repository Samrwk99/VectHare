/** P-B.14 bounded Qdrant physical page read. A native page never certifies
 * whole-collection ownership, inventory count, or page-to-page consistency. */
import {guardedVectorFetch} from './e02-vector-request-gateway.js';
export const PB14_URL='/api/plugins/similharity/v2/pb14/qdrant/physical-page';
const KEY=/^[a-f0-9]{64}$/;
const CURSOR=/^[-_A-Za-z0-9]+\.[-_A-Za-z0-9]+$/;
export function validatePB14NativePage(p){
 if(!p||p.success!==true||p.readOnly!==true||p.backend!=='qdrant'||
    p.inventoryKind!=='SCOPED_NATIVE_PHYSICAL_PAGE'||p.inventoryVerified!==false||
    p.physicalInventoryComplete!==false||p.ownerVerified!==false||
    p.scopeVerified!==true||p.recordsVerified!==true||
    p.consistency!=='UNVERIFIED_BETWEEN_PAGES'||p.totalRecords!==null||
    !KEY.test(p.logicalKey??'')||!KEY.test(p.sourceFingerprint??'')||
    !KEY.test(p.registryFingerprint??'')||
    !Number.isSafeInteger(p.routingGeneration)||p.routingGeneration<0||
    p.pageSize!==50||!Number.isSafeInteger(p.examined)||p.examined<0||
    !Array.isArray(p.records)||p.records.length>50||p.examined<p.records.length||
    (p.nextCursor!==null&&(typeof p.nextCursor!=='string'||p.nextCursor.length>2048||!CURSOR.test(p.nextCursor)))||
    (p.nextCursor!==null&&(!p.records.length||p.pageComplete!==false))||
    (p.nextCursor===null&&p.pageComplete!==true)||
    !p.records.every(r=>r&&typeof r.recordId==='string'&&r.recordId.length>0&&
     Number.isSafeInteger(r.revision)&&r.revision>0&&KEY.test(r.textHash??'')&&
     KEY.test(r.metadataHash??'')&&typeof r.textPreview==='string'&&r.textPreview.length<=160&&
     typeof r.textTruncated==='boolean'&&Array.isArray(r.metadataKeys)&&r.metadataKeys.length<=24&&
     r.metadataKeys.every(k=>typeof k==='string'))||
    new Set(p.records.map(r=>r.recordId)).size!==p.records.length)
   throw Error('PB14_NATIVE_PAGE_UNVERIFIED');
 return p;
}
export async function readPB14NativePage({source,configId='default',cursor=null,headers={},fetchImpl=globalThis.fetch}){
 if(!['default','local'].includes(configId)||!source||typeof source!=='object'||Array.isArray(source))
  throw Error('PB14_SELECTOR_INVALID');
 const response=await guardedVectorFetch(PB14_URL,{method:'POST',credentials:'same-origin',cache:'no-store',
  headers:{...headers,'Content-Type':'application/json'},
  body:JSON.stringify({backend:'qdrant',source,configId,...(cursor?{cursor}:{})})},fetchImpl);
 let result;try{result=await response.json();}catch{throw Error('PB14_RESPONSE_INVALID');}
 if(!response.ok||result?.success!==true)throw Error(result?.code??'PB14_READ_REFUSED');
 return validatePB14NativePage(result);
}

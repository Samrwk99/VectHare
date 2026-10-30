/** P-B.10. Owner-scoped, whole-physical collection read-only browser.
 * Reuses the M3/M4 proof-producing scanners, not a client-side filtered list.
 * Every page re-attests the complete inventory, source, registry and generation.
 * This bounded scanner refuses collections >20k; no silent truncation.
 */
import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {readM3ManagedInventory} from './m3-collections.js';
import {previewM4aLance} from './m4a-lancedb-lifecycle.js';
import {previewM4bVectra} from './m4b-vectra-lifecycle.js';
import {previewM4cMilvus} from './m4c-milvus-lifecycle.js';
const SECRET=randomBytes(32); // per-process; cursors fail closed after a restart
const KEY=/^[a-f0-9]{64}$/;
const BACKENDS=new Set(['qdrant','lancedb','vectra','milvus']);
const fail=(code,status=409)=>{throw Object.assign(new Error(code),{code,status});};
const obj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const sourceFields={chat:['kind','avatar','chatFile'],'group-chat':['kind','groupId','chatFile'],lorebook:['kind','name']};
function validate(body){
 if(!obj(body)||Object.keys(body).some(k=>!['backend','configId','source','cursor'].includes(k))||
    !BACKENDS.has(body.backend)||!obj(body.source))fail('PB10_SELECTOR_INVALID',400);
 const fields=sourceFields[body.source.kind];
 if(!fields||Object.keys(body.source).length!==fields.length||
    fields.some(k=>typeof body.source[k]!=='string'||!body.source[k]||body.source[k].length>220)||
    Object.keys(body.source).some(k=>!fields.includes(k))||
    ![undefined,'default',...(body.backend==='qdrant'?['local']:[])].includes(body.configId)||
    (body.cursor!==undefined&&(typeof body.cursor!=='string'||body.cursor.length>2048||
    !/^[-_A-Za-z0-9]+\.[-_A-Za-z0-9]+$/.test(body.cursor))))fail('PB10_SELECTOR_INVALID',400);
 return {backend:body.backend,configId:body.configId??'default',source:body.source};
}
const b64=x=>Buffer.from(x).toString('base64url');
const mac=s=>createHmac('sha256',SECRET).update(s).digest('base64url');
function token(payload){const raw=b64(JSON.stringify(payload));return `${raw}.${mac(raw)}`;}
function decode(cursor){
 const [raw,sig]=cursor.split('.');
 const expected=mac(raw);if(!sig||Buffer.byteLength(sig)!==Buffer.byteLength(expected)||
    !timingSafeEqual(Buffer.from(sig),Buffer.from(expected)))fail('PB10_CURSOR_INVALID',400);
 let p;try{p=JSON.parse(Buffer.from(raw,'base64url').toString('utf8'));}catch{fail('PB10_CURSOR_INVALID',400);}
 if(!obj(p)||!Number.isSafeInteger(p.offset)||p.offset<1||p.offset>20000||
    typeof p.proof!=='string'||!KEY.test(p.proof))fail('PB10_CURSOR_INVALID',400);
 return p;
}
// Every field is server-owned; no vectors, credentials, physical names, or raw metadata.
function publicRow(row){
 const r=row?.payload;
 if(!obj(r)||typeof r.recordId!=='string'||!r.recordId||
   typeof r.physicalId!=='string'||r.physicalId!==row.id||
   !Number.isSafeInteger(r.revision)||r.revision<1||!KEY.test(r.textHash??'')||
   !KEY.test(r.metadataHash??'')||typeof r.text!=='string')fail('PB10_RECORD_UNVERIFIED');
 return {recordId:r.recordId,revision:r.revision,textHash:r.textHash,
  metadataHash:r.metadataHash,textPreview:r.text.slice(0,160),textTruncated:r.text.length>160,
  metadataKeys:Object.keys(r.metadata??{}).filter(k=>typeof k==='string').slice(0,24)};
}
const readers={qdrant:(req,deps)=>readM3ManagedInventory(req,deps,{includeRows:true}),
 lancedb:(req,deps)=>previewM4aLance(req,deps,{includeRows:true}),
 vectra:(req,deps)=>previewM4bVectra(req,deps,{includeRows:true}),
 milvus:(req,deps)=>previewM4cMilvus(req,deps,{includeRows:true})};
/** Shared, verified, whole-collection proof. Callers must not treat a saved-source
 * listing or an arbitrary client's inventory as an authority for membership. */
export async function inspectPB10PhysicalProof(req,deps={}){
 if(!req?.s03?.userScopeId||!req?.user?.directories)fail('PB10_HOST_AUTH_REQUIRED',403);
 const selector=validate(req.body);
 const proof=await (deps.readPhysical?.[selector.backend]??readers[selector.backend])(
  {...req,body:selector},deps);
 if(proof?.backend!==selector.backend||!KEY.test(proof.logicalKey??'')||
   !KEY.test(proof.inventoryDigest??'')||!KEY.test(proof.sourceFingerprint??'')||
   !KEY.test(proof.registryFingerprint??'')||
   !Number.isSafeInteger(proof.routingGeneration)||proof.routingGeneration<0||
   proof.inventoryVerified!==true||proof.entirePhysicalCollectionVerified!==true||
   proof.exclusiveOwner!==true||!Array.isArray(proof.physicalRows)||
   proof.recordCount!==proof.physicalRows.length||proof.physicalRows.length>20000)
   fail('PB10_PHYSICAL_PROOF_UNVERIFIED');
 const records=proof.physicalRows.map(publicRow);
 if(new Set(records.map(r=>r.recordId)).size!==records.length)fail('PB10_DUPLICATE_RECORD');
 records.sort((a,b)=>a.recordId.localeCompare(b.recordId));
 return {selector,proof,records};
}
export async function browsePB10Physical(req,deps={}){
 validate(req?.body); // reject forged cursors before any expensive physical scan
 const cursor=req.body?.cursor?decode(req.body.cursor):null;
 const {selector,proof,records}=await inspectPB10PhysicalProof(req,deps);
 const fingerprint=createHmac('sha256',SECRET).update(JSON.stringify({
  owner:req.s03.userScopeId,selector,logicalKey:proof.logicalKey,
  generation:proof.routingGeneration,source:proof.sourceFingerprint,
  registry:proof.registryFingerprint,digest:proof.inventoryDigest,count:proof.recordCount
 })).digest('hex');
 if(cursor&&cursor.proof!==fingerprint)fail('PB10_CURSOR_STALE');
 const offset=cursor?.offset??0,limit=50;
 if(offset>records.length||cursor&&offset>=records.length)fail('PB10_CURSOR_OUT_OF_RANGE',400);
 const slice=records.slice(offset,offset+limit),end=offset+slice.length;
 return {readOnly:true,inventoryKind:'ENTIRE_OWNED_PHYSICAL_COLLECTION',
  physicalInventoryComplete:true,inventoryVerified:true,ownerVerified:true,
  backend:selector.backend,logicalKey:proof.logicalKey,routingGeneration:proof.routingGeneration,
  inventoryDigest:proof.inventoryDigest,sourceFingerprint:proof.sourceFingerprint,
  registryFingerprint:proof.registryFingerprint,totalRecords:records.length,offset,records:slice,
  pageComplete:end===records.length,nextCursor:end<records.length?token({offset:end,proof:fingerprint}):null,
  externalWriterExclusionCertified:false,productionCertified:false};
}
export function registerPB10PhysicalRoutes(router,deps={}){
 router.post('/v2/pb10/physical/browse',async(req,res)=>{
  try{res.json({success:true,...await browsePB10Physical(req,deps)});}
  catch(e){res.status(Number.isInteger(e.status)?e.status:409).json({success:false,
   code:/^(PB10_|M3_|M4[A-C]_|S05_|S08_|F09C)/.test(e.code??'')?e.code:'PB10_INVENTORY_REFUSED',
   readOnly:true,retryable:false});}
 });
}

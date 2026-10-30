/** P-B.14. Native Qdrant physical scrolling: bounded per-page verification.
 * This is NOT a proof of exclusive ownership or a consistent whole inventory.
 * The independent PB10 complete-prove scanner remains the only PB10 authority.
 */
import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {validateM3Selector,resolveM3NativePageContext,m3LedgerCheckpoint} from './m3-collections.js';
import {ownedRecord} from './s05-contract.js';
import {inspectQdrantV2Collection} from './s06-qdrant.js';
const SECRET=randomBytes(32);
const HEX=/^[a-f0-9]{64}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const fail=(code,status=409)=>{throw Object.assign(new Error(code),{code,status});};
const obj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const fingerprint=x=>createHmac('sha256',SECRET).update(JSON.stringify(x)).digest('hex');
const b64=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
const mac=x=>createHmac('sha256',SECRET).update(x).digest('base64url');
const sign=p=>{const raw=b64(p);return raw+'.'+mac(raw);};
function verify(raw){
 if(typeof raw!=='string'||raw.length>2048||!/^[-_A-Za-z0-9]+\.[-_A-Za-z0-9]+$/.test(raw))fail('PB14_CURSOR_INVALID',400);
 const [data,sig]=raw.split('.'),expected=mac(data);
 if(Buffer.byteLength(sig)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(sig),Buffer.from(expected)))fail('PB14_CURSOR_INVALID',400);
 let p;try{p=JSON.parse(Buffer.from(data,'base64url').toString('utf8'));}catch{fail('PB14_CURSOR_INVALID',400);}
 if(!obj(p)||p.v!==1||!HEX.test(p.binding??'')||!Number.isSafeInteger(p.count)||p.count<1||p.count>1000000||
    !Number.isSafeInteger(p.expires)||p.expires<Date.now()||p.expires>Date.now()+15*60*1000||
    !(typeof p.offset==='string'&&UUID.test(p.offset)||Number.isSafeInteger(p.offset)&&p.offset>=0)||
    !(typeof p.last==='string'&&UUID.test(p.last)))fail('PB14_CURSOR_INVALID',400);
 return p;
}
function validate(body){
 if(!obj(body)||Object.keys(body).some(k=>!['backend','configId','source','cursor'].includes(k)))fail('PB14_SELECTOR_INVALID',400);
 try{validateM3Selector({backend:body.backend,source:body.source,configId:body.configId});}catch{fail('PB14_SELECTOR_INVALID',400);}
 if(body.cursor!==undefined&&typeof body.cursor!=='string')fail('PB14_CURSOR_INVALID',400);
 return {backend:'qdrant',configId:body.configId??'default',source:body.source};
}
function publicRow(r){return {recordId:r.recordId,revision:r.revision,textHash:r.textHash,
 metadataHash:r.metadataHash,textPreview:r.text.slice(0,160),textTruncated:r.text.length>160,
 metadataKeys:Object.keys(r.metadata).slice(0,24)};}
/** Each request re-attests source/owner/generation and registry/ledger identity.
 * Out-of-process Qdrant changes between pages cannot be ruled out, so this
 * response deliberately NEVER sets inventoryVerified or ownerVerified true. */
export async function browsePB14NativeQdrant(req,deps={}){
 if(!req?.s03?.userScopeId||!req?.user?.directories)fail('PB14_HOST_AUTH_REQUIRED',403);
 const selector=validate(req.body),cursor=req.body.cursor?verify(req.body.cursor):null;
 const c=await (deps.resolveContext??resolveM3NativePageContext)({...req,body:selector},deps);
 const {binding,snapshot,managed,transport}=c;
 if(binding?.backend!=='qdrant'||binding.scope?.userScopeId!==req.s03.userScopeId||
    !HEX.test(binding.collection?.key??'')||!HEX.test(snapshot?.fileHash??'')||
    !HEX.test(managed?.fingerprint??'')||!obj(managed.records)||
    typeof transport?._request!=='function')fail('PB14_CONTEXT_UNVERIFIED');
 const checkpoint=await (deps.ledgerCheckpoint??m3LedgerCheckpoint)(req.s03,binding.collection.key,deps);
 if(!HEX.test(checkpoint?.digest??''))fail('PB14_LEDGER_UNVERIFIED');
 const bind=fingerprint({owner:req.s03.userScopeId,selector,logicalKey:binding.collection.key,
  generation:binding.collection.generation??0,source:snapshot.fileHash,registry:managed.fingerprint,ledger:checkpoint.digest});
 if(cursor&&cursor.binding!==bind)fail('PB14_CURSOR_STALE');
 if((await (deps.schemaCheck??inspectQdrantV2Collection)(transport,binding))?.schemaInspected!==true)
  fail('PB14_SCHEMA_UNVERIFIED');
 const query={limit:50,with_payload:true,with_vector:false};
 if(cursor)query.offset=cursor.offset;
 const result=await transport._request('POST',`/collections/${binding.collection.physicalName}/points/scroll`,query);
 const data=result?.result;
 if(!Array.isArray(data?.points)||data.points.length>50)fail('PB14_BACKEND_PAGE_INVALID');
 const hasMore=data.next_page_offset!==null&&data.next_page_offset!==undefined;
 if(hasMore&&(!data.points.length||!(typeof data.next_page_offset==='string'&&UUID.test(data.next_page_offset)||
   Number.isSafeInteger(data.next_page_offset)&&data.next_page_offset>=0)))fail('PB14_BACKEND_CURSOR_INVALID');
 const records=[],seen=new Set();let previous=cursor?.last??null;
 for(const row of data.points){
  if(typeof row?.id!=='string'||!UUID.test(row.id)||previous&&row.id.toLowerCase()<=previous.toLowerCase()||seen.has(row.id.toLowerCase()))fail('PB14_ORDER_UNVERIFIED');
  if(row.payload?.physicalId!==row.id)fail('PB14_PHYSICAL_ID_MISMATCH');
  const record=ownedRecord({...row.payload,physicalId:row.id},binding);
  const entry=managed.records[record.recordId],meta=record.metadata.vecthareRecordV2;
  if(!entry||entry.state!=='ACTIVE'||entry.contentHash!==record.textHash||entry.revision!==record.revision||
     !meta||meta.schemaVersion!==2||meta.recordId!==record.recordId||
     meta.identity?.userScopeId!==binding.scope.userScopeId||meta.identity?.sourceId!==binding.scope.sourceId||
     meta.contentHash!==record.textHash||meta.revision!==record.revision)fail('PB14_MANAGED_PROVENANCE_UNVERIFIED');
  records.push(publicRow(record));seen.add(row.id.toLowerCase());previous=row.id;
 }
 if(hasMore&&data.next_page_offset===cursor?.offset)fail('PB14_BACKEND_CURSOR_LOOP');
 // This detects in-flight managed ledger/registry/source changes during THIS page.
 const latest=await (deps.recheck??resolveM3NativePageContext)({...req,body:selector},deps);
 const endLedger=await (deps.ledgerCheckpoint??m3LedgerCheckpoint)(req.s03,binding.collection.key,deps);
 if(latest.binding?.collection?.physicalName!==binding.collection.physicalName||
    (latest.binding.collection.generation??0)!==(binding.collection.generation??0)||
    latest.snapshot?.fileHash!==snapshot.fileHash||latest.managed?.fingerprint!==managed.fingerprint||
    endLedger?.digest!==checkpoint.digest)fail('PB14_PAGE_STALE');
 const count=(cursor?.count??0)+records.length;
 const nextCursor=hasMore?sign({v:1,binding:bind,offset:data.next_page_offset,last:previous,
  count,expires:Date.now()+10*60*1000}):null;
 if(nextCursor?.length>2048)fail('PB14_BACKEND_CURSOR_INVALID');
 return {readOnly:true,backend:'qdrant',inventoryKind:'SCOPED_NATIVE_PHYSICAL_PAGE',
  physicalInventoryComplete:false,inventoryVerified:false,ownerVerified:false,
  scopeVerified:true,recordsVerified:true,consistency:'UNVERIFIED_BETWEEN_PAGES',
  logicalKey:binding.collection.key,routingGeneration:binding.collection.generation??0,
  sourceFingerprint:snapshot.fileHash,registryFingerprint:managed.fingerprint,
  records,pageSize:50,examined:count,pageComplete:!hasMore,nextCursor,
  totalRecords:null,externalWriterExclusionCertified:false,productionCertified:false};
}
export function registerPB14NativeRoutes(router,deps={}){
 router.post('/v2/pb14/qdrant/physical-page',async(req,res)=>{
  try{res.json({success:true,...await browsePB14NativeQdrant(req,deps)});}
  catch(e){res.status(Number.isInteger(e.status)?e.status:409).json({success:false,
   code:/^(PB14_|M3_|S05_)/.test(e.code??'')?e.code:'PB14_PAGE_UNVERIFIED',retryable:false,readOnly:true});}
 });
}

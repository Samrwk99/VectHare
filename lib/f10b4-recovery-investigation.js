/** F10b.4: private, read-only review of interrupted VectHare collection writes.
 * A forensic case is a hash-checked local review artifact, NOT independent
 * attestation, a backend read, a replay authorization, or permission to unlink.
 * This module never calls a database or modifies any runtime state.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {constants as C} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
const sha=x=>createHash('sha256').update(x).digest('hex');
const HEX=/^[0-9a-f]{64}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NAME=/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const BACKENDS=new Set(['qdrant','lancedb','vectra','milvus']);
const TERMINAL=new Set(['VERIFIED','FAILED']);
const PENDING=new Set(['PREPARED','SUBMITTED','UNCERTAIN']);
const MANAGED=new Set(['ACTIVE','DELETED','WRITE_PENDING','DELETE_PENDING']);
const MAX_FILE=1024*1024,MAX_FILES=600,MAX_BYTES=20*1024*1024;
export class RecoveryInvestigationError extends Error{
 constructor(code){super(code);this.code=code;this.status=409;}
}
const deny=code=>{throw new RecoveryInvestigationError(code);};
async function privateDir(dir){
 const st=await fs.lstat(dir);
 if(!st.isDirectory()||st.isSymbolicLink()||(process.platform!=='win32'&&(st.mode&0o077)))deny('F10B4_DIRECTORY_UNTRUSTED');
}
async function maybeDir(dir){try{await privateDir(dir);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
async function regular(file,limit=MAX_FILE){
 const st=await fs.lstat(file);
 if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>limit||
   (process.platform!=='win32'&&(st.mode&0o077)))deny('F10B4_FILE_UNTRUSTED');
 const fh=await fs.open(file,C.O_RDONLY|(C.O_NOFOLLOW??0));
 try{
  const fst=await fh.stat();
  if(st.ino!==fst.ino||st.dev!==fst.dev||st.size!==fst.size||fst.nlink!==1)deny('F10B4_SOURCE_CHANGED');
  const bytes=await fh.readFile();
  const end=await fh.stat();
  if(bytes.length!==fst.size||end.size!==fst.size||end.mtimeMs!==fst.mtimeMs)deny('F10B4_SOURCE_CHANGED');
  return bytes;
 }finally{await fh.close();}
}
function checkedJson(bytes){let value;try{value=JSON.parse(bytes.toString('utf8'));}catch{deny('F10B4_STATE_CORRUPT');}
 if(!value||typeof value!=='object'||Array.isArray(value))deny('F10B4_STATE_CORRUPT');return value;
}
function checkedReceipt(bytes,id,owner){
 const data=checkedJson(bytes),{checksum,...rest}=data;
 if(!HEX.test(checksum||'')||sha(JSON.stringify(rest))!==checksum||
  rest.schemaVersion!==4||rest.operationId!==id||rest.owner!==owner||
  !rest.plan||rest.plan.operationId!==id||rest.plan.scope?.userScopeId!==owner||
  !['PREPARED','SUBMITTED','UNCERTAIN','VERIFIED','FAILED'].includes(rest.state)||
  !BACKENDS.has(rest.plan.backend)||!HEX.test(rest.plan.collectionKey||'')||
  !NAME.test(rest.plan.physicalCollectionName||'')||!Array.isArray(rest.history))deny('F10B4_RECEIPT_INVALID');
 return rest;
}
function checkedRegistry(bytes,key,owner){
 const data=checkedJson(bytes),{checksum,...rest}=data;
 if(!HEX.test(checksum||'')||sha(JSON.stringify(rest))!==checksum||rest.schemaVersion!==1||
  rest.owner!==owner||rest.collectionKey!==key||typeof rest.sourceId!=='string'||
  !rest.records||typeof rest.records!=='object'||Array.isArray(rest.records)||
  Object.entries(rest.records).some(([id,record])=>!UUID.test(id)||record?.recordId!==id||
   !MANAGED.has(record.state)||!HEX.test(record.contentHash||'')||
   !Number.isSafeInteger(record.revision)||record.revision<0||
   (record.operationId!==null&&!UUID.test(record.operationId||''))))deny('F10B4_REGISTRY_INVALID');
 return rest;
}
async function snapshot({root,owner,backend,physicalName,key,operationId}){
 await privateDir(root);
 const base=path.join(root,'.similharity');
 if(!await maybeDir(base))deny('F10B4_STATE_UNAVAILABLE');
 const ledger=path.join(base,'s04-operations'),registries=path.join(base,'f09b4-managed');
 const locks=path.join(base,'f09c10-writer-locks');
 const rows=[],rawChecks=[];
 let scanned=0,total=0;
 if(await maybeDir(ledger)){
  const names=(await fs.readdir(ledger)).sort();
  for(const name of names){
   if(name.startsWith('.lock-')||name.startsWith('.tmp-'))deny('F10B4_TRANSIENT_STATE');
   if(!UUID.test(name.replace(/\.json$/,''))||!name.endsWith('.json'))deny('F10B4_LEDGER_UNEXPECTED_ENTRY');
   if(++scanned>MAX_FILES)deny('F10B4_LIMIT');
   const bytes=await regular(path.join(ledger,name));total+=bytes.length;
   if(total>MAX_BYTES)deny('F10B4_LIMIT');
   const receipt=checkedReceipt(bytes,name.slice(0,-5),owner);
   rawChecks.push(['ledger/'+name,sha(bytes)]);
   if(receipt.plan.collectionKey!==key)continue;
   if(receipt.plan.backend!==backend||receipt.plan.physicalCollectionName!==physicalName)deny('F10B4_COLLECTION_BINDING_CONFLICT');
   rows.push({operationId:receipt.operationId,state:receipt.state,action:receipt.plan.action});
  }
 }
 const ids=new Set(rows.map(r=>r.operationId));
 if(operationId && !ids.has(operationId))deny('F10B4_OPERATION_UNAVAILABLE');
 let pendingManaged=0,activeManaged=0,deletedManaged=0;
 if(await maybeDir(registries)){
  for(const name of (await fs.readdir(registries)).sort()){
   if(name.startsWith('.lock-')||name.startsWith('.tmp-'))deny('F10B4_TRANSIENT_STATE');
   if(!name.endsWith('.json')||!HEX.test(name.slice(0,-5)))deny('F10B4_REGISTRY_UNEXPECTED_ENTRY');
   if(++scanned>MAX_FILES)deny('F10B4_LIMIT');
   const bytes=await regular(path.join(registries,name));total+=bytes.length;
   if(total>MAX_BYTES)deny('F10B4_LIMIT');
   const registry=checkedRegistry(bytes,name.slice(0,-5),owner);
   rawChecks.push(['managed/'+name,sha(bytes)]);
   if(name!==key+'.json')continue;
   for(const entry of Object.values(registry.records)){
    if(entry.state==='ACTIVE')activeManaged++;
    else if(entry.state==='DELETED')deletedManaged++;
    else{
     pendingManaged++;
     if(!ids.has(entry.operationId))deny('F10B4_INTENT_WITHOUT_RECEIPT');
    }
   }
  }
 }
 let lockPresent=false,lockDigest=null;
 if(await maybeDir(locks)){
  const name='collection-'+sha(JSON.stringify([backend,physicalName]))+'.lock';
  // A foreign collection lock must not be touched or diagnosed as ours.
  if((await fs.readdir(locks)).includes(name)){
   const bytes=await regular(path.join(locks,name),4096);
   const doc=checkedJson(bytes);
   if(doc.schemaVersion!==1||doc.backend!==backend||doc.physicalNameHash!==sha(physicalName)||
    !Number.isSafeInteger(doc.pid)||doc.pid<=0)deny('F10B4_LOCK_INVALID');
   lockPresent=true;lockDigest=sha(bytes);rawChecks.push(['lock/'+name,lockDigest]);
  }
 }
 rows.sort((a,b)=>a.operationId.localeCompare(b.operationId));
 const pending=rows.filter(r=>PENDING.has(r.state));
 const classification=pending.length||pendingManaged ? 'UNRESOLVED_MUTATION_BLOCKED' :
   lockPresent?'RETAINED_LOCK_REQUIRES_HOST_REVIEW':'NO_RETAINED_LOCK_OBSERVED';
 const evidence={schemaVersion:1,collectionKey:key,backend,physicalNameHash:sha(physicalName),
  ownerHash:sha(owner),operationCount:rows.length,operations:rows,
  managed:{pending:pendingManaged,active:activeManaged,deleted:deletedManaged},
  lockPresent,lockDigest,classification,checks:rawChecks.sort((a,b)=>a[0].localeCompare(b[0])),
  liveUnlockAllowed:false,operationReplayAllowed:false,mutationStateChangeAllowed:false,
  authoritativeBackendOutcome:'NOT_ESTABLISHED'};
 return {...evidence,evidenceDigest:sha(JSON.stringify(evidence))};
}
async function fsyncDir(dir){if(process.platform==='win32')return;const fh=await fs.open(dir,'r');try{await fh.sync();}finally{await fh.close();}}
export class F10b4RecoveryInvestigation{
 constructor({vectorsPath,userScopeId,backend,physicalCollectionName,collectionKey}){
  if(!path.isAbsolute(vectorsPath||'')||typeof userScopeId!=='string'||!userScopeId||
   !BACKENDS.has(backend)||!NAME.test(physicalCollectionName||'')||!HEX.test(collectionKey||''))deny('F10B4_SCOPE_INVALID');
  this.vectorsPath=path.resolve(vectorsPath);this.owner=userScopeId;this.backend=backend;
  this.name=physicalCollectionName;this.key=collectionKey;
 }
 async inspect(operationId=null){
  if(operationId!==null&&!UUID.test(operationId))deny('F10B4_OPERATION_INVALID');
  const args={root:this.vectorsPath,owner:this.owner,backend:this.backend,
   physicalName:this.name,key:this.key,operationId};
  const first=await snapshot(args),second=await snapshot(args);
  if(first.evidenceDigest!==second.evidenceDigest)deny('F10B4_SOURCE_CHANGED');
  return second;
 }
 async stageCase({operationId=null,confirm}={}){
  if(confirm!=='REVIEW_ONLY_NO_UNLOCK_NO_REPLAY')deny('F10B4_CONSENT_REQUIRED');
  const evidence=await this.inspect(operationId);
  const base=path.join(this.vectorsPath,'.similharity');
  await privateDir(base);
  const cases=path.join(base,'f10b4-investigations');
  try{await fs.mkdir(cases,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
  await privateDir(cases);
  const id=randomUUID(),location=path.join(cases,id+'.json');
  const row={schemaVersion:1,id,scopeDigest:sha(JSON.stringify([this.owner,this.backend,this.name,this.key])),
   evidence,reviewOnly:true,liveUnlockAllowed:false,operationReplayAllowed:false};
  const copy=JSON.stringify(row),bytes=Buffer.from(JSON.stringify({...row,checksum:sha(copy)})+'\n');
  const handle=await fs.open(location,'wx',0o600);
  try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
  await fsyncDir(cases);
  const after=await this.inspect(operationId);
  if(after.evidenceDigest!==evidence.evidenceDigest)deny('F10B4_SOURCE_CHANGED');
  return {id,classification:evidence.classification,evidenceDigest:evidence.evidenceDigest,
   operationCount:evidence.operationCount,liveUnlockAllowed:false,operationReplayAllowed:false};
 }
 async verifyCase(id){
  if(!UUID.test(id||''))deny('F10B4_CASE_ID_INVALID');
  const base=path.join(this.vectorsPath,'.similharity');await privateDir(base);
  const cases=path.join(base,'f10b4-investigations');await privateDir(cases);
  const data=checkedJson(await regular(path.join(cases,id+'.json'))),{checksum,...row}=data;
  if(sha(JSON.stringify(row))!==checksum||row.schemaVersion!==1||row.id!==id||
   row.scopeDigest!==sha(JSON.stringify([this.owner,this.backend,this.name,this.key]))||
   row.reviewOnly!==true||row.liveUnlockAllowed!==false||row.operationReplayAllowed!==false||
   row.evidence?.evidenceDigest!==sha(JSON.stringify(Object.fromEntries(Object.entries(row.evidence).filter(([k])=>k!=='evidenceDigest')))))
   deny('F10B4_CASE_TAMPERED');
  return {id,classification:row.evidence.classification,evidenceDigest:row.evidence.evidenceDigest,
   locallyIntegrityChecked:true,independentlyAttested:false,liveUnlockAllowed:false,
   operationReplayAllowed:false};
 }
}

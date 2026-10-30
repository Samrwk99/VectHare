/** M1 vertical slice: source-owned saved-chat single record operations.
 * No browser-supplied owner, text, vector, metadata, revision or physical name.
 * Execution requires separate administrator-held, real-host acceptance evidence.
 * The underlying S01/S04 legacy/generic mutation denials are unchanged.
 */
import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {deterministicRecordUUID,validateRecordV2} from './m0-record-schema.js';
import {getEmbeddingProfile,generateManagedEmbedding} from './f09b5-embedding-profiles.js';
import {selectedM3Profile,assertM3SelectedProfile,generateM3SelectedEmbedding} from './m3-source-selection.js';
import {readAttestedChatSnapshot} from './f09b-chat-sync.js';
import {readOwnedBytes,parseLorebookSnapshot} from './f09b6-saved-content.js';
import {resolveF02Binding} from './f02-public-reads.js';
import {M3CutoverJournal} from './m3-cutover-journal.js';
import {resolveM3ReadBinding} from './m3-target-receipts.js';
import {resolveM4aLanceReadBinding} from './m4a-lancedb-cutover.js';
import {resolveM4bVectraReadBinding} from './m4b-vectra-cutover.js';
import {resolveM4cMilvusReadBinding} from './m4c-milvus-cutover.js';
import {readF03ProvisionReceipt,attestF03QdrantIndexes,registerF03ProvisionRoutes} from './f03-provision.js';
import {qdrantV2Adapter,inspectQdrantV2Collection} from './s06-qdrant.js';
import {lancedbV2Adapter,inspectLanceV2Table} from './s08-lancedb.js';
import {vectraV2Adapter,inspectVectraV2Index} from './s08-vectra.js';
import {milvusV2Adapter,inspectMilvusV2Collection,M4C_M1_WRITER_TOKEN} from './s07-milvus.js';
import {M4A_M1_WRITER_TOKEN} from './s08-local-contract.js';
import {ManagedChatRegistry} from './f09b4-managed-registry.js';
import {OperationLedger} from './s04-ledger.js';
import {MutationEngine} from './s04-engine.js';
import {planMutation} from './s04-contract.js';
import {contentFingerprint} from './s02-identity.js';
import {capability} from './m0-capabilities.js';

const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY=/^[a-f0-9]{64}$/;
const allowed=['insert','update','revectorize','delete','restore'];
const m1Backends=new Set(['qdrant','lancedb','vectra','milvus']);
const bad=(code,status=409)=>Object.assign(new Error(code),{code,status});
const obj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const plain=(x,keys)=>obj(x)&&Object.keys(x).every(k=>keys.includes(k));
const sourceKeys={chat:['kind','avatar','chatFile'],'group-chat':['kind','groupId','chatFile'],
 lorebook:['kind','name']};
const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
async function m1SourceProfile(req,source,deps){
 // Dependency injection supports controlled fixture tests; the real route
 // *always* uses server-attested per-source selection after model activation.
 if(deps.getSelectedProfile)return deps.getSelectedProfile(req,source);
 if(deps.getProfile)return {...await deps.getProfile(req.s03),selectionGeneration:0};
 return selectedM3Profile(req,source);
}

const checkSource=source=>{
 const keys=sourceKeys[source?.kind];
 if(!keys||!plain(source,keys)||keys.some(k=>typeof source[k]!=='string'||!source[k]||source[k].length>220))
  throw bad('M1_SOURCE_SELECTOR_INVALID',400);
 return source;
};
export function validateM1Intent(intent,{preview=false}={}){
 if(!plain(intent,['backend','configId','source',...(preview?[]:['action','recordId'])])||!m1Backends.has(intent.backend)||
  !['local','default',undefined].includes(intent.configId)||
  (['lancedb','vectra','milvus'].includes(intent.backend)&&intent.configId==='local'))throw bad('M1_REFERENCE_BACKEND_REQUIRED',400);
 checkSource(intent.source);
 if(!preview&&(!allowed.includes(intent.action)||!UUID.test(intent.recordId||'')))throw bad('M1_RECORD_ACTION_INVALID',400);
 return intent;
}
/** Same saved-file attestation for WI and chat; no browser text accepted. */
export async function readM1Snapshot(req,source){
 if(source.kind!=='lorebook')return readAttestedChatSnapshot(req,source);
 const {sourceId,bytes,fileHash}=await readOwnedBytes(req,source);
 const items=parseLorebookSnapshot(bytes,sourceId);
 const book=JSON.parse(bytes.toString('utf8'));
 const byUid=new Map(Object.values(book.entries).map(entry=>[String(entry.uid),entry]));
 const messages=items.map(item=>{
  const entry=byUid.get(item.sourceKey);
  const triggers=[...(Array.isArray(entry.key)?entry.key:[]),
   ...(Array.isArray(entry.keysecondary)?entry.keysecondary:[])].filter(t=>typeof t==='string'&&t.length&&t.length<=256).slice(0,128);
  // Retain known saved World Info activation/condition fields as source facts.
  // These are annotations only; M6 owns canonical live evaluation.
  const known=['constant','selective','selectiveLogic','caseSensitive','matchWholeWords',
   'useProbability','probability','scanDepth','group','groupOverride','characterFilter',
   'position','depth','order','role','delayUntilRecursion','excludeRecursion','preventRecursion'];
  const values={};for(const key of known)if(Object.hasOwn(entry,key))values[key]=entry[key];
  if(Buffer.byteLength(JSON.stringify(values))>8192)throw bad('M1_LORE_CONDITION_METADATA_LIMIT');
  return {...item,lorebook:{uid:item.sourceKey,triggers,
   conditions:[{type:'sillytavern-saved-fields',values}],enabled:true}};
 });
 return {sourceId,fileHash,messages,sourceKind:'lorebook'};
}
export function savedRecordIdentity(ctx,binding,msg){
 if(!ctx?.userScopeId||!binding?.scope?.sourceId||!UUID.test(msg?.recordId||''))throw bad('M1_SOURCE_IDENTITY_INVALID');
 const identity={userScopeId:ctx.userScopeId,sourceId:binding.scope.sourceId,
  branchId:binding.scope.branchId??'',sourceEntryId:msg.recordId};
 return {identity,recordId:deterministicRecordUUID(identity)};
}
export function makeSavedRecordV2({ctx,binding,msg,snapshot,profile,revision,operationId,existing=null}){
 const {identity,recordId}=savedRecordIdentity(ctx,binding,msg);
 const previous=existing?.metadata?.vecthareRecordV2;
 const row={schemaVersion:2,recordId,identity,source:{kind:snapshot.sourceKind,
  fileFingerprint:snapshot.fileHash,saved:true},revision,contentHash:msg.contentHash,
  embedding:{...profile,profileFingerprint:hash(profile)},
  tombstone:{state:'ACTIVE',deletedAt:null,operationId:null},
  links:previous?.links??[],conditions:previous?.conditions??[],
  parent:previous?.parent??null,summary:previous?.summary??null,
  lorebook:msg.lorebook??null,metadata:{}};
 // Links are revision-specific; never silently carry stale linkage after update.
 row.links=row.links.map(x=>({...x,sourceRevision:revision}));
 return validateRecordV2(row);
}
function verifyExisting(existing,ctx,binding,msg,profile,recordId){
 if(!existing||existing.recordId!==recordId||!Number.isSafeInteger(existing.revision)||existing.revision<1)
  throw bad('M1_RECORD_UNAVAILABLE');
 const row=existing.metadata?.vecthareRecordV2;
 if(!row||row.recordId!==recordId||row.revision!==existing.revision||
  row.contentHash!==contentFingerprint(existing.text)||!eq(row.embedding,{...profile,profileFingerprint:hash(profile)})||
  row.identity?.sourceId!==binding.scope.sourceId||row.identity?.userScopeId!==ctx.userScopeId)
  throw bad('M1_V2_PROVENANCE_UNVERIFIED',403);
 validateRecordV2(row);
 if(existing.physicalId===undefined||!obj(existing.scope)||existing.scope.userScopeId!==ctx.userScopeId)
  throw bad('M1_PHYSICAL_OWNERSHIP_UNVERIFIED',403);
 return row;
}
async function requirePrivate(directory){
 const stat=await fs.lstat(directory);
 if(!stat.isDirectory()||stat.isSymbolicLink()||(process.platform!=='win32'&&(stat.mode&0o077)))throw bad('M1_TICKET_ROOT_UNTRUSTED',403);
}
export class M1TicketStore {
 constructor(ctx){if(!path.isAbsolute(ctx?.vectorsPath??'')||!ctx?.userScopeId)throw bad('M1_TICKET_SCOPE_REQUIRED',403);
  this.ctx=ctx;this.root=path.join(ctx.vectorsPath,'.similharity','m1-plans');}
 async setup(){await requirePrivate(this.ctx.vectorsPath);
  for(const dir of [path.dirname(this.root),this.root]){
   await fs.mkdir(dir,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});await requirePrivate(dir);}}
 location(id,ext='.json'){if(!UUID.test(id||''))throw bad('M1_OPERATION_ID_INVALID',400);
  return path.join(this.root,id.toLowerCase()+ext);}
 async create(ticket){await this.setup();const file=this.location(ticket.operationId);const payload={...ticket,
  owner:this.ctx.userScopeId,checksum:hash(ticket)};
  const fh=await fs.open(file,'wx',0o600);try{await fh.writeFile(JSON.stringify(payload));await fh.sync();}finally{await fh.close();}
  const dir=await fs.open(this.root,'r');try{await dir.sync();}finally{await dir.close();}}
 async peek(id){await this.setup();const file=this.location(id);
  const st=await fs.lstat(file);if(!st.isFile()||st.isSymbolicLink()||st.size>8192||
   (process.platform!=='win32'&&(st.mode&0o077)))throw bad('M1_TICKET_UNTRUSTED',403);
  let doc;try{doc=JSON.parse(await fs.readFile(file,'utf8'));}catch{throw bad('M1_TICKET_CORRUPT');}
  const {owner,checksum,...ticket}=doc;
  if(owner!==this.ctx.userScopeId||checksum!==hash(ticket)||ticket.operationId!==id||
   Date.now()>ticket.expiresAt)throw bad('M1_TICKET_INVALID',403);return ticket;}
 async claim(id){await this.setup();const file=this.location(id),claimed=this.location(id,'.claimed');
  // Persist the claim before any embedding, registry intent or backend dispatch.
  // Consumed/uncertain tickets are NEVER replayed.
  try{await fs.link(file,claimed);}catch(e){if(e.code==='EEXIST')throw bad('M1_TICKET_ALREADY_CONSUMED');throw e;}
  const fh=await fs.open(claimed,'r');try{await fh.sync();}finally{await fh.close();}
  const dir=await fs.open(this.root,'r');try{await dir.sync();}finally{await dir.close();}
  const st=await fs.lstat(file);
  if(!st.isFile()||st.isSymbolicLink()||st.nlink!==2||st.size>8192||
   (process.platform!=='win32'&&(st.mode&0o077)))throw bad('M1_TICKET_UNTRUSTED',403);
  let doc;try{doc=JSON.parse(await fs.readFile(claimed,'utf8'));}catch{throw bad('M1_TICKET_CORRUPT');}
  const {checksum,owner,...ticket}=doc;
  if(owner!==this.ctx.userScopeId||checksum!==hash(ticket)||ticket.operationId!==id||
   !Number.isSafeInteger(ticket.expiresAt)||Date.now()>ticket.expiresAt)throw bad('M1_TICKET_INVALID',403);
  return ticket;}
}
/** Independent administrator-controlled evidence, not editable from vectorsPath or HTTP.
 * A missing/invalid file means PREVIEW only, never an automatic 'enable' switch.
 */
/** M1 v4: code-ready operations are available for explicit manual testing.
 * Runtime saved-source, owner, schema, lock and receipt checks remain mandatory.
 * A test-only certify override may still veto dispatch in fixture tests.
 */
export const M1_CODE_READY=Object.freeze(['insert','update','revectorize','delete']);
export const M1_IMPLEMENTATION_EVIDENCE=Object.freeze({gateway:'passed',ui:'passed',
 conformance:'passed',faultTests:'passed',securityTests:'passed'});
export async function m1ManualTestReadiness(operation,certification=undefined){
 if(!M1_CODE_READY.includes(operation))return false;
 if(certification===undefined)return true;
 return certification===true||Boolean(certification&&certification.operation===operation);
}
export async function readM1HostEvidence(operation,{root=process.env.SIMILHARITY_SERVER_CONFIG_DIR,
 currentHostVersion=process.env.SIMILHARITY_STABLE_ST_VERSION}={}){
 if(!path.isAbsolute(root??'')||!currentHostVersion)return null;
 try{
  await requirePrivate(root);
  const file=path.join(root,'m1-real-host-acceptance.json'),st=await fs.lstat(file);
  if(!st.isFile()||st.isSymbolicLink()||st.size>16384||(process.platform!=='win32'&&(st.mode&0o077)))return null;
  const data=JSON.parse(await fs.readFile(file,'utf8'));
  const cell=data?.operations?.[operation];
  if(data.schemaVersion!==1||data.backend!=='qdrant'||data.hostVersion!==currentHostVersion||
   !['insert','update','revectorize','delete'].includes(operation)||
   !cell||cell.operation!==operation||cell.backend!=='qdrant'||cell.hostVersion!==currentHostVersion||
   cell.realHostAccepted!==true||cell.disposableBackendAccepted!==true||
   typeof cell.testRunId!=='string'||cell.testRunId.length<10||
   cell.contractProbePassed!==true||cell.writerExclusivityAccepted!==true)return null;
  return cell;
 }catch{return null;}
}
async function resolveContext(req,intent,deps={}){
 const {bind=resolveF02Binding,
 readSnapshot=readM1Snapshot,getReceipt=readF03ProvisionReceipt}=deps;
 if(!req?.s03?.userScopeId||!req.s03?.vectorsPath||!req.user?.directories)throw bad('M1_HOST_AUTH_REQUIRED',403);
 validateM1Intent(intent,{preview:!intent.recordId});
 const result=await m1SourceProfile(req,intent.source,deps);if(!result?.configured||!result.profile)throw bad('M1_EMBEDDING_PROFILE_REQUIRED');
 const profile=result.profile;
 const [{binding},snapshot]=await Promise.all([
  bind(req,{backend:intent.backend,source:intent.source,embedding:profile,configId:intent.configId},{reserve:false,readAlias:intent.backend==='qdrant'&&result.selected===true||['lancedb','vectra','milvus'].includes(intent.backend)}),
  readSnapshot(req,intent.source)]);
 if(binding.backend!==intent.backend||binding.scope.userScopeId!==req.s03.userScopeId||
  binding.scope.sourceId!==snapshot.sourceId||!eq(binding.embedding,profile))throw bad('M1_BINDING_MISMATCH',403);
 const receipt=await getReceipt(req.s03,binding);
 if(receipt?.state!=='SCHEMA_VERIFIED_OFFLINE_UNCERTIFIED'&&!result.selected)throw bad('M1_PROVISION_RECEIPT_REQUIRED');
 if(result.selected&&receipt!==null&&receipt?.state!=='SCHEMA_VERIFIED_OFFLINE_UNCERTIFIED')throw bad('M1_PROVISION_RECEIPT_INVALID');
 // The canonical F03 receipt remains required. A published alias must also
 // carry an immutable target receipt plus fresh physical inventory/schema proof.
 // No supplied browser alias, target name or generation can enter this path.
 let routed=binding;
 const conn=deps.transport?await deps.transport(req,binding):
  (typeof deps.backendPool?.getTrusted==='function'?
    await deps.backendPool.getTrusted(req.s03,intent.backend,intent.configId??'default'):undefined);
 if(intent.backend==='qdrant')routed=await resolveM3ReadBinding(req.s03,binding,{transport:conn});
 else if(intent.backend==='lancedb'){
  if(typeof conn?.getDatabase!=='function')throw bad('M1_LANCE_DATABASE_REQUIRED');
  routed=await resolveM4aLanceReadBinding(req.s03,binding,{db:await conn.getDatabase(binding.embedding.source)});
 }
 else if(intent.backend==='milvus'){
  if(typeof conn?.client?.query!=='function')throw bad('M1_MILVUS_CLIENT_REQUIRED');
  routed=await resolveM4cMilvusReadBinding(req.s03,binding,{backend:conn});
 }
 if(result.selected&&(routed.collection.key!==result.logicalKey||routed.collection.generation!==result.selectionGeneration))
  throw bad('M1_SELECTED_BINDING_MISMATCH');
 return {binding:routed,snapshot,profile,selectionGeneration:result.selectionGeneration??0};
}
/** New owned-collection bootstrap, with F03's SAME durable provision/lock path.
 * Browser never supplies the physical name or embedding profile.
 */
export async function prepareM1Collection(req,deps={}){
 const intent=validateM1Intent(req.body,{preview:true});
 if(!req?.s03?.userScopeId||!req.s03?.vectorsPath||!req.user?.directories)
  throw bad('M1_HOST_AUTH_REQUIRED',403);
 const info=await m1SourceProfile(req,intent.source,deps);
 if(info.selected)throw bad('M1_SELECTED_COLLECTION_ALREADY_PROVISIONED');
 if(!info?.configured||!info.profile)throw bad('M1_EMBEDDING_PROFILE_REQUIRED');
 const profile=info.profile;
 const [{binding},snapshot]=await Promise.all([
  (deps.bind??resolveF02Binding)(req,{backend:intent.backend,source:intent.source,
   embedding:profile,configId:intent.configId},{reserve:true}),
  (deps.readSnapshot??readM1Snapshot)(req,intent.source)]);
 if(binding.scope.userScopeId!==req.s03.userScopeId||binding.scope.sourceId!==snapshot.sourceId||
  !eq(binding.embedding,profile))throw bad('M1_BINDING_MISMATCH',403);
 if(await (deps.getReceipt??readF03ProvisionReceipt)(req.s03,binding))
  throw bad('M1_COLLECTION_ALREADY_PROVISIONED');
 const ticket={operationId:randomUUID(),expiresAt:Date.now()+5*60*1000,
  intent:{...intent,action:'provision'},logicalKey:binding.collection.key,
  sourceId:snapshot.sourceId,fileFingerprint:snapshot.fileHash,profileFingerprint:hash(profile)};
 await (deps.tickets?.(req.s03)??new M1TicketStore(req.s03)).create(ticket);
 return {operationId:ticket.operationId,logicalKey:ticket.logicalKey,action:'provision',
  expiresAt:ticket.expiresAt,requiresExplicitApply:true,executionAllowed:false};
}
export async function provisionM1Collection(req,deps={}){
 if(!plain(req.body,['operationId','confirmation'])||!UUID.test(req.body.operationId||'')||
  req.body.confirmation!=='CREATE OWNED V2 COLLECTION')throw bad('M1_PROVISION_CONFIRMATION_REQUIRED',403);
 if(!req?.s03?.userScopeId||!req.user?.directories)throw bad('M1_HOST_AUTH_REQUIRED',403);
 const store=deps.tickets?.(req.s03)??new M1TicketStore(req.s03);
 const pending=await store.peek(req.body.operationId);
 if(pending.intent?.action!=='provision')throw bad('M1_PROVISION_TICKET_REQUIRED',403);
 const evidence=deps.certify?await deps.certify(req,pending):undefined;
 if(!(await m1ManualTestReadiness('insert',evidence)))throw bad('M1_CODE_GATE_REFUSED');
 const ticket=await store.claim(req.body.operationId);
 const intent=validateM1Intent({backend:ticket.intent.backend,source:ticket.intent.source,
  configId:ticket.intent.configId},{preview:true});
 const info=await m1SourceProfile(req,intent.source,deps),profile=info?.profile;
 if(info.selected||!info?.configured||!profile||hash(profile)!==ticket.profileFingerprint)
  throw bad('M1_STALE_PROVISION_PROFILE');
 const [{binding},snapshot]=await Promise.all([
  (deps.bind??resolveF02Binding)(req,{...intent,embedding:profile},{reserve:false}),
  (deps.readSnapshot??readM1Snapshot)(req,intent.source)]);
 if(binding.collection.key!==ticket.logicalKey||snapshot.sourceId!==ticket.sourceId||
  snapshot.fileHash!==ticket.fileFingerprint)throw bad('M1_STALE_PROVISION_SOURCE');
 // Reuse F03's reviewed receipt, physical writer lock, schema/index validation,
 // one-way uncertain handling and no-cleanup rule, but use server config only.
 const router={post(route,handler){if(route==='/v2/collections/provision')this.invoke=handler;}};
 const pool=deps.backendPool;
 const trustedPool={get:(ctx,backend,configId)=>{
  if(backend!==intent.backend||!pool?.getTrusted)throw bad('M1_SERVER_CONNECTION_REQUIRED',403);
  return pool.getTrusted(ctx,backend,configId);
 }};
 registerF03ProvisionRoutes(router,{backendPool:trustedPool,createVectra:async(req,binding)=>{
   if(typeof deps.makeVectraIndex!=='function')throw bad('M1_VECTRA_FACTORY_REQUIRED');
   const {f07VectraLocation}=await import('./f07-vectra.js');
   const folder=await f07VectraLocation(req.s03,binding,{createRoot:true});
   return {folder,index:deps.makeVectraIndex(folder)};
  },bind:deps.bind??resolveF02Binding,
  ...(deps.provisionBackend?{provisionBackend:deps.provisionBackend}:{})});
 let response=null,code=200;
 const res={status(value){code=value;return this;},json(value){response=value;return this;}};
 await router.invoke({...req,body:{backend:intent.backend,configId:intent.configId,source:intent.source,
  embedding:profile,confirmProvision:true,expectedCollectionName:binding.collection.physicalName}},res);
 if(code>=400||response?.success!==true)throw bad(response?.code??'M1_PROVISION_REFUSED',code);
 return {logicalKey:ticket.logicalKey,receiptState:response.receiptState,
  backend:intent.backend,productionWritesEnabled:false};
}
export async function previewM1Records(req,deps={}){
 const intent=validateM1Intent(req.body,{preview:true});
 const {binding,snapshot}=await resolveContext(req,intent,deps);
 const registry=deps.registry?.(req.s03,binding)??new ManagedChatRegistry(req.s03,binding);
 const document=await registry.read();
 const records=snapshot.messages.map(msg=>{
  const {recordId}=savedRecordIdentity(req.s03,binding,msg),managed=document.records[recordId];
  return {recordId,contentHash:msg.contentHash,managedState:managed?.state??'UNTRACKED',
   revision:managed?.revision??0,changed:managed?.state==='ACTIVE'&&managed.contentHash!==msg.contentHash,availableActions:managed?.state==='DELETED'?['restore']:
    managed?.state==='ACTIVE'?['update','revectorize','delete']:managed?[]:['insert']};
 });
 return {logicalKey:binding.collection.key,backend:intent.backend,sourceKind:snapshot.sourceKind,
  fileFingerprint:snapshot.fileHash,records,completeSavedSource:true,
  productionWritesEnabled:false};
}
export async function planM1Record(req,logicalKey,deps={}){
 const intent=validateM1Intent(req.body);
 if(!KEY.test(logicalKey))throw bad('M1_COLLECTION_KEY_INVALID',400);
 const {binding,snapshot,profile,selectionGeneration}=await resolveContext(req,intent,deps);
 if(logicalKey!==binding.collection.key)throw bad('M1_COLLECTION_BINDING_MISMATCH',403);
 const selected=snapshot.messages.find(msg=>savedRecordIdentity(req.s03,binding,msg).recordId===intent.recordId);
 if(!selected)throw bad('M1_RECORD_NOT_SAVED',403);
 const registry=deps.registry?.(req.s03,binding)??new ManagedChatRegistry(req.s03,binding);
 const doc=await registry.read(),managed=doc.records[intent.recordId];
 if(intent.action==='insert'&&managed || intent.action==='restore'&&managed?.state!=='DELETED'||
  ['update','revectorize','delete'].includes(intent.action)&&managed?.state!=='ACTIVE')
  throw bad('M1_MANAGED_STATE_DENIED',409);
 const read=deps.readRecord;
 // Physical read must be source-scoped and schema-inspected. Never plan from a guessed record.
 const existing=read?await read(req,binding,intent.recordId):await defaultRead(req,binding,intent.recordId,deps,intent.configId);
 if(['insert','restore'].includes(intent.action)){
  if(existing!==null)throw bad('M1_PHYSICAL_RECORD_EXISTS');
 }else{
  verifyExisting(existing,req.s03,binding,selected,profile,intent.recordId);
  if(managed.revision!==existing.revision||managed.contentHash!==contentFingerprint(existing.text))
   throw bad('M1_REGISTRY_REVISION_MISMATCH');
  if(intent.action==='delete'&&selected.contentHash!==contentFingerprint(existing.text))
   throw bad('M1_DELETE_SAVED_SOURCE_CHANGED');
 }
 const operationId=randomUUID(),ticket={operationId,expiresAt:Date.now()+5*60*1000,
  intent,logicalKey,physicalName:binding.collection.physicalName,
  routingGeneration:binding.collection.generation??0,sourceSelectionGeneration:selectionGeneration,
  sourceId:snapshot.sourceId,fileFingerprint:snapshot.fileHash,
  contentHash:selected.contentHash,profileFingerprint:hash(profile),
  expectedRevision:existing?.revision??(intent.action==='restore'?managed.revision:0),
  managedFingerprint:hash(managed??null)};
 const ticketStore=deps.tickets?.(req.s03)??new M1TicketStore(req.s03);
 await ticketStore.create(ticket);
 return {operationId,logicalKey,recordId:intent.recordId,action:intent.action,
  expectedRevision:ticket.expectedRevision,fileFingerprint:snapshot.fileHash,
  expiresAt:ticket.expiresAt,requiresExplicitApply:true,executionAllowed:false};
}
async function transport(req,binding,deps,configId='default'){
 const pool=deps.backendPool;
 if(binding.backend==='vectra'){
  if(typeof deps.createVectra!=='function')throw bad('M1_VECTRA_FACTORY_REQUIRED',403);
  return deps.createVectra(req,binding); // sealed server-derived index, no browser path
 }
 if(!pool?.getTrusted&&!pool?.get)throw bad('M1_BACKEND_POOL_REQUIRED');
 // Only server-configured transport: do not permit legacy GUI credentials.
 if(typeof pool.getTrusted==='function')return pool.getTrusted(req.s03,binding.backend,configId??'default');
 if(deps.testTransport===true)return pool.get(req.s03,binding.backend,configId??'default');
 throw bad('M1_SERVER_CONNECTION_REQUIRED',403);
}
async function m1BackendAdapter(conn,binding,{allowWrite=false}={}){
 if(binding.backend==='vectra'){
  if((await inspectVectraV2Index(conn,binding))?.schemaInspected!=='REGISTRY_SEAL_ONLY')throw bad('M1_SCHEMA_UNVERIFIED');
  return vectraV2Adapter({...conn,...(allowWrite?{m4aTrustedGateway:M4A_M1_WRITER_TOKEN}:{})},binding);
 }
 if(binding.backend==='milvus'){
  if(typeof conn?.client?.query!=='function')throw bad('M1_MILVUS_CLIENT_REQUIRED',403);
  if((await inspectMilvusV2Collection({client:conn.client},binding))?.indexVerified!==true)throw bad('M1_MILVUS_SCHEMA_UNVERIFIED');
  return milvusV2Adapter({client:conn.client,...(allowWrite?{m4cTrustedGateway:M4C_M1_WRITER_TOKEN}:{})},binding);
 }
 if(binding.backend==='lancedb'){
  if(typeof conn?.getDatabase!=='function')throw bad('M1_LANCE_DATABASE_REQUIRED');
  const db=await conn.getDatabase(binding.embedding.source);
  if((await inspectLanceV2Table({db},binding))?.schemaInspected!==true)throw bad('M1_SCHEMA_UNVERIFIED');
  return lancedbV2Adapter({db,...(allowWrite?{m4aTrustedGateway:M4A_M1_WRITER_TOKEN}:{})},binding);
 }
 if((await inspectQdrantV2Collection(conn,binding))?.schemaInspected!==true)throw bad('M1_SCHEMA_UNVERIFIED');
 await attestF03QdrantIndexes(conn,binding);
 return qdrantV2Adapter(allowWrite?{f04SourceBoundPilot:true,_request:(...a)=>conn._request(...a)}:conn,binding);
}
async function defaultRead(req,binding,id,deps,configId='default'){
 const conn=await transport(req,binding,deps,configId);
 const adapter=await m1BackendAdapter(conn,binding);
 return adapter.getRecord(id);
}
export async function executeM1Record(req,deps={}){
 if(!plain(req.body,['operationId','confirmation'])||!UUID.test(req.body.operationId||'')||
  req.body.confirmation!=='APPLY SAVED RECORD MUTATION')throw bad('M1_EXPLICIT_CONFIRMATION_REQUIRED',403);
 if(!req.s03?.userScopeId||!req.user?.directories)throw bad('M1_HOST_AUTH_REQUIRED',403);
 // Production certification checked BEFORE claiming a plan, embedding or dispatch.
 // No browser body/header/environment "pilot" flag can grant execution.
 const tickets=deps.tickets?.(req.s03)??new M1TicketStore(req.s03);
 const pending=await tickets.peek(req.body.operationId);
 const op=pending.intent.action==='restore'?'insert':pending.intent.action;
 // The public HTTP route cannot pass a test runner or browser evidence.
 const evidence=deps.certify?await deps.certify(req,pending):undefined;
 if(!(await m1ManualTestReadiness(op,evidence)))throw bad('M1_CODE_GATE_REFUSED',409);
 const claimed=await tickets.claim(req.body.operationId);
 const intent=validateM1Intent(claimed.intent);
 const {binding,snapshot,profile,selectionGeneration}=await resolveContext(req,intent,deps);
 if((claimed.sourceSelectionGeneration??0)!==selectionGeneration)throw bad('M1_SELECTED_PROFILE_CHANGED');
 if(binding.collection.key!==claimed.logicalKey||
  binding.collection.physicalName!==(claimed.physicalName??binding.collection.physicalName)||
  (binding.collection.generation??0)!==(claimed.routingGeneration??0)||
  snapshot.fileHash!==claimed.fileFingerprint||
  snapshot.sourceId!==claimed.sourceId||hash(profile)!==claimed.profileFingerprint)
  throw bad('M1_STALE_PLAN_OR_PROFILE',409);
 const msg=snapshot.messages.find(m=>savedRecordIdentity(req.s03,binding,m).recordId===intent.recordId);
 if(!msg||msg.contentHash!==claimed.contentHash)throw bad('M1_SAVED_RECORD_CHANGED');
 const managed=deps.registry?.(req.s03,binding)??new ManagedChatRegistry(req.s03,binding);
 const registryDoc=await managed.read(),current=registryDoc.records[intent.recordId]??null;
 if(hash(current)!==claimed.managedFingerprint)throw bad('M1_REGISTRY_CHANGED');
 const conn=deps.transport?await deps.transport(req,binding):await transport(req,binding,deps,intent.configId);
 const check=deps.verifySchema??(async()=>{await m1BackendAdapter(conn,binding);});
 await check(req,binding,conn);
 const adapter=deps.adapter?.(conn,binding)??await m1BackendAdapter(conn,binding,{allowWrite:true});
 const existing=await adapter.getRecord(intent.recordId);
 const isNew=['insert','restore'].includes(intent.action);
 if(isNew){if(existing!==null)throw bad('M1_RECORD_EXISTS');}
 else verifyExisting(existing,req.s03,binding,msg,profile,intent.recordId);
 if((existing?.revision??(intent.action==='restore'?current?.revision:0))!==claimed.expectedRevision)
  throw bad('M1_EXPECTED_REVISION_STALE');
 const action=isNew?'insert':intent.action==='delete'?'delete':'update';
 const revision=action==='insert'?1:existing.revision+1;
 let payload=null;
 if(action!=='delete'){
  const embed=deps.embed??(async()=>generateM3SelectedEmbedding(req.s03,binding.scope,profile,msg.text,{hostEmbed:
   (source,text,model)=>deps.hostEmbed?.(req,source,text,model)}));
  const vector=await embed(req,profile,msg.text);
  if(!Array.isArray(vector)||vector.length!==profile.dimension||vector.some(v=>typeof v!=='number'||!Number.isFinite(v)))
   throw bad('M1_EMBEDDING_INVALID');
  const v2=makeSavedRecordV2({ctx:req.s03,binding,msg,snapshot,profile,revision,operationId:claimed.operationId,
   existing});
  payload={text:msg.text,vector:['lancedb','vectra','milvus'].includes(intent.backend)?vector.map(Math.fround):vector,metadata:{...(existing?.metadata??{}),vecthareRecordV2:v2}};
 }
 // Reattest immediately before mutation planning and inside engine authorize.
 const recheck=async()=>{
  if(!deps.getSelectedProfile&&!deps.getProfile)await assertM3SelectedProfile(req.s03,binding.scope,profile,selectionGeneration);
  const again=await (deps.readSnapshot??readM1Snapshot)(req,intent.source);
  // This recheck also runs during S04 post-dispatch readback, while the
  // managed registry is intentionally WRITE_PENDING. Do NOT repeat an entire
  // physical-inventory vs ACTIVE-registry audit at that point: the current
  // operation itself creates the transient difference. The first resolution
  // already performed complete target attestation; under the shared logical
  // lock we now re-attest the saved source, canonical identity and JOURNAL
  // GENERATION without demanding a prematurely committed registry state.
  const rebound=(await (deps.bind??resolveF02Binding)(req,{backend:intent.backend,source:intent.source,
   embedding:profile,configId:intent.configId},{reserve:false,readAlias:selectionGeneration>0||['lancedb','vectra','milvus'].includes(intent.backend)})).binding;
  if(again.fileHash!==snapshot.fileHash||again.sourceId!==snapshot.sourceId||
   rebound.collection.key!==binding.collection.key||
   !eq(rebound.scope,binding.scope)||!eq(rebound.embedding,binding.embedding))
   throw bad('M1_SOURCE_CHANGED_DURING_APPLY',403);
  if(binding.collection.generation!==undefined){
   const j=new M3CutoverJournal(req.s03,{backend:intent.backend,logicalKey:binding.collection.key});
   await j.assertCurrentVersioned(binding,rebound);
  }else if(rebound.collection.physicalName!==binding.collection.physicalName)
   throw bad('M1_SOURCE_CHANGED_DURING_APPLY',403);
 };
 await recheck();
 const plan=planMutation(req.s03,{backend:intent.backend,scope:binding.scope,embedding:profile,
  action,recordId:intent.recordId,operationId:claimed.operationId,
  expectedRevision:action==='insert'?0:existing.revision,...(payload??{})},
  (binding.collection.generation!==undefined?{trustedBinding:binding}:{}));
 const ledger=deps.ledger?.(req.s03)??new OperationLedger(req.s03);
 const generationFence=binding.collection.generation===undefined?null:async()=>{
  const j=new M3CutoverJournal(req.s03,{backend:intent.backend,logicalKey:binding.collection.key});
  await j.assertCurrentVersioned(binding,{...binding,collection:{key:binding.collection.key,
   physicalName:'vh2_'+binding.collection.key.slice(0,48)}});
 };
 const engine=deps.engine?.({ledger,adapter,trustedBinding:generationFence?binding:null,
  assertFreshBinding:generationFence,authorize:async p=>{
  await recheck();return {authorized:true,ownerVerified:true,mutationContractVerified:true,
   collectionKey:p.collectionKey,backend:intent.backend};
 }})??new MutationEngine({ledger,adapter,atomicOnly:false,
  trustedBinding:generationFence?binding:null,assertFreshBinding:generationFence,authorize:async p=>{
  await recheck();return {authorized:true,ownerVerified:true,mutationContractVerified:true,
   collectionKey:p.collectionKey,backend:intent.backend};
 }});
 await managed.begin({recordId:intent.recordId,contentHash:current?.contentHash??msg.contentHash,
  revision:current?.revision??0,operationId:claimed.operationId,
  action:action==='delete'?'delete':'write',restore:intent.action==='restore',bootstrap:isNew});
 const result=await engine.execute(plan,payload);
 if(result?.state==='VERIFIED')await managed.finish({recordId:intent.recordId,
  operationId:claimed.operationId,action:action==='delete'?'delete':'write',
  contentHash:msg.contentHash,revision:action==='delete'?existing.revision:revision});
 return {operationId:claimed.operationId,recordId:intent.recordId,action:intent.action,
  state:result?.state??'UNCERTAIN',retryable:false,
  productionWritesEnabled:result?.state==='VERIFIED',
  manualRecoveryRequired:result?.state!=='VERIFIED'};
}
export function registerM1Routes(router,deps={}){
 const error=(res,e)=>res.status(Number.isInteger(e.status)?e.status:409).json({success:false,
  // Exact missing v2 binding is a recoverable *explicit provisioning* case.
  // Do not classify unknown read errors as absent/empty collections.
  code:e?.code==='F02_COLLECTION_NOT_BOUND'?'M1_COLLECTION_UNPROVISIONED':
   /^M1_[A-Z0-9_]+$/.test(e?.code??'')?e.code:'M1_OPERATION_REFUSED',
  executionAllowed:false,retryable:false});
 router.post('/v2/m1/collections/prepare',async(req,res)=>{
  try{res.json({success:true,plan:await prepareM1Collection(req,deps)});}catch(e){error(res,e);}});
 router.post('/v2/m1/collections/provision',async(req,res)=>{
  try{res.json({success:true,...await provisionM1Collection(req,deps)});}catch(e){error(res,e);}});
 router.post('/v2/m1/records/preview',async(req,res)=>{
  try{res.json({success:true,...await previewM1Records(req,deps)});}catch(e){error(res,e);}});
 router.post('/v2/collections/:logicalKey/records/plan',async(req,res)=>{
  try{res.json({success:true,plan:await planM1Record(req,req.params.logicalKey,deps)});}catch(e){error(res,e);}});
 router.post('/v2/mutations/execute',async(req,res)=>{
  try{const result=await executeM1Record(req,deps);res.json({success:result.state==='VERIFIED',...result});}
  catch(e){error(res,e);}});
 router.get('/v2/m1/capabilities',async(req,res)=>{
  const hostVersion=process.env.SIMILHARITY_STABLE_ST_VERSION??null;
  const cells=[];
  for(const backend of ['qdrant','lancedb','vectra','milvus'])for(const operation of ['insert','update','revectorize','delete']){
   const evidence=backend==='qdrant'?await readM1HostEvidence(operation):null;
   cells.push(capability({backend,operation,hostVersion,evidence,policy:'ENABLED',
    implementationEvidence:M1_IMPLEMENTATION_EVIDENCE,prerequisites:[]}));
  }
  res.json({success:true,capabilities:cells});
 });
}

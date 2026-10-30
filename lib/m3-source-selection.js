/** M3.5 source-scoped embedding selection. The *only* activation commit point
 * is an immutable per-source file, written after staged Qdrant target + F03
 * adoption are verified. The global user embedding profile is NOT modified.
 * A source-specific copy of the staged provider credential remains in the
 * user's private server config directory, never in VectHare responses.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {canonicalEmbedding} from './s02-identity.js';
import {getEmbeddingProfile,generateStagedEmbedding,generateManagedEmbedding,
 getStagedEmbeddingProfile,readM3StagedProviderConfiguration,generateM3ConfiguredEmbedding} from './f09b5-embedding-profiles.js';
import {attestHostSource} from './f01-host-sources.js';
const sha=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const bad=code=>Object.assign(new Error(code),{code,status:409});
const KEY=/^[a-f0-9]{64}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const privateDir=async dir=>{
 const st=await fs.lstat(dir);
 if(!st.isDirectory()||st.isSymbolicLink()||(process.platform!=='win32'&&(st.mode&0o077)))throw bad('M3_SELECTION_DIRECTORY_UNTRUSTED');
};
function scopeKey(ctx,scope){
 if(!ctx?.userScopeId||scope?.userScopeId!==ctx.userScopeId||!scope.sourceId||
  !['chat','group-chat','lorebook'].includes(scope.type))throw bad('M3_SELECTION_SCOPE_INVALID');
 return sha([ctx.userScopeId,scope.type,scope.collectionId,scope.sourceId,scope.branchId??'']);
}
async function folder(ctx,{create=false}={}){
 if(!path.isAbsolute(ctx?.vectorsPath??''))throw bad('M3_SELECTION_HOST_REQUIRED');
 if(create)await privateDir(ctx.vectorsPath);
 const parent=path.join(ctx.vectorsPath,'.similharity'),dir=path.join(parent,'m3-source-selections');
 if(!create){try{await privateDir(parent);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
 if(create){for(const p of [parent,dir]){await fs.mkdir(p,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});await privateDir(p);}}
 try{await privateDir(dir);}catch(e){if(e.code==='ENOENT'&&!create)return null;throw e;}
 return dir;
}
export async function readM3SourceSelection(ctx,scope){
 const key=scopeKey(ctx,scope),dir=await folder(ctx);
 if(!dir)return null;
 const file=path.join(dir,`m3-source-${key}.json`);
 let st;try{st=await fs.lstat(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}
 if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>16384||
  (process.platform!=='win32'&&(st.mode&0o077)))throw bad('M3_SELECTION_FILE_UNTRUSTED');
 let doc;try{doc=JSON.parse(await fs.readFile(file,'utf8'));}catch{throw bad('M3_SELECTION_FILE_CORRUPT');}
 const {seal,...data}=doc;
 if(seal!==sha(data)||data.schemaVersion!==1||data.owner!==ctx.userScopeId||data.scopeKey!==key||
  !KEY.test(data.fromLogicalKey??'')||!KEY.test(data.toLogicalKey??'')||
  !UUID.test(data.operationId??'')||data.generation!==1||
  !same(data.scope,scope)||!same(canonicalEmbedding(data.profile),data.profile)||
  data.profileHash!==sha(data.profile)||data.config?.version!==1||
  !same(data.config.profile,data.profile)||typeof data.config.credential!=='string')
  throw bad('M3_SELECTION_FILE_CORRUPT');
 // A crash after the single selection commit but before the lifecycle audit's
 // terminal checkpoint is NOT a completed activation. Never serve a selected
 // model or dispatch writes merely because the selection file exists.
 const {M3ExecutionAudit}=await import('./m3-execution-audit.js');
 const audit=new M3ExecutionAudit(ctx,{operationId:data.operationId,
  logicalKey:data.fromLogicalKey,action:'activate-rebuild'});
 const events=await audit.events();
 if(events.at(-1)?.stage!=='COMMITTED')throw bad('M3_SELECTION_ACTIVATION_REVIEW_REQUIRED');
 return data;
}
/** One-shot commitment; no overwrites, no browser supplied profile/credential.
 * A crash before this write leaves the old source selection intact. After it,
 * all M1/F02 flows use the new source identity and enforce generation fencing.
 */
export async function commitM3SourceSelection(ctx,{scope,operationId,fromLogicalKey,toLogicalKey,
 profile,config,sourceFingerprint}={}){
 const key=scopeKey(ctx,scope),dir=await folder(ctx,{create:true});
 if(!KEY.test(fromLogicalKey??'')||!KEY.test(toLogicalKey??'')||fromLogicalKey===toLogicalKey||
  !UUID.test(operationId??'')||!KEY.test(sourceFingerprint??'')||
  !same(canonicalEmbedding(profile),profile)||!same(config?.profile,profile)||
  config.version!==1||typeof config.credential!=='string')throw bad('M3_SELECTION_COMMIT_INVALID');
 const data={schemaVersion:1,owner:ctx.userScopeId,scope:structuredClone(scope),scopeKey:key,
  operationId,generation:1,fromLogicalKey,toLogicalKey,sourceFingerprint,
  profile:structuredClone(profile),profileHash:sha(profile),config:structuredClone(config),at:Date.now()};
 const file=path.join(dir,`m3-source-${key}.json`);
 let fd;try{fd=await fs.open(file,'wx',0o600);}catch(e){if(e.code==='EEXIST')throw bad('M3_SELECTION_ALREADY_ACTIVATED');throw e;}
 try{await fd.writeFile(JSON.stringify({...data,seal:sha(data)}));await fd.sync();}
 finally{await fd.close();}
 const d=await fs.open(dir,'r');try{await d.sync();}finally{await d.close();}
 return {scopeKey:key,generation:1,operationId,logicalKey:toLogicalKey,profile:structuredClone(profile)};
}
/** Resolve a scope only from the authenticated saved-source attestation. */
export async function selectedM3Profile(req,source,{attest=attestHostSource,getBase=getEmbeddingProfile}={}){
 const evidence=await attest(req,source);
 if(evidence?.status!=='HOST_FILE_OWNED'||evidence.hostSourceOwnerVerified!==true||
  evidence.scope?.userScopeId!==req?.s03?.userScopeId)throw bad('M3_SELECTION_SOURCE_NOT_ATTESTED');
 const selection=await readM3SourceSelection(req.s03,evidence.scope);
 if(selection)return {configured:true,profile:selection.profile,scope:evidence.scope,
  selectionGeneration:selection.generation,logicalKey:selection.toLogicalKey,selected:true};
 const original=await getBase(req.s03);
 return {...original,scope:evidence.scope,selectionGeneration:0,selected:false};
}
export async function assertM3SelectedProfile(ctx,scope,expectedProfile,expectedGeneration=0){
 const selection=await readM3SourceSelection(ctx,scope);
 if((selection?.generation??0)!==expectedGeneration||
  (selection!==null&&(!same(selection.profile,expectedProfile)||!KEY.test(selection.toLogicalKey))))
  throw bad('M3_SELECTION_GENERATION_CHANGED');
 if(!selection){const global=await getEmbeddingProfile(ctx);
  if(!same(global.profile,expectedProfile))throw bad('M3_SELECTION_BASE_PROFILE_CHANGED');}
 return selection;
}
export async function generateM3SelectedEmbedding(ctx,scope,profile,text,options={}){
 const selection=await readM3SourceSelection(ctx,scope);
 if(!selection)return generateManagedEmbedding(ctx,profile,text,options);
 if(!same(selection.profile,profile))throw bad('M3_SELECTION_EMBEDDING_PROFILE_MISMATCH');
 return generateM3ConfiguredEmbedding(selection.config,profile,text,options);
}
/** Server-only: never expose a credential or raw config in HTTP responses. */
export async function configurationForM3Activation(ctx,profile){
 const config=await readM3StagedProviderConfiguration(ctx);
 const advertised=await getStagedEmbeddingProfile(ctx);
 if(!same(config?.profile,profile)||!same(advertised.profile,profile))throw bad('M3_SELECTION_STAGED_CONFIG_CHANGED');
 return config;
}

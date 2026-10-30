/** F07 — local Vectra v2: new-only provisioning and authenticated receipt binding.
 * Independent native Standard routes are NOT included in this contract.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {readF03ProvisionReceipt} from './f03-provision.js';
import {inspectVectraV2Index} from './s08-vectra.js';
import {requireLocalBinding} from './s08-local-contract.js';
import {assertM3VersionedBinding} from './m3-versioned-binding.js';

export class F07VectraError extends Error {
 constructor(code,message,status=409){super(message);this.code=code;this.status=status;}
}
const reject=(code)=>new F07VectraError(code,code);
const schemaSeal=b=>Object.freeze({schemaVersion:2,provenance:'SERVER_REGISTRY',
 collectionKey:b.collection.key,physicalName:b.collection.physicalName,embedding:b.embedding});
async function secureDirectory(dir,{create=false}={}){
 if(create){try{await fs.mkdir(dir,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}}
 const st=await fs.lstat(dir);
 if(!st.isDirectory()||st.isSymbolicLink()||(process.platform!=='win32'&&(st.mode&0o077)))
  throw reject('F07_DIRECTORY_UNTRUSTED');
 return dir;
}
/** Server supplied context, no browser paths or collection names. */
export async function f07VectraLocation(context,binding,{createRoot=false}={}){
 const b=requireLocalBinding(binding,'vectra');
 if(typeof context?.vectorsPath!=='string'||!path.isAbsolute(context.vectorsPath))throw reject('F07_USER_ROOT_REQUIRED');
 await secureDirectory(context.vectorsPath);
 const root=path.join(context.vectorsPath,'vectra-v2');
 await secureDirectory(root,{create:createRoot});
 const folder=path.join(root,b.physicalName);
 if(path.dirname(folder)!==root)throw reject('F07_PATH_ESCAPE');
 return folder;
}
/** For creation: the target must not exist, and only the server chooses it. */
export async function provisionF07VectraV2Collection(transport,binding,context){
 const b=requireLocalBinding(binding,'vectra');
 if(typeof transport?.index?.createIndex!=='function'||typeof transport.index.isIndexCreated!=='function')
  throw reject('F07_TRANSPORT_INVALID');
 const folder=await f07VectraLocation(context,binding,{createRoot:true});
 try{await fs.lstat(folder);throw reject('F07_COLLECTION_EXISTS');}
 catch(e){if(e.code!=='ENOENT')throw e;}
 if(transport.folder!==folder)throw reject('F07_INDEX_PATH_MISMATCH');
 // The Vectra LocalIndex API creates a new folder with versioned index.json.
 await transport.index.createIndex({version:1});
 if(await transport.index.isIndexCreated()!==true)throw reject('F07_CREATE_UNVERIFIED');
 const entries=await transport.index.listItems?.();
 if(!Array.isArray(entries)||entries.length!==0)throw reject('F07_COLLECTION_NONEMPTY');
 return {status:'PROVISIONED_SOURCE_BOUND_UNCERTIFIED',physicalName:b.physicalName,
  schemaInspected:true,backendCertified:false,recordMutationsEnabled:false};
}
/** F02 and F07 pilot use this; a registry reservation alone is insufficient. */
export async function f07SealedVectra(req,binding,{createIndex,requireReceipt=true}={}){
 const b=requireLocalBinding(binding,'vectra');
 const folder=await f07VectraLocation(req.s03,binding);
 if(!requireReceipt){
  // Receipt bypass is ONLY for a process-local, server-journal-attested alias.
  if((binding.collection.generation??0)<1)throw reject('F07_TARGET_ATTESTATION_REQUIRED');
  assertM3VersionedBinding(binding);
 }
 if(requireReceipt){const receipt=await readF03ProvisionReceipt(req.s03,binding);
  if(receipt?.state!=='SCHEMA_VERIFIED_OFFLINE_UNCERTIFIED')throw reject('F07_PROVISION_RECEIPT_REQUIRED');}
 const stat=await fs.lstat(folder);
 if(!stat.isDirectory()||stat.isSymbolicLink())throw reject('F07_INDEX_UNTRUSTED');
 if(typeof createIndex!=='function')throw reject('F07_INDEX_FACTORY_REQUIRED');
 const index=await createIndex(folder);
 const backend={index,s08ServerSchema:schemaSeal(binding)};
 await inspectVectraV2Index(backend,binding);
 return backend;
}
export function f07SchemaSeal(binding){requireLocalBinding(binding,'vectra');return schemaSeal(binding);}

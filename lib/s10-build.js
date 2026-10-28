/** S10: self-reported, runtime-verified source inventory.
 * A matching local manifest is NOT remote attestation or proof of approved deployment.
 * Dependency contents, SillyTavern host, and backend services are not measured. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

export const S10_CONTRACT_VERSION=2;
export const S10_MANIFEST_FILE='S10-BUILD-MANIFEST.json';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const BASE_FILES=['index.js','qdrant-backend.js','milvus-backend.js','lancedb-backend.js','package.json'];
const digest=(x)=>createHash('sha256').update(x).digest('hex');

function safeRoot(root) {
  if(typeof root!=='string'||!path.isAbsolute(root)) throw new Error('S10_ROOT_REQUIRED');
  return path.resolve(root);
}
export async function runtimeSourceFiles(root=ROOT){
  root=safeRoot(root);
  const names=[];
  for(const file of BASE_FILES) {
    const full=path.join(root,file); const stat=await fs.lstat(full);
    if(!stat.isFile()||stat.isSymbolicLink()) throw new Error('S10_SOURCE_NOT_REGULAR');
    names.push(file);
  }
  async function walk(folder,relative){
    const entries=await fs.readdir(folder,{withFileTypes:true});
    for(const entry of entries){
      if(entry.isSymbolicLink()) throw new Error('S10_SOURCE_SYMLINK');
      const name=`${relative}/${entry.name}`;
      if(entry.isDirectory()) await walk(path.join(folder,entry.name),name);
      else if(entry.isFile() && /\.(?:js|mjs)$/.test(entry.name)) names.push(name);
      else if(!entry.isFile()) throw new Error('S10_SOURCE_INVALID_TYPE');
    }
  }
  await walk(path.join(root,'lib'),'lib');
  return names.sort();
}
export async function calculateSourceManifest(root=ROOT,version){
  root=safeRoot(root);
  const pkg=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
  if(typeof pkg.version!=='string'||!pkg.version.trim()) throw new Error('S10_VERSION_INVALID');
  if(version!==undefined && version!==pkg.version) throw new Error('S10_VERSION_MISMATCH');
  const names=await runtimeSourceFiles(root);
  const files={};
  for(const name of names) files[name]=digest(await fs.readFile(path.join(root,name)));
  const fingerprint=digest(names.map(name=>`${name}\0${files[name]}\n`).join(''));
  return {formatVersion:1,contractVersion:S10_CONTRACT_VERSION,pluginVersion:pkg.version,
    algorithm:'sha256',files,sourceFingerprint:fingerprint};
}
function sameManifest(expected,actual){
  if(!expected||typeof expected!=='object'||Array.isArray(expected)) return false;
  if(Object.keys(expected).sort().join('|')!==Object.keys(actual).sort().join('|')) return false;
  const keys=['formatVersion','contractVersion','pluginVersion','algorithm','sourceFingerprint'];
  if(keys.some(k=>expected[k]!==actual[k]))return false;
  const e=expected.files;
  if(!e||typeof e!=='object'||Array.isArray(e))return false;
  const names=Object.keys(actual.files).sort();
  return Object.keys(e).sort().join('|')===names.join('|') && names.every(k=>e[k]===actual.files[k]);
}
export async function loadS10Build(root=ROOT,version){
  root=safeRoot(root);
  const manifestPath=path.join(root,S10_MANIFEST_FILE);
  const stat=await fs.lstat(manifestPath);
  if(!stat.isFile()||stat.isSymbolicLink()) throw new Error('S10_MANIFEST_INVALID');
  const bytes=await fs.readFile(manifestPath);
  const expected=JSON.parse(bytes.toString('utf8'));
  const actual=await calculateSourceManifest(root,version);
  if(!sameManifest(expected,actual)) throw new Error('S10_BUILD_SOURCE_MISMATCH');
  return Object.freeze({pluginVersion:actual.pluginVersion,contractVersion:actual.contractVersion,
    fingerprint:actual.sourceFingerprint,manifestFingerprint:digest(bytes),
    sourceFiles:Object.keys(actual.files).length,
    verification:'MATCHED_LOCAL_SOURCE_MANIFEST',
    deploymentAttested:false,dependenciesAttested:false,hostAttested:false,
    liveBackendsCertified:false});
}

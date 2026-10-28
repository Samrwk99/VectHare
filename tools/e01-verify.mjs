/** E01 offline static audit verification. No network I/O and no backend mutation. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = name => JSON.parse(fs.readFileSync(path.join(root, 'docs/e01', name),'utf8'));
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const assert=(condition,message)=>{if(!condition)throw new Error(`E01 verification: ${message}`);};
const matrix=readJson('capability-matrix.json');
const inventory=readJson('plugin-call-inventory.json');
const evidence=readJson('source-evidence.json').evidence;
const hashes=readJson('plugin-source-fingerprints.json').files;
const backends=['standard','lancedb','qdrant','milvus'];
const statuses=['ALLOWED','GUARDED','DENIED','UNPROBED'];
const mutations=['insert','delete','purge','purgeAll','patchText','patchMetadata'];

export function verifyE01(){
 assert(matrix.enforcement==='not connected to runtime','E01 matrix must remain audit-only');
 assert(matrix.pluginServerAttestation==='NOT AVAILABLE','server deployment not authenticated');
 assert(matrix.operations.length>=20,'expected complete plugin operation taxonomy');
 assert(inventory.count===inventory.sites.length,'call inventory count mismatch');
 assert(new Set(inventory.sites.map(x=>x.id)).size===inventory.count,'duplicate call edge IDs');
 for(const backend of backends){
  const cells=matrix.backends[backend];assert(cells && Object.keys(cells).length===matrix.operations.length,`${backend} matrix incomplete`);
  for(const op of matrix.operations){
   const cell=cells[op];
   assert(cell && statuses.includes(cell.status),`${backend}/${op} status missing`);
   assert(Array.isArray(cell.sourceEvidence)&&cell.sourceEvidence.length>0,`${backend}/${op} no evidence`);
   assert(cell.sourceEvidence.every(id=>Object.hasOwn(evidence,id)),`${backend}/${op} invalid evidence reference`);
   assert(Array.isArray(cell.liveProbeEvidence)&&cell.liveProbeEvidence.length===0,`${backend}/${op} cannot claim live probe`);
   if(mutations.includes(op))assert(cell.effectiveMutationPermission===false,`${backend}/${op} mutation appears enabled`);
   if(['purge','purgeAll','patchText'].includes(op))assert(cell.status==='DENIED',`${backend}/${op} prohibited op not denied`);
  }
 }
 for(const [id,ref] of Object.entries(evidence)){
  assert(Number.isInteger(ref.line)&&ref.line>=1,`${id} invalid line anchor`);
  const supplied=ref.source==='plugin' ? hashes[ref.file]?.sha256 : null;
  if(supplied) assert(supplied===ref.sha256,`${id} hash mismatch`);
  if(ref.source==='extension'){
   const data=fs.readFileSync(path.join(root,ref.file));
   assert(sha(data)===ref.sha256,`${id} extension evidence file changed (reaudit required)`);
   assert(ref.line<=data.toString('utf8').split('\n').length,`${id} invalid extension line`);
  }
  assert(ref.runtimeProven===false,`${id} source evidence cannot claim runtime certification`);
 }
 const covered=new Map();
 for(const site of inventory.sites){
  const lines=fs.readFileSync(path.join(root,site.file),'utf8').split('\n');
  const current=lines[site.line-1];
  assert(current && current.trim().startsWith(site.expression),`${site.id} at ${site.file}:${site.line} source changed; regenerate inventory`);
  assert(site.apiSurface==='plugin'||site.apiSurface==='native-vector',`${site.id} unknown API surface`);
  const key=`${site.file}:${site.line}`;
  if(!covered.has(key))covered.set(key,[]);
  covered.get(key).push(site.url);
 }
 // Fail when a new source file or line introduces a direct plugin or native vector fetch.
 const walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>{
  if(e.name==='tests'||e.name==='node_modules'||e.name==='.git')return [];
  const loc=path.join(dir,e.name);
  return e.isDirectory()?walk(loc):(e.isFile()&&e.name.endsWith('.js')?[loc]:[]);
 });
 let calls=0;
 for(const file of walk(root)){
  const rel=path.relative(root,file).replaceAll(path.sep,'/');
  if(rel.startsWith('docs/'))continue;
  const lines=fs.readFileSync(file,'utf8').split('\n');
  for(let i=0;i<lines.length;i++){
   const line=lines[i];
   if(!/\bfetch\s*\(|\bfetchImpl\s*\(|\brequest\s*\(/.test(line))continue;
   if(line.trim().startsWith('//')||line.trim().startsWith('*'))continue;
   if(!line.includes('/api/plugins/similharity/')&&!line.includes('/api/vector/'))continue;
   const k=`${rel}:${i+1}`;
   assert(covered.has(k),`unrecorded plugin/native vector request at ${k}`);
   calls++;
  }
 }
 assert(calls>=70,'unexpectedly small direct network-call coverage');
 // These indirect paths are explicitly represented, rather than counted as direct URLs.
 for(const [file,line] of [['backends/standard.js',194],['diagnostics/infrastructure.js',130],['diagnostics/infrastructure.js',278],['core/emotion-classifier.js',111]]){
  assert(covered.has(`${file}:${line}`),`untracked indirect dispatch ${file}:${line}`);
 }
 const old=fs.readFileSync(path.join(root,'utils/backend-contracts.js'),'utf8');
 assert(old.includes("listPagination:'unknown'"),'E01 may not silently promote existing backend contracts');
 return {pass:true,backends:backends.length,cells:backends.length*matrix.operations.length,routeEdges:inventory.count,uniqueSourceSites:covered.size,directFetchLinesChecked:calls,evidenceRefs:Object.keys(evidence).length};
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{console.log(JSON.stringify(verifyE01(),null,2));}catch(e){console.error(e);process.exitCode=1;}
}

/** E02 static gate coverage: fail CI if an audited transport module loses the
 * E02 import. This complements runtime policy tests; does not prove a live host.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { E02_MATRIX_STATUS } from '../utils/e02-matrix-status.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const e01 = JSON.parse(fs.readFileSync(path.join(root,'docs/e01/plugin-call-inventory.json'),'utf8'));
const routes = e01.sites;
const safeAlias = /import\s*\{\s*guardedVectorFetch\s+as\s+fetch\s*\}\s*from\s*['"](?:\.\.\/|\.\/)utils\/e02-vector-request-gateway\.js['"]/;
const aliasException = new Map([
  ['core/emotion-embedding-provider.js',/import\s*\{\s*guardedVectorFetch\s*\}/],
  ['utils/c05-protected-credentials.js',/import\s*\{\s*guardedVectorFetch\s*\}/],
  ['core/emotion-classifier.js',/createPluginEmotionEmbedder\(/],
]);
const inspected = new Set();
const errors = [];
const found = new Set();
function checkFile(rel) {
  if (inspected.has(rel)) return;
  inspected.add(rel);
  const full = path.join(root,rel);
  if (!fs.existsSync(full)) {errors.push(`Missing audited module: ${rel}`);return;}
  const text = fs.readFileSync(full,'utf8');
  const exemption=aliasException.get(rel);
  if (!(safeAlias.test(text) || exemption?.test(text))) errors.push(`Unaudited plugin/native transport: ${rel}`);
  if (safeAlias.test(text)) found.add(rel);
  // No bypass using direct global/window fetch for known routes.
  if (/\b(?:globalThis|window)\.fetch\s*\(\s*[`'"].*\/api\/(?:vector\/|plugins\/similharity\/)/.test(text))
    errors.push(`Direct global/window fetch bypass: ${rel}`);
}
for (const site of routes) {
  checkFile(site.file);
}
// Scan every production JS file so new literal plugin/native fetch modules
// cannot escape merely because they were absent from the E01 inventory.
const walk = dir => {
  for (const entry of fs.readdirSync(dir,{withFileTypes:true})) {
    if (['tests','docs','node_modules','.git'].includes(entry.name)) continue;
    const dest = path.join(dir,entry.name);
    if (entry.isDirectory()) walk(dest);
    else if (entry.isFile() && dest.endsWith('.js')) {
      const rel = path.relative(root,dest).replaceAll(path.sep,'/');
      const text = fs.readFileSync(dest,'utf8');
      if (/\bfetch\s*\(\s*[`'"]\/?api\/(?:plugins\/similharity\/|vector\/)/.test(text)) checkFile(rel);
      if (/\brequest\s*\(\s*[`'"]\/?api\/plugins\/similharity\//.test(text)) checkFile(rel);
    }
  }
};
walk(root);
for (const [backend, cells] of Object.entries(E02_MATRIX_STATUS)) {
  for (const operation of ['insert','delete','purge','purgeAll','patchText','patchMetadata']) {
    if (!['DENIED','UNPROBED'].includes(cells[operation])) errors.push(`Unproven mutation unlocked: ${backend}/${operation}`);
  }
}
if (errors.length) throw new Error(`E02 gate verification failed:\n${errors.join('\n')}`);
returnVoid();
function returnVoid(){};
export const E02_STATIC_COVERAGE={e01Sites:routes.length,filesInspected:inspected.size,aliasedModules:found.size,pass:true};
if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url))
  process.stdout.write(`${JSON.stringify(E02_STATIC_COVERAGE,null,2)}\n`);

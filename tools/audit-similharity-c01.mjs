/** Read-only static source fingerprint audit. Never changes the plugin or promotes capabilities. */
import {readFile, readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const ledger=JSON.parse(await readFile(join(root,'tests/contracts/similharity-plugin-c01-source.json'),'utf8'));
const path=process.argv[2];
if (!path) {process.stderr.write('Usage: node tools/audit-similharity-c01.mjs <unpacked-plugin-directory>\n');process.exitCode=2;}
else {
 const sources={};let verified=true;const mismatches=[];
 for(const [name,expected] of Object.entries(ledger.sourceHashes)) {
  try {
   const source=await readFile(join(path,name));
   sources[name]=source.toString('utf8');
   const actual=createHash('sha256').update(source).digest('hex');
   if(actual!==expected) {mismatches.push({file:name,reason:'fingerprint-mismatch'});verified=false;}
  } catch (_) {mismatches.push({file:name,reason:'missing-or-unreadable'});verified=false;}
 }
 // Fingerprinting a known local source is NOT an attestation that it is deployed.
 const report={referenceMatched:verified, deployedVersionVerified:false,
  safeForLiveDeletion:false,capabilityPromotion:false,
  mismatches,observations:verified?ledger.backendDeletion:{},
  blockers:verified?ledger.requiredForActivation:['unknown-or-changed-plugin-source',...ledger.requiredForActivation]};
 process.stdout.write(JSON.stringify(report,null,2)+'\n');
}

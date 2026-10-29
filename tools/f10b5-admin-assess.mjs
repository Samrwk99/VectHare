#!/usr/bin/env node
/** F10b.5 read-only acceptance assessor; cannot authorize mutations/restores. */
import {assessF10b5HostEvidence} from '../lib/f10b5-acceptance.js';
import {loadS10Build} from '../lib/s10-build.js';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
try{
 const args=process.argv.slice(2);
 if(args.length!==2||args[0]!=='--evidence-root')throw Error('F10B5_CLI_INVALID');
 const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
 const pkg=await loadS10Build(root);
 const result=await assessF10b5HostEvidence({evidenceRoot:args[1],build:{pluginVersion:pkg.pluginVersion,
  extensionVersion:'2.2.0-alpha.s11.41-f10b5',pluginSourceFingerprint:pkg.fingerprint}});
 process.stdout.write(JSON.stringify(result,null,2)+'\n');
 if(!result.allBackendsReadyForManualReview)process.exitCode=2;
}catch(e){const code=/^F10B5_[A-Z_]+$/.test(e.code||e.message)?(e.code||e.message):'F10B5_CLI_FAILED';
 process.stderr.write(JSON.stringify({ok:false,code})+'\n');process.exitCode=1;}

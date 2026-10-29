#!/usr/bin/env node
/** F10b.10 admin-only, read-only, never certifies production or resolves locks. */
import {assessF10b10} from '../lib/f10b10-integrated-acceptance.js';
import {loadS10Build} from '../lib/s10-build.js';
try{
 const argv=process.argv.slice(2);if(argv.length!==2||argv[0]!=='--evidence-root')throw Error('F10B10_CLI_USAGE');
 const build=await loadS10Build();
 const result=await assessF10b10({evidenceRoot:argv[1],build:{pluginVersion:build.pluginVersion,
  extensionVersion:'2.2.0-alpha.s11.46-f10b10',pluginSourceFingerprint:build.fingerprint}});
 process.stdout.write(JSON.stringify(result,null,2)+'\n');
 if(result.reviewReady.length!==4)process.exitCode=2;
}catch(e){process.stderr.write(JSON.stringify({ok:false,code:/^F10B10_[A-Z_]+$/.test(e.code||e.message)?e.code||e.message:'F10B10_CLI_FAILURE'})+'\n');process.exitCode=1;}

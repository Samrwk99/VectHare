/** Offline S10/S11 contract compatibility verification; never contacts a host. */
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {validateS11Discovery,S11_EXPECTED_PLUGIN} from '../utils/s11-plugin-compatibility.js';
const pluginRoot=process.argv[2];
if(!pluginRoot){console.error('Usage: node tools/s11-verify-pair.mjs /absolute/path/to/extracted/VectHare-Similharity');process.exitCode=2;}
else {
  try{
    const root=path.resolve(pluginRoot);
    const buildModule=await import(pathToFileURL(path.join(root,'lib/s10-build.js')));
    const capsModule=await import(pathToFileURL(path.join(root,'lib/s10-contracts.js')));
    const build=await buildModule.loadS10Build(root,S11_EXPECTED_PLUGIN.pluginVersion);
    const actualBuild={pluginVersion:build.pluginVersion,contractVersion:build.contractVersion,
      sourceFingerprint:build.fingerprint,verification:build.verification};
    const status=validateS11Discovery(actualBuild,capsModule.S10Capabilities(build),capsModule.S10Contracts());
    if(!status.compatible||status.writeEnabled||status.publicV2ReadsEnabled)throw new Error(`S11_PAIR_REJECTED:${status.reason}`);
    console.log(JSON.stringify({pass:true,pluginVersion:build.pluginVersion,
      contractVersion:build.contractVersion,sourceFingerprint:build.fingerprint,
      compatible:true,inspectionOnly:true,writeEnabled:false,publicV2ReadsEnabled:false,
      installedHostAttested:false,liveBackendVerified:false},null,2));
  }catch(error){console.error(error?.message || String(error));process.exitCode=1;}
}

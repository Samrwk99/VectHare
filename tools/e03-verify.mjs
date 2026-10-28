/** E03 source integration audit. Offline evidence only, not a SillyTavern host probe. */
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=relative=>readFileSync(path.join(root,relative),'utf8');
const checks={
  journalCreateReadback:/async create\(header\)[\s\S]*?const saved=await this\.get\(value\.operationId\)/.test(source('utils/c02-operation-journal.js')),
  journalUpdateReadback:/this\.get\(value\.operationId\)\.then\(saved/.test(source('utils/c02-operation-journal.js')),
  c02MutationLockInjected:/mutationLock=withCollectionLock/.test(source('utils/c02-replacement.js')),
  productionC02CrossTab:/mutationLock:withCrossTabMutationLock/.test(source('core/core-vector-api.js')),
  primaryInsertCrossTab:/return await withCrossTabMutationLock\(key,async\(\)=>\{/.test(source('core/core-vector-api.js')),
  deletionCrossTab:/mutationLock:withCrossTabMutationLock/.test(source('core/collection-loader.js')),
  markerReadback:/store\.getItem\(markerKey\)===snapshot/.test(source('core/job-context.js')),
  deferredWriteRefusedWhenMarkerLost:/typeof operationPromise==='function'/.test(source('core/job-context.js')),
  startupReadOnlyRecovery:/buildRecoveryReport\(/.test(source('index.js')),
  sharedPhysicalLock:/shared:\$\{parsed\.backend\}/.test(source('utils/e03-mutation-lock.js')),
  noUnsafeHostSettingsAssumption:/server-readback-not-configured/.test(source('utils/e03-persistence.js')),
};
const verdict={checkpoint:'E03',offlineOnly:true,checks,pass:Object.values(checks).every(Boolean)};
process.stdout.write(JSON.stringify(verdict,null,2)+'\n');
if(!verdict.pass)process.exitCode=1;

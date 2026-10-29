#!/usr/bin/env node
/** Private F10b.4 investigation tool; NEVER unlocks, reconciles, or mutates. */
import {F10b4RecoveryInvestigation} from '../lib/f10b4-recovery-investigation.js';
try{
 const a={};const argv=process.argv.slice(2);
 for(let i=0;i<argv.length;i+=2){
  if(!argv[i]?.startsWith('--')||!argv[i+1]||Object.hasOwn(a,argv[i].slice(2)))throw Error('F10B4_CLI_ARGUMENTS_INVALID');
  a[argv[i].slice(2)]=argv[i+1];
 }
 if(Object.keys(a).some(x=>!['action','vectors-path','user-scope-id','backend','collection-name','collection-key','operation-id','case-id','confirm'].includes(x))||
  !['inspect','stage','verify'].includes(a.action)||!a['vectors-path']||!a['user-scope-id']||!a.backend||!a['collection-name']||!a['collection-key']||
  (a.action==='verify')!==Boolean(a['case-id'])|| (a.action!=='stage'&&a.confirm!==undefined)||
  (a.action==='stage'&&a.confirm!=='REVIEW_ONLY_NO_UNLOCK_NO_REPLAY'))throw Error('F10B4_CLI_ARGUMENTS_INVALID');
 const inspector=new F10b4RecoveryInvestigation({vectorsPath:a['vectors-path'],userScopeId:a['user-scope-id'],
  backend:a.backend,physicalCollectionName:a['collection-name'],collectionKey:a['collection-key']});
 const result=a.action==='inspect'?await inspector.inspect(a['operation-id']??null):a.action==='stage'?
  await inspector.stageCase({operationId:a['operation-id']??null,confirm:a.confirm}):await inspector.verifyCase(a['case-id']);
 // Don't emit physical paths, text, raw plans, vectors, raw receipts, or credentials.
 const output=a.action==='inspect'?{classification:result.classification,evidenceDigest:result.evidenceDigest,
   operationCount:result.operationCount,pendingOperations:result.operations.filter(x=>['PREPARED','SUBMITTED','UNCERTAIN'].includes(x.state)).length,
   pendingManaged:result.managed.pending,lockPresent:result.lockPresent,
   liveUnlockAllowed:false,operationReplayAllowed:false}:result;
 process.stdout.write(JSON.stringify({ok:true,...output})+'\n');
}catch(e){
 const code=/^F10B4_[A-Z_]+$/.test(e?.code||e?.message)?(e.code||e.message):'F10B4_CLI_FAILED';
 process.stderr.write(JSON.stringify({ok:false,code})+'\n');process.exitCode=1;
}

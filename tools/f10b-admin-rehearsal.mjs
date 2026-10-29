#!/usr/bin/env node
/** F10b.1 administrator-only, local control-plane rehearsal CLI.
 * Requires trusted host user scope and isolated disposable vectors directory.
 * No live restore/DB mutation; never accepts target restore path.
 */
import {F10bRecoveryRehearsal} from '../lib/f10b-recovery-rehearsal.js';
function params(argv){
 const out={};
 for(let i=0;i<argv.length;i+=2){
  if(!argv[i]?.startsWith('--')||!argv[i+1]||Object.hasOwn(out,argv[i].slice(2)))throw Error('F10B_CLI_INVALID_ARGUMENTS');
  out[argv[i].slice(2)]=argv[i+1];
 }
 if(Object.keys(out).some(k=>!['action','vectors-path','user-scope-id','id','confirm'].includes(k))||
  !['capture','verify','rehearse'].includes(out.action)||!out['vectors-path']||!out['user-scope-id']||
  out.confirm!=='DISPOSABLE_LOCAL_REHEARSAL_ONLY'||
  ((out.action==='capture')===Boolean(out.id)))throw Error('F10B_CLI_INVALID_ARGUMENTS');
 return out;
}
try{
 const args=params(process.argv.slice(2));
 const control=new F10bRecoveryRehearsal({vectorsPath:args['vectors-path'],userScopeId:args['user-scope-id']});
 const result=args.action==='capture'?await control.capture():args.action==='verify'?await control.verify(args.id):await control.rehearse(args.id);
 // Never dump raw stored receipts, vectors or full filesystem paths to stdout.
 const summary=args.action==='capture'?result:
  args.action==='verify'?{captureId:result.manifest.id,files:result.manifest.files.length,integrityVerified:true,liveRestoreAllowed:false}:
  {captureId:result.sourceCaptureId,stagedFiles:result.stagedFiles,rehearsalVerified:true,liveRestoreAllowed:false};
 process.stdout.write(JSON.stringify({ok:true,...summary})+'\n');
}catch(error){
 process.stderr.write(JSON.stringify({ok:false,code:/^F10B_[A-Z_]+$/.test(error?.code||error?.message)?(error.code||error.message):'F10B_CLI_FAILED'})+'\n');
 process.exitCode=1;
}

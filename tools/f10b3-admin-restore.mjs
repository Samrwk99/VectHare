#!/usr/bin/env node
/** Administrator-only OFFLINE restore staging. Does not touch live databases. */
import {stageF10b3DisposableRestore,verifyF10b3Staging,F10B3_CONSENT} from '../lib/f10b3-disposable-restore.js';
function parse(argv){
 const o={};if(argv.length%2)throw Error('F10B3_CLI_INVALID_ARGUMENTS');
 for(let i=0;i<argv.length;i+=2){const k=argv[i];if(!/^--[a-z-]+$/.test(k)||Object.hasOwn(o,k.slice(2)))throw Error('F10B3_CLI_INVALID_ARGUMENTS');o[k.slice(2)]=argv[i+1];}
 if(Object.keys(o).some(k=>!['action','backup-root','restore-root','capture-id','staging-id','confirm'].includes(k)))throw Error('F10B3_CLI_INVALID_ARGUMENTS');
 if(o.action==='stage'){
  if(!o['backup-root']||!o['restore-root']||!o['capture-id']||o.confirm!==F10B3_CONSENT||o['staging-id'])throw Error('F10B3_CLI_INVALID_ARGUMENTS');
 }else if(o.action==='verify'){
  if(!o['restore-root']||!o['staging-id']||o['backup-root']||o['capture-id']||o.confirm)throw Error('F10B3_CLI_INVALID_ARGUMENTS');
 }else throw Error('F10B3_CLI_INVALID_ARGUMENTS');
 return o;
}
try{
 const a=parse(process.argv.slice(2));const r=a.action==='stage'?
  await stageF10b3DisposableRestore({backupRoot:a['backup-root'],restoreRoot:a['restore-root'],id:a['capture-id'],consent:a.confirm}):
  await verifyF10b3Staging({restoreRoot:a['restore-root'],id:a['staging-id']});
 const {location,...safe}=r;process.stdout.write(JSON.stringify({ok:true,...safe})+'\n');
}catch(e){const code=e?.code||e?.message;process.stderr.write(JSON.stringify({ok:false,code:typeof code==='string'&&/^F10B[23]_[A-Z_]+$/.test(code)?code:'F10B3_CLI_FAILED'})+'\n');process.exitCode=1;}

#!/usr/bin/env node
/** F10b.2 administrator-only fixture backups; no public routes or restore. */
import {captureDisposableLocal,captureDisposableQdrant,verifyF10b2Capture,
 assessMilvusF10b2,F10B2_CONSENT} from '../lib/f10b2-physical-capture.js';
function parse(argv){
 const out={};
 if(argv.length%2)throw Error('F10B2_CLI_INVALID_ARGUMENTS');
 for(let i=0;i<argv.length;i+=2){
  const flag=argv[i];if(!/^--[a-z-]+$/.test(flag)||Object.hasOwn(out,flag.slice(2)))throw Error('F10B2_CLI_INVALID_ARGUMENTS');
  out[flag.slice(2)]=argv[i+1];
 }
 if(Object.keys(out).some(k=>!['action','backend','disposable-name','disposable-parent','backup-root','endpoint','id','confirm','quiescence-confirmed'].includes(k)))
  throw Error('F10B2_CLI_INVALID_ARGUMENTS');
 if(!['capture','verify','milvus-status'].includes(out.action))throw Error('F10B2_CLI_INVALID_ARGUMENTS');
 if(out.action==='verify'&&(!out['backup-root']||!out.id||out.backend||out.confirm))throw Error('F10B2_CLI_INVALID_ARGUMENTS');
 if(out.action==='milvus-status'&&Object.keys(out).length!==1)throw Error('F10B2_CLI_INVALID_ARGUMENTS');
 if(out.action==='capture'&&(!out.backend||!out['disposable-name']||!out['backup-root']||
   out.confirm!==F10B2_CONSENT||out.id||!['qdrant','lancedb','vectra'].includes(out.backend)))throw Error('F10B2_CLI_INVALID_ARGUMENTS');
 if(out.action==='capture'&&((out.backend==='qdrant'&&!out.endpoint)||
  (out.backend!=='qdrant'&&(!out['disposable-parent']||out.endpoint||out['quiescence-confirmed']!=='YES'))))throw Error('F10B2_CLI_INVALID_ARGUMENTS');
 return out;
}
try{
 const args=parse(process.argv.slice(2));let result;
 if(args.action==='milvus-status')result=assessMilvusF10b2();
 else if(args.action==='verify')result=await verifyF10b2Capture({backupRoot:args['backup-root'],id:args.id});
 else{
  const common={backend:args.backend,disposableName:args['disposable-name'],backupRoot:args['backup-root'],consent:args.confirm};
  result=args.backend==='qdrant'?await captureDisposableQdrant({...common,endpoint:args.endpoint,
   apiKey:process.env.F10B2_QDRANT_API_KEY}):await captureDisposableLocal({...common,disposableParent:args['disposable-parent'],operatorDeclaredQuiescent:true});
 }
 // Never print absolute paths, credentials, vectors, or server-origin data.
 const {location,...safe}=result;
 process.stdout.write(JSON.stringify({ok:true,...safe})+'\n');
}catch(error){
 const code=error?.code||error?.message;
 process.stderr.write(JSON.stringify({ok:false,code:typeof code==='string'&&/^F10B2_[A-Z_]+$/.test(code)?code:'F10B2_CLI_FAILED'})+'\n');
 process.exitCode=1;
}

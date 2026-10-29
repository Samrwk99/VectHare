#!/usr/bin/env node
/** F10b.9 terminal-only admin recovery; no replay / no uncertain-state unlock. */
import {F10b9AdministrativeResolution,F10B9_CONSENT} from '../lib/f10b9-admin-resolution.js';
try{
 const a={};const argv=process.argv.slice(2);
 for(let i=0;i<argv.length;i+=2){if(!argv[i]?.startsWith('--')||!argv[i+1]||Object.hasOwn(a,argv[i].slice(2)))throw Error('F10B9_CLI_ARGUMENTS_INVALID');a[argv[i].slice(2)]=argv[i+1];}
 const required=['vectors-path','user-scope-id','backend','collection-name','collection-key','case-id','quiescent','confirm'];
 if(Object.keys(a).length!==required.length||required.some(k=>typeof a[k]!=='string')||a.confirm!==F10B9_CONSENT||a.quiescent!=='yes')throw Error('F10B9_CLI_ARGUMENTS_INVALID');
 const admin=new F10b9AdministrativeResolution({vectorsPath:a['vectors-path'],userScopeId:a['user-scope-id'],
  backend:a.backend,physicalCollectionName:a['collection-name'],collectionKey:a['collection-key']});
 const result=await admin.releaseTerminalLock({caseId:a['case-id'],quiescent:true,confirm:a.confirm});
 process.stdout.write(JSON.stringify({ok:true,...result})+'\n');
}catch(e){const code=/^F(?:10B9|10B4)_[A-Z_]+$/.test(e.code||e.message)?(e.code||e.message):'F10B9_CLI_FAILED';
 process.stderr.write(JSON.stringify({ok:false,code})+'\n');process.exitCode=1;}

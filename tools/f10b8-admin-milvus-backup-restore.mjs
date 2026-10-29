#!/usr/bin/env node
/** F10b.8: explicitly consented disposable Milvus Backup API roundtrip. */
import {runF10b8MilvusRoundtrip,F10B8_CONSENT} from '../lib/f10b8-milvus-backup-restore.js';
function parse(args){
 if(args.length%2)throw Error('F10B8_CLI_INVALID');const out={};const allowed=new Set(['private-root','milvus-address','backup-endpoint','backup-api-version','quiescent','confirm']);
 for(let i=0;i<args.length;i+=2){const key=args[i];if(typeof key!=='string'||!key.startsWith('--')||!allowed.has(key.slice(2))||Object.hasOwn(out,key.slice(2)))throw Error('F10B8_CLI_INVALID');out[key.slice(2)]=args[i+1];}
 if(out.confirm!==F10B8_CONSENT||out.quiescent!=='yes'||out['backup-api-version']!=='0.6'||!out['private-root']||!out['milvus-address']||!out['backup-endpoint'])throw Error('F10B8_CLI_INVALID');
 return {privateRoot:out['private-root'],milvusAddress:out['milvus-address'],backupEndpoint:out['backup-endpoint'],backupApiVersion:'0.6',operatorDeclaredQuiescent:true,consent:F10B8_CONSENT};
}
try{const result=await runF10b8MilvusRoundtrip(parse(process.argv.slice(2)));console.log(JSON.stringify({ok:true,...result}));}
catch(e){const code=typeof e?.code==='string'&&/^(F10B8|F09C5|S0[247])_[A-Z0-9_]+$/.test(e.code)?e.code:'F10B8_HOST_FAILURE_OR_UNCERTAIN';console.error(JSON.stringify({ok:false,code,productionCertified:false}));process.exitCode=1;}

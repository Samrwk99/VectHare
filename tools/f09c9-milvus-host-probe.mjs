#!/usr/bin/env node
/** Administrator CLI only. No HTTP route, no collection cleanup or retries. */
import {runMilvusF09c9HostProbe} from '../lib/f09c9-milvus-host-probe.js';
try{
 const result=await runMilvusF09c9HostProbe({parent:process.env.F09C9_PRIVATE_PARENT,
  address:process.env.F09C9_MILVUS_ADDRESS??'127.0.0.1:19530',
  mode:process.env.F09C9_MODE??'preflight',consent:process.env.F09C9_CONSENT??null});
 console.log(JSON.stringify(result,null,2));
 if(!['PREFLIGHT_ONLY','DISPOSABLE_MILVUS_OBSERVED_NO_PRODUCTION_CERTIFICATION'].includes(result.status))process.exitCode=1;
}catch(e){console.error(JSON.stringify({checkpoint:'F09c.9',status:'REFUSED',
 code:e.code??'F09C9_INVALID_CONFIGURATION',productionPermission:false}));process.exitCode=1;}

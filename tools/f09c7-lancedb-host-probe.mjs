#!/usr/bin/env node
/** Administrator CLI only; no SillyTavern route. Requires pre-created private parent. */
import {runLanceF09c7HostProbe} from '../lib/f09c7-lancedb-host-probe.js';
const mode=process.env.F09C7_MODE??'preflight';
const parent=process.env.F09C7_PRIVATE_PARENT;
try{
 const r=await runLanceF09c7HostProbe({parent,mode,consent:process.env.F09C7_CONSENT??null});
 console.log(JSON.stringify(r,null,2));
 if(!['PREFLIGHT_ONLY','DISPOSABLE_LANCEDB_OBSERVED_NO_PRODUCTION_CERTIFICATION'].includes(r.status))process.exitCode=1;
}catch(e){console.error(JSON.stringify({checkpoint:'F09c.7',status:'REFUSED',error:e.code??'F09C7_INVALID_HOST_CONFIGURATION',productionPermission:false}));process.exitCode=1;}

#!/usr/bin/env node
/** Administrator-only CLI. No HTTP route, normal data access, or auto cleanup. */
import {runVectraF09c8HostProbe} from '../lib/f09c8-vectra-host-probe.js';
try{
 const result=await runVectraF09c8HostProbe({parent:process.env.F09C8_PRIVATE_PARENT,
  mode:process.env.F09C8_MODE??'preflight',consent:process.env.F09C8_CONSENT??null});
 console.log(JSON.stringify(result,null,2));
 if(!['PREFLIGHT_ONLY','DISPOSABLE_VECTRA_OBSERVED_NO_PRODUCTION_CERTIFICATION'].includes(result.status))process.exitCode=1;
}catch(e){console.error(JSON.stringify({checkpoint:'F09c.8',status:'REFUSED',
 code:e.code??'F09C8_INVALID_CONFIGURATION',productionPermission:false}));process.exitCode=1;}

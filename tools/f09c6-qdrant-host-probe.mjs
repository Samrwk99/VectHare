#!/usr/bin/env node
/** Administrator-only CLI; no SillyTavern route, no background task. */
import {runQdrantF09c6HostProbe} from '../lib/f09c6-qdrant-host-probe.js';
const mode=process.env.F09C6_MODE??'read-only';
const result=await runQdrantF09c6HostProbe({
 endpoint:process.env.F09C6_QDRANT_URL??'http://127.0.0.1:6333/',
 apiKey:process.env.F09C6_QDRANT_API_KEY,
 mode,consent:process.env.F09C6_CONSENT??null,
 cleanupConsent:process.env.F09C6_CLEANUP_CONSENT??null
});
console.log(JSON.stringify(result,null,2));
if(!['PREFLIGHT_ONLY','CANDIDATE_HOST_OBSERVED_NO_PRODUCTION_CERTIFICATION'].includes(result.status))process.exitCode=1;

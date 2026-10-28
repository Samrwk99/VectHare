#!/usr/bin/env node
/** F12 host evidence worksheet and conservative local assessor.
 * This tool never contacts SillyTavern, Qdrant or Milvus, executes mutations,
 * or grants certification. PASS values are user-supplied and unverified.
 * Usage: node tools/f12-host-evidence.mjs --template output.json
 *        node tools/f12-host-evidence.mjs --assess evidence.json
 */
import fs from 'node:fs/promises';
import {F12_BACKENDS,F12_REQUIRED_CHECKS} from '../lib/f12-release-assessment.js';
const OS=['termux','linux','windows'];
const CHECKS=['live_disposable_crud_reopen','live_source_and_cross_user_isolation',
 'live_stale_revision_and_external_writer','live_restart_recovery_and_readback',
 'normal_pipeline_activation'];
const STATUS=['PASS','FAIL','BLOCKED','NOT_RUN'];
const argv=process.argv.slice(2);
const mode=argv[0],filename=argv[1];
if(!['--template','--assess'].includes(mode)||typeof filename!=='string'||argv.length!==2){
 console.error('Usage: node tools/f12-host-evidence.mjs --template file.json | --assess file.json');
 process.exitCode=1;
}else if(mode==='--template'){
 const template={schemaVersion:1,checkpoint:'F12',source:'USER_RECORDED_HOST_EVIDENCE_NOT_ATTESTATION',
  instructions:'Disposable data only. Do not paste API keys, tokens, file contents or private URLs. Attach separate redacted logs for independent review.',
  requiredChecks:F12_REQUIRED_CHECKS.map(id=>({id,status:'NOT_RUN',evidenceRef:''})),
  runs:OS.flatMap(os=>F12_BACKENDS.map(backend=>({os,backend,checks:CHECKS.map(id=>({id,status:'NOT_RUN',evidenceRef:''}))}))),
  independentReview:'PENDING',
 };
 await fs.writeFile(filename,JSON.stringify(template,null,2)+'\n',{flag:'wx',mode:0o600});
 console.log(`Created F12 host evidence worksheet: ${OS.length*F12_BACKENDS.length} backend/OS runs; ${F12_REQUIRED_CHECKS.length} shared checks. No execution occurred.`);
}else{
 try{
  const fileStat=await fs.stat(filename);if(fileStat.size>256*1024)throw Error('F12_EVIDENCE_TOO_LARGE');
  const input=JSON.parse(await fs.readFile(filename,'utf8'));
  if(input?.schemaVersion!==1||input.checkpoint!=='F12'||input.source!=='USER_RECORDED_HOST_EVIDENCE_NOT_ATTESTATION'||
   !Array.isArray(input.requiredChecks)||!Array.isArray(input.runs))throw Error('F12_EVIDENCE_INVALID_SCHEMA');
  const verifyChecks=(checks,expected)=>{
    if(checks.length!==expected.length||checks.map(x=>x?.id).join('|')!==expected.join('|'))throw Error('F12_EVIDENCE_WRONG_CHECKS');
    for(const c of checks)if(!STATUS.includes(c.status)||typeof c.evidenceRef!=='string'||c.evidenceRef.length>250||
        (c.status==='PASS'&&!c.evidenceRef.trim()))throw Error('F12_EVIDENCE_CHECK_INVALID');
    return checks;
  };
  const all=verifyChecks(input.requiredChecks,F12_REQUIRED_CHECKS);
  const expected=OS.flatMap(os=>F12_BACKENDS.map(backend=>`${os}/${backend}`));
  if(input.runs.length!==expected.length||input.runs.map(x=>`${x?.os}/${x?.backend}`).join('|')!==expected.join('|'))
   throw Error('F12_EVIDENCE_WRONG_MATRIX');
  for(const run of input.runs)all.push(...verifyChecks(run.checks,CHECKS));
  const counts=Object.fromEntries(STATUS.map(s=>[s,all.filter(x=>x.status===s).length]));
  const output={checkpoint:'F12',evidenceType:'UNVERIFIED_USER_RECORDED',verdict:'NO_GO',
   checks:all.length,counts,requiredOutstanding:counts.FAIL+counts.BLOCKED+counts.NOT_RUN,
   externalHostProven:false,productionWritesEnabled:false,reason:'No independent host attestation or completed F09b/F10 activation evidence; worksheet cannot grant release permission.'};
  console.log(JSON.stringify(output,null,2));
  process.exitCode=output.requiredOutstanding?2:3; // 3 = all self-reported PASS but STILL NOT CERTIFIED
 }catch(e){console.error(`F12 evidence rejected: ${e.message}`);process.exitCode=1;}
}

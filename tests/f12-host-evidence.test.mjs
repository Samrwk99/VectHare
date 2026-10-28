import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const script=new URL('../tools/f12-host-evidence.mjs',import.meta.url).pathname;
async function fixture(fn){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'f12-evidence-'));try{return await fn(path.join(dir,'worksheet.json'));}finally{await fs.rm(dir,{recursive:true,force:true});}}
const run=(...args)=>spawnSync(process.execPath,[script,...args],{encoding:'utf8'});
test('F12 creates a cross-platform, five-backend empty evidence worksheet',()=>fixture(async file=>{
 const r=run('--template',file);assert.equal(r.status,0);
 const data=JSON.parse(await fs.readFile(file,'utf8'));
 assert.equal(data.runs.length,15);assert.equal(data.requiredChecks.length,12);
 assert.ok(data.runs.every(x=>x.checks.every(c=>c.status==='NOT_RUN')));
 assert.equal(run('--template',file).status,1); // cannot overwrite saved evidence
}));
test('F12 reports NO GO when evidence is missing',()=>fixture(async file=>{
 run('--template',file);const r=run('--assess',file);assert.equal(r.status,2);
 const summary=JSON.parse(r.stdout);assert.equal(summary.verdict,'NO_GO');
 assert.equal(summary.checks,87);assert.equal(summary.counts.NOT_RUN,87);
 assert.equal(summary.productionWritesEnabled,false);
}));
test('F12 rejects invented PASS without evidence reference',()=>fixture(async file=>{
 run('--template',file);const data=JSON.parse(await fs.readFile(file,'utf8'));
 data.requiredChecks[0].status='PASS';await fs.writeFile(file,JSON.stringify(data));
 assert.equal(run('--assess',file).status,1);
}));
test('F12 never promotes self-reported all PASS to GO',()=>fixture(async file=>{
 run('--template',file);const data=JSON.parse(await fs.readFile(file,'utf8'));
 for(const x of data.requiredChecks){x.status='PASS';x.evidenceRef='redacted-log-id';}
 for(const run of data.runs)for(const x of run.checks){x.status='PASS';x.evidenceRef='redacted-log-id';}
 await fs.writeFile(file,JSON.stringify(data));
 const r=run('--assess',file);assert.equal(r.status,3);
 assert.equal(JSON.parse(r.stdout).verdict,'NO_GO');
}));

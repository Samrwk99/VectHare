#!/usr/bin/env node
/** OFFLINE FIXTURE ONLY. Never connects to any DB or activates collection mappings. */
import fs from 'node:fs/promises';
import {buildMigrationManifest} from '../lib/s09-manifest.js';
import {rehearseFixture,verifyFixtureSession} from '../lib/s09-fixture.js';
if(process.argv.length!==5 || process.argv[4]!=='--disposable') {
    console.error('Usage: node tools/s09-fixture-rehearsal.mjs inventory.json EMPTY_PRIVATE_DIRECTORY --disposable');
    process.exitCode=2;
} else {
    try {
        const st=await fs.lstat(process.argv[2]);
        if(!st.isFile() || st.isSymbolicLink() || st.size>16*1024*1024)throw new Error('Untrusted inventory file');
        const input=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
        const manifest=buildMigrationManifest(input);
        const result=await rehearseFixture({input,manifest,directory:process.argv[3],disposable:true});
        const checked=await verifyFixtureSession(result.session);
        console.log(JSON.stringify({session:result.session,...checked,productionMigrationAllowed:false},null,2));
    } catch(e) {
        console.error(`S09 rehearsal refused: ${e.code||e.name}`);
        process.exitCode=1;
    }
}

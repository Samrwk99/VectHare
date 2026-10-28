#!/usr/bin/env node
/** Read-only operator utility. Takes explicit JSON inventory; no backend access. */
import fs from 'node:fs/promises';
import {buildMigrationManifest} from '../lib/s09-manifest.js';
if(process.argv.length!==3) {
    console.error('Usage: node tools/s09-plan.mjs inventory.json');
    process.exitCode=2;
} else {
    try {
        const st=await fs.lstat(process.argv[2]);
        if(!st.isFile()||st.isSymbolicLink()||st.size>16*1024*1024)throw new Error('Invalid input file');
        const input=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
        const result=buildMigrationManifest(input);
        console.log(JSON.stringify(result,null,2));
        if(result.quarantinedCount||result.unresolved.length) process.exitCode=3;
    } catch(e) { console.error(`S09 refused: ${e.code||e.name}`);process.exitCode=1; }
}

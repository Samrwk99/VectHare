#!/usr/bin/env node
// Read-only: accepts a trusted local JSON inventory file; prints a plan to stdout.
import fs from 'node:fs/promises';
import { planLegacyMigration } from '../lib/s02-migration.js';
if (process.argv.length !== 3) {
    console.error('Usage: node tools/s02-migration-dry-run.mjs inventory.json');
    process.exitCode = 2;
} else {
    try {
        const file = process.argv[2];
        const stat = await fs.stat(file);
        if (stat.size > 20 * 1024 * 1024) throw new Error('Input file too large');
        const payload = JSON.parse(await fs.readFile(file, 'utf8'));
        console.log(JSON.stringify(planLegacyMigration(payload), null, 2));
    } catch (e) {
        console.error(`S02 dry run refused: ${e.code || e.name}`);
        process.exitCode = 1;
    }
}

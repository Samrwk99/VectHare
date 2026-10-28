#!/usr/bin/env node
/** Controlled packaging step: regenerate the local source manifest after changes. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {calculateSourceManifest,S10_MANIFEST_FILE} from '../lib/s10-build.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const data=await calculateSourceManifest(root);
await fs.writeFile(path.join(root,S10_MANIFEST_FILE),JSON.stringify(data,null,2)+'\n',{flag:'w',mode:0o644});
console.log(`S10 manifest: ${data.pluginVersion}; ${Object.keys(data.files).length} source files; ${data.sourceFingerprint}`);

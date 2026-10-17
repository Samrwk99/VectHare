/** P2 #58: Complete static INVENTORY of 181 UI controls.
 * This proves presence, not save/restart/live functionality; see matrix.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const root=new URL('..',import.meta.url);
const inventory=fs.readFileSync(new URL('./settings-control-inventory.csv',import.meta.url),'utf8');
// CSV-aware reader (quoted fields, commas and escaped double quotes).
function parseCsv(raw){
 let rows=[],row=[],current='',quoted=false;
 for(let i=0;i<raw.length;i++){
  const c=raw[i];
  if(c==='"'){
   if(quoted && raw[i+1]==='"'){current+='"';i++;}
   else quoted=!quoted;
  }else if(!quoted&&(c===','||c==='\n')){
   row.push(current);current='';
   if(c==='\n'){if(row.some(x=>x!==''))rows.push(row);row=[];}
  }else if(c!=='\r'||quoted)current+=c;
 }
 if(current||row.length){row.push(current);rows.push(row);}
 const keys=rows.shift();return rows.map(vals=>Object.fromEntries(keys.map((key,i)=>[key,vals[i]||''])));
}
const rows=parseCsv(inventory);
assert.equal(rows.length,181,'Audited controls must not disappear from the acceptance inventory');
const seen=new Set();
for(const record of rows){
 const identity=`${record.source}#${record.control}`;
 assert(!seen.has(identity),`Duplicated control ${identity}`);seen.add(identity);
 const file=new URL(`../ui/${record.source}`,import.meta.url);
 const source=fs.readFileSync(file,'utf8');
 assert(source.includes(record.control),`UI control removed or renamed without audit amendment: ${identity}`);
 assert(record.audit_scope,`Missing persistence/transient scope classification: ${identity}`);
}
const defaults=fs.readFileSync(new URL('../index.js',import.meta.url),'utf8');
assert(defaults.includes('settings = extension_settings.vecthare;'),'Core runtime must share authoritative extension settings, not copy them');
const ui=fs.readFileSync(new URL('../ui/ui-manager.js',import.meta.url),'utf8');
assert(ui.includes('applyEditedSettings(settingsSnapshot,extension_settings.vecthare,baseline)'),'UI writes edited paths, never stale entire settings snapshots');
for(const file of ['ui/ui-manager.js','core/collection-metadata.js','core/collection-ownership.js']){
 const code=fs.readFileSync(new URL('../'+file,import.meta.url),'utf8');
 assert(code.includes('saveVectHareSettingsDebounced as saveSettingsDebounced'),`Persistence wrapper bypass in ${file}`);
}
console.log(`PASS: all ${rows.length} inventoried controls exist in source and are scope-classified; shared settings, delta UI updates and durability hooks present`);
console.log('NOTICE: No claim of live save-reload-runtime correctness; #58 requires live tests, especially modal and nested controls.');

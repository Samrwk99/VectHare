import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
test('P-B.2 legacy scene markers do not claim managed source or full physical inventory',()=>{
 const src=fs.readFileSync(new URL('../ui/scene-markers.js',import.meta.url),'utf8');
 const a=src.indexOf('export function getSceneCacheEvidence()'),b=src.indexOf('\n}\n',a);
 assert.ok(a>0&&b>a);
 const context=vm.createContext({});
 const inspect=vm.runInContext(`let sceneCacheEvidence='LEGACY_UNVERIFIED';${src.slice(a,b+2).replace('export function','function')}\ngetSceneCacheEvidence`,context);
 const result=inspect();
 assert.equal(result.status,'LEGACY_UNVERIFIED');assert.equal(result.managedV2Verified,false);
 assert.equal(result.physicalInventoryComplete,false);
 assert.match(src,/Legacy cached scene \(UNVERIFIED managed-v2 provenance\)/);
});

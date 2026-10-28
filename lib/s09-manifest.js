/** S09: offline migration candidate manifest. No server authority or cutover granted.
 * Mappings MUST be independently sourced by a future trusted host/backend probe.
 * User-controlled owner metadata or ownerVerified flags are never authority.
 */
import { createHash } from 'node:crypto';
import { collectionIdentity, recordIdentity, canonicalScope, safeLegacyPhysicalName } from './s02-identity.js';

export class MigrationError extends Error {
    constructor(code, message) { super(message); this.name='MigrationError'; this.code=code; }
}
const sha = value => createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const isObj = x => x !== null && typeof x==='object' && !Array.isArray(x);
const MAX = 20000;
function locator(backend, name, hash) {
    const physical=safeLegacyPhysicalName(backend,name);
    if(!((typeof hash==='string' && /^(0|[1-9][0-9]*)$/.test(hash)) ||
      (typeof hash==='number' && Number.isSafeInteger(hash) && hash>=0))) {
        throw new MigrationError('S09_INVALID_LEGACY_HASH','Legacy hash must be an unambiguous unsigned decimal');
    }
    const numeric=BigInt(String(hash));
    // Qdrant/Milvus historic numeric primary keys must fit safe JS integers in this migration format.
    if(numeric>BigInt(Number.MAX_SAFE_INTEGER)) throw new MigrationError('S09_HASH_OUT_OF_RANGE','Legacy numeric hash too large for verified mapping');
    return JSON.stringify([physical,numeric.toString(10)]);
}
function refKey(backend, r) {
    if (!isObj(r)) throw new MigrationError('S09_REFERENCE_INVALID','Reference must be a locator object');
    return locator(backend,r.legacyPhysicalName,r.legacyHash);
}
function evidenceId(value) {
    return typeof value==='string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(value);
}
/** Caller-supplied mappings are just unverified claims until evidence is independently established. */
export function buildMigrationManifest({backend,embedding,records,ownerMappings=[],inventoryEvidence=null}) {
    if(!['qdrant','milvus','lancedb','vectra'].includes(backend) || !Array.isArray(records) ||
       !Array.isArray(ownerMappings) || records.length>MAX || ownerMappings.length>MAX) {
        throw new MigrationError('S09_INPUT_INVALID','Bounded migration inputs and supported backend required');
    }
    const unresolved=[]; const mappings=[]; const owners=new Map(); const ambiguities=new Set();
    for (const [i,m] of ownerMappings.entries()) {
        try {
            if(!isObj(m)||!evidenceId(m.evidenceId)||!m.scope) throw new MigrationError('S09_OWNER_UNVERIFIED','Independent owner mapping/evidence reference required');
            const key=locator(backend,m.legacyPhysicalName,m.legacyHash);
            const s=canonicalScope(m.scope);
            if(owners.has(key)) {
                ambiguities.add(key);
                unresolved.push({kind:'mapping',index:i,code:'S09_OWNER_MAPPING_CONFLICT'});
            } else owners.set(key,{scope:s,evidenceId:m.evidenceId});
        } catch(error) { unresolved.push({kind:'mapping',index:i,code:error.code??'S09_OWNER_MAPPING_INVALID'}); }
    }
    const seenLegacy=new Map();const seenTarget=new Map();const rows=[];
    for (const [i,r] of records.entries()) {
        try {
            if(!isObj(r) || typeof r.recordId!=='string') throw new MigrationError('S09_RECORD_INVALID','Legacy record and stable target recordId required');
            const key=locator(backend,r.legacyPhysicalName,r.legacyHash);
            const owner=owners.get(key);
            if(!owner||ambiguities.has(key)) throw new MigrationError('S09_OWNER_UNVERIFIED','No unique independent owner mapping');
            const target=collectionIdentity({backend,embedding,scope:owner.scope});
            const identity=recordIdentity(owner.scope,r.recordId);
            const references=Array.isArray(r.references)?r.references.map(x=>refKey(backend,x)):[];
            if(references.length>1000) throw new MigrationError('S09_REFERENCE_LIMIT','Too many references');
            const row={inventoryIndex:i,legacyLocator:key,recordId:identity.recordId,
                targetCollectionKey:target.key,targetPhysicalName:target.physicalName,
                targetPhysicalId:identity.physicalId,scope:owner.scope,ownerEvidenceId:owner.evidenceId,
                references,sourceFingerprint:sha(r)};
            if(seenLegacy.has(key)) {
                ambiguities.add(key);
                unresolved.push({kind:'record',index:i,code:'S09_DUPLICATE_LEGACY_LOCATOR'});
                continue;
            }
            seenLegacy.set(key,i);
            if(seenTarget.has(row.targetPhysicalId)) {
                ambiguities.add(key);
                ambiguities.add(seenTarget.get(row.targetPhysicalId));
                unresolved.push({kind:'record',index:i,code:'S09_TARGET_ID_COLLISION'});
                continue;
            }
            seenTarget.set(row.targetPhysicalId,key);
            rows.push(row);
        } catch(error) { unresolved.push({kind:'record',index:i,code:error.code??'S09_RECORD_INVALID'}); }
    }
    const found=new Set(rows.map(x=>x.legacyLocator));
    const byLocator=new Map(rows.map(x=>[x.legacyLocator,x]));
    for(const row of rows) {
        if(ambiguities.has(row.legacyLocator)) continue;
        if(row.references.some(k=>!found.has(k)||ambiguities.has(k))) {
            ambiguities.add(row.legacyLocator);
            unresolved.push({kind:'record',index:row.inventoryIndex,code:'S09_DANGLING_REFERENCE'});
        } else if(row.references.some(k=>byLocator.get(k)?.scope.userScopeId!==row.scope.userScopeId)) {
            ambiguities.add(row.legacyLocator);
            unresolved.push({kind:'record',index:row.inventoryIndex,code:'S09_CROSS_TENANT_REFERENCE'});
        }
    }
    // Repeat until all transitive dependents of quarantined records are also quarantined.
    let changed=true;
    while(changed) {
        changed=false;
        for(const row of rows) {
            if(!ambiguities.has(row.legacyLocator) && row.references.some(k=>ambiguities.has(k))) {
                ambiguities.add(row.legacyLocator);
                unresolved.push({kind:'record',index:row.inventoryIndex,code:'S09_QUARANTINED_REFERENCE'});
                changed=true;
            }
        }
    }
    const accepted=rows.filter(x=>!ambiguities.has(x.legacyLocator));
    for(const row of rows.filter(x=>ambiguities.has(x.legacyLocator))) {
        if(!unresolved.some(u=>u.kind==='record' && u.index===row.inventoryIndex))
            unresolved.push({kind:'record',index:row.inventoryIndex,code:'S09_COLLISION_QUARANTINE'});
    }
    const sourceDigest=sha({backend,embedding,records,ownerMappings,inventoryEvidence});
    const manifest={schemaVersion:9,mode:'OFFLINE_CANDIDATE_ONLY',backend,embedding,
        inputCount:records.length,mappedCount:accepted.length,quarantinedCount:records.length-accepted.length,
        sourceDigest,inventoryEvidenceRef:inventoryEvidence?.reference??null,
        evidenceStatus:'UNVERIFIED_CLAIMS',snapshotConsistency:'UNPROVEN',backupVerified:false,
        targetCopied:false,cutoverAllowed:false,rollbackValidated:false,
        mappings:accepted,unresolved};
    return {...manifest,manifestDigest:sha(manifest)};
}
export function verifyManifest(manifest,input) {
    if(!isObj(manifest) || manifest.schemaVersion!==9 || manifest.mode!=='OFFLINE_CANDIDATE_ONLY')
        throw new MigrationError('S09_MANIFEST_INVALID','Not an S09 offline manifest');
    const {manifestDigest,...body}=manifest;
    if(!/^[a-f0-9]{64}$/.test(manifestDigest??'') || manifestDigest!==sha(body))
        throw new MigrationError('S09_MANIFEST_TAMPERED','Manifest digest mismatch');
    const rebuilt=buildMigrationManifest(input);
    if(JSON.stringify(rebuilt)!==JSON.stringify(manifest))
        throw new MigrationError('S09_SOURCE_CHANGED','Migration sources/mapping or manifest changed');
    if(manifest.cutoverAllowed || manifest.backupVerified || manifest.targetCopied || manifest.rollbackValidated ||
       manifest.snapshotConsistency!=='UNPROVEN')
        throw new MigrationError('S09_ILLEGAL_PROMOTION','Offline manifest cannot authorize cutover');
    return true;
}

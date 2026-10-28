/** S09 isolated local-fixture rehearsal. Never connects to SillyTavern/backend or cuts over.
 * File receipts are NOT evidence of real backend snapshot or ownership.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID,createHash } from 'node:crypto';
import { MigrationError, verifyManifest } from './s09-manifest.js';
import {contentFingerprint} from './s02-identity.js';
const sha = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
async function dirCheck(dir) {
    const st=await fs.lstat(dir);
    if(!st.isDirectory()||st.isSymbolicLink()||(st.mode&0o077))
        throw new MigrationError('S09_UNTRUSTED_DIRECTORY','Fixture directory must be private and nonsymlinked');
}
async function exclusiveJson(file, data) {
    const h=await fs.open(file,'wx',0o600);
    try { await h.writeFile(JSON.stringify(data,null,2)+'\n'); await h.sync(); }
    finally { await h.close(); }
}
async function checkedJson(file) {
    const st=await fs.lstat(file);
    if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o077)||st.size>16*1024*1024)
        throw new MigrationError('S09_UNTRUSTED_FILE','Untrusted fixture artifact');
    return JSON.parse(await fs.readFile(file,'utf8'));
}
/** Rehearse backup, independent copy/readback, and rollback of an isolated snapshot.
 * Requires an empty, private operator-created directory; NEVER accepts a backend adapter.
 */
export async function rehearseFixture({input,manifest,directory,disposable=false}) {
    if(disposable!==true) throw new MigrationError('S09_FIXTURE_ONLY','Explicit disposable fixture approval required');
    if(typeof directory!=='string'||!path.isAbsolute(directory)) throw new MigrationError('S09_PATH_REQUIRED','Absolute directory required');
    await dirCheck(directory);
    verifyManifest(manifest,input);
    if(manifest.quarantinedCount!==0 || manifest.unresolved.length!==0 || manifest.mappedCount!==input.records.length)
        throw new MigrationError('S09_QUARANTINE_PRESENT','Cannot stage an ambiguous/incomplete inventory');
    if(input.records.length>10000) throw new MigrationError('S09_FIXTURE_LIMIT','Fixture exceeds rehearsal limit');
    const current=await fs.readdir(directory);
    if(current.length) throw new MigrationError('S09_TARGET_NOT_EMPTY','Rehearsal destination must be empty');
    const session=path.join(directory,'fixture-'+randomUUID());
    await fs.mkdir(session,{mode:0o700});
    try {
        // Stored backup is a byte-preserving JSON snapshot of supplied fixture inputs,
        // not a verified snapshot or proof of database durability.
        const snapshot={sourceDigest:manifest.sourceDigest,records:input.records,ownerMappings:input.ownerMappings};
        const backup={snapshot,checksum:sha(snapshot)};
        await exclusiveJson(path.join(session,'backup.json'),backup);
        const rereadBackup=await checkedJson(path.join(session,'backup.json'));
        if(sha(rereadBackup.snapshot)!==rereadBackup.checksum ||
           rereadBackup.checksum!==backup.checksum) throw new MigrationError('S09_BACKUP_BAD','Fixture backup failed independent readback');
        const staged=manifest.mappings.map(m=>{
            const legacy=input.records[m.inventoryIndex];
            if(typeof legacy.text!=='string'||!legacy.text||!Array.isArray(legacy.vector)||
                legacy.vector.length!==input.embedding.dimension ||
                !legacy.vector.every(x=>typeof x==='number'&&Number.isFinite(x)&&Object.is(x,Math.fround(x))) ||
                !legacy.metadata || typeof legacy.metadata!=='object' || Array.isArray(legacy.metadata)) {
                throw new MigrationError('S09_LEGACY_PAYLOAD_UNVERIFIABLE',
                    'A complete, float32-compatible text/vector/metadata payload is required to stage a v2 record');
            }
            const metadataJson=JSON.stringify(legacy.metadata);
            if(!metadataJson || Buffer.byteLength(metadataJson)>32768)throw new MigrationError('S09_METADATA_INVALID','Legacy metadata cannot be verified');
            const row={schemaVersion:2,...m.scope,branchId:m.scope.branchId??'',
                recordId:m.recordId,physicalId:m.targetPhysicalId,revision:1,
                text:legacy.text,textHash:contentFingerprint(legacy.text),
                vector:legacy.vector,vectorHash:sha(legacy.vector),
                metadata:legacy.metadata,metadataHash:sha(legacy.metadata),embedding:input.embedding};
            return {targetPhysicalName:m.targetPhysicalName,legacyLocator:m.legacyLocator,
                ownerEvidenceId:m.ownerEvidenceId,sourceFingerprint:m.sourceFingerprint,
                references:m.references,v2Record:row};
        });
        await exclusiveJson(path.join(session,'staged.json'),{staged,digest:sha(staged)});
        const reread=await checkedJson(path.join(session,'staged.json'));
        if(sha(reread.staged)!==reread.digest || reread.digest!==sha(staged))
            throw new MigrationError('S09_STAGE_BAD','Staged fixture did not read back correctly');
        const receipt={schemaVersion:9,mode:'DISPOSABLE_FIXTURE_REHEARSAL',sourceDigest:manifest.sourceDigest,
            manifestDigest:manifest.manifestDigest,backupDigest:backup.checksum,stagedDigest:sha(staged),backupVerifiedWithinFixture:true,
            stageVerifiedWithinFixture:true,backendSnapshotVerified:false,hostOwnershipVerified:false,
            cutoverAllowed:false,productionMigrationAllowed:false,
            status:'STAGED_REHEARSAL_ONLY'};
        await exclusiveJson(path.join(session,'receipt.json'),receipt);
        return {session,receipt};
    } catch(error) {
        // Never delete partially created fixture artifacts silently; they can explain an interruption.
        throw error;
    }
}
export async function verifyFixtureSession(session) {
    if(typeof session!=='string'||!path.isAbsolute(session) || !/^fixture-[0-9a-f-]{36}$/.test(path.basename(session)))
        throw new MigrationError('S09_PATH_REQUIRED','S09 fixture session path required');
    await dirCheck(session);
    const backup=await checkedJson(path.join(session,'backup.json'));
    const stage=await checkedJson(path.join(session,'staged.json'));
    const receipt=await checkedJson(path.join(session,'receipt.json'));
    if(sha(backup.snapshot)!==backup.checksum || sha(stage.staged)!==stage.digest ||
       receipt.backupDigest!==backup.checksum || receipt.stagedDigest!==stage.digest ||
       receipt.mode!=='DISPOSABLE_FIXTURE_REHEARSAL' || receipt.cutoverAllowed!==false ||
       receipt.sourceDigest!==backup.snapshot.sourceDigest ||
       stage.staged.length!==backup.snapshot.records.length ||
       stage.staged.some(s=>s.v2Record.textHash!==contentFingerprint(s.v2Record.text) ||
          s.v2Record.vectorHash!==sha(s.v2Record.vector) ||
          s.v2Record.metadataHash!==sha(s.v2Record.metadata)))
        throw new MigrationError('S09_FIXTURE_TAMPERED','Fixture verification failed');
    return {status:receipt.status,backupVerifiedWithinFixture:true,stageVerifiedWithinFixture:true,cutoverAllowed:false};
}
export async function rollbackFixtureSession(session) {
    await verifyFixtureSession(session);
    // Non-destructive rollback simulation: preserve backup, remove only rehearsal staged file.
    // No production aliases, registry state or source collections are ever touched.
    await fs.rename(path.join(session,'staged.json'),path.join(session,'staged.rolled-back.json'));
    const receipt=await checkedJson(path.join(session,'receipt.json'));
    const next={...receipt,status:'ROLLED_BACK_FIXTURE_ONLY'};
    // Receipt is written via private temp and atomic rename.
    const tmp=path.join(session,'.receipt-'+randomUUID());
    await exclusiveJson(tmp,next);
    await fs.rename(tmp,path.join(session,'receipt.json'));
    return {status:next.status,backupPreserved:true,productionRollbackPerformed:false};
}

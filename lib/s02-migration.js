/** S02 read-only migration planning from EXPLICITLY supplied legacy inventory.
 * Cannot infer missing tenant ownership; never cut over / write backend data.
 */
import { collectionIdentity, recordIdentity, canonicalScope, IdentityError } from './s02-identity.js';

export function planLegacyMigration({ backend, embedding, records, collections = [] }) {
    if (!Array.isArray(records) || !Array.isArray(collections) || records.length > 500000) {
        throw new IdentityError('S02_INVALID_INVENTORY', 'Bounded inventory arrays required');
    }
    const unresolved = [];
    const mapped = [];
    const seenPhysical = new Set();
    const knownCollections = new Map();
    for (const item of collections) {
        try {
            const candidate = collectionIdentity({ backend, embedding, scope: item.scope });
            if (knownCollections.has(candidate.key) && knownCollections.get(candidate.key) !== item.legacyPhysicalName) {
                unresolved.push({ reason: 'CONFLICTING_LEGACY_COLLECTION', reference: String(item.reference ?? '') });
            } else knownCollections.set(candidate.key, item.legacyPhysicalName);
        } catch (error) { unresolved.push({ reason: 'AMBIGUOUS_COLLECTION', reference: String(item?.reference ?? ''), code: error.code ?? 'INVALID' }); }
    }
    for (let i = 0; i < records.length; i++) {
        const item = records[i];
        try {
            if (!item || item.ownerVerified !== true || item.legacyHash === undefined ||
                item.legacyHash === null || !item.recordId || !item.scope ||
                typeof item.legacyPhysicalName !== 'string' || !item.legacyPhysicalName) {
                throw new IdentityError('S02_UNVERIFIED_LEGACY_OWNER', 'Missing independently established owner, hash or stable ID');
            }
            if (!((typeof item.legacyHash === 'string' && /^[0-9]+$/.test(item.legacyHash)) ||
                (typeof item.legacyHash === 'number' && Number.isSafeInteger(item.legacyHash) && item.legacyHash >= 0))) {
                throw new IdentityError('S02_INVALID_LEGACY_HASH', 'Unsupported legacy hash format');
            }
            const scope = canonicalScope(item.scope);
            const target = recordIdentity(scope, item.recordId);
            const namespace = collectionIdentity({ backend, embedding, scope });
            if (seenPhysical.has(target.physicalId)) throw new IdentityError('S02_DUPLICATE_RECORD', 'Duplicate physical target identity');
            seenPhysical.add(target.physicalId);
            mapped.push({ inventoryIndex: i, legacyHash: String(item.legacyHash),
                legacyPhysicalName: String(item.legacyPhysicalName ?? ''),
                collectionKey: namespace.key, targetPhysicalCollection: namespace.physicalName,
                recordId: target.recordId, targetPhysicalId: target.physicalId });
        } catch (error) { unresolved.push({ inventoryIndex: i, reason: error.code ?? 'INVALID_LEGACY_RECORD' }); }
    }
    return {
        schemaVersion: 2, mode: 'READ_ONLY_DRY_RUN', backend,
        recordsExamined: records.length, recordsMapped: mapped.length,
        recordsUnresolved: unresolved.length, mappings: mapped, unresolved,
        backupVerified: false, dataCopied: false, cutoverAllowed: false,
        reason: 'S02 generates planning evidence only. S03 authorization and S09 backup/copy/verification required.'
    };
}

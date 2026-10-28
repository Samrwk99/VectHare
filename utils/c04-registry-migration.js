/** C04-B: deliberately opt-in, reversible migration of *settings*, not backend vectors.
 * Never derive backend/source/owner from an old bare string. The caller must
 * supply a reviewed legacy->qualified map and verified origin IDs.
 */
import {parseCollectionKey} from './collection-keys.js';
export const REGISTRY_SCHEMA_VERSION = 2;
export const MAX_INLINE_REGISTRY_BACKUP_BYTES = 2 * 1024 * 1024;
const copy = value => JSON.parse(JSON.stringify(value));
const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
const safeObject=o=>o && typeof o==='object' && !Array.isArray(o) ? o : {};
const knownParts=key=>parseCollectionKey(key);
function legacySource(key) { return typeof key==='string' && !knownParts(key); }
function validateOwner(meta, owner) {
    if (!meta || typeof meta!=='object') return false;
    const hasLocks = Boolean(meta.lockedToChatId) || (Array.isArray(meta.lockedToChatIds) && meta.lockedToChatIds.length>0)
        || (Array.isArray(meta.lockedToCharacterIds) && meta.lockedToCharacterIds.length>0)
        || Boolean(meta.originChatId || meta.originCharacterId);
    if (!hasLocks) return true;
    if (!owner || owner.verified!==true) return false;
    const chats = [...(Array.isArray(meta.lockedToChatIds)?meta.lockedToChatIds:[]), ...(meta.lockedToChatId?[meta.lockedToChatId]:[])].map(String);
    const characters=(Array.isArray(meta.lockedToCharacterIds)?meta.lockedToCharacterIds:[]).map(String);
    const resolvedChats=new Set((owner.chatIds||[]).map(String));
    const resolvedCharacters=new Set((owner.characterIds||[]).map(String));
    return chats.every(x=>resolvedChats.has(x)) && characters.every(x=>resolvedCharacters.has(x))
        && (!meta.originChatId || resolvedChats.has(String(meta.originChatId)))
        && (!meta.originCharacterId || resolvedCharacters.has(String(meta.originCharacterId)));
}
function snapshot(settings) {
    return {vecthare_collection_registry: copy(Array.isArray(settings.vecthare_collection_registry)?settings.vecthare_collection_registry:[]),
        collections:copy(safeObject(settings.collections)),
        chatCollectionPolicies:copy(safeObject(settings.chatCollectionPolicies)),
        vecthare_chunk_meta_by_collection:copy(safeObject(settings.vecthare_chunk_meta_by_collection)),
        vecthare_registry_schema_version: settings.vecthare_registry_schema_version ?? null};
}
function applySnapshot(settings, state) {
    for(const [key,value] of Object.entries(state)) {
        if (value===null && key==='vecthare_registry_schema_version') delete settings[key];
        else settings[key]=copy(value);
    }
}
const matches=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
/** Returns dry-run proposal and conflicts; does not mutate any supplied object. */
export function planRegistryMigration(settings,{mapping={},owners={}}={}) {
    const before=snapshot(safeObject(settings));
    const after=copy(before),conflicts=[],quarantined=[],changes=[];
    const targetSources=new Map();
    const sourceNames=new Set([...before.vecthare_collection_registry,
        ...Object.keys(before.collections),...Object.keys(before.vecthare_chunk_meta_by_collection),
        ...Object.values(before.chatCollectionPolicies).flatMap(p=>Array.isArray(p?.selectedCollections)?p.selectedCollections:[])]);
    for(const source of sourceNames) {
        if(typeof source!=='string' || !source || !legacySource(source)) continue;
        const target=mapping[source];
        if (!knownParts(target)) {
            quarantined.push({source,reason:'explicit-qualified-remap-required'});
            continue;
        }
        // Even byte-identical legacy metadata represents separately owned records.
        // Merging two sources into one target loses registry identity and policy rights.
        const priorSource=targetSources.get(target);
        if(priorSource && priorSource!==source) {
            conflicts.push({source,target,reason:'multiple-legacy-owners'});continue;
        }
        targetSources.set(target,source);
        if(source===target) continue;
        const hasSource=own(before.collections,source),hasTarget=own(before.collections,target);
        const recordSource=own(before.vecthare_chunk_meta_by_collection,source),recordTarget=own(before.vecthare_chunk_meta_by_collection,target);
        if ((hasSource && before.vecthare_collection_registry.includes(target) && !hasTarget) ||
            (hasSource&&hasTarget && !matches(before.collections[source],before.collections[target])) ||
            (recordSource&&recordTarget&&!matches(before.vecthare_chunk_meta_by_collection[source],before.vecthare_chunk_meta_by_collection[target]))) {
            conflicts.push({source,target,reason:'existing-qualified-record-conflict'});continue;
        }
        if (hasSource && own(after.collections,target) && !matches(after.collections[target],before.collections[source])) {
            conflicts.push({source,target,reason:'multiple-legacy-owners'}); continue;
        }
        const meta=before.collections[source];
        if (hasSource && !hasTarget) {
            const verified=validateOwner(meta,owners[source]);
            after.collections[target]={...copy(meta), ...(verified?{}:{enabled:false,ownershipReviewRequired:true})};
        }
        if(hasSource) delete after.collections[source];
        if(recordSource&&!recordTarget) after.vecthare_chunk_meta_by_collection[target]=copy(before.vecthare_chunk_meta_by_collection[source]);
        if(recordSource) delete after.vecthare_chunk_meta_by_collection[source];
        after.vecthare_collection_registry=after.vecthare_collection_registry.map(x=>x===source?target:x);
        for(const policy of Object.values(after.chatCollectionPolicies)) {
            if(!Array.isArray(policy?.selectedCollections)) continue;
            policy.selectedCollections=policy.selectedCollections.map(x=>x===source?target:x);
        }
        changes.push({source,target,ownerVerified:hasSource?validateOwner(meta,owners[source]):null});
    }
    after.vecthare_collection_registry=[...new Set(after.vecthare_collection_registry)];
    // Never silently suppress a conflicting migration by subsequently committing.
    // A proposal with conflicts is for review only; commit() always refuses it.
    // Unresolved legacy records MUST NOT retain activation rights. Keep the
    // legacy records for review, but disable them, preserving existing locks.
    for(const item of quarantined) {
        if(own(after.collections,item.source)) after.collections[item.source]={...after.collections[item.source],enabled:false,ownershipReviewRequired:true};
    }
    after.vecthare_registry_schema_version=REGISTRY_SCHEMA_VERSION;
    const changed=!matches(before,after);
    return {status:conflicts.length?'conflict':quarantined.length?'requires-remap':'ready',schemaVersion:REGISTRY_SCHEMA_VERSION,
        changes,conflicts,quarantined,changed,before,after};
}
/** Commit only after explicit approval. Saved backup remains in settings until user clears it. */
export function commitRegistryMigration(settings,plan,{approved=false,persist}={}) {
    if(!approved || typeof persist!=='function') return {status:'blocked',reason:'explicit-approval-and-persistence-required'};
    if (!plan || plan.conflicts?.length || plan.quarantined?.length) return {status:'blocked',reason:'unresolved-conflicts-or-owners'};
    if(!matches(snapshot(settings),plan.before)) return {status:'blocked',reason:'registry-changed-since-dry-run'};
    if(settings.vecthare_registry_backup) return {status:'blocked',reason:'existing-backup-must-be-reviewed'};
    // A large registry needs a separate durable backup store; do not double
    // extension_settings size and risk truncating its normal save.
    if (new TextEncoder().encode(JSON.stringify(plan.before)).byteLength > MAX_INLINE_REGISTRY_BACKUP_BYTES)
        return {status:'blocked',reason:'external-durable-backup-required'};
    if(!plan.changed) return {status:'unchanged'};
    const backup=copy(plan.before);
    const previous=copy(plan.before);
    settings.vecthare_registry_backup={schemaVersion:REGISTRY_SCHEMA_VERSION,before:backup,after:copy(plan.after)};
    applySnapshot(settings,plan.after);
    try {
        const acknowledged=persist();
        if (acknowledged && typeof acknowledged.then==='function') {
            // A caller must use the async commit wrapper if persistence is asynchronous.
            applySnapshot(settings,previous);delete settings.vecthare_registry_backup;
            return {status:'blocked',reason:'asynchronous-persistence-requires-async-api'};
        }
        if (acknowledged!==true) {
            applySnapshot(settings,previous);delete settings.vecthare_registry_backup;
            return {status:'blocked',reason:'durable-persistence-not-acknowledged'};
        }
    } catch (_) {applySnapshot(settings,previous);delete settings.vecthare_registry_backup;return {status:'blocked',reason:'persist-failed'};}
    return {status:'committed',changes:plan.changes.length,backupAvailable:true};
}
/** Rollback only if the registry is unchanged since migration. No silent overwrites. */
export function rollbackRegistryMigration(settings,{approved=false,persist}={}) {
    const backup=settings?.vecthare_registry_backup;
    if(!approved || !backup || typeof persist!=='function') return {status:'blocked',reason:'backup-approval-persistence-required'};
    if(!matches(snapshot(settings),backup.after)) return {status:'blocked',reason:'post-migration-registry-has-changed'};
    const next=copy(backup.before),was=copy(backup.after);
    applySnapshot(settings,next);
    try {if(persist()!==true){applySnapshot(settings,was);return {status:'blocked',reason:'durable-persistence-not-acknowledged'};}}
    catch (_){applySnapshot(settings,was);return {status:'blocked',reason:'persist-failed'};}
    delete settings.vecthare_registry_backup;
    return {status:'rolled-back'};
}
/** Stage B mode defaults to read-only: no SillyTavern debounced save can acknowledge durability. */
export function inspectRegistryMigration(settings, options={}) { const report=planRegistryMigration(settings,options);return {status:report.status,changes:report.changes,conflicts:report.conflicts,quarantined:report.quarantined,changed:report.changed,version:report.schemaVersion}; }

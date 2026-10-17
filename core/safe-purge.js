import { saveVectHareSettingsDebounced as saveSettingsDebounced } from './settings-durability.js';
/** Scoped, fail-closed purge of VectHare-owned collections.
 * NEVER call the legacy plugin-wide /purge-all or native /api/vector/purge-all:
 * those also delete unrelated SillyTavern vectors and don't purge remote Qdrant.
 */
import { extension_settings } from '../../../../extensions.js';
import { getRequestHeaders } from '../../../../../script.js';
import { parseRegistryKey } from './collection-ids.js';
import { getCollectionRegistry, unregisterCollection } from './collection-loader.js';
import { assertQdrantIdentity, forgetQdrantIdentity, qdrantDestination } from './physical-identity.js';
import { deleteCollectionMeta } from './collection-metadata.js';
import { retireChatChunkManifest } from './vectorization-profile.js';
import { forgetDeletedCollection } from './collection-ownership.js';
import { clearAllRecovery, clearRecoveryForCollection } from './sync-checkpoints.js';
import { getBackend } from '../backends/backend-manager.js';
import { hasActiveVectorWrite, createOperationControl, detachOperationControl } from '../ui/operation-controls.js';

const belongsToVectHare = id => /^(?:vecthare_|vh:)/.test(id);
const backendName = b => b === 'vectra' ? 'standard' : b;
const idFor = key => parseRegistryKey(key).collectionId;

/**
 * Backend inventory is independent from the local registry and must be
 * available BEFORE any destructive action. Unknown or ambiguous objects block
 * the entire purge rather than being silently skipped.
 */
export async function planVectHarePurge(settings,{skipActive=false}={}) {
    if(!skipActive && hasActiveVectorWrite())throw new Error('Another vector-writing operation is active. Stop or finish it before purging.');
    const requested = settings.vector_backend || 'standard';
    if(!['standard','qdrant'].includes(requested))
        throw new Error(`${requested} cannot guarantee scoped deletion. Switch to Standard or Qdrant to purge those supported stores.`);
    // Inventory may contain BOTH Standard and Qdrant collections. Initialise
    // the configured Qdrant destination before asking the plugin to inspect
    // its server; never trust a previous connection that pointed elsewhere.
    const known=(extension_settings.vecthare?.vecthare_collection_registry||[]);
    const hasQdrantRecords=[...known,...Object.keys(extension_settings.vecthare?.collections||{})]
        .some(key=>parseRegistryKey(key).backend==='qdrant');
    if(requested==='qdrant'||hasQdrantRecords)
        await getBackend({...settings,vector_backend:'qdrant'});
    const response = await fetch('/api/plugins/similharity/vecthare/purge-inventory', {
        headers: getRequestHeaders(),
    });
    if (!response.ok) throw new Error(`Cannot obtain complete purge inventory (${response.status}): ${await response.text()}`);
    const inventory = await response.json();
    if (inventory?.success !== true || !Array.isArray(inventory.targets)) {
        throw new Error('Plugin returned an invalid or incomplete purge inventory');
    }
    const targets = [...new Map(inventory.targets.filter(x =>
        ['standard','qdrant'].includes(backendName(x.backend)) && belongsToVectHare(x.collectionId))
        .map(x=>[`${backendName(x.backend)}:${x.collectionId}`, {...x,backend:backendName(x.backend)}])).values()];
    const unsupported = inventory.targets.filter(x =>
        !['standard','qdrant'].includes(backendName(x.backend)));
    if(unsupported.length)throw new Error('Inventory contains unsupported VectHare backends; refusing an incomplete Purge All');
    if ((requested==='qdrant'||hasQdrantRecords||targets.some(x=>x.backend==='qdrant')) &&
        inventory.qdrantScanned !== true)
        throw new Error('Remote Qdrant was not successfully scanned; nothing deleted');
    if(inventory.qdrantInitialized){
        const expected=qdrantDestination({...settings,vector_backend:'qdrant'}).replace(/^qdrant:v1:/,'').replace(/:multitenancy=(?:true|false)$/,'');
        if(inventory.qdrantEndpoint !== expected)
            throw new Error('Similharity is connected to a DIFFERENT Qdrant server than the configured destination. No deletion performed.');
    }
    const registry = getCollectionRegistry();
    const metaKeys = Object.keys(extension_settings.vecthare?.collections || {});
    const bindings = Object.values(extension_settings.vecthare?.chatCollectionBindings || {}).map(x => x?.registryKey).filter(Boolean);
    const knownKeys = [...new Set([...registry,...metaKeys,...bindings])];
    const unresolved = knownKeys.filter(key => {
        const p = parseRegistryKey(key);
        return !p.backend && belongsToVectHare(p.collectionId);
    });
    if (unresolved.length) throw new Error(`${unresolved.length} legacy collection identities lack a backend; resolve them before purging`);
    const knownSupported = knownKeys.filter(key => {
        const p = parseRegistryKey(key);
        return ['standard','qdrant'].includes(backendName(p.backend)) && belongsToVectHare(p.collectionId);
    });
    const unsupportedKnown=knownKeys.filter(key=>{
        const p=parseRegistryKey(key);
        return p.backend && !['standard','qdrant'].includes(backendName(p.backend)) && belongsToVectHare(p.collectionId);
    });
    if(unsupportedKnown.length)throw new Error(`${unsupportedKnown.length} registered VectHare collection(s) use unsupported storage; cannot guarantee full purge`);
    const unknownNames=knownKeys.filter(key=>{
        const p=parseRegistryKey(key);
        return p.backend && !belongsToVectHare(p.collectionId);
    });
    if(unknownNames.length)throw new Error(`${unknownNames.length} registered collection(s) lack a verifiable VectHare ownership prefix; cannot guarantee a complete data-only purge`);
    // Backend/source variants for the same physical collection must not be
    // deleted twice; all references are cleared only after verification.
    const planned = targets.map(target => {
        const keys = knownSupported.filter(key => backendName(parseRegistryKey(key).backend) === target.backend &&
            idFor(key) === target.collectionId);
        if (!keys.length) throw new Error(`Untracked VectHare collection ${target.collectionId} exists on ${target.backend}. Explicitly discover/adopt it before Purge All.`);
        if (target.backend === 'qdrant') {
            if (target.multitenancy !== !!settings.qdrant_multitenancy) {
                throw new Error(`Qdrant tenant mode disagrees with stored collection ${target.collectionId}`);
            }
            keys.forEach(key => assertQdrantIdentity(key, {...settings, vector_backend:'qdrant'}));
        }
        return {...target, keys};
    });
    // Local registry may contain collections not included in the inventory
    // because the database is unreachable, or the plugin omitted them.
    const discovered = new Set(planned.map(t => `${t.backend}:${t.collectionId}`));
    const absent = knownSupported.filter(key => !discovered.has(`${backendName(parseRegistryKey(key).backend)}:${idFor(key)}`));
    if (absent.length) {
        throw new Error(`Inventory did not confirm ${absent.length} registered collection(s): ${absent.slice(0,3).join(', ')}. Nothing deleted.`);
    }
    if (targets.some(x=>x.backend==='qdrant') && !inventory.qdrantInitialized) {
        throw new Error('Qdrant was not initialised by Similharity. Nothing deleted.');
    }
    return {backend:'standard+qdrant',targets:planned,count:planned.length,
        scope:'VectHare-owned collections in the local Standard store and currently configured Qdrant server (tenant-scoped where applicable)'};
}

/**
 * Data-only: preserves global settings and reusable provider config. Removes
 * connection/collection state ONLY after the relevant deletion is verified.
 * Reset mode resets settings only if EVERY scoped delete succeeds.
 */
export async function executeVectHarePurge(settings, plan, {resetSettings=false} = {}) {
    if (!plan || !Array.isArray(plan.targets)) throw new Error('A verified purge plan is required');
    if(hasActiveVectorWrite())throw new Error('Another vector-writing operation is active. Stop or finish it before purging.');
    const settingsSnapshot={...settings};
    const lockId=`vecthare-purge-${Date.now()}-${Math.random()}`;
    createOperationControl(lockId,{pausable:false,stoppable:false,writeOperation:true});
    try {
    // Re-inventory just before deleting, so an old modal cannot delete a
    // collection that appeared after the user reviewed the list.
    const fresh = await planVectHarePurge(settingsSnapshot,{skipActive:true});
    const signature = p => p.targets.map(t => `${t.backend}:${t.collectionId}:${t.multitenancy}`).sort().join('|');
    if (fresh.backend !== plan.backend || signature(fresh) !== signature(plan)) {
        throw new Error('Purge inventory changed since confirmation. Review again; nothing deleted.');
    }
    const completed=[];
    const failures=[];
    for (const target of fresh.targets) {
        const key=target.keys.find(k => parseRegistryKey(k).source === target.source) || target.keys[0];
        const parsed=parseRegistryKey(key);
        const scopedSettings={...settingsSnapshot,vector_backend:parsed.backend,source:parsed.source};
        try {
            // Deliberately do NOT use deleteCollection here: it deletes the
            // registry before confirming that every model/tenant index is gone.
            const backend=await getBackend(scopedSettings);
            // Rebind Similharity's singleton to the VERIFIED destination just
            // before each Qdrant destructive call; a cached backend object is
            // not proof that the server process still targets that endpoint.
            if(target.backend==='qdrant')await backend.initialize(scopedSettings);
            await backend.purgeVectorIndex(target.collectionId, scopedSettings);
            // A second independent backend inventory is the commit barrier.
            // Standard collections can have more than one model directory; a
            // successful HTTP 200 may only delete one of those directories.
            const response=await fetch('/api/plugins/similharity/vecthare/purge-inventory', {
                headers:getRequestHeaders(),
            });
            if(!response.ok)throw new Error(`Post-deletion inventory failed (HTTP ${response.status})`);
            const after=await response.json();
            if(after?.success!==true || !Array.isArray(after.targets))
                throw new Error('Post-deletion inventory is invalid');
            if(target.backend==='qdrant'){
                if(after.qdrantScanned!==true)throw new Error('Post-deletion Qdrant inventory could not be verified');
                const expected=qdrantDestination(scopedSettings).replace(/^qdrant:v1:/,'').replace(/:multitenancy=(?:true|false)$/,'');
                if(after.qdrantEndpoint!==expected)throw new Error('Qdrant server changed before post-deletion verification');
            }
            if(after.targets.some(x=>backendName(x.backend)===target.backend && x.collectionId===target.collectionId))
                throw new Error('Collection data still exists in the backend after deletion; registry and settings preserved');
            // Remove all aliases only AFTER the backend confirms absence.
            const values=extension_settings.vecthare;
            if(!resetSettings)values.archivedCollectionConfigurations ||= {};
            for(const recordKey of target.keys){
                // Full manifest text may also live in IndexedDB; purge it only
                // AFTER the backend confirms absence, before retiring metadata.
                await retireChatChunkManifest(recordKey);
                // KEEP means collection-specific configuration survives too,
                // as an INACTIVE archived recipe, never as an active collection.
                // Strip manifests and recovery/data fields: data-only purge
                // must not quietly retain copies of message-level data.
                if(!resetSettings && values.collections?.[recordKey]){
                    const {chatChunkManifest, syncCheckpoint, chunks, chunkMeta,
                        chunkCount, replacedBy, ...configuration}=values.collections[recordKey];
                    values.archivedCollectionConfigurations[recordKey]={
                        settings:configuration,
                        removedAt:new Date().toISOString(),
                        physicalIdentity:values.qdrantPhysicalIdentities?.[recordKey]||null,
                    };
                }
                unregisterCollection(recordKey);
                deleteCollectionMeta(recordKey);
                forgetDeletedCollection(recordKey);
                clearRecoveryForCollection(recordKey);
                if(target.backend==='qdrant')forgetQdrantIdentity(recordKey,scopedSettings);
            }
            completed.push(target.collectionId);
            saveSettingsDebounced();
        } catch(error) {
            failures.push({collectionId:target.collectionId,error:error.message});
        }
    }
    if (failures.length) {
        const error=new Error(`Partial purge: ${completed.length} confirmed, ${failures.length} failed. Settings and failed-collection metadata preserved. ${failures.map(f=>`${f.collectionId}: ${f.error}`).join('; ')}`);
        error.completed=completed; error.failures=failures;
        throw error;
    }
    if (resetSettings) {
        // Preserve extension enablement; all other settings will reinitialize
        // from defaults on next load. Never clear unrelated extension data.
        const enabled=extension_settings.vecthare?.enabled;
        // Reset in place: renderers, Auto-Sync, and the collection registry
        // must not keep a detached pre-purge settings object in memory.
        const live=extension_settings.vecthare||settings;
        for (const key of Object.keys(live)) if (key !== 'enabled') delete live[key];
        live.enabled=enabled;
        extension_settings.vecthare=live;
        if(settings!==live){for(const key of Object.keys(settings))if(key!=='enabled')delete settings[key];settings.enabled=enabled;}
        clearAllRecovery();
    }
    saveSettingsDebounced();
    return {completed,resetSettings};
    }finally{detachOperationControl(lockId);}
}

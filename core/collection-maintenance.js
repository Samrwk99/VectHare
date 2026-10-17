/** Safe collection inventory/maintenance. Never infer deletion from missing chat or discovery. */
import { getCollectionRegistry, deleteCollection } from './collection-loader.js';
import { getCollectionMeta, isCollectionEnabled } from './collection-metadata.js';
import { getCollectionOwner } from './collection-ownership.js';
import { getCollectionProfile } from './vectorization-profile.js';
import { parseRegistryKey } from './collection-ids.js';

/** Only a recorded staged replacement is provably a backup. */
export function getMaintenanceInventory(keys = getCollectionRegistry()) {
    const unique = [...new Set(keys)].filter(key => parseRegistryKey(key).backend);
    const known = new Set(unique);
    return unique.map(key => {
        const meta = getCollectionMeta(key);
        const profile = getCollectionProfile(key);
        const owner = getCollectionOwner(key);
        const isBackup = !!meta.replacedBy && known.has(meta.replacedBy);
        return {key, id:parseRegistryKey(key).collectionId, backend:parseRegistryKey(key).backend,
            source:parseRegistryKey(key).source, name:meta.displayName || parseRegistryKey(key).collectionId,
            backupOf:isBackup ? meta.replacedBy : null, replacementMissing:!!meta.replacedBy && !known.has(meta.replacedBy),
            owner, enabled:isCollectionEnabled(key), verified:!!profile?.embedding?.verified,
            hasProfile:!!profile, profile};
    });
}

/** Explicitly typed confirmation and ownership validation are mandatory. */
export async function deleteConfirmedBackup(key, confirmation, settings, inventory = getMaintenanceInventory()) {
    const candidate=inventory.find(x=>x.key===key);
    if(!candidate || !candidate.backupOf)throw new Error('Not a confirmed preserved replacement backup; deletion refused');
    if(candidate.owner)throw new Error('A chat still owns this collection; deletion refused');
    if(candidate.enabled)throw new Error('Disable retrieval for this collection before deleting its backup');
    if(confirmation!==key)throw new Error('Type the complete collection identity to confirm deletion');
    const parsed=parseRegistryKey(key);
    // Never reuse the currently selected storage target if it belongs elsewhere.
    const effective={...settings,vector_backend:parsed.backend,source:parsed.source};
    const result=await deleteCollection(parsed.collectionId,effective,key);
    if(result?.success!==true)throw new Error(`Delete not verified: ${(result?.errors||[]).join('; ')||'backend did not confirm deletion'}`);
    return result;
}

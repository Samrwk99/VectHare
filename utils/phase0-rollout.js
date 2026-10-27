/** Only optional code paths can be switched off. Destructive invariants are unconditional. */
export const phase0Flags=Object.freeze({verboseOperationEvents:false});
export const isFeatureEnabled=(name,overrides={})=>Object.hasOwn(phase0Flags,name) && (overrides[name] ?? phase0Flags[name]) === true;
export function snapshotRegistryBeforeMigration(registry) {
    if(!Array.isArray(registry) || registry.some(x=>typeof x!=='string')) throw new Error('Invalid registry snapshot');
    return {createdAt:new Date().toISOString(),entries:[...registry]};
}

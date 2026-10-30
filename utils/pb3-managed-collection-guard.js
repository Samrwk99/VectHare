/** P-B.3 — a browser-local registry row is not evidence that it can be
 * destructively managed through the old hash/collection-loader deletion path.
 * Only recognizable managed-v2 collection rows are classified here; server
 * mutation policy remains authoritative for all other routes. */
export function requiresManagedLifecycle(collection){
 if(!collection||typeof collection!=='object')return false;
 if(collection.managedV2===true||collection.schemaVersion===2||
  Number.isSafeInteger(collection.routingGeneration)&&collection.routingGeneration>=0||
  collection.managedGeneration!==undefined)return true;
 return ['physicalName','physicalCollection','id'].some(key=>
  typeof collection[key]==='string'&&/^vh2_[a-f0-9]{32,64}$/i.test(collection[key]));
}
export function assertLegacyCollectionDeletionAllowed(collection){
 if(requiresManagedLifecycle(collection))throw Error('PB3_MANAGED_LIFECYCLE_PLAN_REQUIRED');
 return true;
}

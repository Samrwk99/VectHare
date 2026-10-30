/** P14 interim guard: a legacy hash scene is never a managed-v2 metadata
 * mutation receipt. Scene editing remains draft-only until the source-bound
 * revision-checked metadata API is available. */
const managed=new Set(['qdrant','lancedb','vectra','milvus']);
export function requiresManagedSceneContract(settings){
 return managed.has(settings?.vector_backend??settings?.backend);
}
export function assertManagedSceneMutationSupported(settings){
 if(requiresManagedSceneContract(settings))throw Error('PB3_MANAGED_SCENE_METADATA_WRITE_UNAVAILABLE');
 return true;
}

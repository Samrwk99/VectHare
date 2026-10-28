/** C12 scene edit coordinator. Callback-driven to keep backend capabilities explicit. */
export function planSceneEdit(scene, patch) {
    if (!scene?.metadata?.isScene || scene.hash == null) throw new Error('Scene identity required');
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Scene patch required');
    const fields = Object.keys(patch);
    if (!fields.length || fields.some(key => !['title','summary','keywords'].includes(key)))
        throw new Error('Scene patch contains unsupported or immutable fields');
    if (patch.summary !== undefined && typeof patch.summary !== 'string') throw new Error('Summary must be text');
    if (patch.title !== undefined && typeof patch.title !== 'string') throw new Error('Title must be text');
    if (patch.keywords !== undefined && (!Array.isArray(patch.keywords) || patch.keywords.some(k=>typeof k !== 'string')))
        throw new Error('Keywords must be text items');
    const nextMetadata = {...scene.metadata,...patch};
    const summaryChanged = patch.summary !== undefined && patch.summary !== (scene.metadata.summary || '');
    return {kind:summaryChanged ? 'reindex' : 'metadata', oldHash:scene.hash,
        nextMetadata, original:scene, patch};
}

/**
 * Only a verified full backend receipt allows the local metadata to change.
 * For summary edits, remap all scene disable-links and references in one verified
 * transaction; a mere HTTP 200 or acknowledged write is not a commit.
 */
export async function updateSceneAndReindex({scene,patch,collectionKey,commitMetadata,replaceRecords,remapReferences,commitLocal,buildReplacement}) {
    const plan = planSceneEdit(scene,patch);
    if (!collectionKey) throw new Error('Qualified scene collection required');
    if (plan.kind === 'metadata') {
        if (typeof commitMetadata !== 'function') throw new Error('Verified backend metadata update required');
        const receipt=await commitMetadata(scene.hash,plan.nextMetadata,collectionKey);
        if (receipt?.status!=='confirmed' || receipt?.scope!==collectionKey || receipt?.recordId!==String(scene.hash))
            return {status:'needs-reconcile', reason:'Backend metadata update unverified'};
        if (typeof commitLocal === 'function') {
            try {await commitLocal(plan.nextMetadata,scene.hash);}
            catch {return {status:'needs-reconcile',reason:'Scene settings persistence unverified'};}
        }
        return {status:'committed',kind:'metadata',hash:scene.hash};
    }
    if (typeof replaceRecords!=='function' || typeof remapReferences!=='function' || typeof buildReplacement!=='function')
        throw new Error('C02 replacement and verified C07 reference migration required');
    const replacement=buildReplacement(scene,plan.nextMetadata);
    if (!replacement || replacement.hash == null || String(replacement.hash)===String(scene.hash) || replacement.metadata?.sceneId !== (scene.metadata.sceneId ?? String(scene.hash)))
        throw new Error('Scene replacement requires distinct physical ID and preserved scene identity');
    // remapReferences must participate in a verified commit, not run blindly after
    // an uncertain replacement. The callback returns an independently verified receipt.
    // Prepare every reference remap before touching the old record. A separate
    // "remap after delete" is NOT atomic and could strand disabled chunks.
    const prepared=await remapReferences({phase:'prepare',collectionKey,oldHash:scene.hash,
        newHash:replacement.hash,sceneId:replacement.metadata.sceneId});
    if (prepared?.status!=='prepared' || prepared?.collectionKey!==collectionKey || !prepared.referencePlanId)
        return {status:'needs-reconcile',reason:'Scene reference migration unverified; original preserved'};
    const receipt=await replaceRecords(collectionKey,[scene.hash],[replacement],{
        referencePlanId:prepared.referencePlanId,requireAtomicReferenceCommit:true});
    // Both the record replacement AND its reference switch must be committed
    // in the same verified operation. C02 currently cannot provide that proof.
    if (receipt?.status!=='committed' || receipt?.referencesCommitted!==true || receipt?.collectionKey!==collectionKey)
        return {status:'needs-reconcile',reason:'Atomic scene/reference replacement unverified',operationId:receipt?.operationId};
    if (typeof commitLocal==='function') {
        try {await commitLocal(plan.nextMetadata,replacement.hash);}
        catch {return {status:'needs-reconcile',reason:'Scene settings persistence unverified',operationId:receipt.operationId};}
    }

    return {status:'committed',kind:'reindex',hash:replacement.hash};
}

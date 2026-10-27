/** C06-B contract evidence auditor. This reports evidence completeness only;
 * it never grants runtime capabilities or enables destructive endpoints.
 */
const requiredEvidence=['serverSource','liveFixture'];
const requiredNegative=['http-200-success-false','http-500','partial-count','tenant-filter-negative'];
export function auditBackendContract(manifest, {backend,serverVersion,serverCommit}={}) {
    const blockers=[];
    if (!manifest || manifest.backend!==backend || !['standard','qdrant','milvus','lancedb'].includes(backend))
        return {backend,status:'invalid',readyForLiveAcceptance:false,blockers:['missing-or-mismatched-backend']};
    for(const k of requiredEvidence) if(!manifest.evidence?.[k]) blockers.push(`missing-${k}`);
    if(!serverVersion || manifest.verifiedVersion!==serverVersion) blockers.push('deployed-version-not-pinned');
    if(!serverCommit || manifest.evidence?.serverCommit!==serverCommit) blockers.push('server-commit-not-pinned');
    const negatives=new Set((manifest.negativeCases||[]).map(x=>x?.name));
    for(const t of requiredNegative) if(!negatives.has(t)) blockers.push(`missing-negative-${t}`);
    const statuses=new Set(Object.values(manifest.capabilities||{}));
    if([...statuses].some(x=>!['verified','unsupported','unknown'].includes(x))) blockers.push('invalid-capability-status');
    const endpoints=manifest.endpoints||[];
    if(!Array.isArray(endpoints)||endpoints.length===0 || endpoints.some(e=>!e?.url?.startsWith('/api/') || !['GET','POST','DELETE','PUT','PATCH'].includes(e.method)))
        blockers.push('endpoint-evidence-missing-or-invalid');
    // Advisory verdict only. No local fixture is independent proof that the
    // server currently deployed by a user has the same behavior.
    return {backend,status:blockers.length?'unverified':'candidate',readyForLiveAcceptance:false,blockers};
}

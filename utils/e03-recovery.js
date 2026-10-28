/** E03 startup recovery is read-only. It reports uncertainty; it NEVER
 * resends inserts, deletes, purges or settings migrations on reload.
 */
export function buildRecoveryReport({journal=[],writeMarkers=[],deletionMarkers=[],journalError=null}={}) {
    if(!Array.isArray(journal)||!Array.isArray(writeMarkers)||!Array.isArray(deletionMarkers))
        throw new Error('E03 invalid recovery input');
    const pending=journal.filter(op=>op?.phase!=='committed').map(op=>({
        kind:'c02',operationId:String(op?.operationId||'unknown'),
        collectionKey:String(op?.collectionKey||'unknown'),
        phase:String(op?.phase||'unknown'),action:'manual-read-only-reconcile',
    }));
    const writes=writeMarkers.map(op=>({kind:'c03',operationId:String(op?.id||'unknown'),
        collectionKey:String(op?.collectionKey||'unknown'),phase:'uncertain',action:'manual-read-only-reconcile'}));
    const deletions=deletionMarkers.map(op=>({kind:'c01',operationId:String(op?.key||'unknown'),
        collectionKey:String(op?.key||'unknown'),phase:String(op?.stage||'unknown'),action:'manual-read-only-reconcile'}));
    if(journalError)pending.push({kind:'c02',operationId:'journal-unavailable',collectionKey:'unknown',phase:'unverified',action:'inspect-storage'});
    const incidents=[...pending,...writes,...deletions];
    return {status:incidents.length?'needs-reconciliation':'clear',readOnly:true,
        canAutoRetry:false,canAutoDelete:false,canAutoClear:false,
        count:incidents.length,incidents};
}

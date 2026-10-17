/**
 * P2 #34/#44 — verified, collection-scoped keyword inventory.
 * Never count one page as a full collection, treat backend errors as empty,
 * or scan an unqualified Qdrant physical collection without tenant scoping.
 */
export async function countCollectionKeywords(backend, registryKey, settings, {maxItems=20000}={}) {
    if (!backend || typeof backend.listChunks !== 'function') throw new Error('Backend does not support scoped chunk listing');
    const max = Math.min(20000, Math.max(1, Number(maxItems) || 20000));
    const qdrant = settings.vector_backend === 'qdrant';
    const counts=new Map(), seenHashes=new Set(), seenCursors=new Set();
    let cursor=null, offset=0, examined=0;
    while(true) {
        const pageSize=Math.min(200, max-examined+1);
        const page=await backend.listChunks(registryKey, settings,
            qdrant ? {cursor,pageSize} : {offset,limit:pageSize});
        if (!page || !Array.isArray(page.items)) throw new Error('Keyword inventory returned a malformed page');
        if (qdrant && page.pageMode !== 'cursor')
            throw new Error('Keyword inventory requires a supported Qdrant cursor endpoint');
        for (const item of page.items) {
            const hash=item.hash ?? item.metadata?.hash;
            if(hash == null || item.metadata?.unverifiedNativeMetadata)
                throw new Error('Keyword inventory contains unverified chunk metadata');
            if(seenHashes.has(String(hash)))continue;
            seenHashes.add(String(hash));
            if(++examined>max)throw new Error(`Keyword inventory exceeds the ${max}-chunk safety limit. Narrow the collection or use indexed search.`);
            const keywords=item.metadata?.keywords ?? item.keywords ?? [];
            if(!Array.isArray(keywords))throw new Error('Malformed keyword metadata');
            for(const kw of keywords) {
                const text=(typeof kw==='object' ? kw?.text : kw);
                if(typeof text!=='string')continue;
                const normalized=text.trim().toLocaleLowerCase();
                if(normalized)counts.set(normalized,(counts.get(normalized)||0)+1);
            }
        }
        if(qdrant) {
            const next=page.nextCursor ?? page.next_cursor ?? null;
            if(next==null)break;
            const identity=JSON.stringify(next);
            if(seenCursors.has(identity))throw new Error('Keyword scan cursor repeated; inventory incomplete');
            seenCursors.add(identity);
            if(!page.items.length)throw new Error('Keyword scan returned an empty intermediate page');
            cursor=next;
        }else{
            if(!Number.isSafeInteger(page.total)||page.total<0)
                throw new Error('Keyword inventory requires an authoritative result count');
            offset+=page.items.length;
            if(offset>=page.total)break;
            if(!page.items.length)throw new Error('Keyword scan returned an incomplete page');
        }
    }
    return counts;
}

/** Shared authoritative comparison for Sync Chat and Scan/Repair. */
export function expectedEmbeddedText(item) {
    const keywords=(item.keywords||[]).map(k=>k.text||k).join(' ');
    return keywords ? `${item.text} [KEYWORDS: ${keywords}]` : String(item.text);
}
export function chunkMatchesExpected(stored,item) {
    if(!stored || !stored.metadata || !item)return false;
    const expected=expectedEmbeddedText(item);
    const text=String(stored.text??'');
    if(text!==String(item.text) && text!==expected)return false;
    const ids=m=>(m?.messageIds||[m?.messageId]).filter(x=>x!=null).map(String);
    const hashes=m=>Array.isArray(m?.messageHashes)?m.messageHashes.map(String):[];
    return JSON.stringify(ids(stored.metadata))===JSON.stringify(ids(item.metadata)) &&
        JSON.stringify(hashes(stored.metadata))===JSON.stringify(hashes(item.metadata));
}
/** Do not mistake failed/malformed/partial backend scans for an empty DB. */
export async function inspectCollectionChunks(backend,collectionId,settings,{onProgress,signal}={}) {
    if(typeof backend?.listChunks!=='function')throw new Error('Backend cannot inspect chunks for crash-safe resume');
    const rows=[];
    const pageSize=200;
    const cursorMode=settings?.vector_backend==='qdrant';
    const seenCursors=new Set();
    let cursor=null;
    for(let offset=0;offset<100000;offset+=pageSize){
        if(signal?.aborted)throw new Error('Inspection stopped');
        const result=await backend.listChunks(collectionId,settings,
            cursorMode ? {cursor,pageSize} : {offset,limit:pageSize});
        if(!Array.isArray(result?.items))throw new Error('Backend chunk inventory is unavailable or malformed; cannot safely resume');
        if(cursorMode && (result.pageMode!=='cursor' || typeof result.hasMore!=='boolean'))
            throw new Error('Matching Qdrant plugin cursor pagination is required for safe inspection');
        rows.push(...result.items);
        onProgress?.(rows.length);
        if(cursorMode){
            if(!result.hasMore)return rows;
            cursor=result.cursor;
            const id=JSON.stringify(cursor);
            if(cursor==null || seenCursors.has(id) || result.items.length===0)
                throw new Error('Qdrant inventory cursor stalled; refusing an incomplete scan');
            seenCursors.add(id);
        }else{
            // A full page isn't authoritative completion, even if offset+limit
            // matches a stale total. Request one more page to prove exhaustion.
            if(result.items.length<pageSize)return rows;
        }
    }
    throw new Error('Collection exceeds inspection safety limit; manual verification required');
}

/** C11-A: memory-bounded page traversal with explicit, tenant-qualified completeness evidence.
 * No page-length heuristic can ever establish the end of a collection.
 */
import {parseCollectionKey} from './collection-keys.js';

const partial = (key,reason,seen,pages) => ({status:'partial',complete:false,scope:key,recordIds:[...seen],pages,errors:[reason]});

/**
 * readPage({key,cursor,offset,limit}) -> {scope,items,endOfList,nextCursor?}
 * mode: 'cursor' or 'offset'. In offset mode the next offset is derived from the
 * actual unique page length; the server MUST affirm endOfList rather than just
 * returning fewer than limit. contractVerified must be obtained independently.
 */
export async function inventoryPages({key,readPage,mode,contractVerified=false,pageSize=250,maxPages=1000,expectedCount}={}) {
    if (!parseCollectionKey(key)) return {status:'error',complete:false,scope:key,recordIds:[],pages:0,errors:['invalid-collection-key']};
    if (!contractVerified || typeof readPage!=='function' || !['offset','cursor'].includes(mode))
        return {status:'unavailable',complete:false,scope:key,recordIds:[],pages:0,errors:['pagination-contract-unverified']};
    if (!Number.isSafeInteger(pageSize) || pageSize<1 || !Number.isSafeInteger(maxPages) || maxPages<1)
        return {status:'error',complete:false,scope:key,recordIds:[],pages:0,errors:['invalid-pagination-limits']};
    const seen=new Set(), cursors=new Set();
    let cursor=null, offset=0;
    for(let pageNo=0;pageNo<maxPages;pageNo++){
        const cursorId=cursor===null?'initial':`cursor:${String(cursor)}`;
        if (mode==='cursor' && cursors.has(cursorId)) return partial(key,'cursor-cycle',seen,pageNo);
        if (mode==='cursor') cursors.add(cursorId);
        let result;
        try {result=await readPage({key,cursor,offset,limit:pageSize});}
        catch (_) {return partial(key,'page-read-failed',seen,pageNo);}
        if (!result || result.scope!==key || !Array.isArray(result.items) || result.items.length>pageSize)
            return partial(key,'unverified-page-scope-or-shape',seen,pageNo+1);
        const pageIds=new Set();
        for(const item of result.items){
            const id=item?.recordId;
            if (!['string','number'].includes(typeof id) || String(id)==='' || item.collectionKey!==key)
                return partial(key,'unverified-record-owner',seen,pageNo+1);
            if (seen.has(String(id)) || pageIds.has(String(id))) return partial(key,'duplicate-record-across-pages',seen,pageNo+1);
            pageIds.add(String(id));
        }
        for(const id of pageIds) seen.add(id);
        if (result.endOfList===true){
            if (expectedCount!==undefined && (!Number.isSafeInteger(expectedCount)||expectedCount!==seen.size))
                return partial(key,'count-mismatch',seen,pageNo+1);
            return {status:'complete',complete:true,endOfListConfirmed:true,scope:key,recordIds:[...seen],count:seen.size,pages:pageNo+1,errors:[]};
        }
        if (result.endOfList!==false || pageIds.size===0) return partial(key,'end-or-progress-unverified',seen,pageNo+1);
        if(mode==='offset') {
            // A backend that ignores offsets will repeat records; that fails above.
            offset+=result.items.length;
            if (!Number.isSafeInteger(offset)) return partial(key,'offset-overflow',seen,pageNo+1);
        } else {
            const next=result.nextCursor;
            if (!['string','number'].includes(typeof next) || String(next)==='' || String(next)===String(cursor))
                return partial(key,'cursor-progress-unverified',seen,pageNo+1);
            cursor=next;
        }
    }
    return partial(key,'max-pages-exhausted',seen,maxPages);
}

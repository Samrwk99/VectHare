/** C06 + C11 Stage A: bridge verified adapter list-pages to a C01 inventory.
 * This wrapper deliberately does not guess server pagination or ownership.
 */
import {parseCollectionKey} from './collection-keys.js';
import {hasVerifiedCapability} from './backend-contracts.js';
import {inventoryPages} from './c11-paginated-inventory.js';

export async function inspectAdapterInventory({key,adapter,settings,mode='offset',pageSize=250,maxPages=1000,expectedCount}={}) {
    const parsed=parseCollectionKey(key);
    if(!parsed) return {status:'error',complete:false,scope:key,recordIds:[],errors:['invalid-key']};
    if(parsed.backend!==(settings?.vector_backend||'standard') || parsed.source!==settings?.source)
        return {status:'unavailable',complete:false,scope:key,recordIds:[],errors:['backend-route-mismatch']};
    // An adapter's existence does NOT constitute evidence that pagination or
    // tenant filters work on a particular plugin/server version.
    if(!hasVerifiedCapability(parsed.backend,'listPagination') || !hasVerifiedCapability(parsed.backend,'completeInventory') ||
       !hasVerifiedCapability(parsed.backend,'tenantFilter') || !hasVerifiedCapability(parsed.backend,'count') ||
       !adapter || typeof adapter.listScopedPage!=='function' || typeof adapter.countScopedRecords!=='function')
        return {status:'unavailable',complete:false,scope:key,recordIds:[],errors:['inventory-contract-unverified']};
    // Independently counted, fully scoped records are needed for C01 proofs.
    // Legacy listChunks() returns an inconsistent capped envelope and cannot
    // establish completeness or per-record ownership.
    let verifiedCount;
    try {verifiedCount=await adapter.countScopedRecords(key,settings);}
    catch (_) {return {status:'partial',complete:false,scope:key,recordIds:[],errors:['scoped-count-failed']};}
    if (!Number.isSafeInteger(verifiedCount) || verifiedCount<0 ||
        (expectedCount!==undefined && expectedCount!==verifiedCount))
        return {status:'partial',complete:false,scope:key,recordIds:[],errors:['count-unverified-or-mismatch']};
    return inventoryPages({key,mode,contractVerified:true,pageSize,maxPages,expectedCount:verifiedCount,
        readPage:async ({offset,cursor,limit})=>{
            const page=await adapter.listScopedPage(key,{offset,cursor,limit,mode},settings);
            if (page?.scope!==key || !Array.isArray(page.items)) return null;
            return page;
        }});
}

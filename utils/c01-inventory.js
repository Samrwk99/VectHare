/** C01 authoritative inventory. A page is never presumed final merely because it is short. */
import {parseCollectionKey} from './collection-keys.js';

const incomplete = (scope, reason, ids = [], errors = []) => ({status:'partial',complete:false,scope,recordIds:ids,errors:[reason,...errors]});

/**
 * listPage({key,cursor}) -> {scope,items, endOfList:boolean, nextCursor?}.
 * A real adapter must expose a pinned, verified contract before this is used
 * as destructive evidence. A capped/failed/repeated/unknown page is partial.
 */
export async function collectScopedInventory({key,listPage,contractVerified=false,maxPages=1000,expectedCount}={}) {
    if (!parseCollectionKey(key)) return {status:'error',complete:false,scope:key,recordIds:[],errors:['invalid-key']};
    if (contractVerified !== true || typeof listPage !== 'function') return {status:'unavailable',complete:false,scope:key,recordIds:[],errors:['inventory-contract-unverified']};
    const seenCursors = new Set();
    const records = new Set();
    let cursor = null;
    for (let page = 0; page < maxPages; page++) {
        const identity = cursor === null ? 'first' : `cursor:${String(cursor)}`;
        if (seenCursors.has(identity)) return incomplete(key,'repeated-cursor',[...records]);
        seenCursors.add(identity);
        let result;
        try { result = await listPage({key,cursor}); }
        catch (error) { return incomplete(key,'list-error',[...records]); }
        if (!result || result.scope !== key || !Array.isArray(result.items)) return incomplete(key,'invalid-or-cross-scope-page',[...records]);
        for (const item of result.items) {
            if (!item || !['string','number'].includes(typeof item.recordId) || String(item.recordId).length === 0)
                return incomplete(key,'missing-record-identity',[...records]);
            if (item.collectionKey !== undefined && item.collectionKey !== key)
                return incomplete(key,'cross-scope-record',[...records]);
            records.add(String(item.recordId));
        }
        if (result.endOfList === true) {
            if (expectedCount !== undefined && (!Number.isSafeInteger(expectedCount) || records.size !== expectedCount))
                return incomplete(key,'count-mismatch',[...records]);
            return {status:'complete',complete:true,scope:key,recordIds:[...records],errors:[],endOfListConfirmed:true};
        }
        if (result.endOfList !== false || !['string','number'].includes(typeof result.nextCursor) || String(result.nextCursor).length === 0)
            return incomplete(key,'pagination-end-unknown',[...records]);
        if (String(result.nextCursor) === String(cursor)) return incomplete(key,'no-cursor-progress',[...records]);
        cursor = result.nextCursor;
    }
    return incomplete(key,'page-limit',[...records]);
}

/** Unknown is deliberately different from an available but empty record. */
export function metadataEvidence(collections, key) {
    if (!collections || typeof collections !== 'object') return {status:'unavailable',exists:false};
    if (!Object.prototype.hasOwnProperty.call(collections,key)) return {status:'available',exists:false};
    const value=collections[key];
    if (!value || typeof value!=='object') return {status:'unavailable',exists:false};
    return {status:'available',exists:true,value};
}

/** Only an exhaustive backend-qualified collection index can justify orphan cleanup. */
export function planOrphanCollectionMetadataRemoval({inventory, collections, registry=[]}={}) {
    if (inventory?.status !== 'complete' || inventory.complete !== true || inventory.endOfListConfirmed !== true || !Array.isArray(inventory.collections) || !Array.isArray(inventory.verifiedScopes))
        return {allowed:false,reason:'authoritative-collection-inventory-unavailable',remove:[]};
    const serverKeys=new Set(inventory.collections);
    if ([...serverKeys].some(key=>!parseCollectionKey(key))) return {allowed:false,reason:'unqualified-inventory-collection',remove:[]};
    const covered = new Set(inventory.verifiedScopes);
    const registered=new Set(registry);
    const remove=[];
    for (const key of Object.keys(collections || {})) {
        const parsed=parseCollectionKey(key);
        if (!parsed) continue; // legacy ownership cannot be proven
        if (!covered.has(`${parsed.backend}:${parsed.source}`)) continue;
        if (!serverKeys.has(key) && !registered.has(key)) remove.push(key);
    }
    return {allowed:true,remove};
}

/**
 * Authoritative backend-qualified COLLECTION inventory for C01 #189.
 * Only pages positively identified as this backend/source contribute evidence.
 * The real adapters currently cannot assert this contract; callers must pass
 * contractVerified only with a separately pinned server capability.
 */
export async function collectCollectionInventory({backend,source,listPage,contractVerified=false,maxPages=1000,expectedCount}={}) {
    const scope=`${backend}:${source}`;
    if (!parseCollectionKey(`${scope}:inventory-validation`)) return {status:'error',complete:false,scope,collections:[],errors:['invalid-scope']};
    if (contractVerified!==true || typeof listPage!=='function') return {status:'unavailable',complete:false,scope,collections:[],errors:['collection-inventory-contract-unverified']};
    let cursor=null;
    const seen=new Set(), collections=new Set();
    const partial=reason=>({status:'partial',complete:false,scope,collections:[...collections],errors:[reason]});
    for(let page=0;page<maxPages;page++){
        const slot=cursor===null?'first':`cursor:${String(cursor)}`;
        if(seen.has(slot)) return partial('repeated-cursor');
        seen.add(slot);
        let response;
        try{response=await listPage({backend,source,cursor});}catch(_){return partial('list-error');}
        if(response?.scope!==scope || !Array.isArray(response.collections)) return partial('scope-or-response-unverified');
        for(const key of response.collections){
            const parsed=parseCollectionKey(key);
            if(!parsed || parsed.backend!==backend || parsed.source!==source) return partial('foreign-collection-in-page');
            collections.add(key);
        }
        if(response.endOfList===true){
            if(expectedCount!==undefined && (!Number.isSafeInteger(expectedCount)||collections.size!==expectedCount))return partial('count-mismatch');
            return {status:'complete',complete:true,scope,collections:[...collections],errors:[],verifiedScopes:[scope],endOfListConfirmed:true};
        }
        if(response.endOfList!==false || !['string','number'].includes(typeof response.nextCursor) || !String(response.nextCursor))return partial('pagination-end-unknown');
        if(String(response.nextCursor)===String(cursor))return partial('no-cursor-progress');
        cursor=response.nextCursor;
    }
    return partial('page-limit');
}

/** C01 #158: global legacy hash metadata is removable only when ALL owners
 * have a complete authoritative record-ID inventory and none contains it. */
export function mayRemoveLegacyHashMetadata({hash,registry=[],inventoryByCollection={}}={}) {
    if (!Array.isArray(registry) || hash===null || hash===undefined || typeof inventoryByCollection!=='object')
        return {allowed:false,reason:'ownership-unknown'};
    for(const key of registry){
        if(!parseCollectionKey(key)) return {allowed:false,reason:'legacy-registry-owner-unknown'};
        const inv=inventoryByCollection[key];
        if(inv?.complete!==true || inv?.status!=='complete' || inv?.scope!==key || inv?.endOfListConfirmed!==true || !Array.isArray(inv.recordIds))
            return {allowed:false,reason:'owner-inventory-incomplete'};
        if(inv.recordIds.map(String).includes(String(hash))) return {allowed:false,reason:'another-collection-owns-record'};
    }
    return {allowed:true,reason:'all-owners-excluded'};
}

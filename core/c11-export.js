/** C11 export integration. Never interprets the legacy chunks/list API as a
 * complete tenant inventory. A verified C06 adapter and capability proof are
 * required before writing a backup. The plugin is intentionally untouched.
 */
import {parseCollectionKey} from '../utils/collection-keys.js';
import {hasVerifiedCapability} from '../utils/backend-contracts.js';
import {exportVerifiedNDJSON,createBrowserExportWriter} from '../utils/c11-bounded-export.js';

export async function exportCollectionNDJSON({key,settings,adapter,writer,mode='offset',
    capability=hasVerifiedCapability,pageSize=250,maxPages=100000,signal,metadata}={}) {
    const parsed=parseCollectionKey(key);
    if (!parsed || parsed.backend !== (settings?.vector_backend || 'standard') || parsed.source !== settings?.source)
        throw Error('C11: qualified export route mismatch');
    for (const flag of ['listPagination','completeInventory','tenantFilter','count']) {
        if (capability(parsed.backend,flag)!==true) throw Error(`C11: ${flag} backend contract unverified; cannot produce complete export`);
    }
    if (typeof adapter?.listScopedPage!=='function' || typeof adapter?.countScopedRecords!=='function')
        throw Error('C11: verified scoped page/count adapter unavailable');
    return exportVerifiedNDJSON({key,mode,pageSize,maxPages,signal,metadata,writer,
        contractVerified:true,
        countRecords:async ({signal})=>{
            const result=await adapter.countScopedRecords(key,settings,{signal});
            return result?.scope===key && result?.contractVerified===true ? result : null;
        },
        readPage:async ({offset,cursor,limit,signal})=>{
            const page=await adapter.listScopedPage(key,{offset,cursor,limit,mode,includeVectors:true,signal},settings);
            return page?.scope===key && page?.contractVerified===true ? page : null;
        }});
}

/** E04: a read-only preflight, before a browser save is opened.
 * This is NOT a snapshot guarantee: the exporter independently recounts and
 * checks the inventory while writing. Failures must not leave an empty file
 * that a user might mistake for a successful backup.
 */
export async function preflightVerifiedCollectionExport({key,settings,adapter,capability=hasVerifiedCapability,signal}={}) {
    const parsed=parseCollectionKey(key);
    if (!parsed || parsed.backend !== (settings?.vector_backend || 'standard') || parsed.source !== settings?.source)
        return {ready:false,reason:'qualified-export-route-mismatch'};
    for(const flag of ['listPagination','completeInventory','tenantFilter','count']){
        if(capability(parsed.backend,flag)!==true)return {ready:false,reason:`unverified-${flag}`};
    }
    if(typeof adapter?.listScopedPage!=='function'||typeof adapter?.countScopedRecords!=='function')
        return {ready:false,reason:'scoped-inventory-adapter-missing'};
    if(signal?.aborted)return {ready:false,reason:'aborted'};
    try {
        const result=await adapter.countScopedRecords(key,settings,{signal});
        if(signal?.aborted)return {ready:false,reason:'aborted'};
        if(result?.scope!==key||result.contractVerified!==true||!Number.isSafeInteger(result.count)||result.count<0)
            return {ready:false,reason:'independent-count-unverified'};
        return {ready:true,count:result.count,scope:key};
    }catch(_){return {ready:false,reason:'independent-count-failed'};}
}

export async function downloadVerifiedCollectionNDJSON({key,settings,adapter,capability,filename,signal}={}) {
    const preflight=await preflightVerifiedCollectionExport({key,settings,adapter,
        capability:capability||hasVerifiedCapability,signal});
    if(!preflight.ready)throw Error(`C11: verified export not verified or unavailable (${preflight.reason}); no backup file opened`);
    const parsed=parseCollectionKey(key);
    const writer=await createBrowserExportWriter({filename:filename||`${parsed.collectionId}.vecthare.ndjson`});
    return exportCollectionNDJSON({key,settings,adapter,writer,capability,signal});
}

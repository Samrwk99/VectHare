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

export async function downloadVerifiedCollectionNDJSON({key,settings,adapter,capability,filename,signal}={}) {
    const parsed=parseCollectionKey(key);
    if (!parsed) throw Error('C11: qualified collection identity required');
    if (parsed.backend !== (settings?.vector_backend || 'standard') || parsed.source !== settings?.source)
        throw Error('C11: qualified export route mismatch');
    // Validate before opening the browser save dialog.
    for (const flag of ['listPagination','completeInventory','tenantFilter','count']) {
        if ((capability||hasVerifiedCapability)(parsed.backend,flag)!==true)
            throw Error('C11: complete backend inventory is not verified; no full backup was produced');
    }
    const writer=await createBrowserExportWriter({filename:filename||`${parsed.collectionId}.vecthare.ndjson`});
    return exportCollectionNDJSON({key,settings,adapter,writer,capability,signal});
}

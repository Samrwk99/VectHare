/** C06-B typed, fail-closed facade for *new* collection-scoped operations.
 * Until a pinned server contract is accepted, capabilities stay unavailable.
 * Existing legacy callers are not yet all routed through this facade.
 */
import {parseCollectionKey} from './collection-keys.js';
import {hasVerifiedCapability,BACKEND_CAPABILITIES} from './backend-contracts.js';
import {validateOperation} from './backend-operation-validation.js';
import {inventoryPages} from './c11-paginated-inventory.js';

export function createScopedFacade({resolveAdapter,settings,capability=hasVerifiedCapability}={}) {
    const scope = key => {
        const p=parseCollectionKey(key);
        if (!p) throw Error('Qualified collection identity required');
        if ((settings?.vector_backend || 'standard')!==p.backend || settings?.source!==p.source)
            throw Error('Qualified backend/source route mismatch');
        return p;
    };
    const need=(backend,flag)=>{if (capability(backend,flag)!==true) throw Error(`${backend}: ${flag} contract unverified`);};
    const getAdapter=async (p)=>{
        if(typeof resolveAdapter!=='function') throw Error('Backend resolver unavailable');
        const adapter=await resolveAdapter(p.backend);
        if (!adapter) throw Error('Backend adapter unavailable');
        return adapter;
    };
    const info=key=>{const p=scope(key);return {key,backend:p.backend,source:p.source,collectionId:p.collectionId,
        capabilities:BACKEND_CAPABILITIES[p.backend]||{}};};
    return Object.freeze({
        info,
        async list({key,mode='cursor',pageSize=250,maxPages=1000}={}) {
            const p=scope(key);
            for(const flag of ['listPagination','completeInventory','tenantFilter','count'])need(p.backend,flag);
            const adapter=await getAdapter(p);
            // The server must return a separately verified scoped count, not a
            // guessed number from the same capped page list.
            if(typeof adapter.countScopedRecords!=='function'||typeof adapter.listScopedPage!=='function')
                return {status:'unavailable',complete:false,scope:key,errors:['scoped-count-or-page-adapter-unavailable']};
            let expected;
            try {expected=await adapter.countScopedRecords(key,settings);} catch(_){return {status:'partial',complete:false,scope:key,errors:['count-failed']};}
            if (!Number.isSafeInteger(expected)||expected<0) return {status:'partial',complete:false,scope:key,errors:['count-unverified']};
            return inventoryPages({key,mode,contractVerified:true,pageSize,maxPages,expectedCount:expected,
                readPage: async args => adapter.listScopedPage(key,args,settings)});
        },
        async query({key,text,limit=10,queryVector}={}) {
            const p=scope(key);
            if(queryVector!==undefined) need(p.backend,'clientVectors');
            need(p.backend,'tenantFilter');
            if(typeof text!=='string'||!Number.isSafeInteger(limit)||limit<1) throw Error('Invalid query arguments');
            const a=await getAdapter(p);
            if(typeof a.queryScoped!=='function') throw Error('Scoped query adapter unsupported');
            const result=await a.queryScoped({key,text,limit,queryVector},settings);
            if(result?.scope!==key||!Array.isArray(result.items)||result.success===false)
                throw Error('Scoped query proof or response missing');
            if(result.items.some(x=>x?.collectionKey!==key)) throw Error('Cross-tenant query result');
            return result;
        },
        async upsert({key,items}={}) {
            const p=scope(key);need(p.backend,'tenantFilter');need(p.backend,'insertAcknowledgement');
            if(!Array.isArray(items)||!items.length) throw Error('Nonempty insert batch required');
            const a=await getAdapter(p);if(typeof a.upsertScoped!=='function') throw Error('Scoped upsert adapter unsupported');
            let response;
            try {response=await a.upsertScoped({key,items},settings);}catch(_){return {status:'uncertain',reason:'transport-or-adapter-failed'};}
            if(response?.scope!==key) return {status:'uncertain',reason:'unqualified-acknowledgement'};
            return validateOperation({kind:'upsert',sent:true,httpStatus:response.httpStatus,payload:response.payload,
                expectedCount:items.length,capabilities:{supported:true,countAcknowledgement:true}});
        },
        async remove({key,recordIds}={}) {
            const p=scope(key);need(p.backend,'tenantFilter');need(p.backend,'deleteAcknowledgement');
            if(!Array.isArray(recordIds)||!recordIds.length) throw Error('Nonempty delete IDs required');
            const a=await getAdapter(p);if(typeof a.deleteScoped!=='function') throw Error('Scoped delete adapter unsupported');
            let response;
            try {response=await a.deleteScoped({key,recordIds},settings);}catch(_){return {status:'uncertain',reason:'transport-or-adapter-failed'};}
            if(response?.scope!==key) return {status:'uncertain',reason:'unqualified-acknowledgement'};
            return validateOperation({kind:'delete',sent:true,httpStatus:response.httpStatus,payload:response.payload,
                expectedCount:recordIds.length,capabilities:{supported:true,countAcknowledgement:true}});
        },
    });
}

/** C06: typed, fail-closed facade for collection-scoped operations.
 * This interface NEVER upgrades backend capabilities or bypasses legacy guards.
 * Actual server capabilities remain unknown until independently verified.
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
    const validIds=(ids)=>Array.isArray(ids)&&ids.length>0&&ids.every(i=>(typeof i==='string'&&i.length>0)||(typeof i==='number'&&Number.isSafeInteger(i)))&&new Set(ids.map(String)).size===ids.length;
    const recordMatches=(r,key)=>r&&r.collectionKey===key&&(typeof r.recordId==='string'||typeof r.recordId==='number');
    const guardedCount=async(key,p,adapter)=>{
        need(p.backend,'count');need(p.backend,'tenantFilter');
        if (typeof adapter.countScopedRecords!=='function') return {status:'unavailable',scope:key};
        try {
            const result=await adapter.countScopedRecords(key,settings);
            // Legacy native integer is only accepted for internal inventory
            // traversal after a separately verified capability gate.
            if (Number.isSafeInteger(result) && result>=0) return {status:'confirmed',scope:key,count:result};
            if (result?.scope===key && result.contractVerified===true && Number.isSafeInteger(result.count)&&result.count>=0)
                return {status:'confirmed',scope:key,count:result.count};
        } catch (_) {return {status:'unavailable',scope:key};}
        return {status:'unavailable',scope:key};
    };
    return Object.freeze({
        info,
        /** Typed independent scoped count, never treat failed counts as zero. */
        async count({key}={}) {
            const p=scope(key);need(p.backend,'count');need(p.backend,'tenantFilter');
            const a=await getAdapter(p);return guardedCount(key,p,a);
        },
        async list({key,mode='cursor',pageSize=250,maxPages=1000}={}) {
            const p=scope(key);
            for(const flag of ['listPagination','completeInventory','tenantFilter','count'])need(p.backend,flag);
            const adapter=await getAdapter(p);
            if(typeof adapter.countScopedRecords!=='function'||typeof adapter.listScopedPage!=='function')
                return {status:'unavailable',complete:false,scope:key,errors:['scoped-count-or-page-adapter-unavailable']};
            const countResult=await guardedCount(key,p,adapter);
            if(countResult.status!=='confirmed') return {status:'partial',complete:false,scope:key,errors:['count-unverified']};
            return inventoryPages({key,mode,contractVerified:true,pageSize,maxPages,expectedCount:countResult.count,
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
        /** No client-side reconstruction of absent payload fields or guessed IDs. */
        async getByIds({key,recordIds}={}) {
            const p=scope(key);need(p.backend,'tenantFilter');need(p.backend,'pointTenantFilter');need(p.backend,'getByIds');
            if(!validIds(recordIds)) throw Error('Unique nonempty record IDs required');
            const a=await getAdapter(p);
            if(typeof a.getByIdsScoped!=='function') throw Error('Scoped point lookup unsupported');
            let result;
            try {result=await a.getByIdsScoped({key,recordIds},settings);}catch(_){return {status:'unavailable',scope:key,reason:'point-read-failed'};}
            if (result?.scope!==key||result.complete!==true||result.contractVerified!==true||!Array.isArray(result.items)||
                result.items.some(r=>!recordMatches(r,key))||
                new Set(result.items.map(x=>String(x.recordId))).size!==result.items.length||
                result.items.some(x=>!recordIds.map(String).includes(String(x.recordId))))
                return {status:'unavailable',scope:key,reason:'point-read-proof-missing'};
            return {status:'confirmed',scope:key,items:result.items,missingIds:recordIds.filter(id=>!result.items.some(x=>String(x.recordId)===String(id)))};
        },
        /** Metadata/position changes require the physical scoped updatePayload contract. */
        async updatePayload({key,updates}={}) {
            const p=scope(key);need(p.backend,'tenantFilter');need(p.backend,'pointTenantFilter');need(p.backend,'updatePayload');
            if (!Array.isArray(updates)||!updates.length||!validIds(updates.map(x=>x?.recordId))||
                updates.some(x=>!x?.metadata||typeof x.metadata!=='object'||Array.isArray(x.metadata)))
                throw Error('Qualified unique metadata updates required');
            const a=await getAdapter(p);
            if(typeof a.updatePayloadScoped!=='function') throw Error('Scoped payload update unsupported');
            let result;
            try {result=await a.updatePayloadScoped({key,updates},settings);}catch(_){return {status:'uncertain',reason:'transport-or-adapter-failed'};}
            if(result?.scope!==key||result.contractVerified!==true||result.confirmed!==true||result.updated!==updates.length)
                return {status:'uncertain',reason:'payload-update-proof-missing'};
            return {status:'confirmed',scope:key,count:updates.length};
        },
        async upsert({key,items}={}) {
            const p=scope(key);need(p.backend,'tenantFilter');need(p.backend,'insertAcknowledgement');
            if(!Array.isArray(items)||!items.length) throw Error('Nonempty insert batch required');
            if(items.some(i=>i?.collectionKey && i.collectionKey!==key)) throw Error('Cross-tenant insert item');
            const a=await getAdapter(p);if(typeof a.upsertScoped!=='function') throw Error('Scoped upsert adapter unsupported');
            let response;
            try {response=await a.upsertScoped({key,items},settings);}catch(_){return {status:'uncertain',reason:'transport-or-adapter-failed'};}
            if(response?.scope!==key) return {status:'uncertain',reason:'unqualified-acknowledgement'};
            return validateOperation({kind:'upsert',sent:true,httpStatus:response.httpStatus,payload:response.payload,
                expectedCount:items.length,capabilities:{supported:true,countAcknowledgement:true}});
        },
        async remove({key,recordIds}={}) {
            const p=scope(key);need(p.backend,'tenantFilter');need(p.backend,'deleteAcknowledgement');need(p.backend,'pointTenantFilter');
            if(!validIds(recordIds)) throw Error('Unique nonempty delete IDs required');
            const a=await getAdapter(p);if(typeof a.deleteScoped!=='function') throw Error('Scoped delete adapter unsupported');
            let response;
            try {response=await a.deleteScoped({key,recordIds},settings);}catch(_){return {status:'uncertain',reason:'transport-or-adapter-failed'};}
            if(response?.scope!==key) return {status:'uncertain',reason:'unqualified-acknowledgement'};
            return validateOperation({kind:'delete',sent:true,httpStatus:response.httpStatus,payload:response.payload,
                expectedCount:recordIds.length,capabilities:{supported:true,countAcknowledgement:true}});
        },
    });
}

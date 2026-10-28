/**
 * E05 Standard / LanceDB write contract primitives.
 * Offline/source-contract implementation ONLY: no runtime capability is granted
 * without a disposable-host probe and explicit deployment acceptance.
 *
 * Caller must supply a tenant/collection-scoped list page implementation.
 * Never treat echoed mutation counts or HTTP 200 as commitment evidence.
 */
import {fingerprint} from './record-identity.js';

const assert = (condition, reason) => { if (!condition) throw new Error(`E05 evidence unavailable: ${reason}`); };
const validHash = hash => (typeof hash === 'string' && hash.length > 0 && hash.length <= 256) || (typeof hash === 'number' && Number.isSafeInteger(hash));
const keyOf = hash => String(hash);

/** The plugin's sanitizeTableName() changes every disallowed character to '_'.
 * Refusing lossy names at write time avoids two logical names sharing a table.
 * Existing tables with lossy names are not declared safe retroactively.
 */
export function verifyWriteIdentity({backend,collectionId,source,model=''}={}) {
    assert(['standard','lancedb'].includes(backend),'unsupported-backend');
    assert(typeof collectionId === 'string' && collectionId.length > 0 && collectionId.length <= 255,'invalid-collection');
    assert(typeof source === 'string' && /^[A-Za-z0-9_.-]{1,96}$/.test(source),'invalid-source');
    assert(typeof model === 'string' && model.length <= 256,'invalid-model');
    if (backend === 'lancedb') assert(/^[A-Za-z0-9_.-]+$/.test(collectionId),'lancedb-lossy-table-name');
    return {backend,collectionId,source,model};
}

/** Validate the complete outgoing batch BEFORE any write; LanceDB's server
 * silently skips missing vectors, and both backends use hash as physical ID.
 */
export function validateWriteBatch(items,{backend}={}) {
    assert(['standard','lancedb'].includes(backend),'unsupported-backend');
    assert(Array.isArray(items) && items.length > 0 && items.length <= 1000,'invalid-batch-size');
    const seen=new Map(); let dim=null;
    for(const item of items){
        assert(item && typeof item==='object' && validHash(item.hash),'invalid-hash');
        assert(typeof item.text==='string' && item.text.length > 0,'invalid-text');
        assert(Array.isArray(item.vector) && item.vector.length > 0 && item.vector.length <= 65536,'missing-or-invalid-vector');
        assert(item.vector.every(x=>typeof x==='number' && Number.isFinite(x)),'nonfinite-vector');
        assert(dim===null || dim===item.vector.length,'mixed-vector-dimensions');
        dim=item.vector.length;
        const hash=keyOf(item.hash);
        assert(!seen.has(hash),'duplicate-batch-hash');
        seen.set(hash,item.text);
    }
    return {dimension:dim,hashes:[...seen.keys()]};
}

function checkedPage(data,offset,limit){
    assert(data && data.success===true && Array.isArray(data.items),'unsuccessful-page');
    assert(Number.isSafeInteger(data.offset) && data.offset===offset,'offset-mismatch');
    assert(Number.isSafeInteger(data.limit) && data.limit>0 && data.limit<=limit,'invalid-page-limit');
    assert(Number.isSafeInteger(data.total) && data.total>=0,'missing-authoritative-count');
    assert(typeof data.hasMore==='boolean','missing-end-marker');
    assert(data.items.length<=data.limit,'oversized-page');
    assert(data.offset+data.items.length<=data.total,'page-exceeds-total');
    assert(data.hasMore === (data.offset+data.items.length<data.total),'contradictory-page-marker');
    if(data.hasMore)assert(data.items.length>0,'empty-intermediate-page');
    return data;
}

async function oneSweep(listPage,{limit,maxPages,maxItems}){
    let offset=0,total=null; const seen=new Map();
    for(let n=0;n<maxPages;n++){
        const page=checkedPage(await listPage({offset,limit,includeVectors:false}),offset,limit);
        if(total===null)total=page.total;
        assert(total===page.total,'count-drift');
        for(const row of page.items){
            assert(row && validHash(row.hash) && typeof row.text==='string','invalid-record');
            const hash=keyOf(row.hash);
            assert(!seen.has(hash),'duplicate-physical-hash');
            seen.set(hash,{hash,text:row.text,metadata:row.metadata??{}});
        }
        assert(seen.size<=maxItems,'inventory-too-large');
        offset+=page.items.length;
        if(!page.hasMore){
            assert(offset===total && seen.size===total,'incomplete-inventory');
            return {rows:seen,count:total};
        }
    }
    throw new Error('E05 evidence unavailable: page-cap-exceeded');
}
function contentSignature(snapshot){
    return fingerprint([...snapshot.rows].sort(([a],[b])=>a.localeCompare(b)).map(([hash,item])=>[hash,item.text,item.metadata]));
}
/** Two independent complete passes guard against obvious pagination drift.
 * This does not provide snapshot isolation against third-party concurrent writes.
 * Web Lock coordination is required separately by the mutation coordinator.
 */
export async function collectVerifiedInventory(listPage,{limit=100,maxPages=100,maxItems=10000}={}){
    assert(typeof listPage==='function','missing-list-transport');
    assert(Number.isSafeInteger(limit) && limit>0 && limit<=1000,'invalid-limit');
    const a=await oneSweep(listPage,{limit,maxPages,maxItems});
    const b=await oneSweep(listPage,{limit,maxPages,maxItems});
    assert(a.count===b.count && contentSignature(a)===contentSignature(b),'inventory-changed-between-passes');
    return {complete:true,contractVerified:true,count:b.count,rows:b.rows,signature:contentSignature(b)};
}

/** Independent point readback must prove the VECTOR as well as the text.
 * A list of hashes alone cannot certify a semantic memory insertion.
 * LanceDB stores Float32 vectors; allow bounded roundoff from serialization.
 */
export function verifyInsertedPoint(expected,point){
    if(!point || keyOf(point.hash)!==keyOf(expected.hash) || point.text!==expected.text) return false;
    // Node/Express may JSON-serialize Float32Array as an object with dense
    // numeric keys rather than an array. Accept ONLY an exact dense shape.
    let actual;
    if(Array.isArray(point.vector) || ArrayBuffer.isView(point.vector))actual=Array.from(point.vector);
    else if(point.vector && typeof point.vector==='object' && !Array.isArray(point.vector)){
        const keys=Object.keys(point.vector);
        if(keys.length!==expected.vector.length || keys.some((k,i)=>k!==String(i)))return false;
        actual=keys.map(k=>point.vector[k]);
    }else return false;
    if(actual.length!==expected.vector.length)return false;
    if(!actual.every((v,i)=>typeof v==='number' && Number.isFinite(v) && Math.abs(v-expected.vector[i])<=1e-5))return false;
    if(expected.metadata && typeof expected.metadata==='object'){
        if(!point.metadata || typeof point.metadata!=='object')return false;
        for(const [key,value] of Object.entries(expected.metadata))
            if(fingerprint(point.metadata[key])!==fingerprint(value))return false;
    }
    return true;
}
export function evaluateWritePreflight(inventory,items){
    assert(inventory?.complete===true && inventory?.contractVerified===true && inventory.rows instanceof Map,'unverified-inventory');
    const collisions=[];
    for(const item of items)if(inventory.rows.has(keyOf(item.hash)))collisions.push(keyOf(item.hash));
    return {safe:collisions.length===0,collisions};
}
export function evaluateWriteReadback(before,after,items,{deleted=[]}={}){
    assert(before?.complete===true && after?.complete===true,'unverified-inventory');
    const newHashes=new Set(items.map(i=>keyOf(i.hash))),deletedHashes=new Set(deleted.map(keyOf));
    assert(![...newHashes].some(x=>deletedHashes.has(x)),'overlapping-delete-and-insert');
    const missing=[],mismatched=[],stillPresent=[],unexpected=[];
    for(const item of items){
        const found=after.rows.get(keyOf(item.hash));
        if(!found) missing.push(keyOf(item.hash));
        else if(found.text!==item.text) mismatched.push(keyOf(item.hash));
    }
    for(const hash of deletedHashes)if(after.rows.has(hash))stillPresent.push(hash);
    for(const [hash,row] of before.rows){
        if(deletedHashes.has(hash) || newHashes.has(hash))continue;
        const next=after.rows.get(hash);
        if(!next || row.text!==next.text || fingerprint(row.metadata)!==fingerprint(next.metadata)) unexpected.push(hash);
    }
    for(const hash of after.rows.keys())if(!before.rows.has(hash) && !newHashes.has(hash))unexpected.push(hash);
    const expected=before.count+items.length-deletedHashes.size;
    const countsMatch=after.count===expected;
    return {verified:missing.length===0&&mismatched.length===0&&stillPresent.length===0&&unexpected.length===0&&countsMatch,
        missing,mismatched,stillPresent,unexpected,countsMatch,expectedCount:expected,actualCount:after.count};
}

/** A callback-based transaction primitive usable by a disposable test harness
 * and later by the C02 coordinator after acceptance. It cannot override E02.
 * Any uncertainty is terminal pending manual reconciliation; no auto-retry.
 */
export async function executeVerifiedInsert({scope,items,listPage,getPoint,insert,journal,lock,contractAccepted=false}={}) {
    if(!contractAccepted)return {status:'blocked',reason:'live-contract-not-accepted'};
    if(!journal || typeof journal.create!=='function'||typeof journal.put!=='function'||typeof journal.get!=='function'||typeof lock!=='function')
        return {status:'blocked',reason:'durable-journal-or-lock-unavailable'};
    if(typeof insert!=='function' || typeof getPoint!=='function')return {status:'blocked',reason:'mutation-or-point-readback-unavailable'};
    verifyWriteIdentity(scope);
    validateWriteBatch(items,scope);
    return lock(`${scope.backend}|${scope.source}|${scope.collectionId}`,async()=>{
        const prior=await collectVerifiedInventory(listPage);
        const preflight=evaluateWritePreflight(prior,items);
        if(!preflight.safe)return {status:'blocked',reason:'existing-hash-collision',hashes:preflight.collisions};
        // Caller must use a durable journal that independently verifies its
        // writes (E03). No mutation is dispatched until create succeeds.
        if(typeof globalThis.crypto?.randomUUID!=='function')return {status:'blocked',reason:'secure-operation-id-unavailable'};
        const op={operationId:globalThis.crypto.randomUUID(),
            collectionKey:`${scope.backend}|${scope.source}|${scope.collectionId}`,phase:'staged',
            expectedIds:items.map(x=>keyOf(x.hash)),createdAt:Date.now()};
        const saved=await journal.create(op);
        const fresh=await journal.get(op.operationId);
        if(!saved || saved.operationId!==op.operationId || saved.phase!=='staged' ||
            !fresh || JSON.stringify(fresh)!==JSON.stringify(saved))
            return {status:'blocked',reason:'journal-not-verified'};
        let networkError=null;
        try { await insert(items); }catch(error){networkError=String(error?.message||error);}
        let proof;
        try{
            const after=await collectVerifiedInventory(listPage);
            proof=evaluateWriteReadback(prior,after,items);
            if(proof.verified){
                const pointFailures=[];
                for(const item of items){
                    const point=await getPoint(item.hash);
                    if(!verifyInsertedPoint(item,point))pointFailures.push(keyOf(item.hash));
                }
                if(pointFailures.length)proof={...proof,verified:false,pointFailures};
            }
        }catch(error){proof={verified:false,reason:String(error?.message||error)};}
        const completed={...op,phase:proof.verified?'verified':'needs-reconcile',updatedAt:Date.now(),
            reason:proof.verified?'independently-verified':networkError||proof.reason||'unconfirmed-mutation'};
        try{
            const written=await journal.put(completed);
            const reread=await journal.get(op.operationId);
            if(!reread || JSON.stringify(reread)!==JSON.stringify(written))throw new Error('readback failed');
        }catch{return {status:'needs-reconcile',reason:'journal-update-unverified',operationId:op.operationId};}
        if(!proof.verified)return {status:'needs-reconcile',reason:completed.reason,operationId:op.operationId,proof};
        return {status:'verified',operationId:op.operationId,proof};
    });
}

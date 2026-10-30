/** S05 strict, reusable read/inventory contracts. No HTTP read permission is granted here. */
import { canonicalScope, canonicalEmbedding, collectionIdentity, recordIdentity, contentFingerprint } from './s02-identity.js';
import { createHash } from 'node:crypto';
import {compareStoredVector} from './f03-vector-evidence.js';
import {assertM3VersionedBinding} from './m3-versioned-binding.js';

export class ReadError extends Error {
    constructor(code, message, status=409) { super(message); this.name='ReadError'; this.code=code; this.status=status; }
}
const isObject = x => !!x && typeof x==='object' && !Array.isArray(x);
const hex = x => createHash('sha256').update(x).digest('hex');
export function requireReadBinding(binding) {
    if (!isObject(binding) || binding.authorized !== true || binding.provenance !== 'SERVER_VERIFIED' ||
        !isObject(binding.scope) || !isObject(binding.embedding) || !isObject(binding.collection)) {
        throw new ReadError('S05_SOURCE_ATTESTATION_REQUIRED','Trusted source binding required');
    }
    const scope=canonicalScope(binding.scope), embedding=canonicalEmbedding(binding.embedding);
    const computed=collectionIdentity({backend:binding.backend,scope,embedding});
    if (typeof binding.collection.physicalName !== 'string' ||
        !/^vh2_[a-f0-9]{48}$/.test(binding.collection.physicalName) ||
        typeof binding.collection.key!=='string' || !/^[a-f0-9]{64}$/.test(binding.collection.key) ||
        binding.collection.key!==computed.key) {
        throw new ReadError('S05_COLLECTION_UNVERIFIED','Unverified physical collection binding');
    }
    // Only a journal-issued in-memory binding may replace the canonical target.
    if(binding.collection.physicalName!==computed.physicalName)assertM3VersionedBinding(binding);
    // A client may not forge this binding: trusted caller must attest ownership
    // AND verify the registry entry/host mapping before invoking an adapter.
    return Object.freeze({scope, embedding, physicalName:binding.collection.physicalName,collectionKey:binding.collection.key,
        generation:binding.collection.generation??0});
}
export function validateVector(vector, dimension, {optional=false}={}) {
    if (vector === undefined && optional) return null;
    if (!Number.isSafeInteger(dimension) || dimension<1 || dimension>65536 ||
        !Array.isArray(vector) || vector.length!==dimension ||
        !vector.every(x=>typeof x==='number' && Number.isFinite(x))) {
        throw new ReadError('S05_VECTOR_INVALID','Embedding must contain exactly the expected number of finite numeric values',400);
    }
    return vector;
}
export function validatedEmbedding(embedding) { return canonicalEmbedding(embedding); }
export function readPageOptions(input={}) {
    if (!isObject(input)) throw new ReadError('S05_PAGE_INVALID','Page options must be an object',400);
    const limit=input.limit??100;
    if (!Number.isSafeInteger(limit) || limit<1 || limit>256) throw new ReadError('S05_PAGE_INVALID','Page limit must be 1..256',400);
    if (input.cursor!==undefined && input.cursor!==null &&
        !(typeof input.cursor==='string' || Number.isSafeInteger(input.cursor))) {
        throw new ReadError('S05_CURSOR_INVALID','Invalid page cursor',400);
    }
    if (typeof input.cursor==='string' && (input.cursor.length===0 || input.cursor.length>512)) {
        throw new ReadError('S05_CURSOR_INVALID','Cursor exceeds permitted size',400);
    }
    if (input.includeVectors!==undefined && typeof input.includeVectors!=='boolean') {
        throw new ReadError('S05_PAGE_INVALID','includeVectors must be boolean',400);
    }
    return {limit,cursor:input.cursor??null,includeVectors:input.includeVectors===true};
}
export function ownedRecord(raw, binding, {includeVector=false}={}) {
    if (!isObject(raw)) throw new ReadError('S05_RECORD_INVALID','Backend returned invalid record');
    const b=requireReadBinding(binding), scope=b.scope;
    // Require authoritative top-level columns/payload fields, NOT client-provided metadata.
    const owner=raw; // Require physical backend columns/payload; never metadata.owner claims.
    if (!isObject(owner) || owner.userScopeId!==scope.userScopeId || owner.collectionId!==scope.collectionId ||
        owner.type!==scope.type || owner.sourceId!==scope.sourceId ||
        (owner.branchId||null)!==(scope.branchId??null)) {
        throw new ReadError('S05_OWNER_MISMATCH','Missing or conflicting physical ownership fields',403);
    }
    if (typeof raw.recordId!=='string') throw new ReadError('S05_RECORD_INVALID','Stable record identity missing');
    const rid=recordIdentity(scope,raw.recordId);
    if (raw.physicalId!==rid.physicalId) throw new ReadError('S05_PHYSICAL_ID_MISMATCH','Physical point identity conflicts with canonical scope',409);
    if (!Number.isSafeInteger(raw.revision) || raw.revision<1 || typeof raw.text!=='string') {
        throw new ReadError('S05_RECORD_INVALID','Invalid revision/text');
    }
    if (raw.textHash!==contentFingerprint(raw.text)) throw new ReadError('S05_CONTENT_MISMATCH','Text fingerprint mismatch');
    if (!isObject(raw.embedding) || JSON.stringify(canonicalEmbedding(raw.embedding))!==JSON.stringify(b.embedding)) {
        throw new ReadError('S05_EMBEDDING_MISMATCH','Embedding identity differs from collection contract');
    }
    if (!isObject(raw.metadata)) throw new ReadError('S05_RECORD_INVALID','Metadata must be an object');
    let metadataJson;
    try { metadataJson=JSON.stringify(raw.metadata); } catch { throw new ReadError('S05_RECORD_INVALID','Metadata cannot be serialized'); }
    if (!metadataJson || Buffer.byteLength(metadataJson)>32768) throw new ReadError('S05_RECORD_INVALID','Metadata too large');
    if (typeof raw.metadataHash!=='string' || raw.metadataHash!==hex(metadataJson)) {
        throw new ReadError('S05_METADATA_MISMATCH','Metadata fingerprint mismatch');
    }
    let vector;
    if(includeVector || raw.vector!==undefined){
        vector=validateVector(raw.vector,b.embedding.dimension);
        // Qdrant can normalize cosine vectors and backends commonly store float32.
        // A stored hash is *not* proof that the physical vector matches. When
        // present, a separately hashed original must agree with the actual vector.
        if(raw.vectorReference!==undefined){
            const reference=validateVector(raw.vectorReference,b.embedding.dimension);
            const verified=compareStoredVector({backend:binding.backend,metric:b.embedding.metric,
                expected:reference,actual:vector,dimension:b.embedding.dimension,expectedHash:raw.vectorHash});
            if(!verified.verified)throw new ReadError('F03_VECTOR_PHYSICAL_MISMATCH',verified.reason);
        }else if(raw.vectorHash!==hex(JSON.stringify(vector))){
            throw new ReadError('S05_VECTOR_MISMATCH','Unverifiable vector without physical reference');
        }
    }
    return {recordId:rid.recordId,physicalId:rid.physicalId,scope,revision:raw.revision,
        text:raw.text,textHash:raw.textHash,metadata:raw.metadata,metadataHash:raw.metadataHash,
        vector:vector,vectorHash:raw.vectorHash,...(includeVector&&raw.vectorReference?{vectorReference:raw.vectorReference}:{}),embedding:b.embedding};
}
export function validateSearchOptions(input,binding) {
    const b=requireReadBinding(binding);
    if (!isObject(input)) throw new ReadError('S05_QUERY_INVALID','Invalid query',400);
    const topK=input.topK??10;
    if (!Number.isSafeInteger(topK) || topK<1 || topK>100) throw new ReadError('S05_QUERY_INVALID','topK must be 1..100',400);
    validateVector(input.vector,b.embedding.dimension);
    return {vector:input.vector,topK};
}
/** A page by itself never proves consistent inventory across writes or restart. */
export function verifyPage(page,binding,options={}) {
    const b=requireReadBinding(binding);
    if (!isObject(page) || !Array.isArray(page.items) || typeof page.hasMore!=='boolean') {
        throw new ReadError('S05_PAGE_INVALID','Malformed backend page');
    }
    if (page.items.length>readPageOptions(options).limit) throw new ReadError('S05_PAGE_INVALID','Backend returned oversized page');
    if (page.hasMore && (page.nextCursor===null || page.nextCursor===undefined)) {
        throw new ReadError('S05_CURSOR_MISSING','Backend continuation cursor missing');
    }
    const seen=new Set();
    const items=page.items.map(item=>ownedRecord(item,binding,{includeVector:options.includeVectors===true}));
    for(const item of items) {
        if(seen.has(item.physicalId)) throw new ReadError('S05_DUPLICATE_RECORD','Duplicate record within page');
        seen.add(item.physicalId);
    }
    return {items,nextCursor:page.nextCursor??null,hasMore:page.hasMore,
        inventoryVerified:false,consistency:'UNVERIFIED',scopeVerified:true};
}
/** Bounded traversal checks duplicate/loop/ownership, but cannot assert snapshot consistency.
 * Caller must obtain backend-proven snapshot or immutable write quiescence separately. */
export async function walkInventory({binding,readPage,limit=100,maxPages=200,maxItems=20000}) {
    if (typeof readPage!=='function') throw new ReadError('S05_READER_REQUIRED','Page reader required');
    const pageOptions=readPageOptions({limit});
    if(!Number.isSafeInteger(maxPages)||maxPages<1||maxPages>2000 ||
        !Number.isSafeInteger(maxItems)||maxItems<1||maxItems>100000) throw new ReadError('S05_BOUNDS_INVALID','Inventory bounds invalid',400);
    const ids=new Set(),cursors=new Set(),items=[];let cursor=null,ended=false,pages=0;
    while(pages<maxPages) {
        const raw=await readPage({...pageOptions,cursor});
        const page=verifyPage(raw,binding,pageOptions);
        pages++;
        for(const item of page.items) {
            if(ids.has(item.physicalId)) throw new ReadError('S05_DUPLICATE_RECORD','Inventory repeated an identity');
            ids.add(item.physicalId);items.push(item);
            if(items.length>maxItems) throw new ReadError('S05_INVENTORY_BOUNDED','Inventory exceeded record limit');
        }
        if(!page.hasMore) {ended=true;break;}
        if(page.items.length===0) throw new ReadError('S05_PAGE_STALLED','Backend page did not advance');
        const key=JSON.stringify(page.nextCursor);
        if(cursors.has(key) || key===JSON.stringify(cursor)) throw new ReadError('S05_CURSOR_LOOP','Backend repeated a cursor');
        cursors.add(key);cursor=page.nextCursor;
    }
    if(!ended) throw new ReadError('S05_INVENTORY_BOUNDED','Inventory reached page limit');
    return {items,examined:items.length,pages,completeTraversal:true,
        inventoryVerified:false,consistency:'UNVERIFIED',verifiedExportAllowed:false};
}

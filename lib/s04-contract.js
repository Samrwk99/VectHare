import {assertM3VersionedBinding} from './m3-versioned-binding.js';
/** S04: schema validation / immutable planning; NEVER implies authorization. */
import { createHash, randomUUID } from 'node:crypto';
import {compareStoredVector} from './f03-vector-evidence.js';
import { canonicalScope, collectionIdentity, recordIdentity, contentFingerprint } from './s02-identity.js';

export class OperationError extends Error {
    constructor(code, message, status = 409) {
        super(message); this.name = 'OperationError'; this.code = code; this.status = status;
    }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIONS = new Set(['insert', 'update', 'delete', 'metadata']);
const PROTECTED = new Set(['userScopeId','ownerId','tenantId','collectionId','sourceId','type','branchId','recordId','physicalId','revision','vector','embedding']);
const isObj = x => x && typeof x === 'object' && !Array.isArray(x);
const sha = x => createHash('sha256').update(x).digest('hex');
function validateVector(vector, dimension) {
    if (!Array.isArray(vector) || vector.length !== dimension ||
        !vector.every(x => typeof x === 'number' && Number.isFinite(x))) {
        throw new OperationError('S04_VECTOR_INVALID', 'Vector must contain the required number of finite numeric values', 400);
    }
    if (dimension > 65536) throw new OperationError('S04_VECTOR_INVALID', 'Vector dimension too large', 400);
}
function checkMetadata(metadata) {
    if (!isObj(metadata)) throw new OperationError('S04_METADATA_INVALID','Metadata must be a plain object',400);
    if (Object.keys(metadata).some(k => PROTECTED.has(k) || k.startsWith('__'))) {
        throw new OperationError('S04_PROTECTED_METADATA','Protected identity fields cannot be modified',400);
    }
    let serialized;
    try { serialized=JSON.stringify(metadata); } catch { throw new OperationError('S04_METADATA_INVALID','Unserializable metadata',400); }
    if (!serialized || Buffer.byteLength(serialized)>32768) throw new OperationError('S04_METADATA_INVALID','Metadata exceeds size limit',400);
    return serialized;
}
export function planMutation(context, input, {trustedBinding=null}={}) {
    if (!context || typeof context.userScopeId !== 'string' || !isObj(input) || !isObj(input.scope)) {
        throw new OperationError('S04_REQUEST_INVALID','Authenticated mutation request and scope required',400);
    }
    if (Object.hasOwn(input.scope,'userScopeId') && input.scope.userScopeId !== context.userScopeId) {
        throw new OperationError('S04_SCOPE_MISMATCH','Client cannot change authenticated user scope',403);
    }
    if (Object.hasOwn(input,'userScopeId') && input.userScopeId !== context.userScopeId) {
        throw new OperationError('S04_SCOPE_MISMATCH','Client cannot change authenticated user scope',403);
    }
    if (!ACTIONS.has(input.action)) throw new OperationError('S04_ACTION_INVALID','Unsupported mutation action',400);
    const scope = canonicalScope({...input.scope,userScopeId:context.userScopeId});
    const collection = collectionIdentity({backend:input.backend,scope,embedding:input.embedding});
    let routed=null;
    if(trustedBinding!==null){
        const verified=assertM3VersionedBinding(trustedBinding);
        if(verified.key!==collection.key||trustedBinding.backend!==input.backend||
           JSON.stringify(trustedBinding.scope)!==JSON.stringify(scope)||
           JSON.stringify(trustedBinding.embedding)!==JSON.stringify(collection.embedding))
            throw new OperationError('M3_PLAN_BINDING_MISMATCH','Versioned collection scope does not match plan',403);
        routed=verified;
    }
    const rid = input.recordId ?? (input.action==='insert' ? randomUUID() : null);
    const record = recordIdentity(scope,rid);
    const opId = input.operationId ?? randomUUID();
    if (typeof opId !== 'string' || !UUID.test(opId)) throw new OperationError('S04_OPERATION_ID_INVALID','Operation ID must be UUID',400);
    const expectedRevision = input.expectedRevision;
    if (input.action==='insert') {
        if (expectedRevision !== undefined && expectedRevision !== 0) throw new OperationError('S04_REVISION_INVALID','Insert requires revision zero',400);
    } else if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
        throw new OperationError('S04_REVISION_REQUIRED','Expected revision >= 1 is required',400);
    }
    let textHash = null, vectorHash = null, metadataHash = null;
    if (['insert','update'].includes(input.action)) {
        if (typeof input.text !== 'string' || input.text.length === 0 || Buffer.byteLength(input.text)>1024*1024) {
            throw new OperationError('S04_TEXT_INVALID','Nonempty text under 1 MiB required',400);
        }
        validateVector(input.vector,collection.embedding.dimension);
        textHash=contentFingerprint(input.text);
        vectorHash=sha(JSON.stringify(input.vector));
    } else if (input.vector !== undefined || input.text !== undefined) {
        throw new OperationError('S04_ACTION_PAYLOAD_INVALID','Unexpected text/vector for this action',400);
    }
    if (input.metadata !== undefined) {
        if (input.action==='delete') throw new OperationError('S04_ACTION_PAYLOAD_INVALID','Delete must not contain metadata',400);
        metadataHash=sha(checkMetadata(input.metadata));
    }
    if (input.action==='metadata' && metadataHash === null) throw new OperationError('S04_METADATA_REQUIRED','Metadata update required',400);
    // Important: this plan contains *fingerprints only*, not text, vectors or secrets.
    // Caller-provided logical scope still has no server attestation of ownership.
    return Object.freeze({schemaVersion:4,operationId:opId.toLowerCase(),action:input.action,backend:collection.backend,
        collectionKey:collection.key,physicalCollectionName:routed?.name??collection.physicalName,
        ...(routed?{routingGeneration:routed.generation}:{}),
        scope,embedding:collection.embedding,recordId:record.recordId,physicalId:record.physicalId,
        expectedRevision:input.action==='insert'?0:expectedRevision,targetRevision:input.action==='insert'?1:expectedRevision+1,
        textHash,vectorHash,metadataHash,authorized:false,executionAllowed:false});
}
export function verifyMutationReadback(plan, item, {expectedVector=null}={}) {
    if (plan.action==='delete') return item === null ? {verified:true} : {verified:false,reason:'STILL_PRESENT'};
    if (!item || !isObj(item)) return {verified:false,reason:'NOT_PRESENT'};
    if (item.recordId !== plan.recordId || item.physicalId !== plan.physicalId ||
        item.scope?.userScopeId !== plan.scope.userScopeId || item.scope?.collectionId !== plan.scope.collectionId ||
        item.scope?.type !== plan.scope.type || item.scope?.sourceId !== plan.scope.sourceId ||
        (item.scope?.branchId??null) !== (plan.scope.branchId??null)) return {verified:false,reason:'OWNER_MISMATCH'};
    if (item.revision!==plan.targetRevision) return {verified:false,reason:'REVISION_MISMATCH'};
    if (plan.textHash!==null && item.textHash!==plan.textHash) return {verified:false,reason:'CONTENT_MISMATCH'};
    if (plan.vectorHash!==null) {
        if(item.vectorHash!==plan.vectorHash)return {verified:false,reason:'VECTOR_MISMATCH'};
        const original=Array.isArray(expectedVector)?expectedVector:
            (Array.isArray(item.vectorReference)?item.vectorReference:item.vector);
        if(!Array.isArray(original))return {verified:false,reason:'VECTOR_EVIDENCE_UNAVAILABLE'};
        const physical=compareStoredVector({backend:plan.backend,metric:plan.embedding.metric,
            expected:original,actual:item.vector,dimension:plan.embedding.dimension,expectedHash:plan.vectorHash});
        if(!physical.verified)return {verified:false,reason:physical.reason};
    }
    if (plan.metadataHash!==null && item.metadataHash!==plan.metadataHash) return {verified:false,reason:'METADATA_MISMATCH'};
    return {verified:true};
}

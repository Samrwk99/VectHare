/** C07: logical record identities are distinct from legacy backend hashes.
 * This module is host-independent and deliberately does not authorize backend mutation.
 */
import {parseCollectionKey} from './collection-keys.js';

const UID_FIELD = 'vecthareMessageUid';
const UID_RE = /^[a-zA-Z0-9_-]{12,128}$/;
const FINGERPRINT_VERSION = 'vh-fp2-fnv64';

export function fingerprint(value) {
    // FNV-1a 64-bit over UTF-8, implemented without crypto.subtle (plain HTTP hosts).
    const input = typeof value === 'string' ? value : stableJson(value);
    const bytes = new TextEncoder().encode(input);
    let hash = 0xcbf29ce484222325n;
    for (const byte of bytes) {
        hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
    }
    return `${FINGERPRINT_VERSION}:${hash.toString(16).padStart(16, '0')}`;
}
function stableJson(input) {
    if (input === null || typeof input !== 'object') return JSON.stringify(input);
    if (Array.isArray(input)) return `[${input.map(item => stableJson(item) ?? 'null').join(',')}]`;
    return `{${Object.keys(input).sort().filter(key => input[key] !== undefined).map(key => `${JSON.stringify(key)}:${stableJson(input[key])}`).join(',')}}`;
}
function required(value, name) {
    if (typeof value !== 'string' || !value.length) throw new Error(`Missing ${name}`);
    return value;
}
/** Collection-qualified logical identity. No claim that an adapter can use this as its physical storage key. */
export function recordId(collectionKey, localId) {
    if (!parseCollectionKey(collectionKey)) throw new Error('Unverified collection identity');
    return `${collectionKey}#${encodeURIComponent(required(localId, 'local record id'))}`;
}
export function diagnosticRecordKey(collectionKey, hash, metadata = {}) {
    const key = metadata?.recordId;
    if (typeof key === 'string' && key.startsWith(`${collectionKey}#`)) return key;
    return recordId(collectionKey, `hash:${String(hash)}`);
}
function randomUid() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID().replaceAll('-', '');
    if (globalThis.crypto?.getRandomValues) {
        const b = new Uint8Array(16); globalThis.crypto.getRandomValues(b);
        return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
    }
    // Do not stamp pseudo-random IDs: they would be treated as durable identity.
    throw new Error('Secure message UID generation is unavailable');
}
/** Stamps unique extension IDs onto the *actual* chat messages.
 * Caller is responsible for a verified durable chat save; an unsaved stamp is NOT a committed UID.
 * If a copied chat contains duplicate UIDs within itself, only later duplicates are restamped.
 */
export function stampMessageUids(chat, {createUid = randomUid} = {}) {
    if (!Array.isArray(chat)) throw new Error('Invalid chat snapshot');
    const used = new Set(), touched = [];
    for (let i = 0; i < chat.length; i++) {
        const message = chat[i];
        if (!message || typeof message !== 'object' || message.is_system) continue;
        const existing = message.extra?.[UID_FIELD];
        if (typeof existing === 'string' && UID_RE.test(existing) && !used.has(existing)) {
            used.add(existing); continue;
        }
        let uid;
        for (let tries = 0; tries < 5; tries++) {
            uid = createUid();
            if (typeof uid === 'string' && UID_RE.test(uid) && !used.has(uid)) break;
            uid = null;
        }
        if (!uid) throw new Error('Could not create a unique message UID');
        message.extra = { ...(message.extra || {}), [UID_FIELD]: uid };
        used.add(uid); touched.push(i);
    }
    return {changed: touched.length > 0, touched, total: used.size};
}
export function messageReference(chatId, messageOrUid) {
    required(chatId, 'verified chat ID');
    const uid = typeof messageOrUid === 'string' ? messageOrUid : messageOrUid?.extra?.[UID_FIELD];
    if (typeof uid !== 'string' || !UID_RE.test(uid)) throw new Error('Missing stable message UID');
    return `chat:${encodeURIComponent(chatId)}:message:${uid}`;
}
/** A group is named by its exact list of chat-qualified message memberships.
 * Hash of member list is versioned and stable under positional edits, not text edits.
 */
export function groupRecordLocalId(messageRefs, strategy = 'per_message') {
    if (!Array.isArray(messageRefs) || messageRefs.length === 0 || !messageRefs.every(x => typeof x === 'string' && x.startsWith('chat:')))
        throw new Error('Missing verified message membership');
    return `group:${strategy}:${fingerprint(messageRefs)}`;
}
/** No silent collision: identical text is a deterministic dedup with all memberships preserved;
 * different text sharing a legacy hash is unsafe for Standard and must be refused.
 */
export function checkCollision(items = []) {
    const map = new Map(), collisions = [], duplicates = [];
    for (const item of items) {
        const hash = String(item.hash);
        const text = item.raw ?? item.text;
        if (typeof text !== 'string') throw new Error('Collision check requires original text');
        const prior = map.get(hash);
        if (prior === undefined) {map.set(hash, {text, items:[item]}); continue;}
        if (prior.text !== text) collisions.push({hash, previous:prior.items[0], current:item});
        else {prior.items.push(item); duplicates.push({hash, current:item});}
    }
    return {safe: collisions.length === 0, collisions, duplicates, distinctHashes:map.size};
}
/** Position updates are proposals only: they require an updatePayload backend capability,
 * or C02's verified replacement protocol. Missing membership is never guessed from indices.
 */
export function reconcilePositions(records, chatId, chat) {
    const positions = new Map(), duplicated = new Set();
    for (let i = 0; i < chat.length; i++) {
        const uid = chat[i]?.extra?.[UID_FIELD];
        if (typeof uid === 'string' && UID_RE.test(uid)) {
            const ref = messageReference(chatId, uid);
            if (positions.has(ref)) duplicated.add(ref);
            positions.set(ref, i);
        }
    }
    return records.map(record => {
        const refs = record.metadata?.messageRefs ?? record.messageRefs;
        if (!Array.isArray(refs) || !refs.length || refs.some(ref => !positions.has(ref) || duplicated.has(ref)))
            return {status:'blocked',record,reason:'missing-or-legacy-membership'};
        const indices = refs.map(ref => positions.get(ref));
        return {status:'ready',record,metadata:{...record.metadata,messageIds:indices,messageId:indices[0],startIndex:Math.min(...indices),endIndex:Math.max(...indices)}};
    });
}
const SCALAR_REFS = ['parentId','parentHash','summaryHash','disabledByScene','originalSummaryHash'];
const ARRAY_REFS = ['linkedChunks','linkedHashes','containedHashes'];
/** Resolve scene boundary UIDs against the *current* saved chat.
 * New scenes use references; old positional-only scenes remain provisional.
 * A copied chat with a different integrity ID can never inherit those anchors.
 */
export function reconcileSceneBoundaries(scenes, chatId, chat) {
    if (!Array.isArray(scenes) || !Array.isArray(chat)) throw new Error('Invalid scene snapshot');
    const refs = new Map(),duplicates = new Set();
    for (let i=0; i<chat.length; i++) {
        const uid=chat[i]?.extra?.[UID_FIELD];
        if (typeof uid !== 'string' || !UID_RE.test(uid)) continue;
        const ref=messageReference(chatId,uid);
        if (refs.has(ref)) duplicates.add(ref);
        refs.set(ref,i);
    }
    return scenes.map(scene=>{
        const meta=scene?.metadata || {};
        if (!meta.sceneStartRef || !meta.sceneEndRef) return {status:'legacy',scene};
        if (duplicates.has(meta.sceneStartRef) || duplicates.has(meta.sceneEndRef) ||
            !refs.has(meta.sceneStartRef) || !refs.has(meta.sceneEndRef))
            return {status:'blocked',scene,reason:'missing-duplicate-or-foreign-boundary'};
        const start=refs.get(meta.sceneStartRef),end=refs.get(meta.sceneEndRef);
        if (end<start) return {status:'blocked',scene,reason:'reversed-scene-boundary'};
        return {status:'ready',scene,metadata:{...meta,sceneStart:start,sceneEnd:end}};
    });
}

/** Remap references, failing closed when an old ID is ambiguous or unverified. */
export function remapReferences(metadata, mapping, {requireMapped = false} = {}) {
    const oldToNew = mapping instanceof Map ? mapping : new Map(Object.entries(mapping || {}));
    const next = {...metadata}; const blocked = [];
    const resolve = (value) => {
        if (value === null || value === undefined) return value;
        const key = String(value);
        if (!oldToNew.has(key)) {if (requireMapped) blocked.push(key); return value;}
        const newId = oldToNew.get(key);
        if (typeof newId !== 'string' && typeof newId !== 'number') {blocked.push(key); return value;}
        return newId;
    };
    for (const field of SCALAR_REFS) if (next[field] !== undefined) next[field] = resolve(next[field]);
    for (const field of ARRAY_REFS) if (Array.isArray(next[field])) next[field] = next[field].map(resolve);
    return {status:blocked.length ? 'blocked':'ready',metadata:blocked.length ? metadata : next,unresolved:[...new Set(blocked)]};
}
export const MESSAGE_UID_FIELD = UID_FIELD;
export const RECORD_FINGERPRINT_VERSION = FINGERPRINT_VERSION;

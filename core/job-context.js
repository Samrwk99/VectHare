/** C03: in-tab chat-scoped job ownership; never treats an abort as proof a server write stopped. */
import { withCollectionLock, writeBarrier } from '../utils/keyed-mutex.js';
const MARKER_VERSION = 1;
const DEFAULT_MARKER_KEY = 'vecthare:c03:pending-operations';

export class StaleJobError extends Error {
    constructor(reason = 'stale-job') { super(`VectHare job cancelled: ${reason}`); this.name = 'StaleJobError'; this.reason = reason; }
}
const identityOf = value => value && typeof value === 'object' ? {
    chatId: String(value.chatId ?? ''),
    originId: String(value.originId ?? ''),
    groupId: String(value.groupId ?? ''),
    characterId: String(value.characterId ?? ''),
} : {chatId:'',originId:'',groupId:'',characterId:''};
const sameIdentity = (a,b) => {
    if(a.characterId !== b.characterId || a.groupId !== b.groupId) return false;
    // A persisted integrity UUID remains stable across filename renames.
    // Never fall back to a bare filename when only one side has a UUID.
    if(a.originId || b.originId) return Boolean(a.originId && b.originId && a.originId===b.originId);
    return a.chatId===b.chatId;
};

export function createJobCoordinator({ getIdentity, storage = null, markerKey = DEFAULT_MARKER_KEY } = {}) {
    if (typeof getIdentity !== 'function') throw new TypeError('getIdentity required');
    const jobs = new Map();
    const inFlight = new Map();
    let nextId = 0;
    const instanceId = (typeof globalThis.crypto?.randomUUID === 'function'
        ? globalThis.crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
    let generation = 0;
    let pending = [];
    // Bound persistent evidence even when a backend cannot verify thousands of
    // writes. Aggregate only settled uncertain entries; never discard a live one.
    function compactPending() {
        if (pending.length <= 160) return;
        const retained=[],aggregate=new Map();
        for(const op of pending) {
            if (op.status === 'in-flight' || inFlight.has(op.id) || retained.length < 100) {
                retained.push(op);continue;
            }
            const bucket=op.collectionKey || 'unknown';
            let item=aggregate.get(bucket);
            if(!item) {
                item={id:`c03-aggregate-${bucket}`,collectionKey:bucket,kind:'write',status:'uncertain',count:0};
                aggregate.set(bucket,item);
            }
            item.count += Number.isSafeInteger(op.count) && op.count>0 ? op.count : 1;
        }
        pending=[...retained,...aggregate.values()];
    }
    const store = storage;
    const persist = () => {
        if (!store) return false;
        try { const snapshot=JSON.stringify({version:MARKER_VERSION, operations:pending});
            store.setItem(markerKey,snapshot);
            // This is a browser-local marker check, NOT host settings durability.
            return store.getItem(markerKey)===snapshot; }
        catch { return false; }
    };
    try {
        const old = store?.getItem(markerKey);
        if (old) {
            const parsed = JSON.parse(old);
            // Malformed markers must block purge, not silently disappear.
            if (parsed.version !== MARKER_VERSION || !Array.isArray(parsed.operations)) throw new Error('bad-marker');
            pending = parsed.operations.filter(op => op && typeof op.id === 'string' && typeof op.collectionKey === 'string')
                .map(op => ({id:op.id,collectionKey:op.collectionKey,kind:String(op.kind||'write'),status:'uncertain', ...(Number.isSafeInteger(op.count)&&op.count>0?{count:op.count}:{})}));
            if (pending.length !== parsed.operations.length) throw new Error('invalid-items');
        }
    } catch { pending = [{id:'invalid-checkpoint',collectionKey:'unknown',kind:'write',status:'uncertain'}]; }
    compactPending();
    if (pending.length) writeBarrier.markUncertain();

    function startJob({kind, collectionKey = '', generationScoped = false} = {}) {
        if (!kind) throw new TypeError('kind required');
        const id = `c03-${instanceId}-${++nextId}`;
        const snapshot = Object.freeze({...identityOf(getIdentity()), collectionKey:String(collectionKey), generationId:generation});
        if (!snapshot.chatId && !snapshot.originId) throw new StaleJobError('missing-chat');
        const controller = new AbortController();
        const ctx = Object.freeze({
            id, kind, snapshot, signal:controller.signal,
            assertCurrent() {
                if (controller.signal.aborted || !jobs.has(id)) throw new StaleJobError('cancelled');
                if (!sameIdentity(snapshot, identityOf(getIdentity()))) throw new StaleJobError('chat-changed');
                if (generationScoped && snapshot.generationId !== generation) throw new StaleJobError('generation-changed');
                return true;
            },
            cancel(reason='cancelled') { if (!controller.signal.aborted) controller.abort(new StaleJobError(reason)); },
            finish() { jobs.delete(id); },
            async withLock(fn) { ctx.assertCurrent(); return withCollectionLock(snapshot.collectionKey, async () => {ctx.assertCurrent(); return fn(ctx);}, {signal:ctx.signal}); },
        });
        jobs.set(id,ctx);
        return ctx;
    }
    function cancelWhere(predicate,reason) { let count=0; for (const ctx of jobs.values()) if (predicate(ctx)) {ctx.cancel(reason); jobs.delete(ctx.id);count++;} return count; }
    function cancelAll(reason='teardown') {return cancelWhere(()=>true,reason);}
    function cancelKinds(kinds,reason='invalidated') {const allowed=new Set(kinds);return cancelWhere(ctx=>allowed.has(ctx.kind),reason);}
    function bumpGeneration(reason='generation-changed') { generation++; cancelWhere(ctx=>ctx.kind==='retrieval',reason);return generation; }

    // Write markers are persisted BEFORE transport begins. Never clear an abort,
    // timeout or malformed acknowledgement automatically; these need C02 reconciliation.
    function trackWrite(ctx, operationPromise, {collectionKey = ctx?.snapshot.collectionKey,kind='write'}={}) {
        ctx?.assertCurrent();
        const marker = {id:`c03-write-${instanceId}-${++nextId}`,collectionKey:String(collectionKey||''),kind:String(kind),status:'in-flight'};
        pending.push(marker);
        if (!persist()) {
            writeBarrier.markUncertain();
            marker.status='uncertain';
            // Never start a deferred network write without even a browser-local
            // journal marker. Existing already-started Promise inputs cannot be
            // cancelled here, so keep the uncertain marker in memory.
            if(typeof operationPromise==='function')throw new Error('C03 write blocked: pending marker persistence failed');
        }

        const promise = (async () => {
            try {
                const result = await (typeof operationPromise === 'function' ? operationPromise() : operationPromise);
                // A cancelled request could still have committed. Retain marker.
                if (ctx?.signal.aborted) throw new StaleJobError('late-write');
                if (!(result === true || result?.status === 'confirmed') || result?.requiresReconciliation) {
                    marker.status='uncertain'; writeBarrier.markUncertain(); persist();
                    return result;
                }
                pending = pending.filter(op=>op !== marker);
                persist();
                return result;
            } catch (error) {
                marker.status = 'uncertain';
                writeBarrier.markUncertain();
                persist();
                throw error;
            } finally { inFlight.delete(marker.id); compactPending(); persist(); }
        })();
        inFlight.set(marker.id,promise);
        // Observed by awaitInFlightWrites, and rejection handled by caller.
        return promise;
    }
    async function awaitInFlightWrites() {
        const outcomes = await Promise.allSettled([...inFlight.values()]);
        return {settled:outcomes.length,uncertain:pending.length>0};
    }
    function pendingOperations() {return pending.map(op=>({...op}));}
    function teardown() {
        cancelAll('teardown');
        // Can't await on unload: persist markers, conservatively classify active writes.
        for(const marker of pending) marker.status='uncertain';
        if(pending.length) writeBarrier.markUncertain();
        persist();
    }
    return {startJob,cancelAll,cancelKinds,bumpGeneration,trackWrite,awaitInFlightWrites,pendingOperations,teardown,
        get activeJobs(){return jobs.size;},get generation(){return generation;}};
}

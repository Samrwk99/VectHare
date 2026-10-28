/** E03: cooperative cross-tab mutex for qualified collection mutations.
 * Web Locks are required: localStorage leases and BroadcastChannel alone
 * cannot atomically enforce ownership. No fallback to in-tab-only locking.
 */
import {parseCollectionKey} from './collection-keys.js';
import {withCollectionLock} from './keyed-mutex.js';
export class CrossTabLockUnavailable extends Error {
    constructor(reason='web-locks-unavailable') {super(`E03 mutation blocked: ${reason}`);this.name='CrossTabLockUnavailable';this.reason=reason;}
}
export async function withCrossTabMutationLock(key,callback,{signal,locks=globalThis.navigator?.locks,timeoutMs=15000}={}) {
    const parsed=parseCollectionKey(key);
    if(!parsed)throw new CrossTabLockUnavailable('unqualified-collection-key');
    if(typeof callback!=='function')throw new TypeError('Mutation callback required');
    if(!locks || typeof locks.request!=='function')throw new CrossTabLockUnavailable();
    if(signal?.aborted)throw signal.reason || new CrossTabLockUnavailable('aborted');
    if(!Number.isFinite(timeoutMs)||timeoutMs<1||timeoutMs>60000)throw new CrossTabLockUnavailable('invalid-timeout');
    const controller=new AbortController();
    const onAbort=()=>controller.abort(signal.reason);
    signal?.addEventListener('abort',onAbort,{once:true});
    if(signal?.aborted)onAbort();
    // Timeout governs *waiting for the lock*, not a callback that may have
    // dispatched a network write. Never release the lock on an in-flight timeout.
    let acquired=false;
    const timeout=setTimeout(()=>{if(!acquired)controller.abort(new CrossTabLockUnavailable('lock-acquire-timeout'));},timeoutMs);
    try {
        // Shared-backend operations are conservatively serialized across ALL
        // logical tenants on this browser origin. This does not lock foreign
        // clients or a second browser origin; server guarantees remain needed.
        const physicalScope=['qdrant','milvus'].includes(parsed.backend)
            ? `shared:${parsed.backend}` : `collection:${key}`;
        const name=`vecthare:e03:${physicalScope}`;
        return await locks.request(name,{mode:'exclusive',signal:controller.signal},async lock=>{
            if(!lock)throw new CrossTabLockUnavailable('exclusive-lock-not-granted');
            acquired=true;clearTimeout(timeout);
            if(signal?.aborted)throw signal.reason || new CrossTabLockUnavailable('aborted');
            // Never pass the abort signal to the inner FIFO queue: its public
            // Promise can reject early while its queued work is still pending.
            // If we released the Web Lock at that point a later tab could
            // enter concurrently with that queued work. Check cancellation
            // when this slot actually starts, and hold the Web Lock through
            // the entire operation (including an in-flight abort).
            return withCollectionLock(key,async()=>{
                if(signal?.aborted)throw signal.reason || new CrossTabLockUnavailable('aborted');
                return callback();
            });
        });
    } catch(error) {
        if(controller.signal.aborted && !signal?.aborted)throw new CrossTabLockUnavailable('lock-acquire-timeout');
        throw error;
    } finally {clearTimeout(timeout);signal?.removeEventListener('abort',onAbort);}
}

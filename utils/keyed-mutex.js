/** In-tab collection serialization, no Web Locks or secure-context dependency. */
const tails = new Map();
export class PurgeInProgress extends Error {constructor(){super('PurgeInProgress: new writes are blocked');this.name='PurgeInProgress';}}
/**
 * Run an operation under a per-key FIFO lock.
 *
 * A queued caller may observe cancellation immediately, but its place in the
 * queue is not released until all preceding work has finished. Otherwise an
 * aborted middle waiter can unlock the key while its predecessor is active.
 * Once the callback has started, AbortSignal is the callback's responsibility:
 * cancellation cannot release the lock while the callback is still running.
 */
export async function withCollectionLock(key, callback, {signal}={}) {
    if (typeof key !== 'string' || !key) throw new Error('Collection lock requires a qualified key');
    if (signal?.aborted) throw signal.reason || new Error('Aborted');

    const previous = tails.get(key) || Promise.resolve();
    let release;
    const mine = new Promise(resolve => { release = resolve; });
    tails.set(key, mine);

    let started = false;
    let onAbort;
    // This only settles the calling promise early while the operation is queued.
    // The separate `work` promise always owns releasing this queue position.
    const queuedAbort = new Promise((_, reject) => {
        if (!signal) return;
        onAbort = () => {
            if (!started) reject(signal.reason || new Error('Aborted'));
        };
        signal.addEventListener('abort', onAbort, {once:true});
        if (signal.aborted) onAbort();
    });

    const work = (async () => {
        try {
            await previous;
            started = true;
            if (onAbort) signal.removeEventListener('abort', onAbort);
            if (signal?.aborted) throw signal.reason || new Error('Aborted');
            return await callback();
        } finally {
            // Do not resolve `mine` in the queued abort handler: later waiters
            // must remain behind the previous holder until it actually exits.
            release();
            if (tails.get(key) === mine) tails.delete(key);
        }
    })();

    return signal ? Promise.race([work, queuedAbort]) : work;
}
export function createWriteBarrier() {
    let closed=false;
    const active=new Set();
    let uncertain=false;
    return {
        enter() {if(closed) throw new PurgeInProgress(); const token={};active.add(token);return token;},
        leave(token,{uncertain:unknown=false}={}) {if(unknown) uncertain=true;active.delete(token);},
        markUncertain(){uncertain=true;},
        get inFlight(){return active.size;},
        get closed(){return closed;},
        async closeAndDrain({timeoutMs=15000}={}) {
            closed=true;
            const deadline=Date.now()+timeoutMs;
            while(active.size && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,Math.min(10,deadline-Date.now())));
            return {drained:active.size===0,verified:active.size===0 && !uncertain, uncertain};
        },
        reopen(){closed=false;},
        resetUncertainAfterReconciliation(){if(active.size) throw new Error('Writes still in flight');uncertain=false;}
    };
}
export const writeBarrier=createWriteBarrier();

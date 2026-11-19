/**
 * Step 8C: cross-tab leases.
 *
 * Before a tab writes to or deletes a collection (Sync, Repair, Rebuild,
 * Delete, scenes, chunk edits, Content Vectorizer), it takes a short lease on
 * that collection from the Similharity plugin. Another tab or device asking for
 * the same collection meanwhile is told it is busy, so the two never run the
 * same work at once. The identity-ledger versions (8B) remain the hard
 * guarantee; the lease is what keeps two tabs from even starting.
 *
 * - One random id per page load (`tabId`); leases are re-entrant within a tab.
 * - A lease expires on the server 180 s after its last renewal, so a closed or
 *   crashed tab blocks nobody for long. It is renewed with each batch
 *   (`touch()`) and by a timer; a paused run lets it go and takes it back on
 *   resume.
 * - A plugin without lease support (older build): every call succeeds and
 *   nothing changes compared with earlier builds.
 */

import { getRequestHeaders } from '../../../../../script.js';
import { vhLog } from '../utils/log.js';

const ROUTE = '/api/plugins/similharity/locks';
const RENEW_EVERY_MS = 45 * 1000;
const TOUCH_MIN_MS = 20 * 1000;
const PAUSE_RELEASE_MS = 30 * 1000;

const tabId = (() => {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    return 'tab_' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
})();

let supportPromise = null;
/** Whether the plugin offers leases (checked once per page load). */
export function leasesSupported() {
    supportPromise ??= (async () => {
        try {
            const response = await fetch('/api/plugins/similharity/health');
            if (!response.ok) return false;
            const data = await response.json();
            return data?.capabilities?.leases === 1;
        } catch {
            return false;
        }
    })();
    return supportPromise;
}

/** collectionId -> { token, count, lastRenew, released, lost, timer } */
const held = new Map();

async function post(action, body) {
    const response = await fetch(`${ROUTE}/${action}`, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ ...body, owner: tabId }),
    });
    const data = await response.json().catch(() => ({}));
    return { status: response.status, ok: response.ok, data };
}

/** Raised when another tab/device holds the collection. */
export class LeaseHeldError extends Error {
    constructor(label = '') {
        super('Another tab or device is working on this chat right now' +
            (label ? ` (${label})` : '') + '. Try again in a moment.');
        this.code = 'VH_LEASE_HELD';
    }
}

/**
 * Takes (or re-enters) the lease on `collectionId`.
 * @returns {Promise<object>} a handle with touch(), release(), isLost()
 * @throws {LeaseHeldError} when another tab holds it
 */
export async function acquireLease(collectionId, { label = '', isPaused = null } = {}) {
    const noop = { touch: async () => true, release: async () => {}, isLost: () => false, collectionId };
    if (!collectionId || !await leasesSupported()) return noop;

    let entry = held.get(collectionId);
    if (entry && !entry.lost && !entry.released) {
        entry.count++;
        return handleFor(collectionId, entry);
    }
    const result = await post('acquire', { collectionId, label });
    if (result.status === 409) throw new LeaseHeldError(result.data?.label);
    if (!result.ok || typeof result.data?.token !== 'string') {
        // The plugin supports leases but did not answer: do not start blind.
        throw new LeaseHeldError('lease unavailable');
    }
    entry = { token: result.data.token, count: 1, lastRenew: Date.now(), released: false, lost: false, isPaused, timer: null };
    held.set(collectionId, entry);
    entry.timer = setInterval(() => { void renew(collectionId, entry, false); }, RENEW_EVERY_MS);
    return handleFor(collectionId, entry);
}

async function renew(collectionId, entry, fromTouch) {
    if (entry.lost) return false;
    // A run paused for a while gives the lease up so other tabs are not
    // blocked; touch() takes it back on resume.
    if (!fromTouch && entry.isPaused?.() && Date.now() - entry.lastRenew > PAUSE_RELEASE_MS) {
        if (!entry.released) {
            entry.released = true;
            await post('release', { collectionId, token: entry.token }).catch(() => {});
            vhLog(`VectHare: Lease on ${collectionId} released while paused`);
        }
        return true;
    }
    if (entry.released) {
        const again = await post('acquire', { collectionId }).catch(() => null);
        if (again?.ok && typeof again.data?.token === 'string') {
            entry.token = again.data.token;
            entry.released = false;
            entry.lastRenew = Date.now();
            return true;
        }
        entry.lost = true;
        return false;
    }
    const result = await post('renew', { collectionId, token: entry.token }).catch(() => null);
    if (result?.ok) {
        entry.lastRenew = Date.now();
        return true;
    }
    if (result?.status === 409) entry.lost = true;
    return !entry.lost;
}

function handleFor(collectionId, entry) {
    let released = false;
    return {
        collectionId,
        /** Call at batch boundaries; false means stop (another tab took over). */
        touch: async () => {
            if (entry.lost) return false;
            if (entry.released || Date.now() - entry.lastRenew > TOUCH_MIN_MS) {
                return renew(collectionId, entry, true);
            }
            return true;
        },
        isLost: () => entry.lost,
        release: async () => {
            if (released) return;
            released = true;
            entry.count--;
            if (entry.count > 0) return;
            clearInterval(entry.timer);
            if (held.get(collectionId) === entry) held.delete(collectionId);
            if (!entry.released && !entry.lost) {
                await post('release', { collectionId, token: entry.token }).catch(() => {});
            }
        },
    };
}

/**
 * Runs `task(handle)` holding the lease on `collectionId`.
 * @throws {LeaseHeldError} when another tab holds it (task not run)
 */
export async function withLease(collectionId, task, options = {}) {
    const handle = await acquireLease(collectionId, options);
    try {
        return await task(handle);
    } finally {
        await handle.release();
    }
}

/** True if this tab currently holds the collection's lease (for re-entrant callers). */
export function holdsLease(collectionId) {
    const entry = held.get(collectionId);
    return Boolean(entry && !entry.lost && !entry.released);
}

// A closing page gives its leases back at once (keepalive requests may carry
// SillyTavern's CSRF header; sendBeacon could not). Expiry covers the rest.
try {
    window.addEventListener('pagehide', () => {
        for (const [collectionId, entry] of held) {
            if (entry.released || entry.lost) continue;
            try {
                void fetch(`${ROUTE}/release`, {
                    method: 'POST', headers: getRequestHeaders(), keepalive: true,
                    body: JSON.stringify({ collectionId, token: entry.token, owner: tabId }),
                }).catch(() => {});
            } catch { /* best effort */ }
        }
    });
} catch { /* no window (tests) */ }

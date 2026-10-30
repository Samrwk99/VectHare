/** P-B.11 managed browser invalidation, not a source of backend truth.
 * Never broadcast IDs, text, credentials, receipts, or source selectors.
 * Cross-tab notifications are advisory: every refreshed view still reads the
 * authenticated plugin. An uncertain/dispatched mutation invalidates too.
 */
const STORAGE_KEY = 'vecthare:managed-view-invalidated:v1';
const subs = new Set();
export function publishManagedViewInvalidation({sender = null, storage = undefined} = {}) {
    for (const sub of [...subs]) {
        if (sender === null || sub.identity !== sender) sub.notify('mutation');
    }
    try {
        const nonce = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
        (storage === undefined ? globalThis.localStorage : storage)?.setItem?.(STORAGE_KEY, JSON.stringify({version: 1, nonce}));
    } catch { /* blocked storage: same-tab notifications still work */ }
}
/** An untrusted storage event can only discard cached UI state. */
export function watchManagedViewInvalidation(notify, {
    identity = null, window = globalThis.window,
    document = globalThis.document,
} = {}) {
    if (typeof notify !== 'function') throw new TypeError('PB11_LISTENER_REQUIRED');
    const sub = {identity, notify};
    subs.add(sub);
    const remote = event => {
        if (event?.key !== STORAGE_KEY || typeof event.newValue !== 'string' || event.newValue.length > 256) return;
        try {
            const data = JSON.parse(event.newValue);
            if (data?.version === 1 && typeof data.nonce === 'string' && data.nonce.length <= 100)
                notify('other-tab');
        } catch { /* malformed/unrelated storage is not a backend event */ }
    };
    const resume = () => notify('tab-resumed');
    const visibility = () => { if (document?.visibilityState === 'visible') resume(); };
    window?.addEventListener?.('storage', remote);
    window?.addEventListener?.('focus', resume);
    document?.addEventListener?.('visibilitychange', visibility);
    return () => {
        subs.delete(sub);
        window?.removeEventListener?.('storage', remote);
        window?.removeEventListener?.('focus', resume);
        document?.removeEventListener?.('visibilitychange', visibility);
    };
}
export const PB11_STORAGE_KEY = STORAGE_KEY;

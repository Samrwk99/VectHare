/** Per-collection reverse-sync scheduling; only successful passes start cooldown. */
export function createReverseSyncThrottle(intervalMs, now = () => Date.now()) {
    const lastSuccessful = new Map();
    const forced = new Set();
    return {
        force(collectionId) {
            if (collectionId) forced.add(collectionId);
        },
        shouldRun(collectionId) {
            if (!collectionId) return false;
            return forced.has(collectionId) ||
                !lastSuccessful.has(collectionId) ||
                now() - lastSuccessful.get(collectionId) >= intervalMs;
        },
        markSuccessful(collectionId) {
            if (!collectionId) return;
            lastSuccessful.set(collectionId, now());
            forced.delete(collectionId);
        },
    };
}

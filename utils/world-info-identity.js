/** C08: normalize world-info identifiers without guessing that a keyword is a UID.
 * A world-qualified UID is the stable cross-book identity. Bare UIDs are accepted
 * only when unambiguous in a supplied active snapshot.
 */
const norm = value => String(value ?? '').trim().toLowerCase();
const keyTexts = value => (Array.isArray(value) ? value : value == null ? [] : [value])
    .map(v => typeof v === 'string' || typeof v === 'number' ? v : v?.text ?? v?.keyword ?? '')
    .map(norm).filter(Boolean);

export function normalizeWorldInfoEntry(entry, fallbackWorld = null) {
    if (entry == null || typeof entry !== 'object') return null;
    const world = norm(entry.world ?? entry.worldName ?? entry.lorebookName ?? entry.book ?? entry.world_name ?? fallbackWorld);
    const uid = norm(entry.uid ?? entry.entryUid ?? entry.entry_uid);
    if (!world || !uid) return null; // No verified source identity: never invent one.
    return Object.freeze({world,uid,id:`${world}:${uid}`,key:keyTexts(entry.key ?? entry.keys ?? entry.keywords)});
}

/** Map/group/object/array event payloads are accepted only when identity fields exist. */
export function normalizeWorldInfoEntries(payload) {
    const entries = [];
    const visit = (node, world = null, depth = 0) => {
        if (depth > 4 || node == null) return;
        if (Array.isArray(node) || node instanceof Set) {
            for (const item of node) visit(item, world, depth + 1);
            return;
        }
        if (node instanceof Map) {
            for (const [key, value] of node) {
                const composite = String(key);
                const delimiter = composite.lastIndexOf('.');
                const fromKey = delimiter > 0 && value?.uid != null &&
                    norm(composite.slice(delimiter + 1)) === norm(value.uid)
                    ? composite.slice(0,delimiter) : composite;
                visit(value, world || fromKey, depth + 1);
            }
            return;
        }
        if (typeof node !== 'object') return;
        const entry = normalizeWorldInfoEntry(node, world);
        if (entry) { entries.push(entry); return; }
        for (const name of ['entries', 'activatedEntries', 'activeEntries', 'worldInfo', 'activated']) {
            if (node[name] != null) visit(node[name], world, depth + 1);
        }
        // Host may provide {worldName: [entries]}.
        if (!('entries' in node) && !('activatedEntries' in node) && !('activeEntries' in node)) {
            for (const [name, value] of Object.entries(node)) {
                if (['worldInfo','activated','metadata','context'].includes(name)) continue;
                if (Array.isArray(value) || value instanceof Set || value instanceof Map) visit(value, name, depth + 1);
            }
        }
    };
    visit(payload);
    return [...new Map(entries.map(e => [e.id,e])).values()];
}

export function activeWorldInfoMatches(target, entries) {
    const desired = norm(target);
    if (!desired) return false;
    const active = normalizeWorldInfoEntries(entries);
    if (!active.length) return false;
    // Exactly match lorebook, qualified UID, or a globally unique legacy bare UID.
    if (active.some(e => desired === e.world || desired === e.id)) return true;
    const bare = active.filter(e => e.uid === desired);
    return bare.length === 1;
}

/** Last *known* scan only. Never claim it corresponds to a current-generation scan. */
export function createWorldInfoSnapshotStore() {
    const snapshots = new Map();
    return {
        capture(chatId, payload) {
            if (!chatId) return false;
            const entries = normalizeWorldInfoEntries(payload);
            // Empty events are permitted if the host explicitly supplies an empty list.
            if (!entries.length && !Array.isArray(payload)) return false;
            snapshots.set(String(chatId),{entries,source:'previous-observed-scan'});
            return true;
        },
        previous(chatId) {const s=snapshots.get(String(chatId));return s ? {entries:[...s.entries],source:s.source} : {entries:[],source:'unavailable'};},
        clear(chatId) {if(chatId == null) snapshots.clear();else snapshots.delete(String(chatId));},
    };
}
export const worldInfoSnapshots = createWorldInfoSnapshotStore();

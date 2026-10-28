/** C11: lossless, page-by-page NDJSON export. A terminal receipt, not file existence,
 * proves completeness. Callers MUST verify pagination, count and tenant contracts.
 * The writer is a backpressure-aware destination: write(Uint8Array), close(), abort().
 * Only record identities are retained in memory to detect duplicates.
 */
import {parseCollectionKey} from './collection-keys.js';
import {redactSecrets} from './security.js';

const encoder = new TextEncoder();
const validCount = n => Number.isSafeInteger(n) && n >= 0;
const identity = n => (typeof n === 'string' && n.length > 0) || (typeof n === 'number' && Number.isSafeInteger(n));
const line = value => encoder.encode(JSON.stringify(value) + '\n');

export async function exportVerifiedNDJSON({key, readPage, countRecords, writer,
    contractVerified = false, mode = 'offset', pageSize = 250, maxPages = 100000,
    signal, metadata = {}} = {}) {
    if (!parseCollectionKey(key)) throw Error('C11: qualified collection key required');
    if (!contractVerified || typeof readPage !== 'function' || typeof countRecords !== 'function')
        throw Error('C11: verified paginated inventory and independent scoped count required');
    if (!writer || typeof writer.write !== 'function' || typeof writer.close !== 'function' ||
        typeof writer.abort !== 'function') throw Error('C11: transactional destination required');
    if (!['offset','cursor'].includes(mode) || !Number.isSafeInteger(pageSize) || pageSize < 1 ||
        pageSize > 2000 || !Number.isSafeInteger(maxPages) || maxPages < 1)
        throw Error('C11: invalid pagination configuration');
    let started = true; // Destination was opened by caller; abort it on *any* failure.
    const seen = new Set(), cursors = new Set();
    let cursor = null, offset = 0, pages = 0, received = 0;
    try {
        const before = await countRecords({key, signal});
        if (!before || before.scope !== key || before.contractVerified !== true || !validCount(before.count))
            throw Error('C11: independent scoped count unverified');
        const expectedCount = before.count;
        if (signal?.aborted) throw Error('C11: export aborted');
        await writer.write(line({type:'vecthare-export-header', format:'vecthare-ndjson', version:1,
            collectionKey:key, expectedCount, metadata:redactSecrets(metadata)}));
        let ended = false;
        for (; pages < maxPages; pages++) {
            if (signal?.aborted) throw Error('C11: export aborted');
            if (mode === 'cursor') {
                const cursorKey = cursor === null ? 'initial' : `cursor:${String(cursor)}`;
                if (cursors.has(cursorKey)) throw Error('C11: cursor cycle');
                cursors.add(cursorKey);
            }
            const result = await readPage({key, cursor, offset, limit:pageSize, signal});
            if (!result || result.scope !== key || result.contractVerified !== true ||
                !Array.isArray(result.items) || result.items.length > pageSize)
                throw Error('C11: page shape or scope unverified');
            const pageIds = new Set();
            for (const item of result.items) {
                const id = item?.recordId;
                if (!identity(id) || item.collectionKey !== key)
                    throw Error('C11: record ownership or identity unverified');
                const marker = String(id);
                if (pageIds.has(marker) || seen.has(marker)) throw Error('C11: duplicate record identity');
                pageIds.add(marker);
            }
            for (const item of result.items) {
                if (signal?.aborted) throw Error('C11: export aborted');
                seen.add(String(item.recordId));
                // Copy data, including embedding vectors, without an all-records JSON buffer.
                await writer.write(line({type:'record', collectionKey:key, record:redactSecrets(item)}));
                received++;
            }
            if (received > expectedCount) throw Error('C11: received count exceeds independent count');
            if (result.endOfList === true) { ended = true; pages++; break; }
            if (result.endOfList !== false || pageIds.size === 0)
                throw Error('C11: end-of-list or progress unverified');
            if (mode === 'offset') {
                offset += result.items.length;
                if (!Number.isSafeInteger(offset)) throw Error('C11: offset overflow');
            } else {
                const next = result.nextCursor;
                if (!identity(next) || String(next) === String(cursor)) throw Error('C11: cursor did not advance');
                cursor = next;
            }
        }
        if (!ended) throw Error('C11: max pages exhausted before terminal proof');
        const after = await countRecords({key, signal});
        if (!after || after.scope !== key || after.contractVerified !== true || after.count !== expectedCount)
            throw Error('C11: collection count changed or final count unverified');
        if (received !== expectedCount) throw Error('C11: incomplete inventory/count mismatch');
        // Only the final, complete receipt makes the file a validated archive.
        const receipt = Object.freeze({expectedCount, receivedCount:received, complete:true,
            collectionKey:key, pages, format:'vecthare-ndjson', version:1});
        await writer.write(line({type:'vecthare-export-receipt', ...receipt}));
        await writer.close();
        return receipt;
    } catch (error) {
        if (started) { try { await writer.abort(error); } catch { /* retain original failure */ } }
        throw error;
    }
}

/** Browser destination: prefer true streaming disk writes, never hold an unbounded
 * Blob in RAM. Fallback is deliberately capped and is suitable only for modest data.
 */
export async function createBrowserExportWriter({filename='vecthare-export.vecthare.ndjson',
    maxFallbackBytes=32*1024*1024}={}) {
    if (typeof globalThis.showSaveFilePicker === 'function') {
        const handle = await globalThis.showSaveFilePicker({suggestedName:filename,
            types:[{description:'VectHare NDJSON',accept:{'application/x-ndjson':['.ndjson']}}]});
        const writable = await handle.createWritable();
        return {write:bytes=>writable.write(bytes), close:()=>writable.close(),
            abort:error=>writable.abort(error)};
    }
    // Blob fallback caps memory rather than claiming 120k-vector streaming support.
    let parts=[], byteCount=0;
    return {
        async write(bytes) {
            byteCount+=bytes.byteLength;
            if (byteCount>maxFallbackBytes) throw Error('C11: browser memory export limit reached; use a browser with streaming file support');
            parts.push(bytes);
        },
        async close() {
            const blob = new Blob(parts,{type:'application/x-ndjson'});parts=[];
            const url=URL.createObjectURL(blob);
            const a=document.createElement('a');a.href=url;a.download=filename;
            document.body.appendChild(a);a.click();a.remove();
            setTimeout(()=>URL.revokeObjectURL(url),1000);
        },
        async abort() {parts=[];byteCount=0;},
    };
}

/** C08: only a final, confirmed prompt-inclusion receipt can consume frequency.
 * This is a process-local history until the C10 inclusion receipt and persistent
 * generation ledger are established. Unknown and dry-run receipts never spend it.
 */
export function createFrequencyLedger() {
    const entries = new Map();
    const seen = new Set();
    const unverified = new Map();
    const valid = ({chatId,collectionKey,recordId,turnId,scope='conversation'}) =>
        chatId != null && String(chatId).length > 0 && collectionKey && recordId != null && turnId != null &&
        ['conversation','session'].includes(scope);
    const keyOf = args => JSON.stringify([String(args.chatId),String(args.collectionKey),args.scope ?? 'conversation',String(args.recordId)]);
    const turnKey = args => JSON.stringify([keyOf(args),String(args.turnId)]);
    return {
        recordActivation(args = {}) {
            if (!valid(args)) return {status:'invalid'};
            if (args.dryRun) return {status:'dry-run'};
            const turn = turnKey(args);
            if (seen.has(turn)) return {status:'duplicate'}; // Later uncertain receipts cannot downgrade a confirmed turn.
            const receipt = args.receipt;
            if (receipt?.status !== 'included' || receipt?.verified !== true || receipt?.recordIds?.includes(String(args.recordId)) !== true) {
                unverified.set(turnKey(args),{status:'unverified',receiptStatus:receipt?.status ?? 'unknown'});
                return {status:'unverified'};
            }
            seen.add(turn);
            unverified.delete(turn);
            const key = keyOf(args);
            const old = entries.get(key) || {count:0,lastActivation:null};
            const messageCount = Number(args.messageCount);
            entries.set(key, {count:old.count+1,lastActivation:Number.isSafeInteger(messageCount) ? messageCount : null});
            return {status:'recorded'};
        },
        snapshot({chatId,collectionKey,scope='conversation'}={}) {
            const result=Object.create(null);
            if (!chatId || !collectionKey) return result;
            for (const [key,value] of entries) {
                const [chat,collection,storedScope,record] = JSON.parse(key);
                if(chat===String(chatId) && collection===String(collectionKey) && storedScope===scope) result[record]={...value};
            }
            return result;
        },
        pendingCount() {return unverified.size;},
        clearSession() {
            for(const key of entries.keys()) if(JSON.parse(key)[2]==='session') entries.delete(key);
            for(const key of seen) if(JSON.parse(JSON.parse(key)[0])[2]==='session') seen.delete(key);
            for(const key of unverified.keys()) if(JSON.parse(JSON.parse(key)[0])[2]==='session') unverified.delete(key);
        },
        clearAll() {entries.clear();seen.clear();unverified.clear();},
    };
}
// Until C10 returns an authenticated-by-the-client final-selection receipt,
// a registered extension prompt is NOT proof that a frequency-constrained
// record reached the model. Fail closed on these conditions in live retrieval.
export const C08_FINAL_INCLUSION_RECEIPT_AVAILABLE = false;
export const activationFrequencyLedger=createFrequencyLedger();

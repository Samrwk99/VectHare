/** A vector ID denotes a source occurrence; contentHash denotes equal text.
 * All supported stores accept the numeric hashes returned by the supplied hashFn.
 * Deterministic across restarts for the same chat and chunking recipe.
 */
export const CHUNK_IDENTITY_VERSION = 2;
export function assignOccurrenceIds(items, hashFn) {
    const occurrences=new Map();
    const assigned=new Set();
    return items.map(item=>{
        const contentHash=hashFn(String(item.text??''));
        const base=String(item.hash??contentHash);
        const occurrence=occurrences.get(base)||0;
        occurrences.set(base,occurrence+1);
        let hash=item.hash??contentHash;
        if(occurrence || assigned.has(String(hash))){
            const refs=item.metadata?.messageIds || (item.metadata?.messageId!=null?[item.metadata.messageId]:[item.index??0]);
            let salt=0;
            do {hash=hashFn(JSON.stringify(['vecthare:occurrence:v2',base,refs,occurrence,salt++]));}
            while(assigned.has(String(hash)) || String(hash)===base);
        }
        assigned.add(String(hash));
        return {...item,hash,metadata:{...item.metadata,contentHash,occurrenceIndex:occurrence,identityVersion:CHUNK_IDENTITY_VERSION}};
    });
}

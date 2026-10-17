/**
 * P2 #57: enforce a single generation-wide count and token budget after
 * retrieval eligibility/ranking, before modifying any SillyTavern prompt.
 * All formatting is supplied by the caller so collection/chunk/global wrappers
 * and multiple position groups are counted exactly as actually injected.
 */
export async function chooseMemoryInjections(candidates, {maxMemories=0, maxTokens=0, renderGroups, countTokens}) {
    if (!Array.isArray(candidates) || typeof renderGroups !== 'function') throw new Error('Invalid injection budget inputs');
    const countCap = Number.isSafeInteger(Number(maxMemories)) && Number(maxMemories) > 0
        ? Math.min(candidates.length, Number(maxMemories)) : candidates.length;
    const tokenCap = Number.isSafeInteger(Number(maxTokens)) && Number(maxTokens) > 0 ? Number(maxTokens) : null;
    if (tokenCap && typeof countTokens !== 'function') throw new Error('Generation tokenizer unavailable; cannot enforce token budget');
    const selected=[];
    let usedTokens=0;
    const skipped=[];
    for (const chunk of candidates) {
        if(selected.length >= countCap) {skipped.push({hash:chunk.hash,reason:'memory_count_limit'});continue;}
        const proposal=[...selected, chunk];
        if(tokenCap !== null) {
            const groups=renderGroups(proposal);
            let total=0;
            for (const groupText of groups) {
                const count=await countTokens(groupText);
                if(!Number.isSafeInteger(count) || count<0)throw new Error('Generation tokenizer returned invalid token count');
                total+=count;
            }
            if(total>tokenCap) {skipped.push({hash:chunk.hash,reason:'memory_token_budget'});continue;}
            usedTokens=total;
        }
        selected.push(chunk);
    }
    return {selected,usedTokens,tokenCap,estimated:false,skipped};
}

/**
 * Conservative generation-token safeguard for tokenizer implementations which
 * can report an estimate. The host counter is still used, but the larger of
 * it and UTF-8 byte count (+ wrapper overhead) is enforced. The byte count is
 * NOT an exact model-token count, and cannot certify arbitrary exotic models.
 * This deliberately trades injection capacity for protection against
 * under-counting on mainstream byte-based tokenizers.
 */
export async function countConservativeGenerationTokens(text, modelCounter){
    if(typeof text!=='string'||typeof modelCounter!=='function')
        throw new Error('Generation token budget requires prompt text and a tokenizer');
    const reported=await modelCounter(text);
    if(!Number.isSafeInteger(reported)||reported<0)
        throw new Error('Generation tokenizer returned invalid token count');
    const byteBound=new TextEncoder().encode(text).length+8;
    return Math.max(reported,byteBound);
}

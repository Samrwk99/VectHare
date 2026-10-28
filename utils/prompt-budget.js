/** C10 #115 — bounded, wrapper-aware token selection for extension prompts.
 * Host tokenizer is preferred; a conservative UTF-16 length bound is used when
 * unavailable. An unverified context size fails closed, never injects blind.
 */
const positiveInteger = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const bounded = (value, fallback, maximum) => Math.min(positiveInteger(value) ?? fallback, maximum);

export function resolveInjectionBudget({maxContext, cap = 1024, margin = 128, reservedContext} = {}) {
    const context = positiveInteger(maxContext);
    if (!context) return {availableTokens: 0, reason:'unknown-context-size', tokenizer:'unknown'};
    // A prompt extension cannot know how many tokens the final host prompt uses.
    // Reserve at least half the context for host/system/history/output material.
    const reserve = Math.max(Math.ceil(context / 2), bounded(reservedContext, 512, context));
    const safety = bounded(margin, 128, context);
    const availableTokens = Math.max(0, Math.min(bounded(cap, 1024, context), context-reserve-safety));
    return {availableTokens, contextTokens:context, reservedTokens:reserve, safetyTokens:safety, capTokens:bounded(cap,1024,context),
        reason:availableTokens?'bounded':'insufficient-context-headroom'};
}

export async function countPromptTokens(text, tokenizer) {
    if (typeof text !== 'string') throw new TypeError('Prompt text must be a string');
    if (typeof tokenizer === 'function') {
        try {
            const result = await tokenizer(text);
            if (Number.isSafeInteger(result) && result >= 0) return {tokens:result, method:'host'};
        } catch { /* conservative fallback below */ }
    }
    // One UTF-16 code unit per token intentionally over-reserves for ordinary
    // tokenizers; this is a protective estimate, not a claim of exact token count.
    return {tokens:text.length, method:'conservative-code-unit-estimate'};
}

/**
 * @param {object} options
 * @param {Array<object>} options.candidates - ranked candidates
 * @param {Function} options.render - exact formatter used by registration;
 *   accepts chosen candidates and returns an ARRAY of complete prompt blocks.
 * @param {Function} options.tokenizer - host tokenizer, if available
 */
export async function planInjection({candidates=[],render,tokenizer,availableTokens=0,minTrimCharacters=24}={}) {
    if (typeof render !== 'function') throw new TypeError('A prompt renderer is required');
    const limit = Number.isSafeInteger(availableTokens) && availableTokens>0 ? availableTokens : 0;
    const chosen=[], trimmed=[], dropped=[];
    let method='host';
    async function measure(items) {
        const blocks=render(items);
        if (!Array.isArray(blocks) || blocks.some(s => typeof s!=='string')) throw new TypeError('Prompt renderer must return strings');
        let total=0;
        for (const block of blocks) {
            const result=await countPromptTokens(block,tokenizer);
            total+=result.tokens;
            if(result.method!=='host')method=result.method;
        }
        return total;
    }
    if (!limit) return {chosen,trimmed,dropped:candidates.map(c=>({chunk:c,reason:'no-token-budget'})),tokens:0,availableTokens:0,method:'unavailable'};
    for (const item of candidates) {
        if (typeof item?.text!=='string' || !item.text.trim()) {dropped.push({chunk:item,reason:'no-text'});continue;}
        const full=[...chosen,item];
        if (await measure(full)<=limit) {chosen.push(item);continue;}
        const chars=Array.from(item.text);
        const minimum=Math.min(minTrimCharacters,chars.length);
        let lo=minimum,hi=chars.length-1,best=null;
        // Binary search is safe for monotonically non-decreasing token counts;
        // recheck the measured final result below before returning.
        while(lo<=hi) {
            const mid=Math.floor((lo+hi)/2);
            const shortened={...item,text:chars.slice(0,mid).join('').trimEnd()};
            if(mid>=minimum && shortened.text && await measure([...chosen,shortened])<=limit) {best=shortened;lo=mid+1;}
            else hi=mid-1;
        }
        if(best && await measure([...chosen,best])<=limit) {
            chosen.push(best);
            trimmed.push({chunk:item,chosen:best,reason:'token-budget'});
        } else dropped.push({chunk:item,reason:'token-budget'});
    }
    let tokens=await measure(chosen);
    // Tokenizers can vary by surrounding text; never claim a compliant final
    // plan if the exact rendered blocks exceed the budget.
    while(tokens>limit && chosen.length) {
        const removed=chosen.pop();dropped.push({chunk:removed,reason:'final-budget-recheck'});
        tokens=await measure(chosen);
    }
    return {chosen,trimmed,dropped,tokens,availableTokens:limit,method,renderedBlocks:render(chosen)};
}

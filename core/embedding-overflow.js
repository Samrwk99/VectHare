/** Token-accurate overflow guard, preserving parent chunk identity. */
import {getProviderSpecificParams} from '../backends/provider-params.js';
import {getRequestHeaders} from '../../../../../script.js';
const headers = () => getRequestHeaders();
// The same full chat is checked repeatedly by incremental sync. Avoid
// re-tokenizing all its unchanged chunks on every iteration.
const tokenCache=new Map();
const endpointModels=new Map();
const CACHE_TTL_MS=20000;
const MAX_TOKEN_CACHE=5000;
async function proxy(route, settings, text) {
    const {apiUrl} = getProviderSpecificParams(settings);
    const response = await fetch(`/api/plugins/similharity/embedding/${route}`, {method:'POST',headers:headers(),body:JSON.stringify({source:settings.source,apiUrl,...(text == null ? {} : {text})})});
    if (!response.ok) throw new Error(`${route} failed (${response.status}): ${await response.text()}`);
    return response.json();
}
export async function getEmbeddingBudget(settings) {
    if (settings.source === 'llamacpp') {
        const capabilities = await proxy('capabilities',settings);
        const endpoint=getProviderSpecificParams(settings).apiUrl;
        const fingerprint=`${capabilities.modelId || ''}:${capabilities.modelPath || ''}`;
        if(endpointModels.has(endpoint) && endpointModels.get(endpoint)!==fingerprint)tokenCache.clear();
        endpointModels.set(endpoint,fingerprint);
        const value = capabilities?.limits?.maxTokens;
        // llama.cpp may not reveal its physical batch size; require an explicit cap
        // rather than mistakenly assuming its context length is the batch budget.
        const configured=Number(settings.embedding_max_tokens) || null;
        return Number.isFinite(value) && value > 0 ? Math.floor(Math.min(value,configured || value) * .94) : configured ? Math.floor(configured*.94) : null;
    }
    return Number(settings.embedding_max_tokens) || null;
}
export async function countEmbeddingTokens(text, settings) {
    if (settings.source === 'llamacpp') {
        const endpoint=getProviderSpecificParams(settings).apiUrl;
        const key=`${endpoint}\n${text}`;
        const cached=tokenCache.get(key);
        if(cached && Date.now()-cached.time<CACHE_TTL_MS)return cached.count;
        const result=await proxy('tokenize',settings,text);
        if(!Number.isInteger(result.count) || result.count<0)throw new Error('Embedding tokenizer returned no valid token count');
        if(tokenCache.size>=MAX_TOKEN_CACHE)tokenCache.clear();
        tokenCache.set(key,{time:Date.now(),count:result.count});
        return result.count;
    }
    // Other providers: only allow splitting when an exact supported tokenizer
    // exists; character heuristics cannot guarantee an input fits.
    return null;
}
function units(text) {
    return text.match(/[^.!?\n]+[.!?]*(?:\n+|\s+|$)|\S+/g)?.filter(Boolean) || [text];
}
async function splitText(text, maxTokens, count) {
    if (await count(text) <= maxTokens) return [text];
    const parts = units(text);
    const output=[];
    let current='';
    for (let part of parts) {
        if (await count(current+part) <= maxTokens) {current+=part;continue;}
        if (current) {output.push(current);current='';}
        if (await count(part) <= maxTokens) {current=part;continue;}
        // No punctuation/sentence boundary small enough: split at Unicode codepoint
        // boundaries by binary search; no text is discarded or summarised.
        while (part) {
            const chars=Array.from(part);let lo=1,hi=chars.length,best=0;
            while(lo<=hi){const mid=(lo+hi)>>1;if(await count(chars.slice(0,mid).join(''))<=maxTokens){best=mid;lo=mid+1;}else hi=mid-1;}
            if (!best) throw new Error('Embedding token limit is too small to represent one character');
            output.push(chars.slice(0,best).join(''));part=chars.slice(best).join('');
        }
    }
    if(current)output.push(current);
    if(output.join('')!==text)throw new Error('Overflow splitter lost source text');
    return output;
}
/** Splits only when the final text (including keywords) would exceed limit.
 * For paired dialog, repeat a shorter partner when doing so is safe.
 * The returned items are linked to their original hash & source references.
 */
export async function prepareEmbeddingItems(items, settings, hashFn) {
    const budget = await getEmbeddingBudget(settings);
    if (!budget) return items; // Provider has no reliable limit: no speculative split.
    const count = text => countEmbeddingTokens(text,settings);
    if (settings.source !== 'llamacpp') return items;
    const result=[];
    for(const item of items){
        const keywordText = (item.keywords||[]).map(k=>k.text||k).join(' ');
        const suffix = keywordText ? ` [KEYWORDS: ${keywordText}]` : '';
        const finalText = String(item.text||'')+suffix;
        if((await count(finalText))<=budget){result.push(item);continue;}
        // Re-append keywords only when they can fit; if they do not fit alone,
        // this needs an explicit settings change, never silently discard keywords.
        if(await count(suffix)>budget/2) throw new Error(`Keywords alone consume too much of the ${budget}-token embedding budget`);
        const textBudget=budget-(await count(suffix))-8;
        if(textBudget<=0)throw new Error('Insufficient input budget after keywords');
        const text=String(item.text||'');
        let pieces;
        const pair = item.metadata?.strategy==='conversation_turns' ? text.match(/^(\[User\]:[\s\S]*?)\n\n(\[Character\]:[\s\S]*)$/) : null;
        if (pair) {
            const a=pair[1],b=pair[2];
            const short=(await count(a))<=(await count(b))?a:b;
            const long=short===a?b:a;
            const shortCount=await count(short);
            if(shortCount < textBudget*.35){
                const partials=await splitText(long,textBudget-shortCount-4,count);
                pieces=partials.map(p=>short===a?`${short}\n\n${p}`:`${p}\n\n${short}`);
            }
        }
        pieces ||= await splitText(text,textBudget,count);
        for(let i=0;i<pieces.length;i++){
            const part=pieces[i];
            if(await count(part+suffix)>budget)throw new Error('A split segment still exceeds the embedding limit');
            result.push({...item,text:part,hash:hashFn(`${item.hash}:${i}:${part}`),metadata:{...item.metadata,parentHash:item.hash,splitIndex:i,splitTotal:pieces.length,overflow:true}});
        }
    }
    return result;
}

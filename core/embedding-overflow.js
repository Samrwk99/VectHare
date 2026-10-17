/** Token-accurate overflow guard, preserving parent chunk identity. */
import {getProviderSpecificParams} from '../backends/provider-params.js';
import {getRequestHeaders} from '../../../../../script.js';
const headers = () => getRequestHeaders();
// The same full chat is checked repeatedly by incremental sync. Avoid
// re-tokenizing all its unchanged chunks on every iteration.
const tokenCache=new Map();
const endpointModels=new Map();
const tokenizersUnavailable=new Set();
const capabilityCache=new Map();
const CACHE_TTL_MS=120000;
const MAX_TOKEN_CACHE=5000;
const NETWORK_PROVIDERS=new Set(['llamacpp','ollama','vllm','koboldcpp','bananabread','openrouter','electronhub','nanogpt','custom']);
const MODEL_FIELDS={ollama:'ollama_model',vllm:'vllm_model',openrouter:'openrouter_model',electronhub:'electronhub_model',nanogpt:'nanogpt_model',custom:'custom_model'};
function getModel(settings){return settings[MODEL_FIELDS[settings.source]]||settings.model||'';}
function endpointKey(settings){const params=getProviderSpecificParams(settings);return `${settings.source}|${params.apiUrl||''}|${params.customEndpointMode||'base'}|${getModel(settings)}`;}
async function proxy(route, settings, text) {
    const {apiUrl, apiKey, customEndpointMode}=getProviderSpecificParams(settings);
    const model=getModel(settings);
    const response = await fetch(`/api/plugins/similharity/embedding/${route}`, {method:'POST',headers:headers(),body:JSON.stringify({source:settings.source,apiUrl,apiKey,model,customEndpointMode,...(text==null?{}:{text})})});
    if (!response.ok) throw new Error(`${route} failed (${response.status}): ${(await response.text()).slice(0,250)}`);
    return response.json();
}
function conservativeBytes(text) {
    // Deliberately an upper-bound heuristic, NOT an exact model token count.
    // Most text tokenizers produce no more tokens than UTF-8 bytes, but models
    // with unusual special-token expansion still require server enforcement.
    let bytes=0;
    for(const char of text){
        const cp=char.codePointAt(0);
        bytes+=cp<128?1:cp<2048?2:cp<65536?3:4;
    }
    return bytes+8;
}
export async function getEmbeddingBudget(settings) {
    const configured=Number(settings.embedding_max_tokens);
    const manual=Number.isSafeInteger(configured)&&configured>0?configured:null;
    if (!NETWORK_PROVIDERS.has(settings.source)) return manual ? Math.max(1,Math.floor(manual*.85)) : null;
    const key=endpointKey(settings);
    let capabilities=null;
    {
        try {capabilities={data:await proxy('capabilities',settings),time:Date.now()};capabilityCache.set(key,capabilities);}
        catch(error){if(!manual || (settings.source==='custom' && settings.custom_endpoint_mode==='exact'))throw new Error(`${settings.source}: embedding input limit or exact-endpoint support could not be verified. Configure "Embedding input token limit override" explicitly, check endpoint connectivity, and install the matching Similharity plugin. ${error.message}`);}
    }
    const data=capabilities?.data;
    // Older plugins ignore customEndpointMode and silently rewrite the URL.
    // Never send an exact-endpoint request until support is confirmed.
    if(settings.source==='custom' && settings.custom_endpoint_mode==='exact' && (data?.endpointModeSupported!==true || data?.endpointMode!=='exact')) {
        throw new Error('Custom API Exact Endpoint requires the matching Similharity plugin with exact-endpoint support. Refusing to send to a rewritten URL.');
    }
    if(data){
        const fingerprint=`${data.modelId||''}:${data.modelPath||''}`;
        if(endpointModels.has(key)&&endpointModels.get(key)!==fingerprint)tokenCache.clear();
        endpointModels.set(key,fingerprint);
    }
    const serverMax=Number(data?.limits?.maxTokens);
    const contextMax=Number(data?.limits?.reportedContextTokens);
    const published=Number.isSafeInteger(serverMax)&&serverMax>0?serverMax:Number.isSafeInteger(contextMax)&&contextMax>0?contextMax:null;
    const raw=manual&&published?Math.min(manual,published):manual||published;
    if(!raw){
        // Do not submit chunks to a server which might silently truncate them.
        throw new Error(`${settings.source}: no verifiable embedding input limit is exposed. Set an explicit Embedding input token limit override for this model (and ensure it is supported by the endpoint).`);
    }
    return Math.max(1,Math.floor(raw*(settings.source==='llamacpp'?.94:.85)));
}
export async function countEmbeddingTokens(text,settings) {
    if (!NETWORK_PROVIDERS.has(settings.source)) return null;
    const key=`${endpointKey(settings)}\n${text}`;
    const cached=tokenCache.get(key);
    if(cached && Date.now()-cached.time<CACHE_TTL_MS)return cached.count;
    const unavailable=tokenizersUnavailable.has(endpointKey(settings));
    let count;
    if(!unavailable){
        try {
            const result=await proxy('tokenize',settings,text);
            if(!Number.isSafeInteger(result.count)||result.count<0)throw new Error('Invalid tokenizer response');
            count=result.count;
        }catch(error){
            // llama.cpp has an exact tokenizer API. Failure here must be visible,
            // rather than silently falling back and pretending to be exact.
            if(settings.source==='llamacpp')throw error;
            tokenizersUnavailable.add(endpointKey(settings));
        }
    }
    if(count==null)count=conservativeBytes(text);
    if(tokenCache.size>=MAX_TOKEN_CACHE)tokenCache.clear();
    tokenCache.set(key,{time:Date.now(),count});
    return count;
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
    if (!NETWORK_PROVIDERS.has(settings.source)) return items;
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
        // Either speaker can lead. Only treat exactly two labelled messages
        // as a repeatable pair; larger runs use linked, lossless overflow parts.
        const labelledBoundaries = text.match(/\n\n\[(?:User|Character)\]:/g) || [];
        const pair = item.metadata?.strategy === 'conversation_turns' && labelledBoundaries.length === 1
            ? text.match(/^(\[(User|Character)\]:[\s\S]*?)\n\n(\[(User|Character)\]:[\s\S]*)$/)
            : null;
        if (pair && pair[2] !== pair[4]) {
            const a=pair[1],b=pair[3];
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

/** Retrieval queries must not be silently truncated either. Query splitting
 * changes retrieval semantics, so reject oversize queries explicitly instead. */
export async function assertEmbeddingQueryFits(text, settings) {
    if (!NETWORK_PROVIDERS.has(settings?.source) || typeof text !== 'string') return;
    const budget=await getEmbeddingBudget(settings);
    if(!budget)return;
    const tokens=await countEmbeddingTokens(text,settings);
    if(tokens>budget)throw new Error(`Embedding search query exceeds ${settings.source} safe limit (${tokens} measured/conservatively estimated > ${budget} allowed). Shorten the query or increase the server's verified input limit; no text was silently truncated.`);
}

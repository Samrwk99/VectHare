/** C09 independent lexical retrieval: no BM25 over vector top-K.
 * Accept only independently proven native results or fully verified scoped
 * document snapshots; never promote partial/old tenant inventories to search.
 */
import {createBM25Scorer,tokenize} from './bm25-scorer.js';
const MAX_CLIENT_INDEX_DOCS=5000;
const indexCache=new Map();
export function clearLexicalCache(){indexCache.clear();}
export function createClientLexicalIndex({collectionKey,version,items,complete,verified,expectedCount,bm25Options={}}={}){
    if(typeof collectionKey!=='string'||!collectionKey||typeof version!=='string'||!version||
        verified!==true||complete!==true||!Array.isArray(items)||items.length>MAX_CLIENT_INDEX_DOCS||
        !Number.isSafeInteger(expectedCount)||expectedCount!==items.length) return null;
    if(items.some(x=>x?.collectionKey!==collectionKey || (x.hash===undefined && x.recordId===undefined) || typeof x.text!=='string'))return null;
    const keys=items.map(x=>String(x.recordId??x.hash));
    if(new Set(keys).size!==keys.length)return null;
    const cacheKey=JSON.stringify([collectionKey,version,bm25Options]);
    const prior=indexCache.get(cacheKey);
    if(prior && prior.expectedCount===expectedCount)return prior;
    const scored=items.map(i=>({hash:i.recordId??i.hash,text:i.text,title:i.title||'',tags:i.tags||[],metadata:{...i.metadata,collectionKey}}));
    const scorer=createBM25Scorer(scored,{fieldBoosting:true,...bm25Options});
    const index={collectionKey,version,expectedCount,search(query,limit){
        const terms=tokenize(query);
        return scored.map((item,i)=>({...item,bm25Score:scorer.scoreDocument(terms,i)}))
            .filter(i=>Number.isFinite(i.bm25Score)&&i.bm25Score>0)
            .sort((a,b)=>b.bm25Score-a.bm25Score||String(a.hash).localeCompare(String(b.hash))).slice(0,limit);
    }};
    // Per-version cached indexes have finite limits; explicitly invalidate on changes.
    for(const key of indexCache.keys()) if(key.startsWith(JSON.stringify(collectionKey).slice(0,-1)+','))indexCache.delete(key);
    indexCache.set(cacheKey,index);
    while(indexCache.size>8)indexCache.delete(indexCache.keys().next().value);
    return index;
}
export async function lexicalCandidates({collectionKey,query,limit,provider='none',nativeSearch,clientSnapshot,bm25Options={}}={}){
    if(provider==='native' && typeof nativeSearch==='function') {
        try{
            const result=await nativeSearch({collectionKey,query,limit});
            const items=result?.items;
            if(result?.verified===true && result?.scope===collectionKey && Array.isArray(items) &&
                items.every(x=>x?.collectionKey===collectionKey && (x.recordId!==undefined||x.hash!==undefined)&& Number.isFinite(x.bm25Score)))
                return {mode:'native',items};
        }catch{}
        return {mode:'none',items:[],reason:'native-lexical-unverified'};
    }
    if(provider==='clientScan'){
        const index=createClientLexicalIndex({...clientSnapshot,bm25Options});
        if(index?.collectionKey===collectionKey)return {mode:'clientScan',items:index.search(query,limit)};
        return {mode:'none',items:[],reason:'client-index-incomplete'};
    }
    return {mode:'none',items:[],reason:'no-independent-lexical-provider'};
}

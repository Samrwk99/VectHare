/**
 * Query-scoped BM25+ corpus accumulator for bounded large hybrid collections.
 * Holds only documents containing a query term, rather than storing every
 * chunk, all vocabulary and all term-frequency maps in browser memory.
 * Every backend page must still be visited to establish global N, avg length
 * and exact query-term document frequencies. It is NOT a native text index.
 */
import { tokenize } from './bm25-scorer.js';

export function createStreamingLexicalAccumulator(query, {k1=1.5,b=0.75,delta=0.5}={}) {
    const queryTerms=tokenize(query);
    const termSet=new Set(queryTerms);
    const df=new Map(queryTerms.map(term=>[term,0]));
    const matches=[];
    let totalDocs=0,totalLength=0;
    function add(doc) {
        const content=tokenize(doc.text);
        const tf=new Map();
        const include=(tokens,multiplier)=>{
            for (const term of tokens) if(termSet.has(term)) tf.set(term,(tf.get(term)||0)+multiplier);
        };
        include(content,1);
        if(doc.title)include(tokenize(doc.title),4);
        if(Array.isArray(doc.tags)) for(const tag of doc.tags)include(tokenize(tag),4);
        totalDocs++;
        totalLength+=content.length;
        for(const term of tf.keys())df.set(term,df.get(term)+1);
        if(tf.size)matches.push({doc,tf,docLength:content.length});
    }
    function results(limit=100) {
        if(!Number.isSafeInteger(limit)||limit<1)throw new Error('Invalid lexical shortlist size');
        const avg=totalDocs?totalLength/totalDocs:0;
        if(!avg||!queryTerms.length)return [];
        const rows=matches.map(({doc,tf,docLength})=>{
            let score=0,matched=0;
            for(const term of queryTerms){
                const raw=tf.get(term)||0;
                if(!raw)continue;
                matched++;
                const idf=Math.max(0,Math.log((totalDocs-df.get(term)+0.5)/(df.get(term)+0.5)))+delta;
                const adjusted=Math.log(1+raw);
                const normalization=1-b+b*(docLength/avg);
                score+=idf*(adjusted*(k1+1))/(adjusted+k1*normalization);
            }
            if(matched)score*=1+(matched/queryTerms.length)*0.1;
            return {...doc,bm25Score:score};
        });
        rows.sort((a,b)=>b.bm25Score-a.bm25Score);
        return rows.slice(0,limit);
    }
    return {add,results,get totalDocs(){return totalDocs;},get retainedDocs(){return matches.length;}};
}

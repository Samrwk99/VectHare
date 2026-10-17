/** #17: no old 4096 candidate ceiling, eligible refill after exclusions. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {getCandidateBudget,loadCachedCandidatePage,nextCandidateLimit,rankEligibleChunks} from '../core/retrieval-policy.js';
let queries=0;
const ids=Array.from({length:6000},(_,i)=>i);
const pageCache=new Map();
const query=async(id,limit)=>{
    queries++;
    const rows=ids.slice(0,limit);
    return {hashes:rows,metadata:rows.map(n=>({score:1-n/6000,disabled:n<5300}))};
};
const k=20;
const budget=getCandidateBudget(k);
assert.ok(budget>4096);
let limit=32,eligible=[];
for(let step=0;step<24;step++){
    const {result,full}=await loadCachedCandidatePage(pageCache,'A',limit,query);
    eligible=rankEligibleChunks(result.hashes.map((hash,i)=>({hash,score:result.metadata[i].score,
        disabled:result.metadata[i].disabled})).filter(r=>!r.disabled),{},k);
    const next=nextCandidateLimit({eligible:eligible.length,target:k,requested:limit,mayHaveMore:full,maxLimit:budget});
    if(next===null)break;
    limit=next;
}
assert.equal(eligible.length,k);
assert.equal(eligible[0].hash,5300);
assert.ok(limit>4096,'needs to refill beyond old 4096 candidates');
const before=queries;
const exhausted=await loadCachedCandidatePage(pageCache,'A',limit*2,query);
assert.equal(exhausted.full,false);
await loadCachedCandidatePage(pageCache,'A',limit*4,query);
assert.equal(queries,before,'exhausted collection should not be requested again');
console.log('PASS: Top-K=20 recovers candidates ranked after 5,300 excluded results');
console.log('PASS: per-collection exhausted prefixes are cached');
const source=readFileSync(new URL('../core/chat-vectorization.js',import.meta.url),'utf8');
assert.match(source,/rankEligibleChunks\(eligibleChunks/);
assert.match(source,/nextCandidateLimit\(\{eligible:chunksToInject.length/);
assert.match(source,/candidateRefill\.incomplete/);
assert.match(source,/loadCachedCandidatePage\(/);
assert.match(source,/getCandidateBudget\(finalTopK\)/);
assert.match(readFileSync(new URL('../core/keyword-boost.js',import.meta.url),'utf8'),/Math\.min\(65536, Math\.max\(10, topK \* 2\)\)/);
assert.match(readFileSync(new URL('../core/hybrid-search.js',import.meta.url),'utf8'),/const expandedTopK = Math\.min\(65536/);
console.log('PASS: retrieval pipeline final-ranking, budget and incomplete-warning hooks wired');
console.log('3 Top-K completion tests passed');

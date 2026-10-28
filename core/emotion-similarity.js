/** C14 #236 — Deterministic prototype-based emotion similarity.
 * Pure scoring layer; the caller supplies a verified, same-model embedding operation.
 * Never guess scores or silently invoke a different classifier on embedding failure.
 */
export const EMOTION_PROTOTYPES_VERSION = 'ct-basic-en-v1';
export const EMOTION_PROTOTYPES = Object.freeze({
    joy: ['I feel happy and delighted.', 'This is wonderful news!', 'I am cheerful and thrilled.'],
    sadness: ['I feel deeply sad.', 'I am grieving a terrible loss.', 'I feel miserable and heartbroken.'],
    anger: ['I am furious about this.', 'I feel angry and outraged.', 'This makes me irritated and mad.'],
    fear: ['I am afraid something bad will happen.', 'I feel frightened and anxious.', 'I am scared and worried.'],
    disgust: ['This is revolting and disgusting.', 'I feel sickened by it.', 'This makes me feel repulsed.'],
    surprise: ['I cannot believe that happened!', 'What a surprising revelation!', 'I am astonished and shocked.'],
    love: ['I love you so much.', 'I feel deep affection and tenderness.', 'I care for you with all my heart.'],
});

export const EMOTION_TEST_FIXTURES = Object.freeze([
    {text:'I am joyful and full of happiness today.',expected:'joy'},
    {text:'This delightful surprise makes me smile.',expected:'joy'},
    {text:'I miss her so much and feel heartbroken.',expected:'sadness'},
    {text:'I feel devastated and miserable.',expected:'sadness'},
    {text:'I am absolutely furious with this decision.',expected:'anger'},
    {text:'That makes me so mad I could scream.',expected:'anger'},
    {text:'I am terrified of what comes next.',expected:'fear'},
    {text:'I am scared and trembling.',expected:'fear'},
    {text:'That smell is completely revolting.',expected:'disgust'},
    {text:'I feel disgusted and repulsed by it.',expected:'disgust'},
    {text:'I am stunned. I did not expect that.',expected:'surprise'},
    {text:'What an astonishing turn of events!',expected:'surprise'},
    {text:'I adore you with all my heart.',expected:'love'},
    {text:'I feel so much affection for you.',expected:'love'},
]);

function vector(v, dim = null) {
    if (!Array.isArray(v) || !v.length || v.length > 16384 || (dim !== null && v.length !== dim)) {
        throw new Error('C14 embedding response has an invalid vector dimension');
    }
    let sum = 0;
    for (const n of v) {
        if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error('C14 embedding contains a non-finite value');
        sum += n*n;
    }
    if (!Number.isFinite(sum) || sum <= 0) throw new Error('C14 embedding contains a zero or invalid norm');
    const norm = Math.sqrt(sum);
    return v.map(n=>n/norm);
}
function dot(a,b) {let s=0;for(let i=0;i<a.length;i++)s+=a[i]*b[i];return s;}
function labelsFor(customLabels, prototypeSet) {
    if (customLabels === undefined || customLabels === null || customLabels.length === 0) return Object.keys(prototypeSet);
    if (!Array.isArray(customLabels) || customLabels.length > 30) throw new Error('C14 invalid emotion labels');
    const labels=customLabels.map(x => typeof x === 'string' ? x.trim().toLowerCase() : '');
    if (!labels.length || labels.some(x=>!x || !Object.hasOwn(prototypeSet,x)) || new Set(labels).size !== labels.length) {
        throw new Error('C14 custom emotion labels need supported, unique prototypes');
    }
    return labels;
}
function embeddingBatch(raw, n) {
    if (!Array.isArray(raw) || raw.length !== n) throw new Error('C14 embedding response count does not match request');
    if (!n) throw new Error('C14 empty embedding batch');
    const first=vector(raw[0]);
    const result=[first];
    for(let i=1;i<raw.length;i++) result.push(vector(raw[i],first.length));
    return result;
}

/** Embeddings are opaque: profileKey MUST identify provider + effective model + endpoint + relevant settings.
 * Fails closed if profileKey is unavailable. Embeddings are cached in memory only.
 */
export function createEmotionSimilarityClassifier({embed, profileKey, prototypeSet=EMOTION_PROTOTYPES, version=EMOTION_PROTOTYPES_VERSION, threshold=0.38, margin=0.025}={}) {
    if (typeof embed!=='function' || typeof profileKey!=='string' || !profileKey.trim()) throw new Error('C14 requires an explicit embedding provider and model profile');
    if (!(threshold >= -1 && threshold <= 1 && Number.isFinite(threshold)) || !(margin>=0 && margin<=2 && Number.isFinite(margin))) throw new Error('C14 invalid confidence thresholds');
    let cached=null;
    let pending=null;
    let generation=0;
    async function getPrototypes(labels) {
        const signature=JSON.stringify([profileKey,version,labels,labels.map(k=>prototypeSet[k])]);
        if(cached?.signature===signature) return cached;
        if(pending?.signature===signature) return pending.promise;
        const phrases=labels.flatMap(k=>prototypeSet[k]);
        if(!phrases.length || phrases.length>120 || phrases.some(t=>typeof t!=='string'||!t.trim()))throw new Error('C14 invalid prototype set');
        const requestGeneration=generation;
        const promise=(async()=>{
            const vectors=embeddingBatch(await embed(phrases),phrases.length);
            const groups=[];let offset=0;
            for(const label of labels){groups.push({label,vectors:vectors.slice(offset,offset+prototypeSet[label].length)});offset+=prototypeSet[label].length;}
            const prepared={signature,groups,dim:vectors[0].length};
            if (requestGeneration===generation) cached=prepared;
            return prepared;
        })();
        pending={signature,promise};
        try {return await promise;} finally {if(pending?.promise===promise)pending=null;}
    }
    async function classify(text,{customLabels=[]}={}) {
        if(typeof text!=='string' || !text.trim())return null;
        const labels=labelsFor(customLabels,prototypeSet);
        // Embedding the input is performed AFTER prototype availability has been checked.
        const prototypes=await getPrototypes(labels);
        const input=embeddingBatch(await embed([text]),1)[0];
        if(input.length!==prototypes.dim)throw new Error('C14 query and prototype model dimensions differ');
        const ranked=prototypes.groups.map(({label,vectors})=>({label,score:Math.max(...vectors.map(v=>dot(input,v)))}))
            .sort((a,b)=>b.score-a.score || a.label.localeCompare(b.label));
        const best=ranked[0];const second=ranked[1];
        const accepted=best.score>=threshold && (!second || best.score-second.score>=margin);
        return {label:accepted?best.label:'neutral',score:accepted?best.score:0,allLabels:ranked,
            mode:'similarity',modelHonored:false,model:'server-controlled',profileKey,prototypeVersion:version,uncertain:!accepted};
    }
    async function evaluate(fixtures=EMOTION_TEST_FIXTURES, options={}) {
        let correct=0,unknown=0;
        const predictions=[];
        for(const row of fixtures){const result=await classify(row.text,options); if(result?.label===row.expected) correct++;
            if(result?.uncertain)unknown++; predictions.push({expected:row.expected,predicted:result?.label||null});}
        return {evaluated:fixtures.length,correct,unknown,accuracy:fixtures.length?correct/fixtures.length:null,predictions,profileKey,prototypeVersion:version};
    }
    return {classify,evaluate,clear:()=>{generation++;cached=null;pending=null;}};
}

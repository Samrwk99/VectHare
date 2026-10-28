import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createEmotionSimilarityClassifier,EMOTION_PROTOTYPES,EMOTION_PROTOTYPES_VERSION,EMOTION_TEST_FIXTURES} from '../core/emotion-similarity.js';
import {createPluginEmotionEmbedder,emotionEmbeddingCapabilities} from '../core/emotion-embedding-provider.js';
import {classifierCapabilities,requireSupportedClassifierMode} from '../utils/feature-support.js';
const labels=Object.keys(EMOTION_PROTOTYPES);
function basis(label){return labels.map(l=>l===label?1:0);}
function exampleEmbed(text){
    const phraseLabel=labels.find(l=>EMOTION_PROTOTYPES[l].includes(text));
    const fixtureLabel=EMOTION_TEST_FIXTURES.find(x=>x.text===text)?.expected;
    if(phraseLabel||fixtureLabel)return basis(phraseLabel||fixtureLabel);
    if(text==='uncertain')return labels.map(()=>1);
    if(text==='wrong-dimensional')return [1,0];
    if(text==='bad-norm')return labels.map(()=>0);
    if(text==='bad-numeric')return labels.map((_,i)=>i===0?Number.NaN:0);
    if(text==='bad-type')return 'bad';
    return basis('joy');
}
function harness(opts={}){
    const batches=[];
    const embed=async texts=>{batches.push([...texts]);if(opts.fault)return opts.fault(texts,batches.length);
        return texts.map(exampleEmbed);};
    const classifier=createEmotionSimilarityClassifier({embed,profileKey:opts.profileKey||'source:transformers:model:server1',...opts});
    return {classifier,batches};
}
test('C14 mode matrix exposes similarity only for local Transformers',()=>{
    assert.equal(classifierCapabilities({source:'transformers'}).similaritySupported,true);
    for(const source of ['bananabread','openai','webllm','ollama','cohere','qdrant']){
        assert.equal(classifierCapabilities({source}).similaritySupported,false);
        assert.throws(()=>requireSupportedClassifierMode({useEmbeddingSimilarity:true,source}),/requires/);
        assert.equal(emotionEmbeddingCapabilities({source}).supported,false);
    }
    assert.equal(requireSupportedClassifierMode({useEmbeddingSimilarity:true,source:'transformers'}),true);
});
test('C14 matched emotion returns ranked label, cosine confidence, and version',async()=>{
    const {classifier,batches}=harness();
    const r=await classifier.classify('I am furious about this.');
    assert.equal(r.label,'anger');assert.equal(r.score,1);assert.equal(r.allLabels.length,7);
    assert.equal(r.mode,'similarity');assert.equal(r.modelHonored,false);assert.equal(r.model,'server-controlled');assert.equal(r.prototypeVersion,EMOTION_PROTOTYPES_VERSION);
    assert.equal(r.uncertain,false);assert.equal(batches.length,2);
    assert.equal(batches[0].length,21);
});
test('C14 labelled small fixture set is evaluated and reports measured synthetic accuracy',async()=>{
    const {classifier,batches}=harness();
    const report=await classifier.evaluate();
    assert.equal(report.evaluated,14);assert.equal(report.correct,14);assert.equal(report.accuracy,1);
    assert.equal(report.unknown,0);assert.equal(batches.length,15);
    assert.equal(report.prototypeVersion,EMOTION_PROTOTYPES_VERSION);
});
test('C14 empty and whitespace text does not embed',async()=>{
    const {classifier,batches}=harness();
    assert.equal(await classifier.classify(''),null);assert.equal(await classifier.classify(' \n'),null);
    assert.equal(batches.length,0);
});
test('C14 unknown and tied scores return neutral, never a confident guess',async()=>{
    const {classifier}=harness();
    const result=await classifier.classify('uncertain');
    assert.equal(result.label,'neutral');assert.equal(result.score,0);assert.equal(result.uncertain,true);
});
test('C14 weak best score returns neutral',async()=>{
    const {classifier}=harness({threshold:0.9999,margin:0});
    assert.equal((await classifier.classify('uncertain')).label,'neutral');
});
test('C14 custom subset limits prototypes, rejects absent labels',async()=>{
    const {classifier,batches}=harness();
    assert.equal((await classifier.classify('I am furious about this.',{customLabels:['anger','joy']})).label,'anger');
    assert.equal(batches[0].length,6);
    await assert.rejects(classifier.classify('x',{customLabels:['anger','nonsense']}),/supported/);
    await assert.rejects(classifier.classify('x',{customLabels:['anger','anger']}),/unique/);
    await assert.rejects(classifier.classify('x',{customLabels:['__proto__']}),/supported/);
});
test('C14 changing label set changes cached prototypes without leaking old vectors',async()=>{
    const {classifier,batches}=harness();
    await classifier.classify('I am furious about this.',{customLabels:['anger']});
    await classifier.classify('I am furious about this.',{customLabels:['joy']});
    assert.equal(batches.length,4);assert.equal(batches[0].length,3);assert.equal(batches[2].length,3);
});
test('C14 repeated classification caches prototypes but still embeds each new query',async()=>{
    const {classifier,batches}=harness();
    await classifier.classify('A');await classifier.classify('B');
    assert.equal(batches.length,3);
    assert.equal(batches[0].length,21);assert.equal(batches[1].length,1);assert.equal(batches[2].length,1);
});
test('C14 explicit clear forces prototype refresh',async()=>{
    const {classifier,batches}=harness();
    await classifier.classify('A');classifier.clear();await classifier.classify('A');
    assert.equal(batches.length,4);
});
test('C14 concurrent prototypes are single-flight',async()=>{
    const {classifier,batches}=harness();
    const out=await Promise.all([classifier.classify('A'),classifier.classify('B'),classifier.classify('C')]);
    assert.equal(batches.filter(x=>x.length===21).length,1);assert.equal(out.length,3);
});
test('C14 late in-flight prototypes never restore cache after clearing',async()=>{
    let release;
    const gate=new Promise(r=>release=r);
    let first=true;let calls=0;
    const embed=async texts=>{calls++;if(first){first=false;await gate;}return texts.map(exampleEmbed);};
    const classifier=createEmotionSimilarityClassifier({embed,profileKey:'p'});
    const old=classifier.classify('A');
    classifier.clear();release();await old;
    await classifier.classify('A');
    assert.equal(calls,4,'new request must re-embed prototypes');
});
test('C14 invalid dimensions or vector contents fail closed',async()=>{
    for(const text of ['wrong-dimensional','bad-norm','bad-numeric','bad-type']){
        const {classifier}=harness();
        await assert.rejects(classifier.classify(text),/embedding|dimensions/);
    }
});
for(const bad of [null,[],[1],[[0,0,0]],[[1,NaN]],[[1,Infinity]],[[1,0],[1,0]]]){
    test('C14 bad prototype response is rejected '+String(bad),async()=>{
        const {classifier}=harness({fault:()=>bad});
        await assert.rejects(classifier.classify('hello'),/embedding/);
    });
}
test('C14 embedding request failure is retryable; not cached as success',async()=>{
    let attempt=0;const {classifier}=harness({fault:texts=>{if(++attempt===1)throw Error('offline');return texts.map(exampleEmbed);}});
    await assert.rejects(classifier.classify('test'),/offline/);
    assert.equal((await classifier.classify('test')).label,'joy');
});
test('C14 requires explicit embedding profile and valid thresholds',()=>{
    assert.throws(()=>createEmotionSimilarityClassifier({embed:async()=>[],profileKey:''}),/explicit/);
    assert.throws(()=>createEmotionSimilarityClassifier({embed:async()=>[],profileKey:'a',threshold:4}),/threshold/);
    assert.throws(()=>createEmotionSimilarityClassifier({embed:async()=>[],profileKey:'a',margin:-1}),/threshold/);
});
test('C14 plugin request sends no credential, URL, or model selection and requires ack',async()=>{
    const requests=[];
    const provider=createPluginEmotionEmbedder({settings:{source:'transformers',openai_api_key:'do-not-send'},request:async(url,options)=>{
        requests.push({url,options});return {ok:true,json:async()=>({success:true,embeddings:[[1,0]]})};
    }});
    const result=await provider.embed(['hello']);assert.equal(result.length,1);
    assert.equal(requests[0].url,'/api/plugins/similharity/batch-embeddings');
    const body=JSON.parse(requests[0].options.body);
    assert.deepEqual(body,{texts:['hello'],source:'transformers',model:''});
    assert.ok(!requests[0].options.body.includes('do-not-send'));
});
for(const source of ['bananabread','openai','koboldcpp']){
    test(`C14 plugin refuses unsupported ${source} before network call`,async()=>{
        let called=false;
        assert.throws(()=>createPluginEmotionEmbedder({settings:{source},request:async()=>{called=true;}}),/unavailable/);
        assert.equal(called,false);
    });
}
for(const response of [{ok:false,status:502},{ok:true,json:async()=>({success:false,embeddings:[[1]]})},
    {ok:true,json:async()=>({success:true,embeddings:[]})},
    {ok:true,json:async()=>({success:true,embeddings:'oops'})}]){
    test('C14 plugin refuses malformed/negative acknowledgements',async()=>{
        const p=createPluginEmotionEmbedder({request:async()=>response});
        await assert.rejects(p.embed(['hello']),/C14/);
    });
}
test('C14 rejects zero, empty, or oversize batches before network',async()=>{
    let calls=0;
    const p=createPluginEmotionEmbedder({request:async()=>{calls++;}});
    for(const values of [[],[''],Array(121).fill('a')])await assert.rejects(p.embed(values),/invalid/);
    assert.equal(calls,0);
});
test('C14 classifier UI exposes server-model honesty and local-only similarity',()=>{
    const ui=readFileSync(new URL('../ui/ui-manager.js',import.meta.url),'utf8');
    const html=readFileSync(new URL('../ui/settings.html',import.meta.url),'utf8');
    assert.match(ui,/getClassifierCapabilities\(\)\.similarity/);
    assert.match(ui,/testSimilarityClassifier\(/);
    assert.match(html,/controlled by the SillyTavern server/);
    assert.doesNotMatch(html,/id="vecthare_emotion_classifier_model"/);
    assert.match(html,/Classifier model: .*controlled by the SillyTavern server/);
});

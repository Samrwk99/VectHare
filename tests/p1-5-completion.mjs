/** Completion contract for safe model mixing and iterative post-filter retrieval. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { modelIsolationDecision } from '../core/model-isolation-consent.js';
import { nextCandidateLimit } from '../core/retrieval-policy.js';
const source=name=>fs.readFileSync(new URL('../'+name,import.meta.url),'utf8');
let checks=0;
function check(name,fn){fn();checks++;console.log('PASS',name)}
const profiles=[{embedding:{provider:'ollama',configuredModel:'model-A'}},
 {embedding:{provider:'llamacpp',modelId:'gguf-A'}}];
check('same verified embedding provider/model needs no warning',()=>{
 const x=modelIsolationDecision('ollama','model-A',[profiles[0]]);
 assert.equal(x.requiresConfirmation,false);
});
check('different provider and different model demand explicit confirmation',()=>{
 assert.equal(modelIsolationDecision('ollama','model-B',[profiles[0]]).requiresConfirmation,true);
 assert.equal(modelIsolationDecision('ollama','model-A',[profiles[1]]).requiresConfirmation,true);
});
check('model-less providers are treated conservatively when identity cannot be proven',()=>{
 assert.equal(modelIsolationDecision('llamacpp','',[profiles[1]]).requiresConfirmation,true);
});
check('confirmation is scoped to an exact provider/model pair',()=>{
 const a=modelIsolationDecision('ollama','A',profiles),b=modelIsolationDecision('ollama','B',profiles);
 assert.notEqual(a.token,b.token);
});
check('postfilter retrieval doubles candidate budget when page full and eligible insufficient',()=>{
 assert.equal(nextCandidateLimit({eligible:3,target:5,requested:32,mayHaveMore:true,maxLimit:2048}),64);
});
check('postfilter refill stops on enough eligible results, exhausted page or safety cap',()=>{
 for(const opts of [
  {eligible:5,target:5,requested:32,mayHaveMore:true,maxLimit:2048},
  {eligible:1,target:5,requested:32,mayHaveMore:false,maxLimit:2048},
  {eligible:1,target:5,requested:2048,mayHaveMore:true,maxLimit:2048}
 ])assert.equal(nextCandidateLimit(opts),null);
 assert.equal(nextCandidateLimit({eligible:1,target:5,requested:1024,mayHaveMore:true,maxLimit:2048}),2048);
});
check('backend overfetch no longer truncates requested refill to 100',()=>{
 assert.match(source('core/keyword-boost.js'),/Math\.min\(65536, Math\.max\(10, topK \* 2\)\)/);
});
check('all post-filter stages rerun on refill and final injection uses eligible result set',()=>{
 const code=source('core/chat-vectorization.js');
 const loop=code.indexOf('for (let refillRound=0;');
 assert.ok(loop>=0);
 for(const name of ['applyThresholdFilter(chunks','applyTemporalDecayStage(chunks','applyConditionsStage(chunks','applyGroupsAndLinksStage(chunks','deduplicateChunks(chunks']) {
  const idx=code.indexOf(name,loop);assert.ok(idx>loop,`missing stage ${name}`);
  assert.ok(idx<code.indexOf('const nextLimit=nextCandidateLimit',loop),`stage ${name} is after refill decision`);
 }
 assert.match(code,/candidateLimit=nextLimit;[\s\S]*?continue;/);
});
check('model warning is shown before vectorization and enforced again in core',()=>{
 const ui=source('ui/content-vectorizer.js'),core=source('core/content-vectorization.js');
 assert.match(ui,/I Understand — Continue/);
 assert.match(ui,/source\.modelRiskAccepted=modelRisk\.token/);
 assert.match(core,/source\.modelRiskAccepted !== risk\.token/);
 assert.match(core,/DIFFERENT_EMBEDDING_MODEL_CONFIRMATION_REQUIRED/);
 assert.doesNotMatch(ui,/Please delete this collection in Database Browser and try again/);
});
check('legacy recovery retains read-only state and offers staged replacement for connected chat',()=>{
 const ui=source('ui/database-browser.js'),profile=source('core/vectorization-profile.js');
 assert.match(profile,/writeVerified:false/);
 assert.match(ui,/vecthare_recipe_staged_rebuild/);
 assert.match(ui,/openContentVectorizer\('chat',key\)/);
});
console.log(`\n${checks} P1.5 completion checks passed`);

/** P-B.13: apply only source-attested, generation-current UUID group policies
 * to the verified-v2 retrieval candidate window. Never resolve legacy hashes.
 * Hard links/mandatory forcing need a separately verified get-by-ID path and
 * are deliberately not represented by these supported policies.
 */
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export function applyPB13ManagedRetrievalGroups(candidates,evidence,{backend,topK}={}) {
 if(!Array.isArray(candidates)||!evidence||evidence.sourceAuthoritative!==true||
    evidence.verifiedPhysicalInventory!==true||evidence.backend!==backend||
    evidence.requiresGenerationReview!==false||(!Number.isSafeInteger(evidence.generation)||evidence.generation<0)||
    !Array.isArray(evidence.groups)||!Number.isInteger(topK)||topK<1||topK>30)
  throw Object.assign(new Error('PB13_GROUP_EVIDENCE_UNVERIFIED'),{code:'PB13_GROUP_EVIDENCE_UNVERIFIED'});
 const input=new Map();
 for(const item of candidates){
  if(!item||!UUID.test(item.recordId??'')||input.has(item.recordId)||
     !Number.isFinite(item.score))throw Object.assign(new Error('PB13_CANDIDATE_INVALID'),{code:'PB13_CANDIDATE_INVALID'});
  input.set(item.recordId,item);
 }
 const orphaned=new Set((evidence.orphanedMembers||[]).map(x=>`${x.groupId}\0${x.recordId}`));
 const boosts=new Map(),excluded=new Set();
 for(const group of evidence.groups){
  // Old P-B.12 metadata-only groups did not have retrieval semantics.
  if(group.mode===undefined)continue;
  if(!UUID.test(group.id??'')||!Array.isArray(group.members)||
     !['exclusive','inclusive'].includes(group.mode)||
     (group.mode==='inclusive'&&(!Number.isFinite(group.boost)||group.boost<0||group.boost>1)))
   throw Object.assign(new Error('PB13_GROUP_POLICY_INVALID'),{code:'PB13_GROUP_POLICY_INVALID'});
  // An orphan is not a licence to force any other record into the query.
  const present=group.members.filter(id=>!orphaned.has(`${group.id}\0${id}`)&&input.has(id));
  if(group.mode==='exclusive'&&present.length>1){
   const ordered=present.sort((a,b)=>input.get(b).score-input.get(a).score||a.localeCompare(b));
   for(const id of ordered.slice(1))excluded.add(id);
  }else if(group.mode==='inclusive'&&present.length>1){
   // Soft links re-rank already returned, in-scope records only.
   for(const id of present)boosts.set(id,(boosts.get(id)||0)+group.boost);
  }
 }
 const result=candidates.filter(x=>!excluded.has(x.recordId)).map(x=>
  boosts.has(x.recordId)?{...x,score:x.score+boosts.get(x.recordId)}:x);
 result.sort((a,b)=>b.score-a.score||a.recordId.localeCompare(b.recordId));
 return result.slice(0,topK);
}

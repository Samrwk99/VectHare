/** C09 bounded retrieval planner. Does not manufacture backend capabilities.
 * All identities are collection-scoped; physical hashes alone are not unique.
 * Candidates are assumed to have passed the caller's tenant and activation checks.
 */
export const C09_MAX_REFILL_ROUNDS = 2;
export const C09_MAX_OVERFETCH = 5;
const finite = x => Number.isFinite(Number(x)) ? Number(x) : 0;
export const candidateId = c => `${String(c.collectionId ?? c.collectionKey ?? '')}\u0000${String(c.recordId ?? c.hash ?? '')}`;
export function rankCandidates(a,b,priorities={}) {
    return finite(b.score)-finite(a.score) || finite(priorities[b.collectionId])-finite(priorities[a.collectionId]) ||
        String(a.collectionId??'').localeCompare(String(b.collectionId??'')) ||
        String(a.recordId??a.hash??'').localeCompare(String(b.recordId??b.hash??''));
}
export function overfetchSize(k,{factor=3,max=200}={}) {
    if (!Number.isSafeInteger(k)||k<=0) return 0;
    return Math.min(Math.max(k,Math.ceil(k*Math.min(C09_MAX_OVERFETCH,Math.max(1,factor)))),Math.max(k,max));
}
const memberId = (collectionId,hash) => `${String(collectionId)}\u0000${String(hash)}`;
function reason(reasons,item,code,detail={}) { reasons.push({collectionId:item?.collectionId??null,recordId:item?.recordId??item?.hash??null,code,...detail}); }
/** Resolve all exclusive groups simultaneously. A candidate belonging to two
 * groups must win BOTH; a loser cannot be resurrected by another group.
 * Unsatisfiable mandatory groups are reported, not silently overridden.
 */
export function resolveGroupConstraints(items,groups=[],{priorities={}}={}) {
    const reasons=[];
    const eligible=items.filter(c=>{
        if(c && c.disabled!==true && c.eligible!==false) return true;
        if(c) reason(reasons,c,'ineligible-or-disabled');
        return false;
    });
    const byId=new Map();
    for(const c of [...eligible].sort((a,b)=>rankCandidates(a,b,priorities))) {
        const key=candidateId(c);
        if(byId.has(key)){reason(reasons,c,'duplicate-candidate');continue;}
        byId.set(key,c);
    }
    const byHash=new Map();
    const ambiguousIds=new Set();
    for(const c of byId.values()) {
        const k=memberId(c.collectionId,c.hash??c.recordId);
        if(byHash.has(k)) {
            reason(reasons,c,'ambiguous-physical-hash');
            ambiguousIds.add(candidateId(c));
            if(byHash.get(k)) ambiguousIds.add(candidateId(byHash.get(k)));
            byHash.set(k,null);
        } else byHash.set(k,c);
    }
    const losers=new Set();
    const exclusive=groups.filter(g=>g?.mode==='exclusive' && g.collectionId && Array.isArray(g.members));
    for(const group of [...exclusive].sort((a,b)=>String(a.id).localeCompare(String(b.id)))) {
        const participating=group.members.map(hash=>byHash.get(memberId(group.collectionId,hash))).filter(Boolean).sort((a,b)=>rankCandidates(a,b,priorities));
        if(participating.length<=1) continue;
        for(const c of participating.slice(1)) {
            const id=candidateId(c); losers.add(id);
            reason(reasons,c,'exclusive-group-loser',{groupId:group.id,winner:participating[0].recordId??participating[0].hash});
        }
    }
    const chosen=[...byId.values()].filter(c=>!losers.has(candidateId(c)) && !ambiguousIds.has(candidateId(c)));
    for(const group of exclusive.filter(g=>g.mandatory)) {
        if(!group.members.some(m=>chosen.some(c=>memberId(c.collectionId,c.hash??c.recordId)===memberId(group.collectionId,m))))
            reasons.push({code:'mandatory-group-unsatisfied',groupId:group.id,collectionId:group.collectionId});
    }
    return {items:chosen.sort((a,b)=>rankCandidates(a,b,priorities)),reasons};
}
/** Expand explicit and inclusive hard links via a VERIFIED caller-provided
 * scoped getByIds. Never fetch cross-collection IDs or trust unscoped results.
 * A missing contract is an explicit diagnostic, not silent best effort.
 */
export async function expandRequiredLinks(items,groups=[],{getByIds,maxIds=128,priorities={}}={}) {
    const reasons=[];const pool=new Map(items.map(x=>[candidateId(x),x]));
    const byHash=new Set(items.map(x=>memberId(x.collectionId,x.hash??x.recordId)));
    const requests=new Map();
    const request=(source,hash,kind)=>{
        const key=memberId(source.collectionId,hash);
        if(byHash.has(key))return;
        if(!requests.has(source.collectionId))requests.set(source.collectionId,new Set());
        requests.get(source.collectionId).add(String(hash));
    };
    for(const item of items) {
        const links=[...(item.metadata?.links||[]),...(item.metadata?.chunkLinks||[])];
        for(const l of links) if(l?.type==='hard' && l.target!=null) request(item,l.target,'hard');
    }
    for(const group of groups) {
        if(!group?.collectionId||!Array.isArray(group.members))continue;
        if(group.mode!=='inclusive' && !(group.mode==='exclusive'&&group.mandatory))continue;
        if(group.mode==='inclusive' && group.linkType!=='hard')continue;
        const matches=group.members.some(m=>byHash.has(memberId(group.collectionId,m)));
        if(!matches && group.mode!=='exclusive')continue;
        for(const hash of group.members)request({collectionId:group.collectionId},hash,'group');
    }
    let remaining=Math.max(0,Math.min(512,Number(maxIds)||0));
    for(const [collectionId,idSet] of [...requests].sort(([a],[b])=>a.localeCompare(b))) {
        const ids=[...idSet].sort();
        if(ids.length>remaining) reasons.push({code:'expansion-cap',collectionId,omitted:ids.length-remaining});
        const requested=ids.slice(0,remaining);remaining-=requested.length;
        if(!requested.length)continue;
        if(typeof getByIds!=='function') {reasons.push({code:'get-by-ids-unverified',collectionId,requested:requested.length});continue;}
        let result;
        try {result=await getByIds({collectionId,recordIds:requested});}
        catch {reasons.push({code:'get-by-ids-failed',collectionId});continue;}
        if(result?.status!=='confirmed' || result?.complete!==true || !Array.isArray(result.items)) {
            reasons.push({code:'get-by-ids-unverified',collectionId});continue;
        }
        const requestedSet=new Set(requested);
        if(result.items.some(c=>c?.collectionId!==collectionId || !requestedSet.has(String(c.hash??c.recordId)) || c.disabled===true || c.eligible===false) ||
            new Set(result.items.map(c=>String(c.hash??c.recordId))).size!==result.items.length) {
            reasons.push({code:'get-by-ids-scope-mismatch',collectionId});continue;
        }
        for(const c of result.items) { pool.set(candidateId(c),{...c,forcedLinked:true}); byHash.add(memberId(c.collectionId,c.hash??c.recordId)); }
        for(const id of requested) if(!result.items.some(c=>String(c.hash??c.recordId)===id))
            reasons.push({code:'required-member-unavailable',collectionId,recordId:id});
    }
    return {items:[...pool.values()].sort((a,b)=>rankCandidates(a,b,priorities)),reasons};
}
/** Stable bounded selection; collection preferences apply only after activation
 * and ownership checks, never as a way of re-enabling rejected candidates.
 */
export function selectFinal(items,{limit=10,priorities={},quotas={},groups=[]}={}) {
    const reasons=[];
    const constrained=resolveGroupConstraints(items,groups,{priorities});reasons.push(...constrained.reasons);
    const chosen=[];const counts=new Map();const max=Math.max(0,Math.min(1000,Number.isFinite(limit)?Math.floor(limit):0));
    for(const item of constrained.items) {
        const quota=quotas[item.collectionId];
        if(quota!==undefined && counts.get(item.collectionId)>=Math.max(0,Math.floor(quota))) {reason(reasons,item,'collection-quota');continue;}
        if(chosen.length===max) {reason(reasons,item,'budget-exhausted');continue;}
        chosen.push(item);counts.set(item.collectionId,(counts.get(item.collectionId)||0)+1);
    }
    return {items:chosen,reasons,remainingSlots:Math.max(0,max-chosen.length)};
}
/** At most two extra retrieval rounds; filters run before budget selection. */
export async function planCandidates({query,limit,collections,fetchRound,filter=async x=>x,groups=[],getByIds,priorities={},quotas={},maxRounds=C09_MAX_REFILL_ROUNDS}={}) {
    if(typeof fetchRound!=='function') throw Error('fetchRound required');
    const reasons=[];const pool=new Map();let selected={items:[],remainingSlots:limit,reasons:[]};let rounds=0;
    for(let round=0;round<=Math.min(C09_MAX_REFILL_ROUNDS,Math.max(0,maxRounds));round++) {
        rounds++;
        const requested=overfetchSize(limit,{factor:round+2});
        const fetched=await fetchRound({query,collections,limit:requested,round});
        if(!fetched||fetched.complete===false||!Array.isArray(fetched.items)) {
            reasons.push({code:'refill-backend-incomplete',round});break;
        }
        const before=pool.size;
        for(const item of fetched.items) if(item?.collectionId && (item.recordId!=null||item.hash!=null))pool.set(candidateId(item),item);
        const passed=await filter([...pool.values()]);
        const expanded=await expandRequiredLinks(passed,groups,{getByIds,priorities});reasons.push(...expanded.reasons);
        selected=selectFinal(expanded.items,{limit,priorities,quotas,groups});
        if(selected.remainingSlots===0)break;
        if(fetched.exhausted===true){reasons.push({code:'refill-backend-exhausted',round});break;}
        if(pool.size===before){reasons.push({code:'refill-no-progress',round});break;}
    }
    if(selected.remainingSlots>0 && !reasons.some(r=>r.code.startsWith('refill-')))
        reasons.push({code:'refill-bound-reached',rounds,remaining:selected.remainingSlots});
    return {...selected,reasons:[...reasons,...selected.reasons],rounds};
}
/** C09 #76: detect overlapping group membership by stable per-chat message UIDs,
 * not by the hash of their combined text. A missing UID never causes suppression.
 */
export function removeOverlappingGroups(items,{priorities={}}={}) {
    const reasons=[],seen=new Map(),selected=[];
    for(const item of [...items].sort((a,b)=>rankCandidates(a,b,priorities))) {
        const refs=item.metadata?.messageRefs ?? item.metadata?.messageIds ?? item.messageIds ?? [];
        const chatScope=item.metadata?.chatId ?? item.metadata?.chatOriginId ?? item.chatId;
        // Positional message indices are NOT globally stable. Require a known
        // chat origin before treating them as overlaps. Copied chats can retain
        // the same UID, so a UID alone is not sufficient without chat scope.
        const ids=Array.isArray(refs)?refs.flatMap(r=>{
            const uid=r && typeof r==='object' ? (r.messageUid ?? r.uid) : null;
            const origin=r && typeof r==='object' ? (r.chatId ?? r.chatOriginId ?? chatScope) : chatScope;
            if(uid != null && origin != null) return [`chat:${String(origin)}:uid:${String(uid)}`];
            const index=r && typeof r==='object' ? r.messageId : r;
            return chatScope != null && index != null ? [`chat:${String(chatScope)}:position:${String(index)}`] : [];
        }):[];
        const scope=String(item.collectionId??'');
        const collisions=ids.filter(id=>seen.has(`${scope}\u0000${id}`));
        if(collisions.length) {reason(reasons,item,'overlapping-message-membership',{overlapCount:collisions.length});continue;}
        selected.push(item);
        for(const id of ids)seen.set(`${scope}\u0000${id}`,candidateId(item));
    }
    return {items:selected,reasons};
}
/** C09 #147: exclusive activation always chooses one winner in the relevant
 * scope. Presence of an exclusive collection never bypasses activation.
 */
export function resolveExclusiveCollections(activeIds,metadataFor,{priorities={}}={}) {
    const active=[...new Set(activeIds)];const reasons=[];
    const exclusive=active.filter(id=>metadataFor(id)?.exclusiveWhenActive===true)
        .sort((a,b)=>finite(priorities[b]??metadataFor(b)?.retrievalPriority)-finite(priorities[a]??metadataFor(a)?.retrievalPriority)||String(a).localeCompare(String(b)));
    if(!exclusive.length)return {ids:active,reasons};
    const winner=exclusive[0];const winnerScope=metadataFor(winner)?.exclusiveScope==='all'?'all':'lorebook';
    const ids=active.filter(id=>{
        if(id===winner)return true;
        if(exclusive.includes(id)){reasons.push({collectionId:id,code:'exclusive-collection-loser',winner});return false;}
        if(winnerScope==='all' || String(id).toLowerCase().includes('lorebook')){
            reasons.push({collectionId:id,code:'exclusive-collection-suppressed',winner});return false;
        }
        return true;
    });
    return {ids,reasons};
}

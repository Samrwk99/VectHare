/** C10 #187 — registration is not proof that text survived host assembly.
 * A receipt only confirms exact complete blocks in a witnessed assembly event.
 */
export function makePromptSentinel() {
    if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID().replace(/-/g,'');
    // No predictable or reused delimiters in generated prompts.
    throw new Error('Secure prompt receipt nonce unavailable');
}

export function wrapPromptBlock(text, nonce, index) {
    if(!/^[0-9a-f]{32}$/i.test(String(nonce)) || !Number.isSafeInteger(index) || index<0) throw new Error('Invalid prompt receipt identity');
    return `<!-- VH:${nonce}:${index}:BEGIN -->\n${text}\n<!-- VH:${nonce}:${index}:END -->`;
}
/** Capture host-assembled text without joining *different chat messages*.
 * The host can represent one message as several adjacent text parts; those
 * parts may be joined, but separate messages cannot synthesize a whole block.
 */
function assembledSegments(event,kind) {
    if (!event || typeof event !== 'object' || event.dryRun === true || event.dry_run === true) return null;
    if (kind==='text') return typeof event.prompt==='string' ? [event.prompt] : null;
    if (kind!=='chat' || !Array.isArray(event.chat)) return null;
    const segments=[];
    function visit(v,strings,depth=0) {
        if(depth>8)return;
        if(typeof v==='string'){strings.push(v);return;}
        if(Array.isArray(v)){for(const part of v)visit(part,strings,depth+1);return;}
        if (v && typeof v==='object') {
            if(typeof v.text==='string')visit(v.text,strings,depth+1);
            if(typeof v.content==='string'||Array.isArray(v.content))visit(v.content,strings,depth+1);
        }
    }
    for(const message of event.chat) {
        const parts=[];
        visit(message,parts);
        // A structured chat payload may have non-text images and audio; they
        // contribute no text and cannot be used as a bridge between messages.
        if(parts.length)segments.push(parts.join('\n'));
    }
    return segments;
}

export function createPromptReceiptTracker({getChatId=()=>null,onReceipt=()=>{},now=()=>Date.now()}={}) {
    let pending=null;
    let last={status:'unknown',verified:false,reason:'no-prompt-assembly-event'};
    return {
        register({chatId,groups=[],turnId,nonce}={}) {
            if (!chatId || !nonce || !Array.isArray(groups) || !groups.length || groups.some(g=>typeof g.text!=='string'||!g.text))
                return {status:'unknown',verified:false};
            pending={chatId:String(chatId),turnId,nonce,started:now(),groups:groups.map(g=>({...g,recordIds:[...(g.recordIds||[])]}))};
            last={status:'registered',verified:false,reason:'awaiting-host-assembly'};
            return {...last};
        },
        observe(kind,event) {
            if (!pending) return {status:'unknown',verified:false,reason:'no-pending-prompt'};
            if(!['text','chat'].includes(kind))return {status:'unknown',verified:false,reason:'unknown-event-type'};
            if(String(getChatId()??'')!==pending.chatId) {pending=null;last={status:'unknown',verified:false,reason:'chat-changed'};return {...last};}
            // A stale assembly event must never certify a newer registration.
            if(now()-pending.started>120000){pending=null;last={status:'unknown',verified:false,reason:'receipt-expired'};return {...last};}
            const segments=assembledSegments(event,kind);
            if(segments===null)return {status:'unknown',verified:false,reason:'unverifiable-or-dry-run'};
            const result=pending.groups.map(g=>{
                const included=segments.some(segment=>segment.includes(g.text));
                return {tag:g.tag,status:included?'included':'notIncluded',verified:true,
                    recordIds:included?g.recordIds:[],frequencyEntries:included?(g.frequencyEntries||[]):[]};
            });
            const allIncluded=result.every(g=>g.status==='included');
            const anyIncluded=result.some(g=>g.status==='included');
            const receipt={status:allIncluded?'included':anyIncluded?'partial':'notIncluded',verified:true,kind,
                groups:result,recordIds:result.flatMap(g=>g.recordIds),chatId:pending.chatId,turnId:pending.turnId,nonce:pending.nonce};
            pending=null;last=receipt;
            try {onReceipt(receipt);} catch { /* Observed inclusion cannot imply durable accounting */ }
            return receipt;
        },
        invalidate(){pending=null;last={status:'unknown',verified:false,reason:'invalidated'};},
        current(){return {...last};},
        hasPending(){return !!pending;},
    };
}

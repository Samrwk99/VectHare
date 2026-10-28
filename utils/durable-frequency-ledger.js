/** C10 -> C08 durability bridge. One browser-storage key per confirmed turn
 * avoids read-modify-write count loss when multiple generations overlap.
 * No chunk text or API secrets are stored. A failed write does NOT count.
 */
const PREFIX='vecthare.frequency.v1.';
const asId=value=>value!==undefined&&value!==null&&String(value).length>0&&String(value).length<512?String(value):null;
const safeStorage=(name)=>{try{return globalThis[name]??null;}catch{return null;}};
export function createDurableFrequencyLedger({local=safeStorage('localStorage'),session=safeStorage('sessionStorage')}={}) {
    const pending=new Map();
    const select=scope=>scope==='conversation'?local:scope==='session'?session:null;
    function parseKey(key) {
        if(typeof key!=='string'||!key.startsWith(PREFIX))return null;
        try {
            const tuple=JSON.parse(decodeURIComponent(key.slice(PREFIX.length)));
            if(!Array.isArray(tuple)||tuple.length!==5||tuple.some(v=>!asId(v))||!['conversation','session'].includes(tuple[2]))return null;
            return tuple;
        }catch{return null;}
    }
    const tupleOf=args=>[asId(args.chatId),asId(args.collectionKey),args.scope??'conversation',asId(args.recordId),asId(args.turnId)];
    const keyOf=tuple=>PREFIX+encodeURIComponent(JSON.stringify(tuple));
    return {
        isAvailable(scope='conversation') {
            const store=select(scope);
            if(!store)return false;
            try {const key=PREFIX+'storage-test';store.setItem(key,'1');const ok=store.getItem(key)==='1';store.removeItem(key);return ok;}catch{return false;}
        },
        recordActivation(args={}) {
            const tuple=tupleOf(args);
            if(tuple.some(x=>!x)||!['conversation','session'].includes(tuple[2]))return {status:'invalid'};
            if(args.dryRun)return {status:'dry-run'};
            const key=keyOf(tuple),store=select(tuple[2]);
            if(args.receipt?.status!=='included'||args.receipt?.verified!==true||
                !args.receipt?.recordIds?.includes(tuple[3])) {
                pending.set(key,'unverified');return {status:'unverified'};
            }
            try {
                if(!store)return {status:'storage-unavailable'};
                if(store.getItem(key)!==null)return {status:'duplicate'};
                const messageCount=Number(args.messageCount);
                const value=JSON.stringify({v:1,messageCount:Number.isSafeInteger(messageCount)?messageCount:null});
                store.setItem(key,value);
                if(store.getItem(key)!==value)return {status:'storage-unavailable'};
                pending.delete(key);return {status:'recorded'};
            }catch{return {status:'storage-unavailable'};}
        },
        snapshot({chatId,collectionKey,scope='conversation'}={}) {
            const result=Object.create(null),store=select(scope);
            if(!store||!asId(chatId)||!asId(collectionKey))return result;
            try {
                for(let i=0;i<store.length;i++) {
                    const key=store.key(i),tuple=parseKey(key);
                    if(!tuple||tuple[0]!==String(chatId)||tuple[1]!==String(collectionKey)||tuple[2]!==scope)continue;
                    const raw=JSON.parse(store.getItem(key));
                    if(raw?.v!==1|| (raw.messageCount!==null&&!Number.isSafeInteger(raw.messageCount)))continue;
                    const record=tuple[3],entry=result[record]??{count:0,lastActivation:null};
                    entry.count++;
                    if(raw.messageCount!==null)entry.lastActivation=Math.max(entry.lastActivation??0,raw.messageCount);
                    result[record]=entry;
                }
            }catch{return Object.create(null);}
            return result;
        },
        pendingCount(){return pending.size;},
        clearSession(){if(!session)return;try{
            for(let i=session.length-1;i>=0;i--){const key=session.key(i);if(parseKey(key)?.[2]==='session')session.removeItem(key);}
        }catch{}},
        clearAll(){for(const store of [local,session]){if(!store)continue;try{
            for(let i=store.length-1;i>=0;i--){const key=store.key(i);if(parseKey(key))store.removeItem(key);}
        }catch{}}pending.clear();}
    };
}

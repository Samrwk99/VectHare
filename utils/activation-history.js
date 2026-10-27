/** C03: scope frequency counters by chat, qualified collection and session. */
export function createScopedActivationHistory() {
    const entries = new Map();
    const makeKey = ({chatId,collectionKey,scope='conversation'}, hash) => {
        if (!chatId || !collectionKey || hash == null) return null;
        if (scope !== 'session' && scope !== 'conversation') return null;
        return JSON.stringify([String(chatId),String(collectionKey),scope,String(hash)]);
    };
    return {
        snapshot({chatId,collectionKey,scope='conversation'}={}) {
            const result = Object.create(null);
            if (!chatId || !collectionKey) return result;
            for(const [key,value] of entries) {
                let tuple;
                try {tuple=JSON.parse(key);} catch {continue;}
                if(tuple[0]===String(chatId) && tuple[1]===String(collectionKey) && tuple[2]===scope)
                    result[tuple[3]]={...value};
            }
            return result;
        },
        record({chatId,collectionKey,scope='conversation',hash,messageCount}={}) {
            const key=makeKey({chatId,collectionKey,scope},hash);
            if(!key) return false;
            const old=entries.get(key) || {count:0,lastActivation:null};
            entries.set(key,{count:old.count+1,lastActivation:messageCount});
            return true;
        },
        clearSession() {
            for(const key of entries.keys()) if(JSON.parse(key)[2]==='session') entries.delete(key);
        },
        clearAll() { entries.clear(); },
    };
}
export const scopedActivationHistory=createScopedActivationHistory();

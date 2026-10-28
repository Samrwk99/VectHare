/** E03: evidence-based persistence. Browser-local IndexedDB durability is NOT
 * proof that SillyTavern accepted a server-side extension_settings save.
 * No payload text, vectors, API keys or credentials belong in this receipt store.
 */
const MAX_BYTES = 256 * 1024;
const STORE = 'receipts';
const SCHEMA = 1;
const encoder = new TextEncoder();
const secretName = /^(?:api_?key|token|password|authorization|secret|credential|extrasKey)$/i;
const fail = reason => new Error(`E03 persistence unverified: ${reason}`);
function canonical(value) {
    const visit=(v,depth=0)=>{
        if(depth>30)throw fail('nesting-limit');
        if(v===null || typeof v==='string' || typeof v==='boolean')return v;
        if(typeof v==='number' && Number.isFinite(v))return v;
        if(Array.isArray(v))return v.map(x=>visit(x,depth+1));
        if(!v || typeof v!=='object' || Object.getPrototypeOf(v)!==Object.prototype)throw fail('unsupported-value');
        const out={};
        for(const k of Object.keys(v).sort()) {
            if(secretName.test(k))throw fail('secret-field-disallowed');
            if(k==='__proto__'||k==='constructor'||k==='prototype')throw fail('unsafe-key');
            out[k]=visit(v[k],depth+1);
        }
        return out;
    };
    const result=JSON.stringify(visit(value));
    if(encoder.encode(result).length>MAX_BYTES)throw fail('size-limit');
    return result;
}
export function verifySameSnapshot(expected,actual){
    try{return canonical(expected)===canonical(actual);}catch{return false;}
}
/** Host adapter MUST perform an independent authenticated server read for
 * readFresh; checking extension_settings in memory or localStorage is invalid.
 * All host endpoint decisions remain deferred to verification of deployed ST.
 */
export function createHostSettingsVerifier({write,readFresh,readbackIsServer=false}={}) {
    return {
        async persistAndVerify(key,value) {
            if(!readbackIsServer || typeof write!=='function'||typeof readFresh!=='function')
                return {ok:false,reason:'server-readback-not-configured'};
            let serialized;
            try {serialized=canonical(value);} catch {return {ok:false,reason:'invalid-snapshot'};}
            if(typeof key!=='string'||!key||key.length>256)return {ok:false,reason:'invalid-key'};
            try {
                const acknowledgement=await write(key,JSON.parse(serialized));
                if(acknowledgement?.durablySaved!==true)return {ok:false,reason:'server-save-unacknowledged'};
                const fresh=await readFresh(key);
                if(!fresh || fresh.fromServer!==true || !verifySameSnapshot(JSON.parse(serialized),fresh.value))
                    return {ok:false,reason:'server-readback-mismatch'};
                return {ok:true,scope:'host-server',readbackVerified:true};
            }catch{return {ok:false,reason:'server-roundtrip-failed'};}
        }
    };
}
/** E03 receipt store: IndexedDB transaction COMPLETES, then a new independent
 * readonly transaction must return byte-identical data. This only verifies
 * browser-local persistence, not disk fsync or server-side durability.
 */
export function createVerifiedReceiptStore({indexedDB=globalThis.indexedDB,databaseName='vecthare-e03-receipts'}={}) {
    let dbPromise;
    async function db(){
        if(!indexedDB?.open)throw fail('indexeddb-unavailable');
        if(!dbPromise){
            dbPromise=new Promise((resolve,reject)=>{
                const r=indexedDB.open(databaseName,SCHEMA);
                r.onupgradeneeded=()=>{if(!r.result.objectStoreNames.contains(STORE))r.result.createObjectStore(STORE,{keyPath:'key'});};
                r.onsuccess=()=>resolve(r.result);
                r.onerror=()=>reject(fail('database-open-failed'));
                r.onblocked=()=>reject(fail('database-upgrade-blocked'));
            });
            dbPromise.catch(()=>{dbPromise=null;});
        }
        return dbPromise;
    }
    async function read(key) {
        const database=await db();
        return new Promise((resolve,reject)=>{
            const tx=database.transaction(STORE,'readonly'),request=tx.objectStore(STORE).get(key);
            let result;
            request.onsuccess=()=>{result=request.result;};
            tx.oncomplete=()=>resolve(result?{key:result.key,value:result.value}:null);
            tx.onerror=()=>reject(fail('read-failed'));
            tx.onabort=()=>reject(fail('read-aborted'));
        });
    }
    async function persistAndVerify(key,value){
        if(typeof key!=='string'||!key||key.length>256)return {ok:false,reason:'invalid-key'};
        let data;
        try{data=canonical(value);}catch{return {ok:false,reason:'invalid-snapshot'};}
        try {
            const database=await db();
            await new Promise((resolve,reject)=>{
                const tx=database.transaction(STORE,'readwrite');
                tx.objectStore(STORE).put({key,value:data});
                tx.oncomplete=resolve;
                tx.onerror=()=>reject(fail('write-failed'));
                tx.onabort=()=>reject(fail('write-aborted'));
            });
            const saved=await read(key);
            if(!saved||saved.value!==data)return {ok:false,reason:'independent-readback-mismatch'};
            return {ok:true,scope:'browser-indexeddb',readbackVerified:true};
        }catch{return {ok:false,reason:'durable-browser-store-unavailable'};}
    }
    return {persistAndVerify,readVerified:async key=>{
        const saved=await read(key);
        if(!saved)return null;
        try{return JSON.parse(saved.value);}catch{throw fail('corrupt-receipt');}
    }};
}

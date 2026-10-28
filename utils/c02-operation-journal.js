/**
 * C02 durable, payload-free operation journal. Never stores vectors, message
 * text, credentials, or raw backend errors. IndexedDB request success is not a
 * transaction commit: all writes resolve only after transaction.oncomplete.
 */
import { parseCollectionKey } from './collection-keys.js';
const DB_NAME = 'vecthare-c02-operations';
const STORE = 'operations';
const SCHEMA = 1;
const STATES = new Set(['staged','verified','committed','needs-reconcile']);
const KINDS = new Set(['import','replace','deduplicate','reembed','scene-replace','physical-id-migration']);
const MAX_RECORDS = 20000;
const MAX_IDS = 50000;
let counter = 0;
const idString = value => typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value)) ? String(value) : null;
export function verifiedIds(ids, {allowEmpty=true}={}) {
    if (!Array.isArray(ids) || ids.length > MAX_IDS || (!allowEmpty && !ids.length)) throw new Error('Invalid operation ID list');
    const result=ids.map(idString);
    if(result.some(id=>id===null || id.length===0 || id.length>512) || new Set(result).size!==result.length) throw new Error('Missing, duplicate, or invalid operation record ID');
    return result;
}
export function operationId() {
    // All durable journal keys must be unpredictable across tabs/reloads.
    const c=globalThis.crypto;
    if(c?.randomUUID) return `c02-${c.randomUUID()}`;
    if(c?.getRandomValues){const bytes=new Uint8Array(16); c.getRandomValues(bytes); return `c02-${[...bytes].map(b=>b.toString(16).padStart(2,'0')).join('')}`;}
    // No secure entropy => do not risk overwriting a different operation.
    throw new Error('C02 persistent operation identity requires secure randomness');
}
function publicHeader(header) {
    if (!header || typeof header !== 'object' || !parseCollectionKey(header.collectionKey) || !KINDS.has(header.kind) || !STATES.has(header.phase)) throw new Error('Invalid C02 journal header');
    if(header.schema!==undefined && header.schema!==SCHEMA)throw new Error('Unsupported C02 journal schema');
    if (typeof header.operationId!=='string' || !/^c02-[a-f0-9-]{16,80}$/i.test(header.operationId)) throw new Error('Invalid operation identifier');
    const oldIds=verifiedIds(header.oldIds||[]);
    const newIds=verifiedIds(header.newIds||[]);
    const confirmedIds=verifiedIds(header.confirmedIds||[]);
    // Versioned per-item digests permit payload-free drift detection on
    // user-approved retries after reload. No raw text or vectors are stored.
    const newDigests=header.newDigests||[];
    if(!Array.isArray(newDigests) || (newDigests.length!==0 && newDigests.length!==newIds.length) ||
       newDigests.some(d=>typeof d!=='string' || !/^vh-fp2-fnv64:[a-f0-9]{16}$/.test(d)))
        throw new Error('Invalid replacement content fingerprint');
    const planned=new Set(newIds);
    if(confirmedIds.some(id=>!planned.has(id))) throw new Error('Unplanned confirmed record ID');
    if (!Number.isSafeInteger(header.createdAt) || header.createdAt<0 || !Number.isSafeInteger(header.updatedAt) || header.updatedAt<header.createdAt) throw new Error('Invalid journal timestamps');
    const reason=typeof header.reason === 'string' && /^[a-z0-9-]{1,64}$/.test(header.reason) ? header.reason : 'none';
    return {schema:SCHEMA,operationId:header.operationId,kind:header.kind,collectionKey:header.collectionKey,
        oldIds,newIds,confirmedIds,newDigests:[...newDigests],phase:header.phase,createdAt:header.createdAt,updatedAt:header.updatedAt,reason};
}
export function makeHeader({collectionKey,kind,oldIds=[],newIds=[],newDigests=[],id=operationId()}={}) {
    const now=Date.now();
    return publicHeader({operationId:id,collectionKey,kind,oldIds,newIds,newDigests,confirmedIds:[],phase:'staged',createdAt:now,updatedAt:now,reason:'none'});
}
export function createIndexedDBOperationJournal({indexedDB=globalThis.indexedDB,databaseName=DB_NAME}={}) {
    let dbPromise;
    function database(){
        if(dbPromise) return dbPromise;
        if(!indexedDB?.open) throw new Error('C02 durable storage unavailable: writes disabled');
        dbPromise=new Promise((resolve,reject)=>{
            const request=indexedDB.open(databaseName,SCHEMA);
            request.onupgradeneeded=()=>{const db=request.result;if(!db.objectStoreNames.contains(STORE))db.createObjectStore(STORE,{keyPath:'operationId'});};
            request.onerror=()=>reject(new Error('C02 IndexedDB open failed'));
            request.onsuccess=()=>resolve(request.result);
            request.onblocked=()=>reject(new Error('C02 IndexedDB upgrade blocked'));
        });
        dbPromise.catch(()=>{dbPromise=null;});
        return dbPromise;
    }
    async function transaction(mode,action){
        const db=await database();
        return new Promise((resolve,reject)=>{
            let tx;try{tx=db.transaction(STORE,mode);}catch(_){reject(new Error('C02 IndexedDB transaction could not start'));return;}
            const store=tx.objectStore(STORE);
            let result;
            try {result=action(store);}catch(_){tx.abort();reject(new Error('C02 IndexedDB operation rejected'));return;}
            tx.oncomplete=()=>resolve(result?.result);
            tx.onabort=()=>reject(new Error('C02 journal transaction aborted'));
            tx.onerror=()=>reject(new Error('C02 journal transaction failed'));
        });
    }
    return {
        async create(header){
            const value=publicHeader(header);
            // Early duplicate detection provides a specific message; add() is
            // still the atomic cross-tab uniqueness guard if another tab races.
            if(await this.get(value.operationId))throw new Error('Operation already exists');
            await transaction('readwrite',store=>store.add(value));
            const saved=await this.get(value.operationId);
            if(!saved || JSON.stringify(saved)!==JSON.stringify(value))throw new Error('C02 journal create readback failed');
            return saved;
        },
        async put(header){
            const value=publicHeader(header),db=await database();
            return new Promise((resolve,reject)=>{
                let tx;try{tx=db.transaction(STORE,'readwrite');}catch(_){reject(new Error('C02 journal write unavailable'));return;}
                let reason=null;
                const store=tx.objectStore(STORE),request=store.get(value.operationId);
                const order={'staged':0,'verified':1,'needs-reconcile':1,'committed':2};
                request.onsuccess=()=>{
                    let current;
                    try{current=request.result?publicHeader(request.result):null;}catch(_){reason='Invalid journal entry';tx.abort();return;}
                    if(!current){reason='Journal entry missing';tx.abort();return;}
                    if(current.phase==='committed' || (value.phase!=='needs-reconcile' && order[value.phase]<order[current.phase])){
                        reason='Journal transition not permitted';tx.abort();return;
                    }
                    store.put(value);
                };
                request.onerror=()=>{reason='C02 journal read failed';tx.abort();};
                tx.oncomplete=()=>{
                    // Confirm in a *separate* read transaction, not the in-memory
                    // object sent to IDB. A lost or altered write cannot pass.
                    this.get(value.operationId).then(saved=>{
                        if(!saved || JSON.stringify(saved)!==JSON.stringify(value))reject(new Error('C02 journal update readback failed'));
                        else resolve(saved);
                    },reject);
                };
                tx.onerror=()=>reject(new Error(reason||'C02 journal write failed'));
                tx.onabort=()=>reject(new Error(reason||'C02 journal write aborted'));
            });
        },
        async get(id){const db=await database();return new Promise((resolve,reject)=>{
            const tx=db.transaction(STORE,'readonly'),r=tx.objectStore(STORE).get(id);let value,invalid=false;
            r.onsuccess=()=>{try{value=r.result?publicHeader(r.result):null;}catch{invalid=true;}};
            r.onerror=()=>{invalid=true;};
            tx.oncomplete=()=>invalid?reject(new Error('Invalid persisted C02 journal')):resolve(value);
            tx.onerror=()=>reject(new Error('C02 journal read failed'));
            tx.onabort=()=>reject(new Error('C02 journal read aborted'));
        });},
        async list(){const db=await database();return new Promise((resolve,reject)=>{
            const tx=db.transaction(STORE,'readonly'),r=tx.objectStore(STORE).getAll();let values,invalid=false;
            r.onsuccess=()=>{try{if(r.result.length>MAX_RECORDS)throw Error('limit');values=r.result.map(publicHeader);}catch{invalid=true;}};
            r.onerror=()=>{invalid=true;};
            tx.oncomplete=()=>invalid?reject(new Error('Invalid persisted C02 journal list')):resolve(values);
            tx.onerror=()=>reject(new Error('C02 journal list failed'));
            tx.onabort=()=>reject(new Error('C02 journal list aborted'));
        });},
    };
}
/** An explicit test-only store. It is NEVER used for browser writes. */
export function createTestOperationJournal(initial=[]){
    const values=new Map(initial.map(h=>{const v=publicHeader(h);return [v.operationId,v];}));
    return {
        async create(h){const v=publicHeader(h);if(values.has(v.operationId))throw new Error('Operation already exists');values.set(v.operationId,v);return structuredClone(v);},
        async put(h){const v=publicHeader(h);if(!values.has(v.operationId))throw new Error('Journal entry missing');values.set(v.operationId,v);return structuredClone(v);},
        async get(id){return values.has(id)?structuredClone(values.get(id)):null;},
        async list(){return [...values.values()].map(v=>structuredClone(v));},
    };
}

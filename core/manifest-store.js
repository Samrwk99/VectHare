/**
 * IndexedDB storage for large chat manifests. The extension settings contain
 * only a small commit reference; every patch writes changed entries only.
 * A single IndexedDB readwrite transaction commits entries and the revision
 * together. The remote Similharity journal remains authoritative for Qdrant.
 */
const DATABASE='vecthare-manifests-v1';
const VERSION=1;
let databasePromise;
export function hasManifestStorage(){return typeof globalThis.indexedDB?.open==='function';}
function openDatabase(){
    if(!hasManifestStorage())return Promise.reject(new Error('IndexedDB is unavailable'));
    if(!databasePromise){
        databasePromise=new Promise((resolve,reject)=>{
            const req=globalThis.indexedDB.open(DATABASE,VERSION);
            req.onupgradeneeded=()=>{
                const db=req.result;
                if(!db.objectStoreNames.contains('headers'))db.createObjectStore('headers',{keyPath:'key'});
                if(!db.objectStoreNames.contains('entries'))db.createObjectStore('entries',{keyPath:['key','id']});
            };
            req.onsuccess=()=>resolve(req.result);
            req.onerror=()=>reject(req.error||new Error('Manifest database could not open'));
        }).catch(error=>{databasePromise=null;throw error;});
    }
    return databasePromise;
}
function transactionResult(db,stores,mode,work){
    return new Promise((resolve,reject)=>{
        const tx=db.transaction(stores,mode);
        let result;
        tx.oncomplete=()=>resolve(result);
        tx.onerror=()=>reject(tx.error||new Error('Manifest transaction failed'));
        tx.onabort=()=>reject(tx.error||new Error('Manifest transaction aborted'));
        try{result=work(tx);}catch(error){try{tx.abort();}catch{}reject(error);}
    });
}
export async function readManifest(key){
    const db=await openDatabase();
    return new Promise((resolve,reject)=>{
        const tx=db.transaction(['headers','entries'],'readonly');
        let header,rows;
        tx.objectStore('headers').get(key).onsuccess=e=>{header=e.target.result;};
        const range=globalThis.IDBKeyRange.bound([key,''],[key,'\uffff']);
        tx.objectStore('entries').getAll(range).onsuccess=e=>{rows=e.target.result;};
        tx.oncomplete=()=>resolve(header?{...header.manifest,entries:(rows||[]).map(({key:_,id:__,...item})=>item)}:null);
        tx.onerror=()=>reject(tx.error||new Error('Manifest read failed'));
        tx.onabort=()=>reject(tx.error||new Error('Manifest read aborted'));
    });
}
export async function replaceManifest(key,manifest){
    const db=await openDatabase();
    const range=globalThis.IDBKeyRange.bound([key,''],[key,'\uffff']);
    await transactionResult(db,['headers','entries'],'readwrite',tx=>{
        const entries=tx.objectStore('entries');
        entries.delete(range);
        for(const item of manifest.entries||[])entries.put({...item,key,id:String(item.hash)});
        const {entries:_,...header}=manifest;
        tx.objectStore('headers').put({key,manifest:header});
    });
}
export async function patchManifest(key,{chatUUID,expectedRevision,revision,updatedAt,upserts=[],removedHashes=[]}){
    const db=await openDatabase();
    return new Promise((resolve,reject)=>{
        const tx=db.transaction(['headers','entries'],'readwrite');
        const headers=tx.objectStore('headers');
        const entries=tx.objectStore('entries');
        const req=headers.get(key);
        req.onsuccess=()=>{
            const prior=req.result?.manifest;
            if(!prior || prior.chatUUID!==chatUUID || (prior.revision??0)!==expectedRevision || revision!==expectedRevision+1){
                tx.abort();return;
            }
            for(const hash of removedHashes)entries.delete([key,String(hash)]);
            for(const item of upserts)entries.put({...item,key,id:String(item.hash)});
            headers.put({key,manifest:{...prior,revision,updatedAt}});
        };
        tx.oncomplete=()=>resolve(true);
        tx.onerror=()=>reject(tx.error||new Error('Manifest patch failed'));
        tx.onabort=()=>reject(new Error('Manifest local revision conflict or aborted storage operation'));
    });
}

/** Erase full text and provenance after independently verified vector purge.
 * A failed local cleanup aborts metadata retirement so it is recoverable. */
export async function deleteManifest(key){
    const db=await openDatabase();
    const range=globalThis.IDBKeyRange.bound([key,''],[key,'\uffff']);
    await transactionResult(db,['headers','entries'],'readwrite',tx=>{
        tx.objectStore('entries').delete(range);
        tx.objectStore('headers').delete(key);
    });
}

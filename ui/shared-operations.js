/**
 * P2 #60: authoritative per-user shared operations for all tabs/browsers on
 * one SillyTavern deployment. The server, not the current chat or the browser,
 * owns the queue, progress and cancellation requests.
 * Never serialize raw chat text, vectors, API keys or credentials here.
 */
import { getRequestHeaders } from '../../../../../script.js';
import { getActivitySnapshot } from './activity-status.js';
const ENDPOINT='/api/plugins/similharity/vecthare/operations';
const owned=new Map();
const observers=new Set();
let current=[], timer=null, updating=false;
async function api(path,payload=null){
    const response=await fetch(`${ENDPOINT}/${path}`,{method:'POST',headers:getRequestHeaders(),body:JSON.stringify(payload||{})});
    const data=await response.json().catch(()=>({error:'Invalid operation response'}));
    if(!response.ok)throw new Error(data.error||`Operation coordinator HTTP ${response.status}`);
    return data;
}
export async function fetchSharedOperations(){
    const response=await fetch(ENDPOINT,{headers:getRequestHeaders()});
    const data=await response.json().catch(()=>({error:'Invalid operation list'}));
    if(!response.ok)throw new Error(data.error||`Operation list HTTP ${response.status}`);
    if(!Array.isArray(data.operations))throw new Error('Malformed server operation list');
    return data.operations;
}
export function getSharedOperations(){return current.map(op=>({...op}));}
export function subscribeSharedOperations(callback){
    observers.add(callback);callback(getSharedOperations());
    return ()=>observers.delete(callback);
}
async function refresh(){
    if(updating)return;
    updating=true;
    try{
        current=await fetchSharedOperations();
        for(const observer of [...observers]){try{observer(getSharedOperations());}catch(e){console.warn('[VectHare] Shared status listener:',e);}}
    }catch(error){
        // Never turn a failed read into a claim that another operation ended.
        console.warn('[VectHare] Shared operation status unavailable:',error.message);
    }finally{updating=false;}
}
export function initializeSharedOperations(){
    if(timer)return;
    void refresh();
    timer=setInterval(()=>{void refresh();},2500);
}
export async function recoverSharedOperation(id,confirmation){
    const result=await api('recover',{id,confirmation});
    await refresh();return result;
}
export async function cancelSharedOperation(id){
    const result=await api('cancel',{id});
    await refresh();return result;
}
function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
/** Await an authoritative turn BEFORE any collection mutation begins. */
export async function acquireSharedOperation(label,{activityId=null,category='write',resourceKey='',queue=true}={}){
    const claim=await api('start',{label,category,resourceKey,queue});
    if(!claim?.id||!claim?.token)throw new Error('Operation coordinator did not acknowledge a lease');
    const handle={...claim,activityId,closed:false,lastHeartbeat:0};
    owned.set(claim.id,handle);
    try{
        while(true){
            const state=await api('status',{id:handle.id,token:handle.token});
            if(state.phase==='running'){handle.phase='running';break;}
            if(state.phase!=='queued')throw new Error(`Shared operation ${state.phase}; no writes performed`);
            await sleep(1000);
        }
        await heartbeatSharedOperation(handle);
        await refresh();
        return handle;
    }catch(error){owned.delete(claim.id);throw error;}
}
export async function heartbeatSharedOperation(handle){
    if(!handle||handle.closed)throw new Error('Shared operation lease is not active');
    const progress=getActivitySnapshot().operations.find(op=>op.id===handle.activityId);
    const state=await api('heartbeat',{id:handle.id,token:handle.token,
        completed:progress?.completed??0,total:progress?.total??0,
        detail:progress?.detail||'',unit:progress?.unit||'items'});
    handle.lastHeartbeat=Date.now();
    if(state.cancelRequested)throw new SharedOperationStoppedError();
    if(state.phase!=='running')throw new Error('Shared operation is no longer the active writer');
    return state;
}
export class SharedOperationStoppedError extends Error {
    constructor(){super('Operation cancelled from Live Status; existing verified vectors retained');this.name='SharedOperationStoppedError';}
}
/** Every write-oriented checkpoint revalidates the server lease and cancellation. */
export async function checkpointSharedOperation(handle){
    if(!handle)return;
    await heartbeatSharedOperation(handle);
}
export async function finishSharedOperation(handle,phase='completed',detail=''){
    if(!handle||handle.closed)return;
    // HTTP response completion can precede the server's on-finish marker fsync.
    // Retry a bounded number of times; never free the lease on our own.
    for(let attempt=0;attempt<12;attempt++){
        try{
            await api('complete',{id:handle.id,token:handle.token,phase,detail});
            handle.closed=true;owned.delete(handle.id);void refresh();return;
        }catch(error){
            if(!/still in flight/i.test(error.message)||attempt===11)throw error;
            await sleep(150);
        }
    }
}
/** Attach an authenticated, same-user lease only to same-origin VectHare
 * plugin requests. No token is sent to external embedding providers. */
export function withSharedWriteHeaders(headers){
    const h=new Headers(headers);
    const active=[...owned.values()].find(job=>job.phase==='running'&&!job.closed);
    if(active){h.set('x-vecthare-operation-id',active.id);h.set('x-vecthare-operation-token',active.token);}
    return h;
}
export function sharedOperationForActivity(activityId){
    return [...owned.values()].find(op=>op.activityId===activityId)||null;
}

/** Native SillyTavern /api/vector writes bypass the Similharity plugin's
 * request middleware. Hold a verified shared lease across the ENTIRE native
 * write and sidecar update, rather than assuming custom HTTP headers are
 * enforced by the host. Uses an existing writer lease when the caller is a
 * long-running Sync/Repair/Content Vectorizer job.
 */
export async function runExclusiveNativeMutation(label,resourceKey,work){
    let lease=[...owned.values()].find(job=>job.phase==='running'&&!job.closed);
    let ownLease=false;
    if(!lease){
        lease=await acquireSharedOperation(label,{category:'native-write',resourceKey,queue:false});
        ownLease=true;
    }
    let outcome='failed', marker=null;
    try{
        await checkpointSharedOperation(lease);
        // Durable server marker prevents an interrupted browser from silently
        // releasing a native request while the host is still handling it.
        const reservation=await api('native-begin',{id:lease.id,token:lease.token});
        marker=reservation.markerId;
        const result=await work();
        outcome='completed';
        return result;
    }finally{
        if(marker && outcome==='completed'){
            // A resolved work() is the only client-side evidence that the
            // server finished. A rejected fetch may mean it DISCONNECTED
            // while native ST is still writing: retain the durable marker.
            await api('native-end',{id:lease.id,token:lease.token,markerId:marker});
        }
        if(ownLease){
            if(marker && outcome!=='completed'){
                console.error('[VectHare] Native write outcome uncertain; shared lease and in-flight marker retained for explicit recovery');
            }else{
                await finishSharedOperation(lease,outcome);
            }
        }
    }
}

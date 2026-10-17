/**
 * VectHare non-secret settings recovery mirror (#53).
 * The ST settings object remains the live settings owner. A revisioned server
 * snapshot provides independently acknowledged recovery evidence; conflicting
 * copies are never silently merged/overwritten. Secret fields remain in ST's
 * credential stores and are NOT copied to this recovery sidecar.
 */
import { extension_settings } from '../../../../extensions.js';
import {saveSettings as hostSaveSettings, getRequestHeaders} from '../../../../../script.js';

const SECRET=/(?:api[_-]?key|password|credential|secret|authorization|access[_-]?token|auth[_-]?token|private[_-]?key|^jwt$|^bearer$|^session[-_]?token$|^refresh[-_]?token$)/i;
const OMIT=new Set(['__settingsMirrorRevision','__settingsMirrorStatus']);
const URL_SECRET=/[?&](?:api[_-]?key|apikey|token|jwt|bearer|secret|password|auth|authorization|signature|sig|x-amz-(?:signature|credential|security-token|algorithm)|x-goog-(?:signature|credential|algorithm))=/i;
/** Snapshot immutable/retrieval/user UI settings, not credentials or large manifests. */
export function recoverySnapshot(settings){
    function scrub(value){
        if(Array.isArray(value))return value.map(scrub);
        if(value && typeof value==='object'){
            const result={};for(const [key,child] of Object.entries(value)){
                if(SECRET.test(key)||OMIT.has(key) || ['lastUsed','queryCount','profileSaveError'].includes(key))continue;
                if(key==='chatChunkManifest' && child && typeof child==='object'){
                    const {entries,...header}=child;
                    result[key]=scrub({...header,...(entries?{entryCount:entries.length}:{} )});
                }else result[key]=scrub(child);
            }return result;
        }
        if(typeof value==='string' && /^https?:\/\//i.test(value) && (URL_SECRET.test(value) || (()=>{try{const url=new URL(value);return !!url.username||!!url.password;}catch{return true;}})()))
            return '[redacted-credential-bearing-endpoint]';
        return value;
    }
    // Normalize to the exact JSON transmitted to the server. Optional undefined
    // keys and non-JSON UI values must not create phantom read-back conflicts.
    return JSON.parse(JSON.stringify(scrub(settings||{})));
}
// Compare settings by value, not property insertion order. SillyTavern can
// deserialize object keys in a different order without changing any setting.
function equal(a,b){
    if(Object.is(a,b))return true;
    if(Array.isArray(a)||Array.isArray(b))return Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((v,i)=>equal(v,b[i]));
    if(plain(a)&&plain(b)){
        const aa=Object.keys(a),bb=Object.keys(b);
        return aa.length===bb.length&&aa.every(key=>Object.hasOwn(b,key)&&equal(a[key],b[key]));
    }
    return false;
}
function plain(value){return value && typeof value==='object' && !Array.isArray(value);}
// New default keys in an extension upgrade should not be mistaken for lost
// committed settings. But ANY previously committed setting that differs or
// has disappeared is an actual recovery conflict.
function matchesCommitted(committed,local){
    if(plain(committed)&&plain(local))return Object.entries(committed).every(([key,value])=>
        Object.prototype.hasOwnProperty.call(local,key) && matchesCommitted(value,local[key]));
    return equal(committed,local);
}
async function call(route,body){
    const response=await fetch(`/api/plugins/similharity/settings/revision/${route}`,{
        method:'POST',headers:getRequestHeaders(),body:JSON.stringify(body||{})});
    let data;try{data=await response.json();}catch{throw new Error(`Settings mirror ${route} malformed response`);}
    if(!response.ok || !data.success)throw new Error(`Settings mirror ${route} HTTP ${response.status}: ${data.error||'unavailable'}`);
    return data;
}
let knownRevision=null,initializing=null,pending=null,timer=null;
let status={phase:'uninitialized',revision:null,error:null};
export function getSettingsDurabilityStatus(){return {...status};}
function update(phase,error=null){
    status={phase,revision:knownRevision,error:error?String(error.message||error):null};
    if(typeof document!=='undefined'){
        const node=document.getElementById('vecthare_settings_integrity_status');
        if(node)node.textContent=`Settings persistence: ${phase}${error?` — ${status.error}`:''}`;
    }
}
/** No write or restore is permitted when host/server settings disagree. */
export async function initialiseSettingsDurability(){
    if(initializing)return initializing;
    initializing=(async()=>{
        try{
            const saved=await call('get');
            const local=recoverySnapshot(extension_settings.vecthare);
            if(saved.revision && !matchesCommitted(saved.snapshot,local)){
                knownRevision=saved.revision;
                update('conflict',new Error('Local and committed recovery settings differ; inspect both before writing. Automatic overwrite is forbidden.'));
                return status;
            }
            knownRevision=saved.revision;
            update('ready');
            return status;
        }catch(error){update('unavailable',error);throw error;}
    })().catch(error=>{initializing=null;throw error;});
    return initializing;
}
/**
 * Explicitly commit the current nonsecret settings with CAS and readback.
 * Mirror acknowledgement is separate from ST's host save, whose async handler
 * may swallow persistence errors. The two copies are checked on restart.
 */
export async function flushVectHareSettings(){
    if(pending)return pending.then(()=>flushVectHareSettings());
    pending=(async()=>{
        await initialiseSettingsDurability();
        if(status.phase==='conflict')throw new Error('Settings recovery conflict: do not overwrite the other copy');
        update('saving');
        try{
            const snapshot=recoverySnapshot(extension_settings.vecthare);
            const saved=await call('get');
            if(saved.revision!==knownRevision){
                // An HTTP acknowledgement can be lost AFTER the plugin's
                // fsynced commit. Recognise that exact revision on readback.
                if(saved.revision===knownRevision+1 && equal(saved.snapshot,snapshot))
                    knownRevision=saved.revision;
                else throw new Error('Another session changed settings; stale write blocked');
            }
            if(!equal(saved.snapshot,snapshot)){
                const ack=await call('commit',{expectedRevision:knownRevision,snapshot});
                const verify=await call('get');
                if(verify.revision!==ack.revision||verify.checksum!==ack.checksum||!equal(verify.snapshot,snapshot))
                    throw new Error('Settings recovery snapshot acknowledgement/read-back mismatch');
                knownRevision=ack.revision;
            }
            // Commit the recovery copy BEFORE attempting an ST-wide host
            // save, so a rejected stale revision never makes a stale host POST.
            // The ST save function may swallow errors: completion is NOT proof
            // that settings.json was durably persisted by the host.
            await hostSaveSettings();
            update('recovery-copy-confirmed');return status;
        }catch(error){update('failed',error);throw error;}
    })();
    try{return await pending;}finally{pending=null;}
}
/** Every extension settings save enters this queue, rather than relying on a
 * host-only debounced write. Coalescing avoids flooding the plugin.
 */
export function saveVectHareSettingsDebounced(){
    // Do NOT schedule a host save before the authoritative revision check.
    // Another tab's changes must not be overwritten by a stale local copy.
    if(status.phase==='conflict'){
        update('conflict',new Error('Recovery-copy conflict; inspect the settings copies before saving'));
        return;
    }
    update('pending');
    if(timer)clearTimeout(timer);
    timer=setTimeout(()=>{
        timer=null;
        flushVectHareSettings().catch(error=>{
            console.warn('[VectHare] Settings persistence not confirmed:',error.message);
            if(typeof toastr!=='undefined' && typeof toastr.warning==='function')toastr.warning('VectHare settings not confirmed saved. Check Settings persistence status before vectorising.','VectHare',{timeOut:6000});
        });
    },700);
}

/** Read-only conflict evidence for deliberate recovery. Never merges or changes
 * collection authority; removes credentials and bulky manifest text.
 */
export async function inspectSettingsRecovery(){
    const saved=await call('get');
    const previous=await call('previous');
    const local=recoverySnapshot(extension_settings.vecthare);
    const paths=[];
    function walk(a,b,prefix=''){
        if(equal(a,b))return;
        if(plain(a)&&plain(b)){
            for(const key of new Set([...Object.keys(a),...Object.keys(b)])){
                walk(a[key],b[key],prefix?`${prefix}.${key}`:key);
            }
        }else paths.push(prefix||'(root)');
    }
    walk(saved.snapshot||{},local);
    return {revision:saved.revision,previousRevision:previous.revision,phase:status.phase,differingPaths:paths,
        committed:saved.snapshot,previousCommitted:previous.snapshot,local};
}

import { withSharedWriteHeaders } from '../ui/shared-operations.js';
/**
 * Durable, non-secret collection profiles and chat-chunk manifests.
 * Never infer an older collection's embedding model from today's defaults.
 */
import { extension_settings, getContext } from '../../../../extensions.js';
import { saveSettingsDebounced, getRequestHeaders } from '../../../../../script.js';
import { getProviderSpecificParams } from '../backends/provider-params.js';
import { getModelField } from './providers.js';
import { getCollectionMeta, setCollectionMeta } from './collection-metadata.js';
import { getBackend } from '../backends/backend-manager.js';
import { parseRegistryKey } from './collection-ids.js';
import { getChatUUID } from './collection-ids.js';
import { bindChatCollection, getChatBinding } from './collection-ownership.js';
import { captureCleaningSnapshot } from './text-cleaning.js';
import { CHUNK_IDENTITY_VERSION } from './chunk-identity.js';
import { hasManifestStorage, readManifest, replaceManifest, patchManifest, deleteManifest } from './manifest-store.js';
import { flushVectHareSettings } from './settings-durability.js';

const VERSION = 1;
const RECIPE_VERSION = 2;
const CHUNKING_ALGORITHM_VERSION = 4;
const IDENTITY_PROBE_TEXT='VectHare stable embedding identity probe, version 1. This text is never a chat memory.';
const PROBE_TTL=60000;
const embeddingProbeCache=new Map();
const COPY_FIELDS = ['embedding_max_tokens','alt_endpoint_url','use_alt_endpoint','custom_endpoint_mode','chunking_strategy','conversation_turn_order','batch_size','chunk_size','chunk_overlap','keyword_extraction_level','cleaning_preset','text_cleaning_enabled','cleaning_rules','cleaning_snapshot','substitution_policy','source','vector_backend','qdrant_multitenancy'];
/** Prevent exporting/storing credentials embedded in endpoint URLs.
 * Do not delete query params from a working exact endpoint: reject it and
 * require a credential-free endpoint plus separate API key instead.
 */
export function assertPersistableEndpoint(value) {
    if(!value)return;
    let endpoint;
    try {endpoint=new URL(value);}catch {throw new Error('Embedding endpoint URL is invalid');}
    if(endpoint.username || endpoint.password)
        throw new Error('Embedding endpoint URL contains credentials. Use a separate API key setting instead.');
    const sensitive=/^(api[-_]?key|apikey|access[-_]?token|auth|authorization|token|key|password|secret|signature|sig|credential|client[-_]?secret|jwt|bearer|session[-_]?token|id[-_]?token|refresh[-_]?token|x-amz-(?:signature|credential|security-token|algorithm)|x-goog-(?:signature|credential|algorithm))$/i;
    for(const name of endpoint.searchParams.keys()) if(sensitive.test(name))
        throw new Error(`Embedding endpoint URL contains a sensitive query parameter (${name}). Move credentials to the API key field before vectorising.`);
}

function copySafe(obj) {
    const result = {};
    for (const key of COPY_FIELDS) if (obj?.[key] !== undefined) result[key] = structuredClone(obj[key]);
    return result;
}
const NATIVE_PROFILE_PREFIX='vecthare:native-profile:v1:';
// Full manifests are held only in memory during an operation. Never put large
// chunk arrays into SillyTavern extension settings on the indexed-store path.
const manifestCache=new Map();
const manifestLocks=new Map();
function manifestHeader(manifest){
    return {schemaVersion:VERSION,storage:'indexeddb-v1',chatUUID:manifest.chatUUID,
        revision:manifest.revision??0,updatedAt:manifest.updatedAt,entryCount:manifest.entryCount??manifest.entries?.length??0};
}
function hasInlineEntries(manifest){return manifest?.schemaVersion===VERSION && Array.isArray(manifest.entries);}
function cacheManifest(key,manifest){
    const snapshot=structuredClone(manifest);
    manifestCache.set(key,{header:{...snapshot,entries:undefined},entries:new Map(snapshot.entries.map(e=>[String(e.hash),e]))});
}
function cachedManifest(key){
    const item=manifestCache.get(key);
    return item?{...item.header,entries:[...item.entries.values()].map(e=>structuredClone(e))}:null;
}
function withManifestLock(key,work){
    const previous=manifestLocks.get(key)||Promise.resolve();
    const current=previous.catch(()=>{}).then(work);
    manifestLocks.set(key,current);
    current.finally(()=>{if(manifestLocks.get(key)===current)manifestLocks.delete(key);}).catch(()=>{});
    return current;
}
function storeCompactHeader(key,manifest){
    setCollectionMeta(key,{chatChunkManifest:manifestHeader(manifest)});
}
/** Hydrate before any Sync, Repair, Content Vectorizer, or export read.
 * A missing/failed backing store never turns a collection into an empty one. */
export async function hydrateChatChunkManifest(key,{forceRemote=false}={}){
    const saved=getCollectionMeta(key)?.chatChunkManifest;
    if(!saved){manifestCache.delete(key);return null;}
    if(!forceRemote && manifestCache.has(key))return cachedManifest(key);
    let manifest=null;
    if(!forceRemote && hasInlineEntries(saved))manifest=structuredClone(saved);
    if(!manifest && !forceRemote && hasManifestStorage()){
        try{manifest=await readManifest(key);}
        catch(error){console.warn('[VectHare] IndexedDB manifest read failed:',error.message);}
    }
    if(!key.startsWith('standard:')){
        // A remote manifest is the authoritative durable revision for Qdrant.
        const response=await fetch('/api/plugins/similharity/collection/profile/get',{
            method:'POST',headers:withSharedWriteHeaders(getRequestHeaders()),body:JSON.stringify({key}),
        });
        if(!response.ok)throw new Error(`Cannot validate authoritative manifest (HTTP ${response.status})`);
        const remote=(await response.json()).manifest;
        if(!hasInlineEntries(remote))throw new Error('Remote manifest missing or incomplete; writes are blocked');
        if(manifest && manifest.chatUUID!==remote.chatUUID)
            throw new Error('Local and remote manifests belong to different chats; writes blocked');
        manifest=remote;
    }
    if(!hasInlineEntries(manifest))throw new Error('Manifest data unavailable; refusing to infer an empty collection');
    cacheManifest(key,manifest);
    if(hasManifestStorage()){
        try{await replaceManifest(key,manifest);}
        catch(error){
            // Qdrant has a verified authoritative server journal; native
            // Standard cannot discard its only durable local manifest.
            if(key.startsWith('standard:'))throw error;
            console.warn('[VectHare] IndexedDB backup unavailable, remote sidecar remains authoritative:',error.message);
        }
        storeCompactHeader(key,manifest);
    } else if(!hasInlineEntries(saved)){
        // Standard must never depend solely on a missing IndexedDB database.
        if(key.startsWith('standard:'))throw new Error('Local manifest storage missing; Standard collection must be repaired');
        storeCompactHeader(key,manifest);
    }
    return cachedManifest(key);
}

/** Native Standard may not have the Similharity sidecar. Keep a synchronous
 * non-text backup of its identity and manifest references for crash recovery.
 * The original vector text stays in the database/extension settings, not here.
 */
function recoverNativeProfile(key) {
    if(!key?.startsWith('standard:'))return;
    try{
        const raw=globalThis.localStorage?.getItem(NATIVE_PROFILE_PREFIX+encodeURIComponent(key));
        const data=raw?JSON.parse(raw):null;
        if(data?.key!==key || data?.profile?.schemaVersion!==VERSION)return;
        const meta=getCollectionMeta(key)||{};
        if(!meta.vectorizationProfile || !meta.chatChunkManifest){
            setCollectionMeta(key,{
                ...(!meta.vectorizationProfile?{vectorizationProfile:data.profile}:{}),
                ...(!meta.chatChunkManifest && data.manifest?.schemaVersion===VERSION?{chatChunkManifest:data.manifest}:{})
            });
        }
    }catch(error){console.warn('[VectHare] Could not restore native profile backup:',error.message);}
}
function saveNativeProfile(key){
    if(!key?.startsWith('standard:'))return;
    const profile=getCollectionMeta(key)?.vectorizationProfile;
    if(!profile || profile.schemaVersion!==VERSION)return;
    const manifest=getCollectionMeta(key)?.chatChunkManifest;
    const safeManifest=manifest?.schemaVersion===VERSION ? {
        schemaVersion:VERSION,chatUUID:manifest.chatUUID,updatedAt:manifest.updatedAt,
        ...(hasManifestStorage()?{storage:'indexeddb-v1',entryCount:manifest.entryCount??manifest.entries?.length??0}:{entries:(manifest.entries||[]).map(e=>({hash:e.hash,messageIds:e.messageIds||[],messageHashes:e.messageHashes||[]}))})
    }:null;
    try {globalThis.localStorage?.setItem(NATIVE_PROFILE_PREFIX+encodeURIComponent(key),JSON.stringify({key,profile,manifest:safeManifest}));}
    catch(error){console.warn('[VectHare] Native profile immediate backup unavailable:',error.message);}
}
const RETRIEVAL_PREFERENCE_FIELDS=[
    'enabled','autoSync','scope','displayName','description','tags','color',
    'alwaysActive','lockMode','forceMode','exclusiveWhenActive','exclusiveScope',
    'triggers','triggerMatchMode','triggerCaseSensitive','triggerScanDepth',
    'conditions','temporalDecay','groups','context','xmlTag','position','depth',
    'collectionType','contentType',
];
export function collectionPreferenceSnapshot(meta){
    const result=structuredClone(meta?.collectionPreferences||{});
    for(const key of RETRIEVAL_PREFERENCE_FIELDS){
        if(meta?.[key]!==undefined)result[key]=structuredClone(meta[key]);
    }
    return result;
}
/** The original recipe is never overwritten by editing UI preferences or drafts. */
export function getCollectionConfiguration(key) {
    const meta=getCollectionMeta(key)||{};
    return {
        key,
        originalRecipe:getCollectionProfile(key)?.recipe||null,
        originalProfile:getCollectionProfile(key),
        // Saved retrieval preferences live in the SAME collection metadata
        // record; `collectionPreferences` alone was never populated by most
        // activation/decay/prompt editors. Resolve actual effective fields.
        preferences:collectionPreferenceSnapshot(meta),
        lastUsedDraft:structuredClone(meta.lastUsedVectorizationDraft||{}),
        revision:meta.configurationRevision||0,
        persistenceStatus:meta.profileSaveStatus||'legacy',
    };
}
export function saveCollectionDraft(key, draft) {
    if(!key || !draft || typeof draft!=='object' || Array.isArray(draft))throw new Error('Collection and settings draft required');
    // A draft never changes the recipe used for existing embeddings.
    const allowed=['source','model','chunking_strategy','conversation_turn_order','chunk_size','chunk_overlap','batch_size','cleaning_preset','embedding_max_tokens','keyword_extraction_level','keyword_weight','custom_stopwords','text_cleaning_enabled','cleaning_rules','cleaning_snapshot','substitution_policy'];
    const copy={};for(const f of allowed)if(draft[f]!==undefined)copy[f]=structuredClone(draft[f]);
    setCollectionMeta(key,{lastUsedVectorizationDraft:copy,configurationRevision:(getCollectionMeta(key)?.configurationRevision||0)+1});
    return copy;
}
export function describeRecipeEdit(key, proposed) {
    const profile=getCollectionProfile(key);
    if(!profile?.recipe)return {severity:'unverified',message:'Original settings are incomplete. Keep the collection read-only or safely re-vectorize.'};
    const original=profile.recipe;
    const fields=['chunking_strategy','conversation_turn_order','chunk_size','chunk_overlap','batch_size','keyword_extraction_level'];
    const differences=fields.filter(f=>proposed[f]!==undefined && original.settings[f]!==proposed[f]);
    if(proposed.cleaning_preset!==undefined && original.cleaning?.selectedPreset!==proposed.cleaning_preset)differences.push('cleaning_preset');
    if(proposed.source!==undefined && profile.embedding.provider!==proposed.source)differences.push('source');
    if(proposed.model!==undefined && profile.embedding.modelId!==proposed.model)differences.push('embedding_model');
    return differences.length?{severity:'revectorize',differences,message:'Changing the embedding model or original text/chunk settings requires a staged replacement. The old collection stays unchanged.'}:{severity:'safe',differences:[],message:'No embedding-recipe changes detected.'};
}
export function ensureCompleteRecipe(profile) {
    if(!profile?.recipe || profile.recipe.version!==RECIPE_VERSION ||
       !profile.recipe.cleaning || !profile.recipe.settings ||
       profile.recipe.algorithmVersions?.chunkIdentity!==CHUNK_IDENTITY_VERSION ||
       profile.recipe.algorithmVersions?.chunking!==CHUNKING_ALGORITHM_VERSION ||
       profile.recipe.algorithmVersions?.cleaning!==1) {
        throw new Error('This collection predates complete vectorization recipes. Its original cleaning/chunk settings cannot be proven; keep it read-only or safely re-vectorize.');
    }
    return profile.recipe;
}
export function getCollectionProfile(key) {
    let profile=getCollectionMeta(key)?.vectorizationProfile;
    if(!profile){recoverNativeProfile(key);profile=getCollectionMeta(key)?.vectorizationProfile;}
    return profile?.schemaVersion === VERSION ? structuredClone(profile) : null;
}
export function getChatChunkManifest(key) {
    // Purged/unregistered collections must never resurrect stale cached text.
    if(!getCollectionMeta(key)?.chatChunkManifest){
        manifestCache.delete(key);
        recoverNativeProfile(key);
        if(!getCollectionMeta(key)?.chatChunkManifest)return null;
    }
    const fromCache=cachedManifest(key);
    if(fromCache)return fromCache;
    let manifest=getCollectionMeta(key)?.chatChunkManifest;
    if(!manifest){recoverNativeProfile(key);manifest=getCollectionMeta(key)?.chatChunkManifest;}
    return hasInlineEntries(manifest) ? structuredClone(manifest) : null;
}
async function writeRemoteProfile(key) {
    const profile=getCollectionProfile(key);
    if(!profile)return;
    saveNativeProfile(key);
    try {
        const response=await fetch('/api/plugins/similharity/collection/profile/set',{
            method:'POST',headers:withSharedWriteHeaders(getRequestHeaders()),body:JSON.stringify({key,profile,manifest:getChatChunkManifest(key)}),
        });
        if(!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch(error) {
        // Qdrant/multitenancy MUST retain a durable sidecar. Standard native
        // Vectra may lack a plugin; its ST extension settings still persist.
        if(!key.startsWith('standard:'))throw new Error(`Could not persist collection profile alongside vectors: ${error.message}`);
        console.warn('[VectHare] Plugin sidecar unavailable; profile remains in ST extension settings:',error.message);
    }
}
async function loadRemoteProfile(key) {
    try {
        const response=await fetch('/api/plugins/similharity/collection/profile/get',{
            method:'POST',headers:withSharedWriteHeaders(getRequestHeaders()),body:JSON.stringify({key}),
        });
        if(!response.ok) return null;
        const data=await response.json();
        if(data.profile?.schemaVersion!==VERSION)return null;
        if(hasInlineEntries(data.manifest)){
            cacheManifest(key,data.manifest);
            if(hasManifestStorage()){
                try{await replaceManifest(key,data.manifest);}
                catch(error){
                    if(key.startsWith('standard:'))throw error;
                    console.warn('[VectHare] Remote profile loaded but local manifest mirror could not persist:',error.message);
                }
            }
        }
        setCollectionMeta(key,{vectorizationProfile:data.profile,chatChunkManifest:data.manifest?(hasManifestStorage()?manifestHeader(data.manifest):data.manifest):null});
        return data.profile;
    }catch{return null;}
}
export async function reconcileCollectionProfile(key) {
    const profile=getCollectionProfile(key);
    ensureCompleteRecipe(profile);
    try {
        if(!manifestCache.has(key) && getCollectionMeta(key)?.chatChunkManifest)
            await hydrateChatChunkManifest(key);
        const needsManifestRecovery=!!getCollectionMeta(key)?.manifestNeedsReconciliation;
        let manifestReconciled=!needsManifestRecovery;
        // A timed-out patch can have committed on the server even when the
        // client received no acknowledgement. Read authoritative revision
        // before attempting a whole-profile repair (never roll it back).
        if(getChatChunkManifest(key)){
            const local=getChatChunkManifest(key);
            let remote=null;
            const res=await fetch('/api/plugins/similharity/collection/profile/get',{
                method:'POST',headers:withSharedWriteHeaders(getRequestHeaders()),body:JSON.stringify({key}),
            }).catch(error=>{
                if(!key.startsWith('standard:'))throw error;
                return null;
            });
            if(res?.ok)remote=(await res.json()).manifest;
            else if(!key.startsWith('standard:'))
                throw new Error(`Profile recovery read failed: HTTP ${res?.status??'network unavailable'}`);
            if(hasInlineEntries(remote)){
                if(remote.chatUUID!==local.chatUUID)throw new Error('Manifest recovery chat identity mismatch');
                if((remote.revision??0)>(local.revision??0)){
                    cacheManifest(key,remote);
                    if(hasManifestStorage())await replaceManifest(key,remote);
                    setCollectionMeta(key,{chatChunkManifest:hasManifestStorage()?manifestHeader(remote):remote});
                    manifestReconciled=true;
                }else if((remote.revision??0)===(local.revision??0) &&
                    (remote.updatedAt!==local.updatedAt || JSON.stringify(remote.entries)!==JSON.stringify(local.entries))){
                    throw new Error('Conflicting manifest data at the same revision; automatic overwrite blocked');
                }else if((remote.revision??0)<(local.revision??0)){
                    throw new Error('Remote manifest is behind local data; automatic rollback blocked');
                }
            }
            if(key.startsWith('standard:') && needsManifestRecovery && hasManifestStorage()){
                // Without the optional plugin, IndexedDB is authoritative.
                const persisted=await readManifest(key);
                if(persisted && persisted.chatUUID===local.chatUUID &&
                    (persisted.revision??0)>(local.revision??0)){
                    cacheManifest(key,persisted);
                    storeCompactHeader(key,persisted);
                    manifestReconciled=true;
                }
            }
            // Revision zero is the first snapshot and may safely be retried
            // while the remote profile still has no manifest.
            if(needsManifestRecovery && (local.revision??0)===0 && !hasInlineEntries(remote))
                manifestReconciled=true;
        }
        if(!manifestReconciled)
            throw new Error('Manifest patch may have failed after vectors were written. A verified database reconciliation is required; refusing to clear the failed status.');
        await writeRemoteProfile(key);
        if(!key.startsWith('standard:')){
            const response=await fetch('/api/plugins/similharity/collection/profile/get',{
                method:'POST',headers:withSharedWriteHeaders(getRequestHeaders()),body:JSON.stringify({key}),
            });
            if(!response.ok)throw new Error(`Profile read-back failed: HTTP ${response.status}`);
            const result=await response.json();
            if(JSON.stringify(result.profile?.recipe)!==JSON.stringify(profile.recipe))
                throw new Error('Remote profile recipe did not match the local configuration');
            const local=getChatChunkManifest(key);
            if(local && ((result.manifest?.revision??-1)!==(local.revision??0) ||
                result.manifest?.updatedAt!==local.updatedAt ||
                result.manifest?.entries?.length!==local.entries.length))
                throw new Error('Remote manifest recovery acknowledgement was incomplete');
        }
        setCollectionMeta(key,{profileSaveStatus:'committed',profileSaveError:null,manifestNeedsReconciliation:false});
        return true;
    }catch(error){setCollectionMeta(key,{profileSaveStatus:'failed',profileSaveError:error.message});throw error;}
}
/** Manifest revision writes are serialized per collection and never push all
 * chunk text through SillyTavern settings when IndexedDB is available. */
export async function saveChatChunkManifest(key,chunks,chatUUID){
    return withManifestLock(key,async()=>{
        const entries=chunks.map(chunk=>({hash:chunk.hash,text:chunk.text,
            messageIds:chunk.metadata?.messageIds??[chunk.metadata?.messageId??chunk.index],
            messageHashes:chunk.metadata?.messageHashes||[],metadata:chunk.metadata||{}}));
        const manifest={schemaVersion:VERSION,chatUUID,entries,revision:0,updatedAt:new Date().toISOString()};
        // Do not erase a newer remote revision: sidecar compare-and-swap rejects it.
        cacheManifest(key,manifest);
        setCollectionMeta(key,{chatChunkManifest:hasManifestStorage()?manifestHeader(manifest):manifest,profileSaveStatus:'pending'});
        try{
            await writeRemoteProfile(key);
            if(hasManifestStorage())await replaceManifest(key,manifest);
            setCollectionMeta(key,{profileSaveStatus:'committed',profileSaveError:null,manifestNeedsReconciliation:false});
        }catch(error){
            setCollectionMeta(key,{profileSaveStatus:'failed',profileSaveError:String(error.message),manifestNeedsReconciliation:true});
            throw error;
        }
    });
}
export async function patchChatChunkManifest(key,chunks,chatUUID,removedHashes=[]){
    return withManifestLock(key,async()=>{
        const live=manifestCache.get(key);
        let previous=live?live.header:null;
        if(!previous){
            previous=getChatChunkManifest(key);
            if(!previous && getCollectionMeta(key)?.chatChunkManifest)
                previous=await hydrateChatChunkManifest(key);
        }
        if(!previous){
            // No manifest exists: initialize under the same lock (avoid nested lock).
            if(removedHashes.length)throw new Error('Cannot remove chunks without a verified manifest');
            const entries=chunks.map(item=>({hash:item.hash,text:item.text,
                messageIds:item.metadata?.messageIds??[item.metadata?.messageId??item.index],
                messageHashes:item.metadata?.messageHashes||[],metadata:item.metadata||{}}));
            const manifest={schemaVersion:VERSION,chatUUID,entries,revision:0,updatedAt:new Date().toISOString()};
            cacheManifest(key,manifest);
            setCollectionMeta(key,{chatChunkManifest:hasManifestStorage()?manifestHeader(manifest):manifest,profileSaveStatus:'pending'});
            try{
                await writeRemoteProfile(key);
                if(hasManifestStorage())await replaceManifest(key,manifest);
                setCollectionMeta(key,{profileSaveStatus:'committed',profileSaveError:null,manifestNeedsReconciliation:false});
            }catch(error){setCollectionMeta(key,{profileSaveStatus:'failed',profileSaveError:error.message,manifestNeedsReconciliation:true});throw error;}
            return;
        }
        if(previous.chatUUID!==chatUUID)throw new Error('Refusing to patch a manifest belonging to another chat');
        const upserts=chunks.map(item=>({hash:item.hash,text:item.text,
            messageIds:item.metadata?.messageIds??[item.metadata?.messageId??item.index],
            messageHashes:item.metadata?.messageHashes||[],metadata:item.metadata||{}}));
        const old=manifestCache.get(key);
        if(!old){cacheManifest(key,previous);}
        const record=manifestCache.get(key);
        const updatedAt=new Date().toISOString();
        const revision=(previous.revision??0)+1;
        const delta={key,chatUUID,upserts,removedHashes,
            expectedUpdatedAt:previous.updatedAt??null,expectedRevision:previous.revision??0,updatedAt,revision};
        // Do not advance the local checkpoint until the server has acknowledged.
        setCollectionMeta(key,{profileSaveStatus:'pending'});
        try{
            const expectedIds=new Set(record.entries.keys());
            for(const hash of removedHashes)expectedIds.delete(String(hash));
            for(const item of upserts)expectedIds.add(String(item.hash));
            const shouldPatchRemote=!key.startsWith('standard:') || hasManifestStorage();
            if(shouldPatchRemote){
                let response;
                try{response=await fetch('/api/plugins/similharity/collection/profile/manifest/patch',{
                    method:'POST',headers:withSharedWriteHeaders(getRequestHeaders()),body:JSON.stringify(delta)
                });}catch(error){
                    if(!key.startsWith('standard:'))throw error;
                    // Native Standard has no remote sidecar requirement.
                    response=null;
                }
                if(response?.ok){
                    const answer=await response.json();
                    if(!answer.success || answer.revision!==revision || answer.updatedAt!==updatedAt || answer.entries!==expectedIds.size)
                        throw new Error('Remote manifest acknowledgement did not match local revision');
                }else if(!key.startsWith('standard:') || (response && response.status!==404)){
                    throw new Error(`Incremental manifest persistence failed (HTTP ${response?.status??'network error'})`);
                }
                // No native plugin or old plugin lacking the journal route:
                // the IndexedDB transaction remains Standard's durable owner.
            }else{
                // Browsers lacking IndexedDB preserve the original complete
                // settings/sidecar fallback instead of dropping metadata.
                const items=new Map(record.entries);
                for(const hash of removedHashes)items.delete(String(hash));
                for(const item of upserts)items.set(String(item.hash),item);
                cacheManifest(key,{schemaVersion:VERSION,chatUUID,updatedAt,revision,entries:[...items.values()]});
                await writeRemoteProfile(key);
            }
            // IndexedDB uses one atomic write transaction for entries+revision.
            // A failure after server acknowledgement is recoverable from the
            // authoritative server journal before another write is allowed.
            if(hasManifestStorage())await patchManifest(key,delta);
            for(const hash of removedHashes)record.entries.delete(String(hash));
            for(const item of upserts)record.entries.set(String(item.hash),item);
            record.header={...record.header,updatedAt,revision};
            const compact={schemaVersion:VERSION,chatUUID,updatedAt,revision,
                entries:hasManifestStorage()?[]:[...record.entries.values()]};
            setCollectionMeta(key,{chatChunkManifest:hasManifestStorage()?manifestHeader({...compact,entryCount:record.entries.size}):compact,
                profileSaveStatus:'committed',profileSaveError:null});
        }catch(error){
            setCollectionMeta(key,{profileSaveStatus:'failed',profileSaveError:String(error.message),manifestNeedsReconciliation:true});
            throw error;
        }
    });
}

/** Only call after verifying the vectors were deleted from their owner.
 * Purge must erase our independent browser-side copy as well as ST settings. */
export async function retireChatChunkManifest(key){
    if(hasManifestStorage())await deleteManifest(key);
    manifestCache.delete(key);
    manifestLocks.delete(key);
    try{globalThis.localStorage?.removeItem(NATIVE_PROFILE_PREFIX+encodeURIComponent(key));}
    catch(error){throw new Error(`Native manifest backup could not be deleted: ${error.message}`);}
}

/** Model-name compatibility alone does NOT prove that the underlying model is
 * unchanged. Compare embeddings of a fixed harmless probe across sessions.
 * Secrets and API keys are never stored in the collection profile. */
async function embeddingIdentityProbe(settings) {
    const provider=settings.source||'transformers';
    if(provider==='transformers'||provider==='webllm')return null;
    const field=getModelField(provider);
    const model=field?settings[field]||'':settings.model||'';
    const params=getProviderSpecificParams(settings);
    const fingerprintKey=JSON.stringify([provider,model,params.apiUrl,params.customEndpointMode]);
    const known=embeddingProbeCache.get(fingerprintKey);
    if(known && Date.now()-known.time<PROBE_TTL)return structuredClone(known.probe);
    const response=await fetch('/api/plugins/similharity/get-embedding',{
        method:'POST',headers:withSharedWriteHeaders(getRequestHeaders()),
        body:JSON.stringify({source:provider,model,text:IDENTITY_PROBE_TEXT,...params}),
    });
    if(!response.ok)throw new Error(`Embedding identity probe failed (HTTP ${response.status})`);
    const data=await response.json();
    if(!Array.isArray(data.embedding)||data.embedding.length<2||data.embedding.some(n=>!Number.isFinite(n)))
        throw new Error('Embedding endpoint returned an invalid identity probe');
    const vector=data.embedding;
    const norm=Math.hypot(...vector);
    if(!Number.isFinite(norm)||norm<=0)throw new Error('Embedding model returned an empty identity probe');
    // Small, numeric, non-secret fingerprint. 48 coordinates and dimension
    // distinguish model changes while tolerating floating-point variation.
    const probe={dimension:vector.length,sample:vector.slice(0,48).map(v=>v/norm)};
    embeddingProbeCache.set(fingerprintKey,{probe,time:Date.now()});
    return structuredClone(probe);
}
function assertMatchingProbe(reference,active) {
    if(!reference)return;
    if(!active || reference.dimension!==active.dimension || reference.sample.length!==active.sample.length)
        throw new Error('Embedding fingerprint dimension mismatch. Collection write/query blocked.');
    const distance=Math.hypot(...reference.sample.map((v,i)=>v-active.sample[i]));
    if(!Number.isFinite(distance)||distance>0.005)
        throw new Error('Embedding fingerprint changed although the model name may be unchanged. Collection write/query blocked; re-vectorize safely.');
}
export async function discoverEmbeddingModel(settings) {
    const source = settings.source || 'transformers';
    const modelField = getModelField(source);
    let model = modelField && settings[modelField] || settings.model || null;
    if (source === 'llamacpp' || source === 'ollama') {
        const {apiUrl} = getProviderSpecificParams(settings);
        if (!apiUrl) return {modelId:null,verified:false,reason:`No ${source} embedding URL configured`};
        try {
            // Server-side proxy avoids browser CORS for remote/Termux embedding servers.
            const response = await fetch('/api/plugins/similharity/embedding/capabilities', {
                method:'POST',headers:withSharedWriteHeaders(getRequestHeaders()),body:JSON.stringify({source,apiUrl,model}),
            });
            if (!response.ok) throw new Error(`Capability discovery HTTP ${response.status}`);
            const data = await response.json();
            if (!data.success || !data.modelId) throw new Error(data.reason || 'Server did not return an unambiguous loaded model');
            return {modelId:data.modelId,modelPath:data.modelPath || null,verified:true,discovery:`${source}-api`,limits:data.limits || null};
        } catch (error) {
            return {modelId:null,verified:false,reason:`Unable to verify ${source} model: ${error.message}`};
        }
    }
    if (source === 'transformers') model ||= 'sillytavern-transformers-default';
    return {modelId:model,verified:!!model,verificationLevel:'configured-only',discovery:model?'configured-model':'unknown',reason:model?null:`${source} did not identify its embedding model`};
}
export async function makeCollectionProfile(settings, override={}) {
    const effective={...settings,...override};
    // Only the endpoint actually used for this embedding recipe belongs in
    // immutable collection metadata. Inactive draft URLs must not be copied
    // into exports or sidecars (they might contain credentials).
    assertPersistableEndpoint(effective.use_alt_endpoint ? effective.alt_endpoint_url : null);
    const model=await discoverEmbeddingModel(effective);
    let probe=null;let probeReason=null;
    try {probe=await embeddingIdentityProbe(effective);}catch(error){probeReason=error.message;}
    const verified=model.verified && (model.discovery!=='configured-model' || probe || effective.source==='transformers');
    const chunking=copySafe({...effective,conversation_turn_order:effective.conversation_turn_order || 'user_character'});
    if(!effective.use_alt_endpoint)delete chunking.alt_endpoint_url;
    const cleaning=structuredClone(effective.cleaning_snapshot ?? captureCleaningSnapshot(effective.cleaning_preset));
    chunking.cleaning_snapshot=cleaning;
    const recipe={version:RECIPE_VERSION,
        algorithmVersions:{chunking:CHUNKING_ALGORITHM_VERSION,chunkIdentity:CHUNK_IDENTITY_VERSION,cleaning:1,keywords:1,overflow:1},
        settings:structuredClone(chunking),cleaning,
        provider:effective.source||'transformers',
        vectorBackend:effective.vector_backend||'standard',
        createdAt:new Date().toISOString()};
    return {schemaVersion:VERSION,createdAt:recipe.createdAt,embedding:{provider:recipe.provider,
        modelId:model.modelId,configuredModel:(getModelField(effective.source)?effective[getModelField(effective.source)]:null)||null,
        modelPath:model.modelPath||null,verified:!!verified,discovery:model.discovery||null,reason:probeReason||model.reason||null,
        fingerprint:probe,
        verificationLevel:model.verificationLevel||(model.discovery==='configured-model'?'configured-only':'api-discovered')},
        chunking,recipe,limits:model.limits||null,status:verified?'verified':'unverified'};
}
export async function saveCollectionProfile(key, profile) {
    if (!profile || profile.schemaVersion !== VERSION) throw new Error('Invalid collection profile');
    ensureCompleteRecipe(profile);
    const before=getCollectionMeta(key)||{};
    if(before.manifestNeedsReconciliation)throw new Error('Manifest persistence is unresolved; do not overwrite its profile before verified reconciliation');
    const revision=(before.configurationRevision||0)+1;
    setCollectionMeta(key,{vectorizationProfile:profile,configurationRevision:revision,profileSaveStatus:'pending'});
    try {
        await writeRemoteProfile(key);
        // Initial Qdrant profile must be retrievable before committing writes.
        // Standard native storage has a synchronous local backup instead.
        if(!key.startsWith('standard:')) {
            const response=await fetch('/api/plugins/similharity/collection/profile/get',{
                method:'POST',headers:withSharedWriteHeaders(getRequestHeaders()),body:JSON.stringify({key}),
            });
            if(!response.ok)throw new Error(`Cannot verify saved profile (HTTP ${response.status})`);
            const saved=await response.json();
            if(JSON.stringify(saved.profile?.recipe)!==JSON.stringify(profile.recipe))
                throw new Error('Stored profile verification did not match the original recipe');
        }
        setCollectionMeta(key,{profileSaveStatus:'committed',profileSaveError:null,manifestNeedsReconciliation:false});
        // Commit/read back a separate durable settings copy before claiming
        // the original per-collection recipe is safely persisted.
        await flushVectHareSettings();
    } catch(error) {
        // Never claim a failed multi-store write committed. Retain the new
        // record for repair but fail closed until the remote copy is reconciled.
        setCollectionMeta(key,{profileSaveStatus:'failed',profileSaveError:String(error.message)});
        throw error;
    }
}
/** Restore a chat collection's non-secret embedding/chunking configuration without
 * mutating global preferences or another collection. Connection URLs and API
 * credentials remain operational settings; incompatible live servers fail closed.
 */
export function settingsForSavedCollection(key, currentSettings) {
    const profile=getCollectionProfile(key);
    if(!profile)return currentSettings;
    const provider=profile.embedding?.provider;
    if(!provider || !profile.embedding.verified)throw new Error('Saved embedding identity is unverified; refusing to resume');
    ensureCompleteRecipe(profile);
    if(['failed','pending'].includes(getCollectionMeta(key)?.profileSaveStatus))throw new Error('Collection profile persistence previously failed; repair before writing');
    const parsed=parseRegistryKey(key);
    const modelField=getModelField(provider);
    return {...currentSettings,...profile.chunking,cleaning_snapshot:structuredClone(profile.recipe.cleaning),
        ...(profile.chunking?.chunking_strategy === 'conversation_turns' ? {conversation_turn_order:profile.chunking.conversation_turn_order || 'user_character'} : {}),
        source:provider,
        // Profiles saved before Exact URL existed implicitly used Base mode.
        ...(provider === 'custom' ? {custom_endpoint_mode:profile.chunking?.custom_endpoint_mode || 'base'} : {}),
        vector_backend:parsed.backend||profile.chunking?.vector_backend||currentSettings.vector_backend,
        ...(modelField && profile.embedding.configuredModel ? {[modelField]:profile.embedding.configuredModel} : {})};
}
/** Existing profile controls how we chunk new messages; only operational URL may change. */
export async function applyAndVerifyProfile(key, currentSettings, {allowNew=false}={}) {
    const profile = getCollectionProfile(key) || await loadRemoteProfile(key);
    if (!profile) {
        if (!allowNew) throw new Error('Collection has no verified vectorization profile. It is read-only. Restore original settings or re-vectorize into a new collection.');
        return {settings:currentSettings,profile:await makeCollectionProfile(currentSettings),newProfile:true};
    }
    ensureCompleteRecipe(profile);
    if(getCollectionMeta(key)?.chatChunkManifest)await hydrateChatChunkManifest(key);
    if(['failed','pending'].includes(getCollectionMeta(key)?.profileSaveStatus))throw new Error('Collection profile persistence is incomplete. Repair the profile before writing.');
    if (!profile.embedding?.verified || !profile.embedding.modelId) throw new Error('Collection embedding identity is unverified. Writing is blocked; use verified settings or re-vectorize safely.');
    if (profile.embedding.provider !== currentSettings.source) throw new Error(`Collection uses ${profile.embedding.provider}, active provider is ${currentSettings.source}. Switch back to the original provider.`);
    const effectiveSettings = {...currentSettings, ...profile.chunking,cleaning_snapshot:structuredClone(profile.recipe.cleaning),
        ...(profile.chunking?.chunking_strategy === 'conversation_turns' ? {conversation_turn_order:profile.chunking.conversation_turn_order || 'user_character'} : {}),
        ...(profile.embedding.provider === 'custom' ? {custom_endpoint_mode:profile.chunking?.custom_endpoint_mode || 'base'} : {})};
    const live = await discoverEmbeddingModel(effectiveSettings);
    if (!live.verified || !live.modelId || live.modelId !== profile.embedding.modelId || (profile.embedding.modelPath && (profile.embedding.provider === 'ollama' ? live.modelPath !== profile.embedding.modelPath : !!live.modelPath && live.modelPath !== profile.embedding.modelPath))) {
        throw new Error(`Embedding model mismatch or unavailable: collection=${profile.embedding.modelId}, running=${live.modelId || live.reason || 'unknown'}. No vectors were written.`);
    }
    if(profile.embedding.fingerprint)assertMatchingProbe(profile.embedding.fingerprint,await embeddingIdentityProbe(effectiveSettings));
    if (profile.chunking?.vector_backend !== currentSettings.vector_backend || !!profile.chunking?.qdrant_multitenancy !== !!currentSettings.qdrant_multitenancy) {
        throw new Error('Collection backend or tenancy mode differs from its saved profile. Writing blocked.');
    }
    return {settings:effectiveSettings,profile,newProfile:false};
}

/** Query a collection in its original embedding space, independent of the UI's
 * currently selected provider. Retrieval preferences stay global/per-collection.
 * Missing profiles are readable for migration, never silently considered writable.
 */
export function settingsForCollectionQuery(key, currentSettings) {
    const profile=getCollectionProfile(key);
    if(!profile)return currentSettings;
    const parsed=parseRegistryKey(key);
    const provider=profile.embedding?.provider||parsed.source;
    const field=getModelField(provider);
    return {...currentSettings,
        ...profile.chunking,
        source:provider,
        vector_backend:parsed.backend||currentSettings.vector_backend,
        ...(field&&profile.embedding?.configuredModel?{[field]:profile.embedding.configuredModel}:{}),
        ...(provider==='custom'?{custom_endpoint_mode:profile.chunking?.custom_endpoint_mode||'base'}:{})};
}
/** Query-time compatibility: chunking may differ but the embedding space must not. */
const probeCache = new Map();
export async function assertQueryModelCompatible(key, settings) {
    const profile=getCollectionProfile(key);
    if(!profile) return; // Legacy collections remain readable, but cannot be written.
    if(!profile.embedding?.verified || !profile.embedding.modelId) throw new Error(`Collection ${key} has unverified embedding identity; do not issue an incompatible query.`);
    if(profile.embedding.provider !== settings.source)throw new Error(`Collection ${key} uses ${profile.embedding.provider}; query uses ${settings.source}`);
    if(settings.source === 'custom' && (profile.chunking?.custom_endpoint_mode || 'base') !== (settings.custom_endpoint_mode || 'base'))
        throw new Error(`Collection ${key} uses Custom API ${(profile.chunking?.custom_endpoint_mode || 'base')} URL mode. Restore that mode before querying; do not silently change embedding endpoints.`);
    const identity=getProviderSpecificParams(settings).apiUrl || '';
    const field=getModelField(settings.source);
    const cacheKey=`${settings.source}:${identity}:${field?settings[field]||'':''}`;
    let found=probeCache.get(cacheKey);
    if(!found || Date.now()-found.time>30000) {
        found={time:Date.now(),model:await discoverEmbeddingModel(settings)};
        probeCache.set(cacheKey,found);
    }
    const active=found.model;
    if(!active.verified || profile.embedding.modelId!==active.modelId ||
        (profile.embedding.modelPath && (profile.embedding.provider === 'ollama' ? profile.embedding.modelPath!==active.modelPath : !!active.modelPath && profile.embedding.modelPath!==active.modelPath)))
        throw new Error(`Embedding model mismatch querying ${key}. Saved=${profile.embedding.modelId}, running=${active.modelId || active.reason || 'unknown'}`);
    if(profile.embedding.fingerprint)assertMatchingProbe(profile.embedding.fingerprint,await embeddingIdentityProbe(settings));
}

/**
 * Explicit legacy-profile recovery. NEVER accept a user's guess alone:
 * verify the live provider against stored real vector values. This is a
 * conservative proof for sampled existing chunks, not a promise that every
 * legacy vector or original chunk setting can be recovered.
 */
export async function verifyAndRestoreLegacyProfile(registryKey, settings) {
    const existingProfile=getCollectionProfile(registryKey);
    if(existingProfile && getChatChunkManifest(registryKey)) throw new Error('Collection already has its profile and manifest; use Scan Chat instead');
    const parsed=parseRegistryKey(registryKey);
    if(parsed.backend !== (settings.vector_backend||'standard') || parsed.source !== (settings.source||'transformers'))
        throw new Error('Switch back to the collection backend and original embedding provider first');
    const profile=existingProfile || await makeCollectionProfile(settings);
    if(!profile.embedding.verified)throw new Error(profile.embedding.reason || 'Current embedding model cannot be verified');
    if(existingProfile) await applyAndVerifyProfile(registryKey,settings);
    const backend=await getBackend(settings);
    const result=await backend.listChunks(parsed.collectionId,settings,{limit:12,offset:0,includeVectors:true});
    if(!Array.isArray(result?.items) || !result.items.length)throw new Error('No existing vector samples are available for compatibility verification');
    const samples=result.items.slice(0,3);
    for(const sample of samples) {
        if(typeof sample.text !== 'string' || !Array.isArray(sample.vector) || sample.vector.length<2)
            throw new Error('Stored vector/text samples are not available; original settings cannot be verified');
        if(sample.metadata?.strategy !== settings.chunking_strategy)
            throw new Error(`Stored chunk strategy (${sample.metadata?.strategy || 'unknown'}) does not match chosen strategy (${settings.chunking_strategy}). Restore the original strategy first.`);
        // The stored text is exactly what the backend embedded, including any
        // expanded keywords. Compare with a live embedding of that same text.
        const {apiUrl,...providerParams}=getProviderSpecificParams(settings);
        const modelField=getModelField(settings.source);
        const response=await fetch('/api/plugins/similharity/get-embedding',{
            method:'POST',headers:withSharedWriteHeaders(getRequestHeaders()),body:JSON.stringify({
                source:settings.source,model:modelField?settings[modelField]||'':'',
                ...(apiUrl ? {apiUrl} : {}),...providerParams,text:sample.text,
            }),
        });
        if(!response.ok)throw new Error('Cannot verify existing vectors with the running embedding server');
        const {embedding}=await response.json();
        if(!Array.isArray(embedding) || embedding.length!==sample.vector.length)
            throw new Error('Embedding dimensionality differs from stored vectors; legacy collection remains read-only');
        let dot=0,an=0,bn=0;
        for(let i=0;i<embedding.length;i++){
            const a=embedding[i],b=sample.vector[i];
            if(!Number.isFinite(a)||!Number.isFinite(b))throw new Error('Invalid stored embedding values');
            dot+=a*b;an+=a*a;bn+=b*b;
        }
        const similarity=dot/(Math.sqrt(an)*Math.sqrt(bn));
        if(!Number.isFinite(similarity)||similarity<0.9995)
            throw new Error(`Legacy embedding mismatch (cosine similarity ${Number.isFinite(similarity)?similarity.toFixed(5):'unknown'}). Restore the original model or safely re-vectorize.`);
    }
    // Reconstruct a manifest only from chunks whose full message references
    // and source text are actually readable. Never invent missing provenance.
    const chatUUID=getChatUUID();
    if(!chatUUID || !Array.isArray(getContext()?.chat))throw new Error('Open the exact original chat before verifying this legacy collection');
    if(getChatBinding(chatUUID)?.registryKey!==registryKey)throw new Error('This chat must be explicitly connected read-only to the selected legacy collection before restoring its original settings');
    const complete=[];
    for(let offset=0;offset<100000;offset+=200){
        const batch=await backend.listChunks(parsed.collectionId,settings,{limit:200,offset});
        if(!Array.isArray(batch?.items))throw new Error('Cannot reconstruct legacy chunk references');
        complete.push(...batch.items);
        if(batch.items.length<200)break;
    }
    if(!complete.length || complete.some(row=>!row.text || !row.metadata ||
        (!Array.isArray(row.metadata.messageIds) && row.metadata.messageId == null)))
        throw new Error('Legacy vectors have missing source references; safe manifest recovery is impossible. Re-vectorize into a new collection instead.');
    // Historical cleaning, keywords, overflow and chunker versions cannot be
    // proven by matching a handful of numerical samples. Save the evidence,
    // but do not grant write ownership; use staged re-vectorisation to upgrade.
    setCollectionMeta(registryKey,{
        legacyVerification:{sampledAt:new Date().toISOString(),samplesChecked:samples.length,
            collectionItems:complete.length,method:'sampled-embedding-cosine',writeVerified:false},
        lastUsedVectorizationDraft:{...(getCollectionMeta(registryKey)?.lastUsedVectorizationDraft||{}),
            source:settings.source,chunking_strategy:settings.chunking_strategy}
    });
    throw new Error('Embedding samples match, but the original cleaning and chunking recipe cannot be proven. Collection remains read-only. Use staged Re-vectorize to create a verified replacement.');
}

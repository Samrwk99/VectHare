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

const VERSION = 1;
const COPY_FIELDS = ['embedding_max_tokens','alt_endpoint_url','use_alt_endpoint','custom_endpoint_mode','chunking_strategy','conversation_turn_order','batch_size','chunk_size','chunk_overlap','keyword_extraction_level','cleaning_preset','text_cleaning_enabled','cleaning_rules','substitution_policy','source','vector_backend','qdrant_multitenancy'];
function copySafe(obj) {
    const result = {};
    for (const key of COPY_FIELDS) if (obj?.[key] !== undefined) result[key] = structuredClone(obj[key]);
    return result;
}
const NATIVE_PROFILE_PREFIX='vecthare:native-profile:v1:';
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
        entries:(manifest.entries||[]).map(e=>({hash:e.hash,messageIds:e.messageIds||[],messageHashes:e.messageHashes||[]}))
    }:null;
    try {globalThis.localStorage?.setItem(NATIVE_PROFILE_PREFIX+encodeURIComponent(key),JSON.stringify({key,profile,manifest:safeManifest}));}
    catch(error){console.warn('[VectHare] Native profile immediate backup unavailable:',error.message);}
}
export function getCollectionProfile(key) {
    let profile=getCollectionMeta(key)?.vectorizationProfile;
    if(!profile){recoverNativeProfile(key);profile=getCollectionMeta(key)?.vectorizationProfile;}
    return profile?.schemaVersion === VERSION ? structuredClone(profile) : null;
}
export function getChatChunkManifest(key) {
    let manifest=getCollectionMeta(key)?.chatChunkManifest;
    if(!manifest){recoverNativeProfile(key);manifest=getCollectionMeta(key)?.chatChunkManifest;}
    return manifest?.schemaVersion === VERSION ? structuredClone(manifest) : null;
}
async function writeRemoteProfile(key) {
    const profile=getCollectionProfile(key);
    if(!profile)return;
    saveNativeProfile(key);
    try {
        const response=await fetch('/api/plugins/similharity/collection/profile/set',{
            method:'POST',headers:getRequestHeaders(),body:JSON.stringify({key,profile,manifest:getChatChunkManifest(key)}),
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
            method:'POST',headers:getRequestHeaders(),body:JSON.stringify({key}),
        });
        if(!response.ok) return null;
        const data=await response.json();
        if(data.profile?.schemaVersion!==VERSION)return null;
        setCollectionMeta(key,{vectorizationProfile:data.profile,chatChunkManifest:data.manifest||null});
        return data.profile;
    }catch{return null;}
}
export async function saveChatChunkManifest(key, chunks, chatUUID) {
    const entries = chunks.map(chunk => ({hash: chunk.hash, text: chunk.text, messageIds: chunk.metadata?.messageIds ?? [chunk.metadata?.messageId ?? chunk.index], messageHashes: chunk.metadata?.messageHashes || [], metadata: chunk.metadata || {}}));
    setCollectionMeta(key, {chatChunkManifest:{schemaVersion:VERSION, chatUUID, entries, updatedAt:new Date().toISOString()}});
    await writeRemoteProfile(key);
}
export async function patchChatChunkManifest(key, chunks, chatUUID, removedHashes=[]) {
    const previous = getChatChunkManifest(key);
    const entries = new Map((previous?.entries || []).map(e => [String(e.hash),e]));
    for (const hash of removedHashes) entries.delete(String(hash));
    for (const item of chunks) entries.set(String(item.hash), {hash:item.hash,text:item.text,messageIds:item.metadata?.messageIds ?? [item.metadata?.messageId ?? item.index],messageHashes:item.metadata?.messageHashes||[],metadata:item.metadata||{}});
    await saveChatChunkManifest(key, [...entries.values()].map(e=>({...e, metadata:{...e.metadata}})), chatUUID);
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
                method:'POST',headers:getRequestHeaders(),body:JSON.stringify({source,apiUrl,model}),
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
    return {modelId:model,verified:!!model,discovery:model?'configured-model':'unknown',reason:model?null:`${source} did not identify its embedding model`};
}
export async function makeCollectionProfile(settings, override={}) {
    const model = await discoverEmbeddingModel(settings);
    return {schemaVersion:VERSION,createdAt:new Date().toISOString(), embedding:{provider:settings.source||'transformers',modelId:model.modelId,configuredModel:(getModelField(settings.source)?settings[getModelField(settings.source)]:null)||null,modelPath:model.modelPath||null,verified:model.verified,discovery:model.discovery||null,reason:model.reason||null}, chunking:copySafe({...settings,...override,conversation_turn_order:settings.conversation_turn_order || 'user_character'}), limits:model.limits||null, status:model.verified?'verified':'unverified'};
}
export async function saveCollectionProfile(key, profile) {
    if (!profile || profile.schemaVersion !== VERSION) throw new Error('Invalid collection profile');
    setCollectionMeta(key, {vectorizationProfile:profile});
    await writeRemoteProfile(key);
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
    const parsed=parseRegistryKey(key);
    const modelField=getModelField(provider);
    return {...currentSettings,...profile.chunking,
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
    if (!profile.embedding?.verified || !profile.embedding.modelId) throw new Error('Collection embedding identity is unverified. Writing is blocked; use verified settings or re-vectorize safely.');
    if (profile.embedding.provider !== currentSettings.source) throw new Error(`Collection uses ${profile.embedding.provider}, active provider is ${currentSettings.source}. Switch back to the original provider.`);
    const effectiveSettings = {...currentSettings, ...profile.chunking,
        ...(profile.chunking?.chunking_strategy === 'conversation_turns' ? {conversation_turn_order:profile.chunking.conversation_turn_order || 'user_character'} : {}),
        ...(profile.embedding.provider === 'custom' ? {custom_endpoint_mode:profile.chunking?.custom_endpoint_mode || 'base'} : {})};
    const live = await discoverEmbeddingModel(effectiveSettings);
    if (!live.verified || !live.modelId || live.modelId !== profile.embedding.modelId || (profile.embedding.modelPath && (profile.embedding.provider === 'ollama' ? live.modelPath !== profile.embedding.modelPath : !!live.modelPath && live.modelPath !== profile.embedding.modelPath))) {
        throw new Error(`Embedding model mismatch or unavailable: collection=${profile.embedding.modelId}, running=${live.modelId || live.reason || 'unknown'}. No vectors were written.`);
    }
    if (profile.chunking?.vector_backend !== currentSettings.vector_backend || !!profile.chunking?.qdrant_multitenancy !== !!currentSettings.qdrant_multitenancy) {
        throw new Error('Collection backend or tenancy mode differs from its saved profile. Writing blocked.');
    }
    return {settings:effectiveSettings,profile,newProfile:false};
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
            method:'POST',headers:getRequestHeaders(),body:JSON.stringify({
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
    await saveCollectionProfile(registryKey,{...profile,legacyVerifiedAt:new Date().toISOString(),verification:'sampled-embedding-cosine'});
    await saveChatChunkManifest(registryKey,complete.map(row=>({hash:row.hash,text:row.text,metadata:row.metadata})),chatUUID);
    bindChatCollection(chatUUID,registryKey,{writeVerified:true});
    return profile;
}

/**
 * VectHare Live Status — one event-driven view on desktop and Android.
 * Reads backend counts only while the window is open; never infers database
 * completeness from local settings or masks failed backend requests as zero.
 */
import { getContext, extension_settings } from '../../../../extensions.js';
import { getChatUUID, parseRegistryKey } from '../core/collection-ids.js';
import { getChatBinding } from '../core/collection-ownership.js';
import { getCollectionProfile, getChatChunkManifest } from '../core/vectorization-profile.js';
import { getCollectionRegistry } from '../core/collection-loader.js';
import { isCollectionEnabled, isCollectionAutoSyncEnabled, setCollectionAutoSync } from '../core/collection-metadata.js';
import { getBackend } from '../backends/backend-manager.js';
import {getCurrentSyncCheckpoint,getPendingContentForChat} from '../core/sync-checkpoints.js';
import {operationActions,requestOperationAction} from './operation-controls.js';
import { subscribeActivity, getActivitySnapshot, activityPercent, canRetryActivity, retryActivity } from './activity-status.js';

let initialized = false;
let displayTimer = null;
let databaseTimer = null;
let unsubscribe = null;
let databaseRefreshToken = 0;
let databaseBusy = false;
let lastStatsCollectionKey = undefined;
let previouslyFocused = null;
const $id = id => document.getElementById(id);
const isOpen = () => $id('vecthare_live_status_modal')?.style.display === 'flex';
function setText(id, value) { const el = $id(id); if(el) el.textContent=String(value ?? 'Unknown'); }
function elapsed(start, end=Date.now()) { return start ? `${Math.max(0,Math.round((end-start)/1000))}s` : '—'; }
function formatBytes(bytes) {
    if(!Number.isFinite(bytes) || bytes < 0) return null;
    const units=['B','KiB','MiB','GiB','TiB'];
    let count=bytes, index=0;
    while(count>=1024 && index<units.length-1){count/=1024;index++;}
    return `${count.toFixed(index ? 1 : 0)} ${units[index]}`;
}
function renderProgressCard(container, op) {
    const card=document.createElement('div'); card.className='vecthare-live-operation';
    const title=document.createElement('strong'); title.textContent=op.label;
    const description=document.createElement('div'); description.className='vecthare-live-muted';
    description.textContent=op.detail || (op.phase==='running'?'Working…':op.phase);
    const bar=document.createElement('div');bar.className='vecthare-live-progress-track';
    bar.setAttribute('role','progressbar'); bar.setAttribute('aria-label',op.label);
    bar.setAttribute('aria-valuemin','0'); bar.setAttribute('aria-valuemax','100');
    const fill=document.createElement('div');fill.className='vecthare-live-progress-fill';
    const pct=activityPercent(op);
    if(pct===null){bar.classList.add('vecthare-live-indeterminate');}else{
        fill.style.width=`${pct}%`;bar.setAttribute('aria-valuenow',String(pct));
    }
    bar.append(fill);
    const summary=document.createElement('small');summary.className='vecthare-live-muted';
    summary.textContent=`${op.total>0?`${op.completed} / ${op.total} ${op.unit} · ${pct}% · `:''}${elapsed(op.startedAt,op.finishedAt)} elapsed${op.phase!=='running'?` · ${op.phase}`:''}`;
    card.append(title,description,bar,summary);
    const m=op.metrics || {};
    const details=[];
    if(Number.isFinite(m.processedItems))details.push(`Items ${m.processedItems}/${m.totalItems||0}`);
    if(Number.isFinite(m.totalChunks))details.push(`Chunks prepared ${m.totalChunks}`);
    if(Number.isFinite(m.totalChunksToEmbed) && m.totalChunksToEmbed>0)details.push(`Embedded ${m.embeddedChunks||0}/${m.totalChunksToEmbed} (${Math.max(0,m.totalChunksToEmbed-(m.embeddedChunks||0))} left)`);
    if(Number.isFinite(m.totalBatches) && m.totalBatches>0)details.push(`Batch ${m.currentBatch||0}/${m.totalBatches}`);
    if(Number.isFinite(m.speedPerSecond) && m.speedPerSecond>0)details.push(`${m.speedPerSecond.toFixed(1)} chunks/s`);
    if(details.length){const stats=document.createElement('div');stats.className='vecthare-live-metrics';stats.textContent=details.join(' · ');card.append(stats);}
    if(op.errors?.length){const errors=document.createElement('div');errors.className='vecthare-live-errors';
        errors.textContent=`${op.errors.length} error(s): ${op.errors.slice(-3).join(' · ')}`;card.append(errors);}
    const actions=operationActions(op.id);
    if(op.category==='autosync' && op.resourceKey && ['running','paused','pausing'].includes(op.phase))actions.unshift('disable-auto-sync');
    if(op.phase==='failed'&&canRetryActivity(op.id))actions.push('retry');
    if(actions.length){
        const toolbar=document.createElement('div');toolbar.className='vecthare-live-controls';
        for(const action of actions){
            const button=document.createElement('button');button.type='button';
            button.className='vecthare-btn-secondary';
            button.textContent=action==='disable-auto-sync'?'Pause Auto-Sync':action==='pause'?'Pause':action==='resume'?'Resume':action==='stop'?'Stop safely':'Retry';
            button.dataset.liveAction=action;button.dataset.activityId=op.id;
            toolbar.append(button);
        }
        card.append(toolbar);
    }
    container.append(card);
}
function renderOperations(snapshot) {
    const current=snapshot.operations[0];
    const dock=$id('vecthare_status_dock');
    const inline=$id('vecthare_inline_status');
    // Avoid a second floating control sitting over the inline status strip.
    const inlineVisible=Boolean(inline && inline.getClientRects().length && inline.offsetWidth>0);
    if(dock){
        dock.hidden=!current || isOpen() || inlineVisible;
        if(current){
            const percent=activityPercent(current);
            setText('vecthare_dock_text',`${current.label}${current.detail?` · ${current.detail}`:''}`);
            setText('vecthare_dock_count',percent===null?'Working…':`${percent}%`);
            const fill=$id('vecthare_dock_fill');if(fill)fill.style.width=percent===null?'35%':`${percent}%`;
            dock.setAttribute('aria-label',`Open Live Status: ${current.label}`);
        }
    }
    if(inline){
        const primary=current||snapshot.latest;
        const state=current?(current.phase==='paused'?'Paused':current.phase==='pausing'?'Pausing':current.phase==='stopping'?'Stopping':'In progress'):primary?.phase==='failed'?'Last operation failed':primary?.phase==='stopped'?'Last operation stopped':primary?'Last operation completed':'Ready';
        setText('vecthare_inline_status_text',`${state}${primary?` · ${primary.label}`:' · No active operation'}`);
        const pct=current?activityPercent(current):null;
        setText('vecthare_inline_status_count',pct===null?(current?'Working…':'View status'):`${pct}%`);
        inline.classList.toggle('vecthare-inline-status-active',!!current);
        inline.classList.toggle('vecthare-inline-status-failed',!current && primary?.phase==='failed');
        const fill=$id('vecthare_inline_status_fill');if(fill)fill.style.width=pct===null?(current?'35%':'0%'):`${pct}%`;
    }
    if(!isOpen())return;
    const list=$id('vecthare_live_operations');
    if(list){list.replaceChildren();
        if(snapshot.operations.length)for(const op of snapshot.operations)renderProgressCard(list,op);
        else{const empty=document.createElement('p');empty.className='vecthare-live-muted';empty.textContent='No operation is currently running.';list.append(empty);}
    }
    const history=$id('vecthare_live_history');
    if(history){history.replaceChildren();
        for(const op of snapshot.history.slice(0,8))renderProgressCard(history,op);
        if(!snapshot.history.length)history.textContent='No completed operations this session.';
    }
}
function chatIdentity() {
    const chatUUID=getChatUUID();
    const binding=chatUUID?getChatBinding(chatUUID):null;
    return {chatUUID,binding,collectionKey:binding?.registryKey||null};
}
function renderChatSummary() {
    if(!isOpen())return;
    const settings=extension_settings.vecthare||{};
    const chat=getContext()?.chat;
    const {chatUUID,binding,collectionKey}=chatIdentity();
    if(collectionKey!==lastStatsCollectionKey){
        lastStatsCollectionKey=collectionKey;
        databaseRefreshToken++;
        setText('vecthare_live_db_vectors',collectionKey?'Checking new collection…':'Not connected');
        setText('vecthare_live_db_size','Unavailable');
        setText('vecthare_live_db_updated','Waiting for backend statistics');
        if(!databaseBusy)queueMicrotask(refreshDatabaseStats);
    }
    const profile=collectionKey?getCollectionProfile(collectionKey):null;
    const staged=getPendingContentForChat(chatUUID);
    const checkpoint=staged?.checkpoint || getCurrentSyncCheckpoint(binding,chatUUID);
    const recovery=$id('vecthare_live_recovery');
    if(recovery){
        const pending=Boolean(staged) || (checkpoint && ['running','interrupted','stopped','failed','paused'].includes(checkpoint.phase));
        const stillActive=getActivitySnapshot().operations.some(op=>['autosync'].includes(op.category)||op.label==='Vectorizing Chat');
        const savedState=checkpoint?.phase==='running' && !stillActive?'interrupted in an earlier session':checkpoint?.phase;
        recovery.hidden=!pending;
        setText('vecthare_live_recovery_text',!pending?'':staged?`Unfinished staged replacement: ${checkpoint?.verified??0}/${checkpoint?.total??'?'} chunks last verified. Your old collection remains active. Reopen Content Vectorizer with the original settings/source to resume safely.`:`Previous sync: ${savedState} · ${checkpoint.verified}/${checkpoint.total} chunks verified at last checkpoint. Sync Chat will reconcile actual database records before writing.`);
        const syncButton=$id('vecthare_live_resume_sync');if(syncButton)syncButton.hidden=Boolean(staged);
        const stagedButton=$id('vecthare_live_resume_staged');if(stagedButton){stagedButton.hidden=!staged;stagedButton.dataset.oldCollection=staged?.previousCollectionKey||'';}
    }
    const manifest=collectionKey?getChatChunkManifest(collectionKey):null;
    let registry=[];try{registry=getCollectionRegistry()||[];}catch{}
    setText('vecthare_live_backend',profile?.chunking?.vector_backend||settings.vector_backend||'standard');
    setText('vecthare_live_provider',profile?.embedding?.provider||settings.source||'transformers');
    setText('vecthare_live_chat',Array.isArray(chat)?`${chat.length} messages in current chat`:'No chat open');
    setText('vecthare_live_collection',collectionKey||'Not connected');
    setText('vecthare_live_connection',!binding?'Not connected':binding.writeVerified?'Verified writable connection':'Read-only / unverified');
    const autosyncOn=Boolean(collectionKey&&isCollectionAutoSyncEnabled(collectionKey));
    setText('vecthare_live_autosync',autosyncOn?'Enabled':'Disabled');
    const autoButton=$id('vecthare_live_autosync_toggle');
    if(autoButton){autoButton.hidden=!binding?.writeVerified;autoButton.textContent=autosyncOn?'Pause Auto-Sync':'Resume Auto-Sync';autoButton.dataset.autosyncKey=collectionKey||'';}
    setText('vecthare_live_retrieval',collectionKey?(isCollectionEnabled(collectionKey)?'Enabled (subject to activation rules)':'Disabled'):'Not connected');
    const embedding=profile?.embedding;
    setText('vecthare_live_model',embedding?`${embedding.modelId||'Unknown'} · ${embedding.verified?'verified':'unverified'}`:'No saved model profile');
    setText('vecthare_live_strategy',profile?.chunking?.chunking_strategy||'Unknown / not recorded');
    const entries=manifest?.entries;
    const tracked=new Set(Array.isArray(entries)?entries.flatMap(e=>e.messageIds||[]).filter(n=>Number.isInteger(n)&&n>=0):[]);
    setText('vecthare_live_coverage',Array.isArray(entries)&&manifest.chatUUID===chatUUID?
        `${tracked.size} / ${Array.isArray(chat)?chat.length:'?'} messages tracked · ${entries.length} chunk records`:
        'Unverified — no current-chat manifest');
    setText('vecthare_live_collection_total',`${registry.length} registered collections`);
    setText('vecthare_live_coverage_note','Manifest coverage is recorded locally; it is not proof that every vector exists. Use Scan Chat for verification.');
}
/** Backend-only read, never modify state. Every 12 s while the modal is visible. */
async function refreshDatabaseStats() {
    if(!isOpen()||databaseBusy)return;
    const {collectionKey}=chatIdentity();
    const token=++databaseRefreshToken;
    if(!collectionKey){setText('vecthare_live_db_vectors','Not connected');setText('vecthare_live_db_size','Unavailable');
        setText('vecthare_live_db_updated','No collection connected');return;}
    databaseBusy=true;
    setText('vecthare_live_db_updated','Refreshing from backend…');
    try{
        const parsed=parseRegistryKey(collectionKey);
        const base=extension_settings.vecthare||{};
        const profile=getCollectionProfile(collectionKey);
        const effective={...base,vector_backend:parsed.backend||profile?.chunking?.vector_backend||base.vector_backend,
            source:parsed.source||profile?.embedding?.provider||base.source};
        const backend=await getBackend(effective);
        if(typeof backend.getStats!=='function')throw new Error('Backend has no statistics API');
        const stats=await backend.getStats(parsed.collectionId,effective);
        // An unknown schema is not equivalent to an empty collection.
        if(!stats || typeof stats!=='object')throw new Error('Statistics response unavailable');
        if(stats.error)throw new Error(String(stats.error));
        if(token!==databaseRefreshToken || !isOpen() || chatIdentity().collectionKey!==collectionKey)return;
        const count=[stats.count,stats.totalVectors,stats.total_vectors,stats.vectors_count,stats.points_count,stats.totalChunks,stats.chunkCount].find(Number.isFinite);
        // Plugin `storageSize: 0` means unknown, not necessarily zero bytes.
        const bytes=[stats.sizeBytes,stats.size_bytes,stats.diskBytes,stats.disk_bytes,stats.storageSizeBytes].find(Number.isFinite);
        setText('vecthare_live_db_vectors',Number.isFinite(count)?`${count.toLocaleString()} stored vectors`:'Count not exposed by backend');
        setText('vecthare_live_db_size',formatBytes(bytes)||'Storage bytes not exposed by backend');
        setText('vecthare_live_db_updated',`Backend checked ${new Date().toLocaleTimeString()}`);
    }catch(error){
        if(token!==databaseRefreshToken || !isOpen())return;
        setText('vecthare_live_db_vectors','Unable to verify');
        setText('vecthare_live_db_size','Unavailable');
        setText('vecthare_live_db_updated',`Refresh failed: ${error.message||String(error)}`);
    }finally{
        databaseBusy=false;
        // Switching chats invalidates the old request. Refresh the new collection now.
        if(isOpen() && chatIdentity().collectionKey!==collectionKey)void refreshDatabaseStats();
    }
}
export function openLiveStatus() {
    initializeLiveStatus();
    const modal=$id('vecthare_live_status_modal');if(!modal)return;
    previouslyFocused=document.activeElement;
    modal.style.display='flex';
    document.body.classList.add('vecthare-live-open');
    renderChatSummary();renderOperations(getActivitySnapshot());
    clearInterval(displayTimer);clearInterval(databaseTimer);
    displayTimer=setInterval(()=>{if(isOpen()){renderChatSummary();renderOperations(getActivitySnapshot());}},2000);
    refreshDatabaseStats();
    databaseTimer=setInterval(refreshDatabaseStats,12000);
    $id('vecthare_live_status_close')?.focus();
}
export function closeLiveStatus() {
    const modal=$id('vecthare_live_status_modal');if(modal)modal.style.display='none';
    document.body.classList.remove('vecthare-live-open');
    renderOperations(getActivitySnapshot());
    databaseRefreshToken++;
    clearInterval(displayTimer);clearInterval(databaseTimer);
    displayTimer=null;databaseTimer=null;
    if(previouslyFocused?.isConnected)previouslyFocused.focus();
}
export function initializeLiveStatus() {
    if(initialized && $id('vecthare_live_status_modal'))return;
    initialized=true;
    const modal=document.createElement('div');
    modal.id='vecthare_live_status_modal';modal.className='vecthare-modal vecthare-live-modal';modal.style.display='none';
    modal.setAttribute('role','dialog');modal.setAttribute('aria-modal','true');modal.setAttribute('aria-label','VectHare Live Status');
    modal.innerHTML=`
      <div class="vecthare-modal-overlay" data-vecthare-live-close="true"></div>
      <div class="vecthare-modal-content vecthare-live-content">
        <div class="vecthare-modal-header"><h3><i class="fa-solid fa-chart-line"></i> Live Status</h3>
          <button type="button" id="vecthare_live_status_close" class="vecthare-modal-close" aria-label="Close live status">&times;</button></div>
        <div class="vecthare-modal-body vecthare-live-body">
          <section class="vecthare-live-section"><h4>Live operations & progress</h4><div id="vecthare_live_operations"></div></section>
          <section class="vecthare-live-section" id="vecthare_live_recovery" hidden><h4>Interrupted sync recovery</h4><p id="vecthare_live_recovery_text"></p><button type="button" class="vecthare-btn-secondary" id="vecthare_live_resume_sync">Resume using Sync Chat</button><button type="button" class="vecthare-btn-secondary" id="vecthare_live_resume_staged" hidden>Reopen Content Vectorizer</button></section>
          <section class="vecthare-live-section"><h4>Current chat</h4><div class="vecthare-live-data">
            <span>Chat</span><strong id="vecthare_live_chat"></strong>
            <span>Connected collection</span><strong id="vecthare_live_collection"></strong>
            <span>Write access</span><strong id="vecthare_live_connection"></strong>
            <span>Recorded coverage</span><strong id="vecthare_live_coverage"></strong>
            <span>Auto-Sync</span><strong><span id="vecthare_live_autosync"></span> <button type="button" class="vecthare-btn-secondary" id="vecthare_live_autosync_toggle" hidden></button></strong>
            <span>Retrieval</span><strong id="vecthare_live_retrieval"></strong>
          </div><small id="vecthare_live_coverage_note" class="vecthare-live-muted"></small></section>
          <section class="vecthare-live-section"><h4>Database (auto-refreshing)</h4><div class="vecthare-live-data">
            <span>Stored vectors, current collection</span><strong id="vecthare_live_db_vectors">Checking…</strong>
            <span>Physical storage size</span><strong id="vecthare_live_db_size">Checking…</strong>
            <span>Registered collections</span><strong id="vecthare_live_collection_total"></strong>
          </div><small id="vecthare_live_db_updated" class="vecthare-live-muted">Checking…</small></section>
          <section class="vecthare-live-section"><h4>Vectorisation configuration</h4><div class="vecthare-live-data">
            <span>Backend</span><strong id="vecthare_live_backend"></strong>
            <span>Embedding provider</span><strong id="vecthare_live_provider"></strong>
            <span>Saved model</span><strong id="vecthare_live_model"></strong>
            <span>Saved chunking strategy</span><strong id="vecthare_live_strategy"></strong>
          </div></section>
          <section class="vecthare-live-section"><h4>Recent operations (this session)</h4>
            <div id="vecthare_live_history" class="vecthare-live-history"></div></section>
        </div>
      </div>`;
    const dock=document.createElement('button');dock.type='button';dock.id='vecthare_status_dock';
    dock.className='vecthare-status-dock';dock.hidden=true;
    dock.innerHTML='<span class="vecthare-status-dock-row"><span id="vecthare_dock_text">Working…</span><strong id="vecthare_dock_count"></strong></span><span class="vecthare-status-dock-track"><span id="vecthare_dock_fill"></span></span>';
    document.body.append(modal,dock);
    modal.addEventListener('click',async e=>{
        const button=e.target.closest('[data-live-action]');
        if(button){
            const {activityId,liveAction}=button.dataset;
            if(liveAction==='disable-auto-sync'){
                const key=getActivitySnapshot().operations.find(op=>op.id===activityId)?.resourceKey;
                if(key){setCollectionAutoSync(key,false);requestOperationAction(activityId,'stop');renderChatSummary();}
            }else if(liveAction==='retry'){button.disabled=true;try{await retryActivity(activityId);}catch(error){console.error('[VectHare] Retry failed',error);const note=document.createElement('small');note.className='vecthare-live-errors';note.textContent=`Retry failed: ${error.message||error}`;button.parentElement.append(note);button.disabled=false;}}
            else requestOperationAction(activityId,liveAction);
        }
        if(e.target.closest('#vecthare_live_autosync_toggle')){
            const key=e.target.closest('#vecthare_live_autosync_toggle').dataset.autosyncKey;
            const current=chatIdentity();
            if(key && key===current.collectionKey && current.binding?.writeVerified){
                setCollectionAutoSync(key,!isCollectionAutoSyncEnabled(key));renderChatSummary();
            }
        }
        if(e.target.closest('#vecthare_live_resume_staged')){
            const key=e.target.closest('#vecthare_live_resume_staged').dataset.oldCollection;
            const open=window.vecthareOpenStagedRecovery;
            if(typeof open==='function')open(key||null);
        }
        if(e.target.closest('#vecthare_live_resume_sync')){
            const resume=window.vecthareResumeFromStatus;
            if(typeof resume==='function')await resume();
        }
    });
    modal.addEventListener('mousedown',e=>e.stopPropagation());
    modal.addEventListener('touchstart',e=>e.stopPropagation(),{passive:true});
    modal.addEventListener('click',e=>{if(e.target.closest('[data-vecthare-live-close], #vecthare_live_status_close'))closeLiveStatus();});
    dock.addEventListener('click',openLiveStatus);
    document.addEventListener('keydown',e=>{if(e.key==='Escape'&&isOpen())closeLiveStatus();});
    if(unsubscribe)unsubscribe();
    unsubscribe=subscribeActivity(renderOperations);
}

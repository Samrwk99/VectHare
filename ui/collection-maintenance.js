/** P4 maintenance console. Everything is opt-in; discovery never deletes. */
import { extension_settings } from '../../../../extensions.js';
import { getChatUUID, parseRegistryKey } from '../core/collection-ids.js';
import { getChatBinding } from '../core/collection-ownership.js';
import { getMaintenanceInventory, deleteConfirmedBackup } from '../core/collection-maintenance.js';
import { getCollectionRegistry } from '../core/collection-loader.js';
import { verifyAndRestoreLegacyProfile } from '../core/vectorization-profile.js';
import { verifyEmbeddingSamples } from '../core/embedding-verification.js';
import { getModelField } from '../core/providers.js';
import { openContentVectorizer } from './content-vectorizer.js';

let busy=false;
const el=(tag,text,cls)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node;};
function setStatus(container,message,bad=false){
    const status=container.querySelector('[data-maintenance-status]');
    if(status){status.textContent=message;status.style.color=bad?'var(--SmartThemeQuoteColor)':'';}
}
function button(text,action){const btn=el('button',text,'vecthare-btn-secondary');btn.type='button';btn.dataset.maintenanceAction=action;return btn;}
function input(label,value,type='text'){
    const holder=el('label');holder.style.cssText='display:flex;flex-direction:column;gap:4px;min-width:0';
    holder.append(el('small',label));
    const field=el('input');field.type=type;field.className='vecthare-input';field.value=value??'';
    holder.append(field);return {holder,field};
}
function rowFor(item){
    const row=el('section',undefined,'vecthare-live-operation');
    row.style.cssText='margin:8px 0;padding:12px;overflow-wrap:anywhere';
    const name=el('strong',item.name);row.append(name);
    const info=el('p',item.key,'vecthare-live-muted');info.style.fontSize='0.8em';row.append(info);
    const status=item.backupOf?'Preserved replacement backup':item.replacementMissing?'Replacement target not registered':item.owner?'Active chat-owned collection':'Registered collection';
    row.append(el('p',`${status} · ${item.enabled?'Retrieval enabled':'Retrieval disabled'} · ${item.verified?'Verified profile':'Unverified/legacy profile'}`,'vecthare-live-muted'));
    if(item.backupOf){
        row.append(el('p',`Replaced by: ${item.backupOf}`,'vecthare-live-muted'));
        const remove=button('Delete this backup…','delete-backup');remove.dataset.collectionKey=item.key;
        remove.disabled=!!item.owner||item.enabled;
        if(remove.disabled)remove.title='Only disabled, unowned confirmed backups may be deleted';
        row.append(remove);
    }
    if(!item.verified){
        const recover=button('Restore original settings…','legacy');recover.dataset.collectionKey=item.key;row.append(recover);
    }else{
        const verify=button('Verify embedding samples','verify');verify.dataset.collectionKey=item.key;row.append(verify);
    }
    return row;
}
export function renderCollectionMaintenance(container,settings=extension_settings.vecthare||{}) {
    container.replaceChildren();
    container.append(el('h4','Collection backups & recovery'));
    container.append(el('p','Only collections explicitly marked as replaced are labelled backups. Nothing is automatically deleted. Active chat connections are protected.','vecthare-live-muted'));
    const status=el('p','Ready. Collection inventory comes from the local registry; a failed database discovery is never interpreted as an empty database.');
    status.dataset.maintenanceStatus='1';container.append(status);
    const list=el('div');list.dataset.maintenanceList='1';container.append(list);
    const details=el('div');details.dataset.maintenanceDetails='1';container.append(details);
    const entries=getMaintenanceInventory();
    for(const item of entries)list.append(rowFor(item));
    if(!entries.length)list.append(el('p','No fully qualified registered collections available.'));
    const unresolved=(getCollectionRegistry()||[]).filter(key=>!parseRegistryKey(key).backend);
    if(unresolved.length)list.append(el('p',`${unresolved.length} unqualified legacy registry entr${unresolved.length===1?'y':'ies'} cannot be safely assigned to a backend yet. Use Database Browser Resync/discovery to identify them; these entries are preserved and never offered for deletion.`, 'vecthare-live-muted'));
    const byKey=key=>entries.find(x=>x.key===key);
    // Avoid duplicate listeners when the browser refreshes its tab.
    container.onclick=async event=>{
        const trigger=event.target.closest('button[data-maintenance-action]');
        if(!trigger||busy)return;
        const key=trigger.dataset.collectionKey,action=trigger.dataset.maintenanceAction;
        const item=byKey(key);if(!item)return;
        details.replaceChildren();
        if(action==='delete-backup'){
            if(!item.backupOf||item.owner||item.enabled){setStatus(container,'This collection is not an unowned, disabled confirmed backup.',true);return;}
            const typed=prompt(`Permanently delete only this backup?\n\n${key}\n\nType the complete collection identity to confirm:`);
            if(typed===null)return;
            if(typed!==key){setStatus(container,'Confirmation did not match; nothing deleted.',true);return;}
            if(!confirm('Final confirmation: deleting stored vectors cannot be undone. The replacement collection is not deleted. Continue?'))return;
            busy=true;setStatus(container,'Deleting backup; verifying backend response…');
            try {await deleteConfirmedBackup(key,typed,settings);renderCollectionMaintenance(container,settings);setStatus(container,'Backup deletion confirmed by backend.');}
            catch(error){setStatus(container,`Deletion refused or failed: ${error.message}`,true);}
            finally{busy=false;}
            return;
        }
        if(action==='verify'){
            busy=true;setStatus(container,'Read-only embedding sample verification in progress…');
            try {
                const result=await verifyEmbeddingSamples(key,settings);
                setStatus(container,`Sample verification: ${result.passed} passed, ${result.suspicious.length} suspicious, ${result.unverifiable.length} unverifiable; ${result.sampled} regenerated for comparison.`);
                for(const found of [...result.suspicious,...result.unverifiable]){
                    details.append(el('p',`${found.hash}: ${found.reason||`cosine ${found.similarity.toFixed(5)}`} — review/re-vectorize only after confirming model and source text.`));
                }
                if(!result.sampled)details.append(el('p',result.message||'No usable vector samples.'));
            }catch(error){setStatus(container,`Verification unavailable: ${error.message}`,true);}
            finally{busy=false;}
            return;
        }
        if(action==='legacy'){
            setStatus(container,'Unknown original settings: wrong guesses may mix incompatible embedding spaces and make retrieval misleading. No writes will be enabled unless sampled vectors match.');
            const form=el('div');form.style.cssText='display:flex;flex-direction:column;gap:8px;margin:12px 0';
            const provider=input('Original embedding provider',item.source);
            const model=input('Original model name (required for model-based providers)',getModelField(item.source)?settings[getModelField(item.source)]||'':'');
            const strategy=input('Original chunking strategy',settings.chunking_strategy||'conversation_turns');
            const turnOrder=input('Conversation Turns order (user_character or character_user)',settings.conversation_turn_order||'user_character');
            const size=input('Original chunk size',settings.chunk_size||512,'number');
            const overlap=input('Original overlap',settings.chunk_overlap||0,'number');
            form.append(provider.holder,model.holder,strategy.holder,turnOrder.holder,size.holder,overlap.holder);
            const verify=button('Verify existing vectors and restore profile','restore');verify.dataset.collectionKey=key;
            form.append(verify);
            const newCollection=button('Safely re-vectorize into a NEW collection…','revectorize');newCollection.dataset.collectionKey=key;
            form.append(newCollection);
            form.append(el('p','Alternative: leave this collection read-only. Verification samples are conservative, not proof of every legacy chunk. No automatic deletion.','vecthare-live-muted'));
            details.append(form);
            form.onclick=async e=>{
                e.stopPropagation();
                const act=e.target.closest('button[data-maintenance-action]')?.dataset.maintenanceAction;
                if(act==='revectorize'){
                    const binding=getChatBinding(getChatUUID());
                    if(binding?.registryKey!==key){setStatus(container,'Open the original chat and connect this collection read-only before starting replacement.',true);return;}
                    if(!confirm('Create a new collection for this chat using the current settings? The original collection will be preserved.'))return;
                    openContentVectorizer('chat',key);return;
                }
                if(act!=='restore'||busy)return;
                const selectedSource=provider.field.value.trim();
                if(selectedSource!==item.source){setStatus(container,'Provider does not match collection identity. No profile was saved.',true);return;}
                const candidate={...settings,source:selectedSource,vector_backend:item.backend,
                    chunking_strategy:strategy.field.value.trim(),conversation_turn_order:turnOrder.field.value.trim(),chunk_size:Number(size.field.value),chunk_overlap:Number(overlap.field.value)};
                const field=getModelField(selectedSource);if(field)candidate[field]=model.field.value.trim();
                if(!['user_character','character_user'].includes(candidate.conversation_turn_order)){setStatus(container,'Invalid Conversation Turns order',true);return;}
                if(!candidate.chunking_strategy||!Number.isInteger(candidate.chunk_size)||candidate.chunk_size<1 || !Number.isInteger(candidate.chunk_overlap)||candidate.chunk_overlap<0){setStatus(container,'Invalid chunking fields',true);return;}
                if(!confirm(`Attempt read-only compatibility checks for ${key}? No stored vectors will be changed.`))return;
                busy=true;setStatus(container,'Comparing stored vectors with live provider…');
                try{await verifyAndRestoreLegacyProfile(key,candidate);renderCollectionMaintenance(container,settings);setStatus(container,'Original profile restored from verified samples; review the collection and run Scan Chat.');}
                catch(error){setStatus(container,`Restore blocked: ${error.message}`,true);}
                finally{busy=false;}
            };
        }
    };
}

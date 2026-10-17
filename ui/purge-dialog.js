/** Shared, explicit UI for scoped VectHare data deletion. */
import { planVectHarePurge, executeVectHarePurge } from '../core/safe-purge.js';
import { acquireSharedOperation,finishSharedOperation } from './shared-operations.js';

export async function openPurgeDialog(settings, {allowReset=false}={}) {
    const mode = allowReset ? prompt(
        'VectHare Purge All\n\nType KEEP to delete VectHare vector data while preserving settings.\nType RESET to delete data AND reset VectHare settings after every deletion is verified.\n\nOther SillyTavern extensions and unrelated Qdrant tenants will not be deleted.\nCancel to leave everything unchanged.'
    ) : 'KEEP';
    if(mode === null)return null;
    if(!['KEEP',...(allowReset?['RESET']:[])].includes(mode))throw new Error('Enter KEEP or RESET exactly. No deletion performed.');
    const plan=await planVectHarePurge(settings);
    const names=plan.targets.map(item=>`• ${item.backend}: ${item.collectionId}${item.multitenancy?' (tenant only)':''}`).join('\n');
    const confirmed=confirm(
        `VectHare Purge — ${mode==='KEEP'?'PRESERVE SETTINGS':'RESET SETTINGS'}\n\n`+
        `Scope: ${plan.scope}\n\n${plan.count} VectHare collection(s) will be removed:\n${names||'(none discovered)'}\n\n`+
        'No unrelated vectors will be removed. Failed deletions preserve their metadata.\nContinue?'
    );
    if(!confirmed)return null;
    const typed=prompt(`FINAL confirmation: type DELETE ${plan.count} to delete the listed collection(s).`);
    if(typed!==`DELETE ${plan.count}`)throw new Error('Final confirmation did not match; nothing deleted.');
    // The shared writer slot must be held before the first backend deletion.
    const job=await acquireSharedOperation('Purge VectHare Data',{category:'purge',resourceKey:'all-user-collections'});
    let outcome='failed';
    try{
        const result=await executeVectHarePurge(settings,plan,{resetSettings:mode==='RESET'});
        outcome='completed';return result;
    }finally{
        await finishSharedOperation(job,outcome).catch(e=>console.warn('VectHare: purge job requires recovery',e));
    }
}

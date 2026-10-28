import {createPromptReceiptTracker} from '../utils/prompt-receipts.js';
import {currentChatIdentity} from './chat-job-runtime.js';
import {activationFrequencyLedger} from '../utils/activation-frequency-ledger.js';
import {getLastSearchDebug} from '../ui/search-debug.js';

const chatId=()=>{const id=currentChatIdentity();return String(id.originId||id.chatId||'');};
export const promptReceipts=createPromptReceiptTracker({
    getChatId:chatId,
    onReceipt(receipt) {
        const debug=getLastSearchDebug();
        if(debug?.injection && debug.injection.receiptNonce===receipt.nonce)
            debug.injection.finalReceipt={status:receipt.status,verified:receipt.verified,kind:receipt.kind};
        // Only exact, complete, assembled blocks can spend frequency. Registered
        // text, dry-runs, partial blocks and missing host hooks spend nothing.
        if (receipt.verified!==true) return;
        for (const group of receipt.groups||[]) {
            if(group.status!=='included') continue;
            for (const item of group.frequencyEntries||[]) {
                const result=activationFrequencyLedger.recordActivation({...item,
                    receipt:{status:'included',verified:true,recordIds:[item.recordId]}});
                if (result.status!=='recorded' && result.status!=='duplicate' && debug?.injection)
                    debug.injection.frequencyAccounting='unverified-storage-or-identity';
            }
        }
    }
});

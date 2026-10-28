/** S04 HTTP surface: validation + owner-scoped receipt inspection only.
 * No endpoint dispatches a vector mutation; S05-S08 must certify adapters. */
import {planMutation} from './s04-contract.js';
import {OperationLedger} from './s04-ledger.js';
export function registerS04Routes(router) {
    router.post('/v2/operations/preflight',(req,res)=>{
        try {
            const plan=planMutation(req.s03,req.body);
            // Do not reflect private text/vector/metadata, and do not imply that
            // a caller-selected chat/source has been authorized by the host.
            res.json({success:true,checkpoint:'S04',validated:true,authorized:false,
                executionAllowed:false,reason:'S04_SCOPE_AND_BACKEND_NOT_CERTIFIED',plan});
        } catch(error){
            res.status(error.status||400).json({success:false,code:error.code||'S04_PREFLIGHT_INVALID',error:'Mutation preflight rejected'});
        }
    });
    router.post('/v2/operations/submit',(req,res)=>res.status(409).json({
        success:false,code:'S04_MUTATION_NOT_ACTIVATED',
        error:'Mutation adapters and trusted source ownership require S05-S08 live acceptance.',
        retryable:false
    }));
    router.post('/v2/operations/reconcile',(req,res)=>res.status(409).json({
        success:false,code:'S04_RECONCILE_NOT_ACTIVATED',
        error:'Read-only reconciliation is internal until backend-authoritative reads are certified.',retryable:false
    }));
    router.get('/v2/operations/:id',async(req,res)=>{
        try {
            const receipt=await new OperationLedger(req.s03).read(req.params.id);
            res.json({success:true,operationId:receipt.operationId,state:receipt.state,
                action:receipt.plan.action,history:receipt.history,
                executionAllowed:false});
        } catch(error) {
            // Do not reveal a different user’s operation or filesystem state.
            res.status(404).json({success:false,code:'S04_OPERATION_UNAVAILABLE'});
        }
    });
}

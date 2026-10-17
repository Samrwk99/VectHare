/** Cooperative controls: never interrupt a database write in progress. */
import { setActivityPhase } from './activity-status.js';
import { checkpointSharedOperation } from './shared-operations.js';
const controllers=new Map();
export class OperationStoppedError extends Error {
    constructor(){super('Operation stopped safely; verified chunks preserved');this.name='OperationStoppedError';}
}
export function hasActiveVectorWrite(){return [...controllers.values()].some(control=>control.writeOperation);}
export function createOperationControl(activityId,{retry=null,pausable=true,stoppable=true,writeOperation=false}={}) {
    let state='running',release=null,shared=null;
    const controller={
        activityId,writeOperation,
        bindSharedOperation(operation){shared=operation;},
        get state(){return state;},
        get actions(){return state==='running'?[
            ...(pausable?['pause']:[]),...(stoppable?['stop']:[])]:
            state==='paused'?['resume',...(stoppable?['stop']:[])]:
            state==='pausing'?['stop']:[];},
        async checkpoint(){
            if(state==='stopping'||state==='stopped')throw new OperationStoppedError();
            if(state==='pausing'){state='paused';setActivityPhase(activityId,'paused');}
            while(state==='paused')await new Promise(resolve=>{release=resolve;});
            if(state==='stopping'||state==='stopped')throw new OperationStoppedError();
            await checkpointSharedOperation(shared);
        },
        request(action){
            if(action==='pause' && pausable && state==='running') {state='pausing';setActivityPhase(activityId,'pausing');return true;}
            if(action==='resume' && state==='paused'){state='running';setActivityPhase(activityId,'running');release?.();release=null;return true;}
            if(action==='stop' && stoppable && ['running','pausing','paused'].includes(state)) {
                state='stopping';setActivityPhase(activityId,'stopping');release?.();release=null;return true;
            }
            return false;
        },
        retry:typeof retry==='function'?retry:null,
        dispose(){state='stopped';release?.();release=null;controllers.delete(activityId);},
    };
    controllers.set(activityId,controller);
    return controller;
}
export function operationActions(activityId){return controllers.get(activityId)?.actions||[];}
export function requestOperationAction(activityId,action){
    const control=controllers.get(activityId);
    return control?.request(action)===true;
}
export function detachOperationControl(activityId){controllers.get(activityId)?.dispose();}

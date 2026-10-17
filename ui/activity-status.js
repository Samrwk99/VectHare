/** In-memory status feed for visible and background VectHare operations.
 * No network calls, chat text, or credentials are stored here.
 */
const active = new Map();
const history = [];
const listeners = new Set();
let nextId = 0;
const retryCallbacks = new Map();
export function registerActivityRetry(id, callback) {if(typeof callback === 'function') retryCallbacks.set(id,callback);}
export function canRetryActivity(id) {return retryCallbacks.has(id) && history.some(op=>op.id===id&&op.phase==='failed');}
export async function retryActivity(id) {
    if(!canRetryActivity(id))return false;
    const callback=retryCallbacks.get(id);retryCallbacks.delete(id);notify();
    await callback();return true;
}


function notify() {
    const snapshot = getActivitySnapshot();
    for (const listener of [...listeners]) {
        try { listener(snapshot); } catch (error) { console.warn('[VectHare] Status listener failed:', error); }
    }
}
function finiteCount(number, fallback = 0) {
    return Number.isFinite(number) ? Math.max(0, number) : fallback;
}
export function getActivitySnapshot() {
    const operations = [...active.values()].map(op => ({...op})).sort((a,b) => b.startedAt - a.startedAt);
    return { operations, latest: history[0] ? {...history[0]} : null, history: history.map(op => ({...op})) };
}
export function subscribeActivity(listener) {
    listeners.add(listener);
    listener(getActivitySnapshot());
    return () => listeners.delete(listener);
}
export function startActivity(label, {total=0, unit='items', detail='', category='operation',resourceKey=null}={}) {
    const id = `vh-activity-${++nextId}`;
    const now = Date.now();
    active.set(id, {id, label: String(label), detail: String(detail), category, unit,
        resourceKey, completed: 0, total: finiteCount(total), startedAt: now, updatedAt: now, phase: 'running', errors: [], metrics: {}});
    notify();
    return id;
}
export function updateActivity(id, {completed, total, detail, error, unit, metrics}={}) {
    const operation = active.get(id);
    if (!operation) return false;
    if (completed !== undefined) operation.completed = finiteCount(completed, operation.completed);
    if (total !== undefined) operation.total = finiteCount(total, operation.total);
    if (detail !== undefined) operation.detail = String(detail);
    if (unit !== undefined) operation.unit = String(unit);
    if (metrics && typeof metrics === 'object') operation.metrics = {...operation.metrics, ...metrics};
    if (error != null) operation.errors.push(String(error));
    operation.updatedAt = Date.now();
    notify();
    return true;
}
export function setActivityPhase(id, phase) {
    const operation=active.get(id);
    if(!operation || !['running','pausing','paused','stopping'].includes(phase))return false;
    operation.phase=phase;operation.updatedAt=Date.now();notify();return true;
}
export function finishActivity(id, success, detail='') {
    const operation = active.get(id);
    if (!operation) return false;
    if (detail) operation.detail = String(detail);
    operation.phase = success === 'stopped' ? 'stopped' : (success ? 'completed' : 'failed');
    operation.finishedAt = Date.now();
    active.delete(id);
    history.unshift({...operation, errors: [...operation.errors]});
    const removed=history.splice(12);for(const old of removed)retryCallbacks.delete(old.id);
    notify();
    return true;
}
export function activityPercent(operation) {
    return operation?.total > 0 ? Math.min(100, Math.max(0, Math.round(operation.completed / operation.total * 100))) : null;
}

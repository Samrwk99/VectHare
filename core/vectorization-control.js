/**
 * ============================================================================
 * VECTORIZATION RUN CONTROL (VectHare+)
 * ============================================================================
 * Tiny global controller for Pause / Resume / Stop of chat vectorization runs.
 *
 * Design notes:
 * - State is intentionally in-memory only. A Stop or crash does NOT need to
 *   persist anything: completed vectors are already written through to the
 *   vector DB (per-batch, not buffered), and the sync queue is derived from
 *   the DB on every run. "Resume" therefore simply means "run sync again".
 * - `paused` blocks the vectorizeAll loop AND new auto-sync work.
 * - `stopped` ends a vectorizeAll run cleanly, keeping all completed work.
 * - Both flags are cleared by resetControlState() whenever a run starts or
 *   ends, so stale flags can never wedge the extension.
 *
 * Part of the VectHare+ persistence/resume feature set. See CHANGES.txt.
 * ============================================================================
 */

/** @type {boolean} When true, vectorization work is held (not cancelled). */
let paused = false;

/** @type {boolean} When true, the active vectorization run should end cleanly. */
let stopped = false;

// R13: AbortController wiring - Stop now also CANCELS in-flight embedding /
// insert requests via AbortSignal instead of waiting for them to finish.
// Safety: embeddings complete before any DB write and chunks are written as
// complete units, so an aborted request leaves either a valid chunk or none -
// the next sync's hash diff reconciles either outcome. Never partial data.
let stopAbortController = new AbortController();

/**
 * R13: AbortSignal for the current run. Passed into insertVectorItems so
 * Stop cancels in-flight requests instead of draining them.
 * @returns {AbortSignal}
 */
export function getStopSignal() {
    return stopAbortController.signal;
}

/**
 * Pause vectorization: in-flight request finishes and is saved, no new work starts.
 */
export function pauseVectorization() {
    paused = true;
    console.log('VectHare: Vectorization paused by user (in-flight work will finish and be saved)');
}

/**
 * Resume vectorization after a pause.
 */
export function resumeVectorization() {
    paused = false;
    console.log('VectHare: Vectorization resumed');
}

/**
 * Stop vectorization cleanly. Completed vectors are kept; a later run
 * (manual, auto-sync, or resume-on-load) continues from where this one ended.
 */
export function stopVectorization() {
    stopped = true;
    paused = false;
    // R13: cancel in-flight embedding/insert requests immediately
    stopAbortController.abort();
    console.log('VectHare: Vectorization stopped by user (all completed vectors are kept, in-flight requests cancelled)');
}

/**
 * Clears both flags. Called when a run starts, ends, or aborts so flags
 * never leak between runs.
 */
export function resetControlState() {
    paused = false;
    stopped = false;
    // R13: fresh controller per run so a stale aborted signal can never
    // kill the next run's requests
    stopAbortController = new AbortController();
}

/**
 * @returns {boolean} True while vectorization is paused.
 */
export function isVectorizationPaused() {
    return paused;
}

/**
 * @returns {boolean} True when a stop has been requested for the active run.
 */
export function isVectorizationStopped() {
    return stopped;
}

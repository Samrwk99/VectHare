/**
 * ============================================================================
 * VECTHARE PROGRESS TRACKER
 * ============================================================================
 * Real-time progress panel for vectorization operations
 * Shows detailed status, progress bars, and live updates
 * VectHare+: Pause / Resume / Stop controls on the progress panel
 *
 * @author VectHare
 * @version 2.2.1-alpha
 * ============================================================================
 */

/**
 * Progress Tracker - Manages progress panel UI
 */
export class ProgressTracker {
    constructor() {
        this.panel = null;
        this.modal = null;
        this.isVisible = false;
        this.isPaused = false;
        this.terminalStatus = '';
        this.currentStatus = '';
        this.isDatabaseSnapshot = false;
        this.startCallback = null;
        this.currentOperation = null;
        this.timeIntervalId = null;
        this.isComplete = false;
        this.isStopping = false; // R10: true while a requested Stop is draining
        this.currentEta = ''; // R7: last computed ETA string, appended by the timer
        // PERF: Cache DOM element references to avoid repeated getElementById calls
        this.elements = null;
        // VectHare+: run-control callbacks (wired by vectorizeAll)
        this.controls = null;
        this.stats = {
            totalItems: 0,
            processedItems: 0,
            currentBatch: 0,
            totalBatches: 0,
            totalChunks: 0,
            embeddedChunks: 0,
            totalChunksToEmbed: 0,
            startTime: null,
            lastBatchTime: null,
            lastBatchSize: 0,
            lastBatchStartTime: null,
            errors: [],
        };
    }

    /**
     * Wire run-control callbacks (Pause / Resume / Stop buttons)
     * @param {{onPause: Function, onResume: Function, onStop: Function}} controls
     */
    setControls(controls) {
        this.controls = controls || null;
        if (!this.elements) return;
        const { pauseBtn, resumeBtn, stopBtn } = this.elements;
        if (pauseBtn) pauseBtn.style.display = 'inline-block';
        if (stopBtn) stopBtn.style.display = 'inline-block';
        if (resumeBtn) resumeBtn.style.display = 'none';
    }

    /** Start a chat sync from the Status window, even when no run exists yet. */
    setStartCallback(callback) {
        this.startCallback = callback;
        if (this.elements?.startBtn) {
            this.elements.startBtn.style.display = this.isComplete ? 'inline-block' : 'none';
        }
    }

    /**
     * Opens the same live progress view inside a modal (no duplicate controls).
     * The first open also works when no vectorization has run this session.
     */
    openStatus() {
        if (!this.panel) this.createPanel();
        // Keep real run controls/progress intact, including a paused run.
        if (!this.isPaused && (this.isComplete || !this.currentOperation)) {
            this.isDatabaseSnapshot = true;
            this.setDatabaseStatus(null, 'Checking saved database progress…');
        }
        this.reveal();
    }

    /** Show a database-backed snapshot when no manual job is active. */
    setDatabaseStatus(result, unavailableMessage = 'Saved vector status unavailable', targetLabel = '') {
        if (!this.panel || !this.isDatabaseSnapshot || this.isPaused) return;
        const validResult = result != null &&
            Number.isSafeInteger(result.total) && Number.isSafeInteger(result.pending) &&
            result.total >= 0 && result.pending >= 0 && result.pending <= result.total;
        if (!validResult) result = null;
        const total = result ? result.total : 0;
        const done = result ? total - result.pending : 0;
        const chunksKnown = result && Number.isSafeInteger(result.storedChunks) &&
            result.storedChunks >= 0;

        if (this.timeIntervalId) {
            clearInterval(this.timeIntervalId);
            this.timeIntervalId = null;
        }
        // #36: name the chat this snapshot describes; "Current Chat" alone left
        // the reader guessing which chat the numbers belonged to.
        this.currentOperation = `${targetLabel || 'Current Chat'} · Database Progress`;
        this.isComplete = true;
        this.isPaused = false;
        this.isStopping = false;
        this.currentStatus = '';
        this.currentEta = '';
        this.stats = {
            totalItems: total, processedItems: done,
            currentBatch: 0, totalBatches: 0,
            totalChunks: chunksKnown ? result.storedChunks : 0,
            embeddedChunks: 0, totalChunksToEmbed: 0,
            startTime: null, lastBatchTime: null, lastBatchSize: 0,
            lastBatchStartTime: null, errors: [],
            groupsCompletedThisRun: 0, embeddingBasePercent: 0, lastPercent: 0,
            databaseResultUnknown: !validResult,
            storedChunkCountKnown: !!chunksKnown,
        };
        this.terminalStatus = result
            ? (total
                ? (done === 0 && chunksKnown && result.storedChunks > 0
                    ? `${result.storedChunks} stored hash(es) reported; ` +
                      `no matching current group hashes found (${result.pending} pending)`
                    : `Saved group progress: ${done}/${total} groups · ${result.pending} pending`)
                : 'No eligible message groups in this chat')
            : unavailableMessage;
        if (this.elements?.statLabel) this.elements.statLabel.textContent = result ? 'Message groups' : 'Progress';
        if (this.elements?.time) this.elements.time.textContent = '—';
        if (this.elements?.speed) this.elements.speed.textContent = '—';
        if (this.elements?.errors) this.elements.errors.style.display = 'none';
        this.hideControls();
        this.updateCurrentItem(null);
        this.updateDisplay();
    }

    /**
     * #33: is `runId` the run that currently owns the panel? A null or undefined
     * id means the caller does not track runs and is always allowed, so every
     * existing call site keeps working unchanged.
     * @param {number|null} runId Value returned by show()
     * @returns {boolean}
     */
    isCurrentRun(runId) {
        return runId == null || runId === this.runId;
    }

    /**
     * Hide all run-control buttons (used on completion/failure)
     */
    hideControls() {
        if (!this.elements) return;
        const { pauseBtn, resumeBtn, stopBtn } = this.elements;
        if (pauseBtn) pauseBtn.style.display = 'none';
        if (stopBtn) stopBtn.style.display = 'none';
        if (resumeBtn) resumeBtn.style.display = 'none';
        if (this.elements.startBtn) this.elements.startBtn.style.display = this.startCallback ? 'inline-block' : 'none';
    }

    /**
     * Show progress panel
     * @param {string} operation - Operation name (e.g., "Vectorizing Chat", "Purging Index")
     * @param {number} totalItems - Total number of items to process
     * @param {string} itemLabel - Label for items (e.g., "Messages", "Steps", "Entries")
     */
    show(operation, totalItems = 0, itemLabel = 'Progress') {
        // #33: every operation shares this one panel. Each show() starts a new
        // run; a run that has been superseded can no longer complete the panel
        // (see isCurrentRun), so a slower earlier operation cannot overwrite
        // the reporting of the operation the user is now watching.
        this.runId = (this.runId || 0) + 1;
        if (!this.isComplete && this.currentOperation && this.currentOperation !== operation) {
            console.warn(`VectHare: progress panel taken over by "${operation}" while "${this.currentOperation}" was still reporting`);
        }
        this.currentOperation = operation;
        this.isDatabaseSnapshot = false;
        this.isComplete = false;
        this.isPaused = false;
        this.terminalStatus = '';
        this.currentStatus = '';
        this.isStopping = false; // R10: fresh run must not inherit a stale stopping state
        this.currentEta = '';
        // Each run gets its own log and its own settings summary.
        this.runLog = [];
        this.runSettings = null;
        this.renderRunSettings();
        this.renderRunLog();
        this.stats = {
            totalItems: totalItems,
            processedItems: 0,
            currentBatch: 0,
            totalBatches: 0,
            totalChunks: 0,
            embeddedChunks: 0,
            totalChunksToEmbed: 0,
            startTime: Date.now(),
            lastBatchTime: null,
            lastBatchSize: 0,
            lastBatchStartTime: Date.now(),
            groupsCompletedThisRun: 0, embeddingBasePercent: 0, lastPercent: 0,
            databaseResultUnknown: false, storedChunkCountKnown: false,
            errors: [],
        };

        if (!this.panel) {
            this.createPanel();
        }

        // Set the item label using cached element
        if (this.elements?.statLabel) {
            this.elements.statLabel.textContent = itemLabel;
        }

        // Start/restart time updater
        this.startTimeUpdater();

        this.log(`Started: ${operation}${totalItems ? ` (${totalItems} ${itemLabel.toLowerCase()})` : ''}`);
        this.updateDisplay();
        this.modal.style.display = 'flex';
        this.isVisible = true;
        if (this.elements?.startBtn) this.elements.startBtn.style.display = 'none';
        return this.runId; // #33: callers pass this back to complete()
    }

    /**
     * Appends one line to this run's log. Consecutive duplicates are collapsed
     * with a counter so a per-chunk narration cannot flood the panel.
     * @param {string} text Line to record
     */
    log(text) {
        const line = String(text ?? '').trim();
        if (!line) return;
        if (!Array.isArray(this.runLog)) this.runLog = [];
        const elapsed = this.stats?.startTime ? (Date.now() - this.stats.startTime) / 1000 : 0;
        const at = `+${elapsed.toFixed(1)}s`;
        const last = this.runLog[this.runLog.length - 1];
        if (last && last.text === line) {
            last.repeats = (last.repeats || 1) + 1;
            last.at = at;
        } else {
            this.runLog.push({ at, text: line, repeats: 1 });
            // Keep the panel bounded; the console still has everything.
            if (this.runLog.length > 300) this.runLog.splice(0, this.runLog.length - 300);
        }
        this.renderRunLog();
    }

    /**
     * Records what this run is ACTUALLY using, for display. The run passes its
     * own effective settings, so a sync or repair shows the collection's saved
     * configuration rather than today's global selection.
     * @param {object} info Effective run settings
     * @param {string} [origin] Where the values came from, shown beside the heading
     */
    setRunSettings(info, origin = '') {
        this.runSettings = info && typeof info === 'object' ? info : null;
        this.runSettingsOrigin = origin;
        this.renderRunSettings();
        if (this.runSettings) {
            const summary = Object.entries(this.runSettings)
                .filter(([, value]) => value !== undefined && value !== null && value !== '')
                .map(([label, value]) => `${label}: ${value}`).join(' · ');
            if (summary) this.log(`Settings in use - ${summary}`);
        }
    }

    /** Renders the settings-in-use block. */
    renderRunSettings() {
        const section = this.elements?.settings;
        const grid = this.elements?.settingsGrid;
        if (!section || !grid) return;
        const entries = Object.entries(this.runSettings || {})
            .filter(([, value]) => value !== undefined && value !== null && value !== '');
        if (!entries.length) {
            section.style.display = 'none';
            grid.replaceChildren();
            return;
        }
        grid.replaceChildren(...entries.flatMap(([label, value]) => {
            const key = document.createElement('div');
            key.className = 'vecthare-progress-settings-key';
            key.textContent = label;
            const val = document.createElement('div');
            val.className = 'vecthare-progress-settings-value';
            val.textContent = String(value);
            return [key, val];
        }));
        if (this.elements.settingsOrigin) {
            this.elements.settingsOrigin.textContent = this.runSettingsOrigin || '';
        }
        section.style.display = 'block';
    }

    /** Renders the run log, newest last, and keeps it scrolled to the end. */
    renderRunLog() {
        const section = this.elements?.log;
        const list = this.elements?.logList;
        if (!section || !list) return;
        const entries = this.runLog || [];
        if (!entries.length) {
            section.style.display = 'none';
            list.replaceChildren();
            return;
        }
        const atEnd = list.scrollTop + list.clientHeight >= list.scrollHeight - 24;
        list.replaceChildren(...entries.map(entry => {
            const row = document.createElement('div');
            row.className = 'vecthare-progress-log-row';
            const at = document.createElement('span');
            at.className = 'vecthare-progress-log-at';
            at.textContent = entry.at;
            const text = document.createElement('span');
            text.className = 'vecthare-progress-log-text';
            text.textContent = entry.repeats > 1 ? `${entry.text} (×${entry.repeats})` : entry.text;
            row.append(at, text);
            return row;
        }));
        section.style.display = 'block';
        if (atEnd) list.scrollTop = list.scrollHeight;
    }

    /**
     * Hide progress panel
     */
    hide() {
        if (this.modal) this.modal.style.display = 'none';
        this.isVisible = false;
    }

    /**
     * VectHare+ BUG FIX: Re-shows an existing panel WITHOUT resetting stats or
     * controls. Anchor for the paused-run recovery: a paused run whose panel
     * was closed by the user would otherwise strand its only Resume/Stop
     * controls behind a hidden element (re-entry was rejected with "use the
     * panel", pointing at a panel that no longer existed). vectorizeAll's
     * re-entrancy guard calls this when it detects a paused run.
     * Caller supplies the status line afterwards via updateDisplay('...').
     */
    reveal() {
        if (!this.panel) {
            this.openStatus();
            return;
        }

        // R16 FIX: a COMPLETED panel must never resurrect its run controls.
        // The previous logic inferred state from resumeBtn visibility, and
        // "resumeBtn hidden" (which is ALSO the post-complete state) was
        // misread as "running, not paused" - revealing Pause/Stop buttons
        // bound to a run that no longer existed (user-visible as a green-tick
        // 100% panel with clickable Pause/Stop).
        if (this.isComplete && !this.isPaused) {
            this.hideControls();
        } else if (this.elements && this.controls) {
            const isPaused = this.isPaused;
            if (this.elements.pauseBtn) this.elements.pauseBtn.style.display = isPaused ? 'none' : 'inline-block';
            if (this.elements.resumeBtn) this.elements.resumeBtn.style.display = isPaused ? 'inline-block' : 'none';
            if (this.elements.stopBtn) this.elements.stopBtn.style.display = 'inline-block';
        }

        this.modal.style.display = 'flex';
        this.isVisible = true;
        this.updateDisplay();
    }

    /**
     * Update progress
     * @param {number} processedItems - Number of items processed so far
     * @param {string} status - Current status message
     */
    updateProgress(processedItems, status = '') {
        this.stats.processedItems = processedItems;
        if (status) this.currentStatus = status;
        // The run's own status line is the run log: no extra plumbing, and it
        // records exactly what the panel reported at the time.
        if (status) this.log(status);
        this.updateDisplay(status);
    }

    /**
     * Update batch progress
     * @param {number} currentBatch - Current batch number
     * @param {number} totalBatches - Total number of batches
     */
    updateBatch(currentBatch, totalBatches) {
        this.stats.currentBatch = currentBatch;
        this.stats.totalBatches = totalBatches;
        this.updateDisplay();
    }

    /**
     * Update chunk count (for showing message → chunk splitting)
     * @param {number} totalChunks - Total chunks created from messages
     */
    updateChunks(totalChunks) {
        this.stats.totalChunks = totalChunks;
        this.updateDisplay();
    }

    /**
     * Update embedding progress (for showing embedded/remaining chunks)
     * @param {number} embeddedChunks - Number of chunks embedded so far
     * @param {number} totalChunksToEmbed - Total chunks to embed
     */
    updateEmbeddingProgress(embeddedChunks, totalChunksToEmbed) {
        console.log(`[ProgressTracker] updateEmbeddingProgress: ${embeddedChunks}/${totalChunksToEmbed}`);

        // Track batch timing for speed calculation
        const previousEmbedded = this.stats.embeddedChunks || 0;
        const batchSize = embeddedChunks - previousEmbedded;

        if (batchSize > 0 && this.stats.lastBatchStartTime) {
            const now = Date.now();
            this.stats.lastBatchTime = now - this.stats.lastBatchStartTime;
            this.stats.lastBatchSize = batchSize;
            this.stats.lastBatchStartTime = now; // Reset for next batch
            console.log(`[ProgressTracker] Batch completed: ${batchSize} chunks in ${this.stats.lastBatchTime}ms`);
        }

        this.stats.embeddedChunks = embeddedChunks;
        this.stats.totalChunksToEmbed = totalChunksToEmbed;
        this.updateDisplay();
    }

    /**
     * Update current item being processed (e.g., "Message 3, Chunk 2/5")
     * @param {string} text - Current item description
     */
    updateCurrentItem(text) {
        if (text) this.log(text);
        // PERF: Use cached element references
        const el = this.elements?.current;
        const textEl = this.elements?.currentText;
        if (el && textEl) {
            if (text) {
                textEl.textContent = text;
                el.style.display = 'block';
            } else {
                el.style.display = 'none';
            }
        }
    }

    /**
     * Add error to tracker
     * @param {string} error - Error message
     */
    addError(error) {
        this.stats.errors.push({
            message: error,
            timestamp: Date.now(),
        });
        this.log(`Error: ${error}`);
        this.updateDisplay();
    }

    /**
     * VectHare+: mark the panel as paused (keeps panel open, shows Resume/Stop)
     * @param {string} message - Paused status message
     */
    markPaused(message = '') {
        this.isComplete = true;
        this.isPaused = true;
        this.updateCurrentItem(null); // R17: clear the fossil "Item N - embedding" line
        if (this.timeIntervalId) {
            clearInterval(this.timeIntervalId);
            this.timeIntervalId = null;
        }
        if (this.elements) {
            if (this.elements.pauseBtn) this.elements.pauseBtn.style.display = 'none';
            if (this.elements.resumeBtn) this.elements.resumeBtn.style.display = 'inline-block';
            if (this.elements.stopBtn) this.elements.stopBtn.style.display = 'inline-block';
        }
        this.terminalStatus = `⏸ ${message || 'Paused'}`;
        this.updateDisplay();
    }

    /**
     * Complete operation
     * @param {boolean} success - Whether operation succeeded
     * @param {string} message - Completion message
     */
    complete(success, message = '', runId = null) {
        // #33: a completion from an operation that no longer owns the panel is
        // ignored, so it cannot mark the current operation as finished.
        if (!this.isCurrentRun(runId)) {
            console.debug(`VectHare: ignoring completion from a superseded operation (${message || 'no message'})`);
            return;
        }
        this.log(`${success ? 'Finished' : 'Ended'}${message ? `: ${message}` : ''}`);
        this.isComplete = true;
        this.isPaused = false;
        this.isStopping = false; // R10: drain finished - no lingering "stopping…" state
        this.currentEta = '';
        this.updateCurrentItem(null); // R17: clear the fossil "Item N - embedding" line
        // R17: a finished panel must never show live-looking controls
        this.hideControls();

        // Stop the time updater
        if (this.timeIntervalId) {
            clearInterval(this.timeIntervalId);
            this.timeIntervalId = null;
        }

        const startTime = this.stats?.startTime || Date.now();
        const duration = Date.now() - startTime;
        const seconds = (duration / 1000).toFixed(1);

        // #39: a run the user stopped, or one that ended because the chat
        // changed, neither succeeded nor failed. Showing a green tick for it was
        // misleading, and a red cross would be just as wrong.
        const completionMessage = success === 'stopped'
            ? `⏹ ${message || 'Operation stopped'} (${seconds}s)`
            : success
                ? `✅ ${message || 'Operation completed successfully'} (${seconds}s)`
                : `❌ ${message || 'Operation failed'} (${seconds}s)`;

        this.terminalStatus = completionMessage;
        this.updateDisplay();

        // Don't auto-hide - let user close manually
    }

    /**
     * Create progress panel HTML
     */
    createPanel() {
        const panelHTML = `
            <div id="vecthare_progress_modal" class="vecthare-modal" style="display: none;">
                <div class="vecthare-modal-overlay"></div>
                <div class="vecthare-modal-content vecthare-progress-modal-content">
                    <div id="vecthare_progress_panel" class="vecthare-progress-panel">
                <div class="vecthare-progress-header">
                    <h3 id="vecthare_progress_title">VectHare Progress</h3>
                    <button id="vecthare_progress_close" class="vecthare-progress-close">
                        <i class="fa-solid fa-times"></i>
                    </button>
                </div>
                <div class="vecthare-progress-body">
                    <!-- Main Progress Bar -->
                    <div class="vecthare-progress-section">
                        <div class="vecthare-progress-label">
                            <span id="vecthare_progress_status">Initializing...</span>
                            <span id="vecthare_progress_percent">0%</span>
                        </div>
                        <div class="vecthare-progress-bar-container">
                            <div id="vecthare_progress_bar" class="vecthare-progress-bar" style="width: 0%"></div>
                        </div>
                    </div>

                    <!-- Current Item Progress -->
                    <div id="vecthare_progress_current" class="vecthare-progress-current" style="display: none;">
                        <span id="vecthare_progress_current_text">Processing...</span>
                    </div>

                    <!-- Run Controls (VectHare+) -->
                    <div class="vecthare-progress-section" id="vecthare_progress_controls" style="margin-top: 8px;">
                        <button id="vecthare_progress_start" title="Start or continue syncing the current chat"
                            class="menu_button" style="display: none;">
                            <i class="fa-solid fa-play"></i> Sync Chat
                        </button>
                        <button id="vecthare_progress_pause" title="Pause: finish in-flight work, then stop starting new items"
                            class="menu_button" style="display: none;">
                            <i class="fa-solid fa-pause"></i> Pause
                        </button>
                        <button id="vecthare_progress_resume" title="Resume: continue from the last completed item"
                            class="menu_button" style="display: none;">
                            <i class="fa-solid fa-play"></i> Resume
                        </button>
                        <button id="vecthare_progress_stop" title="Stop: end the run and keep everything completed so far"
                            class="menu_button" style="display: none;">
                            <i class="fa-solid fa-stop"></i> Stop
                        </button>
                    </div>

                    <!-- Stats Grid -->
                    <div class="vecthare-progress-stats">
                        <div class="vecthare-progress-stat">
                            <div id="vecthare_progress_stat_label" class="vecthare-progress-stat-label">Progress</div>
                            <div id="vecthare_progress_processed" class="vecthare-progress-stat-value">0 / 0</div>
                        </div>
                        <div class="vecthare-progress-stat">
                            <div class="vecthare-progress-stat-label">Chunks</div>
                            <div id="vecthare_progress_chunks" class="vecthare-progress-stat-value">0</div>
                        </div>
                        <div class="vecthare-progress-stat">
                            <div class="vecthare-progress-stat-label">Time</div>
                            <div id="vecthare_progress_time" class="vecthare-progress-stat-value">0.0s</div>
                        </div>
                        <div class="vecthare-progress-stat">
                            <div class="vecthare-progress-stat-label">Speed</div>
                            <div id="vecthare_progress_speed" class="vecthare-progress-stat-value">0/s</div>
                        </div>
                    </div>

                    <!-- What this run is actually using (set by the run itself) -->
                    <div id="vecthare_progress_settings" class="vecthare-progress-section vecthare-progress-details" style="display: none;">
                        <div class="vecthare-progress-details-header">
                            <i class="fa-solid fa-sliders"></i>
                            <span>Settings in use</span>
                            <small id="vecthare_progress_settings_origin" class="vecthare-progress-details-note"></small>
                        </div>
                        <div id="vecthare_progress_settings_grid" class="vecthare-progress-settings-grid"></div>
                    </div>

                    <!-- Run log: this run's own narration, newest last -->
                    <div id="vecthare_progress_log" class="vecthare-progress-section vecthare-progress-details" style="display: none;">
                        <div class="vecthare-progress-details-header">
                            <i class="fa-solid fa-list-ul"></i>
                            <span>Run log</span>
                            <button id="vecthare_progress_log_copy" class="vecthare-progress-log-copy"
                                    title="Copy this log to the clipboard">
                                <i class="fa-solid fa-copy"></i> Copy
                            </button>
                        </div>
                        <div id="vecthare_progress_log_list" class="vecthare-progress-log-list"></div>
                    </div>

                    <!-- Errors (hidden by default) -->
                    <div id="vecthare_progress_errors" class="vecthare-progress-errors" style="display: none;">
                        <div class="vecthare-progress-errors-header">
                            <i class="fa-solid fa-exclamation-triangle"></i>
                            <span>Errors</span>
                        </div>
                        <div id="vecthare_progress_errors_list" class="vecthare-progress-errors-list"></div>
                    </div>
                </div>
                    </div>
                </div>
            </div>
        `;

        // Insert panel into DOM
        const container = document.createElement('div');
        container.innerHTML = panelHTML;
        document.body.appendChild(container.firstElementChild);

        this.modal = document.getElementById('vecthare_progress_modal');
        this.panel = document.getElementById('vecthare_progress_panel');

        // PERF: Cache all DOM element references to avoid repeated getElementById calls
        this.elements = {
            title: document.getElementById('vecthare_progress_title'),
            status: document.getElementById('vecthare_progress_status'),
            percent: document.getElementById('vecthare_progress_percent'),
            bar: document.getElementById('vecthare_progress_bar'),
            processed: document.getElementById('vecthare_progress_processed'),
            chunks: document.getElementById('vecthare_progress_chunks'),
            time: document.getElementById('vecthare_progress_time'),
            speed: document.getElementById('vecthare_progress_speed'),
            current: document.getElementById('vecthare_progress_current'),
            settings: document.getElementById('vecthare_progress_settings'),
            settingsGrid: document.getElementById('vecthare_progress_settings_grid'),
            settingsOrigin: document.getElementById('vecthare_progress_settings_origin'),
            log: document.getElementById('vecthare_progress_log'),
            logList: document.getElementById('vecthare_progress_log_list'),
            currentText: document.getElementById('vecthare_progress_current_text'),
            statLabel: document.getElementById('vecthare_progress_stat_label'),
            errors: document.getElementById('vecthare_progress_errors'),
            errorsList: document.getElementById('vecthare_progress_errors_list'),
            closeBtn: document.getElementById('vecthare_progress_close'),
            // VectHare+ controls
            startBtn: document.getElementById('vecthare_progress_start'),
            pauseBtn: document.getElementById('vecthare_progress_pause'),
            resumeBtn: document.getElementById('vecthare_progress_resume'),
            stopBtn: document.getElementById('vecthare_progress_stop'),
        };

        // Bind close button
        this.elements.closeBtn.addEventListener('click', () => {
            this.hide();
        });

        // Mirror Database Browser modal behavior: clicks inside must not
        // close SillyTavern's settings drawer; backdrop / Escape closes view.
        this.modal.addEventListener('mousedown', e => e.stopPropagation());
        this.modal.addEventListener('touchstart', e => e.stopPropagation());
        this.modal.querySelector('.vecthare-modal-overlay').addEventListener('click', () => this.hide());
        this.modal.addEventListener('keydown', e => {
            if (e.key === 'Escape') this.hide();
        });
        this.elements.startBtn?.addEventListener('click', () => this.startCallback?.());

        document.getElementById('vecthare_progress_log_copy')?.addEventListener('click', async () => {
            const text = (this.runLog || []).map(entry => `${entry.at}  ${entry.text}`).join('\n');
            if (!text) return;
            try {
                await navigator.clipboard.writeText(text);
                toastr.success('Run log copied', 'VectHare');
            } catch (error) {
                console.warn('VectHare: Could not copy the run log:', error);
                toastr.info('Copying was blocked; the log is also in the browser console.', 'VectHare');
            }
        });

        // VectHare+: bind run-control buttons
        this.elements.pauseBtn?.addEventListener('click', () => {
            this.controls?.onPause?.();
        });
        this.elements.resumeBtn?.addEventListener('click', () => {
            this.controls?.onResume?.();
        });
        this.elements.stopBtn?.addEventListener('click', () => {
            this.controls?.onStop?.();
        });

        // Start time update interval
        this.startTimeUpdater();
    }

    /**
     * Update display with current stats
     * @param {string} statusOverride - Override status message
     */
    updateDisplay(statusOverride = '') {
        if (!this.panel || !this.elements) return;

        // Calculate progress percentage
        // Prioritize embedding progress if available, otherwise use processed items
        let percent = 0;
        if (this.stats.totalChunksToEmbed > 0 && this.stats.embeddedChunks >= 0) {
            const base = Math.min(Math.max(this.stats.embeddingBasePercent || 0, 0), 99);
            const ratio = Math.min(this.stats.embeddedChunks / this.stats.totalChunksToEmbed, 1);
            percent = Math.round(base + (100 - base) * ratio);
        } else if (this.stats.totalItems > 0) {
            percent = Math.round((this.stats.processedItems / this.stats.totalItems) * 100);
        }
        // Keep Content Vectorizer progress monotonic without masking chat sync recalculations.
        if (!this.isDatabaseSnapshot && this.stats.embeddingBasePercent > 0) {
            percent = Math.max(percent, this.stats.lastPercent || 0);
            this.stats.lastPercent = percent;
        }

        // PERF: Use cached element references instead of repeated getElementById calls
        const els = this.elements;

        // Update title
        if (els.title) els.title.textContent = this.currentOperation || 'VectHare Progress';

        // Update status.
        // R10 FIX: while a Stop is draining, ALWAYS synthesize the stopping
        // status - the 2s ETA-recalc tick calls updateDisplay() without an
        // override, which would otherwise clobber the onStop status line back
        // to "Processing chunks..." two seconds after Stop was pressed.
        const status = statusOverride
            || (this.isComplete && this.terminalStatus)
            || (this.isStopping ? '⏹ Stopping - waiting for the in-flight embedding to finish...' : this.currentStatus || this.generateStatusMessage());
        if (els.status) els.status.textContent = status;

        // Unknown saved status must not appear as verified 0% or 0/0.
        const unknownSnapshot = this.isDatabaseSnapshot && this.stats.databaseResultUnknown;
        if (els.percent) els.percent.textContent = unknownSnapshot ? '—' : `${percent}%`;
        if (els.bar) els.bar.style.width = `${unknownSnapshot ? 0 : percent}%`;
        if (els.processed) {
            els.processed.textContent = unknownSnapshot ? '—' :
                `${this.stats.processedItems} / ${this.stats.totalItems}`;
        }

        // Chat progress is in groups; this line counts writes from this run.
        if (els.chunks) {
            if (this.isDatabaseSnapshot) {
                els.chunks.textContent = this.stats.storedChunkCountKnown ?
                    String(this.stats.totalChunks) : '—';
            } else if (this.currentOperation === 'Vectorizing Chat') {
                els.chunks.textContent = `${this.stats.totalChunks} written this run`;
            } else if (this.stats.totalChunksToEmbed > 0) {
                // Show embedding progress: "45/100 (55 left)"
                const remaining = this.stats.totalChunksToEmbed - this.stats.embeddedChunks;
                const displayText = `${this.stats.embeddedChunks}/${this.stats.totalChunksToEmbed} (${remaining} left)`;
                els.chunks.textContent = displayText;
            } else if (this.stats.totalChunks > this.stats.processedItems && this.stats.processedItems > 0) {
                // Messages are being split into multiple chunks
                const avgChunks = (this.stats.totalChunks / this.stats.processedItems).toFixed(1);
                els.chunks.textContent = `${this.stats.totalChunks} (~${avgChunks}/msg)`;
            } else {
                els.chunks.textContent = `${this.stats.totalChunks}`;
            }
        }

        // Chat speed is based on chunks written during this run.
        let speed = '0.0';
        if (this.currentOperation === 'Vectorizing Chat' && this.stats.startTime) {
            const elapsed = (Date.now() - this.stats.startTime) / 1000;
            speed = elapsed > 0 ? (this.stats.totalChunks / elapsed).toFixed(1) : '0.0';
        } else if (this.stats.lastBatchTime && this.stats.lastBatchSize > 0) {
            // Use last batch performance for real-time speed
            const batchSpeed = (this.stats.lastBatchSize / (this.stats.lastBatchTime / 1000)).toFixed(1);
            speed = batchSpeed;
        } else if (this.stats.embeddedChunks > 0 && this.stats.startTime) {
            // Fallback to average speed
            const elapsed = (Date.now() - this.stats.startTime) / 1000;
            speed = elapsed > 0 ? (this.stats.embeddedChunks / elapsed).toFixed(1) : '0.0';
        }
        if (els.speed) els.speed.textContent = this.isDatabaseSnapshot ? '—' : `${speed}${this.currentOperation === 'Vectorizing Chat' ? ' chunks/s' : '/s'}`;

        // R7/R10: compute ETA and stash it for the elapsed-time timer to append.
        // R10: while a Stop is draining, show "stopping…" instead of a nonsense
        // countdown; ETA is also recomputed by the 2s status timer (see
        // startTimeUpdater) so it stays fresh even during long single embeds.
        if (this.isComplete) {
            this.currentEta = '';
        } else if (this.isStopping) {
            this.currentEta = ' · stopping…';
        } else {
            const done = this.stats.totalChunksToEmbed > 0
                ? this.stats.embeddedChunks
                : this.stats.processedItems;
            const totalUnits = this.stats.totalChunksToEmbed > 0
                ? this.stats.totalChunksToEmbed
                : this.stats.totalItems;
            const elapsedSec = this.stats.startTime ? (Date.now() - this.stats.startTime) / 1000 : 0;
            const completedForEta = this.currentOperation === 'Vectorizing Chat'
                ? this.stats.groupsCompletedThisRun || 0 : done;
            if (completedForEta > 0 && totalUnits > done && elapsedSec > 2) {
                const etaSec = Math.round((elapsedSec / completedForEta) * (totalUnits - done));
                const mins = Math.floor(etaSec / 60);
                const secs = etaSec % 60;
                this.currentEta = ` · ETA ${mins > 0 ? `${mins}m ` : ''}${secs}s`;
            } else {
                this.currentEta = '';
            }
        }
        if (els.time) {
            if (this.isDatabaseSnapshot) {
                els.time.textContent = '—';
            } else if (this.stats.startTime) {
                const elapsed = ((Date.now() - this.stats.startTime) / 1000).toFixed(1);
                els.time.textContent = `${elapsed}s${this.currentEta}`;
            }
        }

        // Show/hide errors
        if (this.stats.errors.length > 0) {
            this.updateErrorsList();
            if (els.errors) els.errors.style.display = 'block';
        }
    }

    /**
     * Generate status message based on current state
     */
    generateStatusMessage() {
        // R14 FIX: repair runs have their own status vocabulary. The 2s
        // ETA-recompute tick regenerates status without an override, which
        // previously clobbered the repair status line with generic sync text
        // ("Processing items..."/"Finalizing...") mid-repair.
        if (this.currentOperation && this.currentOperation.toLowerCase().includes('repair')) {
            const remaining = Math.max(0, this.stats.totalItems - this.stats.processedItems);
            return remaining > 0 ? `Repairing... ${remaining} item(s) remaining` : 'Finalizing...';
        }
        if (this.stats.processedItems === 0) {
            return 'Starting...';
        } else if (this.stats.totalChunksToEmbed > 0 && this.stats.embeddedChunks >= 0) {
            // Streaming approach: embedding and writing happen together
            const progressPercent = (this.stats.embeddedChunks / this.stats.totalChunksToEmbed) * 100;
            if (progressPercent < 100) {
                return 'Processing chunks...';
            } else {
                return 'Finalizing...';
            }
        } else if (this.stats.processedItems >= this.stats.totalItems) {
            return 'Finalizing...';
        } else if (this.stats.totalBatches > 0) {
            return `Processing batch ${this.stats.currentBatch}/${this.stats.totalBatches}`;
        } else {
            return `Processing items...`;
        }
    }

    /**
     * Update errors list display
     */
    updateErrorsList() {
        // PERF: Use cached element reference
        const errorsList = this.elements?.errorsList;
        if (!errorsList) return;
        // #53: error text can come from a backend response or a remote
        // provider. It was interpolated straight into innerHTML, so markup in
        // an error message could execute. Build the nodes and set text instead.
        errorsList.replaceChildren(...this.stats.errors.map(err => {
            const item = document.createElement('div');
            item.className = 'vecthare-progress-error-item';
            item.textContent = String(err?.message ?? err ?? '');
            return item;
        }));
    }

    /**
     * Start interval to update elapsed time
     */
    startTimeUpdater() {
        // Clear any existing interval first
        if (this.timeIntervalId) {
            clearInterval(this.timeIntervalId);
        }

        // R10: fast 100ms tick keeps elapsed fresh; every 2s (~20th tick) the
        // ETA is RECOMPUTED here too, so it stays current even when the run is
        // inside one long embedding request (updateDisplay only fires between
        // items, which could otherwise freeze the ETA for minutes).
        let tickCount = 0;
        this.timeIntervalId = setInterval(() => {
            tickCount++;

            // Recompute ETA every ~2s while a run is active
            if (tickCount % 20 === 0 && this.isVisible && !this.isComplete) {
                this.updateDisplay();
            }

            // Only update if visible, not complete, and has start time
            if (this.isVisible && !this.isComplete && this.stats.startTime) {
                const elapsed = ((Date.now() - this.stats.startTime) / 1000).toFixed(1);
                // PERF: Use cached element reference
                // R7/R10: elapsed + stashed ETA, e.g. "1m 12.4s · ETA 25m 3s"
                if (this.elements?.time) {
                    this.elements.time.textContent = `${elapsed}s${this.currentEta || ''}`;
                }
            }
        }, 100);
    }
}

// Export singleton instance
/**
 * Summarizes the settings a run is ACTUALLY using, for the status window.
 * Takes the run's own effective settings, so a sync or repair shows the
 * collection's saved configuration rather than today's global selection.
 * @param {object} settings Effective settings for the run
 * @param {object} [extra] Extra labelled values to append
 * @returns {object} Ordered label -> value pairs
 */
export function describeEffectiveSettings(settings, extra = {}) {
    if (!settings || typeof settings !== 'object') return { ...extra };
    const model = settings.openai_model || settings.ollama_model || settings.llamacpp_model ||
        settings.vllm_model || settings.webllm_model || settings.togetherai_model ||
        settings.cohere_model || settings.nomicai_model || settings.mistral_model ||
        settings.palm_model || settings.koboldcpp_model || '';
    const cleaning = settings.__collectionCleaningPatterns
        ? `${settings.__collectionCleaningPatterns.length} pattern(s) from the collection`
        : settings.text_cleaning_enabled === false
            ? 'off'
            : settings.text_cleaning_preset || 'default';
    const out = {
        'Backend': settings.vector_backend || 'standard',
        'Embedding source': settings.source || 'transformers',
        'Model': model || '(provider default)',
        'Chunking': settings.chunking_strategy || 'per_message',
    };
    if (settings.chunking_strategy === 'message_batch' && settings.batch_size) {
        out['Messages per batch'] = settings.batch_size;
    }
    if (settings.chunking_strategy === 'conversation_turns' && settings.conversation_turn_order) {
        out['Pairing order'] = settings.conversation_turn_order === 'character_user'
            ? 'Character → User' : 'User → Character';
    }
    if (settings.chunk_size) out['Chunk size'] = settings.chunk_size;
    out['Text cleaning'] = cleaning;
    if (settings.embedding_batch_size) out['Embedding batch'] = settings.embedding_batch_size;
    return { ...out, ...extra };
}

export const progressTracker = new ProgressTracker();

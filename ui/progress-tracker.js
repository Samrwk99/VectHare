/**
 * VectHare Progress Tracker — with Pause/Stop, sync counts, reopen.
 * Ported from VectFox's tracker; class API identical so no call-site churn.
 */

export class ProgressTracker {
    constructor() {
        this.panel = null;
        this.isVisible = false;
        this.currentOperation = null;
        this.timeIntervalId = null;
        this.isComplete = false;
        this.isCancelling = false;
        this.cancelHandler = null;
        this.syncCounts = null;
        this.elements = null;
        this.stats = {
            totalItems: 0, processedItems: 0, currentBatch: 0, totalBatches: 0,
            totalChunks: 0, embeddedChunks: 0, totalChunksToEmbed: 0,
            startTime: null, lastBatchTime: null, lastBatchSize: 0, lastBatchStartTime: null,
            errors: [],
        };
    }

    show(operation, totalItems = 0, itemLabel = 'Progress') {
        this.currentOperation = operation;
        this.isComplete = false;
        this.completedSuccess = false;
        this.isCancelling = false;
        this.syncCounts = null;
        this.stats = {
            totalItems, processedItems: 0, currentBatch: 0, totalBatches: 0,
            totalChunks: 0, embeddedChunks: 0, totalChunksToEmbed: 0,
            startTime: Date.now(), lastBatchTime: null, lastBatchSize: 0,
            lastBatchStartTime: Date.now(), errors: [],
        };

        if (!this.panel) this.createPanel();
        document.body.appendChild(this.panel); // re-append to layer above ST panels

        // Reset DOM state left over from a previous run
        if (this.elements?.errors) this.elements.errors.style.display = 'none';
        if (this.elements?.errorsList) this.elements.errorsList.innerHTML = '';
        if (this.elements?.current) this.elements.current.style.display = 'none';
        if (this.elements?.syncCountsRow) this.elements.syncCountsRow.style.display = 'none';

        if (this.elements?.statLabel) this.elements.statLabel.textContent = itemLabel;

        // Visible BEFORE updateDisplay so it doesn't show stale previous-run state
        this.panel.style.display = 'block';
        this.isVisible = true;

        this.startTimeUpdater();
        this.updateDisplay();
        this.refreshCancelButtons();
    }

    hide() {
        if (this.panel) this.panel.style.display = 'none';
        this.isVisible = false;
        this.currentOperation = null;
        this.isCancelling = false;
        if (this.timeIntervalId) { clearInterval(this.timeIntervalId); this.timeIntervalId = null; }
        this.refreshCancelButtons();
    }

    setCancelHandler(handler) {
        this.cancelHandler = typeof handler === 'function' ? handler : null;
        this.refreshCancelButtons();
    }

    clearCancelHandler() {
        this.cancelHandler = null;
        this.refreshCancelButtons();
    }

    /** mode: 'pause' | 'stop' */
    requestCancel(mode = 'pause') {
        if (!this.cancelHandler || this.isComplete || this.isCancelling) return;
        this.isCancelling = true;
        this.updateDisplay(mode === 'stop' ? 'Stopping...' : 'Pausing...');
        try { this.cancelHandler(mode); }
        catch (error) { this.addError(`Cancel failed: ${error?.message || error}`); this.isCancelling = false; }
        this.refreshCancelButtons();
    }

    refreshCancelButtons() {
        const canAct = !!this.cancelHandler && this.isVisible && !this.isComplete;
        const pauseBtn = this.elements?.pauseBtn;
        const stopBtn = this.elements?.stopBtn;
        for (const [btn, label, cls] of [
            [pauseBtn, 'Pause', 'vecthare-progress-pause'],
            [stopBtn, 'Stop', 'vecthare-progress-stop'],
        ]) {
            if (!btn) continue;
            btn.style.display = canAct ? 'inline-flex' : 'none';
            btn.disabled = !canAct || this.isCancelling;
            btn.innerHTML = this.isCancelling
                ? '<i class="fa-solid fa-spinner fa-spin"></i>'
                : `<i class="fa-solid ${cls === 'vecthare-progress-pause' ? 'fa-pause' : 'fa-stop'}"></i> ${label}`;
        }
    }

    updateProgress(processedItems, status = '') {
        this.stats.processedItems = processedItems;
        this.updateDisplay(status);
    }

    updateBatch(currentBatch, totalBatches) {
        this.stats.currentBatch = currentBatch;
        this.stats.totalBatches = totalBatches;
        this.updateDisplay();
    }

    updateChunks(totalChunks) {
        this.stats.totalChunks = totalChunks;
        this.updateDisplay();
    }

    updateEmbeddingProgress(embeddedChunks, totalChunksToEmbed) {
        const previousEmbedded = this.stats.embeddedChunks || 0;
        const batchSize = embeddedChunks - previousEmbedded;
        if (batchSize > 0 && this.stats.lastBatchStartTime) {
            const now = Date.now();
            this.stats.lastBatchTime = now - this.stats.lastBatchStartTime;
            this.stats.lastBatchSize = batchSize;
            this.stats.lastBatchStartTime = now;
        }
        this.stats.embeddedChunks = embeddedChunks;
        this.stats.totalChunksToEmbed = totalChunksToEmbed;
        this.updateDisplay();
    }

    updateCurrentItem(text) {
        const el = this.elements?.current;
        const textEl = this.elements?.currentText;
        if (el && textEl) {
            if (text) { textEl.textContent = text; el.style.display = 'block'; }
            else { el.style.display = 'none'; }
        }
    }

    /** Requirement #16: changed / deleted / failed counts line */
    setSyncCounts({ changed = 0, deleted = 0, failed = 0 } = {}) {
        this.syncCounts = { changed, deleted, failed };
        const row = this.elements?.syncCountsRow;
        if (row) {
            if (changed || deleted || failed) {
                row.innerHTML = `changed: <b>${changed}</b> · deleted: <b>${deleted}</b> · failed: <b>${failed}</b>`;
                row.style.display = 'block';
            } else {
                row.style.display = 'none';
            }
        }
    }

    addError(error) {
        this.stats.errors.push({ message: error, timestamp: Date.now() });
        this.updateDisplay();
    }

    complete(success, message = '') {
        this.isComplete = true;
        this.completedSuccess = success;
        this.isCancelling = false;
        this.clearCancelHandler();
        if (this.timeIntervalId) { clearInterval(this.timeIntervalId); this.timeIntervalId = null; }
        const seconds = ((Date.now() - this.stats.startTime) / 1000).toFixed(1);
        const msg = success ? `✅ ${message || 'Operation completed successfully'} (${seconds}s)`
                            : `❌ ${message || 'Operation failed'} (${seconds}s)`;
        this.updateDisplay(msg);
        // Don't auto-hide — user closes manually
    }

    /** Reopen the panel if it exists (Actions panel "Progress" button) */
    reopen() {
        if (!this.panel) return false;
        this.panel.style.display = 'block';
        this.isVisible = true;
        this.refreshCancelButtons();
        return true;
    }

    createPanel() {
        document.getElementById('vecthare_progress_panel')?.remove();

        const html = `
            <div id="vecthare_progress_panel" class="vecthare-progress-panel">
                <div class="vecthare-progress-header">
                    <h3 id="vecthare_progress_title">VectHare Progress</h3>
                    <div class="vecthare-progress-actions">
                        <button id="vecthare_progress_pause" class="vecthare-progress-pause" style="display: none;">
                            <i class="fa-solid fa-pause"></i> Pause
                        </button>
                        <button id="vecthare_progress_stop" class="vecthare-progress-stop" style="display: none;">
                            <i class="fa-solid fa-stop"></i> Stop
                        </button>
                        <button id="vecthare_progress_close" class="vecthare-progress-close">
                            <i class="fa-solid fa-times"></i>
                        </button>
                    </div>
                </div>
                <div class="vecthare-progress-body">
                    <div class="vecthare-progress-section">
                        <div class="vecthare-progress-label">
                            <span id="vecthare_progress_status">Initializing...</span>
                            <span id="vecthare_progress_percent">0%</span>
                        </div>
                        <div class="vecthare-progress-bar-container">
                            <div id="vecthare_progress_bar" class="vecthare-progress-bar" style="width: 0%"></div>
                        </div>
                    </div>
                    <div id="vecthare_progress_sync_counts" class="vecthare-progress-sync-counts" style="display: none;"></div>
                    <div id="vecthare_progress_current" class="vecthare-progress-current" style="display: none;">
                        <span id="vecthare_progress_current_text">Processing...</span>
                    </div>
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
                    <div id="vecthare_progress_errors" class="vecthare-progress-errors" style="display: none;">
                        <div class="vecthare-progress-errors-header">
                            <i class="fa-solid fa-exclamation-triangle"></i> <span>Errors</span>
                        </div>
                        <div id="vecthare_progress_errors_list" class="vecthare-progress-errors-list"></div>
                    </div>
                </div>
            </div>`;

        const container = document.createElement('div');
        container.innerHTML = html;
        document.body.appendChild(container.firstElementChild);
        this.panel = document.getElementById('vecthare_progress_panel');

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
            currentText: document.getElementById('vecthare_progress_current_text'),
            statLabel: document.getElementById('vecthare_progress_stat_label'),
            syncCountsRow: document.getElementById('vecthare_progress_sync_counts'),
            errors: document.getElementById('vecthare_progress_errors'),
            errorsList: document.getElementById('vecthare_progress_errors_list'),
            pauseBtn: document.getElementById('vecthare_progress_pause'),
            stopBtn: document.getElementById('vecthare_progress_stop'),
            closeBtn: document.getElementById('vecthare_progress_close'),
        };

        this.elements.pauseBtn?.addEventListener('click', () => this.requestCancel('pause'));
        this.elements.stopBtn?.addEventListener('click', () => this.requestCancel('stop'));
        this.elements.closeBtn?.addEventListener('click', () => this.hide());

        this.startTimeUpdater();
    }

    updateDisplay(statusOverride = '') {
        if (!this.panel || !this.isVisible || !this.elements) return;

        let percent = 0;
        if (this.isComplete && this.completedSuccess) percent = 100;
        else if (this.stats.totalChunksToEmbed > 0 && this.stats.embeddedChunks >= 0) {
            percent = Math.round((this.stats.embeddedChunks / this.stats.totalChunksToEmbed) * 100);
        } else if (this.stats.totalItems > 0) {
            percent = Math.round((this.stats.processedItems / this.stats.totalItems) * 100);
        }

        const els = this.elements;
        if (els.title) els.title.textContent = this.currentOperation || 'VectHare Progress';
        const status = statusOverride || this.generateStatusMessage();
        if (els.status) els.status.textContent = status;
        if (els.percent) els.percent.textContent = `${percent}%`;
        if (els.bar) els.bar.style.width = `${percent}%`;
        if (els.processed) els.processed.textContent = `${this.stats.processedItems} / ${this.stats.totalItems}`;

        if (els.chunks) {
            if (this.stats.totalChunksToEmbed > 0) {
                const remaining = this.stats.totalChunksToEmbed - this.stats.embeddedChunks;
                els.chunks.textContent = `${this.stats.embeddedChunks}/${this.stats.totalChunksToEmbed} (${remaining} left)`;
            } else if (this.stats.totalChunks > this.stats.processedItems && this.stats.processedItems > 0) {
                const avg = (this.stats.totalChunks / this.stats.processedItems).toFixed(1);
                els.chunks.textContent = `${this.stats.totalChunks} (~${avg}/msg)`;
            } else {
                els.chunks.textContent = `${this.stats.totalChunks}`;
            }
        }

        // Speed — guard against microsecond queue-flush spikes
        const MIN_BATCH_TIME_MS = 100;
        let speed = '0.0';
        if (this.stats.lastBatchTime >= MIN_BATCH_TIME_MS && this.stats.lastBatchSize > 0) {
            speed = (this.stats.lastBatchSize / (this.stats.lastBatchTime / 1000)).toFixed(1);
        } else if (this.stats.embeddedChunks > 0 && this.stats.startTime) {
            const elapsed = (Date.now() - this.stats.startTime) / 1000;
            speed = elapsed > 0 ? (this.stats.embeddedChunks / elapsed).toFixed(1) : '0.0';
        }
        if (els.speed) els.speed.textContent = `${speed}/s`;

        if (this.stats.errors.length > 0) {
            this.updateErrorsList();
            if (els.errors) els.errors.style.display = 'block';
        } else if (els.errors) {
            els.errors.style.display = 'none';
        }
    }

    generateStatusMessage() {
        if (this.isCancelling) return 'Cancelling...';
        if (this.stats.processedItems === 0) return 'Starting...';
        if (this.stats.totalChunksToEmbed > 0 && this.stats.embeddedChunks >= 0) {
            const p = (this.stats.embeddedChunks / this.stats.totalChunksToEmbed) * 100;
            return p < 100 ? 'Processing chunks...' : 'Finalizing...';
        }
        if (this.stats.processedItems >= this.stats.totalItems && this.stats.totalItems > 0) return 'Finalizing...';
        if (this.stats.totalBatches > 0) return `Processing batch ${this.stats.currentBatch}/${this.stats.totalBatches}`;
        return 'Processing items...';
    }

    updateErrorsList() {
        const list = this.elements?.errorsList;
        if (list) list.innerHTML = this.stats.errors.map(e => `<div class="vecthare-progress-error-item">${e.message}</div>`).join('');
    }

    startTimeUpdater() {
        if (this.timeIntervalId) clearInterval(this.timeIntervalId);
        this.timeIntervalId = setInterval(() => {
            if (this.isVisible && !this.isComplete && this.stats.startTime && this.elements?.time) {
                this.elements.time.textContent = `${((Date.now() - this.stats.startTime) / 1000).toFixed(1)}s`;
            }
        }, 100);
    }
}

export const progressTracker = new ProgressTracker();
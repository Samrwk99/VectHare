/**
 * ============================================================================
 * VEC-18: BACKEND HEALTH DASHBOARD
 * ============================================================================
 * Real-time monitoring dashboard for vector backend health and metrics.
 *
 * Features:
 * - Health status indicator
 * - Query latency statistics
 * - Operation counts (queries, inserts, deletes)
 * - Error tracking and display
 * - Auto-refresh with configurable interval
 *
 * @author VectHare
 * @version 2.2.0-alpha
 * ============================================================================
 */

import { getBackendMetrics, initializeBackend, resetBackendHealth } from '../backends/backend-manager.js';
import { extension_settings } from '../../../../extensions.js';

let refreshInterval = null;
let isModalOpen = false;

// Serialize explicit health checks to keep older results from racing new settings.
let pendingCheck = null;
let checkQueue = Promise.resolve();
let checkRevision = 0;

function getHealthDisplay(backendName, metrics) {
    if (pendingCheck?.backendName === backendName || !metrics?.lastHealthCheck) {
        const checking = pendingCheck?.backendName === backendName;
        return {
            css: 'vecthare-health-warning',
            icon: '&#x26A0;',
            label: checking ? 'Checking' : 'Not checked',
        };
    }
    return {
        css: getHealthClass(metrics.healthy, metrics.errors),
        icon: getHealthIcon(metrics.healthy, metrics.errors),
        label: metrics.healthy ? 'Healthy' : 'Unhealthy',
    };
}

function updateHealthIndicator() {
    const indicator = document.getElementById('vecthare_health_indicator');
    if (!indicator) return;
    const backendName = getCurrentBackend();
    const metrics = getBackendMetrics().backends.find(b => b.name === backendName);
    const display = getHealthDisplay(backendName, metrics);
    indicator.className = `vecthare-health-indicator ${display.css}`;
    indicator.title = `Backend Health: ${display.label}`;
}

/** Freshly verify the selected backend; reuse an identical in-flight request. */
export function checkBackendHealth(settings) {
    const backendName = settings.vector_backend || 'standard';
    const configKey = JSON.stringify([
        backendName, settings.source, settings.qdrant_use_cloud,
        settings.qdrant_host, settings.qdrant_port, settings.qdrant_url,
        settings.qdrant_api_key, settings.milvus_address, settings.milvus_host,
        settings.milvus_port,
    ]);
    if (pendingCheck?.key === configKey) return pendingCheck.promise;

    const revision = ++checkRevision;
    const snapshot = { ...settings };
    const record = { key: configKey, backendName, promise: null };
    const previous = checkQueue;
    pendingCheck = record;

    record.promise = previous.then(async () => {
        if (revision !== checkRevision) return false;
        // Force a real health check rather than reuse the 60-second instance cache.
        resetBackendHealth(backendName);
        return (await initializeBackend(backendName, snapshot, false)) !== null;
    }).catch(error => {
        console.warn(`VectHare: Health check failed for ${backendName}:`, error);
        return false;
    }).finally(() => {
        if (pendingCheck === record) {
            pendingCheck = null;
            updateHealthIndicator();
            updateDashboard();
        }
    });
    checkQueue = record.promise;
    updateHealthIndicator();
    updateDashboard();
    return record.promise;
}

/**
 * Get the current backend name from settings
 * @returns {string} Current backend name
 */
function getCurrentBackend() {
    return extension_settings.vecthare?.vector_backend || 'standard';
}

/**
 * Format a timestamp as a relative time string
 * @param {number} timestamp - Timestamp in milliseconds
 * @returns {string} Relative time string
 */
function formatRelativeTime(timestamp) {
    if (!timestamp) return 'Never';
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ago`;
}

/**
 * Get health status class for styling
 * @param {boolean} healthy - Health status
 * @param {number} errors - Error count
 * @returns {string} CSS class name
 */
function getHealthClass(healthy, errors = 0) {
    if (!healthy) return 'vecthare-health-error';
    if (errors > 0) return 'vecthare-health-warning';
    return 'vecthare-health-ok';
}

/**
 * Get health status icon
 * @param {boolean} healthy - Health status
 * @param {number} errors - Error count
 * @returns {string} Status icon
 */
function getHealthIcon(healthy, errors = 0) {
    if (!healthy) return '&#x2716;'; // X mark
    if (errors > 0) return '&#x26A0;'; // Warning
    return '&#x2714;'; // Check mark
}

/**
 * Render the health dashboard content
 * @returns {string} HTML content
 */
function renderDashboard() {
    const metrics = getBackendMetrics();
    const currentBackend = getCurrentBackend();

    // Find current backend metrics
    const currentMetrics = metrics.backends.find(b => b.name === currentBackend) || {
        name: currentBackend,
        healthy: false,
        queries: 0,
        inserts: 0,
        deletes: 0,
        errors: 0,
        avgLatency: 0,
        minLatency: null,
        maxLatency: null,
    };

    const display = getHealthDisplay(currentBackend, currentMetrics);
    const healthClass = display.css;
    const healthIcon = display.icon;

    return `
        <div class="vecthare-health-dashboard">
            <!-- Summary Section -->
            <div class="vecthare-health-summary">
                <div class="vecthare-health-status ${healthClass}">
                    <span class="vecthare-health-icon">${healthIcon}</span>
                    <span class="vecthare-health-label">${display.label}</span>
                </div>
                <div class="vecthare-health-uptime">
                    <small>Uptime: ${metrics.uptimeFormatted}</small>
                </div>
            </div>

            <!-- Current Backend Section -->
            <div class="vecthare-health-section">
                <h4>Current Backend: ${currentBackend}</h4>
                <div class="vecthare-health-grid">
                    <div class="vecthare-health-stat">
                        <span class="vecthare-stat-value">${currentMetrics.queries}</span>
                        <span class="vecthare-stat-label">Queries</span>
                    </div>
                    <div class="vecthare-health-stat">
                        <span class="vecthare-stat-value">${currentMetrics.inserts}</span>
                        <span class="vecthare-stat-label">Inserts</span>
                    </div>
                    <div class="vecthare-health-stat">
                        <span class="vecthare-stat-value">${currentMetrics.deletes}</span>
                        <span class="vecthare-stat-label">Deletes</span>
                    </div>
                    <div class="vecthare-health-stat ${currentMetrics.errors > 0 ? 'vecthare-stat-error' : ''}">
                        <span class="vecthare-stat-value">${currentMetrics.errors}</span>
                        <span class="vecthare-stat-label">Errors</span>
                    </div>
                </div>
            </div>

            <!-- Latency Section -->
            <div class="vecthare-health-section">
                <h4>Query Latency</h4>
                <div class="vecthare-health-grid">
                    <div class="vecthare-health-stat">
                        <span class="vecthare-stat-value">${currentMetrics.avgLatency || 0}ms</span>
                        <span class="vecthare-stat-label">Average</span>
                    </div>
                    <div class="vecthare-health-stat">
                        <span class="vecthare-stat-value">${currentMetrics.minLatency !== null ? currentMetrics.minLatency + 'ms' : '-'}</span>
                        <span class="vecthare-stat-label">Min</span>
                    </div>
                    <div class="vecthare-health-stat">
                        <span class="vecthare-stat-value">${currentMetrics.maxLatency !== null ? currentMetrics.maxLatency + 'ms' : '-'}</span>
                        <span class="vecthare-stat-label">Max</span>
                    </div>
                </div>
            </div>

            <!-- Health Checks Section -->
            <div class="vecthare-health-section">
                <h4>Health Checks</h4>
                <div class="vecthare-health-grid">
                    <div class="vecthare-health-stat">
                        <span class="vecthare-stat-value">${currentMetrics.healthChecksPassed || 0}</span>
                        <span class="vecthare-stat-label">Passed</span>
                    </div>
                    <div class="vecthare-health-stat ${currentMetrics.healthChecksFailed > 0 ? 'vecthare-stat-error' : ''}">
                        <span class="vecthare-stat-value">${currentMetrics.healthChecksFailed || 0}</span>
                        <span class="vecthare-stat-label">Failed</span>
                    </div>
                    <div class="vecthare-health-stat">
                        <span class="vecthare-stat-value">${formatRelativeTime(currentMetrics.lastHealthCheck)}</span>
                        <span class="vecthare-stat-label">Last Check</span>
                    </div>
                </div>
            </div>

            <!-- Last Error Section -->
            ${currentMetrics.lastError ? `
            <div class="vecthare-health-section vecthare-health-error-section">
                <h4>Last Error</h4>
                <div class="vecthare-health-error-box">
                    <span class="vecthare-error-time">${formatRelativeTime(currentMetrics.lastError.timestamp)}</span>
                    <span class="vecthare-error-message">${currentMetrics.lastError.message}</span>
                </div>
            </div>
            ` : ''}

            <!-- Global Stats Section -->
            <div class="vecthare-health-section">
                <h4>Global Statistics</h4>
                <div class="vecthare-health-grid">
                    <div class="vecthare-health-stat">
                        <span class="vecthare-stat-value">${metrics.totalQueries}</span>
                        <span class="vecthare-stat-label">Total Queries</span>
                    </div>
                    <div class="vecthare-health-stat">
                        <span class="vecthare-stat-value">${metrics.totalInserts}</span>
                        <span class="vecthare-stat-label">Total Inserts</span>
                    </div>
                    <div class="vecthare-health-stat ${metrics.totalErrors > 0 ? 'vecthare-stat-error' : ''}">
                        <span class="vecthare-stat-value">${metrics.totalErrors}</span>
                        <span class="vecthare-stat-label">Total Errors</span>
                    </div>
                </div>
            </div>

            <!-- Active Backends -->
            ${metrics.activeBackends.length > 0 ? `
            <div class="vecthare-health-section">
                <h4>Active Backends</h4>
                <div class="vecthare-active-backends">
                    ${metrics.activeBackends.map(name => `<span class="vecthare-backend-badge">${name}</span>`).join('')}
                </div>
            </div>
            ` : ''}
        </div>
    `;
}

/**
 * Update the dashboard content
 */
function updateDashboard() {
    const content = document.getElementById('vecthare_health_content');
    if (content && isModalOpen) {
        content.innerHTML = renderDashboard();
    }
}

/**
 * Start auto-refresh
 * @param {number} intervalMs - Refresh interval in milliseconds
 */
function startAutoRefresh(intervalMs = 5000) {
    stopAutoRefresh();
    refreshInterval = setInterval(updateDashboard, intervalMs);
}

/**
 * Stop auto-refresh
 */
function stopAutoRefresh() {
    if (refreshInterval) {
        clearInterval(refreshInterval);
        refreshInterval = null;
    }
}

/**
 * Open the health dashboard modal
 */
export function openHealthDashboard() {
    isModalOpen = true;
    const modal = document.getElementById('vecthare_health_modal');
    if (modal) {
        modal.style.display = 'flex';
        updateDashboard();
        startAutoRefresh(5000);
    }
}

/**
 * Close the health dashboard modal
 */
export function closeHealthDashboard() {
    isModalOpen = false;
    stopAutoRefresh();
    const modal = document.getElementById('vecthare_health_modal');
    if (modal) {
        modal.style.display = 'none';
    }
}

/**
 * Get the health indicator HTML for the main UI
 * @returns {string} HTML for health indicator
 */
export function getHealthIndicatorHtml() {
    const metrics = getBackendMetrics();
    const currentBackend = getCurrentBackend();
    const currentMetrics = metrics.backends.find(b => b.name === currentBackend);

    const display = getHealthDisplay(currentBackend, currentMetrics);

    return `
        <button id="vecthare_health_indicator" class="vecthare-health-indicator ${display.css}" title="Backend Health: ${display.label}">
            <span class="vecthare-health-dot"></span>
        </button>
    `;
}

/**
 * Get the health modal HTML
 * @returns {string} HTML for health modal
 */
export function getHealthModalHtml() {
    return `
        <div id="vecthare_health_modal" class="vecthare-modal" style="display: none;">
            <div class="vecthare-modal-overlay"></div>
            <div class="vecthare-modal-content vecthare-health-modal">
                <div class="vecthare-modal-header">
                    <h3>Backend Health Dashboard</h3>
                    <button class="vecthare-modal-close" id="vecthare_health_close">
                        <span>&times;</span>
                    </button>
                </div>
                <div class="vecthare-modal-body">
                    <div id="vecthare_health_content">
                        ${renderDashboard()}
                    </div>
                </div>
                <div class="vecthare-modal-footer">
                    <small>Auto-refreshes every 5 seconds</small>
                    <button id="vecthare_health_refresh" class="vecthare-btn-secondary">Refresh Now</button>
                </div>
            </div>
        </div>
    `;
}

/**
 * Initialize health dashboard event handlers
 */
export function initializeHealthDashboard() {
    // Health indicator click
    $(document).on('click', '#vecthare_health_indicator', openHealthDashboard);

    // Close button
    $(document).on('click', '#vecthare_health_close', closeHealthDashboard);

    // Overlay click
    $(document).on('click', '#vecthare_health_modal .vecthare-modal-overlay', closeHealthDashboard);

    // Refresh button
    $(document).on('click', '#vecthare_health_refresh', updateDashboard);

    // Update health indicator periodically
    setInterval(updateHealthIndicator, 10000);
}

/**
 * Get CSS styles for the health dashboard
 * @returns {string} CSS styles
 */
export function getHealthDashboardStyles() {
    return `
        /* Health Indicator */
        .vecthare-health-indicator {
            display: flex;
            align-items: center;
            justify-content: center;
            width: 28px;
            height: 28px;
            border: none;
            border-radius: 50%;
            cursor: pointer;
            background: transparent;
            padding: 0;
        }

        .vecthare-health-dot {
            width: 12px;
            height: 12px;
            border-radius: 50%;
            transition: background-color 0.3s;
        }

        .vecthare-health-ok .vecthare-health-dot {
            background-color: #4caf50;
            box-shadow: 0 0 6px rgba(76, 175, 80, 0.5);
        }

        .vecthare-health-warning .vecthare-health-dot {
            background-color: #ff9800;
            box-shadow: 0 0 6px rgba(255, 152, 0, 0.5);
        }

        .vecthare-health-error .vecthare-health-dot {
            background-color: #f44336;
            box-shadow: 0 0 6px rgba(244, 67, 54, 0.5);
        }

        /* Health Dashboard Modal */
        .vecthare-health-modal {
            max-width: 500px;
        }

        .vecthare-health-dashboard {
            display: flex;
            flex-direction: column;
            gap: 16px;
        }

        .vecthare-health-summary {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 12px 16px;
            background: rgba(0,0,0,0.2);
            border-radius: 8px;
        }

        .vecthare-health-status {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 1.1em;
            font-weight: 600;
        }

        .vecthare-health-status.vecthare-health-ok {
            color: #4caf50;
        }

        .vecthare-health-status.vecthare-health-warning {
            color: #ff9800;
        }

        .vecthare-health-status.vecthare-health-error {
            color: #f44336;
        }

        .vecthare-health-icon {
            font-size: 1.2em;
        }

        .vecthare-health-section {
            padding: 12px;
            background: rgba(0,0,0,0.1);
            border-radius: 8px;
        }

        .vecthare-health-section h4 {
            margin: 0 0 12px 0;
            font-size: 0.9em;
            opacity: 0.8;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        .vecthare-health-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(80px, 1fr));
            gap: 12px;
        }

        .vecthare-health-stat {
            display: flex;
            flex-direction: column;
            align-items: center;
            padding: 8px;
            background: rgba(0,0,0,0.15);
            border-radius: 6px;
        }

        .vecthare-stat-value {
            font-size: 1.4em;
            font-weight: 600;
        }

        .vecthare-stat-label {
            font-size: 0.75em;
            opacity: 0.7;
            text-transform: uppercase;
        }

        .vecthare-stat-error .vecthare-stat-value {
            color: #f44336;
        }

        .vecthare-health-error-section {
            border-left: 3px solid #f44336;
        }

        .vecthare-health-error-box {
            display: flex;
            flex-direction: column;
            gap: 4px;
            padding: 8px;
            background: rgba(244, 67, 54, 0.1);
            border-radius: 4px;
        }

        .vecthare-error-time {
            font-size: 0.8em;
            opacity: 0.7;
        }

        .vecthare-error-message {
            font-size: 0.9em;
            color: #f44336;
            word-break: break-word;
        }

        .vecthare-active-backends {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
        }

        .vecthare-backend-badge {
            padding: 4px 10px;
            background: rgba(255,255,255,0.1);
            border-radius: 12px;
            font-size: 0.85em;
        }

        .vecthare-modal-footer {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 12px 16px;
            border-top: 1px solid rgba(255,255,255,0.1);
        }

        .vecthare-modal-footer small {
            opacity: 0.6;
        }
    `;
}

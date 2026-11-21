import { legacyNeedsRebuild } from '../core/legacy-collections.js';
import { escapeHtml } from '../utils/html.js';
import { getStorageLocator } from "../core/storage-resolver.js";
import { vhLog } from '../utils/log.js';
import { progressTracker } from './progress-tracker.js';
/**
 * ============================================================================
 * VECTHARE DATABASE BROWSER
 * ============================================================================
 * Comprehensive vector database browser UI
 * Main entry point for browsing, managing, and editing all vector collections
 *
 * @author Coneja Chibi
 * @version see manifest.json
 * ============================================================================
 */

import {
  loadAllCollections,
  checkPluginAvailable,
  setCollectionEnabled,
  registerCollection,
  unregisterCollection,
  deleteCollection,
  deleteCollectionMetadataOnly,
  regenerateCollectionMetadata,
  getCollectionRegistry,
  invalidateCollectionInventory,
} from "../core/collection-loader.js";
import { parseRegistryKey, getBoundChatDetails } from "../core/collection-ids.js";
import {
  getDeletedChatInfo,
  listDeletedChatCollections,
  deletedChatDaysLeft,
  purgeDeletedChats,
} from "../core/deleted-chats.js";
import { storeStatus, reloadVectHareStore } from "../core/vecthare-store.js";
import { planStorageMove, moveCollectionStorage, deleteOldStorageCopy } from "../core/storage-move.js";
import {
  purgeVectorIndex,
  queryMultipleCollections,
} from "../core/core-vector-api.js";
import { getRequestHeaders, getCurrentChatId, eventSource, event_types } from "../../../../../script.js";
import {
  deleteCollectionMeta,
  getCollectionConditions,
  setCollectionConditions,
  getCollectionTriggers,
  setCollectionTriggers,
  getCollectionMeta,
  setCollectionMeta,
  getCollectionActivationSummary,
  getCollectionDecaySummary,
  getCollectionDecaySettings,
  setCollectionDecaySettings,
  hasCustomDecaySettings,
  getDefaultDecayForType,
  isCollectionEnabled,
  // Locking API
  getCollectionLock,
  getCollectionLocks,
  setCollectionLock,
  removeCollectionLock,
  clearCollectionLock,
  isCollectionLockedToChat,
  getCollectionLockCount,
  // Character Locking API
  getCollectionCharacterLocks,
  setCollectionCharacterLock,
  removeCollectionCharacterLock,
  clearCollectionCharacterLocks,
  isCollectionLockedToCharacter,
  currentCharacterLockKey,
  getCollectionCharacterLockCount,
  getChatCollectionPolicy,
  setChatCollectionPolicy,
  addCollectionToChatPolicy,
  removeCollectionFromChatPolicy,
  isCollectionSelectedForChat,
  getAllChunkMetadata,
  getAnnotatedChunkHashes,
  readInitialVectorizationConfig,
  fillStorageLocators,
} from "../core/collection-metadata.js";
import { getContext } from "../../../../extensions.js";
import {
  VALID_EMOTIONS,
  VALID_GENERATION_TYPES,
  getExpressionsExtensionStatus,
} from "../core/conditional-activation.js";
import { world_names, loadWorldInfo } from "../../../../world-info.js";
import { icons } from "./icons.js";
import { openVisualizer } from "./chunk-visualizer.js";
import { queryCollection } from "../core/core-vector-api.js";
import { getModelField } from "../core/providers.js";
import {
  exportCollection,
  importCollectionFromFile,
  downloadExport,
  readImportFile,
  validateImportData,
  getExportInfo,
} from "../core/collection-export.js";
import {
  fetchStorageReport,
  summarizeStorageReport,
  LAYOUT_LABELS,
  CONFIG_LABELS,
} from "../core/storage-report.js";
import {
  embedDataInPNG,
  extractDataFromPNG,
  downloadPNG,
  readPNGFile,
  convertToPNG,
  isVectHarePNG,
} from "../core/png-export.js";

/** VH-064: what kind of SillyTavern built-in collection a row is, in words. */
function stBuiltInLabel(kind) {
  return { chat: "a chat", file: "a file or Data Bank attachment", "world-info": "World Info" }[kind] ||
    "SillyTavern's Vector Storage";
}

// Plugin availability is managed by collection-loader.js.

// Browser state
let browserState = {
  isOpen: false,
  pluginAvailable: null,
  collections: [],
  selectedCollection: null,
  filters: {
    scope: "all", // 'all', 'global', 'character', 'chat'
    collectionType: "all", // 'all', 'chat', 'file', 'lorebook'
    searchQuery: "",
  },
  settings: null,
  // Bulk operations state
  bulkSelected: new Set(),
  bulkFilter: "all", // 'all', 'enabled', 'disabled'
  // Search state
  searchResults: null,
  isSearching: false,
  // Keyword filter state
  keywordFilter: '',
  availableKeywords: [],
  // PNG export state
  pendingPngExport: null,
  // Key of the collection whose Metadata window is open, so a refresh can
  // bring it up to date instead of leaving stale values on screen.
  openMetadataKey: null,
};

// Event binding flags (module-level for proper reset on modal close)
let searchEventsBound = false;
let bulkEventsBound = false;

// Qdrant scroll order is not conversation order. Chat chunks carry their
// original source position in metadata even when the list item has no index.
function getChatChunkSourceIndex(item, fallback) {
  const meta = item.metadata || {};
  const candidates = [
    meta.startIndex,
    meta.messageIndex,
    Array.isArray(meta.messageIds) ? meta.messageIds[0] : undefined,
    // messageId is a position only for VectHare's per-message chunks;
    // other records may use timestamps or unrelated external IDs.
    meta.strategy === "per_message" ? meta.messageId : undefined,
    meta.index,
    item.index,
  ];
  for (const candidate of candidates) {
    if (Number.isSafeInteger(candidate) && candidate >= 0) return candidate;
    if (typeof candidate === "string" && /^(0|[1-9]\d*)$/.test(candidate)) {
      const position = Number(candidate);
      if (Number.isSafeInteger(position)) return position;
    }
  }
  return fallback; // No trustworthy source index: preserve existing list order.
}

/**
 * Initializes the database browser
 * @param {object} settings VectHare settings
 */
export function initializeDatabaseBrowser(settings) {
  browserState.settings = settings;
  vhLog("VectHare Database Browser: Initialized");
}

/**
 * Opens the database browser modal
 */
export async function openDatabaseBrowser() {
  if (browserState.isOpen) {
    vhLog("VectHare Database Browser: Already open");
    return;
  }

  browserState.isOpen = true;

  // Refresh plugin availability whenever the Database Browser opens.
  browserState.pluginAvailable = await checkPluginAvailable(true);

  // Create modal if it doesn't exist
  if ($("#vecthare_database_browser_modal").length === 0) {
    createBrowserModal();
  }

  // Show/hide plugin warning banner
  updatePluginWarningBanner();

  // Load collections (fast: what is already known)
  await refreshCollections();

  // Show modal
  $("#vecthare_database_browser_modal").fadeIn(200);
  vhLog("VectHare Database Browser: Opened");

  // Then the same read-only refresh as Resync, in the background: re-read
  // VectHare's metadata file, drop the cached server listing, re-check every
  // collection where it lives, and update the list in place.
  refreshCollections({ reloadStore: true, invalidateInventory: true }).catch((error) =>
    console.warn("VectHare: Background resync of the Database Browser failed:", error));
}

/**
 * Updates the plugin warning banner visibility
 */
function updatePluginWarningBanner() {
  const banner = $("#vecthare_plugin_warning_banner");
  if (browserState.pluginAvailable) {
    banner.hide();
  } else {
    banner.show();
  }
}

/**
 * Closes the database browser modal
 */
export function closeDatabaseBrowser() {
  $("#vecthare_database_browser_modal").fadeOut(200);
  browserState.isOpen = false;
  // Reset event bound flags for clean rebind on next open
  resetEventFlags();
  vhLog("VectHare Database Browser: Closed");
}

/**
 * Resets event bound flags (called on modal close)
 */
function resetEventFlags() {
  // Reset flags so events rebind properly on next modal open
  bulkEventsBound = false;
  searchEventsBound = false;
}

/**
 * Creates the browser modal HTML structure
 */
function createBrowserModal() {
  const modalHtml = `
        <div id="vecthare_database_browser_modal" class="vecthare-modal">
            <div class="vecthare-modal-content vecthare-database-browser-content">
                <!-- Header -->
                <div class="vecthare-modal-header">
                    <h3>🗃️ VectHare Database Browser</h3>
                    <button class="vecthare-btn-icon" id="vecthare_browser_close">✕</button>
                </div>

                <!-- Plugin Warning Banner (hidden by default, shown when plugin unavailable) -->
                <div id="vecthare_plugin_warning_banner" class="vecthare-warning-banner" style="display: none;">
                    <i class="fa-solid fa-triangle-exclamation" style="color: var(--SmartThemeQuoteColor);"></i>
                    <div class="vecthare-warning-text">
                        <strong>Limited Discovery Mode</strong>
                        <span>Similharity plugin not detected. Only registered collections and current chat can be discovered.
                        Collections created outside VectHare won't appear here.
                        <a href="https://github.com/Samrwk99/Similharity-VectHare-Plugin" target="_blank">Install the plugin</a> for full filesystem scanning.</span>
                    </div>
                </div>

                <!-- Browser Tabs -->
                <div class="vecthare-browser-tabs">
                    <button class="vecthare-tab-btn active" data-tab="collections">
                        ${icons.folder(16)} Collections
                    </button>
                    <button class="vecthare-tab-btn" data-tab="search">
                        ${icons.search(16)} Search
                    </button>
                    <button class="vecthare-tab-btn" data-tab="bulk">
                        ${icons.listChecks(16)} Bulk Operations
                    </button>
                    <button class="vecthare-tab-btn" data-tab="storage" title="Read-only report: where each collection is physically stored">
                        ${icons.database(16)} Storage
                    </button>
                </div>

                <!-- Tab Content -->
                <div class="vecthare-browser-content">
                    <!-- Collections Tab -->
                    <div id="vecthare_tab_collections" class="vecthare-tab-content active">
                        <!-- Scope Filters (V1-style) -->
                        <div class="vecthare-scope-filters">
                            <button class="vecthare-scope-filter active" data-scope="all" title="Show all collections">All</button>
                            <button class="vecthare-scope-filter" data-scope="global" title="Global = collections set to 'Always Active'">Global</button>
                            <button class="vecthare-scope-filter" data-scope="character" title="Character = collections locked to at least one character">Character</button>
                            <button class="vecthare-scope-filter" data-scope="chat" title="Chat = collections locked to at least one chat">Chat</button>
                            <button class="vecthare-scope-filter" data-scope="unbound" title="Chat collections no chat is bound to: deleted chats, kept old collections after a rebuild, unassigned legacy collections. Select them in Bulk Operations to delete several at once.">Not bound to a chat</button>
                            <button id="vecthare_empty_deleted" class="vecthare-btn vecthare-btn-sm vecthare-btn-danger" style="display: none;" title="Purge the vectors of every deleted chat's kept collection now (verified delete)">Empty deleted</button>

                            <!-- Small badge and hint describing current scope filter -->
                        </div>

                        <!-- Type Filters -->
                        <div class="vecthare-type-filters">
                            <label>
                                <input type="radio" name="vecthare_type_filter" value="all" checked>
                                All Types
                            </label>
                            <label>
                                <input type="radio" name="vecthare_type_filter" value="chat">
                                ${icons.messageSquare(14)} Chats
                            </label>
                            <label>
                                <input type="radio" name="vecthare_type_filter" value="lorebook">
                                ${icons.bookOpen(14)} Lorebooks
                            </label>
                            <label>
                                <input type="radio" name="vecthare_type_filter" value="character">
                                ${icons.user(14)} Characters
                            </label>
                            <label>
                                <input type="radio" name="vecthare_type_filter" value="document">
                                ${icons.fileText(14)} Documents
                            </label>
                            <label>
                                <input type="radio" name="vecthare_type_filter" value="web">
                                ${icons.globe(14)} Web
                            </label>
                        </div>

                        <!-- Search Box -->
                        <div class="vecthare-search-box">
                            <input type="text"
                                   id="vecthare_collection_search"
                                   placeholder="Search collections..."
                                   autocomplete="off">
                        </div>

                        <!-- Collections List -->
                        <div id="vecthare_collections_list" class="vecthare-collections-list">
                            <div class="vecthare-loading">Loading collections...</div>
                        </div>

                        <!-- Stats Footer -->
                        <div class="vecthare-browser-stats">
                            <span id="vecthare_browser_stats_text">No collections</span>
                            <div class="vecthare-browser-actions">
                                <button id="vecthare_import_collection" class="vecthare-btn-sm" title="Import collection from file">
                                    📥 Import
                                </button>
                                <button id="vecthare_reset_registry" class="vecthare-reset-btn" title="Clear registry and rescan from disk">
                                    <i class="fa-solid fa-arrows-rotate"></i> Resync
                                </button>
                            </div>
                        </div>
                        <!-- Hidden file inputs for import -->
                        <input type="file" id="vecthare_import_file" accept=".json,.vecthare.json,.png,image/png" style="display: none;">
                        <input type="file" id="vecthare_png_image_picker" accept="image/*" style="display: none;">
                    </div>

                    <!-- Search Tab -->
                    <div id="vecthare_tab_search" class="vecthare-tab-content">
                        <div class="vecthare-search-panel">
                            <!-- Search Input -->
                            <div class="vecthare-search-input-row">
                                <input type="text"
                                       id="vecthare_semantic_search"
                                       class="vecthare-search-input"
                                       placeholder="Search across all collections..."
                                       autocomplete="off">
                                <button id="vecthare_search_btn" class="vecthare-btn vecthare-btn-primary">
                                    ${icons.search(16)} Search
                                </button>
                            </div>

                            <!-- Search Options -->
                            <div class="vecthare-search-options">
                                <div class="vecthare-search-option">
                                    <label>Results per collection:</label>
                                    <input type="number" id="vecthare_search_topk" value="5" min="1" max="50">
                                </div>
                                <div class="vecthare-search-option">
                                    <label>Min score:</label>
                                    <input type="number" id="vecthare_search_threshold" value="0.3" min="0" max="1" step="0.05">
                                </div>
                                <div class="vecthare-search-option">
                                    <label>
                                        <input type="checkbox" id="vecthare_search_enabled_only" checked>
                                        Enabled collections only
                                    </label>
                                </div>
                            </div>

                            <!-- Keyword Filter -->
                            <div class="vecthare-keyword-filter-section">
                                <div class="vecthare-keyword-filter-header">
                                    ${icons.filter(16)} <span>Keyword Filter</span>
                                    <button id="vecthare_scan_keywords" class="vecthare-btn-sm" title="Scan all collections for keywords">
                                        <i class="fa-solid fa-sync"></i> Scan
                                    </button>
                                </div>
                                <div class="vecthare-keyword-filter-input-row">
                                    <input type="text"
                                           id="vecthare_keyword_filter"
                                           class="vecthare-keyword-filter-input"
                                           placeholder="Filter by keywords (comma-separated)..."
                                           autocomplete="off">
                                    <button id="vecthare_clear_keyword_filter" class="vecthare-btn-sm" title="Clear filter">
                                        ${icons.x(14)}
                                    </button>
                                </div>
                                <div id="vecthare_keyword_tags" class="vecthare-keyword-tags">
                                    <span class="vecthare-keyword-hint">Click "Scan" to discover keywords in your collections</span>
                                </div>
                            </div>

                            <!-- Search Results -->
                            <div id="vecthare_search_results" class="vecthare-search-results">
                                <div class="vecthare-search-empty">
                                    ${icons.search(48)}
                                    <p>Enter a query to search across all collections</p>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Bulk Operations Tab -->
                    <div id="vecthare_tab_bulk" class="vecthare-tab-content">
                        <div class="vecthare-bulk-panel">
                            <!-- Selection Info -->
                            <div class="vecthare-bulk-header">
                                <div class="vecthare-bulk-select-all">
                                    <label>
                                        <input type="checkbox" id="vecthare_bulk_select_all">
                                        Select All Visible
                                    </label>
                                    <span id="vecthare_bulk_count">0 selected</span>
                                </div>
                                <div class="vecthare-bulk-filter">
                                    <select id="vecthare_bulk_filter">
                                        <option value="all">All Collections</option>
                                        <option value="enabled">Enabled Only</option>
                                        <option value="disabled">Disabled Only</option>
                                        <option value="unbound">Not bound to a chat</option>
                                    </select>
                                </div>
                            </div>

                            <!-- Bulk Actions -->
                            <div class="vecthare-bulk-actions">
                                <button id="vecthare_bulk_enable" class="vecthare-btn vecthare-btn-sm" disabled>
                                    ${icons.toggleRight(16)} Enable Selected
                                </button>
                                <button id="vecthare_bulk_disable" class="vecthare-btn vecthare-btn-sm" disabled>
                                    ${icons.toggleLeft(16)} Disable Selected
                                </button>
                                <button id="vecthare_bulk_export" class="vecthare-btn vecthare-btn-sm" disabled>
                                    ${icons.download(16)} Export Selected
                                </button>
                                <button id="vecthare_bulk_delete" class="vecthare-btn vecthare-btn-sm vecthare-btn-danger" disabled>
                                    ${icons.trash(16)} Delete Selected
                                </button>
                            </div>

                            <!-- Collection List with Checkboxes -->
                            <div id="vecthare_bulk_list" class="vecthare-bulk-list">
                                <div class="vecthare-loading">Loading collections...</div>
                            </div>
                        </div>
                    </div>

                    <!-- Storage Tab (Step 9a: read-only storage report) -->
                    <div id="vecthare_tab_storage" class="vecthare-tab-content">
                        <div class="vecthare-bulk-panel vecthare-storage-panel">
                            <div class="vecthare-bulk-header">
                                <span class="vecthare-storage-intro">Read-only. Shows where each collection's vectors and saved original settings are, as the server sees them. Changes nothing.</span>
                                <div class="vecthare-bulk-actions">
                                    <select id="vecthare_storage_filter" title="Which collections to list">
                                        <option value="all">All collections</option>
                                        <option value="attention">Needs attention</option>
                                    </select>
                                    <button id="vecthare_storage_run" class="vecthare-btn vecthare-btn-sm vecthare-btn-primary">
                                        ${icons.database(16)} Run report
                                    </button>
                                    <button id="vecthare_storage_locate" class="vecthare-btn vecthare-btn-sm" title="Read-only check of where each Qdrant/Milvus collection of the selected backend is, and record it (a pointer in VectHare's metadata). Collections found in no place or in more than one are left alone.">
                                        ${icons.target(16)} Record locations
                                    </button>
                                    <button id="vecthare_storage_copy" class="vecthare-btn vecthare-btn-sm" disabled title="Copy the full report as JSON (to keep as a baseline or share it)">
                                        ${icons.download(16)} Copy as JSON
                                    </button>
                                </div>
                            </div>
                            <div id="vecthare_storage_output" class="vecthare-storage-output">
                                <div class="vecthare-search-empty">
                                    ${icons.database(48)}
                                    <p>Run the report to see where your collections are stored. It only reads.</p>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;

  $("body").append(modalHtml);

  // Bind events
  bindBrowserEvents();
}

/**
 * Binds event handlers for browser UI
 */
function bindBrowserEvents() {
  // Close button
  $("#vecthare_browser_close").on("click", function (e) {
    e.stopPropagation();
    e.preventDefault();
    closeDatabaseBrowser();
  });

  // Stop propagation on mousedown (ST listens on mousedown to close drawers)
  // This prevents the drawer from closing when clicking inside the modal
  $("#vecthare_database_browser_modal").on("mousedown touchstart", function (e) {
    e.stopPropagation();
  });

  // Close when clicking directly on the modal background (overlay)
  $("#vecthare_database_browser_modal").on("click", function (e) {
    if (e.target === this) {
      e.preventDefault();
      closeDatabaseBrowser();
    }
  });

  // Tab switching
  $(".vecthare-tab-btn").on("click", function (e) {
    e.stopPropagation();
    e.preventDefault();
    const tab = $(this).data("tab");
    switchTab(tab);
  });

  // Scope filters
  $(".vecthare-scope-filter").on("click", function (e) {
    e.stopPropagation();
    e.preventDefault();
    $(".vecthare-scope-filter").removeClass("active");
    $(this).addClass("active");
    browserState.filters.scope = $(this).data("scope");
    renderCollections();
  });

  // N2: purge every deleted chat's kept collection now (verified path).
  $("#vecthare_empty_deleted").on("click", async function (e) {
    e.stopPropagation();
    e.preventDefault();
    const count = listDeletedChatCollections().length;
    if (!count) return;
    if (!confirm(`Purge the vectors of ${count} deleted chat(s)?\n\nThey are not used by any chat. This cannot be undone.`)) return;
    const button = $(this);
    button.prop("disabled", true);
    // S6: show the purge in the Status panel when no other run owns it.
    const panelRun = progressTracker.beginCounted("Purging Deleted Chats", count, "Collections");
    try {
      const { isChatSynchronizationActive, isVectorizationActive } = await import("../core/chat-vectorization.js");
      const results = await purgeDeletedChats(browserState.settings, {
        isBusy: () => isChatSynchronizationActive() || isVectorizationActive(),
        onProgress: ({ done, total, id }) =>
          progressTracker.countedStep(panelRun, "Purging collections", done, total, id != null),
      });
      if (panelRun != null && progressTracker.isCurrentRun(panelRun)) progressTracker.setPhase("Refreshing the list…");
      await refreshCollections({ reloadStore: true, invalidateInventory: true });
      const purged = results.filter((r) => r.success).length;
      const keptResults = results.filter((r) => !r.success);
      if (panelRun != null) {
        for (const r of keptResults) progressTracker.addError(`Kept ${r.id}: ${r.reason || "not confirmed"}`);
        progressTracker.complete(keptResults.length === 0,
          `Purged ${purged}${keptResults.length ? `; kept ${keptResults.length}` : ""}`, panelRun);
      }
      if (keptResults.length) {
        toastr.warning(
          `Purged ${purged}; kept ${keptResults.length}: ` +
            keptResults.map((r) => r.reason).filter(Boolean).slice(0, 3).join("; "),
          "VectHare",
          { timeOut: 15000 },
        );
      } else {
        toastr.success(`Purged ${purged} deleted chat collection(s)`, "VectHare");
      }
    } catch (error) {
      if (panelRun != null) {
        progressTracker.addError(error.message);
        progressTracker.complete(false, "Empty deleted failed", panelRun);
      }
      toastr.error(`Empty deleted failed: ${error.message}`, "VectHare");
    } finally {
      button.prop("disabled", false);
    }
  });

  // Type filters
  $('input[name="vecthare_type_filter"]').on("change", function (e) {
    e.stopPropagation();
    browserState.filters.collectionType = $(this).val();
    renderCollections();
  });

  // Search input
  $("#vecthare_collection_search").on("input", function (e) {
    e.stopPropagation();
    browserState.filters.searchQuery = $(this).val().toLowerCase();
    renderCollections();
  });

  // Resync - a READ-ONLY refresh of the whole Browser state. It re-reads
  // VectHare's authoritative metadata document, drops the cached backend
  // inventory, re-checks physical existence at each entry's own recorded
  // destination, and rebuilds the list, the labels, the buttons, the open
  // Metadata window and the footer counts. It deletes nothing, regenerates
  // nothing, vectorizes nothing and never touches a chat binding - so it needs
  // no confirmation. It used to clear the registry first, which was a
  // destructive step a display refresh has no business taking.
  $("#vecthare_reset_registry").on("click", async function (e) {
    e.stopPropagation();
    e.preventDefault();

    const button = $(this);
    if (button.prop("disabled")) return;
    const original = button.html();
    button.prop("disabled", true).html('<i class="fa-solid fa-arrows-rotate fa-spin"></i> Resyncing');

    // S6: shown in the Status panel when no other run owns it.
    const panelRun = progressTracker.beginCounted("Resyncing Collections", 0, "Collections");
    try {
      await refreshCollections({
        reloadStore: true, invalidateInventory: true,
        onPhase: (text) => { if (panelRun != null && progressTracker.isCurrentRun(panelRun)) progressTracker.setPhase(text); },
        onProgress: ({ done, total }) =>
          progressTracker.countedStep(panelRun, "Checking collections", done, total, done < total),
      });

      const rows = browserState.collections || [];
      const physical = rows.filter((c) => c.existence === "present").length;
      const metadataOnly = rows.filter((c) => c.presence === "metadata-only").length;
      const unresolved = rows.length - physical - metadataOnly;
      // Same buckets as the footer, so the message and the counts agree.
      const reload = browserState.lastStoreReload;
      const resyncClean = !(reload && reload.reloaded === false && reload.reason);
      if (panelRun != null) {
        if (!resyncClean) progressTracker.addError(`VectHare's metadata file was not re-read: ${reload.reason}`);
        progressTracker.complete(resyncClean,
          `${physical} collection(s), ${metadataOnly} metadata-only${unresolved ? `, ${unresolved} unresolved` : ""}`,
          panelRun);
        // A clean read-only refresh needs no attention: close its panel again.
        if (resyncClean) {
          setTimeout(() => {
            if (progressTracker.isCurrentRun(panelRun) && progressTracker.isComplete &&
                !progressTracker.isPaused) progressTracker.hide();
          }, 1500);
        }
      }

      if (reload && reload.reloaded === false && reload.reason) {
        // The list is still rebuilt from the working copy, but say plainly
        // that the stored document itself was not re-read.
        toastr.warning(
          `Resynced backends, but VectHare's metadata file was not re-read: ${reload.reason}`,
          "VectHare",
          { timeOut: 0, extendedTimeOut: 0 },
        );
      } else {
        toastr.success(
          `Resynced: ${physical} collection(s), ${metadataOnly} metadata-only` +
            `${unresolved ? `, ${unresolved} unresolved` : ""}`,
          "VectHare",
        );
      }
    } catch (error) {
      console.error("VectHare: Failed to resync", error);
      if (panelRun != null) {
        progressTracker.addError(error.message);
        progressTracker.complete(false, "Resync failed", panelRun);
      }
      toastr.error(`Failed to resync: ${error.message}`, "VectHare");
    } finally {
      button.prop("disabled", false).html(original);
    }
  });

  // Keyboard shortcuts
  $(document).on("keydown.vecthare_browser", function (e) {
    if (!browserState.isOpen) return;

    if (e.key === "Escape") {
      closeDatabaseBrowser();
    }
  });

  // Import button
  $("#vecthare_import_collection").on("click", function (e) {
    e.stopPropagation();
    $("#vecthare_import_file").click();
  });

  // Import file handler (supports JSON and PNG)
  $("#vecthare_import_file").on("change", async function (e) {
    const file = e.target.files[0];
    if (!file) return;

    // Reset input so same file can be selected again
    $(this).val("");

    try {
      toastr.info("Reading import file...", "VectHare");

      let data;

      // Check if it's a PNG file
      if (
        file.type === "image/png" ||
        file.name.toLowerCase().endsWith(".png")
      ) {
        const pngData = await readPNGFile(file);
        data = await extractDataFromPNG(pngData);

        if (!data) {
          toastr.error(
            "This PNG does not contain VectHare data.",
            "VectHare Import",
          );
          return;
        }

        toastr.info("Found VectHare data in PNG!", "VectHare");
      } else {
        // JSON file
        data = await readImportFile(file);
      }

      const info = getExportInfo(data);
      const validation = validateImportData(data, browserState.settings);

      // Show import confirmation dialog
      let message = `Import "${info.collections[0]?.name || "collection"}"?\n\n`;
      message += `• ${info.totalChunks} chunks\n`;
      message += `• ${info.totalChunksWithVectors} with vectors\n`;

      if (info.embedding) {
        message += `\nEmbedding: ${info.embedding.source}/${info.embedding.model || "default"}\n`;
        message += `Dimension: ${info.embedding.dimension || "unknown"}\n`;
      }

      if (validation.warnings.length > 0) {
        message += `\n⚠️ Warnings:\n`;
        validation.warnings.forEach((w) => {
          message += `• ${w}\n`;
        });
      }

      if (!validation.compatible && info.totalChunksWithVectors > 0) {
        message += `\n⚠️ Your embedding settings don't match.\n`;
        message += `To use existing vectors, change your settings to:\n`;
        message += `  Source: ${info.embedding?.source || "unknown"}\n`;
        message += `  Model: ${info.embedding?.model || "default"}\n`;
        message += `\nOr continue to re-embed with current settings.`;
      }

      if (!validation.valid) {
        toastr.error(
          `Invalid export file:\n${validation.errors.join("\n")}`,
          "VectHare Import",
        );
        return;
      }

      const confirmed = confirm(message);
      if (!confirmed) return;

      // Perform import
      // VH-046: import as new unless the collection exists; replacing asks first.
      const result = await importCollectionFromFile(data, browserState.settings, {
        confirmReplace: (id) =>
          confirm(
            `A collection "${id}" already exists here.\n\nReplace it with the imported one? Its current contents will be removed.`,
          ),
      });
      if (result.cancelled) {
        toastr.info("Import cancelled; the existing collection was not changed.", "VectHare Import");
        return;
      }

      if (result.success) {
        const vectorMsg = result.usedVectors
          ? "(used existing vectors)"
          : "(re-embedded)";
        toastr.success(
          `Imported ${result.chunkCount} chunks ${vectorMsg}`,
          "VectHare Import",
        );

        // Refresh collections list (as Resync does)
        await refreshCollections({ reloadStore: true, invalidateInventory: true });
      }
    } catch (error) {
      console.error("VectHare: Import failed", error);
      toastr.error(`Import failed: ${error.message}`, "VectHare");
    }
  });
}


/**
 * Switches active tab
 * @param {string} tabName Tab identifier
 */
function switchTab(tabName) {
  $(".vecthare-tab-btn").removeClass("active");
  $(`.vecthare-tab-btn[data-tab="${tabName}"]`).addClass("active");

  $(".vecthare-tab-content").removeClass("active");
  $(`#vecthare_tab_${tabName}`).addClass("active");

  // Initialize tab-specific content
  if (tabName === "bulk") {
    renderBulkList();
    bindBulkEvents();
  } else if (tabName === "search") {
    bindSearchEvents();
  } else if (tabName === "storage") {
    bindStorageEvents();
  }
}

// ============================================================================
// STORAGE TAB (Step 9a / P1) - read-only storage report
// ============================================================================

let storageReportState = { report: null, running: false };

function bindStorageEvents() {
  $("#vecthare_storage_run").off("click.vhStorage").on("click.vhStorage", async function (e) {
    e.stopPropagation();
    e.preventDefault();
    if (storageReportState.running) return;
    storageReportState.running = true;
    const button = $(this);
    button.prop("disabled", true);
    $("#vecthare_storage_output").html('<div class="vecthare-loading">Reading every backend… (large shared stores take a while)</div>');
    try {
      const result = await fetchStorageReport(browserState.settings);
      if (!result.ok) {
        storageReportState.report = null;
        $("#vecthare_storage_copy").prop("disabled", true);
        $("#vecthare_storage_output").html(`<div class="vecthare-error">${escapeHtml(result.reason)}</div>`);
        return;
      }
      storageReportState.report = result.report;
      $("#vecthare_storage_copy").prop("disabled", false);
      renderStorageReport();
    } finally {
      storageReportState.running = false;
      button.prop("disabled", false);
    }
  });
  $("#vecthare_storage_locate").off("click.vhStorage").on("click.vhStorage", async function (e) {
    e.stopPropagation();
    e.preventDefault();
    if (storageReportState.running) return;
    const backend = browserState.settings?.vector_backend || "standard";
    if (!["qdrant", "milvus"].includes(backend)) {
      toastr.info("Only Qdrant and Milvus collections have more than one possible location. Select that backend first.", "VectHare");
      return;
    }
    storageReportState.running = true;
    const button = $(this);
    button.prop("disabled", true);
    try {
      const result = await fillStorageLocators(browserState.settings);
      const parts = [`${result.recorded} recorded`, `${result.checked} checked`];
      if (result.unavailable) parts.push(`${result.unavailable} could not be read`);
      if (result.conflicts.length) parts.push(`${result.conflicts.length} found in more than one place (writes blocked)`);
      (result.conflicts.length || result.unavailable ? toastr.warning : toastr.success)(
        `Storage locations: ${parts.join(", ")}`, "VectHare", { timeOut: 8000 });
    } catch (error) {
      toastr.error(`Recording locations failed: ${error.message}`, "VectHare");
    } finally {
      storageReportState.running = false;
      button.prop("disabled", false);
    }
    $("#vecthare_storage_run").trigger("click");
  });
  $("#vecthare_storage_filter").off("change.vhStorage").on("change.vhStorage", function (e) {
    e.stopPropagation();
    if (storageReportState.report) renderStorageReport();
  });
  $("#vecthare_storage_copy").off("click.vhStorage").on("click.vhStorage", async function (e) {
    e.stopPropagation();
    e.preventDefault();
    const report = storageReportState.report;
    if (!report) return;
    const text = JSON.stringify(report, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      toastr.success("Storage report copied as JSON", "VectHare");
    } catch {
      // Clipboard can be unavailable (http, permissions): offer it as a file.
      const blob = new Blob([text], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `vecthare-storage-report-${report.generatedAt?.replace(/[:.]/g, "-") || "now"}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  });
}

function storageRowNeedsAttention(row) {
  return ["conflict", "not-found", "unknown"].includes(row.layout) ||
    (row.savedConfig && row.savedConfig.status !== "found") ||
    (row.todayRule?.agrees === false && !row.locatorAgrees) ||
    (row.locator && !row.locatorAgrees);
}

function formatStorageCount(row) {
  if (Number.isSafeInteger(row.count)) return `${row.count}${row.countNote ? ` (${row.countNote})` : ""}`;
  return "?";
}

function renderStorageReport() {
  const report = storageReportState.report;
  if (!report) return;
  const filter = $("#vecthare_storage_filter").val();
  const rows = (report.collections || []).filter((r) => filter !== "attention" || storageRowNeedsAttention(r));
  const summary = summarizeStorageReport(report)
    .map((line) => `<div>${escapeHtml(line)}</div>`).join("");
  const warnings = (report.warnings || []).map((w) => `<div class="vecthare-error">${escapeHtml(w)}</div>`).join("");
  const backendErrors = Object.entries(report.backends || {})
    .filter(([, b]) => b.error)
    .map(([name, b]) => `<div class="vecthare-error">${escapeHtml(name)}: ${escapeHtml(b.error)}</div>`).join("");

  const rowHtml = rows.map((r) => {
    const cfg = r.savedConfig || {};
    const where = cfg.location || (cfg.locations || []).join(", ");
    const physical = r.physical || (r.locations || []).map((l) => l.physical).join(", ") || "—";
    const notes = [
      ...(r.notes || []),
      ...(r.error ? [r.error] : []),
      ...(r.assumedBackend ? ["no backend recorded: checked on today's backend"] : []),
      ...(r.todayRule?.agrees === false
        ? [r.locatorAgrees ? `today's switch points elsewhere (${r.todayRule.physical}); the recorded location is used`
          : `today's settings would look in ${r.todayRule.physical || r.todayRule.source}`] : []),
      ...(r.locator ? [r.locatorAgrees ? "location recorded" : `recorded location (${r.locator.physical}) does not match`]
        : (["qdrant", "milvus"].includes(r.backend) && r.physical ? ["location not recorded yet"] : [])),
      ...(cfg.reason && cfg.status !== "found" ? [cfg.reason] : []),
    ];
    return `
      <tr class="${storageRowNeedsAttention(r) ? "vecthare-storage-attention" : ""}">
        <td title="${escapeHtml((r.hints || []).join(", ")).replace(/"/g, "&quot;")}">${escapeHtml(r.collectionId)}</td>
        <td>${escapeHtml(r.backend)}</td>
        <td>${escapeHtml(LAYOUT_LABELS[r.layout] || r.layout)}</td>
        <td>${escapeHtml(physical)}${Number.isSafeInteger(r.dim) ? ` <small>(${r.dim}-dim)</small>` : ""}</td>
        <td>${escapeHtml(formatStorageCount(r))}</td>
        <td>${escapeHtml(CONFIG_LABELS[cfg.status] || cfg.status || "?")}${where ? ` <small>${escapeHtml(where)}</small>` : ""}</td>
        <td><small>${escapeHtml(notes.join("; "))}</small></td>
      </tr>${(r.oldCopies || []).map((copy) => `
      <tr class="vecthare-storage-oldcopy">
        <td><small>${copy.pending ? "↳ leftover copy from an unfinished move" : "↳ old copy (moved)"}</small></td>
        <td>${escapeHtml(copy.backend || r.backend)}</td>
        <td>${escapeHtml(LAYOUT_LABELS[copy.layout] || copy.layout)}</td>
        <td>${escapeHtml(copy.physical || "(not known yet)")}</td>
        <td>${escapeHtml(formatStorageCount(copy))}</td>
        <td>${copy.config ? escapeHtml(CONFIG_LABELS[copy.config.status] || copy.config.status || "") : ""}</td>
        <td><small>${escapeHtml([copy.movedAt ? `moved ${new Date(copy.movedAt).toLocaleString()}` : "",
          copy.pending && copy.startedAt ? `move started ${new Date(copy.startedAt).toLocaleString()}, not finished` : "", copy.note || "",
          copy.foreignOwner ? `owner stamp: ${copy.foreignOwner}` : ""].filter(Boolean).join("; "))}</small>
          <button class="vecthare-btn-sm vecthare-btn-danger vecthare-storage-delete-old"
                  data-collection-id="${escapeHtml(r.collectionId).replace(/"/g, "&quot;")}"
                  data-backend="${escapeHtml(copy.backend || r.backend)}"
                  data-layout="${escapeHtml(copy.layout)}"
                  data-pending="${copy.pending ? "1" : ""}"
                  data-physical="${escapeHtml(copy.physical || "").replace(/"/g, "&quot;")}">${copy.pending ? "Delete leftover copy" : "Delete old copy"}</button></td>
      </tr>`).join("")}`;
  }).join("");

  const sharedHtml = (report.sharedStores || []).map((s) => {
    const parts = [];
    if (s.error) parts.push(`error: ${s.error}`);
    if (Number.isSafeInteger(s.total)) parts.push(`${s.total} vectors`);
    if (s.dim) parts.push(`${s.dim}-dim`);
    if (Number.isSafeInteger(s.withoutContentType)) parts.push(`${s.withoutContentType} without a collection tag`);
    if (Number.isSafeInteger(s.notAttributed)) parts.push(`${s.notAttributed} not attributed to your records`);
    if (s.hidden) parts.push(`${s.hidden.contentTypes} other collection(s) / ${s.hidden.points} vectors hidden (other users)`);
    if (s.truncated) parts.push("scan capped");
    const types = (s.byContentType || []).map((t) =>
      `<li>${escapeHtml(t.contentType)}: ${Number(t.count) || 0}${t.recorded ? "" : " <small>(no VectHare record)</small>"}</li>`).join("");
    return `<div class="vecthare-bulk-item vecthare-storage-store">
        <div class="vecthare-bulk-item-info">
          <div class="vecthare-bulk-item-name">${escapeHtml(s.backend)}: ${escapeHtml(s.name)} <small>(kept: shared store)</small></div>
          <div class="vecthare-bulk-item-meta">${escapeHtml(parts.join(" · "))}</div>
          ${types ? `<details><summary>Per collection</summary><ul>${types}</ul></details>` : ""}
        </div>
      </div>`;
  }).join("");

  const hiddenUnref = Object.entries(report.unreferencedHidden || {}).map(([b, n]) => `${n} on ${b}`).join(", ");
  const unrefHtml = (report.unreferenced || []).map((u) =>
    `<li>${escapeHtml(u.backend)}: ${escapeHtml(u.name)}${Number.isSafeInteger(u.count) ? ` (${u.count})` : ""}</li>`).join("");

  $("#vecthare_storage_output").html(`
    <div class="vecthare-search-summary">${summary}
      <div><small>Generated ${escapeHtml(new Date(report.generatedAt).toLocaleString())}. Metadata file: ${escapeHtml(report.state?.status || "?")}${report.state?.token ? ` (${escapeHtml(report.state.token)})` : ""}.</small></div>
    </div>
    ${warnings}${backendErrors}
    ${rows.length ? `
    <div class="vecthare-storage-table-wrap">
      <table class="vecthare-storage-table">
        <thead><tr><th>Collection</th><th>Backend</th><th>Layout</th><th>Physical store</th><th>Vectors</th><th>Saved settings</th><th>Notes</th></tr></thead>
        <tbody>${rowHtml}</tbody>
      </table>
    </div>` : `<div class="vecthare-empty-state"><p>${filter === "attention" ? "Nothing needs attention." : "No collections recorded."}</p></div>`}
    ${sharedHtml ? `<h4>Shared stores</h4>${sharedHtml}` : ""}
    ${unrefHtml || hiddenUnref ? `<h4>Physical stores no VectHare record points at</h4><ul>${unrefHtml}</ul>${hiddenUnref ? `<small>Hidden (may belong to other users): ${escapeHtml(hiddenUnref)}</small>` : ""}` : ""}
  `);
  $("#vecthare_storage_output .vecthare-storage-delete-old").off("click.vhStorage").on("click.vhStorage", async function (e) {
    e.stopPropagation();
    e.preventDefault();
    const button = $(this);
    const collectionId = String(button.data("collection-id"));
    const which = { layout: String(button.data("layout")), physical: String(button.data("physical") || "") };
    const backend = String(button.data("backend"));
    const pending = String(button.data("pending") || "") === "1";
    // VH-010: a leftover copy is the target of a move that did not finish.
    const message = pending
      ? `Delete the leftover copy of "${collectionId}" in ${LAYOUT_LABELS[which.layout] || which.layout}${which.physical ? ` (${which.physical})` : ""}?\n\n` +
        "A move of this collection did not finish; the collection still lives where it was. This removes the unfinished copy's vectors and saved settings and cannot be undone."
      : `Delete the old copy of "${collectionId}" in ${LAYOUT_LABELS[which.layout] || which.layout} (${which.physical})?\n\n` +
        "The collection itself is not affected: it now lives elsewhere. This removes the old copy's vectors and saved settings and cannot be undone.";
    if (!confirm(message)) return;
    button.prop("disabled", true);
    const result = await deleteOldStorageCopy(collectionId, { ...browserState.settings, vector_backend: backend }, which);
    if (result.success) {
      toastr.success(`${pending ? "Leftover" : "Old"} copy${which.physical ? ` in ${which.physical}` : ""} deleted.${result.warnings.length ? ` ${result.warnings.join(" ")}` : ""}`, "VectHare");
      $("#vecthare_storage_run").trigger("click");
    } else {
      toastr.warning(result.reason, "VectHare: Delete old copy", { timeOut: 10000 });
      button.prop("disabled", false);
    }
  });
}

/**
 * 9c: lists a collection's chunks for display. Qdrant/Milvus go through their
 * adapter (storage resolver + scope): a direct call named the logical id as the
 * physical store, which is empty under Qdrant multitenancy and refused by
 * Milvus. Local backends keep the direct call (it addresses the exact model
 * folder the Browser discovered).
 */
async function listCollectionChunksForBrowser(collection, collectionSettings, requestBody) {
  if (["qdrant", "milvus"].includes(collection.backend)) {
    const { getBackend } = await import("../backends/backend-manager.js");
    const adapter = await getBackend(collectionSettings);
    return await adapter.listChunks(collection.id, collectionSettings, { offset: 0, limit: requestBody.limit });
  }
  const response = await fetch("/api/plugins/similharity/chunks/list", {
    method: "POST",
    headers: getRequestHeaders(),
    body: JSON.stringify(requestBody),
  });
  if (!response.ok) {
    throw new Error(`Failed to list chunks: ${response.statusText}`);
  }
  return await response.json();
}

// Refreshes run one at a time (opening, Resync and actions can overlap).
let refreshChain = Promise.resolve();

/**
 * Refreshes collections from storage. Queued behind any refresh in progress.
 */
function refreshCollections(options = {}) {
  const run = refreshChain.then(() => refreshCollectionsNow(options));
  refreshChain = run.catch(() => {});
  return run;
}

async function refreshCollectionsNow(options = {}) {
  try {
    // Resync asks for the authoritative metadata document to be re-read and
    // the cached backend inventory to be dropped, so the rebuilt list comes
    // from what is actually persisted and actually present - never from the
    // in-memory working copy or from counts gathered before a change. Both
    // are read-only with respect to stored state.
    if (options.invalidateInventory) invalidateCollectionInventory();
    if (options.reloadStore) {
      options.onPhase?.("Reading VectHare metadata…");
      const reload = await reloadVectHareStore();
      browserState.lastStoreReload = reload;
      if (!reload.reloaded && reload.reason) {
        console.warn(`VectHare: Metadata was not re-read (${reload.reason})`);
      }
    }

    // Read-only: a Browser refresh (and Resync) reports what the backends
    // hold and what VectHare has stored, and writes nothing - no registry
    // pruning, no re-registration, no metadata cleanup.
    options.onPhase?.("Discovering collections…");
    browserState.collections = await loadAllCollections(browserState.settings, true,
        { readOnly: true, onProgress: options.onProgress });

    // Phase 2: refreshing the Browser no longer deletes "orphaned" metadata.
    // A backend error or an incomplete listing must never be read as absence,
    // and metadata-only records have to stay visible so they can be inspected
    // and removed deliberately (View Metadata / Delete Metadata).

    // Keep the user's place when the list is rebuilt (a background resync
    // must not jump the list back to the top).
    const list = $("#vecthare_collections_list");
    const scrollers = [list, list.parent()].map((el) => [el, el.scrollTop()]);
    renderCollections();
    for (const [el, top] of scrollers) if (top) el.scrollTop(top);
    await refreshOpenMetadataDialog();
  } catch (error) {
    console.error("VectHare: Failed to load collections", error);
    $("#vecthare_collections_list").html(`
            <div class="vecthare-error">
                Failed to load collections. Check console for details.
            </div>
        `);
  }
}

/**
 * U4: a chat collection no chat is bound to (deleted chat, kept old collection
 * after a rebuild, unassigned legacy collection). A rebuild still staging is
 * not listed: it is about to be bound.
 */
function isUnboundChatCollection(c) {
  const id = parseRegistryKey(c.id).collectionId || c.id;
  if (!String(id).startsWith("vecthare_chat_")) return false;
  if (getBoundChatDetails(id)) return false;
  return getCollectionMeta(id)?.rebuildState !== "staging";
}

/** Bulk-tab filter, shared by the list and "Select All Visible". */
function applyBulkFilter(collections) {
  const filter = browserState.bulkFilter;
  if (filter === "enabled") return collections.filter((c) => c.enabled);
  if (filter === "disabled") return collections.filter((c) => !c.enabled);
  if (filter === "unbound") return collections.filter((c) => isUnboundChatCollection(c));
  return collections;
}

/**
 * Renders collections list based on current filters
 */
function renderCollections() {
  const container = $("#vecthare_collections_list");
  // N2: "Empty deleted" only when deleted chats' collections are kept.
  try {
    const deletedCount = listDeletedChatCollections().length;
    $("#vecthare_empty_deleted")
      .toggle(deletedCount > 0)
      .text(deletedCount > 0 ? `Empty deleted (${deletedCount})` : "Empty deleted");
  } catch { /* button is optional */ }

    // Apply filters
    let filtered = browserState.collections.filter(c => {
        const scopeFilter = browserState.filters.scope;

        // Scope filter:
        // - 'all' => no filter
        // - 'global' => show collections explicitly set to alwaysActive
        // - 'chat' => show collections locked to at least one chat
        // - 'character' => show collections locked to at least one character
        // - otherwise: preserve legacy behavior (compare c.scope)
        if (scopeFilter !== 'all') {
            if (scopeFilter === 'global') {
                const meta = getCollectionMeta(c.id);
                if (!meta || meta.alwaysActive !== true) return false;
            } else if (scopeFilter === 'chat') {
                if (getCollectionLockCount(c.id) <= 0) return false;
            } else if (scopeFilter === 'character') {
                if (getCollectionCharacterLockCount(c.id) <= 0) return false;
            } else if (scopeFilter === 'unbound') {
                if (!isUnboundChatCollection(c)) return false;
            } else {
                if (c.scope !== scopeFilter) return false;
            }
        }

    // Type filter - map filter categories to actual collection types
    if (browserState.filters.collectionType !== "all") {
      const typeMap = {
        chat: ["chat"],
        lorebook: ["lorebook"],
        character: ["character", "persona"],
        document: ["file", "doc", "paste", "select", "current"],
        web: ["url", "wiki", "youtube"],
      };
      const allowedTypes = typeMap[browserState.filters.collectionType];
      if (allowedTypes && !allowedTypes.includes(c.type)) {
        return false;
      }
    }

    // Search filter
    if (browserState.filters.searchQuery) {
      const searchLower = browserState.filters.searchQuery;
      return (
        c.name.toLowerCase().includes(searchLower) ||
        c.id.toLowerCase().includes(searchLower)
      );
    }

    return true;
  });

  if (filtered.length === 0) {
    container.html(`
            <div class="vecthare-empty-state">
                <p>No collections found.</p>
                <small>Vectorize some chat messages to create collections!</small>
            </div>
        `);
    updateStats([]);
    return;
  }

  // Render collection cards
  const cardsHtml = filtered.map((c) => renderCollectionCard(c)).join("");
  container.html(cardsHtml);

  // Bind card events
  bindCollectionCardEvents();

  // Update stats
  updateStats(filtered);
}

/**
 * Renders a single collection card (V1-inspired layout)
 * @param {object} collection Collection data
 * @returns {string} Card HTML
 */
function renderCollectionCard(collection) {
  // Map collection types to icon functions
  const typeIconMap = {
    chat: icons.messageSquare,
    file: icons.fileText,
    doc: icons.fileText,
    paste: icons.fileText,
    select: icons.fileText,
    current: icons.fileText,
    lorebook: icons.bookOpen,
    character: icons.user,
    persona: icons.user,
    url: icons.globe,
    wiki: icons.globe,
    youtube: icons.globe,
  };
  const iconFn = typeIconMap[collection.type] || icons.box;
  const typeIcon = iconFn(14, "vecthare-type-icon");

  const scopeBadge =
    {
      global:
        '<span class="vecthare-badge vecthare-badge-global">Global</span>',
      character:
        '<span class="vecthare-badge vecthare-badge-character">Character</span>',
      chat: '<span class="vecthare-badge vecthare-badge-chat">Chat</span>',
    // A chat's own collection is used only in its chat, whatever scope older runs stamped on it.
    }[String(collection.id || "").startsWith("vecthare_chat_") ? "chat" : collection.scope] || "";

  const statusBadge = collection.enabled
    ? '<span class="vecthare-badge vecthare-badge-success">Active</span>'
    : '<span class="vecthare-badge vecthare-badge-muted">Paused</span>';

  // N2: a deleted chat's collection is kept for a while and not used by RAG.
  const deletedInfo = getDeletedChatInfo(collection.id);
  const deletedDays = deletedInfo ? deletedChatDaysLeft(deletedInfo) : 0;
  const deletedBadge = deletedInfo
    ? `<span class="vecthare-badge vecthare-badge-muted" title="The chat this collection belonged to was deleted${deletedInfo.filename ? ` (${escapeHtml(deletedInfo.filename)})` : ""}. Its memories are not used. Re-importing the chat offers to re-use them; otherwise they are purged ${escapeHtml(deletedDays ? `in ${deletedDays} day(s)` : "at the next startup")}, or now with Empty deleted.">Deleted chat — kept ${escapeHtml(deletedDays)} day${deletedDays === 1 ? "" : "s"}</span>`
    : "";

  // VH-061: an older collection that is searched although its settings were never recorded.
  const legacyBadge = legacyNeedsRebuild(collection.id)
    ? '<span class="vecthare-badge vecthare-badge-muted" title="Made by an older VectHare that did not record its settings. It is searched with the current settings until you re-vectorize it (Vectorize asks before rebuilding).">Needs re-vectorizing</span>'
    : "";

  // What an explicit existence check at the recorded destination established.
  const presence = collection.presence || "unverified";
  // A row with no VectHare marker at all is reported as what it is rather than
  // as ambiguous ownership.
  const notVectHare = collection.metadataRecord?.foreign === true;
  // Only these keep their vectors in a folder on this machine.
  const fileBacked = ["standard", "vectra", "lancedb"].includes(collection.backend);
  const presenceBadge =
    {
      empty:
        '<span class="vecthare-badge vecthare-badge-muted" title="The physical collection exists at its recorded destination and has a verified count of zero chunks.">Empty Collection</span>',
      "count-unverified":
        '<span class="vecthare-badge vecthare-badge-muted" title="The physical collection exists, but its chunk count could not be trusted.">Exists — Count Unverified</span>',
      "metadata-only":
        '<span class="vecthare-badge vecthare-badge-muted" title="The physical collection was confirmed absent at its recorded destination, and VectHare\'s metadata file holds a validated record for it.">Metadata Only</span>',
      "invalid-metadata":
        '<span class="vecthare-badge vecthare-badge-muted" title="This entry is not a usable VectHare metadata record: the record is unreadable, records no backend-qualified destination, or exists only as a discovered name. It is listed for inspection; its actions are withheld.">Invalid Metadata</span>',
      unverified:
        '<span class="vecthare-badge vecthare-badge-muted" title="The recorded destination could not be checked. Nothing is assumed, and no destructive action is offered.">Unverified</span>',
      "ownership-unverified":
        '<span class="vecthare-badge vecthare-badge-muted" title="A record exists, but nothing establishes it as VectHare\'s own, or its binding is ambiguous. Destructive actions are withheld.">Ownership Unverified</span>',
      "not-vecthare": '<span class="vecthare-badge vecthare-badge-muted" title="This collection is not VectHare\'s: it carries no VectHare marker, VectHare recorded no vectorization configuration for it and no chat is bound to it. It was most likely created by SillyTavern itself or another extension. VectHare lists it for information and will not modify or delete it.">Not VectHare-Owned</span>',
      "st-builtin": `<span class="vecthare-badge vecthare-badge-muted" title="This is one of SillyTavern's own vector collections (${escapeHtml(stBuiltInLabel(collection.metadataRecord?.sillyTavernBuiltIn))}), made by SillyTavern's built-in Vector Storage. VectHare lists it for information and will not change it on its own.">SillyTavern Built-in Vectors</span>`,
    }[notVectHare && presence === "ownership-unverified"
      ? (collection.metadataRecord?.sillyTavernBuiltIn ? "st-builtin" : "not-vecthare") : presence] || "";

  // Which actions this state may offer. A record is never treated as a real
  // collection without a confirmed existence answer.
  const physicallyPresent = ["present", "empty", "count-unverified"].includes(presence);
  // Only a confirmed absence with a validated VectHare metadata record is
  // metadata-only; an invalid or unowned record is visible but acts on nothing.
  const metadataOnly = presence === "metadata-only";
  // An unowned record whose collection is CONFIRMED ABSENT can still have
  // VectHare's own local record removed: that touches no vectors and no other
  // extension's data, so ownership is not what is at stake - confirmed absence
  // is, and it is re-checked before anything is removed.
  // Delete Metadata also clears an unreadable or stale VectHare entry once the
  // collection is confirmed absent - otherwise such a row can be neither
  // regenerated (nothing to rebuild from) nor removed, and sits there forever.
  const localRecordOnly =
    (presence === "ownership-unverified" || presence === "invalid-metadata") &&
    collection.existence === "absent";
  const blocked = ["unverified", "ownership-unverified", "invalid-metadata"].includes(presence);
  const canUseCollectionActions = physicallyPresent;
  // A collection whose ownership VectHare cannot prove is still the user's to
  // delete when the destination itself is proven: it exists at the exact
  // recorded destination and that destination is recorded for this identity.
  // It takes its own, explicit confirmation - see the delete handler.
  const deletableOnUserAuthority = presence === "ownership-unverified" &&
    collection.existence === "present" && collection.destinationQualified === true;
  const canDeleteCollection =
    (physicallyPresent && presence !== "ownership-unverified") || deletableOnUserAuthority;

  // Activation badge (shows triggers or conditions)
  const activationSummary = getCollectionActivationSummary(collection.id);
  let activationBadge = "";
  if (activationSummary.alwaysActive) {
    activationBadge =
      '<span class="vecthare-badge vecthare-badge-always" title="Always active">∞ Always</span>';
  } else if (activationSummary.triggerCount > 0) {
    activationBadge = `<span class="vecthare-badge vecthare-badge-triggers" title="${activationSummary.triggerCount} trigger(s)">🎯 ${activationSummary.triggerCount}</span>`;
  } else if (activationSummary.conditionsEnabled) {
    activationBadge = `<span class="vecthare-badge vecthare-badge-conditions" title="${activationSummary.conditionCount} condition(s)">⚡ ${activationSummary.conditionCount}</span>`;
  }

  // Backend badge - shows vector database (Standard, LanceDB, Qdrant)
  const backendDisplayName =
    {
      standard: "Standard",
      vectra: "Standard", // registry keys name the Standard backend "vectra"
      lancedb: "LanceDB",
      qdrant: "Qdrant",
      milvus: "Milvus",
    }[collection.backend] || collection.backend;

  const backendBadge = collection.backend
    ? `<span class="vecthare-badge vecthare-badge-backend" title="Vector backend">${escapeHtml(backendDisplayName)}</span>`
    : "";

  // Shared (multitenancy) storage, from the collection's recorded location only.
  let storageBadge = "";
  try {
    const where = ["qdrant", "milvus"].includes(collection.backend) ? getStorageLocator(collection.id) : null;
    if (where?.layout === "mt-v2") {
      storageBadge = `<span class="vecthare-badge vecthare-badge-backend" title="Stored in the shared multitenancy store ${escapeHtml(where.physical)}, kept separate from other collections there. Database Browser &gt; Storage can move it.">Multitenancy</span>`;
    } else if (where?.layout === "legacy-mt" || where?.layout === "legacy-shared") {
      storageBadge = `<span class="vecthare-badge vecthare-badge-backend" title="Stored in the older shared store ${escapeHtml(where.physical)}. Database Browser &gt; Storage can move it to the newer layout.">Multitenancy (old store)</span>`;
    }
  } catch {
    storageBadge = "";
  }

  // Source badge - shows embedding source (transformers, palm, openai, etc.)
  const sourceBadge =
    collection.source && collection.source !== "unknown"
      ? `<span class="vecthare-badge vecthare-badge-source" title="Embedding source">${escapeHtml(collection.source)}</span>`
      : "";

  // Model info - show current model and count if multiple
  const hasMultipleModels = collection.models && collection.models.length > 1;
  const currentModelName = collection.model || "(default)";
  const modelBadge = hasMultipleModels
    ? `<span class="vecthare-badge vecthare-badge-model" title="Current model: ${escapeHtml(currentModelName)} (${collection.models.length} available)">📐 ${escapeHtml(currentModelName)}</span>`
    : "";

  // Temporal decay badge
  const decaySummary = getCollectionDecaySummary(collection.id);
  let decayBadge = "";
  if (decaySummary.enabled) {
    const decayIcon = decaySummary.isCustom ? "⏳" : "⏱️";
    const decayTitle = decaySummary.isCustom
      ? `Custom decay: ${decaySummary.description}`
      : `Default decay: ${decaySummary.description}`;
    decayBadge = `<span class="vecthare-badge vecthare-badge-decay ${decaySummary.isCustom ? "vecthare-badge-decay-custom" : ""}" title="${escapeHtml(decayTitle)}">${decayIcon}</span>`;
  }

  // Lock badge - shows if collection is locked and to how many chats
  const lockCount = getCollectionLockCount(collection.id);
  let lockBadge = "";
  if (lockCount > 0) {
    const lockTitle = `Locked to ${lockCount} chat${lockCount !== 1 ? "s" : ""}`;
    lockBadge = `<span class="vecthare-badge vecthare-badge-lock" title="${escapeHtml(lockTitle)}">🔒 ${lockCount}</span>`;
  }

  // Use registryKey for unique identification (source:id format)
  const uniqueKey = collection.registryKey || collection.id;

  return `
        <div class="vecthare-collection-card" data-collection-key="${escapeHtml(uniqueKey)}" data-status="${collection.enabled ? "active" : "paused"}">
            <div class="vecthare-collection-header">
                <span class="vecthare-collection-title">
                    ${typeIcon} ${escapeHtml(collection.name)}
                </span>
                <div class="vecthare-collection-badges">
                    ${deletedBadge}
                    ${legacyBadge}
                    ${presenceBadge}
                    ${scopeBadge}
                    ${backendBadge}
                    ${storageBadge}
                    ${sourceBadge}
                    ${modelBadge}
                    ${decayBadge}
                    ${lockBadge}
                    ${statusBadge}
                </div>
            </div>

            <div class="vecthare-collection-meta">
                <span>${collection.chunkCount} chunks</span>
                <span>ID: ${escapeHtml(collection.id)}</span>
            </div>
            ${
              collection.presenceDetail && presence !== "present"
                ? `<div class="vecthare-collection-meta"><small>${escapeHtml(collection.presenceDetail)}</small></div>`
                : ""
            }

            <div class="vecthare-collection-actions">
                ${
                  // Collection actions require a CONFIRMED physical
                  // collection. Metadata-only and unverified rows get
                  // metadata actions only.
                  canUseCollectionActions
                    ? `
                <button class="vecthare-btn-sm vecthare-action-toggle"
                        data-collection-key="${escapeHtml(uniqueKey)}"
                        data-enabled="${escapeHtml(collection.enabled)}">
                    ${collection.enabled ? icons.pause(16) + " Pause" : icons.play(16) + " Enable"}
                </button>
                <button class="vecthare-btn-sm vecthare-action-rename"
                        data-collection-key="${escapeHtml(uniqueKey)}"
                        data-current-name="${escapeHtml(collection.name)}"
                        title="Rename this collection">
                    ${icons.pencil(16)} Rename
                </button>
                <button class="vecthare-btn-sm vecthare-action-activation ${activationSummary.mode !== "auto" || decaySummary.isCustom ? "vecthare-has-settings" : ""}"
                        data-collection-key="${escapeHtml(uniqueKey)}"
                        title="Configure activation, triggers, conditions, and temporal decay">
                    ${icons.settings(16)} Settings
                </button>
                ${
                  hasMultipleModels
                    ? `
                <button class="vecthare-btn-sm vecthare-action-switch-model"
                        data-collection-key="${escapeHtml(uniqueKey)}"
                        title="Switch embedding model (${collection.models.length} available)">
                    <i class="fa-solid fa-code-branch"></i> Model
                </button>
                `
                    : ""
                }
                ${
                  // Qdrant and Milvus collections live on a server, not in a
                  // folder on this machine, so the action is not offered for
                  // them rather than failing when pressed.
                  fileBacked
                    ? `
                <button class="vecthare-btn-sm vecthare-action-open-folder"
                        data-collection-key="${escapeHtml(uniqueKey)}"
                        data-backend="${escapeHtml(collection.backend)}"
                        data-source="${escapeHtml(collection.source || "transformers")}"
                        title="Open this collection's folder in your file explorer">
                    ${icons.folderOpen(16)} Open Folder
                </button>
                `
                    : ""
                }
                ${
                  // 9d: Qdrant/Milvus collections can move between the layouts
                  // of their backend (same server; the switch picks the target).
                  ["qdrant", "milvus"].includes(collection.backend)
                    ? `
                <button class="vecthare-btn-sm vecthare-action-move-storage"
                        data-collection-key="${escapeHtml(uniqueKey)}"
                        title="Move this collection to the storage layout the multitenancy switch selects for new collections (same server; the old copy is kept until you delete it in the Storage tab)">
                    <i class="fa-solid fa-right-left"></i> Move storage…
                </button>
                `
                    : ""
                }
                <button class="vecthare-btn-sm vecthare-action-visualize"
                        data-collection-key="${escapeHtml(uniqueKey)}"
                        data-backend="${escapeHtml(collection.backend)}"
                        data-source="${escapeHtml(collection.source || "transformers")}"
                        title="View and edit chunks in this collection">
                    ${icons.eye(16)} View Chunks
                </button>
                <div class="vecthare-export-dropdown">
                    <button class="vecthare-btn-sm vecthare-btn-export vecthare-action-export-toggle"
                            title="Export collection">
                        ${icons.download(16)} Export
                    </button>
                    <div class="vecthare-export-options">
                        <button class="vecthare-btn-sm vecthare-btn-json vecthare-action-export"
                                data-collection-key="${escapeHtml(uniqueKey)}"
                                data-collection-id="${escapeHtml(collection.id)}"
                                data-backend="${escapeHtml(collection.backend)}"
                                data-source="${escapeHtml(collection.source || "transformers")}"
                                data-model="${escapeHtml(collection.model || "")}"
                                title="Export as JSON (includes vectors)">
                            ${icons.fileExport(16)} JSON
                        </button>
                        <button class="vecthare-btn-sm vecthare-btn-png vecthare-action-export-png"
                                data-collection-key="${escapeHtml(uniqueKey)}"
                                data-collection-id="${escapeHtml(collection.id)}"
                                data-backend="${escapeHtml(collection.backend)}"
                                data-source="${escapeHtml(collection.source || "transformers")}"
                                data-model="${escapeHtml(collection.model || "")}"
                                title="Export as PNG (shareable image)">
                            ${icons.image(16)} PNG
                        </button>
                    </div>
                </div>
                `
                    : ""
                }
                <button class="vecthare-btn-sm vecthare-action-view-metadata"
                        data-collection-key="${escapeHtml(uniqueKey)}"
                        title="Inspect VectHare's stored metadata for this collection">
                    ${icons.eye(16)} View Metadata
                </button>
                <button class="vecthare-btn-sm vecthare-action-regenerate-metadata"
                        data-collection-key="${escapeHtml(uniqueKey)}"
                        ${blocked ? "disabled" : ""}
                        title="${blocked
                          ? presence === "invalid-metadata"
                            ? "This entry is not a usable VectHare metadata record, so there is nothing to recover from."
                            : "The recorded destination could not be verified, so nothing can be recovered safely."
                          : "Refresh local metadata that can be independently verified. Never vectorizes."}">
                    ${icons.rotateCcw ? icons.rotateCcw(16) : ""} Regenerate Metadata
                </button>
                ${
                  metadataOnly || localRecordOnly
                    ? `
                <button class="vecthare-btn-sm vecthare-btn-danger vecthare-action-delete-metadata"
                        data-collection-key="${escapeHtml(uniqueKey)}"
                        title="${localRecordOnly
                          ? "Remove only VectHare's own local record for this confirmed-absent collection. No vectors are touched."
                          : "Remove VectHare's leftover metadata for this confirmed-absent collection"}">
                    ${icons.trash(16)} Delete Metadata
                </button>
                `
                    : canDeleteCollection
                      ? `
                <button class="vecthare-btn-sm vecthare-btn-danger vecthare-action-delete"
                        data-collection-key="${escapeHtml(uniqueKey)}">
                    ${icons.trash(16)} Delete Collection
                </button>
                `
                      : `
                <button class="vecthare-btn-sm vecthare-btn-danger" disabled
                        title="${presence === "ownership-unverified"
                          ? notVectHare
                            ? "This is not a VectHare collection, so VectHare will not delete it. Remove it with whatever created it."
                            : "Nothing establishes this record as VectHare's own; resolve that before deleting anything."
                          : presence === "invalid-metadata"
                            ? "This entry is not a usable VectHare metadata record, and its destination could not be verified, so VectHare will not act on it. Open View Metadata to see what it holds."
                            : "The recorded destination could not be verified; deletion is withheld."}">
                    ${icons.trash(16)} Delete
                </button>
                `
                }
            </div>
        </div>
    `;
}

/**
 * Phase 2: gathers everything VectHare has stored about one collection, plus
 * what the backend can confirm, for the View Metadata window. Read-only: this
 * never writes, and never presents a local record as backend-verified.
 * @param {object} collection Collection entry from loadAllCollections()
 * @returns {Promise<object>} Inspection report
 */
async function collectMetadataReport(collection) {
  const registryKey = collection.registryKey || collection.id;
  const destinationSettings = {
    ...browserState.settings,
    vector_backend: collection.backend,
    source: collection.source,
  };

  const report = {
    collectionId: collection.id,
    registryKey,
    displayName: collection.name,
    registered: getCollectionRegistry().some(
      (key) => (parseRegistryKey(key).collectionId || key) === collection.id,
    ),
    presence: collection.presence || "unverified",
    presenceDetail: collection.presenceDetail || "",
    existence: collection.existence || "unverified",
    chunkCount: collection.chunkCount,
    chunkCountTrusted: collection.countTrusted === true,
    // Source-of-truth facts: what VectHare's own metadata file actually holds
    // for this identity, and where the destination below came from.
    metadataRecord: collection.metadataRecord || {
      present: false, key: null, source: "none", fieldCount: 0,
      malformed: false, ownershipValidated: false,
    },
    destinationQualified: collection.destinationQualified === true,
    destinationOrigin: collection.destinationOrigin || "assumed",
    // The destination that was actually checked, as recorded for this entry.
    destinationChecked: {
      backend: collection.backend || "unknown",
      source: collection.source || "unknown",
      model: collection.model || "(none recorded)",
    },
    destination: {
      backend: collection.backend || "unknown",
      source: collection.source || "unknown",
      model: collection.model || "(default)",
    },
    binding: collection.boundChat
      ? {
          ownerType: collection.boundChat.owner?.type || "unknown",
          ownerId: collection.boundChat.owner?.id || "unknown",
          chatFile: collection.boundChat.chat || "unknown",
        }
      : null,
    quarantined: Boolean(collection.quarantined),
    localMetadata: getCollectionMeta(registryKey) || getCollectionMeta(collection.id) || {},
    // Only annotations actually scoped to THIS entry. getAllChunkMetadata()
    // falls back to shared (legacy, unscoped) records, which made every entry
    // claim annotations that do not belong to it and that deleting its
    // metadata would not remove.
    annotationCount: getAnnotatedChunkHashes(collection.id).length,
    originalConfiguration: null,
    originalConfigurationStatus: "unknown",
    ledger: "unknown",
    storeStatus: storeStatus(),
  };

  // The authoritative original vectorization configuration is backend-resident;
  // it is read here, never reconstructed or edited.
  try {
    const saved = await readInitialVectorizationConfig(collection.id, destinationSettings, {
      backend: collection.backend,
      source: collection.source,
    });
    report.originalConfigurationStatus = saved.status;
    if (saved.status === "valid" && saved.config) {
      report.originalConfiguration = {
        provider: saved.config.embedding?.provider,
        model: saved.config.embedding?.model,
        dimensions: saved.config.embedding?.dimensions,
        grouping: saved.config.chunking?.strategy,
        groupSize: saved.config.chunking?.batchSize,
        cleaning: saved.config.chunking?.cleaning ?? saved.config.cleaning,
        identityLedger: saved.config.identityLedger === 1,
        recordedAt: saved.config.recordedAt,
      };
      report.ledger = saved.config.identityLedger === 1 ? "enabled" : "not used";
    }
  } catch (error) {
    report.originalConfigurationStatus = `unreadable (${error.message})`;
  }

  // Where this collection and VectHare's metadata document actually live.
  // Read-only, and only reported when the plugin can confirm them: a remote
  // backend has no local folder, and an unconfirmed path is not shown at all.
  try {
    const response = await fetch("/api/plugins/similharity/collections/paths", {
      method: "POST",
      headers: getRequestHeaders(),
      body: JSON.stringify({
        backend: collection.backend || "vectra",
        collectionId: collection.id,
        source: collection.source || "",
        model: collection.model || "",
      }),
    });
    if (response.ok) {
      const paths = await response.json();
      report.collectionPath = paths?.collection || null;
      report.metadataPath = paths?.metadata || null;
    }
  } catch (error) {
    console.debug("VectHare: Could not resolve storage paths", error);
  }

  return report;
}

/**
 * Sets the Metadata window's Delete button to whichever operation this entry's
 * state actually allows - the same decision the card makes, so the window can
 * never offer a deletion the card withholds.
 * @param {object} collection Collection entry from loadAllCollections()
 */
function updateMetadataDeleteButton(collection) {
  const button = $("#vecthare_metadata_delete");
  if (!button.length) return;

  // Local-only reset: available whenever VectHare holds a readable record for
  // this entry, whether or not the collection still exists.
  const record = collection.metadataRecord;
  const metaButton = $("#vecthare_metadata_delete_meta");
  const hasReadableRecord = record?.present === true && record.malformed !== true;
  // An unreadable entry can be cleared once the collection is confirmed
  // absent: it is matched by its key, not by its contents, and nothing but
  // VectHare's own state is removed.
  const absenceKnown = collection.existence === "present" || collection.existence === "absent";
  // An unreadable entry is matched by its key, not its contents, so it can be
  // cleared whenever the destination is known - absent (clearing a ghost) or
  // present (clearing a broken record so Regenerate can rebuild it).
  const clearableUnreadable = record?.malformed === true && absenceKnown;
  if ((hasReadableRecord && absenceKnown) || clearableUnreadable) {
    metaButton.prop("disabled", false).text("Delete Metadata").attr("title",
      collection.existence === "present"
        ? "Remove only VectHare's own records for this entry. The collection and its vectors are not touched."
        : clearableUnreadable
          ? "Clear this unreadable VectHare entry. The collection is confirmed absent and no vectors are deleted."
          : "Remove VectHare's own records for this confirmed-absent collection. No vectors are deleted.");
  } else {
    metaButton.prop("disabled", true).text("Delete Metadata").attr("title",
      record?.present !== true
        ? "VectHare holds no record of its own for this entry, so there is nothing to remove."
        : "The recorded destination could not be checked, so VectHare's records are kept.");
  }

  const presence = collection.presence || "unverified";
  const physicallyPresent = ["present", "empty", "count-unverified"].includes(presence);
  const notVectHare = collection.metadataRecord?.foreign === true;
  // Mirrors the card exactly, including the user-authority case for a
  // collection too old to carry VectHare's ownership markers.
  const canDeleteCollection =
    (physicallyPresent && presence !== "ownership-unverified") ||
    (presence === "ownership-unverified" && collection.existence === "present" &&
      collection.destinationQualified === true);
  const canDeleteMetadata = presence === "metadata-only" ||
    (presence === "ownership-unverified" && collection.existence === "absent");

  if (canDeleteCollection) {
    button.prop("disabled", false).removeAttr("title")
      .data("action", "vecthare-action-delete")
      .text("Delete Collection");
  } else if (canDeleteMetadata) {
    // The local-only button beside it already covers this case; keep the
    // collection button disabled rather than offering the same thing twice.
    button.prop("disabled", true).data("action", null)
      .attr("title", "There is no physical collection to delete - use Delete Metadata.")
      .text("Delete Collection");
  } else {
    button.prop("disabled", true).data("action", null)
      .attr("title", notVectHare
        ? "This is not a VectHare collection, so VectHare will not delete it."
        : presence === "invalid-metadata"
          ? "This entry is not a usable VectHare metadata record, so VectHare will not act on it."
          : "The recorded destination could not be verified, so deletion is withheld.")
      .text("Delete");
  }
}

/**
 * Opens the View Metadata window for one collection.
 * @param {object} collection Collection entry from loadAllCollections()
 */
async function openMetadataDialog(collection) {
  if ($("#vecthare_metadata_modal").length === 0) {
    $("body").append(`
            <div id="vecthare_metadata_modal" class="vecthare-modal">
                <div class="vecthare-modal-content vecthare-rename-dialog popup">
                    <div class="vecthare-modal-header">
                        <h3>Collection Metadata</h3>
                        <button class="vecthare-btn-icon" id="vecthare_metadata_close">✕</button>
                    </div>
                    <div class="vecthare-rename-body" id="vecthare_metadata_body"></div>
                    <div class="vecthare-modal-footer">
                        <button class="vecthare-btn" id="vecthare_metadata_json">Show raw JSON</button>
                        <button class="vecthare-btn vecthare-btn-danger" id="vecthare_metadata_delete_meta"></button>
                        <button class="vecthare-btn vecthare-btn-danger" id="vecthare_metadata_delete"></button>
                        <button class="vecthare-btn" id="vecthare_metadata_done">Close</button>
                    </div>
                </div>
            </div>
        `);
    $("#vecthare_metadata_close, #vecthare_metadata_done").on("click", () => {
      browserState.openMetadataKey = null;
      $("#vecthare_metadata_modal").removeClass("active").hide();
    });
    $("#vecthare_metadata_modal").on("mousedown touchstart", (e) => e.stopPropagation());
    $("#vecthare_metadata_modal").on("click", function (e) {
      if (e.target === this) {
        browserState.openMetadataKey = null;
        $(this).removeClass("active").hide();
      }
    });
    $("#vecthare_metadata_json").on("click", function () {
      const pane = $("#vecthare_metadata_raw");
      pane.toggle();
      $(this).text(pane.is(":visible") ? "Hide raw JSON" : "Show raw JSON");
    });
    // Local-only reset: removes VectHare's own records for this entry and
    // deletes no vectors. Offered even while the collection exists, so the
    // entry can be cleared and then rebuilt with Regenerate Metadata.
    $("#vecthare_metadata_delete_meta").on("click", async function () {
      if ($(this).prop("disabled")) return;
      const collection = findCollectionByKey(browserState.openMetadataKey);
      if (!collection) return;
      const present = collection.existence === "present";
      const confirmed = confirm(
        `Delete VectHare's metadata for "${collection.name}"?\n\n` +
          (present
            ? "The collection itself is NOT deleted - its vectors stay exactly where they are. " +
              "Only VectHare's own records for it are removed.\n\n"
            : "The physical collection was confirmed absent at its recorded destination.\n\n") +
          "Removed: registry entry, collection metadata and preferences, chat binding, " +
          "this collection's chunk annotations and its identity ledger.\n\n" +
          "Regenerate Metadata can afterwards recover only what it can verify at the " +
          "destination - the registry entry and the chunk count. Your annotations, the chat " +
          "binding and the identity ledger are NOT recoverable.\n\n" +
          `Press OK for "Yes, Delete Metadata" or Cancel for "No, Cancel".`,
      );
      if (!confirmed) return;

      const button = $(this);
      button.prop("disabled", true);
      try {
        const result = await deleteCollectionMetadataOnly(
          collection.id,
          {
            ...browserState.settings,
            vector_backend: collection.backend,
            source: collection.source,
          },
          collection.registryKey,
          { model: collection.model || "", allowWhilePresent: present },
        );
        await refreshCollections({ reloadStore: true, invalidateInventory: true });
        if (result.success) {
          toastr.success(
            `Removed VectHare's metadata for "${collection.name}" ` +
              `(${result.removed.join(", ") || "nothing left to remove"})` +
              `${result.verified ? " - verified gone from VectHare's metadata file" : ""}` +
              `${present ? ". The collection itself was not touched." : ""}`,
            "VectHare",
            { timeOut: 12000 },
          );
        } else {
          toastr.error(
            `Metadata was not fully removed: ${result.errors.join(", ")}`,
            "VectHare",
            { timeOut: 0, extendedTimeOut: 0 },
          );
        }
      } catch (error) {
        console.error("VectHare: Metadata reset failed", error);
        toastr.error(`Metadata reset failed: ${error.message}`, "VectHare");
      } finally {
        button.prop("disabled", false);
      }
    });

    // Deliberately not a third deletion path: this closes the window and
    // triggers the very button this entry's card offers, so Delete Collection
    // and Delete Metadata keep their own confirmations, verification and
    // cleanup exactly as they are.
    $("#vecthare_metadata_delete").on("click", function () {
      if ($(this).prop("disabled")) return;
      const key = browserState.openMetadataKey;
      const action = $(this).data("action");
      if (!key || !action) return;
      const card = $(`.${action}`).filter(function () {
        return $(this).data("collection-key") === key;
      }).first();
      browserState.openMetadataKey = null;
      $("#vecthare_metadata_modal").removeClass("active").hide();
      if (card.length) card.trigger("click");
      else toastr.warning("Reopen Database Browser and try the deletion from the collection card.", "VectHare");
    });
  }

  // Remembered so a refresh (Resync, a deletion, a regeneration) can bring
  // this window up to date instead of leaving stale values on screen.
  browserState.openMetadataKey = collection.registryKey || collection.id;
  updateMetadataDeleteButton(collection);

  const body = $("#vecthare_metadata_body");
  body.html("<p>Reading metadata…</p>");
  $("#vecthare_metadata_modal").addClass("active").show();

  let report;
  try {
    report = await collectMetadataReport(collection);
  } catch (error) {
    body.html(`<p>Could not read metadata: ${escapeHtml(error.message)}</p>`);
    return;
  }

  const stateLabel = {
    present: "Collection Exists",
    empty: "Empty Collection",
    "count-unverified": "Collection Exists — Count Unverified",
    "metadata-only": "Metadata Only",
    "invalid-metadata": "Invalid Metadata",
    unverified: "Unverified",
    "ownership-unverified": report.metadataRecord?.sillyTavernBuiltIn
      ? "SillyTavern Built-in Vectors"
      : report.metadataRecord?.foreign ? "Not VectHare-Owned" : "Ownership Unverified",
  }[report.presence] || "Unverified";
  const presenceText = {
    present: "The physical collection exists at its recorded destination.",
    empty: "The physical collection exists at its recorded destination and has a verified count of zero chunks.",
    "count-unverified": "The physical collection exists at its recorded destination, but its chunk count could not be trusted.",
    "metadata-only": "The physical collection was confirmed absent at its recorded destination, and VectHare's metadata file holds a validated record for it.",
    "invalid-metadata": "This entry is not a usable VectHare metadata record. It is shown so it can be inspected, and VectHare will not act on it.",
    unverified: "The recorded destination could not be checked, so nothing is assumed about this collection.",
    "ownership-unverified": report.metadataRecord?.sillyTavernBuiltIn
      ? `This is one of SillyTavern's own vector collections (${stBuiltInLabel(report.metadataRecord.sillyTavernBuiltIn)}), made by SillyTavern's built-in Vector Storage. It carries no VectHare marker, so VectHare lists it for information and will not change it on its own.`
      : report.metadataRecord?.foreign
      ? "This collection carries no VectHare marker: no VectHare-style name, no vectorization configuration recorded by VectHare and no chat bound to it. It was most likely created by SillyTavern itself or by another extension, so VectHare lists it for information and will not modify or delete it."
      : "A record exists, but nothing establishes it as VectHare's own, or its binding is ambiguous, so destructive actions are withheld.",
  }[report.presence] || "";

  const row = (label, value) =>
    `<div class="vecthare-collection-meta"><span>${escapeHtml(label)}</span><span>${escapeHtml(
      value === undefined || value === null || value === "" ? "—" : String(value),
    )}</span></div>`;

  const original = report.originalConfiguration;
  const checked = `${report.destinationChecked.backend} / ${report.destinationChecked.source}` +
    `${report.destinationChecked.model && report.destinationChecked.model !== "(none recorded)"
      ? ` / ${report.destinationChecked.model}` : ""}`;

  body.html(`
    <p><strong>${escapeHtml(report.displayName)}</strong></p>
    <p><strong>${escapeHtml(stateLabel)}</strong></p>
    <p><small>${escapeHtml(presenceText)}${report.presenceDetail && !["metadata-only", "empty", "invalid-metadata"].includes(report.presence) ? " " + escapeHtml(report.presenceDetail) : ""}</small></p>
    <p><strong>Stored in VectHare's metadata file</strong></p>
    ${row("Metadata record", report.metadataRecord.malformed
      ? "present but unreadable"
      : report.metadataRecord.present
        ? `present (${report.metadataRecord.source})`
        : "none - this identity has no VectHare metadata record")}
    ${report.metadataRecord.present && !report.metadataRecord.malformed
      ? row("Record key", report.metadataRecord.key) + row("Record fields stored", report.metadataRecord.fieldCount)
      : ""}
    ${row("Ownership validated", report.metadataRecord.ownershipValidated
      ? "yes"
      : report.metadataRecord.sillyTavernBuiltIn
        ? `no - SillyTavern built-in vectors (${stBuiltInLabel(report.metadataRecord.sillyTavernBuiltIn)})`
        : report.metadataRecord.foreign
        ? "no - not a VectHare collection (most likely SillyTavern's own or another extension's)"
        : "no")}
    ${row("Collection ID", report.collectionId)}
    ${row("Registry key", report.registryKey)}
    ${row("In registry", report.registered ? "yes" : "no")}
    ${row("Backend recorded", report.destinationQualified
      ? report.destination.backend
      : `${report.destination.backend} (not recorded - assumed)`)}
    ${row("Embedding source recorded", report.destinationQualified
      ? report.destination.source
      : `${report.destination.source} (not recorded - assumed)`)}
    ${row("Model noted", report.destination.model)}
    ${row("Chat binding", report.binding
      ? `${report.binding.ownerType} ${report.binding.ownerId} · ${report.binding.chatFile}`
      : report.quarantined ? "preserved, no current chat" : "none recorded")}
    ${row("Local annotations", report.annotationCount)}
    ${report.metadataPath ? row("Metadata file", report.metadataPath) : ""}
    ${report.collectionPath ? row("Collection folder", report.collectionPath) : ""}
    <p><strong>Not stored metadata - read from the backend this session</strong></p>
    ${row("Destination checked", checked)}
    ${row("Destination came from", report.destinationOrigin === "registry-key"
      ? "VectHare's registry key (stored)"
      : report.destinationOrigin === "backend-query"
        ? "a backend query (not stored metadata)"
        : "neither - assumed default")}
    ${row("Existence result", report.existence)}
    ${row("Chunks counted", report.chunkCountTrusted
      ? report.chunkCount : `${report.chunkCount} (not verified)`)}
    ${row("Identity ledger", report.ledger)}
    ${row("Original configuration (backend record)", report.originalConfigurationStatus)}
    ${report.originalConfigurationStatus !== "valid"
      ? `<div class="vecthare-collection-meta"><small>No authoritative creation record was found at the destination, so the backend, source and model above are VectHare's own notes or this session's lookup, not verified original vectorization settings.</small></div>`
      : ""}
    ${original ? `
      ${row("  provider (verified)", original.provider)}
      ${row("  model (verified)", original.model)}
      ${row("  dimensions (verified)", original.dimensions)}
      ${row("  grouping (verified)", original.grouping)}
      ${row("  group size (verified)", original.groupSize)}
      ${row("  recorded at", original.recordedAt)}
    ` : ""}
    ${report.storeStatus.status !== "ready"
      ? `<p><small>VectHare's metadata storage is ${escapeHtml(report.storeStatus.status)}: ${escapeHtml(report.storeStatus.detail)}</small></p>`
      : ""}
    <pre id="vecthare_metadata_raw" style="display:none;max-height:240px;overflow:auto;white-space:pre-wrap;"></pre>
  `);
  // Read-only: set as text so stored values can never be interpreted as markup.
  $("#vecthare_metadata_raw").text(JSON.stringify(report, null, 2));
  $("#vecthare_metadata_json").text("Show raw JSON");
}

/**
 * Helper to find collection by its unique key (registryKey or id)
 */
function findCollectionByKey(key) {
  return browserState.collections.find((c) => (c.registryKey || c.id) === key);
}

/**
 * Performs PNG export with optional custom image
 * @param {File|null} imageFile - Custom image file or null for default
 */
async function performPngExport(imageFile) {
  const pending = browserState.pendingPngExport;
  if (!pending) {
    toastr.error("No export pending", "VectHare");
    return;
  }

  browserState.pendingPngExport = null;

  try {
    toastr.info("Preparing PNG export...", "VectHare");

    // Get export data
    const exportData = await exportCollection(
      pending.collectionId,
      browserState.settings,
      {
        backend: pending.backend,
        source: pending.source,
        model: pending.model,
      },
    );

    // Convert custom image to PNG if provided
    let pngData = null;
    if (imageFile) {
      toastr.info("Converting image...", "VectHare");
      pngData = await convertToPNG(imageFile);
    }

    // Embed data in PNG
    toastr.info("Embedding data in PNG...", "VectHare");
    const pngWithData = await embedDataInPNG(exportData, pngData);

    // Download
    const filename = `${pending.collection.name || pending.collectionId}.vecthare`;
    downloadPNG(pngWithData, filename);

    // Show compression stats
    const jsonSize = JSON.stringify(exportData).length;
    const pngSize = pngWithData.length;
    const ratio = Math.round((pngSize / jsonSize) * 100);

    toastr.success(
      `PNG export complete!\n${exportData.stats.chunkCount} chunks\n` +
        `Original: ${formatBytes(jsonSize)}\n` +
        `PNG: ${formatBytes(pngSize)} (${ratio}%)`,
      "VectHare Export",
    );
  } catch (error) {
    console.error("VectHare: PNG export failed", error);
    toastr.error(`PNG export failed: ${error.message}`, "VectHare");
  }
}

/**
 * Formats bytes to human readable string
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}


/**
 * VH-045: settings for acting on one collection: its backend, embedding source
 * and model (as listed), not today's global choice.
 */
function settingsForCollection(collection) {
  const settings = { ...browserState.settings, vector_backend: collection.backend };
  if (collection.source) {
    settings.source = collection.source;
    const field = getModelField(collection.source);
    if (field && collection.model) settings[field] = collection.model;
  }
  return settings;
}

/**
 * Binds events for collection card actions
 */
function bindCollectionCardEvents() {
  // Toggle enabled/disabled
  $(".vecthare-action-toggle")
    .off("click")
    .on("click", async function (e) {
      e.stopPropagation();
      const collectionKey = $(this).data("collection-key");
      const currentEnabled = $(this).data("enabled");
      const newEnabled = !currentEnabled;

      setCollectionEnabled(collectionKey, newEnabled);

      // Update UI
      const collection = findCollectionByKey(collectionKey);
      if (collection) {
        collection.enabled = newEnabled;
      }

      renderCollections();

      toastr.success(
        `Collection ${newEnabled ? "enabled" : "paused"}`,
        "VectHare",
      );
    });

  // Delete collection - uses unified deleteCollection() to handle all 3 stores
  $(".vecthare-action-delete")
    .off("click")
    .on("click", async function (e) {
      e.stopPropagation();
      const collectionKey = $(this).data("collection-key");
      const collection = findCollectionByKey(collectionKey);

      if (!collection) return;

      const emptyButPresent =
        collection.presence === "empty" ||
        (collection.existence === "present" && collection.countTrusted === true &&
          !collection.chunkCount);
      // An old collection from before VectHare recorded ownership cannot be
      // proven to be VectHare's. The destination is proven, so the user is the
      // one who can say whether it is theirs - asked plainly, once, naming the
      // exact destination that will be deleted.
      const onUserAuthority = collection.presence === "ownership-unverified" &&
        collection.existence === "present";
      const confirmed = confirm(
        `Delete collection "${collection.name}"?\n\n` +
          (onUserAuthority
            ? "VectHare cannot verify that this collection is its own - it carries no VectHare " +
              "marker, and VectHare holds no original vectorization record for it. That is normal " +
              "for a collection created before VectHare recorded this, but it also means VectHare " +
              "cannot rule out that it belongs to SillyTavern or another extension.\n\n" +
              `Destination to be deleted: ${collection.backend || "unknown"} / ` +
              `${collection.source || "unknown"}${collection.model ? ` / ${collection.model}` : ""} / ` +
              `${collection.id}\n\n` +
              "Only continue if you recognise this as yours to delete.\n\n"
            : "") +
          (emptyButPresent
            ? "This collection exists at its recorded destination and holds no chunks. " +
              "It will be removed from the backend together with VectHare's metadata for it.\n"
            : `This will remove ${collection.chunkCount} chunks from the vector index.\n`) +
          `This action cannot be undone.`,
      );

      if (!confirmed) return;

      try {
        // Use unified delete function - handles vectors, registry, AND metadata
        const collectionSettings = {
          ...browserState.settings,
          vector_backend: collection.backend,
          source: collection.source,
        };

        const result = await deleteCollection(
          collection.id,
          collectionSettings,
          collection.registryKey,
          // Set only here, only after the explicit confirmation above.
          { userConfirmedUnownedDeletion: onUserAuthority },
        );

        // Always reload, from the persisted document and a fresh backend
        // inventory: a row only disappears when deletion AND the metadata
        // cleanup actually completed, and a pending cleanup must stay visible.
        await refreshCollections({ reloadStore: true, invalidateInventory: true });

        if (result.success) {
          toastr.success(
            `Deleted collection "${collection.name}" and its VectHare metadata`,
            "VectHare",
          );
          // VH-011: rows that had to stay in Milvus' older shared store.
          for (const note of result.notes || []) toastr.info(note, "VectHare", { timeOut: 15000 });
        } else if (result.vectorsDeleted && result.absenceVerified) {
          toastr.error(
            `Vectors were deleted but the metadata cleanup did not finish: ${result.errors.join(", ")}. ` +
              "The entry is kept as a pending cleanup.",
            "VectHare",
            { timeOut: 0, extendedTimeOut: 0 },
          );
        } else {
          toastr.warning(
            `Partial deletion: ${result.errors.join(", ")}`,
            "VectHare",
          );
        }
      } catch (error) {
        console.error("VectHare: Failed to delete collection", error);
        toastr.error(`Failed to delete collection: ${error.message}`, "VectHare");
      }
    });

  // Phase 2: inspect VectHare's stored metadata for a collection
  $(".vecthare-action-view-metadata")
    .off("click")
    .on("click", async function (e) {
      e.stopPropagation();
      const collection = findCollectionByKey($(this).data("collection-key"));
      if (!collection) return;
      await openMetadataDialog(collection);
    });

  // Phase 2: remove leftover metadata for a confirmed-absent collection.
  // This deletes no vectors; it makes the chat look never-vectorized again.
  $(".vecthare-action-delete-metadata")
    .off("click")
    .on("click", async function (e) {
      e.stopPropagation();
      const collectionKey = $(this).data("collection-key");
      const collection = findCollectionByKey(collectionKey);
      if (!collection) return;

      const unownedButAbsent =
        (collection.presence === "ownership-unverified" ||
          collection.presence === "invalid-metadata") && collection.existence === "absent";
      if (collection.presence !== "metadata-only" && !unownedButAbsent) {
        toastr.warning(
          "This collection's absence is not confirmed, so its metadata is kept.",
          "VectHare",
        );
        return;
      }
      // The row's state came from the last refresh. The core re-checks the
      // exact recorded destination again before removing anything.

      const confirmed = confirm(
        `Delete VectHare metadata for "${collection.name}"?\n\n` +
          (unownedButAbsent
            ? "Nothing identifies this collection as VectHare's own, so only VectHare's own " +
              "local record for it is removed. No vectors are deleted and no other extension's " +
              "data is touched.\n\n"
            : "") +
          `The physical collection was confirmed absent at its recorded destination ` +
          `(${collection.backend || "unknown"} / ${collection.source || "unknown"}).\n\n` +
          `This removes VectHare's stored associations for it: registry entry, collection ` +
          `metadata, chat binding, chunk annotations and its identity ledger. Reopening the ` +
          `chat will then be treated as never vectorized.\n\n` +
          `No vectors are deleted and your chat messages are not touched.\n\n` +
          `Press OK for "Yes, Delete Metadata" or Cancel for "No, Cancel".`,
      );
      if (!confirmed) return;

      try {
        const result = await deleteCollectionMetadataOnly(
          collection.id,
          {
            ...browserState.settings,
            vector_backend: collection.backend,
            source: collection.source,
          },
          collection.registryKey,
          { model: collection.model || "" },
        );

        // Re-read the persisted document rather than assuming: the row only
        // disappears if the reset actually reached disk, and a fresh inventory
        // stops a stale cached count from rebuilding it.
        await refreshCollections({ reloadStore: true, invalidateInventory: true });

        if (result.success) {
          toastr.success(
            `Removed metadata for "${collection.name}" (${result.removed.join(", ") || "nothing left to remove"})` +
              `${result.verified ? " - verified gone from VectHare's metadata file" : ""}`,
            "VectHare",
          );
        } else {
          toastr.error(
            `Metadata was not fully removed: ${result.errors.join(", ")}`,
            "VectHare",
            { timeOut: 0, extendedTimeOut: 0 },
          );
        }
      } catch (error) {
        console.error("VectHare: Metadata reset failed", error);
        toastr.error(`Metadata reset failed: ${error.message}`, "VectHare");
      }
    });

  // Regenerate only the local metadata that can be independently verified.
  // Never vectorizes and never fabricates provenance.
  $(".vecthare-action-regenerate-metadata")
    .off("click")
    .on("click", async function (e) {
      e.stopPropagation();
      if ($(this).is(":disabled")) return;
      const collection = findCollectionByKey($(this).data("collection-key"));
      if (!collection) return;

      const confirmed = confirm(
        `Regenerate metadata for "${collection.name}"?\n\n` +
          "This refreshes only VectHare's local records that can be independently " +
          "verified at the recorded destination: registry entry, chunk count and " +
          "demonstrably invalid local fields.\n\n" +
          "It does NOT vectorize anything, does not create or change any collection, " +
          "and never invents original settings, chat ownership or ledger history. " +
          "Your annotations are kept.\n\n" +
          'Press OK for "Yes, Regenerate" or Cancel for "No, Cancel".',
      );
      if (!confirmed) return;

      try {
        const result = await regenerateCollectionMetadata(
          collection.id,
          {
            ...browserState.settings,
            vector_backend: collection.backend,
            source: collection.source,
          },
          collection.registryKey,
        );
        await refreshCollections({ reloadStore: true, invalidateInventory: true });

        const summary = [
          result.restored.length ? `restored: ${result.restored.join(", ")}` : "",
          result.preserved.length ? `preserved: ${result.preserved.join(", ")}` : "",
          result.cleared.length ? `cleared: ${result.cleared.join(", ")}` : "",
          result.unverified.length ? `left unverified: ${result.unverified.join(", ")}` : "",
        ]
          .filter(Boolean)
          .join(" · ");

        if (result.success) {
          toastr.success(summary || "Nothing needed regenerating", "VectHare", { timeOut: 12000 });
        } else {
          toastr.warning(
            `Nothing was regenerated — ${summary}`,
            "VectHare",
            { timeOut: 12000 },
          );
        }
      } catch (error) {
        console.error("VectHare: Metadata regeneration failed", error);
        toastr.error(`Metadata regeneration failed: ${error.message}`, "VectHare");
      }
    });

  // Open folder
  // 9d / P6: move a collection to the other layout of its backend.
  $(".vecthare-action-move-storage")
    .off("click")
    .on("click", async function (e) {
      e.stopPropagation();
      const collection = findCollectionByKey($(this).data("collection-key"));
      if (!collection) return;
      const button = $(this);
      const collectionSettings = { ...browserState.settings, vector_backend: collection.backend, source: collection.source };
      button.prop("disabled", true);
      try {
        const plan = await planStorageMove(collection.id, collectionSettings);
        if (!plan.ok) {
          toastr.info(plan.reason, "VectHare: Move storage", { timeOut: 10000 });
          return;
        }
        const label = (layout) => LAYOUT_LABELS[layout] || layout;
        const confirmed = confirm(
          `Move "${collection.name}" from ${label(plan.from.layout)} (${plan.from.physical}) ` +
            `to ${label(plan.to)}?\n\n` +
            "The vectors are copied as they are (no re-embedding) on the same server, checked, and only then " +
            "does VectHare switch over. The old copy is kept until you delete it in the Storage tab.\n\n" +
            "Do not vectorize this chat in another tab meanwhile; reload other open tabs afterwards.",
        );
        if (!confirmed) return;
        const toast = toastr.info("Moving…", "VectHare: Move storage", { timeOut: 0, extendedTimeOut: 0 });
        const result = await moveCollectionStorage(collection.id, collectionSettings, {
          onPhase: (phase) => toast?.find?.(".toast-message").text(phase),
        });
        toastr.clear(toast);
        if (result.success) {
          toastr.success(`Moved ${result.copied} vectors to ${result.to.physical}. The old copy is listed in the Storage tab.` +
            (result.warnings.length ? ` ${result.warnings.join(" ")}` : ""), "VectHare: Move storage", { timeOut: 12000 });
        } else {
          (result.uncertain ? toastr.error : toastr.warning)(result.reason +
            (result.warnings.length ? ` ${result.warnings.join(" ")}` : ""), "VectHare: Move storage",
            { timeOut: 0, extendedTimeOut: 0 });
        }
        await refreshCollections({ reloadStore: true, invalidateInventory: true });
      } catch (error) {
        toastr.error(error.message, "VectHare: Move storage");
      } finally {
        button.prop("disabled", false);
      }
    });

  $(".vecthare-action-open-folder")
    .off("click")
    .on("click", async function (e) {
      e.stopPropagation();
      const collectionKey = $(this).data("collection-key");
      const collection = findCollectionByKey(collectionKey);

      if (!collection) return;

      try {
        const response = await fetch("/api/plugins/similharity/open-folder", {
          method: "POST",
          headers: getRequestHeaders(),
          body: JSON.stringify({
            collectionId: collection.id,
            backend: collection.backend,
            source: collection.source,
          }),
        });

        if (!response.ok) {
          // The plugin says exactly why (remote backend, folder missing); a
          // bare "Bad Request" told the user nothing.
          const reason = await response.json().then(body => body?.error).catch(() => "");
          throw new Error(reason || response.statusText || `HTTP ${response.status}`);
        }

        // VH-060: on a shared server the folder is not on this device; show where it is.
        const result = await response.json().catch(() => ({}));
        if (result?.opened === false) {
          toastr.info(`${escapeHtml(result.reason || "The folder is on the server")}:<br><code>${escapeHtml(result.path || "")}</code>`,
            "VectHare: Collection folder", { timeOut: 20000, escapeHtml: false });
        } else {
          toastr.success("Opened collection folder", "VectHare");
        }
      } catch (error) {
        console.error("VectHare: Failed to open folder", error);
        toastr.error(error.message, "VectHare: Could not open the folder");
      }
    });

  // Visualize chunks
  $(".vecthare-action-visualize")
    .off("click")
    .on("click", async function (e) {
      e.stopPropagation();
      const collectionKey = $(this).data("collection-key");
      const collection = findCollectionByKey(collectionKey);

      if (!collection) return;

      let loadingToast = null;
      try {
        // Closed as soon as loading ends (it used to stay up over the opened chunks).
        loadingToast = toastr.info("Loading chunks...", "VectHare", { timeOut: 0, extendedTimeOut: 0 });

        // Use the collection's actual backend, not the global setting
        // This ensures we query Standard collections with Standard backend, etc.
        if (!collection.backend) {
          toastr.error(
            "Collection has no backend defined - this is a bug",
            "VectHare",
          );
          console.error("VectHare: Collection missing backend:", collection);
          return;
        }

        const collectionSettings = settingsForCollection(collection);

        // Use unified plugin endpoint
        const requestBody = {
          backend: collection.backend || "vectra",
          collectionId: collection.id,
          source: collection.source || "transformers",
          model: collection.model || "",
          limit: 1000, // Get first 1000 chunks
        };

        vhLog("VectHare DB Browser: Requesting chunks with:", requestBody);

        const data = await listCollectionChunksForBrowser(collection, collectionSettings, requestBody);
        // Support all plugin response shapes: items (new), chunks/results (older/backends)
        const results = data.items || data.chunks || data.results || [];

        if (!results || results.length === 0) {
          toastr.warning("No chunks found in this collection", "VectHare");
          return;
        }

        // Format chunks for visualizer
        const chunks = results.map((item, idx) => ({
          hash: item.hash,
          index: collection.type === "chat" ? getChatChunkSourceIndex(item, idx) : item.index ?? idx,
          text: item.text || item.metadata?.text || "No text available",
          score: 1.0,
          similarity: 1.0,
          messageAge: item.metadata?.messageAge,
          decayApplied: false,
          decayMultiplier: 1.0,
          metadata: item.metadata, // Pass through all metadata including keywords
        }));

        // Pass collection-specific settings so visualizer uses correct backend for edits/deletes
        // Include collection type so visualizer knows if this is a chat (for Scenes tab)
        openVisualizer(
          { chunks, collectionType: collection.type },
          collection.id,
          collectionSettings,
        );
      } catch (error) {
        console.error("VectHare: Failed to load chunks", error);
        toastr.error(`Failed to load chunks: ${error.message}`, "VectHare");
      } finally {
        if (loadingToast) toastr.clear(loadingToast);
      }
    });

  // Export toggle - show/hide export options
  $(".vecthare-action-export-toggle")
    .off("click")
    .on("click", function (e) {
      e.stopPropagation();
      const $dropdown = $(this).closest(".vecthare-export-dropdown");
      const isExpanded = $dropdown.hasClass("expanded");

      // Close any other open dropdowns
      $(".vecthare-export-dropdown.expanded")
        .not($dropdown)
        .removeClass("expanded");

      // Toggle this one
      $dropdown.toggleClass("expanded", !isExpanded);
    });

  // Close export dropdown when clicking elsewhere
  $(document)
    .off("click.vecthare-export")
    .on("click.vecthare-export", function (e) {
      if (!$(e.target).closest(".vecthare-export-dropdown").length) {
        $(".vecthare-export-dropdown.expanded").removeClass("expanded");
      }
    });

  // Export collection (JSON)
  $(".vecthare-action-export")
    .off("click")
    .on("click", async function (e) {
      e.stopPropagation();
      const collectionKey = $(this).data("collection-key");
      const collectionId = $(this).data("collection-id");
      const backend = $(this).data("backend");
      const source = $(this).data("source");
      const model = $(this).data("model");

      const collection = findCollectionByKey(collectionKey);
      if (!collection) return;

      try {
        toastr.info("Exporting collection...", "VectHare");

        const exportData = await exportCollection(
          collectionId,
          browserState.settings,
          {
            backend,
            source,
            model,
          },
        );

        downloadExport(exportData, collection.name || collectionId);

        toastr.success(
          `Exported ${exportData.stats.chunkCount} chunks (${exportData.stats.chunksWithVectors} with vectors)`,
          "VectHare Export",
        );
      } catch (error) {
        console.error("VectHare: Export failed", error);
        toastr.error(`Export failed: ${error.message}`, "VectHare");
      }
    });

  // Export collection (PNG)
  $(".vecthare-action-export-png")
    .off("click")
    .on("click", async function (e) {
      e.stopPropagation();
      const collectionKey = $(this).data("collection-key");
      const collectionId = $(this).data("collection-id");
      const backend = $(this).data("backend");
      const source = $(this).data("source");
      const model = $(this).data("model");

      const collection = findCollectionByKey(collectionKey);
      if (!collection) return;

      // Store export context for image picker callback
      browserState.pendingPngExport = {
        collectionKey,
        collectionId,
        backend,
        source,
        model,
        collection,
      };

      // Ask if they want to use a custom image
      const useCustomImage = confirm(
        "Export as PNG\n\n" +
          "Would you like to use a custom image?\n\n" +
          "• Click OK to choose an image file\n" +
          "• Click Cancel to use default VectHare image",
      );

      if (useCustomImage) {
        $("#vecthare_png_image_picker").click();
      } else {
        // Export with default image
        await performPngExport(null);
      }
    });

  // PNG image picker handler
  $("#vecthare_png_image_picker")
    .off("change")
    .on("change", async function (e) {
      const file = e.target.files[0];
      $(this).val(""); // Reset for next use

      if (!file) {
        browserState.pendingPngExport = null;
        return;
      }

      await performPngExport(file);
    });

  // Activation editor (triggers + conditions)
  $(".vecthare-action-activation")
    .off("click")
    .on("click", function (e) {
      e.stopPropagation();
      const collectionKey = $(this).data("collection-key");
      const collection = findCollectionByKey(collectionKey);
      if (collection) {
        openActivationEditor(collection.id, collection.name);
      }
    });

  // Rename collection
  $(".vecthare-action-rename")
    .off("click")
    .on("click", function (e) {
      e.stopPropagation();
      const collectionKey = $(this).data("collection-key");
      const collection = findCollectionByKey(collectionKey);
      if (collection) {
        openRenameDialog(collection.id, collection.name);
      }
    });

  // Switch model (for collections with multiple embedding models)
  $(".vecthare-action-switch-model")
    .off("click")
    .on("click", async function (e) {
      e.stopPropagation();
      const collectionKey = $(this).data("collection-key");
      const collection = findCollectionByKey(collectionKey);

      if (!collection || !collection.models || collection.models.length < 2) {
        return;
      }

      openModelSwitcher(collection);
    });
}

/**
 * Updates stats footer
 * @param {number} collectionCount Number of collections shown
 * @param {number} chunkCount Total chunks
 */
function updateStats(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) {
    $("#vecthare_browser_stats_text").text("No collections").attr("title", "");
    return;
  }

  // Every row counts once, in exactly one bucket, decided by the explicit
  // backend existence answer - never by a registry entry or a chunk count:
  //   physical     = existence confirmed at the recorded destination (empty included)
  //   metadataOnly = confirmed absent AND a validated VectHare record exists
  //   unresolved   = existence not verifiable, or the record is invalid or unowned
  let physical = 0;
  let metadataOnly = 0;
  let invalid = 0;
  let ownershipUnverified = 0;
  let notVectHareCount = 0;
  let stBuiltInCount = 0;
  let unverified = 0;
  let chunks = 0;
  let countsUnverified = 0;
  for (const row of list) {
    // Counted alongside its bucket, never instead of it: a collection that is
    // not VectHare's still exists if the backend says so.
    if (row.metadataRecord?.sillyTavernBuiltIn) stBuiltInCount++;
    else if (row.metadataRecord?.foreign) notVectHareCount++;
    if (row.existence === "present") physical++;
    else if (row.presence === "metadata-only") metadataOnly++;
    else if (row.presence === "invalid-metadata") invalid++;
    else if (row.presence === "ownership-unverified") ownershipUnverified++;
    else unverified++;

    // Verified counts only: an untrusted count contributes nothing.
    if (row.existence === "present" && row.countTrusted === true) {
      chunks += Number(row.chunkCount) || 0;
    } else if (row.existence === "present") {
      countsUnverified++;
    }
  }

  const parts = [`${physical} Collection${physical === 1 ? "" : "s"}`];
  if (metadataOnly) parts.push(`${metadataOnly} Metadata Only`);
  if (invalid) parts.push(`${invalid} Invalid Metadata`);
  if (stBuiltInCount) parts.push(`${stBuiltInCount} SillyTavern Built-in`);
  if (notVectHareCount) parts.push(`${notVectHareCount} Not VectHare-Owned`);
  if (ownershipUnverified) parts.push(`${ownershipUnverified} Ownership Unverified`);

  if (unverified) parts.push(`${unverified} Unverified`);
  parts.push(`${chunks} Total Chunks${countsUnverified ? "+" : ""}`);

  const detail = [
    `${physical} collection(s) whose existence was confirmed at their recorded destination, empty ones included`,
    `${metadataOnly} entr(y/ies) confirmed absent with a validated VectHare metadata record`,
    `${invalid} entr(y/ies) whose VectHare record is malformed, incomplete or not a record at all`,
    `${stBuiltInCount} of the entries above are SillyTavern's own built-in vectors (chats, files or World Info made by its Vector Storage)`,
    `${notVectHareCount} of the entries above carry no VectHare marker (most likely another extension's, or a SillyTavern collection VectHare could not recognise)`,
    `${ownershipUnverified} entr(y/ies) whose VectHare ownership could not be established`,
    `${unverified} entr(y/ies) whose existence could not be checked at their recorded destination`,
    `${chunks} chunks counted from verified backend counts only`,
  ];
  if (countsUnverified) {
    detail.push(`${countsUnverified} existing collection(s) had an untrusted count and add no chunks here`);
  }

  $("#vecthare_browser_stats_text").text(parts.join(" · ")).attr("title", detail.join("\n"));
}

/**
 * Re-renders the open Metadata window, if any, from freshly loaded state.
 * Read-only: it never writes, and an entry that no longer exists says so
 * rather than being redrawn from the values it held before.
 */
async function refreshOpenMetadataDialog() {
  const key = browserState.openMetadataKey;
  if (!key || !$("#vecthare_metadata_modal").hasClass("active")) return;
  const collection = findCollectionByKey(key);
  if (!collection) {
    $("#vecthare_metadata_body").html(
      "<p>This entry no longer exists. Its VectHare metadata has been removed.</p>");
    $("#vecthare_metadata_delete").prop("disabled", true).data("action", null)
      .attr("title", "There is nothing left to delete.").text("Delete");
    $("#vecthare_metadata_delete_meta").prop("disabled", true)
      .attr("title", "There is nothing left to delete.");
    return;
  }
  // Re-opening re-reads the entry and re-decides what Delete may offer.
  await openMetadataDialog(collection);
}

// ============================================================================
// RENAME DIALOG
// ============================================================================

/**
 * Opens a rename dialog for a collection
 * @param {string} collectionId Collection ID
 * @param {string} currentName Current display name
 */
function openRenameDialog(collectionId, currentName) {
  // Create modal if needed
  if ($("#vecthare_rename_modal").length === 0) {
    const modalHtml = `
            <div id="vecthare_rename_modal" class="vecthare-modal">
                <div class="vecthare-modal-content vecthare-rename-dialog popup">
                    <div class="vecthare-modal-header">
                        <h3>✏️ Rename Collection</h3>
                        <button class="vecthare-btn-icon" id="vecthare_rename_close">✕</button>
                    </div>
                    <div class="vecthare-rename-body">
                        <label for="vecthare_rename_input">New name:</label>
                        <input type="text" id="vecthare_rename_input" placeholder="Enter new name..." autocomplete="off">
                        <small class="vecthare-rename-hint">Leave empty to reset to auto-generated name</small>
                    </div>
                    <div class="vecthare-modal-footer">
                        <button class="vecthare-btn" id="vecthare_rename_cancel">Cancel</button>
                        <button class="vecthare-btn vecthare-btn-primary" id="vecthare_rename_save">Save</button>
                    </div>
                </div>
            </div>
        `;
    $("body").append(modalHtml);

    // Bind events
    $("#vecthare_rename_close, #vecthare_rename_cancel").on(
      "click",
      closeRenameDialog,
    );
    // Stop mousedown propagation (ST closes drawers on mousedown/touchstart)
    $("#vecthare_rename_modal").on("mousedown touchstart", function (e) {
      e.stopPropagation();
    });
    // Close on background click
    $("#vecthare_rename_modal").on("click", function (e) {
      if (e.target === this) closeRenameDialog();
    });
    $("#vecthare_rename_input").on("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        $("#vecthare_rename_save").click();
      } else if (e.key === "Escape") {
        closeRenameDialog();
      }
    });
  }

  // Store collection ID for save handler
  $("#vecthare_rename_modal").data("collection-id", collectionId);

  // Set current name
  $("#vecthare_rename_input").val(currentName);

  // Bind save handler (rebind each time to get fresh collectionId)
  $("#vecthare_rename_save")
    .off("click")
    .on("click", function () {
      const newName = $("#vecthare_rename_input").val().trim();
      const id = $("#vecthare_rename_modal").data("collection-id");

      // Save the new name (or null to reset)
      setCollectionMeta(id, { displayName: newName || null });

      // Update local state
      const collection = browserState.collections.find((c) => c.id === id);
      if (collection) {
        collection.name = newName || collection.name; // Will refresh properly on next load
      }

      closeRenameDialog();
      refreshCollections({ reloadStore: true, invalidateInventory: true }); // Reload to get updated names

      if (newName) {
        toastr.success(`Renamed to "${newName}"`, "VectHare");
      } else {
        toastr.success("Reset to auto-generated name", "VectHare");
      }
    });

  // Show modal and focus input
  $("#vecthare_rename_modal").fadeIn(200, function () {
    $("#vecthare_rename_input").focus().select();
  });
}

/**
 * Closes the rename dialog
 */
function closeRenameDialog() {
  $("#vecthare_rename_modal").fadeOut(200);
}

// ============================================================================
// MODEL SWITCHER
// ============================================================================

/**
 * Opens the model switcher modal
 * @param {object} collection Collection object with models array
 */
function openModelSwitcher(collection) {
  // Create modal if it doesn't exist
  if ($("#vecthare_model_switcher_modal").length === 0) {
    const modalHtml = `
            <div id="vecthare_model_switcher_modal" class="vecthare-modal">
                <div class="vecthare-modal-content vecthare-model-switcher-content popup">
                    <div class="vecthare-modal-header">
                        <h3><i class="fa-solid fa-code-branch"></i> Switch Embedding Model</h3>
                        <button class="vecthare-btn-icon" id="vecthare_model_switcher_close">✕</button>
                    </div>
                    <div class="vecthare-modal-body">
                        <p class="vecthare-model-switcher-desc">
                            Select which embedding model to use for this collection.
                            Each model may have different vectors from different embedding providers.
                        </p>
                        <div id="vecthare_model_list" class="vecthare-model-list"></div>
                    </div>
                </div>
            </div>
        `;
    $("body").append(modalHtml);

    // Bind close
    $("#vecthare_model_switcher_close").on("click", closeModelSwitcher);
    // Stop mousedown propagation (ST closes drawers on mousedown/touchstart)
    $("#vecthare_model_switcher_modal").on("mousedown touchstart", function (e) {
      e.stopPropagation();
    });
    // Close on background click
    $("#vecthare_model_switcher_modal").on("click", function (e) {
      if (e.target === this) closeModelSwitcher();
    });
  }

  // Store collection reference
  $("#vecthare_model_switcher_modal").data("collection", collection);

  // Build model list
  const modelListHtml = collection.models
    .map((model) => {
      const isActive = model.path === collection.model;
      const modelName = model.name || "(default)";
      const chunkLabel = model.chunkCount === 1 ? "chunk" : "chunks";

      return `
            <div class="vecthare-model-item ${isActive ? "vecthare-model-active" : ""}"
                 data-model-path="${escapeHtml(model.path)}">
                <div class="vecthare-model-item-info">
                    <span class="vecthare-model-name">
                        ${isActive ? '<i class="fa-solid fa-check"></i>' : '<i class="fa-solid fa-cube"></i>'}
                        ${escapeHtml(modelName)}
                    </span>
                    <span class="vecthare-model-chunks">${model.chunkCount} ${escapeHtml(chunkLabel)}</span>
                </div>
                ${
                  isActive
                    ? '<span class="vecthare-model-badge-current">Current</span>'
                    : '<button class="vecthare-btn-sm vecthare-model-select-btn">Set as Primary</button>'
                }
            </div>
        `;
    })
    .join("");

  $("#vecthare_model_list").html(modelListHtml);

  // Bind selection
  $(".vecthare-model-select-btn")
    .off("click")
    .on("click", function (e) {
      e.stopPropagation();
      const modelPath = $(this)
        .closest(".vecthare-model-item")
        .data("model-path");
      const coll = $("#vecthare_model_switcher_modal").data("collection");

      // Update collection
      coll.model = modelPath;
      const modelInfo = coll.models.find((m) => m.path === modelPath);
      if (modelInfo) {
        coll.chunkCount = modelInfo.chunkCount;
      }

      // Persist
      setCollectionMeta(coll.registryKey || coll.id, {
        preferredModel: modelPath,
      });

      toastr.success(
        `Set primary model: ${modelPath || "(default)"}`,
        "VectHare",
      );
      closeModelSwitcher();
      renderCollections();
    });

  // Show
  $("#vecthare_model_switcher_modal").fadeIn(200);
}

/**
 * Closes the model switcher modal
 */
function closeModelSwitcher() {
  $("#vecthare_model_switcher_modal").fadeOut(200);
}

// ============================================================================
// CONDITIONS EDITOR
// ============================================================================

// Collection-level condition types (11 types)
// Note: "keyword" renamed to "pattern" - triggers handle simple keywords,
// this is for advanced regex/pattern matching with custom scan depth
const CONDITION_TYPES = [
  {
    value: "pattern",
    label: "🔍 Pattern Match",
    desc: "Advanced regex/pattern in messages",
  },
  { value: "speaker", label: "🗣️ Speaker", desc: "Match by who spoke last" },
  {
    value: "characterPresent",
    label: "👥 Character Present",
    desc: "Check if character spoke recently",
  },
  {
    value: "messageCount",
    label: "#️⃣ Message Count",
    desc: "Conversation length check",
  },
  { value: "emotion", label: "😊 Emotion", desc: "Detect emotional tone" },
  { value: "isGroupChat", label: "👪 Group Chat", desc: "Group vs 1-on-1" },
  {
    value: "generationType",
    label: "⚙️ Gen Type",
    desc: "Normal, swipe, continue, etc.",
  },
  {
    value: "lorebookActive",
    label: "📖 Lorebook",
    desc: "Check if lorebook entry active",
  },
  {
    value: "swipeCount",
    label: "👆 Swipe Count",
    desc: "Swipes on last message",
  },
  {
    value: "timeOfDay",
    label: "🕐 Time of Day",
    desc: "Real-world time window",
  },
  {
    value: "randomChance",
    label: "🎲 Random",
    desc: "Probabilistic activation",
  },
];

// ============================================================================
// COLLECTION SETTINGS EDITOR (Activation + Triggers + Conditions + Decay)
// ============================================================================

let activationEditorState = {
  collectionId: null,
  collectionName: null,
  collectionType: "unknown",
  alwaysActive: false,
  triggers: [],
  triggerMatchMode: "any",
  triggerCaseSensitive: false,
  triggerScanDepth: 5,
  conditions: null,
  // Temporal Weighting (decay or nostalgia)
  temporalDecay: {
    enabled: false,
    type: "decay", // 'decay' or 'nostalgia'
    mode: "exponential",
    halfLife: 50,
    linearRate: 0.01,
    minRelevance: 0.3,
    maxBoost: 1.2,
    sceneAware: false,
  },
  // Injection settings (position/depth)
  position: null, // null = use global default
  depth: null, // null = use global default
};

/**
 * Opens the collection settings editor
 * @param {string} collectionId Collection ID
 * @param {string} collectionName Display name
 */
function openActivationEditor(collectionId, collectionName) {
  const meta = getCollectionMeta(collectionId);
  const triggerSettings = getCollectionTriggers(collectionId);
  const conditions = getCollectionConditions(collectionId);

  // Get decay settings - use type-aware defaults if not explicitly set
  const collectionType =
    meta.scope === "chat" ? "chat" : meta.type || "unknown";
  const decaySettings = getCollectionDecaySettings(collectionId);

  activationEditorState = {
    collectionId,
    collectionName,
    collectionType,
    alwaysActive: meta.alwaysActive || false,
    lockMode: meta.lockMode || "prefer",
    exclusiveWhenActive: meta.exclusiveWhenActive || false,
    exclusiveScope: meta.exclusiveScope || "lorebook",
    selectedForCurrentChat: isCollectionSelectedForChat(collectionId, getCurrentChatId()),
    chatPolicy: getChatCollectionPolicy(getCurrentChatId()),
    triggers: triggerSettings.triggers || [],
    triggerMatchMode: triggerSettings.matchMode || "any",
    triggerCaseSensitive: triggerSettings.caseSensitive || false,
    triggerScanDepth: triggerSettings.scanDepth || 5,
    conditions,
    temporalDecay: {
      enabled: decaySettings.enabled,
      type: decaySettings.type || "decay",
      mode: decaySettings.mode,
      halfLife: decaySettings.halfLife,
      linearRate: decaySettings.linearRate,
      minRelevance: decaySettings.minRelevance,
      maxBoost: decaySettings.maxBoost || 1.2,
      sceneAware: decaySettings.sceneAware,
    },
    // Prompt context
    context: meta.context || "",
    xmlTag: meta.xmlTag || "",
    // Injection position/depth (null = use global default)
    position: meta.position ?? null,
    depth: meta.depth ?? null,
  };

  // Create modal if needed
  if ($("#vecthare_activation_editor_modal").length === 0) {
    createActivationEditorModal();
  }

  // Populate with current settings
  renderActivationEditor();

  $("#vecthare_activation_editor_modal").fadeIn(200);
}

/**
 * Closes the activation editor
 */
function closeActivationEditor() {
  $("#vecthare_activation_editor_modal").fadeOut(200);
  activationEditorState.collectionId = null;
}

/**
 * Creates the activation editor modal
 * Primary: Triggers (like lorebook)
 * Secondary: Advanced conditions
 */
function createActivationEditorModal() {
  const modalHtml = `
        <div id="vecthare_activation_editor_modal" class="vecthare-modal">
            <div class="vecthare-activation-editor">
                <div class="vecthare-modal-header">
                                    <h3>⚙️ Collection Settings</h3>
                                    <div style="display:flex; gap:8px; align-items:center;">
                                        <button id="vecthare_activation_lock_collection" class="vecthare-btn-sm" title="Lock this collection to the current chat">🔒 Lock to Chat</button>
                                        <button class="vecthare-btn-icon" id="vecthare_activation_close">✕</button>
                                    </div>
                                </div>

                <div class="vecthare-activation-body">
                    <div class="vecthare-activation-collection-name">
                        Collection: <strong id="vecthare_activation_collection_name"></strong>
                    </div>

                    <!-- Always Active Toggle -->
                    <div class="vecthare-activation-section vecthare-always-active">
                        <label class="vecthare-checkbox-label">
                            <input type="checkbox" id="vecthare_always_active">
                            <strong>∞ Always Active</strong>
                        </label>
                        <small>When enabled, this collection always queries (ignores triggers and conditions)</small>
                    </div>

                    <div class="vecthare-activation-section vecthare-lock-mode-section">
                        <label for="vecthare_lock_mode"><strong>🔒 Lock Behavior</strong></label>
                        <select id="vecthare_lock_mode" class="text_pole">
                            <option value="prefer">Prefer locked chats/characters</option>
                            <option value="exclusive">Only use in locked chats/characters</option>
                        </select>
                        <small>"Only use" makes locks restrictive: if this collection is locked elsewhere, it cannot activate here.</small>
                    </div>

                    <div class="vecthare-activation-section vecthare-chat-policy-section">
                        <label class="vecthare-checkbox-label">
                            <input type="checkbox" id="vecthare_force_current_chat">
                            <strong>📌 Force in Current Chat</strong>
                        </label>
                        <small>Queries this collection in the current chat without needing triggers or Always Active. Disabled collections still stay disabled.</small>
                        <label for="vecthare_chat_collection_policy" style="margin-top: 8px; display:block;">Current chat collection policy:</label>
                        <select id="vecthare_chat_collection_policy" class="text_pole">
                            <option value="normal">Normal smart activation</option>
                            <option value="prefer_selected">Prefer forced/selected collections</option>
                            <option value="only_selected">Only selected lorebook collections</option>
                        </select>
                    </div>

                    <div class="vecthare-activation-section vecthare-exclusive-section">
                        <label class="vecthare-checkbox-label">
                            <input type="checkbox" id="vecthare_exclusive_when_active">
                            <strong>🚫 Suppress peer collections when active</strong>
                        </label>
                        <select id="vecthare_exclusive_scope" class="text_pole">
                            <option value="lorebook">Suppress other lorebooks</option>
                            <option value="all">Suppress all other collections</option>
                        </select>
                        <small>Useful when a specific lorebook should be the only lorebook injected for a chat.</small>
                    </div>

                    <!-- ========================================== -->
                    <!-- PRIMARY: ACTIVATION TRIGGERS (Like Lorebook) -->
                    <!-- ========================================== -->
                    <div class="vecthare-activation-section vecthare-triggers-section">
                        <div class="vecthare-section-header">
                            <h4>🎯 Activation Triggers <span class="vecthare-badge-primary">Primary</span></h4>
                            <small>Simple keyword-based activation, like lorebook entries</small>
                        </div>

                        <div class="vecthare-triggers-input">
                            <label>Trigger keywords:</label>
                            <textarea id="vecthare_triggers_input"
                                      placeholder="Enter keywords, one per line or comma-separated.&#10;Supports regex: /pattern/i"
                                      rows="4"></textarea>
                        </div>

                        <div class="vecthare-triggers-options">
                            <div class="vecthare-option-row">
                                <label>Match mode:</label>
                                <select id="vecthare_trigger_match_mode">
                                    <option value="any">ANY trigger matches (OR)</option>
                                    <option value="all">ALL triggers must match (AND)</option>
                                </select>
                            </div>
                            <div class="vecthare-option-row">
                                <label>Scan depth:</label>
                                <input type="number" id="vecthare_trigger_scan_depth" min="1" max="20" value="5">
                                <small>recent messages</small>
                            </div>
                            <div class="vecthare-option-row">
                                <label class="vecthare-checkbox-label">
                                    <input type="checkbox" id="vecthare_trigger_case_sensitive">
                                    Case sensitive
                                </label>
                            </div>
                        </div>
                    </div>

                    <!-- ========================================== -->
                    <!-- SECONDARY: ADVANCED CONDITIONS -->
                    <!-- ========================================== -->
                    <div class="vecthare-activation-section vecthare-conditions-section">
                        <div class="vecthare-section-header">
                            <h4>⚡ Advanced Conditions <span class="vecthare-badge-secondary">Secondary</span></h4>
                            <small>Complex rule-based activation (evaluated if triggers don't match or are empty)</small>
                        </div>

                        <!-- Enable toggle -->
                        <div class="vecthare-conditions-toggle">
                            <label class="vecthare-checkbox-label">
                                <input type="checkbox" id="vecthare_conditions_enabled">
                                Enable advanced conditions
                            </label>
                        </div>

                        <!-- Logic selector -->
                        <div class="vecthare-conditions-logic">
                            <label>Condition logic:</label>
                            <select id="vecthare_conditions_logic">
                                <option value="AND">ALL conditions must match (AND)</option>
                                <option value="OR">ANY condition can match (OR)</option>
                            </select>
                        </div>

                        <!-- Rules list -->
                        <div class="vecthare-conditions-rules">
                            <div class="vecthare-conditions-rules-header">
                                <span>Conditions</span>
                                <button class="vecthare-btn-sm" id="vecthare_add_condition">+ Add</button>
                            </div>
                            <div id="vecthare_conditions_list"></div>
                        </div>
                    </div>

                    <!-- ========================================== -->
                    <!-- TEMPORAL DECAY (Per-Collection) -->
                    <!-- ========================================== -->
                    <div class="vecthare-activation-section vecthare-decay-section">
                        <div class="vecthare-section-header">
                            <h4>⏳ Temporal Weighting</h4>
                            <small>Adjust chunk relevance based on message age</small>
                        </div>

                        <div class="vecthare-decay-settings">
                            <div class="vecthare-option-row">
                                <label class="vecthare-checkbox-label">
                                    <input type="checkbox" id="vecthare_decay_enabled">
                                    <strong>Enable temporal weighting</strong>
                                </label>
                            </div>

                            <div class="vecthare-decay-advanced" id="vecthare_decay_advanced">
                                <div class="vecthare-type-toggle">
                                    <label class="vecthare-type-option" data-type="decay">
                                        <input type="radio" name="vecthare_decay_type" value="decay" checked>
                                        <div class="vecthare-type-card">
                                            <div class="vecthare-type-header">
                                                <span class="vecthare-type-icon">📉</span>
                                                <strong>Decay</strong>
                                            </div>
                                            <small>Recent messages score higher. Older memories fade over time.</small>
                                        </div>
                                    </label>
                                    <label class="vecthare-type-option" data-type="nostalgia">
                                        <input type="radio" name="vecthare_decay_type" value="nostalgia">
                                        <div class="vecthare-type-card">
                                            <div class="vecthare-type-header">
                                                <span class="vecthare-type-icon">📈</span>
                                                <strong>Nostalgia</strong>
                                            </div>
                                            <small>Older messages score higher. Ancient history becomes more relevant.</small>
                                        </div>
                                    </label>
                                </div>

                                <div class="vecthare-curve-label">Curve</div>
                                <div class="vecthare-type-toggle vecthare-curve-toggle">
                                    <label class="vecthare-type-option" data-mode="exponential">
                                        <input type="radio" name="vecthare_decay_mode" value="exponential" checked>
                                        <div class="vecthare-type-card">
                                            <div class="vecthare-type-header">
                                                <span class="vecthare-type-icon">📐</span>
                                                <strong>Exponential</strong>
                                            </div>
                                            <small>Smooth half-life curve. Effect halves every N messages. Natural decay pattern.</small>
                                        </div>
                                    </label>
                                    <label class="vecthare-type-option" data-mode="linear">
                                        <input type="radio" name="vecthare_decay_mode" value="linear">
                                        <div class="vecthare-type-card">
                                            <div class="vecthare-type-header">
                                                <span class="vecthare-type-icon">📏</span>
                                                <strong>Linear</strong>
                                            </div>
                                            <small>Fixed rate per message. Predictable, steady change. Hits limits faster.</small>
                                        </div>
                                    </label>
                                </div>

                                <div class="vecthare-option-row vecthare-decay-exponential">
                                    <label>Half-life:</label>
                                    <input type="number" id="vecthare_decay_halflife" min="1" max="500" value="50">
                                    <small id="vecthare_halflife_hint">messages until 50% effect</small>
                                </div>

                                <div class="vecthare-option-row vecthare-decay-linear" style="display: none;">
                                    <label>Rate:</label>
                                    <input type="number" id="vecthare_decay_rate" min="0.001" max="0.5" step="0.001" value="0.01">
                                    <small>per message (0.01 = 1%)</small>
                                </div>

                                <div class="vecthare-option-row vecthare-decay-floor">
                                    <label id="vecthare_limit_label">Min relevance:</label>
                                    <input type="number" id="vecthare_decay_min" min="0" max="2" step="0.05" value="0.3">
                                    <small id="vecthare_limit_hint">floor for decay (0-1)</small>
                                </div>

                                <div class="vecthare-option-row vecthare-nostalgia-ceiling" style="display: none;">
                                    <label>Max boost:</label>
                                    <input type="number" id="vecthare_decay_max_boost" min="1" max="3" step="0.1" value="1.2">
                                    <small>ceiling for nostalgia (1.2 = 20% max boost)</small>
                                </div>

                                <div class="vecthare-option-row">
                                    <label class="vecthare-checkbox-label">
                                        <input type="checkbox" id="vecthare_decay_scene_aware">
                                        Scene-aware
                                    </label>
                                    <small>Reset weighting at scene boundaries</small>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- ========================================== -->
                    <!-- PROMPT CONTEXT -->
                    <!-- ========================================== -->
                    <div class="vecthare-activation-section vecthare-context-section">
                        <div class="vecthare-section-header">
                            <h4>💬 Prompt Context</h4>
                            <small>Add context prompts to help the AI understand chunks from this collection</small>
                        </div>

                        <div class="vecthare-context-settings">
                            <div class="vecthare-option-row">
                                <label>Context prompt:</label>
                                <textarea id="vecthare_collection_context"
                                          placeholder="e.g., Things {{char}} remembers about {{user}}:"
                                          rows="2"></textarea>
                                <small>Shown before this collection's chunks. Supports {{user}} and {{char}}.</small>
                            </div>

                            <div class="vecthare-option-row">
                                <label>XML tag (optional):</label>
                                <input type="text" id="vecthare_collection_xml_tag" placeholder="e.g., memories">
                                <small>Wraps this collection's chunks in &lt;tag&gt;...&lt;/tag&gt;</small>
                            </div>

                            <div class="vecthare-option-row vecthare-injection-row">
                                <label>Injection position:</label>
                                <select id="vecthare_collection_position">
                                    <option value="">Use global default</option>
                                    <option value="2">Before Main Prompt</option>
                                    <option value="0">After Main Prompt</option>
                                    <option value="1">In-Chat @ Depth</option>
                                </select>
                                <small>Where this collection's chunks appear in the prompt</small>
                            </div>

                            <div class="vecthare-option-row vecthare-depth-row" id="vecthare_collection_depth_row" style="display: none;">
                                <label>Injection depth: <span id="vecthare_collection_depth_value">2</span></label>
                                <input type="range" id="vecthare_collection_depth" min="0" max="50" step="1" value="2">
                                <small>Messages from end of chat to insert at</small>
                            </div>
                        </div>
                    </div>

                    <!-- Activation Priority Info -->
                    <div class="vecthare-activation-info">
                        <strong>Activation Priority:</strong>
                        <ol>
                            <li><strong>Always Active</strong> → Collection always queries</li>
                            <li><strong>Force in Current Chat</strong> → Queries in this chat without triggers</li>
                            <li><strong>Strict Locks</strong> → Can restrict collection to locked chats/characters only</li>
                            <li><strong>Triggers</strong> → Match keywords in recent messages</li>
                            <li><strong>Advanced Conditions</strong> → Evaluated if triggers empty/don't match</li>
                            <li><strong>No config</strong> → Inactive unless forced, locked, or Always Active</li>
                        </ol>
                    </div>
                </div>

                <div class="vecthare-modal-footer">
                    <button class="vecthare-btn" id="vecthare_activation_cancel">Cancel</button>
                    <button class="vecthare-btn vecthare-btn-primary" id="vecthare_activation_save">Save</button>
                </div>
            </div>
        </div>
    `;

  $("body").append(modalHtml);
  bindActivationEditorEvents();
}

/**
 * Updates hint text based on decay vs nostalgia mode
 * @param {boolean} isNostalgia True if nostalgia mode
 */
function updateTemporalWeightingHints(isNostalgia) {
  if (isNostalgia) {
    $("#vecthare_decay_type_hint").text("Older messages score higher");
    $("#vecthare_halflife_hint").text("messages until 50% of max boost");
  } else {
    $("#vecthare_decay_type_hint").text("Newer messages score higher");
    $("#vecthare_halflife_hint").text("messages until 50% relevance");
  }
}

/**
 * Binds event handlers for activation editor
 */
function bindActivationEditorEvents() {
  $("#vecthare_activation_close, #vecthare_activation_cancel").on(
    "click",
    function (e) {
      e.preventDefault();
      e.stopPropagation();
      closeActivationEditor();
    },
  );

  $("#vecthare_activation_save").on("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    saveActivation();
  });

  $("#vecthare_add_condition").on("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    addConditionRule();
  });

  // Stop mousedown propagation (ST closes drawers on mousedown/touchstart)
  $("#vecthare_activation_editor_modal").on("mousedown touchstart", function (e) {
    e.stopPropagation();
  });

  // Close on background click
  $("#vecthare_activation_editor_modal").on("click", function (e) {
    if (e.target === this) closeActivationEditor();
  });

  // Always active disables other sections
  $("#vecthare_always_active").on("change", function (e) {
    e.stopPropagation();
    const isAlwaysActive = $(this).prop("checked");
    $(".vecthare-triggers-section, .vecthare-conditions-section").toggleClass(
      "vecthare-disabled",
      isAlwaysActive,
    );
  });

  // Decay enabled toggle shows/hides advanced settings
  $("#vecthare_decay_enabled").on("change", function (e) {
    e.stopPropagation();
    const enabled = $(this).prop("checked");
    $("#vecthare_decay_advanced").toggle(enabled);
  });

  // Decay mode toggle shows/hides exponential vs linear settings
  $('input[name="vecthare_decay_mode"]').on("change", function (e) {
    e.stopPropagation();
    const mode = $(this).val();
    $(".vecthare-decay-exponential").toggle(mode === "exponential");
    $(".vecthare-decay-linear").toggle(mode === "linear");
    // Update visual selection state
    $(".vecthare-curve-toggle .vecthare-type-option").removeClass("selected");
    $(this).closest(".vecthare-type-option").addClass("selected");
  });

  // Decay type toggle shows/hides decay-specific vs nostalgia-specific fields
  $('input[name="vecthare_decay_type"]').on("change", function (e) {
    e.stopPropagation();
    const isNostalgia = $(this).val() === "nostalgia";
    $(".vecthare-decay-floor").toggle(!isNostalgia);
    $(".vecthare-nostalgia-ceiling").toggle(isNostalgia);
    updateTemporalWeightingHints(isNostalgia);
    // Update visual selection state
    $(".vecthare-type-option").removeClass("selected");
    $(this).closest(".vecthare-type-option").addClass("selected");
  });

  // Activation editor: Lock-to-chat button - opens dialog to manage multiple locks
  $("#vecthare_activation_lock_collection").off("click").on("click", async function (e) {
    e.stopPropagation();
    const collId = activationEditorState.collectionId;

    if (!collId) {
      toastr.warning("No collection selected");
      return;
    }

    try {
      openCollectionLockDialog(collId);
    } catch (err) {
      console.error("VectHare: Failed to open lock dialog", err);
      toastr.error("Failed to open lock dialog");
    }
  });

  // Refresh lock button when chat changes
  eventSource.on(event_types.CHAT_CHANGED, () => {
    refreshActivationLockButton();
  });

  // Injection position toggle shows/hides depth row
  $("#vecthare_collection_position").on("change", function (e) {
    e.stopPropagation();
    const position = $(this).val();
    // Show depth row only if "In-Chat @ Depth" (value 1) is selected
    $("#vecthare_collection_depth_row").toggle(position === "1");
  });

  // Injection depth slider updates label
  $("#vecthare_collection_depth").on("input", function (e) {
    e.stopPropagation();
    $("#vecthare_collection_depth_value").text($(this).val());
  });
}

/**
 * Renders the activation editor content
 */
function renderActivationEditor() {
  const state = activationEditorState;

  $("#vecthare_activation_collection_name").text(state.collectionName);
  $("#vecthare_always_active").prop("checked", state.alwaysActive);
  $("#vecthare_lock_mode").val(state.lockMode || "prefer");
  $("#vecthare_force_current_chat").prop("checked", state.selectedForCurrentChat || false);
  $("#vecthare_chat_collection_policy").val(state.chatPolicy?.mode || "normal");
  $("#vecthare_exclusive_when_active").prop("checked", state.exclusiveWhenActive || false);
  $("#vecthare_exclusive_scope").val(state.exclusiveScope || "lorebook");

  // Triggers
  const triggersText = state.triggers.join("\n");
  $("#vecthare_triggers_input").val(triggersText);
  $("#vecthare_trigger_match_mode").val(state.triggerMatchMode);
  $("#vecthare_trigger_scan_depth").val(state.triggerScanDepth);
  $("#vecthare_trigger_case_sensitive").prop(
    "checked",
    state.triggerCaseSensitive,
  );

  // Conditions
  $("#vecthare_conditions_enabled").prop("checked", state.conditions.enabled);
  $("#vecthare_conditions_logic").val(state.conditions.logic || "AND");

  // Temporal Weighting (decay or nostalgia)
  const decay = state.temporalDecay;
  $("#vecthare_decay_enabled").prop("checked", decay.enabled);
  const decayType = decay.type || "decay";
  $(`input[name="vecthare_decay_type"][value="${decayType}"]`).prop(
    "checked",
    true,
  );
  $(".vecthare-type-option").removeClass("selected");
  $(`.vecthare-type-option[data-type="${decayType}"]`).addClass("selected");
  const decayMode = decay.mode || "exponential";
  $(`input[name="vecthare_decay_mode"][value="${decayMode}"]`).prop(
    "checked",
    true,
  );
  $(`.vecthare-type-option[data-mode="${decayMode}"]`).addClass("selected");
  $("#vecthare_decay_halflife").val(decay.halfLife);
  $("#vecthare_decay_rate").val(decay.linearRate);
  $("#vecthare_decay_min").val(decay.minRelevance);
  $("#vecthare_decay_max_boost").val(decay.maxBoost || 1.2);
  $("#vecthare_decay_scene_aware").prop("checked", decay.sceneAware);

  // Show/hide advanced decay settings based on enabled
  $("#vecthare_decay_advanced").toggle(decay.enabled);

  // Show correct decay mode fields
  $(".vecthare-decay-exponential").toggle(decay.mode === "exponential");
  $(".vecthare-decay-linear").toggle(decay.mode === "linear");

  // Show/hide type-specific fields and update hints
  const isNostalgia = decayType === "nostalgia";
  $(".vecthare-decay-floor").toggle(!isNostalgia);
  $(".vecthare-nostalgia-ceiling").toggle(isNostalgia);
  updateTemporalWeightingHints(isNostalgia);

  // Prompt Context
  $("#vecthare_collection_context").val(state.context || "");
  $("#vecthare_collection_xml_tag").val(state.xmlTag || "");

  // Injection position/depth
  const posValue = state.position !== null ? String(state.position) : "";
  $("#vecthare_collection_position").val(posValue);
  $("#vecthare_collection_depth").val(state.depth ?? 2);
  $("#vecthare_collection_depth_value").text(state.depth ?? 2);
  // Show depth row only if position is "In-Chat @ Depth" (value 1)
  $("#vecthare_collection_depth_row").toggle(state.position === 1);

  // Disable sections if always active
  const isAlwaysActive = state.alwaysActive;
  $(".vecthare-triggers-section, .vecthare-conditions-section").toggleClass(
    "vecthare-disabled",
    isAlwaysActive,
  );

  // Refresh lock button state for this collection
  refreshActivationLockButton();

  renderConditionRules();
}

/**
 * Refresh the lock button in the activation editor based on current collection and chat
 */
function refreshActivationLockButton() {
  try {
    const collId = activationEditorState.collectionId;
    const $btn = $("#vecthare_activation_lock_collection");
    const chatId = getCurrentChatId();
    const context = getContext();
    const charId = context?.characterId || null;

    if (!$btn || $btn.length === 0) return;

    if (!collId) {
      $btn.prop("disabled", true).text("🔒 Lock to Chat");
      $btn.attr("title", "No collection selected");
      return;
    }

    const chatLockCount = getCollectionLockCount(collId);
    const charLockCount = getCollectionCharacterLockCount(collId);
    const isLockedToCurrentChat = chatId && isCollectionLockedToChat(collId, chatId);
    const isLockedToCurrentChar = charId && isCollectionLockedToCharacter(collId, charId);
    const totalLocks = chatLockCount + charLockCount;

    if (totalLocks === 0) {
      $btn.prop("disabled", false).text("🔒 Manage Locks");
      $btn.attr("title", "No locks set. Click to add locks");
    } else {
      const lockedStatus = (isLockedToCurrentChat || isLockedToCurrentChar) ? "🔓" : "🔒";
      $btn.prop("disabled", false).text(`${lockedStatus} ${totalLocks} lock${totalLocks !== 1 ? "s" : ""}`);

      let tooltip = `Collection has ${totalLocks} lock${totalLocks !== 1 ? "s" : ""}`;
      if (chatLockCount > 0) tooltip += ` (${chatLockCount} chat${chatLockCount !== 1 ? "s" : ""})`;
      if (charLockCount > 0) tooltip += ` (${charLockCount} character${charLockCount !== 1 ? "s" : ""})`;
      if (isLockedToCurrentChat || isLockedToCurrentChar) tooltip += " - ACTIVE for current context";

      $btn.attr("title", tooltip);
    }
  } catch (err) {
    console.error("VectHare: Failed to refresh activation lock button", err);
  }
}

/**
 * Saves collection settings (activation + triggers + conditions + decay)
 */
function saveActivation() {
  const state = activationEditorState;

  // Parse triggers from textarea
  const triggersRaw = $("#vecthare_triggers_input").val();
  const triggers = triggersRaw
    .split(/[\n,]/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  // Build temporal weighting settings (decay or nostalgia)
  const temporalDecay = {
    enabled: $("#vecthare_decay_enabled").prop("checked"),
    type: $('input[name="vecthare_decay_type"]:checked').val() || "decay",
    mode: $('input[name="vecthare_decay_mode"]:checked').val() || "exponential",
    halfLife: parseInt($("#vecthare_decay_halflife").val()) || 50,
    linearRate: parseFloat($("#vecthare_decay_rate").val()) || 0.01,
    minRelevance: parseFloat($("#vecthare_decay_min").val()) || 0.3,
    maxBoost: parseFloat($("#vecthare_decay_max_boost").val()) || 1.2,
    sceneAware: $("#vecthare_decay_scene_aware").prop("checked"),
  };

  // Get prompt context values (sanitize xml tag)
  const contextPrompt = $("#vecthare_collection_context").val() || "";
  const xmlTagRaw = $("#vecthare_collection_xml_tag").val() || "";
  const xmlTag = xmlTagRaw.replace(/[^a-zA-Z0-9_-]/g, "");

  // Get injection position/depth (empty string = use global default = null)
  const positionRaw = $("#vecthare_collection_position").val();
  const position = positionRaw === "" ? null : parseInt(positionRaw);
  const depth =
    position === 1
      ? parseInt($("#vecthare_collection_depth").val()) || 2
      : null;

  // Update metadata (all in one call)
  setCollectionMeta(state.collectionId, {
    alwaysActive: $("#vecthare_always_active").prop("checked"),
    lockMode: $("#vecthare_lock_mode").val() || "prefer",
    exclusiveWhenActive: $("#vecthare_exclusive_when_active").prop("checked"),
    exclusiveScope: $("#vecthare_exclusive_scope").val() || "lorebook",
    triggers: triggers,
    triggerMatchMode: $("#vecthare_trigger_match_mode").val(),
    triggerScanDepth: parseInt($("#vecthare_trigger_scan_depth").val()) || 5,
    triggerCaseSensitive: $("#vecthare_trigger_case_sensitive").prop("checked"),
    temporalDecay: temporalDecay,
    context: contextPrompt,
    xmlTag: xmlTag,
    position: position,
    depth: depth,
  });

  // Save conditions
  const conditions = {
    enabled: $("#vecthare_conditions_enabled").prop("checked"),
    logic: $("#vecthare_conditions_logic").val(),
    rules: state.conditions.rules || [],
  };
  setCollectionConditions(state.collectionId, conditions);

  const currentChatId = getCurrentChatId();
  if (currentChatId) {
    const policy = getChatCollectionPolicy(currentChatId);
    setChatCollectionPolicy(currentChatId, {
      ...policy,
      mode: $("#vecthare_chat_collection_policy").val() || "normal",
    });

    if ($("#vecthare_force_current_chat").prop("checked")) {
      addCollectionToChatPolicy(currentChatId, state.collectionId);
    } else {
      removeCollectionFromChatPolicy(currentChatId, state.collectionId);
    }
  }

  closeActivationEditor();
  refreshCollections({ reloadStore: true, invalidateInventory: true });
  toastr.success("Collection settings saved", "VectHare");
}

/**
 * Renders the list of condition rules
 */
function renderConditionRules() {
  const rules = activationEditorState.conditions.rules || [];
  const container = $("#vecthare_conditions_list");

  if (rules.length === 0) {
    container.html(
      '<div class="vecthare-empty-rules">No conditions yet. Click "+ Add Condition" to add one.</div>',
    );
    return;
  }

  const rulesHtml = rules
    .map((rule, idx) => renderConditionRule(rule, idx))
    .join("");
  container.html(rulesHtml);

  // Bind rule events
  bindConditionRuleEvents();
}

/**
 * Renders a single condition rule
 */
function renderConditionRule(rule, index) {
  const typeOptions = CONDITION_TYPES.map(
    (t) =>
      `<option value="${escapeHtml(t.value)}" ${rule.type === t.value ? "selected" : ""}>${escapeHtml(t.label)}</option>`,
  ).join("");

  return `
        <div class="vecthare-condition-rule" data-rule-index="${index}">
            <div class="vecthare-condition-row">
                <select class="vecthare-condition-type" data-rule-index="${index}">
                    ${typeOptions}
                </select>
                <label class="vecthare-condition-negate">
                    <input type="checkbox" ${rule.negate ? "checked" : ""} data-rule-index="${index}">
                    NOT
                </label>
                <button class="vecthare-btn-icon vecthare-condition-remove" data-rule-index="${index}">🗑️</button>
            </div>
            <div class="vecthare-condition-settings" data-rule-index="${index}">
                ${renderConditionSettings(rule, index)}
            </div>
        </div>
    `;
}

/**
 * Renders settings for a specific condition type
 */
function renderConditionSettings(rule, index) {
  const settings = rule.settings || {};

  switch (rule.type) {
    case "keyword": // Legacy support
    case "pattern":
      return `
                <div class="vecthare-pattern-condition-wrapper">
                    <div class="vecthare-pattern-row">
                        <textarea class="vecthare-pattern-input" placeholder="Patterns (one per line)&#10;Plain text or regex: /pattern/i"
                                  data-field="patterns" data-rule-index="${index}"
                                  rows="3">${escapeHtml((settings.patterns || settings.values || []).join("\n"))}</textarea>
                    </div>
                    <div class="vecthare-pattern-options">
                        <div class="vecthare-option-row">
                            <label>Match mode:</label>
                            <select data-field="matchMode" data-rule-index="${index}">
                                <option value="any" ${settings.matchMode === "any" ? "selected" : ""}>ANY pattern matches</option>
                                <option value="all" ${settings.matchMode === "all" ? "selected" : ""}>ALL patterns must match</option>
                            </select>
                        </div>
                        <div class="vecthare-option-row">
                            <label>Scan depth:</label>
                            <input type="number" data-field="scanDepth" data-rule-index="${index}"
                                   min="1" max="100" value="${escapeHtml(settings.scanDepth || 10)}">
                            <small>messages</small>
                        </div>
                        <div class="vecthare-option-row">
                            <label>Search in:</label>
                            <select data-field="searchIn" data-rule-index="${index}">
                                <option value="all" ${settings.searchIn === "all" ? "selected" : ""}>All messages</option>
                                <option value="user" ${settings.searchIn === "user" ? "selected" : ""}>User only</option>
                                <option value="assistant" ${settings.searchIn === "assistant" ? "selected" : ""}>Assistant only</option>
                            </select>
                        </div>
                        <div class="vecthare-option-row">
                            <label class="vecthare-checkbox-label">
                                <input type="checkbox" data-field="caseSensitive" data-rule-index="${index}"
                                       ${settings.caseSensitive ? "checked" : ""}>
                                Case sensitive
                            </label>
                        </div>
                    </div>
                </div>
            `;

    case "speaker":
    case "characterPresent":
      return `
                <input type="text" placeholder="Character names (comma-separated)"
                       value="${escapeHtml((settings.values || []).join(", "))}"
                       data-field="values" data-rule-index="${index}">
                <select data-field="matchType" data-rule-index="${index}">
                    <option value="any" ${settings.matchType === "any" ? "selected" : ""}>Any matches</option>
                    <option value="all" ${settings.matchType === "all" ? "selected" : ""}>All must match</option>
                </select>
            `;

    case "messageCount":
    case "swipeCount":
      return `
                <input type="number" placeholder="Count" min="0"
                       value="${settings.count || 0}"
                       data-field="count" data-rule-index="${index}">
                <select data-field="operator" data-rule-index="${index}">
                    <option value="eq" ${settings.operator === "eq" ? "selected" : ""}>Exactly</option>
                    <option value="gte" ${settings.operator === "gte" ? "selected" : ""}>At least</option>
                    <option value="lte" ${settings.operator === "lte" ? "selected" : ""}>At most</option>
                </select>
            `;

    case "emotion":
      const emotionOptions = VALID_EMOTIONS.map(
        (e) =>
          `<option value="${escapeHtml(e)}" ${(settings.values || []).includes(e) ? "selected" : ""}>${escapeHtml(e)}</option>`,
      ).join("");
      const expressionsStatus = getExpressionsExtensionStatus();
      return `
                <div class="vecthare-emotion-condition-wrapper">
                    <div class="vecthare-conditions-notice vecthare-notice-${expressionsStatus.level} vecthare-emotion-notice">
                        ${expressionsStatus.message}
                    </div>
                    <div class="vecthare-emotion-controls">
                        <select multiple data-field="values" data-rule-index="${index}" class="vecthare-multi-select">
                            ${emotionOptions}
                        </select>
                        <select data-field="detectionMethod" data-rule-index="${index}">
                            <option value="auto" ${settings.detectionMethod === "auto" ? "selected" : ""}>Auto (recommended)</option>
                            <option value="expressions" ${settings.detectionMethod === "expressions" ? "selected" : ""}>Expressions only</option>
                            <option value="patterns" ${settings.detectionMethod === "patterns" ? "selected" : ""}>Patterns only</option>
                            <option value="both" ${settings.detectionMethod === "both" ? "selected" : ""}>Both must match</option>
                        </select>
                    </div>
                </div>
            `;

    case "isGroupChat":
      return `
                <select data-field="isGroup" data-rule-index="${index}">
                    <option value="true" ${settings.isGroup === true ? "selected" : ""}>Is group chat</option>
                    <option value="false" ${settings.isGroup === false ? "selected" : ""}>Is 1-on-1 chat</option>
                </select>
            `;

    case "generationType":
      const genOptions = VALID_GENERATION_TYPES.map(
        (g) =>
          `<option value="${escapeHtml(g)}" ${(settings.values || []).includes(g) ? "selected" : ""}>${escapeHtml(g)}</option>`,
      ).join("");
      return `
                <select multiple data-field="values" data-rule-index="${index}" class="vecthare-multi-select">
                    ${genOptions}
                </select>
            `;

    case "lorebookActive":
      // Get available world names for the picker
      const availableWorlds = world_names || [];
      const worldOptions = availableWorlds
        .map((w) => `<option value="${escapeHtml(w)}">${escapeHtml(w)}</option>`)
        .join("");
      const selectedValues = settings.values || [];
      return `
                <div class="vecthare-lorebook-picker-wrapper">
                    <div class="vecthare-lorebook-picker-row">
                        <select class="vecthare-lorebook-select" data-rule-index="${index}">
                            <option value="">-- Select Lorebook --</option>
                            ${worldOptions}
                        </select>
                        <select class="vecthare-lorebook-entry-select" data-rule-index="${index}" disabled>
                            <option value="">-- Select Entry (optional) --</option>
                        </select>
                        <button class="vecthare-btn-sm vecthare-lorebook-add" data-rule-index="${index}" type="button">+ Add</button>
                    </div>
                    <div class="vecthare-lorebook-selected" data-rule-index="${index}">
                        ${selectedValues
                          .map(
                            (v) => `
                            <span class="vecthare-lorebook-tag" data-value="${escapeHtml(v)}">
                                ${escapeHtml(v)} <button class="vecthare-lorebook-remove" data-value="${escapeHtml(v)}" data-rule-index="${index}">×</button>
                            </span>
                        `,
                          )
                          .join("")}
                    </div>
                    <input type="hidden" data-field="values" data-rule-index="${index}" value="${escapeHtml(selectedValues.join(","))}">
                </div>
            `;

    case "timeOfDay":
      return `
                <input type="time" value="${escapeHtml(settings.startTime || "00:00")}"
                       data-field="startTime" data-rule-index="${index}">
                <span>to</span>
                <input type="time" value="${escapeHtml(settings.endTime || "23:59")}"
                       data-field="endTime" data-rule-index="${index}">
            `;

    case "randomChance":
      return `
                <input type="number" placeholder="Probability %" min="0" max="100"
                       value="${escapeHtml(settings.probability || 50)}"
                       data-field="probability" data-rule-index="${index}">
                <span>%</span>
            `;

    default:
      return '<span class="vecthare-unknown-type">Unknown condition type</span>';
  }
}

/**
 * Binds events for individual condition rules
 */
function bindConditionRuleEvents() {
  // Type change
  $(".vecthare-condition-type")
    .off("change")
    .on("change", function (e) {
      e.stopPropagation();
      const idx = $(this).data("rule-index");
      activationEditorState.conditions.rules[idx].type = $(this).val();
      activationEditorState.conditions.rules[idx].settings = {};
      renderConditionRules();
    });

  // Negate toggle
  $(".vecthare-condition-negate input")
    .off("change")
    .on("change", function (e) {
      e.stopPropagation();
      const idx = $(this).data("rule-index");
      activationEditorState.conditions.rules[idx].negate =
        $(this).prop("checked");
    });

  // Remove rule
  $(".vecthare-condition-remove")
    .off("click")
    .on("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      const idx = $(this).data("rule-index");
      activationEditorState.conditions.rules.splice(idx, 1);
      renderConditionRules();
    });

  // Settings fields (inputs, selects, and textareas)
  $(
    ".vecthare-condition-settings input, .vecthare-condition-settings select, .vecthare-condition-settings textarea",
  )
    .off("change")
    .on("change", function (e) {
      e.stopPropagation();
      const idx = $(this).data("rule-index");
      const field = $(this).data("field");
      let value = $(this).val();

      // Handle patterns (textarea, newline-separated)
      if (field === "patterns" && typeof value === "string") {
        value = value
          .split("\n")
          .map((v) => v.trim())
          .filter((v) => v);
      }

      // Handle comma-separated values
      if (field === "values" && typeof value === "string") {
        value = value
          .split(",")
          .map((v) => v.trim())
          .filter((v) => v);
      }

      // Handle multi-select
      if ($(this).prop("multiple")) {
        value = $(this).val() || [];
      }

      // Handle checkboxes
      if ($(this).attr("type") === "checkbox") {
        value = $(this).prop("checked");
      }

      // Handle booleans from select
      if (field === "isGroup") {
        value = value === "true";
      }

      // Handle numbers
      if (["count", "probability", "scanDepth"].includes(field)) {
        value = parseInt(value) || 0;
      }

      if (!activationEditorState.conditions.rules[idx].settings) {
        activationEditorState.conditions.rules[idx].settings = {};
      }
      activationEditorState.conditions.rules[idx].settings[field] = value;
    });

  // Lorebook picker: world select change - load entries
  $(".vecthare-lorebook-select")
    .off("change")
    .on("change", async function (e) {
      e.stopPropagation();
      const idx = $(this).data("rule-index");
      const worldName = $(this).val();
      const entrySelect = $(
        `.vecthare-lorebook-entry-select[data-rule-index="${idx}"]`,
      );

      if (!worldName) {
        entrySelect
          .prop("disabled", true)
          .html('<option value="">-- Select Entry (optional) --</option>');
        return;
      }

      // Load world info entries
      entrySelect
        .prop("disabled", true)
        .html('<option value="">Loading...</option>');
      try {
        const worldData = await loadWorldInfo(worldName);
        if (worldData && worldData.entries) {
          const entries = Object.values(worldData.entries);
          const entryOptions = entries
            .map((entry) => {
              const displayName =
                entry.comment || entry.key?.join(", ") || `Entry ${entry.uid}`;
              return `<option value="${escapeHtml(entry.uid)}" data-key="${escapeHtml(entry.key?.join(",") || "")}">${escapeHtml(displayName)}</option>`;
            })
            .join("");
          entrySelect.html(
            `<option value="">-- Entire Lorebook --</option>${entryOptions}`,
          );
          entrySelect.prop("disabled", false);
        }
      } catch (error) {
        console.error("VectHare: Failed to load world info", error);
        entrySelect.html(
          '<option value="">-- Error loading entries --</option>',
        );
      }
    });

  // Lorebook picker: add button
  $(".vecthare-lorebook-add")
    .off("click")
    .on("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      const idx = $(this).data("rule-index");
      const worldSelect = $(
        `.vecthare-lorebook-select[data-rule-index="${idx}"]`,
      );
      const entrySelect = $(
        `.vecthare-lorebook-entry-select[data-rule-index="${idx}"]`,
      );
      const selectedContainer = $(
        `.vecthare-lorebook-selected[data-rule-index="${idx}"]`,
      );
      const hiddenInput = $(
        `input[data-field="values"][data-rule-index="${idx}"]`,
      );

      const worldName = worldSelect.val();
      if (!worldName) {
        toastr.warning("Please select a lorebook first", "VectHare");
        return;
      }

      const entryUid = entrySelect.val();
      let valueToAdd;

      if (entryUid) {
        // Specific entry: use "worldName:uid" format
        valueToAdd = `${worldName}:${entryUid}`;
      } else {
        // Entire lorebook
        valueToAdd = worldName;
      }

      // Get current values
      const currentValues = hiddenInput.val()
        ? hiddenInput
            .val()
            .split(",")
            .filter((v) => v)
        : [];
      if (currentValues.includes(valueToAdd)) {
        toastr.info("Already added", "VectHare");
        return;
      }

      currentValues.push(valueToAdd);
      hiddenInput.val(currentValues.join(","));

      // Update the visual tags
      const displayName = entryUid
        ? `${worldName}:${entrySelect.find(":selected").text()}`
        : worldName;
      selectedContainer.append(`
            <span class="vecthare-lorebook-tag" data-value="${escapeHtml(valueToAdd)}">
                ${escapeHtml(displayName)} <button class="vecthare-lorebook-remove" data-value="${escapeHtml(valueToAdd)}" data-rule-index="${idx}">×</button>
            </span>
        `);

      // Update state
      if (!activationEditorState.conditions.rules[idx].settings) {
        activationEditorState.conditions.rules[idx].settings = {};
      }
      activationEditorState.conditions.rules[idx].settings.values =
        currentValues;

      // Rebind remove buttons
      bindLorebookRemoveButtons();

      // Reset selects
      worldSelect.val("");
      entrySelect
        .prop("disabled", true)
        .html('<option value="">-- Select Entry (optional) --</option>');
    });

  // Bind remove buttons
  bindLorebookRemoveButtons();
}

/**
 * Binds lorebook tag remove buttons
 */
function bindLorebookRemoveButtons() {
  $(".vecthare-lorebook-remove")
    .off("click")
    .on("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      const idx = $(this).data("rule-index");
      const valueToRemove = $(this).data("value");
      const hiddenInput = $(
        `input[data-field="values"][data-rule-index="${idx}"]`,
      );

      // Remove from values
      const currentValues = hiddenInput.val()
        ? hiddenInput
            .val()
            .split(",")
            .filter((v) => v && v !== valueToRemove)
        : [];
      hiddenInput.val(currentValues.join(","));

      // Update state
      if (activationEditorState.conditions.rules[idx]?.settings) {
        activationEditorState.conditions.rules[idx].settings.values =
          currentValues;
      }

      // Remove the tag
      $(this).closest(".vecthare-lorebook-tag").remove();
    });
}

/**
 * Adds a new condition rule
 */
function addConditionRule() {
  if (!activationEditorState.conditions.rules) {
    activationEditorState.conditions.rules = [];
  }

  activationEditorState.conditions.rules.push({
    type: "pattern",
    negate: false,
    settings: {},
  });

  renderConditionRules();
}

// ============================================================================
// SEARCH TAB FUNCTIONS
// ============================================================================

/**
 * Binds search tab events
 */
function bindSearchEvents() {
  if (searchEventsBound) return;
  searchEventsBound = true;

  // Search button click
  $("#vecthare_search_btn").off("click").on("click", performSearch);

  // Enter key in search input
  $("#vecthare_semantic_search")
    .off("keydown")
    .on("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        performSearch();
      }
    });

  // Keyword filter events
  $("#vecthare_scan_keywords").off("click").on("click", scanKeywords);
  $("#vecthare_clear_keyword_filter").off("click").on("click", clearKeywordFilter);
  $("#vecthare_keyword_filter").off("input").on("input", updateKeywordFilterFromInput);
}

/**
 * Scans all collections for keywords
 */
async function scanKeywords() {
  const $btn = $("#vecthare_scan_keywords");
  const $tags = $("#vecthare_keyword_tags");

  $btn.prop("disabled", true).html('<i class="fa-solid fa-spinner fa-spin"></i> Scanning...');
  $tags.html('<span class="vecthare-keyword-hint">Scanning collections...</span>');

  try {
    const enabledOnly = $("#vecthare_search_enabled_only").is(":checked");
    let collectionsToScan = browserState.collections;

    if (enabledOnly) {
      collectionsToScan = collectionsToScan.filter(c => c.enabled);
    }

    const keywordCounts = new Map();

    for (const collection of collectionsToScan) {
      try {
        let data;
        try {
          data = await listCollectionChunksForBrowser(collection,
            { ...browserState.settings, vector_backend: collection.backend }, {
            backend: collection.backend || "vectra",
            collectionId: collection.id,
            source: collection.source || "transformers",
            model: collection.model || "",
            limit: 500,
          });
        } catch { continue; }
        const items = data.items || [];

        for (const item of items) {
          const keywords = item.metadata?.keywords || item.keywords || [];
          for (const kw of keywords) {
            const text = (typeof kw === 'object' ? kw.text : kw)?.toLowerCase();
            if (text) {
              keywordCounts.set(text, (keywordCounts.get(text) || 0) + 1);
            }
          }
        }
      } catch (err) {
        console.warn(`VectHare: Failed to scan keywords from ${collection.id}:`, err);
      }
    }

    // Sort by count and store
    browserState.availableKeywords = Array.from(keywordCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([text, count]) => ({ text, count }));

    renderKeywordTags();

    if (browserState.availableKeywords.length === 0) {
      $tags.html('<span class="vecthare-keyword-hint">No keywords found in scanned collections</span>');
    } else {
      toastr.success(`Found ${browserState.availableKeywords.length} unique keywords`, "VectHare");
    }
  } catch (error) {
    console.error("VectHare: Keyword scan failed", error);
    $tags.html('<span class="vecthare-keyword-hint vecthare-error">Scan failed</span>');
    toastr.error("Failed to scan keywords", "VectHare");
  } finally {
    $btn.prop("disabled", false).html('<i class="fa-solid fa-sync"></i> Scan');
  }
}

/**
 * Renders clickable keyword tags
 */
function renderKeywordTags() {
  const $tags = $("#vecthare_keyword_tags");
  const keywords = browserState.availableKeywords;

  if (keywords.length === 0) {
    $tags.html('<span class="vecthare-keyword-hint">No keywords available</span>');
    return;
  }

  // Show top 30 keywords with counts
  const displayKeywords = keywords.slice(0, 30);
  const currentFilter = browserState.keywordFilter.toLowerCase().split(',').map(k => k.trim()).filter(Boolean);

  let html = displayKeywords.map(kw => {
    const isActive = currentFilter.includes(kw.text);
    return `<span class="vecthare-keyword-tag ${isActive ? 'active' : ''}"
                  data-keyword="${escapeHtml(kw.text)}"
                  title="${kw.count} occurrence(s)">
              ${escapeHtml(kw.text)} <small>(${kw.count})</small>
            </span>`;
  }).join('');

  if (keywords.length > 30) {
    html += `<span class="vecthare-keyword-more">+${keywords.length - 30} more</span>`;
  }

  $tags.html(html);

  // Bind click events on tags
  $tags.find(".vecthare-keyword-tag").off("click").on("click", function() {
    const keyword = $(this).data("keyword");
    toggleKeywordFilter(keyword);
  });
}

/**
 * Toggles a keyword in the filter
 */
function toggleKeywordFilter(keyword) {
  const currentFilter = browserState.keywordFilter.toLowerCase().split(',').map(k => k.trim()).filter(Boolean);
  const idx = currentFilter.indexOf(keyword.toLowerCase());

  if (idx >= 0) {
    currentFilter.splice(idx, 1);
  } else {
    currentFilter.push(keyword.toLowerCase());
  }

  browserState.keywordFilter = currentFilter.join(', ');
  $("#vecthare_keyword_filter").val(browserState.keywordFilter);
  renderKeywordTags();
}

/**
 * Clears the keyword filter
 */
function clearKeywordFilter() {
  browserState.keywordFilter = '';
  $("#vecthare_keyword_filter").val('');
  renderKeywordTags();
}

/**
 * Updates keyword filter from input field
 */
function updateKeywordFilterFromInput() {
  browserState.keywordFilter = $("#vecthare_keyword_filter").val();
  renderKeywordTags();
}

/**
 * Filters search results by keywords
 * @param {object} results Search results by collection
 * @returns {object} Filtered results
 */
function filterResultsByKeywords(results) {
  const filterKeywords = browserState.keywordFilter.toLowerCase()
    .split(',')
    .map(k => k.trim())
    .filter(Boolean);

  if (filterKeywords.length === 0) {
    return results;
  }

  const filtered = {};

  for (const [collectionId, collectionResults] of Object.entries(results)) {
    if (!collectionResults?.hashes?.length) continue;

    const filteredHashes = [];
    const filteredMetadata = [];

    for (let i = 0; i < collectionResults.hashes.length; i++) {
      const metadata = collectionResults.metadata?.[i] || {};
      const chunkKeywords = (metadata.keywords || []).map(kw =>
        (typeof kw === 'object' ? kw.text : kw)?.toLowerCase()
      ).filter(Boolean);

      // Check if chunk has ANY of the filter keywords
      const hasMatch = filterKeywords.some(fk => chunkKeywords.includes(fk));

      if (hasMatch) {
        filteredHashes.push(collectionResults.hashes[i]);
        filteredMetadata.push(metadata);
      }
    }

    if (filteredHashes.length > 0) {
      filtered[collectionId] = {
        hashes: filteredHashes,
        metadata: filteredMetadata
      };
    }
  }

  return filtered;
}

/**
 * Performs semantic search across collections
 */
async function performSearch() {
  const query = $("#vecthare_semantic_search").val().trim();
  if (!query) {
    toastr.warning("Please enter a search query", "VectHare");
    return;
  }

  const topK = parseInt($("#vecthare_search_topk").val()) || 5;
  const threshold = parseFloat($("#vecthare_search_threshold").val()) || 0.3;
  const enabledOnly = $("#vecthare_search_enabled_only").is(":checked");

  // Get collection IDs to search
  let collectionIds = browserState.collections.map((c) => c.id);

  if (enabledOnly) {
    collectionIds = collectionIds.filter((id) => {
      const collection = browserState.collections.find((c) => c.id === id);
      return collection && collection.enabled;
    });
  }

  if (collectionIds.length === 0) {
    $("#vecthare_search_results").html(`
            <div class="vecthare-search-empty">
                ${icons.search(48)}
                <p>No collections available to search</p>
            </div>
        `);
    return;
  }

  // Show loading state
  browserState.isSearching = true;
  $("#vecthare_search_btn")
    .prop("disabled", true)
    .html(`${icons.search(16)} Searching...`);
  $("#vecthare_search_results").html(`
        <div class="vecthare-search-loading">
            <i class="fa-solid fa-spinner fa-spin"></i> Searching ${collectionIds.length} collections...
        </div>
    `);

  try {
    const results = await queryMultipleCollections(
      collectionIds,
      query,
      topK,
      threshold,
      browserState.settings,
    );

    browserState.searchResults = results;

    // Apply keyword filter if set
    const filteredResults = filterResultsByKeywords(results);
    renderSearchResults(filteredResults, query, results);
  } catch (error) {
    console.error("VectHare: Search failed", error);
    $("#vecthare_search_results").html(`
            <div class="vecthare-search-error">
                ${icons.x(24)} Search failed: ${error.message}
            </div>
        `);
  } finally {
    browserState.isSearching = false;
    $("#vecthare_search_btn")
      .prop("disabled", false)
      .html(`${icons.search(16)} Search`);
  }
}

/**
 * Renders search results
 * @param {object} results Results from queryMultipleCollections (possibly filtered)
 * @param {string} query Original search query
 * @param {object} originalResults Original unfiltered results (for showing filter info)
 */
function renderSearchResults(results, query, originalResults = null) {
  const collectionIds = Object.keys(results);
  const totalResults = collectionIds.reduce(
    (sum, id) => sum + (results[id]?.hashes?.length || 0),
    0,
  );

  // Calculate original counts if keyword filter was applied
  const wasFiltered = originalResults && browserState.keywordFilter.trim();
  const originalTotal = originalResults
    ? Object.keys(originalResults).reduce((sum, id) => sum + (originalResults[id]?.hashes?.length || 0), 0)
    : totalResults;

  if (totalResults === 0) {
    const filterMsg = wasFiltered
      ? `<p>No results match keyword filter: "${escapeHtml(browserState.keywordFilter)}"</p><small>${originalTotal} result(s) found before filtering</small>`
      : `<p>No results found for "${escapeHtml(query)}"</p><small>Try adjusting the score threshold or search in more collections</small>`;

    $("#vecthare_search_results").html(`
            <div class="vecthare-search-empty">
                ${icons.search(48)}
                ${filterMsg}
            </div>
        `);
    return;
  }

  let summaryHtml = `<div class="vecthare-search-summary">Found ${escapeHtml(totalResults)} result(s) in ${collectionIds.length} collection(s)`;
  if (wasFiltered) {
    summaryHtml += ` <span class="vecthare-filter-badge" title="Keyword filter active">🏷️ filtered from ${originalTotal}</span>`;
  }
  summaryHtml += `</div>`;

  let html = summaryHtml;

  for (const collectionId of collectionIds) {
    const collectionResults = results[collectionId];
    if (!collectionResults?.hashes?.length) continue;

    const collection = browserState.collections.find(
      (c) => c.id === collectionId,
    );
    const collectionName = collection?.name || collectionId;
    // Use registryKey for unique identification (source:id format)
    const uniqueKey = collection.registryKey || collection.id;

    html += `
            <div class="vecthare-search-collection">
                <div class="vecthare-search-collection-header">
                    ${icons.folder(16)} ${escapeHtml(collectionName)}
                    <span class="vecthare-search-count">${collectionResults.hashes.length} result(s)</span>
                </div>
                <div class="vecthare-search-collection-results">
        `;

    for (let i = 0; i < collectionResults.hashes.length; i++) {
      const metadata = collectionResults.metadata?.[i] || {};
      const score =
        metadata.score !== undefined ? (metadata.score * 100).toFixed(1) : "?";
      const text = metadata.text || `[Hash: ${collectionResults.hashes[i]}]`;
      const preview = text.length > 200 ? text.substring(0, 200) + "..." : text;

      // Build score breakdown for hybrid search results
      const vectorScore = metadata.vectorScore !== undefined ? (metadata.vectorScore * 100).toFixed(0) : null;
      const textScore = metadata.textScore !== undefined ? (metadata.textScore * 100).toFixed(0) : null;
      const isHybrid = metadata.hybridSearch || (vectorScore !== null && textScore !== null);

      let scoreDisplay = `<div class="vecthare-search-result-score">${score}%</div>`;
      if (isHybrid) {
        scoreDisplay = `
          <div class="vecthare-search-result-score-hybrid">
            <div class="vecthare-score-main">${score}%</div>
            <div class="vecthare-score-breakdown">
              <span class="vecthare-score-vector" title="Semantic similarity">🔷${vectorScore || '?'}%</span>
              <span class="vecthare-score-text" title="Keyword match">📝${textScore || '0'}%</span>
            </div>
          </div>`;
      }

      // Build keywords display
      const chunkKeywords = metadata.keywords || [];
      let keywordsHtml = '';
      if (chunkKeywords.length > 0) {
        const keywordTags = chunkKeywords.slice(0, 5).map(kw => {
          const text = typeof kw === 'object' ? kw.text : kw;
          return `<span class="vecthare-result-keyword">${escapeHtml(text)}</span>`;
        }).join('');
        const moreCount = chunkKeywords.length > 5 ? `<span class="vecthare-result-keyword-more">+${chunkKeywords.length - 5}</span>` : '';
        keywordsHtml = `<div class="vecthare-result-keywords">${keywordTags}${moreCount}</div>`;
      }

      html += `
                <div class="vecthare-search-result" data-collection="${escapeHtml(collectionId)}" data-hash="${escapeHtml(collectionResults.hashes[i])}">
                    ${scoreDisplay}
                    <div class="vecthare-search-result-content">
                        <div class="vecthare-search-result-text">${escapeHtml(preview)}</div>
                        ${keywordsHtml}
                    </div>
                </div>

                <button class="vecthare-btn-sm vecthare-action-visualize"
                        data-collection-key="${escapeHtml(uniqueKey)}"
                        data-backend="${escapeHtml(collection.backend)}"
                        data-source="${escapeHtml(collection.source || "transformers")}"
                        title="View and edit chunks in this collection">
                    ${icons.eye(16)} View Chunks
                </button>
            `;
    }

    html += `</div></div>`;
  }

  $("#vecthare_search_results").html(html);
  // sloppy, temporary fix to replicate OG chunk link functionality (1091)
  $(".vecthare-action-visualize")
    .off("click")
    .on("click", async function (e) {
      e.stopPropagation();
      const collectionKey = $(this).data("collection-key");
      const collection = findCollectionByKey(collectionKey);

      if (!collection) return;

      let loadingToast = null;
      try {
        // Closed as soon as loading ends (it used to stay up over the opened chunks).
        loadingToast = toastr.info("Loading chunks...", "VectHare", { timeOut: 0, extendedTimeOut: 0 });

        // Use the collection's actual backend, not the global setting
        // This ensures we query Standard collections with Standard backend, etc.
        if (!collection.backend) {
          toastr.error(
            "Collection has no backend defined - this is a bug",
            "VectHare",
          );
          console.error("VectHare: Collection missing backend:", collection);
          return;
        }

        const collectionSettings = settingsForCollection(collection);

        // Use unified plugin endpoint (9c: Qdrant/Milvus through their adapter)
        const data = await listCollectionChunksForBrowser(collection, collectionSettings, {
            backend: collection.backend || "vectra",
            collectionId: collection.id,
            source: collection.source || "transformers",
            model: collection.model || "",
            limit: 1000, // Get first 1000 chunks
        });
        const results = data.items || [];

        if (!results || results.length === 0) {
          toastr.warning("No chunks found in this collection", "VectHare");
          return;
        }

        // Format chunks for visualizer
        const chunks = results.map((item, idx) => ({
          hash: item.hash,
          index: collection.type === "chat" ? getChatChunkSourceIndex(item, idx) : item.index ?? idx,
          text: item.text || item.metadata?.text || "No text available",
          score: 1.0,
          similarity: 1.0,
          messageAge: item.metadata?.messageAge,
          decayApplied: false,
          decayMultiplier: 1.0,
          metadata: item.metadata, // Pass through all metadata including keywords
        }));

        // Pass collection-specific settings so visualizer uses correct backend for edits/deletes
        // Include collection type so visualizer knows if this is a chat (for Scenes tab)
        openVisualizer(
          { chunks, collectionType: collection.type },
          collection.id,
          collectionSettings,
        );
      } catch (error) {
        console.error("VectHare: Failed to load chunks", error);
        toastr.error(`Failed to load chunks: ${error.message}`, "VectHare");
      } finally {
        if (loadingToast) toastr.clear(loadingToast);
      }
    });
}

// ============================================================================
// BULK OPERATIONS TAB FUNCTIONS
// ============================================================================

/**
 * Renders bulk operations list
 */
function renderBulkList() {
  const collections = applyBulkFilter([...browserState.collections]);

  if (collections.length === 0) {
    $("#vecthare_bulk_list").html(`
            <div class="vecthare-bulk-empty">
                ${icons.folder(48)}
                <p>No collections match the current filter</p>
            </div>
        `);
    return;
  }

  let html = "";
  for (const collection of collections) {
    const uniqueKey = collection.registryKey || collection.id;
    const isSelected = browserState.bulkSelected.has(uniqueKey);

    html += `
            <div class="vecthare-bulk-item ${isSelected ? "selected" : ""}" data-key="${escapeHtml(uniqueKey)}">
                <label class="vecthare-bulk-checkbox">
                    <input type="checkbox" ${isSelected ? "checked" : ""} data-key="${escapeHtml(uniqueKey)}">
                </label>
                <div class="vecthare-bulk-item-info">
                    <span class="vecthare-bulk-item-name">${escapeHtml(collection.name || collection.id)}</span>
                    <span class="vecthare-bulk-item-meta">
                        ${collection.chunkCount || 0} chunks •
                        ${collection.enabled ? `${icons.toggleRight(12)} Enabled` : `${icons.toggleLeft(12)} Disabled`}
                    </span>
                </div>
            </div>
        `;
  }

  $("#vecthare_bulk_list").html(html);
  updateBulkCount();
}

/**
 * Binds bulk operations events
 */
function bindBulkEvents() {
  if (bulkEventsBound) return;
  bulkEventsBound = true;

  // Filter change
  $("#vecthare_bulk_filter")
    .off("change")
    .on("change", function () {
      browserState.bulkFilter = $(this).val();
      browserState.bulkSelected.clear();
      renderBulkList();
    });

  // Select all checkbox
  $("#vecthare_bulk_select_all")
    .off("change")
    .on("change", function () {
      const isChecked = $(this).is(":checked");
      const collections = applyBulkFilter([...browserState.collections]);

      browserState.bulkSelected.clear();
      if (isChecked) {
        collections.forEach((c) =>
          browserState.bulkSelected.add(c.registryKey || c.id),
        );
      }

      renderBulkList();
    });

  // Individual checkbox clicks (delegated)
  $("#vecthare_bulk_list")
    .off("change", 'input[type="checkbox"]')
    .on("change", 'input[type="checkbox"]', function () {
      const key = $(this).data("key");
      if ($(this).is(":checked")) {
        browserState.bulkSelected.add(key);
      } else {
        browserState.bulkSelected.delete(key);
      }
      updateBulkCount();
      $(this)
        .closest(".vecthare-bulk-item")
        .toggleClass("selected", $(this).is(":checked"));
    });

  // Bulk enable
  $("#vecthare_bulk_enable")
    .off("click")
    .on("click", async function () {
      if (browserState.bulkSelected.size === 0) return;

      for (const key of browserState.bulkSelected) {
        setCollectionEnabled(key, true);
        const collection = browserState.collections.find(
          (c) => (c.registryKey || c.id) === key,
        );
        if (collection) collection.enabled = true;
      }

      toastr.success(
        `Enabled ${browserState.bulkSelected.size} collection(s)`,
        "VectHare",
      );
      renderBulkList();
      renderCollections();
    });

  // Bulk disable
  $("#vecthare_bulk_disable")
    .off("click")
    .on("click", async function () {
      if (browserState.bulkSelected.size === 0) return;

      for (const key of browserState.bulkSelected) {
        setCollectionEnabled(key, false);
        const collection = browserState.collections.find(
          (c) => (c.registryKey || c.id) === key,
        );
        if (collection) collection.enabled = false;
      }

      toastr.success(
        `Disabled ${browserState.bulkSelected.size} collection(s)`,
        "VectHare",
      );
      renderBulkList();
      renderCollections();
    });

  // Bulk export
  $("#vecthare_bulk_export")
    .off("click")
    .on("click", async function () {
      if (browserState.bulkSelected.size === 0) return;

      const confirmed = confirm(
        `Export ${browserState.bulkSelected.size} collection(s)?\n\nEach collection will be downloaded as a separate file.`,
      );
      if (!confirmed) return;

      toastr.info(
        `Exporting ${browserState.bulkSelected.size} collection(s)...`,
        "VectHare",
      );

      let successCount = 0;
      for (const key of browserState.bulkSelected) {
        const collection = browserState.collections.find(
          (c) => (c.registryKey || c.id) === key,
        );
        if (!collection) continue;

        try {
          const exportData = await exportCollection(
            collection.id,
            browserState.settings,
            {
              backend: collection.backend,
              source: collection.source || "transformers",
              model: collection.model || "",
            },
          );

          downloadExport(exportData, collection.name || collection.id);
          successCount++;
        } catch (error) {
          console.error(`VectHare: Failed to export ${collection.id}`, error);
        }
      }

      toastr.success(`Exported ${successCount} collection(s)`, "VectHare");
    });

  // Bulk delete - uses unified deleteCollection()
  $("#vecthare_bulk_delete")
    .off("click")
    .on("click", async function () {
      if (browserState.bulkSelected.size === 0) return;

      const confirmed = confirm(
        `⚠️ DELETE ${browserState.bulkSelected.size} COLLECTION(S)?\n\n` +
          `This will permanently delete all vectors in these collections.\n` +
          `This action CANNOT be undone!\n\n` +
          `Type "DELETE" to confirm.`,
      );

      if (!confirmed) return;

      const confirmText = prompt("Type DELETE to confirm:");
      if (confirmText !== "DELETE") {
        toastr.info("Deletion cancelled", "VectHare");
        return;
      }

      toastr.info(
        `Deleting ${browserState.bulkSelected.size} collection(s)...`,
        "VectHare",
      );

      let successCount = 0;
      let partialCount = 0;
      // S6: progress in the Status panel when no other run owns it.
      const selectedKeys = [...browserState.bulkSelected];
      const panelRun = progressTracker.beginCounted("Deleting Collections", selectedKeys.length, "Collections");
      let stepIndex = 0;
      for (const key of selectedKeys) {
        progressTracker.countedStep(panelRun, "Deleting collections", stepIndex, selectedKeys.length);
        stepIndex++;
        const collection = browserState.collections.find(
          (c) => (c.registryKey || c.id) === key,
        );
        if (!collection) continue;

        try {
          const collectionSettings = {
            ...browserState.settings,
            vector_backend: collection.backend,
            source: collection.source,
          };
          const result = await deleteCollection(
            collection.id,
            collectionSettings,
            collection.registryKey,
          );
          if (result.success) {
            successCount++;
          } else {
            partialCount++;
            if (panelRun != null) {
              progressTracker.addError(`${collection.name || collection.id}: ` +
                `${(result.errors || []).join(", ") || "not fully deleted"}`);
            }
          }
        } catch (error) {
          console.error(`VectHare: Failed to delete ${collection.id}`, error);
          if (panelRun != null) progressTracker.addError(`${collection.name || collection.id}: ${error.message}`);
        }
      }

      browserState.bulkSelected.clear();
      progressTracker.countedStep(panelRun, "Refreshing the list", selectedKeys.length, selectedKeys.length, false);
      await refreshCollections({ reloadStore: true, invalidateInventory: true });
      renderBulkList();
      if (panelRun != null) {
        progressTracker.complete(partialCount === 0 && successCount === selectedKeys.length,
          `Deleted ${successCount} of ${selectedKeys.length}${partialCount ? `, ${partialCount} partial` : ""}`, panelRun);
      }

      if (partialCount > 0) {
        toastr.warning(
          `Deleted ${successCount}, partial: ${partialCount}`,
          "VectHare",
        );
      } else {
        toastr.success(`Deleted ${successCount} collection(s)`, "VectHare");
      }
    });
}

/**
 * Updates bulk selection count and button states
 */
function updateBulkCount() {
  const count = browserState.bulkSelected.size;
  $("#vecthare_bulk_count").text(`${count} selected`);

  // Enable/disable buttons based on selection
  const hasSelection = count > 0;
  $(
    "#vecthare_bulk_enable, #vecthare_bulk_disable, #vecthare_bulk_export, #vecthare_bulk_delete",
  ).prop("disabled", !hasSelection);
}

// ============================================================================
// COLLECTION LOCK MANAGEMENT DIALOG
// ============================================================================

/**
 * Opens a dialog to manage locks for a collection (add/remove multiple chats)
 * @param {string} collectionId
 */
function openCollectionLockDialog(collectionId) {
    const locks = getCollectionLocks(collectionId);
    const characterLocks = getCollectionCharacterLocks(collectionId);
    const currentChatId = getCurrentChatId();
    const context = getContext();
    const currentCharacterId = currentCharacterLockKey(); // VH-107: avatar name
    const characters = context?.characters || [];

    // Build HTML for locked chats
    const locksHtml = locks.length === 0
        ? '<div class="vecthare-lock-list-empty">No chats locked yet</div>'
        : locks.map((chatId) => `
            <div class="vecthare-lock-item" data-chat-id="${escapeHtml(chatId)}">
                <span class="vecthare-lock-chat-id" title="${escapeHtml(chatId)}">${escapeHtml(chatId)}</span>
                <div class="vecthare-lock-item-actions">
                    ${String(chatId) === String(currentChatId) ? '<span class="vecthare-lock-badge-current">Current</span>' : ''}
                    <button class="vecthare-lock-remove-btn" data-chat-id="${escapeHtml(chatId)}" title="Remove lock">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            </div>
        `).join('');

    // Build HTML for locked characters
    const charLocksHtml = characterLocks.length === 0
        ? '<div class="vecthare-lock-list-empty">No characters locked yet</div>'
        : characterLocks.map((charId) => {
            const charName = characters.find(c => c?.avatar === charId)?.name || characters[charId]?.data?.name || `Character ${charId}`;
            return `
                <div class="vecthare-lock-item" data-character-id="${escapeHtml(charId)}">
                    <span class="vecthare-lock-character-name">
                        <i class="fa-solid fa-user"></i>
                        ${escapeHtml(charName)}
                    </span>
                    <div class="vecthare-lock-item-actions">
                        ${String(charId) === String(currentCharacterId) ? '<span class="vecthare-lock-badge-current">Active</span>' : ''}
                        <button class="vecthare-lock-remove-char-btn" data-character-id="${escapeHtml(charId)}" title="Remove lock">
                            <i class="fa-solid fa-trash"></i>
                        </button>
                    </div>
                </div>
            `;
        }).join('');

    // Generate hint text for chat section
    const chatHintClass = currentChatId && locks.includes(currentChatId) ? 'vecthare-lock-hint vecthare-lock-hint-success' : 'vecthare-lock-hint';
    const chatHintText = currentChatId
        ? locks.includes(currentChatId)
            ? '✓ Already locked to this chat'
            : 'Lock this collection to the current chat'
        : 'Open a chat first to lock this collection';

    // Generate hint text for character section
    const charHintClass = currentCharacterId && characterLocks.includes(currentCharacterId) ? 'vecthare-lock-hint vecthare-lock-hint-success' : 'vecthare-lock-hint';
    const charHintText = currentCharacterId
        ? characterLocks.includes(currentCharacterId)
            ? '✓ Already locked to this character'
            : 'Lock this collection to the current character'
        : 'No character currently active';

    const dialogHtml = `
        <div id="vecthare_lock_dialog" class="vecthare-modal" style="display: flex;">
            <div class="vecthare-modal-content vecthare-lock-dialog">
                <div class="vecthare-modal-header">
                    <h3><i class="fa-solid fa-lock"></i> Manage Collection Locks</h3>
                    <button class="vecthare-modal-close" data-action="close">
                        <i class="fa-solid fa-times"></i>
                    </button>
                </div>
                <div class="vecthare-modal-body">
                    <!-- Chat Locks Section -->
                    <div class="vecthare-lock-section">
                        <h4><i class="fa-solid fa-comments"></i> Chat Locks <span class="vecthare-badge vecthare-badge-muted">${locks.length}</span></h4>
                        <div class="vecthare-lock-list">
                            ${locksHtml}
                        </div>
                        <p class="${escapeHtml(chatHintClass)}">${escapeHtml(chatHintText)}</p>
                        <button id="vecthare_lock_add_current" class="vecthare-btn-sm vecthare-btn-primary" ${!currentChatId || locks.includes(currentChatId) ? 'disabled' : ''}>
                            <i class="fa-solid fa-plus"></i> Lock to Current Chat
                        </button>
                    </div>

                    <hr class="vecthare-lock-divider">

                    <!-- Character Locks Section -->
                    <div class="vecthare-lock-section">
                        <h4><i class="fa-solid fa-user"></i> Character Locks <span class="vecthare-badge vecthare-badge-muted">${characterLocks.length}</span></h4>
                        <div class="vecthare-lock-list">
                            ${charLocksHtml}
                        </div>
                        <p class="${escapeHtml(charHintClass)}">${escapeHtml(charHintText)}</p>
                        <button id="vecthare_lock_add_character" class="vecthare-btn-sm vecthare-btn-primary" ${!currentCharacterId || characterLocks.includes(currentCharacterId) ? 'disabled' : ''}>
                            <i class="fa-solid fa-plus"></i> Lock to Current Character
                        </button>
                    </div>
                </div>
                <div class="vecthare-modal-footer">
                    <button class="vecthare-btn" data-action="close">
                        <i class="fa-solid fa-check"></i> Done
                    </button>
                </div>
            </div>
        </div>
    `;

    const $dialog = $(dialogHtml);
    $('body').append($dialog);

    // Handle add lock button (chat)
    $('#vecthare_lock_add_current').on('click', function() {
        const chatId = getCurrentChatId();
        if (!chatId) {
            toastr.warning('Open a chat first');
            return;
        }

        setCollectionLock(collectionId, chatId);
        toastr.success('Collection locked to current chat', 'VectHare');

        // Re-open dialog with updated state
        $dialog.remove();
        refreshActivationLockButton();
        openCollectionLockDialog(collectionId);
    });

    // Handle add lock button (character)
    $('#vecthare_lock_add_character').on('click', function() {
        const context = getContext();
        const charId = context?.characterId;
        if (!charId) {
            toastr.warning('No character currently active');
            return;
        }

        setCollectionCharacterLock(collectionId, charId);
        toastr.success('Collection locked to current character', 'VectHare');

        // Re-open dialog with updated state
        $dialog.remove();
        refreshActivationLockButton();
        openCollectionLockDialog(collectionId);
    });

    // Handle remove lock buttons (chat)
    $dialog.find('.vecthare-lock-remove-btn').on('click', function(e) {
        e.stopPropagation();
        const chatId = $(this).data('chat-id');

        removeCollectionLock(collectionId, chatId);
        toastr.info('Removed lock from chat', 'VectHare');

        // Re-open dialog with updated state
        $dialog.remove();
        refreshActivationLockButton();
        openCollectionLockDialog(collectionId);
    });

    // Handle remove lock buttons (character)
    $dialog.find('.vecthare-lock-remove-char-btn').on('click', function(e) {
        e.stopPropagation();
        const charId = $(this).data('character-id');

        removeCollectionCharacterLock(collectionId, charId);
        toastr.info('Removed lock from character', 'VectHare');

        // Re-open dialog with updated state
        $dialog.remove();
        refreshActivationLockButton();
        openCollectionLockDialog(collectionId);
    });

    // Handle close button
    $dialog.find('[data-action="close"]').on('click', function(e) {
        e.preventDefault();
        $dialog.remove();
    });

    // Stop mousedown propagation (ST closes drawers on mousedown/touchstart)
    $dialog.on('mousedown touchstart', function(e) {
        e.stopPropagation();
    });

    // Close on background click
    $dialog.on('click', function(e) {
        if (e.target === this) {
            $dialog.remove();
        }
    });

    // Handle escape key
    $(document).one('keydown.lock_dialog', function(e) {
        if (e.key === 'Escape') {
            $dialog.remove();
        }
    });
}

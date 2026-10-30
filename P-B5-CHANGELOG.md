# VectHare P-B.5 — Functional saved-chat record editing

**Baseline:** Matched VectHare P-B.4 and Similharity 3.2.11-p-b.4, 30 October 2026.
**New matched release:** VectHare 2.2.0-alpha.p-b.5 and Similharity 3.2.11-p-b.5.

## Implemented

### P07 — functional saved-chat-first edit in Database Browser (partial)

The managed saved-record browser now contains a **Save chat text and update managed vector** action for an *existing, physically verified, unchanged, non-truncated* active saved-chat message. It uses the plugin's source-attested timestamp/speaker/is-user locator, checks that exactly one actual SillyTavern message matches the saved text, checks source and physical state again, obtains explicit user confirmation, changes the message via SillyTavern's `context.saveChat()`, reads the saved source back through authenticated managed browsing, plans an M1 **update** against the new server-attested file fingerprint, executes the one-use M1 ticket, then verifies the physical record and managed registry through paginated authoritative readback.

No browser-provided text/vector/owner/physical name goes to M1. The embedding is regenerated server-side from the bytes of the **saved source**. Unverified, foreign, duplicate-key, changed, deleted, legacy, lorebook, uploaded, non-chat, and truncated (>8,192-character preview) rows are not offered this editor. Saved lorebook editing and M7 summaries remain pending. The legacy Chunk Visualizer still refuses managed hash editing.

**Durability boundary:** A successful SillyTavern save is never rolled back because a later vector update failed. If save is acknowledged but M1 fails or readback is incomplete, the UI reports `CHAT SAVED; VECTOR UPDATE UNVERIFIED` and directs the user to Repair Chat / receipt inspection. If the host's save API throws, its outcome is explicitly displayed as **HOST CHAT SAVE OUTCOME UNCERTAIN**, not a definite completed save or clean refusal. There is no blind replay of the vector operation. Successful completion requires a **VERIFIED** M1 receipt and a physically verified post-write saved-record read.

**Scope limitation:** This is only available when the current managed backend reports the M1 `update` capability enabled and the host provides a real `saveChat()` function. Availability will depend on the existing M1/manual-test evidence policy and database configuration. No capability matrix permissions were changed.

### P06/P13 — functional large-saved-chat correction

The legacy F09b read-only chat sync planner continues to refuse more than 80 messages. M1's server-owned snapshot reader now explicitly requests a trusted in-process bound of 100,000 chat message lines, subject to existing 12 MiB saved-file and per-message limits. This removes an otherwise overlooked 80-message bottleneck for M1 browse, P06 vectorization and P05 repair on saved chats. The browser still explicitly caps the client audit at 200,000 records and never interprets a saved-source page as whole physical inventory.

### P-B scope still pending

- P07 complete legacy Chunk Visualizer replacement, lorebook text editing, manual/upload registration (P09), and summary editing (M7).
- P08 LanceDB/Vectra/Milvus managed collection lifecycle and live Qdrant lifecycle acceptance.
- P13/P16 whole physical inventory for other backends.
- P14 functional revision-checked managed scene metadata editing.
- P22 fully durable authoritative metadata/cache synchronization.
- P29 durable verified group metadata repair.

**Preserved:** obsolete purge button unchanged; capability matrix baseline **32 ENABLED / 33 BLOCKED / 5 UNSUPPORTED**; no new collection permissions, blind retries, or legacy managed mutations.

## Automated verification

- Plugin: **881/881 tests passed**, 99 test files in 9 bounded batches.
- Extension: **1,284/1,284 tests passed**, 95 Node test files in 8 bounded batches, Node.js 22 `--no-opt --experimental-vm-modules`.
- New tests: host message identity/stale/duplicate/confirmation, save-first→managed update→readback, saved-but-unsynced/uncertain-save behavior, source-derived browser locator, 250-message M1 reading with stable identity while old F09b planner still refuses 81 messages.
- No live SillyTavern, llama.cpp/Ollama/vLLM/KoboldCpp, Qdrant, LanceDB, Vectra or Milvus test was performed. **Not certified production-ready.**

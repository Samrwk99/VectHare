# S11 — VectHare / Similharity integration checkpoint

Date: 28 October 2026. Candidate, **not a production release**.

## Changes in VectHare

1. `utils/s11-plugin-compatibility.js`: read-only S10 plugin discovery via `GET /v2/build`, `/v2/capabilities`, `/v2/contracts`, with pinned S10 contract version, plugin version and source fingerprint. All claims must agree. A matching self-reported fingerprint is only consistency evidence; it is not remote authentication, backend certification or permission to mutate.
2. `utils/e02-vector-request-gateway.js`: allowlist only those read-only discovery GETs and `/capabilities`; reject POST/body on them. All other `/v2/` plugin paths are denied **before network dispatch**. Original E02 mutation policy and native Standard restrictions remain intact.
3. `utils/s11-chat-fork-observer.js`: persistent, conservative *local* observation of `(host chat handle, chat_metadata.integrity)` pairs. If the same integrity value appears with distinct chat handles, quarantine that integrity ID; this applies to both chats until reviewed. Missing/corrupt/inaccessible browser storage fails closed. No metadata is automatically rewritten or reassigned.
4. `core/collection-ids.js`: use the observer for verified-origin selection; do not return a copied integrity as a chat collection identity. This does not constitute authoritative server-side chat ownership, and a rename can trigger a false positive.
5. `index.js`: perform non-mutating compatibility discovery during settings initialization and render a text-only user status; show a one-time warning when branch identity reuse is quarantined. Do not unlock operations on success.
6. `manifest.json`: version `2.2.0-alpha.s11.0`; auto-update disabled to avoid unexpectedly overwriting this test build with upstream code.
7. New S11 unit tests, branch integration tests and a narrowly updated preexisting VM test fixture for the added module dependency.

## Plugin

**No S10 plugin source modifications.** `VectHare-Similharity-S10-API-Plugin-Finalization.zip` remains the paired plugin. Its v2 record and mutation routes refuse execution by design. No unverified server route has been turned on.

## Not implemented / not certified

- Server-authoritative chat, branch, lorebook or scene ownership grants.
- Live Qdrant/Milvus concurrency/CAS, SDK persistence, vector readback, or restart evidence.
- Native Standard endpoint verification, verified inventory/exports, backend-native migrations.
- A new host-generated identity for copied branches. S11 **detects and quarantines**, but does not repair, fork or migrate chat metadata automatically.
- Any public write, reindex, delete, inventory or migration activation. All those remain blocked.

The next work is authenticated disposable-host acceptance and server-side source-ownership contracts, not a blanket policy flip.

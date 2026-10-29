# F09b.6 — Source-backed saved summaries and World Info pilots

**Matched source:** VectHare `2.2.0-alpha.s11.24-f09b6` + Similharity `3.2.10-s10.23-f09b6`.

## Implemented

1. A dedicated F09b.6 source snapshot module verifies F01-owned SillyTavern files using bounded open-descriptor inode/stat readback. Source selection is authenticated on the server; neither source text nor record IDs nor vectors are accepted from the browser.
2. The World Info adapter extracts saved lorebook `entries` with distinct, stable nonnegative integer `uid` values. It generates a deterministic UUID per source ID + lorebook UID. Disabled/empty entries are ignored, never automatically deleted. Maximum 80 entries (including disabled), 64,000 characters per entry and 4 MiB saved lorebook file.
3. The saved-summary adapter uses the **existing literal string** `chat_metadata.summary` in a saved solo/group chat header. It generates a separate deterministic v2 UUID within that chat's source-bound collection. It does **not** generate an LLM summary or assume other legacy summary schemas. Maximum 64,000 characters and 12 MiB saved chat file.
4. Authenticated `POST /v2/workflows/saved-content-pilot` supports two modes: read-only `preview`, returning only deterministic record UUIDs/status/revisions/counts/source file hash; and explicit one-record `apply`, with exact snapshot fingerprint, bounded `itemIndex`, same-origin header and deliberate consent. No batch write, automatic synchronization, hidden deletion, arbitrary record IDs, physical collection overrides, text/vector upload or legacy writes.
5. The apply route uses the existing authenticated F02 scoped reads and binding, F03 provision/schema verification, F09b.5 managed server embedding generator and exact embedding identity, S04 operation plan/ledger/verified readback and F09b.4 durable managed registry. It checks the source repeatedly, preserves safe old metadata on updates, and refuses to adopt any unregistered, preexisting record.
6. Unknown/changed sources fail closed. Source snapshot changes during embedding or before mutation authorization refuse; uncertain write state is not automatically retried/reconciled. Zero auto-deletion/orphan inference, no full inventory, no production grant.
7. VectHare F09b.6 GUI offers summary vs lorebook selection, read-only preview, individually selected ordinal and one-time consented apply. The guarded E02 request gateway allows only this explicit server-owned route and prohibits browser-supplied text, vectors, IDs or owner/physical names.
8. Updated S10 route/capability contract, regenerated local S10 build fingerprint and updated S11 pinned extension compatibility. All existing F09b.4/5 safety boundaries remain unchanged.

## Deliberate exclusions

- **No automatic summary generation, model-produced summaries, dual-vector parent-child summary expansion/reindex, or automatic World Info creation/deletion/lifecycle**. Those remain to be implemented or linked safely before general feature parity can be claimed.
- Only the saved chat header string `chat_metadata.summary` is supported as a summary source. Other host summary formats are *explicitly unsupported* until observed and verified on a real host.
- Entries without stable `uid`, duplicate `uid`, oversized or malformed documents are refused instead of silently assigning positional/hash identities.
- No production mutation matrix state is enabled. Qdrant/LanceDB/plugin Vectra/Milvus integration is offline-tested only; native Standard and legacy vectors remain denied; no physical purge, automatic cleanup, external-writer CAS certification or disaster recovery.

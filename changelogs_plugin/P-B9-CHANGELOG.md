# VectHare P-B.9 — M4 Collection Lifecycle in Database Browser

**Matched build:** VectHare extension `2.2.0-alpha.p-b.9`; Similharity plugin `3.2.11-p-b.9`. Built from the matched P-B.8 bundles, 30 October 2026.

## P08 — functional M4 lifecycle interface

The existing Qdrant M3 Database Browser lifecycle workspace is retained unchanged. P-B.9 adds a separate **LanceDB / Vectra / Milvus** lifecycle workspace in `ui/database-browser.js` using `utils/pb9-m4-lifecycle.js`. The plugin already provides the underlying M4a/M4b/M4c routes, authoritative physical inventory and ownership gates, backed-up empty/restore generation transactions, and guarded canonical deletion; no duplicate destructive backend was introduced.

The complete browser flow is **inspect physical inventory → capture a private source-owned backup → verify the backup → plan an empty/restore/delete action → type exact backend-specific confirmation → dispatch a one-use plan → independently validate the M4 receipt**. It supports existing saved chat, group-chat selectors where applicable, and named saved lorebooks. Only server-authored collection identity is accepted. The UI never specifies physical names, path, owner, embedding vector or inventory authority. The gateway's existing M4 exact-selector allowlist continues to apply.

Technical behaviors:
- All three backends require `completePhysicalInventory`, `ownerVerified`, canonical key, count, and inventory digest in inspection.
- Before backup and planning, a fresh M4 inspection must match the original logical key, inventory digest, count, and operation-modes; the persisted backup's count/digest are independently verified.
- The backend's own operation mode can refuse a delete (notably after a generation cutover). Empty and restore use the existing generation-preserving M4 transition routes.
- The plan must return a live expiry, matching backup/logical key, server-required confirmation and a one-use operation UUID. Expired plans are not dispatched.
- Delete receipts must attest physical absence and registry tombstone. Empty receipts must attest verified emptiness and retained original. Restore must attest retained original.
- The client marks a plan terminal **before** performing the execute request; a lost acknowledgement or misleading response is not automatically replayed. The server retains the execution record as authoritative.
- Selection changes invalidate the UI state and suppress stale result painting. The obsolete purge button and legacy deletion guards are unchanged.

### Acceptance boundaries

This is **functional browser wiring to existing backend M4 contracts, with automated checks**, not certification of destructive operations on a live backend. No live SillyTavern, LanceDB, Vectra or Milvus tests occurred in this release. Avoid production datasets until the dedicated disposable host runbook passes. The existing server-side M4 adapters may themselves refuse when the host does not provide the required authoritative physical inventory or write-boundary proof. Do not interpret such refusal as a UI success.

P08 remains `PARTIAL_IMPLEMENTATION / AWAITING_USER_LIVE_BACKEND` pending real host acceptance for all four backends and crash/recovery verification. P13/P16 universal record-level physical enumeration, P22 cache invalidation and P29 durable group repair remain open. No capability-matrix mutation or global enabling of destructive writes was made (32 enabled / 33 blocked / 5 unsupported); obsolete purge button untouched.

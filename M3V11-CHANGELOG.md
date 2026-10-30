# M3v11 — Repeatable verified Qdrant collection lifecycle

**Base:** M3v10. **Extension:** `2.2.0-alpha.m3.15`. **Plugin:** `3.2.10-m3.15`.

**Delivery:** Same-profile **restore and scoped empty after a prior verified cutover** now have plan → typed confirm → one-use execute → full physical readback → publish generation → verify. Previously only read-only backup was available on an alias. Repeated operations are now available as `ENABLED / AWAITING_MANUAL_TEST` and require a new backup of the *current* active generation.

**Safety and functional changes**

- `m3-collections`: `preview` and `plan` resolve the live server-verified active Qdrant generation (only for restore/empty), verify complete physical inventory, managed provenance, source hash, embedding, receipt, ledger and jobs; durable plan carries canonical physical name and exact routing generation. **Delete-after-cutover remains refused.**
- `m3-empty-transaction`: same locked lifecycle transaction works on the verified current target; re-attests routing generation and current backup **before** claim, then creates an empty distinct target with tombstones, target receipt and new journal generation. Keeps old physical collection and logical backup.
- `m3-lifecycle-transaction`: repeat restore uses the currently active physical target, fresh current-generation manifest and exact generation fencing before one-shot restore. Historical physical collections remain untouched.
- `m3-target-receipts` and restore staging: canonical S02 identity remains server-derived despite active physical aliases; immutable receipt and physical verification bind each new generation. No physical alias supplied by browser.
- Corrected `resolveF02Binding` calls to use its existing authenticated `readAlias:true` option on verified lifecycle read/plan/preflight paths; otherwise the canonical-only guard would have incorrectly rejected real cutover requests.
- VectHare UI now explains that repeated backup/restore/empty are supported, while alias decommission remains refused.
- Tests cover **empty → capture backup at generation 1 → empty at generation 2**, **empty → backup → restore into generation 2**, stale ticket refusal, original preservation, tombstones, receipt and the required alias read authorization flag.

**Not claimed:** General uncertain-operation recovery, post-cutover decommission, deletion of historical physical generations, resumable >256 cross-model rebuild, or real-host verification. The unscoped purge route is still denied.

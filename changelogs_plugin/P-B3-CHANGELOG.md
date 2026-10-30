# P-B.3 — Managed record readback and legacy mutation guards (30 October 2026)

Matched components: **VectHare 2.2.0-alpha.p-b.3** and **Similharity 3.2.11-p-b.3**.

## Implemented

1. **P07 partial — authoritative post-action physical readback**: the managed saved-record browser now receives M1's verified mutation receipt, invalidates its previous page, and obtains fresh source-bound browse pages. It confirms physical state, registry state, saved-source freshness and per-record status before displaying `VERIFIED`. It performs cross-page revision/generation checks, duplicate UUID and replay checks, a final first-page re-attestation, and a final target-page re-read. A failure is labelled `RECEIPT RETURNED / READBACK UNVERIFIED`: no blind retry or false confirmation. Bounded at 200,000 saved rows, with explicit failure rather than truncated proof. This applies only to the separate managed saved-source browser; **direct free-text edits in legacy Chunk Visualizer remain unavailable for managed v2**. Edit actual saved messages first, then revectorize.
2. **P14 interim guard — legacy scene controls never mutate managed backends**: Qdrant, LanceDB, Vectra and Milvus scene marker actions now refuse scene create/delete/update through the hash-based editor; the lower-level `core/scenes.js` mutation functions also refuse. Managed scene cache no longer consumes `getSavedHashes()` as though it were authoritative. The revision-checked, persisted P14 metadata patch and reload is **NOT IMPLEMENTED**. Legacy standard scene operation path unchanged.
3. **P08 preliminary safeguard — identifiable managed-v2 collection rows cannot be passed to old collection-loader deletion** by either single-delete or bulk-delete browser handlers. Recognized indicators are managed-v2 schema/flag/generation or a `vh2_...` physical ID. This is **not** a complete P08 lifecycle implementation and does not establish identity for every legacy browser row. No obsolete purge button changes. Backup/restore/empty/delete previews and durable M3/M4 receipts remain pending.
4. **Plugin is source-identical to P-B.2 except for the matched release version and source manifest**. No plugin mutation policy was changed and no new write capability was enabled.

## Verification

- Extension Node.js regression: **1,271 passing / 0 failing**, Node 22-compatible `--no-opt --experimental-vm-modules --test --test-concurrency=4`.
- Plugin Node.js regression: **879 passing / 0 failing** (`--experimental-vm-modules --test --test-concurrency=4`).
- Four new readback / managed mutation guard tests; an old VM-only scene-cache fixture was updated for the new guard dependency.
- These are automated tests, not live SillyTavern or Qdrant/LanceDB/Vectra/Milvus acceptance.

## Outstanding P-B

- **P07**: managed metadata/text editing UI and M7 summary handoff with authoritative saved-source edit persistence.
- **P08**: complete typed collection lifecycle preview/backup/plan/execute/reconciliation for all backend types (do not confuse P-B.3 delete guard with lifecycle support).
- **P13/P16**: physical collection inventory beyond Qdrant, plus integrated large-collection authoritative listing.
- **P14**: authenticated revision-checked, server-owned scene metadata patch and readback. Until then managed scene marker edits are explicitly unavailable.
- **P22**: fully server-authoritative collection lifecycle cache across tabs/restarts.
- **P29**: durable group metadata recovery after complete verified inventory and authorized server mutation.

**Matrix remains 32 enabled / 33 blocked / 5 unsupported; obsolete purge button untouched.**

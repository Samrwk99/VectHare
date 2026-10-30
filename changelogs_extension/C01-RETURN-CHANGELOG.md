# VectHare — C01 Return / deletion acceptance checkpoint

Date: 2026-10-27
Base: `VectHare-I18-Phase0-C01-C04AB-C06AB-C11AB-Checkpoint.zip`
Base SHA-256: `a1e17ddb99bd934029fe42b2c90c51272b3b9ecaedd62342f9cd3d411db7f4be`

## Source changes (extension only)

### #216 — deletion / durable recovery
- Reject malformed, wrong-key and unknown-stage recovery tombstones.
- On recovery of a **prepared** delete, check that registry ownership and scoped metadata still exist; never replay a purge on a changed owner.
- Reject a contradictory pre-purge readback that reports an empty collection after a non-empty verified inventory.
- Only accept an empty post-purge proof when it explicitly confirms full enumeration and an independently verified zero count (`endOfListConfirmed:true`, `verifiedCount:0`).
- Fail closed when a `finalized` or `purged` checkpoint lacks conclusive empty proof. Never reissue a `purge-sent` operation blindly.
- Preserve exact prior missing/present metadata keys during a finalization persistence rollback; avoid manufacturing ghost metadata entries.
- Expose optional completion-receipt durability as `receiptDurable`; a failed receipt write is not misrepresented as a confirmed receipt, though a previous durable finalization cannot be undone.

### #158 — protected data and cross-collection ownership
- Inspect the actual collection metadata for `protected:true` even when the caller omits the protected flag.
- Require a protected export receipt to match the scoped inventory count, before persisting the deletion tombstone.
- Refuse recovery of prepared protected tombstones without verified export evidence.
- Refuse global legacy-hash cleanup unless registry-wide coverage was independently verified; zero/unknown owners are **not** enough.

### #189 / #220 — inventory and provenance
- Refuse duplicate record IDs or duplicate qualified collection IDs instead of silently deduplicating them.
- Require each record in the C01 inventory to affirm its complete qualified owner; partial, ambiguous or mismatched records remain non-destructive.
- Retain the existing explicit metadata capability states and the ban on partial-list orphan cleanup.

## Pinned read-only Similharity source investigation

The newly supplied `VectHare-Similharity-Plugin.zip` was **not edited** and is **not included in the extension ZIP**. Source archive SHA-256:
`51f74de9c7e57524cc3f1f881b03069805e654b162a8f5ccb77d012b0a2604a7`.

- `index.js` reports runtime plugin version **3.2.0**, while `package.json` declares **2.0.0**. This is a provenance inconsistency and does not establish deployed compatibility.
- `POST /chunks/purge` returns a generic `{success:true}` when the backend method returns; it is not a durable, scoped deletion receipt.
- The Qdrant backend handler calls `purgeAll(collectionId, filters)`; `purgeAll` drops the shared physical collection and does not interpret the filters. Enabling C01 against that path would be unsafe.
- The Milvus backend can drop `vecthare_main` without filters, and its `purgeCollection` catch path logs failures without rethrowing them.
- Qdrant/Milvus item listing may turn backend errors into empty arrays, making an unverified empty readback unsafe for C01.
- The Milvus plugin handler appears to paginate twice: backend `listItems` uses offset/limit, then the route handler slices again.
- Standard/LanceDB expose offset-sliced `total`/`hasMore`, but their production consistency, durable purge and independent count contracts are not verified.

The source evidence manifest is `tests/contracts/similharity-plugin-c01-source.json`. The read-only CLI auditor is `tools/audit-similharity-c01.mjs`; to rerun, unpack your unchanged plugin and run `node tools/audit-similharity-c01.mjs /path/to/unpacked-plugin` from the extension root. A matching fingerprint is **not** live verification.

## Scope and safety status

The extension's deletion endpoint **remains blocked for live use**. None of the source observations promote `BACKEND_CAPABILITIES` to `verified`. The SillyTavern settings callback available to this build is debounced and does not confirm durable persistence. There is no real-server destructive test, and the plugin still contains unsafe paths that cannot be repaired without changing the plugin. No user collections were deleted and no registry migrations were executed.

C01 local safety implementation has progressed; **full real-server C01 acceptance is NOT complete**. The deferred items are in the C01 return checklist.

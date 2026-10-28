# E06 — Decision: is VectHare usable yet, and when should the plugin change?

**No production certification yet.** E06 closes key shared-backend read hazards but does not unlock writes. Neither user data protection nor plugin quality can be inferred from unit-test count alone.

## Qdrant

Tenant-filtered query, hybrid and some point/display reads are structurally supported by the current plugin, conditional on meaningful `type`/`sourceId` filters and returned ownership metadata. **Not certified live.** Physical names can be normalized in surprising ways by `_parseCollectionName`, while hash IDs and dimension mismatch handling make mutation unsafe. Strongly recommend a plugin safety update before permitting routine Qdrant vectorization, editing, reindexing or deletion.

## Milvus

Query/list operations use tenant filters, but the returned `hash`, `text`, `metadata` projection omits the authoritative separate owner columns. Unless the metadata object itself contains matching owner fields, E06 now refuses those read results. Even matching metadata is not server-authenticated ownership proof. Milvus also swallows some read errors and lacks authoritative inventory. Full read and write support requires server-side improvements.

## Standard/LanceDB

Not altered by E06. E05 write contracts and readback machinery are locally implemented; full activation is still blocked pending actual disposable backend tests, restart and persistence evidence. E06 should not be read as a reason to delay those tests.

## Recommended immediate next step

**Perform focused real-host E07 smoke testing in the disposable SillyTavern installation, and run E05 Standard/LanceDB probes.** Gather plugin version/hash, host revisions, UI and retrieval results, and sanitized backend evidence. At that decision point, authorize a narrowly scoped **Similharity safety patch** if ordinary Qdrant or Milvus vectorization is essential. Don't spend another large extension-only phase on client workarounds for server defects. Plugin patch implementation must be separately approved, not bundled into this E06 checkpoint.

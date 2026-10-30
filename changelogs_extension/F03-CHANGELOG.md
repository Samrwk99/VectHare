# F03 — Backend Mutation Safety and Schema Provisioning

**Baseline:** F02 VectHare 2.2.0-alpha.s11.7-f02 + Similharity 3.2.10-s10.6-f02.
**Delivered developer builds:** VectHare 2.2.0-alpha.s11.8-f03 + Similharity 3.2.10-s10.7-f03.
**Date:** 2026-10-28. **Certification:** offline tests only; production record mutations remain blocked.

## Implemented

1. **Cross-process collection mutation lock:** S04 OperationLedger now exposes `withCollectionLock()` using a fail-closed, atomic directory lock in the authenticated user's private vectors directory. `MutationEngine.execute()` acquires the collection lock and record lock in fixed order. Direct `reconcile()` also acquires the collection lock; the internal reconciliation path avoids recursive locking. Lock files are never automatically stolen after a crash. The lock covers processes sharing *that same path*; it does not coordinate remote replicas or external database writers.
2. **Actual physical-vector evidence:** `f03-vector-evidence.js` compares backend-returned numeric vectors against the planned original, with limited float32 rounding tolerances and Qdrant cosine normalization handling. S04 no longer considers the copied stored `vectorHash` sufficient when physical vector evidence is absent. The read layer independently hashes a stored reference vector and compares it to the physical vector when that reference is present. Qdrant v2 stores a `vectorReference` copy of the original embedding in the point payload for this check; extra storage is required. Search responses that do not request vectors do not return that reference.
3. **Qdrant and Milvus source-bound v2 schema creation:** New authenticated routes: `POST /v2/collections/preview`, `/provision`, and `/status`. They use F01/F02's fresh saved-file attestation and S02 registry mapping. Preview reserves only the server-generated name. Provision requires exact name confirmation; it refuses an existing collection and never overwrites/clears old vectors. It uses a local collection lock and a one-time private receipt written before backend dispatch. Any partial backend failure is `UNCERTAIN`; no cleanup or automatic retry.
4. **Qdrant ownership indexes:** On source-bound provisioning, the plugin validates the schema after creation and reads the native `payload_schema` to verify all seven expected keyword indexes. A missing/malformed index yields an uncertain receipt, not success. The separate H01 disposable acceptance remains independently gated.
5. **Milvus schema and index inspection:** Source-bound provisioning reuses the S07 full-field schema, non-auto primary key, vector metric index, collection load and readback checks; outcome remains backend-live-uncertified.
6. **GUI:** A dedicated SillyTavern F03 panel previews the generated name, confirms creation separately, and reports the prior provisioning receipt. The client request gateway strictly allows only these reviewed endpoints. The existing connection GUI remains authoritative; no manually edited config file is needed for the new controls.
7. **Exact matched version and source fingerprint:** The plugin's S10 source manifest was regenerated and the extension's expected fingerprint updated. Existing v2 record insert/update/delete/clear routes and legacy mutations remain denied.

## Deliberately not activated / outstanding

- **Production record writes:** insert, update, metadata edit, delete, revectorization, bulk purge and automatic memory vectorization are still denied. F04 must connect S04 to authenticated backend adapters and prove end-to-end behavior.
- **LanceDB and plugin Vectra provisioning:** Not yet implemented; F03's new schema routes accept Qdrant and Milvus only. Native SillyTavern Standard endpoint mutations are separately unprobed.
- **External writers / multi-host CAS:** A user-directory lock cannot stop database mutations from another host, Qdrant console, separate Milvus client, or a second SillyTavern data root. Cross-process locking is tested locally, but a deployment-level single-writer policy or backend-native CAS strategy and adversarial live tests are still required.
- **Crash durability / reconciliation:** Fail-closed lock/receipt handling is offline-tested, not host crash-tested. An uncertain receipt deliberately blocks retry until investigated. Receipt status is a diagnostic, never a mutation authorization.
- **Live Termux, Windows, Linux, Qdrant, Milvus acceptance:** Not performed in this environment. No existing vector data was migrated, altered or inspected.

## Compatibility notes

Both new ZIPs must be installed together. The extension rejects older plugin source fingerprints. Do not combine F03 extension with the F02 plugin.

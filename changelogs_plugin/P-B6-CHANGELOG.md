# VectHare P-B.6 — functional saved-chat scene annotations

**Matched versions:** VectHare `2.2.0-alpha.p-b.6` / Similharity `3.2.11-p-b.6`.
**Baseline:** P-B.5, 30 October 2026. **P-B remains open.**

## Functional change: P14 saved-source-backed scene metadata (partial)

For managed backends (Qdrant, LanceDB, Vectra and Milvus), the existing START/END marker buttons now offer **create, rename and delete of chat scene annotations**, saved to SillyTavern's actual `chat_metadata.vecthareManagedScenes`. Each scene has a UUID, title, and stable send-date/speaker/is-user start/end references. Titles and boundaries are validated; overlapping or ambiguous boundaries are refused. The plugin independently reads the authenticated, owned chat JSONL header and returns the complete saved-scene array, source file fingerprint and scene revision digest. It accepts no scene patch, browser vector, arbitrary physical name, or filesystem path.

On mutation the extension re-reads the saved-source revision, obtains explicit confirmation, modifies only its namespaced chat metadata field, asks SillyTavern to save the chat, and checks that the **plugin** now sees exactly the updated scenes and changed file revision. A stale source refuses **before** host save. A failed/uncertain host save is reported as uncertain; a successful host save with missing readback is shown as unverified. A new user may add scene markers even when no collection has been provisioned, as these are *chat annotations*, not vector rows.

**Critical distinction:** The saved scene annotations are *not* vectorized scene chunks and do not replace/erase legacy scene vectors. Scene embeddings and server-owned vector metadata updates still require a separate M1/M7-compatible design. Physical database inventories and the P29 group-member diagnostic were not made writable. The existing legacy scene functions remain guarded for managed v2. Scenes are read from the saved source only, not inferred from stale hash caches.

## Code

- Plugin: `lib/pb6-scene-source.js` and authenticated `POST /v2/pb6/scenes/read` registered in `index.js` behind S01/M0/S03.
- Extension: `utils/pb6-managed-scenes.js`, narrow E02 request policy; `ui/scene-markers.js` now saves actual chat annotations for managed backends and shows verified saved markers. `getSceneCacheEvidence()` separately reports `savedMetadataVerified` and `vectorSceneRecordsVerified:false`.
- Tests: `plugin/tests/pb6-scene-source.test.mjs`, `extension/tests/pb6-managed-scenes.node.test.mjs`, and updated two plugin VM import mocks/M0 route inventory.

## Unfinished P-B requirements

- **P07** lorebook/manual/summary editing and full legacy Chunk Visualizer replacement.
- **P08** complete lifecycle for LanceDB/Vectra/Milvus and real destructive-operation acceptance.
- **P13/P16** whole physical inventories beyond Qdrant and live large-source validation.
- **P14** live host reload and branch/fork acceptance, and separately vectorized scene-chunk metadata if required by retrieval. The new saved annotations are distinct from vectorized scenes.
- **P22** complete server-authoritative browser metadata/cache reconciliation.
- **P29** durable, owned, revision-checked group-member repairs; current preview-only refusal preserved.

**Safety matrix unchanged:** 32 enabled / 33 blocked / 5 unsupported. **Obsolete purge button untouched.** No new physical vector-write permissions enabled.

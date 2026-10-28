# VectHare C14 — Implementation Changelog (Step 14)

**Baseline:** `VectHare-Step13-C13-Cumulative-Chunking-Checkpoint.zip`. **Plugin:** read-only source reference; no plugin files modified or bundled.

## Issue #236 — Genuine embedding-similarity classification

- Implemented `core/emotion-similarity.js`: seven emotion classes with three versioned short reference phrases each; cosine-similarity scoring, deterministic tie ranking, explicit threshold/margin, neutral fallback, strict numeric/dimension validation, single-flight prototype batching and bounded in-memory prototype caching. Custom label subsets must have known prototypes; novel labels cannot silently masquerade as trained labels.
- Implemented `core/emotion-embedding-provider.js`: read-only adapter for plugin `POST /batch-embeddings`, requiring a positive application ACK, exact vector count, and exclusively local `transformers` source. No browser API keys, custom URLs or client-selected model sent. Other embedding sources remain explicitly unsupported by this C14 adapter.
- `core/emotion-classifier.js` now routes `emotion_use_similarity=true` to actual embedding requests rather than `/api/extra/classify`, and preserves original server-classifier behavior when disabled. The I17 full-text/mode/label cache remains isolated, with stale-request generation checks and prototype cache invalidation.
- Added a 14-sentence labelled evaluation fixture and `testSimilarityClassifier()`, returning evaluated/correct/unknown and measured accuracy against the active host embeddings. **No real-model accuracy is claimed:** the automated fixture scoring uses controlled fake embeddings.
- Settings UI offers similarity only with the local Transformers source, provides an explicit source label, and supports testing the selected mode. Existing saved values are preserved; unsupported sources fail closed.

## Issue #237 — Model selection honesty

- Removed nonfunctional classifier model and custom-model selectors from the UI; the host `/api/extra/classify` endpoint is server-controlled and cannot honor a VectHare-selected HuggingFace model.
- Exposes capability metadata `modelHonored:false` for both server-controlled classifier mode and local Transformers similarity. Similarity requests send an empty model field, matching source plugin behavior.
- Changed classifier test messages to plain text rather than HTML interpolation of server-provided labels or errors.

## Unchanged behavior and constraints

- C01 live purge, C02 backend replacement, C04/C06/C07 host verification, C05 protected credentials, C08 frequency gate, C09 live advanced retrieval, C10 host prompt receipts, and C11 exports retain all prior fail-closed restrictions.
- Similarity remains opt-in and does not alter stored collection vectors or perform any database mutations.
- Deployed plugin and SillyTavern versions not verified, so this checkpoint is not certified for production model accuracy or universal backend compatibility.

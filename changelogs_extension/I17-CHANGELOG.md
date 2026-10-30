# I17 — Emotion-classifier cache isolation

**Base:** I16 cumulative ZIP. **Scope:** #238 only. **Build:** I01–I17 cumulative.

## Change

- Cache results by an unambiguous JSON-encoded tuple of **full input text**, configured/requested model, classification mode, and custom label set. Different messages with the same first 100 characters no longer share a result.
- Clear cached classifications whenever classifier enabled state, model, mode or labels are changed using `updateClassifierSetting()`; direct settings modifications also generate distinct cache identities.
- Add a cache-generation guard so requests that finish after a cache reset do not populate the current cache with older results.
- Preserve the 100-entry cache limit, oldest-entry eviction, disabled-mode behavior and failure handling.

**Affected production file:** `core/emotion-classifier.js`.

## Verification

- **I17 tests:** 7/7 passed (`npm run test:i17`).
- **Cumulative I01–I17 tests:** 188/188 passed (`npm run test:repair`).
- **Syntax:** 100 JavaScript / MJS files passed `node --check`.
- **Live SillyTavern / Similharity:** not tested.

## Deferred

The endpoint currently does not honor client-supplied classifier model or embedding-similarity mode. Implementing those modes and capabilities remains Phase 2 C14 (#236 and #237 in the reviewed plan), not I17. Cache isolation by model/mode prevents accidental reuse but does not add model selection functionality.

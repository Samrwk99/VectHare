# I13 — Numeric settings and zero-value defaults

**Base:** VectHare-I12-Fixed.zip. **Cumulative build:** I01–I13.

| Issue | Fix |
|---|---|
| #52 | Preserve actual score `0` in vector-query results, World Info hit conversion, chunk visualizer, and condition filtering; do not substitute a perfect score. |
| #125 | Preserve `bm25_b: 0` (and `bm25_k1: 0`) in settings UI, BM25 scoring and hybrid scoring. |
| #227 | Preserve per-chunk score threshold `0`; accept normalized legacy rules with `settings.value`. |
| #228 | Preserve recency `messagesAgo: 0` for `eq`, `lte`, `gte` and legacy saved forms. |
| #96 | Preserve World Info semantic threshold `0` through regular and hybrid threshold evaluation (UI was already zero-safe). |
| #74 | Preserve a 0% random-chance setting and make it always false, even for a random draw exactly equal to zero. |
| #79 | Fix the same score-threshold defaulting defect as #227, including the filtering-stage score fallback. |
| #58 | Preserve zero overlap when the Content Vectorizer displays its strategy settings; preview/actual processing already used nullish defaults from I12. |
| #193 | Preserve injection depth `0` in Chunk Visualizer and Database Browser; invalid values still fall back to depth `2`. |

## Tests

- `npm run test:i13` — **9/9 passed**.
- `npm run test:repair` — **144/144 passed** across I01–I13.
- `node --check` — passed for **96 JavaScript/MJS files**.
- ZIP integrity — checked.
- Live SillyTavern/Similharity testing — **not performed**.

## Scope

This only fixes the nine I13 numeric/default issues and adjacent zero-value propagation paths. No Phase 2 internal mechanism was added. Source-level and mocked regression tests cannot guarantee behavior on a live SillyTavern/Similharity setup.

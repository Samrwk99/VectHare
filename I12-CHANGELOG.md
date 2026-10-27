# I12 — Content Vectorizer source selection, controls and chunk settings

Cumulative build: I01–I12. Base: VectHare-I11-Fixed.zip.

| Issue | Applied change |
|---|---|
| #149 | Reset loaded source data on content type, source tab, input method, address edits and modal close; tag cached data with its type; reject stale file/fetch completions after a source switch. |
| #150 | Character field checkboxes read/write the job's `currentSettings.fields`; selected fields flow into both preview and vectorization preparation. |
| #151 | Include Disabled Entries checkbox now saves `includeDisabled`, default false; lorebook preparation filters disabled entries unless selected. |
| #152 | Cleaning preset applies per Content Vectorizer job and is passed through every content preparation path, without rewriting the global cleaning preset. Existing global cleaner behavior remains unchanged. |
| #157 | Deep-copy nested content-type defaults so modal adjustments cannot mutate shared default fields or temporal settings. |
| #153 | Expose message-batch size in the Content Vectorizer UI and forward `batchSize` to both preview and actual chunking; retain zero chunk overlap via nullish defaults. |
| #116 | Remove/migrate legacy `protect` setting because no runtime path honored it; existing deduplication controls remain separate. No new recent-message safeguard is claimed. |

## Tests

- `npm run test:i12` — 8 focused tests passed.
- `npm run test:repair` — 135 cumulative tests passed (I01–I12).
- JavaScript syntax check — passed for 95 JS/MJS files.
- Live SillyTavern/Similharity integration testing — not performed.

## Scope / outstanding work

The feature does not provide the Phase 2 chat-scoped job manager or transactional replacement safeguards. Source-switch guards are local to the Content Vectorizer UI; broader concurrency isolation is scheduled for C03. `protect` is retired as nonfunctional, not newly implemented.

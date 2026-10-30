# I09 — Search relevance, keyword matching and BM25

Base: cumulative I08 project. Only I09 scope changed.

| Issue | Fix |
|---|---|
| #140 | Use the latest non-system chat messages while keeping them oldest-to-newest in semantic query text. |
| #97 | Merge semantic World Info results by collection-qualified vector identity, removing duplicate hits already returned from ordinary retrieval. |
| #137 | Preserve chronological order in World Info lookup and the optional direct WI injection path. |
| #234 | Share Unicode NFKC/case-normalized lexical tokenization between BM25 and keyword extraction, with portable CJK bigrams; preserve accented and Cyrillic words. |
| #171 | Match whole keywords or phrases, not substrings inside unrelated words; support Unicode boundaries. |
| #233 | Preserve repeated document terms for BM25 TF weighting; document frequency still counts each document once. |
| #99 | Replace unconditional late `score = 1` with the existing bounded weight-aware keyword boost. |
| #53 | Preserve nonzero, equal hybrid scores instead of normalizing tied results to all zeros. |
| #201 | Never cap overfetch below requested top-K values above 100. |
| #127 | Preserve rank order from raw reciprocal-rank fusion; display/confidence scoring cannot reorder results. |
| #19 | Remove literal backspace regex and use shared Unicode-aware query tokenization. |

## Tests
- `npm run test:i09`: 12 focused tests.
- `npm run test:repair`: 110 tests covering I01–I09.
- All JavaScript file syntax checks passed.

## Scope limits
- Does not implement independent full-collection lexical retrieval (Phase 2 C09).
- World Info duplicate elimination is based on collection-qualified stored identities; canonical cross-backend collection IDs remain Phase 2 C04.
- No live SillyTavern or Similharity integration testing was performed.

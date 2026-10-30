# I15 — Search Debugger record fidelity and trace attribution

Cumulative build: I01–I15. Base: `VectHare-I14-Fixed.zip`.

| Issue | Change | Files |
|---|---|---|
| #185 | Emit a new, zero-result debug record when no collections are enabled or none pass activation. Preserve collection decisions and show an activation-skip explanation instead of stale results. | `core/chat-vectorization.js`, `ui/search-debug.js` |
| #188 | Snapshot actual vector hits before keyword boosting/World Info merging. Track `afterKeywordBoost` and `afterWorldInfo` separately; update stage tabs, overview, counts and diagnostic export. | `core/chat-vectorization.js`, `ui/search-debug.js` |
| #186 | Record the actual extension prompt tag, position, depth, text, byte-independent character count and chunk IDs for each injection group. Display per-placement details and escape prompt content. | `core/chat-vectorization.js`, `ui/search-debug.js` |
| #182 | Keep selected history in a separate UI variable, leaving `getLastSearchDebug()` pointing at the most recently recorded search. History copy and stage tabs use the selected entry. | `ui/search-debug.js` |

## Verification

- `npm run test:i15`: **10/10 passing**.
- `npm run test:repair`: **163/163 passing** (cumulative I01–I15).
- JavaScript syntax checks: passed.
- ZIP integrity: passed.
- Live SillyTavern/Similharity testing: **not performed**.

## Notes

- Prompt verification here confirms **extension prompt registration**, not inclusion in the final host-assembled prompt. Final inclusion receipts and token-aware budgeting belong to Phase 2 C10.
- Stage snapshots describe results returned by the existing query-merger; individual backend return accuracy and independent lexical retrieval remain separate Phase 2 work.
- No other repair groups were intentionally changed.

# I11 — Chunk links, inclusive group boosts and temporal weighting

**Base:** `VectHare-I10-Fixed.zip`. All changes from I01–I10 are retained.

| Issue | Implemented fix |
|---|---|
| **#72** | Read chunk metadata from Map-like or plain-object stores. Support both saved `{ chunkLinks: [{ targetHash, mode: 'force'/'soft' }] }` and legacy/group `{ links: [{ target, type: 'hard'/'soft' }] }` forms. Normalize target IDs as strings (preserving leading zeroes), avoid duplicate mirrored links, and make both retrieval branches detect explicit `chunkLinks`. |
| **#134** | Carry individual inclusive group's `boost` into virtual links and apply that value during scoring. Fall back to the configured default only when unset; preserve `0` in the editor and scoring. |
| **#229** | Dispatch the live weighting stage to nostalgia scoring when `temporal_decay.type === 'nostalgia'`, rather than always invoking decay. Preserve ordinary and scene-aware decay modes, score thresholds, and debugging flags. |

## Changed files

- `core/conditional-activation.js`
- `core/chunk-groups.js`
- `core/chat-vectorization.js`
- `ui/chunk-visualizer.js`
- `tests/i11-links-temporal.node.test.mjs` (new)
- `package.json` (new `test:i11`; appended to `test:repair`)
- `I11-CHANGELOG.md` (included in ZIP)

## Local verification

- `npm run test:i11`: **8/8 passed**.
- `npm run test:repair`: **127/127 passed** (I01–I11).
- `node --check` across project JS/MJS files: passed.
- ZIP archive integrity: passed.

## Outstanding / not claimed

- Missing hard-linked targets are reported but are **not fetched from the backend**; that is C09 (retrieval planner).
- Per-collection temporal-policy resolution (C12/#94) is still pending. I11 corrects the weighting *type dispatch for the settings passed into the live stage*; it does not implement C12.
- No live SillyTavern / Similharity integration testing was performed. The results cover local regressions only.

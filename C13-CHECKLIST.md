# VectHare C13 — Issue-by-issue checklist

| Requirement | Status | Evidence / limitation |
|---|---|---|
| #57 adaptive/sentence/dialogue overlap is real | **Locally implemented** | `core/chunking.js` `applyTextOverlap`, `validateOverlap`, `chunkText`; dedicated unit tests. |
| #57 explicit zero remains zero | **Verified** | `i13-numeric-zero` execution test and C13 overlap=0 tests. |
| #57 size and Unicode safeguards | **Locally implemented** | Surrogate-safe window boundaries, input validation, long-word splitting; targeted tests. |
| #57 visibility reflects supported strategies | **Locally implemented** | `content-types.js` flags and context-dependent adaptive-chat controls. |
| #107 adaptive chat groups instead of per-message fallback | **Locally implemented** | `adaptiveChatGroups` and `prepareChatContent` / `chunkText` pipeline. |
| #107 stable message membership and chunker version | **Locally implemented** | Per-chunk metadata; collection `chunkerVersion`/effective settings stamp. |
| #107 new versioned destination rather than in-place change | **Locally implemented** | Separate uploaded-chat collection identity; live-chat runtime / settings gate. |
| #107 migration review and rollback | **Planner only; activation blocked** | `planChunkStrategyRebuild` is dry-run; C02 verified commit and full C07 reference migration remain required. |
| #148 imported chat scene boundaries parsed | **Locally implemented** | Explicit indexed, flag, extra and textual marker formats; scene metadata. |
| #148 select-time rejection for absent/invalid markers | **Locally implemented** | Parsed source controls dropdown availability; runtime validation and preview use same contract. |
| #148 no silent missing-scene fallback | **Locally verified** | Invalid/empty/nested/overlapping scenes reject before writing. |
| Old I01–I18, Phase 0, C01–C12 regressions | **Verified locally** | 779 prior tests retained and passed. |
| Live plugin/server compatibility | **Not certified** | Unchanged Similharity source lacks required verified C02/C06 readback, write and replacement proofs. |
| Live adaptive rebuild/reindex and activation | **Blocked** | Needs complete verified inventory, transactional C02 commit, reference migration, and durable host settings acknowledgement. |

The existence of strategy code and successful local tests must not be treated as certification of live migration, imports, or vector replacement.

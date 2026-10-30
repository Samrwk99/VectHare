# C09 — issue-by-issue checkpoint checklist

| Issue | Local implementation | Live acceptance | Evidence / blocker |
|---|---|---|---|
| #108 | Implemented: 3× over-fetch, up to two wider late-filter refill rounds, bounded stop reasons | Pending host/backend performance and behavior | `core/chat-vectorization.js`, `core/retrieval-planner.js`; synthetic pipeline tests |
| #192 | Implemented: stable ranked priority, optional per-collection quota, selected-chat tie priority | UI/default-policy acceptance pending | `core/collection-metadata.js`, retrieval planner |
| #76 | Implemented: scoped overlap detection with reliable message identities | Copied/legacy chat verification pending | `removeOverlappingGroups()`; tests for cloned IDs and unscoped positions |
| #54 | Verified-capability expansion path in place; fails closed without readback | **Blocked: live C06 scoped getByIds contract** | `expandRequiredLinks()`; host bridge requires verified capability |
| #55 | Bounded inclusive-hard / mandatory-member lookup with identity checks | **Blocked: live C06 scoped getByIds contract** | No unbounded or unscoped fallback |
| #139 | Implemented: deterministic multi-group conflict resolution, mandatory-unsatisfied reasons | Host/UI integration pending | `resolveGroupConstraints()` and group stage |
| #147 | Implemented: one deterministic exclusive winner, scoped suppression | Config UI/host behavior pending | `filterActiveCollections()` |
| #68 | Independent lexical provider, verified client index and native contract interface implemented, vector-only fallback explicit | **Blocked: verified native lexical contract or complete versioned scoped inventory** | `core/lexical-provider.js`, `core/hybrid-search.js` |
| #56 | Implemented: multiple summaries per scoped parent | Actual backend parent readback completeness pending | `expandSummaryChunks()` |

**Important:** The original C09 plan header counts 10 issues, but its issue-action list names **nine distinct issue IDs** (#108, #192, #76, #54, #55, #139, #147, #68, #56). This checklist covers every ID explicitly named in that C09 section; no tenth issue ID is invented.

**Overall:** C09 local checkpoint delivered. Live backend-dependent expansion and lexical completeness, plus downstream C10 receipt, remain pending. This is not unrestricted production certification.

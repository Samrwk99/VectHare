# VectHare — C09 retrieval checkpoint changelog

**Baseline:** Step 8 C08 cumulative ZIP; Similharity plugin remains unchanged and separate.
**Result:** C09 local retrieval safety and selection improvements; some external backend-dependent features remain gated.

## Implemented

- **#108 — Late-filter headroom and refill:** Over-fetch up to a bounded factor/candidate limit, retain candidates across late filters, and run no more than **two** wider query rounds after condition filtering and in-chat deduplication. Every new candidate passes disabled, keyword, summary, reranking (when enabled), threshold, temporal, condition, group, and deduplication stages. Record refill limits/failures in retrieval debug output. An exhausted/capped backend may still leave slots empty.
- **#192 — Priorities and quotas:** Stable sorting by score, then configured collection priority, then qualified record reference. Allow reviewed per-collection priority/quota metadata, per-run overrides, and selected-chat collection tie preference. No rejected collection or chunk is re-enabled by priority.
- **#76 — Grouped message overlap:** Identify overlap using chat-origin-qualified durable message identities or chat-scoped positions; do not treat unscoped legacy positions or copied-chat UIDs as proof of overlap.
- **#54/#55 — Linked/group expansion groundwork:** Add bounded, collection-scoped required-member fetching with explicit proof checks. Wire into retrieval **only** through verified C06 tenant-scoped `getByIds`. When that capability is unknown, do not fetch and emit a diagnostic rather than make an unsafe unscoped scan.
- **#139 — Exclusive group constraints:** Deterministic scored winners with qualified group memberships, conflict detection, mandatory-group-unsatisfied reporting, and prevention of reintroducing a loser from another overlapping group.
- **#147 — Exclusive collections:** Select a deterministic winning *active* exclusive collection by configured priority and stable ID tie-break; respect `lorebook`/`all` scope and never activate an otherwise inactive collection.
- **#68 — Independent lexical candidates:** Add capability-gated native or complete, versioned, scoped client BM25 indexing (limited to modest verified collections), enabling genuine lexical-only hits when an independent source exists. **No more BM25-on-vector-topK masquerading as independent hybrid**. Without a verified lexical source, report vector-only retrieval. Do not infer native capabilities from an adapter method alone.
- **#56 — Scoped parent summaries:** Preserve multiple summaries of the same parent within and across collections instead of overwriting by parent hash.
- **Cross-collection protection:** Refuse ambiguous duplicate physical record identities; suppress hash-only legacy links when multiple collections share a hash.
- **Regression coverage:** Added C09 planner, orchestration, and hybrid tests. Extended older isolated test harnesses for the new imports.

## Deliberately not enabled or completed

- Live `getByIds` link/group refill requires verified server tenant filtering, record lookup and ownership. The supplied plugin does not establish that contract.
- Live independent lexical querying requires a proven native lexical endpoint or a complete versioned tenant-scoped inventory suitable for a client index. No such runtime capability has been certified.
- C10 still owns tokenizer-aware final prompt budgeting and a verified inclusion receipt; C09 selection does not prove prompt inclusion or unlock C08 frequency accounting.
- Full C01/C02/C04/C06/C07/C05 live acceptance and destructive/credential constraints remain as previously documented. No server plugin changes and no data migrations were performed.

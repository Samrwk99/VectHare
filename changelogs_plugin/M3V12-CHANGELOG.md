# M3v12 — Change log (VectHare / Similharity)

**Baseline:** VectHare M3v11 + Similharity M3v11. **Target:** VectHare `2.2.0-alpha.m3.16`, Similharity `3.2.10-m3.16`.

## Completed

1. **Post-cutover active-generation deletion:** The deletion plan and one-shot execution bind the verified active journal generation and refuse stale physical targets. S02 tombstones only after a confirmed Qdrant 404 of the deleted active collection. The receipt names the deleted physical generation and records historical collections as *retained*, not purged.
2. **Historical-collection protection:** Before physical delete, every retired journal generation must have a complete owner-bound backup and unchanged full physical inventory. Ordinary missing historical evidence blocks execution. Source-scoped cross-model activation has a narrowly proved exception for a never-provisioned canonical name, requiring a verified source selection and Qdrant 404.
3. **Large-model rebuild preparation:** Staging tickets now permit up to 20,000 managed active records subject to source-backup limits. More than 256 records require immutable per-record preembedding checkpoints produced in server-bounded 16-record steps. Crashed or paused preembedding can resume without retrying a physical mutation.
4. **Prepared-vector consumption:** The final existing guarded stage transaction consumes the already-sealed vectors, rechecking saved source, profile, revision and record identity. The immutable target backup size is checked *before* the one-way physical claim; final staging remains a single, non-replayable physical operation if uncertain.
5. **GUI:** Adds preparation progress, pause/resume by saved operation ID, and explicit retention wording for deletion. Browser calls cannot supply text, vectors, physical targets, credentials, or owner IDs.
6. **Regression:** Tests for repeated deletion, history loss, virtual canonical exception, 300-record resumable preparation, checkpoint tampering and stale-source refusal.

## Explicitly still blocked

- General uncertain lifecycle adjudication where authoritative applied/not-applied evidence is missing.
- Full resumability of the *physical* Qdrant staging/cutover after dispatch. Only preembedding is resumable. No replay of uncertain writes.
- Shared/foreign collection destructive operations and unrestricted `/purge-all`.
- Per-backend operations belonging to M4–M8 not yet implemented.

The 70-cell matrix remains **8 ENABLED / 57 BLOCKED / 5 UNSUPPORTED_BY_DESIGN**. Two additional scoped Qdrant components are enabled for user manual testing; this is not a claim of external certification.

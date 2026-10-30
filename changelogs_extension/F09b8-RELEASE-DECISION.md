# F09b.8 — Release decision

**Implementation verdict:** COMPLETE for the **restricted offline cross-workflow integration verification checkpoint**. New cross-stage tests and the matched source versions are packaged. The regression assertions are green, with one pre-existing extension Node worker SIGSEGV in a partition that passed when rerun alone.

**Production readiness:** `DEVELOPMENT_ONLY_NO_GO`. All four backend selectors were covered **only through simulated physical adapters**. Production Qdrant/LanceDB/plugin Vectra/Milvus remains denied, and no native Standard, blanket purge, legacy migration or automatic mutation is unlocked. Same-process test fixtures are not evidence of external-writer concurrency safety or host deployment identity.

**Unfinished scope:** The existing F09b.5 embedding-provider parity, F09b.6 full summaries/World Info parity, and F09b.7 live link/condition/lifecycle parity gaps remain; F09b.8 integration cannot silently close them.

**Next planned stage:** F09c — actual host/backend acceptance with disposable collections, interleavings/external writers, source/owner isolation, crash-uncertain receipt handling and observed evidence. Then F10b backup/recovery, F11b UX and F12b release assessment. Any expanded functional parity must be separately implemented, tested and scoped before matrix activation.

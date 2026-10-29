# F09c.8 — Release decision

**F09c.8 administrator-only Vectra disposable diagnostic: COMPLETE as a restricted offline implementation checkpoint.**

**Actual Vectra host acceptance: NOT DONE. Overall F09c: OPEN. Production vector writes: NO GO.**

This checkpoint exercises only an injected SDK mock. The native `vectra` library is not installed in the current environment, and no actual index has been opened, created or mutated. The read-only native preflight fails closed when the SDK is unavailable.

The explicit user-accepted concurrency contract protects **cooperating VectHare writers that share one trusted lock root and physical collection identity**, not unrelated direct database writers. The new probe participates in that lock; existing VectHare runtime mutations do not yet have proven comprehensive lock coverage. A stale revision is checked under the cooperating lock; no native compare-and-swap guarantee is claimed.

Do not enable Qdrant, LanceDB, Vectra, Milvus, native Standard, historical collections, unscoped purge or background automation on the strength of this checkpoint. F09c.6 and F09c.7 live acceptance also remain pending.

**Next:** F09c.9 Milvus diagnostic; F09c.10 cross-backend real-host, recovery, source isolation and complete runtime-lock coverage; F09c.11 backend-scoped release decisions.

# S03 — Verification Report

**Date:** 28 October 2026  
**Version:** `3.2.3-s03.0`  
**Assessment scope:** source and offline tests only.

Commands:

```bash
npm run check:s03
npm run test:s03
```

| Test group | Outcome |
|---|---|
| Cumulative S01/S02/S03 Node tests | 63 pass, 0 fail |
| All packaged JavaScript/ESM syntax checks | 15 pass |
| S01 destructive-route/mismatch denial | Passed offline |
| S02 UUID, collection identity, registry and dry-run migration | Passed offline |
| S03 trusted-user extraction, conflict rejection and root-path binding | Passed offline |
| S03 private administrator configuration permissions/symlink checks | Passed offline |
| S03 scoped backend factory/pool isolation and configuration rotation | Passed offline |
| S03 concurrent initialization and failure eviction | Passed offline |
| S03 protected registry read-only lookup | Passed offline |
| S03 shared legacy read, insecure rerank/folder and browser credential guards | Passed offline |
| Actual plugin middleware/route registration with dependency stubs | Passed offline |
| Real SillyTavern auth/CSRF and API host semantics | **Not tested** |
| Actual multi-user Qdrant/Milvus/LanceDB instances | **Not tested** |
| Actual remote credentials, TLS, token handling and connection | **Not tested** |
| Safe mutation or final prompt integration | **Blocked / not tested** |

**Critical interpretation:** Offline simulations prove this source rejects specified unsafe inputs; they do not establish that a deployed SillyTavern plugin receives the expected host-authenticated user object or that the host router enforces authentication/CSRF. In that case S03 deliberately refuses requests instead of silently trusting request bodies. Backend pool identity is per process, not a durable distributed isolation control. Real server/backend integration is required before any production or write-support claim.

**Compatibility impact:** Legacy browser-provided Qdrant/Milvus connection settings are no longer accepted. Shared Qdrant/Milvus reads are explicitly blocked until S05's authenticated read contract exists. Legacy ambiguous Qdrant/LanceDB/Vectra local names can be refused. External rerank and folder launch are blocked. Do not replace a working production plugin containing valuable vectors without testing and a rollback plan.

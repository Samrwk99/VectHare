# F08 — Release decision

**F08 STATUS: GUARDED DEVELOPMENT CANDIDATE — NOT PRODUCTION READY.**

Milvus has an authenticated F02 read route, F03 source-bound schema provisioning, F08 isolated disposable lifecycle acceptance, and a consented local-only manual CRUD pilot using the S04 ledger. These are not normal VectHare memory operations. Legacy mutations stay refused, full authoritative inventory and migration remain unavailable, and no external-writer CAS or host crash/restart guarantee has been demonstrated.

Before any production activation: prove real Milvus SDK/server behavior, concurrent writers, source isolation, restart recovery, and complete F09 memory workflow integration. Continue with F09–F12 while collecting host tests for F05–F08.

# F09c.4 — Release decision

**F09c.4 offline implementation: COMPLETE.**
**Overall F09c acceptance: OPEN.**
**Production readiness: NO GO.**

The Qdrant conditional request API provides a meaningful candidate for optimistic concurrency when writers cooperate on revision filters, but the documented `completed` response does not include a per-point `condition_matched` or `applied` result. Post-dispatch readback is not causal evidence. F09c.4 proves this ambiguity with controlled independent-writer counterexamples, adds explicit non-authorizing diagnostic classification and retains all safety gates.

### Required to close F09c

1. Establish a backend-native, independently verifiable *applied vs skipped* outcome (not merely an acknowledged/completed operation), **or** build a genuinely enforced exclusive-writer service and deployment architecture; both need physical testing. An assertion that the deployment is single-writer is not itself enforcement.
2. Prove that all write credentials, legacy and new raw mutation routes, direct backend access and independent writers are blocked or mediated by this enforcement point, including local and network paths.
3. Test real Qdrant v1.17+ conditional requests, no-op responses, race conditions, restarted operation journals and crash-uncertain outcomes on disposable physical collections.
4. Independently assess LanceDB, plugin Vectra and Milvus; one backend's semantics cannot be generalized to the others.
5. Capture sanitized host logs and independent reviewed acceptance evidence; do not unlock production matrices based on offline fixtures or self-reported flags.

No native Standard, legacy vector, collection-wide purge, background auto-write or automatic uncertain-operation reconciliation grant is included.

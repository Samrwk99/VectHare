# F09c.6 — Release decision

**F09c.6 Qdrant diagnostic implementation and regression checkpoint: COMPLETE.**

**Qdrant real-host acceptance: NOT DONE. Overall F09c: OPEN. Production mutation activation: NO GO.**

The host-only probe can inspect a live local Qdrant 1.17+ server and (with explicit consent) create a fresh disposable collection to test conditional behavior. Its test execution cannot establish an applied-versus-skipped acknowledgement for individual writes. It must not issue production mutations or classify a backend as CAS-certified.

**Accepted operational scope** (per user): supporting only cooperating VectHare writers using the same trusted lock is acceptable; stopping unrelated applications with direct backend credentials is **not required** for the target deployment. Such external direct writes remain outside the VectHare concurrency guarantee; they must not be presented as protected.

This scope acceptance removes the proposed requirement for independent blocking of unrelated apps, **but does not prove all VectHare mutation routes participate in the lock**, nor does it fix crash recovery, actual host verification, or Qdrant's ambiguous conditional acknowledgement. Those remain real admission requirements.

Next: run the Qdrant diagnostic on the user's disposable real host; make/verify the shared cooperating-writer lock binding for the supported write routes; continue LanceDB, Vectra and Milvus acceptance, crash/restart tests and evidence review.

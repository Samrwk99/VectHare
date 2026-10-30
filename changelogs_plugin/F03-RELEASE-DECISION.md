# F03 Release Decision

**Status: DEVELOPMENT / HOST TEST CANDIDATE — NOT PRODUCTION-READY.**

F03 provides a meaningful backend-mutation safety foundation and explicit, source-bound **empty collection creation for Qdrant and Milvus**, with rollback-by-refusal (no automatic delete), a persistent provisioning receipt, cross-process same-user-root locks and numeric physical-vector readback logic.

The checkpoint **does not finish the full F03 live-proof objective** from the master plan: LanceDB/Vectra provisioning, actual native backend acceptance, remote/external writer isolation, production operation recovery under crash, and real database vector readback must still be demonstrated. These are release blockers, not issues to bypass with configuration switches.

No general vector record operation has been reactivated. Continue toward F04 only after the applicable live F03 acceptance is obtained, and keep one backend/operation enablement decision separate from another.

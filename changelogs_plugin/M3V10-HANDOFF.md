# M3v10 handoff — next engineering priorities

**Code-ready:** bounded source-scoped Qdrant rebuild with separate stage, verification and activation; source-bound M1 reads/writes/embedding and F02 selected-profile enforcement; post-activation backup preflight; guarded GUI. `ENABLED / AWAITING_MANUAL_TEST` under the M3–M9 v4 policy.

**Outstanding engineering before M3 fully done:**

1. Replace the 256-record synchronous stage with checkpointed, resumable M2 per-record batches. Retain pre-dispatch claims and never replay uncertain writes.
2. Generalize destructive M3 restore/delete/empty to already-published source-model generations with mandatory fresh complete backup, owner/managed inventory proof, and versioned physical binding locks.
3. Implement administrator adjudication for genuinely uncertain collection/cutover/rebuild operations, with authoritative backend/ledger/registry reconciliation before lock release.
4. Complete the remaining integration tests for the full user journey on disposable latest-stable SillyTavern and real Qdrant; update validationStatus from AWAITING_MANUAL_TEST to VERIFIED only on user evidence.

**Important:** Do not make external real-host certification a reason to disable operations whose code-level safety requirements pass. Conversely, a missing operation or demonstrably unsafe retry is a legitimate BLOCKED state. This follows the user's revised M3–M9 execution policy.

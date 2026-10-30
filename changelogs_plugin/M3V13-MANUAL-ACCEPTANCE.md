# M3v13 manual test instructions (disposable only)

1. Install the **matched** `VectHare-M3v13` extension and `Similharity-M3v13` plugin on a disposable latest-stable SillyTavern with a disposable Qdrant collection and a complete verified backup.
2. Create an owned saved source with >256 active records and configure a distinct staged local embedding profile. Prepare the embeddings through the existing 16-record preparation steps, then explicitly run the guarded physical stage.
3. After staging, click **Inspect physical rebuild checkpoints (read-only)** and check that `verifiedRecordCount` matches the source and `verifiedChunks` equals the number of 32-point batches. This is historical evidence, NOT a green light to resume an interrupted stage.
4. In a disposable fault-injection environment, interrupt Qdrant at a batch boundary and verify the stage remains claimed/uncertain; only previously read-back-verified chunks appear in progress, and retries are refused.
5. As an authorized host administrator, use **Admin: reconcile Qdrant lifecycle outcome (read-only)** on an operation UUID. A proven completed operation may say `VERIFIED_APPLIED_REVIEW`; an incomplete or ambiguous one must say `REVIEW_REQUIRED`. Both explicitly forbid replay and physical lock release.
6. Report operation UUIDs and sanitized error codes/results only. Do **not** upload credentials, personally sensitive chats or full private backup contents.

`ENABLED` means code-ready for your controlled manual testing, not a claim of host production certification.

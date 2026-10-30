# F01 Verification Report

**Scope:** Source/offline test verification only. Does not certify live SillyTavern, Windows/Termux filesystem behavior, or any vector backend.

## Results

- Similharity cumulative Node tests: **261/261 passed** (`node --experimental-vm-modules --test tests/*.test.mjs`).
- VectHare isolated Node test files: **59/59 passed**, **1,096/1,096 test cases passed** (one independent Node invocation per file).
- Focused F01/S11 extension tests after final source-fingerprint pin: **26/26 passed**.
- Plugin and extension JavaScript source syntax checked successfully with `node --check`.
- The existing combined VectHare runner intermittently crashes in an old `c12-integration.node.test.mjs` VM-based file (SIGSEGV). The file passed when run independently. **Do not describe the combined runner as a clean pass.**

## Coverage

- Authenticated user file existence and source-directory isolation.
- Character-avatar ownership for solo chat.
- Group membership for group chat.
- Distinct chat and branch IDs despite duplicated integrity fields.
- Stable identity after restart-style re-attestation and independently verified same-file rename.
- Refusal on changed integrity/branch metadata, missing registry, invalid header, invalid selector and symlink/path escape.
- Header-only empty chat support.
- Public route under real plugin registration: unauthenticated 401; authenticated owned-source attestation; no backend write dispatch.
- Extension source-attestation request-gateway whitelist and continued denial of v2 insert.
- Extension build fingerprint pinned to the new plugin executable source fingerprint.

## No live evidence

No actual SillyTavern authentication/CSRF integration, active-chat attestation, real Qdrant/LanceDB/Milvus/Vectra calls, persistence after an actual host restart, or native backend mutation was executed in this test environment. The post-F01 runtime matrix is unchanged for vector reads/writes.

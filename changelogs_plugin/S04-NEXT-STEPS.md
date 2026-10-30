# S05 Handoff — Read, Owner Projection, Inventory and Embedding Contracts

1. Verify `req.user` identity and `directories.vectors` mapping in an authenticated disposable SillyTavern host. Do not bypass auth/CSRF or allow browser-selected owner/backend credentials.
2. Implement a **trusted server-owned source/collection registration** that verifies chat, lorebook and branch identity. S02 reservations and S04 preflight are NOT owner authorization.
3. Implement backend-authoritative scope-safe `getRecord`/`query`/`list` and stable pagination. Qdrant and Milvus legacy shared reads remain S03-denied until owner columns/projections and tenant filters are independently proven.
4. Define exact backend v2 record schema: stable UUID/physical ID, owner fields, revision, content/vector fingerprints, embedding version. Check compatibility with real Qdrant and Milvus primary-key/consistency APIs.
5. Connect only read-only `getRecord` adapters to S04's internal engine for independent verification tests; **do not expose public submit or reconcile routes** until backend operations and source attestation are certified.
6. Verify embedding model/dimension and numerical integrity. Require errors distinct from empty/no-hit; forbid incomplete inventory from enabling export or destructive cleanup.
7. In S06/S07/S08 implement scoped backend mutations with durable semantics, independent readback, and collision/restart tests on empty disposable collections. Ensure no hash-only deletion, delete-before-insert or dimension-mismatch purge.
8. Record per-backend PASS/FAIL/BLOCKED/UNPROBED, source build hashes, two runs including after restart, and rollback. Leave legacy unsafe routes denied permanently or replace them with a separately reviewed v2 adapter.

## S04 API/engine contract

- `planMutation(context,input)` validates schema, builds canonical IDs and fingerprints, **not authorization**.
- `OperationLedger` stores a private receipt in `vectors/.similharity/s04-operations` and records PREPARED/SUBMITTED/VERIFIED/UNCERTAIN/FAILED.
- `MutationEngine` receives an injected trusted `authorize(plan)` callback and an adapter with `getRecord`, `insertRecord`, `updateRecord`, `deleteRecord` methods. There is **no production adapter connected** yet.
- `getRecord(plan)` must return canonical owner fields, revision, content/vector/metadata fingerprints or *null only for confirmed absence*; errors MUST throw, never become null.
- Mutation methods must implement backend-native ownership and concurrency guarantees. An adapter must never treat a successful API request as proof of durable commit without independent readback.

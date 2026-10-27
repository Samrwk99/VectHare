# VectHare — C04-A / C06-A / C11-A dependency checkpoint

Baseline: `VectHare-I18-Phase0-C01-Safety-Checkpoint.zip`. This is a cumulative source update, **not completion of C04/C06/C11**.

## C04 Stage A — qualified identity routing
- Added `utils/tenant-route.js`, a shared `adapterCollectionId()` validator for `backend:source:collectionId` and legacy `source:collectionId` keys. Qualified backend/source mismatch and malformed backend-qualified keys are refused, not silently treated as bare physical IDs.
- Standard, Qdrant, Milvus and LanceDB now validate/strip authoritative qualified collection identities on their adapter operations. Standard sends the correct physical ID to native SillyTavern instead of using the entire registry key as its collection name.
- Legacy bare IDs remain accepted for compatibility. **This does not migrate or resolve ambiguous registry records**; ownership migration and policies remain C04 Stage B.

## C06 Stage A — conservatively isolated backend operations
- Extended the capability ledger with `pointTenantFilter: unknown` (existing `tenantFilter`, pagination, count and delete/purge acknowledgement capabilities stay unknown).
- Milvus's shared-physical-collection reads, queries, inserts and edits require verified `tenantFilter`; point GET stays blocked because the request does not include a verified tenant filter.
- Qdrant shared multitenancy queries/list/inserts require verified `tenantFilter`. Its single-point GET/PATCH operations are blocked in shared mode without scoped request semantics, and shared physical-collection purge is explicitly prohibited.
- Direct targeted deletion and collection purge in all four adapters now fail closed without a verified acknowledgement; global purge methods do not call the network. This is defense in depth in addition to C01's high-level delete gate.
- Existing adapter responses are **not certified as having complete tenant isolation, supported query vectors, or valid ACKs**. Some operations intentionally become unavailable on unverified Milvus and Qdrant multitenancy servers.

## C11 Stage A — inventory traversal and conservative adapter bridge
- Added `utils/c11-paginated-inventory.js`: explicit cursor/offset modes; scope and record ownership checks; positive end-of-list required; duplicate/repeated page detection; count cross-check; bounds and error-state reporting.
- Added `utils/c11-adapter-inventory.js`: C01 bridge to an adapter `listChunks()` only after separately verified tenant-filter, complete-inventory and pagination capabilities. Raw server responses lacking `scope`, per-record owner or `endOfList` cannot confirm completeness.
- Wired the bridge into the C01 delete coordinator's inventory callback. This does not activate live deletion because server flags remain unknown and SillyTavern's debounced settings save cannot prove durable persistence.
- Added a deterministic test of a 120,001-record, 25-page inventory without data loss, and cases for missing end, repeated records, wrong owner, count mismatch, server failure and page limits.

## Tests and compatibility
- `npm run test:repair`: 199 passing on serial rerun.
- `npm run test:p0`: 33 passing.
- `npm run test:c01`: 35 passing.
- `npm run test:dependencies`: 24 passing.
- `node --check` across all `.js` and `.mjs` source: passing.
- The Node experimental VM module test harness intermittently emitted a **SIGSEGV** in independent runs (in I17 and I08 test worker processes); individual reruns and a complete serial rerun passed. This intermittent runner instability is not certified as resolved.

## Still open
- C04 Stage B: versioned registry migrations, backup/dry-run, untrusted restored owners, chat/character ownership, policy cleanup.
- C06 full backend facade, pinned Similharity schemas, tenant-filter/ACK/embedding-provider contract smoke tests and cross-tenant live acceptance.
- C11 Stage A server-verified cursor/offset mappings and count proofs; Stage B streaming exports, large-collection receipts, PNG limits.
- C01 production deletion/recovery: independently verified ownership and paginated inventories, durable settings persistence, real purge ACK and post-purge readback.
- C02–C14 remainder not implemented here. No data migrations and no settings version increment.

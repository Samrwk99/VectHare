# E04 — Read-Only Capability and Acceptance Assessment

The matrix below describes the **actual current extension**, not proposed plugin changes. “Local pass” means simulated/contract tests; it is not a deployed host result. No feature is globally enabled by this document.

| Workflow | Local implementation | Runtime allowance | Live proof still required |
|---|---|---|---|
| C09 bounded candidate selection/dedup | Existing C09 + E04 disabled-linked-member check | Permitted for already retrieved *verified-scoped* candidates | Queries, owner identity, latency under actual plugin |
| C09 expand missing hard links | Existing scoped facade + E04 metadata eligibility check | **GATED** by tenantFilter, pointTenantFilter and getByIds proof | No backend receives this proof merely from E04 |
| C09 lexical search | Existing independent native/client inventory contract; explicit vector-only fallback | Native only when independently contract-verified; client index only on complete versioned inventory | Native hybrid endpoint behavior, result provenance, UI warning |
| C08 WI identity and previous scans | E04 verifies empty/invalid WI events | Allowed as *previous observed scan* only | Exact host event shape/order; copied chats, world+UID |
| C09 exclusive WI collection winner | E04 uses existing stable resolver | Locally functional | Actual collection registry selection and on-host WI conditions |
| C10 prompt budgeting | Existing C10 budget planner | Registration only if budget known; no oversized block | Actual tokenizer, context, prompt serialization |
| C10 final inclusion receipt | E04 protects chat message boundaries | Can report observed inclusion, never call prompt registration proof | Event timing, final model request, dry runs / regeneration |
| C08/C10 frequency-conditioned activation | Existing durable ledger and receipt foundations | **WITHHELD** (`C08_FINAL_INCLUSION_RECEIPT_AVAILABLE=false`) | Final request receipts, durable readback, multi-tab behavior |
| C11 verified NDJSON export | Existing C11 inventory proofs + E04 count preflight | **WITHHELD** unless count, pages, tenant and completeInventory capabilities independently verified | Backend-by-backend live inventory/count/end behavior |
| C11 legacy JSON and PNG export | Existing explicit UNVERIFIED labeling and PNG limits | Output must not be presented as verified full backup | Browser and malformed data checks |
| C14 emotion similarity classification | Existing C14 feature | Local algorithm implemented; real-model confidence unverified | Labelled actual embedding-model evaluation |

### Backend-specific constraints
- **Standard (Vectra):** Native and plugin read/write interfaces must be distinguished. No automatically certified complete inventory or scoped link lookup.
- **LanceDB:** Physically separated tables reduce blast radius, but sanitized table identity, errors, count and pagination need probes.
- **Qdrant:** Shared collection and hash-based physical IDs create tenant collision hazards; scoped queries require validated `filters` and returned ownership. E04 grants no write or delete permission.
- **Milvus:** Shared collection, unfiltered point lookup and untrustworthy empty-on-error inventory prohibit treating lookup or count as reliable without new proof. E04 grants no write or delete permission.

### Status vocabulary
- **Local pass:** Tests assert a behavior against isolated or simulated dependencies.
- **Guarded:** Function can run only after the listed proof exists.
- **Denied:** Request gateway must refuse the operation with zero mutation network requests.
- **Uncertified:** Host timing, backend semantics or browser behavior have not been exercised.

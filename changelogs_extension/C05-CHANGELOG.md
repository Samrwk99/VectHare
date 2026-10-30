# VectHare C05 — Credential security checkpoint

**Baseline:** Step 6 cumulative project (I01–I18, Phase 0, C01, C02, C03, and C04/C06/C07/C11 checkpoints).
**Plugin:** User-supplied `VectHare-Similharity-Plugin.zip` was read-only and was not included/modified.

## Code changes

1. Added `utils/c05-protected-credentials.js`: explicit credential key map; write-only protected-secret adapter (`setSecret`, `hasSecret`, `deleteSecret`, `migrateLegacySecret`, `redact`); strict host-write acknowledgements, boolean-only presence checks, user-scoped plugin capability handshake and authenticated test receipt; reject unknown outcomes. No `getSecret` method.
2. Replaced credential-entry UI persistence for Qdrant/Milvus/BananaBread with protected-store controls. Never pre-fill password inputs with legacy settings values. Inputs remain disabled when the server-side resolver cannot be verified. Add setup warnings, guarded clear actions, and a separate **explicit** legacy-only plaintext removal button which warns that it cannot revoke the server secret or prove durable host persistence.
3. Removed all four credentials from `index.js` default settings and from runtime outgoing settings snapshots. Legacy settings values are not deleted on startup: they must survive until successful authenticated migration plus acknowledged durable settings persistence.
4. Qdrant cloud initialization refuses legacy plaintext and requires the user-scoped resolver contract. The browser never sends `apiKey` in Qdrant init JSON.
5. Milvus refuses a legacy password/token, requires resolver evidence for configured authentication and never sends password/token in init JSON. It no longer surfaces arbitrary error-body text from failed init.
6. BananaBread embedding/rerank paths no longer send the key in plugin request bodies or browser Authorization headers. The pinned plugin cannot resolve protected BananaBread secrets; unsupported paths fail closed. Blocked client-side embedding cannot quietly fall back to unauthenticated embedding. Removed the incorrect assumption that `secret_state` exposes values (it reports presence).
7. Backend manager refuses legacy-secret access **before** handing out a cached backend, and invalidates cached state following protected secret changes. Public backend configuration fingerprints no longer incorporate raw credential field values.
8. Guarded Qdrant endpoint input/init against credential-bearing URLs. Milvus address init likewise rejects embedded credentials.
9. Replaced the legacy BananaBread clearing helper with contract-verified revocation and durable settings persistence acknowledgment. Browser UI warns when a settings save is queued rather than durably proven.
10. Added **47 C05-specific regression tests** covering missing capabilities, unacknowledged saves/revokes, bad auth receipts, unsafe fallback, migration rollback, URL credentials, nonexposure and source integration invariants.

## Explicitly NOT enabled

- No real Qdrant Cloud, authenticated Milvus or authenticated BananaBread secret-backed requests. The unmodified Similharity plugin has no user-scoped secret resolver.
- No automatic migration/clearing of legacy ordinary-settings values. Host persistence is debounced with no proven durable acknowledgment, and server-authenticated acceptance cannot be established with this plugin.
- No plaintext fallback, no browser secret read endpoint and no opt-in weakening of the contract.

## Follow-up before full C05 acceptance

Supply a compatible **server-side** plugin/host secret resolver; verify arbitrary protected key support, per-user path selection, and authenticated probe semantics. Add a durable settings transaction/readback to migrate legacy plaintext safely; perform live disposable-account tests for save, authenticated use, rotation, revocation, failure/recovery and multi-user isolation. With plugin modifications prohibited, these remain **blocked by design**.

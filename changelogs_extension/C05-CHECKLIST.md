# C05 — Requirement and issue checklist

| Requirement | Status | Evidence / reason |
|---|---|---|
| Preserve Step 6 source and test baseline | PASS | Cumulative suite; plugin unchanged |
| #221: no new plaintext Qdrant keys in extension settings | LOCAL PASS | C05 UI/defaults scrub; adapter rejects missing resolver |
| #221: no new plaintext Milvus passwords/tokens in extension settings | LOCAL PASS | C05 UI/defaults scrub; adapter rejects missing resolver |
| #124: no new BananaBread API key in ordinary settings | LOCAL PASS | UI save path no longer assigns plaintext |
| Plugin requests omit Qdrant/Milvus credentials | LOCAL PASS | Backend init JSON excludes API key/password/token |
| Plugin requests omit BananaBread credential | LOCAL PASS | Provider params/core/rerank no body key or browser Authorization |
| Browser protected-secret interface is write-only | LOCAL PASS | No `getSecret`; presence state is boolean-only |
| Strict application-level write, revoke and authenticated probe checks | LOCAL PASS | C05 mock fault tests |
| Endpoint rejects basic-auth/userinfo and secret query strings | LOCAL PASS | C05 checks and UI restriction |
| Unknown server capabilities fail closed without network writes | LOCAL PASS | Similharity resolver route absent |
| No blind fallback to unauthenticated embedding | LOCAL PASS | Backend manager and core query guards |
| Legacy values not silently lost when migration blocked | LOCAL PASS | Preserve settings until verified durable migration; explicit opt-in legacy-only removal available |
| Legacy **existing** settings/host backup secrets fully scrubbed | **BLOCKED** | No verified authenticated migration + host durability; old values remain in previously persisted settings/backups |
| Live server-side per-user secret resolution | **BLOCKED** | Supplied plugin reads credentials from browser bodies, not per-user protected storage |
| Real authenticated use after secure save | **BLOCKED** | Plugin lacks `/capabilities/secrets` and `/capabilities/secrets/test` contract |
| Proven secret clearing plus durable removal of legacy settings | **BLOCKED** | Host settings save acknowledgment unavailable; extension warns, does not claim proof |
| Safe ordinary-settings export/diagnostic masking | PRESERVED / LOCAL PASS | Existing Phase 0 recursive redactor; no new secrets written |
| No broad ST client secret exposure (`allowKeysExposure`) | REQUIRED DEPLOYMENT CHECK | Do not enable secret exposure; cannot inspect user's host configuration |
| Live per-user isolation and credential rotation | **BLOCKED** | Requires verified ST host/plugin + disposable server tests |
| I01–I18 regression | PASS | 199/199 |
| Phase 0 | PASS | 33/33 |
| C01 | PASS | 50/50 |
| C04/C06/C11-A/B | PASS | 24/24 + 31/31 |
| C03 | PASS | 38/38 |
| C07 foundations | PASS | 40/40 |
| C02 | PASS | 61/61 |
| Step 6 | PASS | 37/37 |
| New C05 | PASS | 47/47 |

**Verdict:** C05 browser-side security enforcement and tests delivered, but **not full C05 acceptance**. Authenticated Qdrant Cloud, Milvus and BananaBread workflows may be disabled until a compatible per-user server-side plugin and verifiable persistence exist. Preserve the C01/C02 destructive-operation blocks.

# VectHare / Similharity — P-A.1 (P01–P03 first implementation slice)

Date: 2026-10-30. Input baseline: matched M4e.1 ZIPs; full roadmap remains P01–P37 then M5–M9.

## Delivered code

- **P01, PARTIAL**: authenticated `GET /v2/embeddings/preflight` advertises server-managed profile identity, opaque revision, test state, remediation and explicit absence of source-bound collection certification; M1 saved-record UI checks it before preview/provision/apply. A missing profile cannot proceed to the managed collection action from that UI. Durable 24-hour `VERIFIED` evidence is recorded only after a successful bounded server-side model/dimension connection test, invalidated by any profile save. Other legacy entry points (normal Repair, Content Vectorizer, main Vectorize) **are not yet bridged** and P01 is not complete.
- **P02, PARTIAL**: `llama_cpp` OpenAI-compatible embeddings on exact, explicitly configured `http://127.0.0.1:PORT/v1/embeddings` server-loopback endpoint. No default port fallback, DNS destination, credentials, redirect or query string accepted. Exact profile model is sent, length and finite values are validated, and bad or unreachable endpoints fail without database mutation. Actual local HTTP endpoint integration test uses a disposable loopback fixture; **no actual installed llama.cpp server or Qdrant/LanceDB/Vectra/Milvus was contacted**. Ollama, KoboldCpp and vLLM-specific adapters are **not implemented**.
- **P03, CODE READY / AWAITING USER LIVE TEST**: authenticated user-scoped profile setup GUI now exposes active profile save, delete and separate test with explicit confirmation. The extension gateway allows exactly typed embedding configuration methods while ordinary vector write policy stays unchanged. Secrets are sent solely in the authenticated HTTPS/same-origin configuration request, are stored in server-owned private files, and are redacted from GET/status/diagnostics. Revisions and successful connection tests persist across reload. Ownership depends on the existing authenticated S03 user context. Credential authentication for remote providers requires manual validation.

## Execution evidence

- Similharity server/plugin suite: `node --experimental-vm-modules --test --test-concurrency=1 tests/*.test.mjs` — **850 tests passed, 0 failed** (includes 4 new P-A.1 local-provider tests).
- VectHare extension suite: `node --experimental-vm-modules --test --test-concurrency=1 tests/*.node.test.mjs` — **1,235 tests passed, 0 failed** (includes new P-A.1 gateway/GUI tests and updated M3 staged-flow assertions).
- Existing S10 source fingerprint manifest regenerated against the new package revision. Automated status is not a substitute for real hosted integration acceptance.

## No permissions / feature expansion implied

- **No change to the 70-cell baseline matrix**: 32 ENABLED / 33 BLOCKED / 5 UNSUPPORTED_BY_DESIGN. No new vector writes were enabled by this delivery; configuration changes are not vector mutation permissions.
- No auto-sync, Repair, generation-time retrieval, bulk 80+ batch handling, native Standard mutation or older-vector migration was enabled in P-A.1.
- Obsolete purge button untouched; existing dangerous routes remain denied.

## P01–P03 test instructions for user

1. Install both matched P-A.1 ZIPs. In VectHare settings open **Server-managed embeddings**.
2. Select `llama_cpp`, enter the server's exact embedding model, true embedding dimensions, cosine/dot/euclid metric, and the plugin machine's `http://127.0.0.1:<actual-port>/v1/embeddings` URL (for example port 8181); `127.0.0.1` refers to the host running the **Similharity plugin**, not a different device running a browser.
3. Save after confirmation, then click **Test server embedding (provider request)**. Expect `VECTOR_DIMENSION_VERIFIED` only when the provider actually replies with a conforming embedding. A failed connection or wrong dimensions must not mark the profile verified.
4. From the M1 saved-record UI run preview/provision on a disposable saved source. Backends still require valid S03 ownership/binding and applicable matrix permission. Confirm the managed UI presents a profile setup message instead of a Qdrant error when no profile exists.
5. Verify setting persists across restarting SillyTavern. If the profile changes, retest it before attempting M1 operations.

## Next development

P01 remaining manual Vectorize / Repair / Content entry points; P02 specific provider contract tests; P04 managed query+prompt, P05 true Repair, P06 safe batches beyond 80 records, and P19 diagnostic embedding bridge. Continue P-A before P-B. Do not claim all P01–P37 complete.

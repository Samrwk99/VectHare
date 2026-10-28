# S03 — Authorization & Isolation: Implementation Changelog

**Date:** 28 October 2026  
**Base:** S02 `3.2.2-s02.0`  
**New checkpoint:** S03 `3.2.3-s03.0`  
**Scope:** Similharity plugin only. VectHare extension unchanged.

## 1. Host-authenticated user boundary

- Added `lib/s03-security.js`. Non-health routes now require an authenticated `req.user` containing a stable `req.user.profile.handle` or string `req.user.id`, plus an existing absolute `req.user.directories.vectors` path. The path is resolved on the server; browser body/query cannot choose it.
- Missing/unrecognized host identity fails closed (`S03_HOST_IDENTITY_UNVERIFIED`). Browser-supplied conflicting user/owner/tenant claims are rejected (`S03_OWNER_CONFLICT`).
- A process-local root binding detects two host identities mapped to the same resolved vectors root. This is a safeguard, **not** cross-process isolation proof.
- Trust boundary: the plugin assumes SillyTavern mounted it behind genuine authentication/CSRF middleware. **This assumption must be checked live.** Client control over `req.user` has not been demonstrated or permitted by the code.

## 2. Per-user backend state

- Added `lib/s03-backends.js` with `BackendPool`, scoped per authenticated user, physical user root, backend type and fingerprint of server-side connection configuration. Concurrent same-context initialization shares a single promise; failed initialization is removed from the cache.
- Added non-singleton factory exports to Qdrant, Milvus and LanceDB adapters. Existing default singleton exports remain for compatibility with source-level tests and are **not** used by the active `index.js` routing path.
- Legacy `getBackendHandler()` now receives the request's scoped backend instance. The Qdrant/Milvus hybrid handlers also obtain a request-bound instance. `/backend/health/:backend` and `/backend/init/:backend` no longer read/modify one shared global remote backend.
- LanceDB initialization is now per authenticated user vectors root, including local collection scanning. LanceDB source-directory traversal and symlink escapes are refused. Process-local pool capacity is bounded; no multi-process or storage lock certification is claimed.

## 3. Administrator-only remote credentials

- Remote Qdrant/Milvus configuration is read from an **administrator-controlled path**, selected by the environment variable `SIMILHARITY_SERVER_CONFIG_DIR`. The plugin derives the user subdirectory from a SHA-256 hash of the authenticated user ID. Nothing in an HTTP request can change the root.
- Private directory mode `0700`, file mode `0600`, regular-file, no-symlink, size, schema and connection-address checks are performed. A missing configuration fails closed; no browser credentials or connection URLs are accepted by `/backend/init/:backend`.
- The plugin accepts only `configId: "default"` as a selector, **not** a client credential. Qdrant HTTP is permitted only on loopback; remote Qdrant requires HTTPS. Remote Milvus requires TLS. Credentials are never echoed in the new initialization/health responses.
- This is a server-file provisioning foundation, **not** a live-verified credential vault or final provider-support certification. TLS/network trust, actual host permissions and backend credentials still need integration tests.

## 4. Protected S02 registry lookup

- Added `POST /v2/identity/resolve`. The plugin supplies `scope.userScopeId` from authenticated host context; conflicting browser owner values are rejected.
- The endpoint computes the S02 canonical identity and searches the S02 registry **only under the authenticated user's vectors root**. It never reserves or activates mappings and returns `operational: false` and `writesEnabled: false`.
- Client `sourceId`, `collectionId` and `branchId` are still claims requiring host/backend ownership evidence. This endpoint **does not prove a physical collection belongs to the user**. Branch-fork detection remains an S11 VectHare/SillyTavern task.

## 5. Fail-closed legacy routes and reads

- Preserved the S01 mutation HTTP guard and S01 backend mutation denies.
- Added S03 read guard: legacy Qdrant/Milvus `/chunks/list`, point get, query, hybrid and stats return `S03_SHARED_LEGACY_READ_UNVERIFIED` instead of relying on unverifiable source/owner metadata. Authoritative shared-backend read contracts are deferred to S05.
- Removed implicit index creation on Vectra read and rejected ambiguous Vectra collection names/model paths that might alias existing storage.
- Disabled legacy caller-supplied `/rerank` endpoint and shell-based `/open-folder` route. Caller-supplied embedding URLs and credentials on the principal embedding and chunks routes are rejected. Host-managed embedding providers may still work where the underlying host implements them; full credential/endpoint audit remains pending.
- Removed all remote Qdrant/Milvus collection enumeration from the legacy `/collections` scan. Local read-only enumeration remains nonauthoritative. `/sources` hides private dot directories.

## 6. Test and packaging changes

- New `tests/s03-isolation.test.mjs` and `tests/s03-route.test.mjs`: host identity, owner spoofing, server config permissions and symlinks, configuration rotation, user/branch separation, concurrent pool initialization, sensitive route blocking and real plugin route registration using dependency stubs.
- Updated S01 VM test import declarations to account for S03 modules; the S01 and S02 invariants remain intact.
- New scripts: `npm run test:s03`, `npm run check:s03`.

## Explicitly not implemented

- No insertion, editing, reindexing, deletion, purge, physical migration or collection cutover.
- No server-attested proof of logical chat/branch source ownership; source-level isolation is **partial**.
- No production-ready claim, no live SillyTavern authentication confirmation, no actual Qdrant/Milvus/LanceDB multi-user integration tests.
- No unlocked backend capability cells. The strict read/credential gates can reduce compatibility until S04/S05/S11 work is completed.

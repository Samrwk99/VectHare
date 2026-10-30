# C05 — Server-side protected secret contract (not deployed)

This is a **proposed future interface**, not functionality present in the supplied plugin.

### Read-only resolver discovery

`GET /api/plugins/similharity/capabilities/secrets`

Expected JSON fields: `protocol: "vecthare-user-scoped-secrets-v1"`, `userScope: "request-user"`, `writeOnlyBrowser: true`, `serverSideResolution: true`, `authenticatedProbe: true`, `supportedKeys` listing `vecthare_qdrant_api_key`, `vecthare_milvus_password`, `vecthare_milvus_token`, `bananabread_api_key`.

This discovery endpoint contains no credential values. The server must authorize against the **current SillyTavern authenticated user**, using that user's protected secret directory; no global/shared secret fallbacks. Reject unauthenticated requests.

### Host write/delete/presence

`POST /api/secrets/write` with `{key,value}` only for a user-initiated write or revocation. The endpoint must explicitly accept custom key names, return a reliable success acknowledgement, and write to user-scoped protected storage. Revocation sends `value: ""`. `POST /api/secrets/read` must return boolean presence flags, never secret values. Browser code must not use `/api/secrets/view` or `findSecret`.

### Authenticated smoke-test receipt

`POST /api/plugins/similharity/capabilities/secrets/test` with `{key: serverSecretKey}` **and no secret value**. The plugin retrieves the credential from the current user's protected store, attempts a safe authenticated call to the configured backend/provider, and returns `{protocol, userScope: "request-user", key, authenticated: true}` only on verified success. No resource mutation; no echoed secret, URL userinfo, or raw upstream response body. Scope receipts to the correct backend endpoint/tenant and reject stale or cross-user results. This is NOT implemented in the supplied plugin.

### Backend init and embedding

Qdrant/Milvus init should accept non-secret connection settings and resolve credentials server-side; BananaBread embedding/rerank should be proxied by the plugin when authentication is required, with the plugin attaching the header server-side. Never accept a browser-provided `apiKey`, `password`, `token` or provider `Authorization` header as an implicit fallback. Host settings migration must use a verified durable save/readback transaction before deleting legacy plaintext and backups must be examined separately.

### Deployment acceptance

Pin exact SillyTavern and plugin versions; verify supported arbitrary keys, CSRF/authentication, per-user directories, endpoint/probe semantics, rotation and revocation across reload, loss of host connectivity, missing/severed secret, multiple users, and hostile error echo. All tests must use disposable users and credentials. Only enable C05 after this evidence is recorded.

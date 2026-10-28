# S03 — Administrator-Provisioned Backend Configuration

**Do not put actual secrets in the plugin ZIP or in VectHare settings.** This runbook documents the S03 interface; do not provision a production instance before real-host verification and backups.

1. Administrator sets `SIMILHARITY_SERVER_CONFIG_DIR` to an existing **absolute private server path**, outside web-served, user-controlled and vector-data directories. The root must have mode `0700` on supported POSIX systems.
2. The plugin obtains the user key from the SillyTavern-authenticated `req.user.profile.handle` (fallback: string `req.user.id`). Compute the per-user subfolder as lowercase hexadecimal `SHA256(UTF-8(user key))`. Do not accept a user key from a browser request.
3. Create `<private-root>/<sha256-user>/` with mode `0700` and `<private-root>/<sha256-user>/server-connections.json` with mode `0600`. Both must be regular non-symlink filesystem objects.
4. Example **without actual secrets**:

```json
{
  "schemaVersion": 1,
  "backends": {
    "qdrant": { "url": "https://qdrant.example.invalid", "apiKey": "<SERVER-SECRET>" },
    "milvus": { "address": "milvus.example.invalid:19530", "token": "<SERVER-SECRET>", "ssl": true }
  }
}
```

5. Qdrant accepts a direct HTTPS root URL, or HTTP only on loopback. Milvus requires `address` as host:port; non-loopback destinations require `ssl:true`. Configuration file changes generate a different connection-pool key. Restart the host after credential rotation when immediate revocation of any existing client connection is required.
6. HTTP clients may issue `/backend/init/qdrant` with `{}` or `{"configId":"default"}`, but **cannot** send `url`, `apiKey`, `host`, `address`, `token`, or other connection settings. This initialization is read-only in S03.
7. If the root is absent or unreadable, the plugin refuses remote access with an explicit configuration failure. This is intentional. The original client-supplied initialization model is not supported in this checkpoint.

**Limitations:** The exact SillyTavern user object, host router auth/CSRF integration, plugin environment inheritance, remote TLS connection behavior, user storage privileges, SDK compatibility and multi-process isolation have **not been verified on a live host**. Credentials may still need a future host-native protected store. This runbook is not evidence that remote provider support is production-ready.

# F09c.6 — Local Qdrant host acceptance runbook

## Safe default: passive read-only preflight

From the extracted Similharity plugin directory, run:

```bash
F09C6_QDRANT_URL=http://127.0.0.1:6333/ node tools/f09c6-qdrant-host-probe.mjs
```

This sends only `GET /`, checks Qdrant version 1.17+, and produces a non-authorizing JSON diagnostic. Set `F09C6_QDRANT_API_KEY` via the environment if needed; do not paste credentials into logs. The URL must use literal IPv4 loopback, plain HTTP, and an explicit port. No remote or production host may be targeted with this tool.

## Optional fresh disposable collection exercise

**Only on a disposable Qdrant deployment with no valuable data.** It creates a uniquely named `vh_f09c6_disposable_<random>` collection and updates only its synthetic points. Other collections are not selected or modified.

```bash
F09C6_QDRANT_URL=http://127.0.0.1:6333/ \
F09C6_MODE=disposable \
F09C6_CONSENT=I_ACCEPT_F09C6_DISPOSABLE_QDRANT_WRITES \
node tools/f09c6-qdrant-host-probe.mjs
```

The default is **no cleanup**. Record the exact generated collection name and inspect the outcome. For an additional separately consented cleanup of only that newly created collection, add:

```bash
F09C6_CLEANUP_CONSENT=DELETE_MY_F09C6_DISPOSABLE_COLLECTION
```

If any operation is uncertain, the tool stops and does **not** retry, re-create or clean up. Preserve the diagnostic output and investigate manually. An explicit cleanup response is checked with a 404 readback. Do not manually purge unrelated collections.

## Accepted concurrency model and remaining acceptance

The user's operational model is **cooperating writers only**: all participating VectHare mutators use the same trusted lock root and collection identity. External applications with backend write privileges can bypass that lock; the deployment makes no guarantee against them. The unsupported external-writer case is not a reason by itself to fail cooperating-writer scope acceptance.

Still required: confirm all relevant VectHare write routes actually use the lock, run real Qdrant insert/update/delete and two participating-process races, verify source/owner boundaries, handle reboot and pending-operation quarantine, and attach sanitized evidence. F10b owns disaster recovery and backups. Neither this diagnostic nor offline tests certify production writes.

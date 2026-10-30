# M0 handoff -> M1

The v2 plan is the authority. M0.1–M0.7 implementation foundation is in the paired project ZIPs.

## What M1 must integrate

1. Implement the trusted, server-side `plan -> explicit consent -> execute` entry point, rather than lifting the `/v2/mutations/execute` refusal or pointing it at `/chunks/*`.
2. Re-attest saved source and exact managed record; enforce S02 source-owner binding and F03 schema, immutable model profile, S04 durable receipt and anti-replay UUID, F09b.4 registry intent, F09c.10 lock, backend write, authoritative readback, registry commit. No browser-provided owner/text/vector/physical collection.
3. Wire M0 record schema v2 into persisted records and test source changes and tombstones. Existing F09b.3/4/6 pilot record formats differ.
4. Resolve per-operation capability prerequisites from real-host recorded evidence only, without accepting public capability override.
5. Run Qdrant live-host D7 spike and backend conformance; treat failures as BLOCKED/adjudication-only. Do not assume mock upsert proves safe recovery.
6. Server-admin remote connection and embedding credential storage must be read from a trusted config source; legacy saved browser connection precedence must not authorize production writes.
7. Add GUI insert/revectorize/exact delete actions and real-host acceptance; only then flip corresponding Qdrant operation cells, if proven.

## Important warnings

- M0 blocks earlier pilot write API and browser-side endpoint/embedding edits on purpose. Some prior debug/pilot actions will no longer work; read-only previews and standard read routes remain.
- `GET /v2/collections/:logicalKey/capabilities` currently refuses unbound lookup; M1 should implement source-attested binding before making scoped capabilities readable.
- Backups, collection deletion, model rebuild and broad batch mutation remain M2/M3 work.
- Keep existing S01 `/chunks/*` and S04 generic `/submit` `/reconcile` denials intact.
- Rebuild S10 plugin source manifest after any executable plugin source/version modifications.

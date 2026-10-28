# E05 — Disposable Standard/LanceDB acceptance runbook

## Prerequisites

Run **only** on an isolated, disposable SillyTavern installation and use an empty test profile. Do not run on valuable chats or vector data. The probe itself creates a unique `e05_probe_...` collection; it deletes only its own generated record and never purges a collection. It may leave that record if the server fails during a write or delete. Do not blindly retry; inspect and reconcile.

The CLI's network origin must be `http://localhost:<port>/`, `http://127.0.0.1:<port>/` or `http://[::1]:<port>/` with no URL credentials, query string or path. It refuses all remote targets. A deployment requiring browser authentication or CSRF tokens may fail with HTTP 401/403; **do not add cookie, token or credential forwarding to bypass this**. Use a safe locally authorized test procedure instead.

## Commands (Linux/macOS bash; from the unzipped `VectHare` directory)

```bash
VECTHARE_PROBE_DISPOSABLE=1 VECTHARE_PROBE_ORIGIN=http://127.0.0.1:8000 \
  node tools/e05-disposable-probe.mjs standard
VECTHARE_PROBE_DISPOSABLE=1 VECTHARE_PROBE_ORIGIN=http://127.0.0.1:8000 \
  node tools/e05-disposable-probe.mjs lancedb
```

Both write a uniquely named JSON evidence file into `e05-probe-results/`. A file with `PASS_SINGLE_RUN` is **not a production certificate** and does not activate any VectHare write capability. Restart the test server and run again; verify the installed plugin file hashes and actual SillyTavern revision separately. Keep the two JSON reports, log any altered test collections, and do not claim isolation across users without testing it.

## Evidence required before enabling operations

- Repeated insert/get/list/delete/absence verification survives a server restart.
- LanceDB duplicate-hash behavior, sanitized-name collisions, cross-user base-path behavior, exact readback vectors and metadata are understood and appropriately guarded.
- Full pagination (including >1,000 records), counts, empty-on-error and interruption recovery have been proven.
- Standard plugin (Vectra) and native Standard APIs are tested **separately**. The CLI tests *only* plugin Vectra and LanceDB routes.
- C02 journal persistence and Web Locks protect user-facing mutation flows; unsafe native fallback, unverified success echoes and unknown server versions remain denied.

## Next decision

Once these are collected, E05 acceptance may selectively unlock proven Standard/LanceDB operations. If source and live evidence do not show safe mutation semantics, keep them denied and record the exact plugin changes required rather than weakening the restrictions.

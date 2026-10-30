# VectHare M3v6 — Administrator terminal-lock quarantine

**Base:** M3v5 (`Similharity 3.2.10-m3.9`, `VectHare 2.2.0-alpha.m3.9`)
**Output:** `Similharity 3.2.10-m3.10`, `VectHare 2.2.0-alpha.m3.10`

## Shipped code

- Added `lib/m3-terminal-resolution.js` with an authenticated, **administrator-only**, server-evidence-bound forensic release path for a retained **logical lock of a durably COMMITTED owned Qdrant collection deletion**.
- Required immutable M3 operation and backup evidence, complete hash-chained `COMMITTED` lifecycle audit, deletion receipt, S02 `DELETED` tombstone, settled S04 ledger, absence of M2 job leases, fresh Qdrant GET→404, exact bound retained lock, and a verifiably non-running original owner PID.
- Requires a one-use explicit approval from administrator-controlled `SIMILHARITY_SERVER_CONFIG_DIR` matching a freshly computed proof fingerprint. HTTP carries **no** approval contents, physical name, owner, backend address, verdict or filesystem path.
- Quarantines the existing lock via same-filesystem rename, stores durable one-use intent and result receipts, preserves the forensic lock file, and never replays the physical delete. Failures after committing the intent retain an admin fence for investigation.
- Added administrator-only GET `/v2/m3/operations/:operationId/terminal-proof` and POST `/v2/m3/operations/:operationId/quarantine-terminal` and precise M0 route inventory classification.
- Added strictly typed extension request guards, client wrappers and advanced review controls; browser cannot submit an arbitrary unlock decision.
- Added three new plugin tests and one new extension test; updated source manifest.

## Deliberate scope limits

This only releases a **terminal, independently verified collection-deletion lock**. It **does not** adjudicate truly `DISPATCH_PENDING` / `UNCERTAIN` operations, does **not** repair incomplete restoration, and does **not** release locks with live or unverifiable PID. In particular it does not meet the matrix's general `uncertain-recovery` requirement and must not be used as a force-unlock facility.

M3.5 cross-model rebuild and repeat destructive lifecycle operations on previously published aliases are still incomplete and intentionally blocked. The eight previously enabled Qdrant matrix operations are unchanged, pending user manual testing.

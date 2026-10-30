# M3v7 — continuation from M3v6

Base: VectHare `2.2.0-alpha.m3.10` / Similharity `3.2.10-m3.10`.
New: VectHare `2.2.0-alpha.m3.11` / Similharity `3.2.10-m3.11`.

## Delivered

1. **Generation-aware production backup after a verified cutover:** M3 preview and logical backup now resolve the currently active Qdrant physical collection from the server-owned journal, immutable per-target receipt and fresh physical verification. Backups pin the observed generation and original canonical name, and recheck the active generation while holding the shared logical/physical mutation boundary. This fixes the previous inability to back up a restored or emptied generation.
2. **Safer preview classifications:** restore, owned deletion and scoped empty remain blocked *for already-switched generations* until repeat-lifecycle transactions exist. Backup remains available there. Canonical generation-zero collection operations retain prior readiness classifications.
3. **M3.5 new-model rebuild readiness:** new authenticated, read-only `POST /v2/m3/collections/rebuild/preview`. It accepts only a saved-source selector and server-issued backup UUID, requires a distinct server-configured current embedding profile, derives the target S02 identity server-side, checks the original full inventory, settled ledger, managed registry, source fingerprint and per-record saved-source provenance, and reports an exact bounded record count and remaining prerequisites. No browser vectors, text, endpoint, physical target, credentials or owner are accepted. The route cannot mutate collections.
4. **VectHare GUI:** rebuild-readiness button and clearer active-generation indicators. The request gateway includes a typed read-only allowlist for the new endpoint and tests reject forbidden fields.
5. **Fail-closed target evidence:** a published alias missing a target-specific receipt now produces a distinct refusal rather than proceeding via the canonical name.

## Not delivered / still blocked

- **Actual cross-model rebuild:** the system still has only one active embedding profile. A safe full implementation requires a server-managed staged second profile, bounded source re-embedding into a distinct new collection, exact schema/inventory/query checks, atomic profile+collection activation, and rollback. A simple same-key alias would mix incompatible embeddings.
- **Repeated destructive collection operations after cutover:** only backed-up reads and previews were added. Production restore/decommission/empty for generations >0 remain refused.
- **General ambiguous physical-operation resolution** remains refused; terminal-delete quarantine from M3v6 remains narrowly supported.
- No live-host/backend acceptance was available. Capabilities remain manual-test readiness, not externally verified.

**Matrix**: eight enabled Qdrant operation cells unchanged; 57 blocked; five unsupported by design. No status was flipped merely because code was added.

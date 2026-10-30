# P-B.4 automated verification

Source baseline: P-B.3. Node.js source tested with `--no-opt --experimental-vm-modules` for the extension and `--experimental-vm-modules` for the plugin; full Node suites run in bounded 12-file batches to avoid VM instability.

- Extension: **1,277** tests passed, zero assertions failed.
- Plugin: **879** tests passed, zero assertions failed.
- New P-B.4 tests exercise the imported M3 lifecycle contract with injected server responses, not live Qdrant endpoints.
- Plugin S10 build-integrity manifest recalculated for 115 runtime files and current version.
- Live host/provider/backend manual acceptance remains outstanding; no certification of destructive collection writes is implied.

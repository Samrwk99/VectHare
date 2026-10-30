# VectHare C01 verification record

Source ZIP: `VectHare-I18-Phase0-P09-Hotfix.zip`. Tests executed from extracted updated source via Node.js, without live SillyTavern or Similharity servers.

| Command | Expected result | Measured |
|---|---|---|
| `npm run test:repair` | Preserve I01–I18 | 199 passed, 0 failed |
| `npm run test:p0` | Preserve P0 including P0-9 hotfix | 33 passed, 0 failed |
| `npm run test:c01` | C01 inventory/deletion faults | 35 passed, 0 failed |
| `node --check` over JavaScript and `.mjs` source | Syntax clean | Passed |
| ZIP archive CRC integrity | Archive readable | Passed |

The C01 suite is **mock-backed**, not a live integration certification. Unverified capabilities remain `unknown`. No real backend was queried or purged. Pending deletion tombstones are exposed on startup, but actual replay and new purge commands are disabled until durable persistence and verified backend contracts exist. Live successful deletion is **not** a demonstrated behavior of this build. The code remains at the existing `2.2.0-alpha` manifest version; no silent settings schema migration was done.

The cumulative build ZIP, the baseline ZIP, and companion release notes have SHA-256 checksums in the separately supplied `VectHare-C01-SHA256SUMS.txt`.

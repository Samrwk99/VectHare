# F09c.5 — Verification

- Plugin full suite: **443/443 passed** in one run, `node --experimental-vm-modules --test --test-concurrency=2 tests/*.test.mjs`.
- F09c.5 suite contains **10 new tests** (the focused Node test command also imports 4 S04 fixture tests: **14/14 total**).
- Extension: **77 files and 1,169 assertions covered with passes across controlled partitions and independent retests**. The combined extension run ended with a Node `SIGSEGV` in `i17-emotion-cache` (1,162/1,163 recorded results); its 7 tests passed in isolation. In later ten partitions `c12-integration` and `i17-emotion-cache` workers failed at process level; their 7 + 7 tests passed separately. These are not clean combined-run results.
- JavaScript syntax: **365 `.js`/`.mjs` files checked**, without syntax errors.
- S10 executable source manifest regenerated; S11 extension expected plugin version and SHA-256 fingerprint match.
- ZIP package CRC/integrity checks and SHA-256 recorded in package manifest.

## Evidence scope

The new two-process test uses real Node processes and local OS filesystem locks; it does **not** exercise an actual vector database, backend-specific conflict detection, independent external writers with direct backend credentials, Termux, or privileged network restrictions. No full failure injection or recovery certification occurred. No production permission was activated.

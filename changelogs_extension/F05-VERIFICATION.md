# F05 verification report

**Plugin:** Similharity S10.9-F05. **Extension:** VectHare S11.10-F05.

- Plugin cumulative offline suite: **291 passed, 0 failed**, Node `--experimental-vm-modules --test tests/*.test.mjs`.
- Plugin new F05 route/engine tests: 5 tests passed (including an actual local TCP/HTTP fixture using the production Qdrant HTTP client; the HTTP fixture is **not** a live Qdrant installation).
- Extension new F05 and compatibility focused suite: **27 passed, 0 failed**.
- Extension isolated broad suite: 63 files; 62 files passed on their initial or retried run. The prior-known `c09-hybrid.node.test.mjs` crashed with `SIGSEGV` on first and second isolated attempts but then passed all 4 assertions in a standalone retry. Across those files, **1,111 assertions passed** after that retry. This is a test-runner stability limitation and should not be represented as a clean uninterrupted pass.
- Syntax checks: 63 plugin JS/MJS files and 229 extension JS/MJS files passed `node --check`.
- Plugin fingerprint build/extension pin: **PASSED** against freshly extracted matched ZIPs. Packaged plugin F05 tests: **5/5 passed**.
- Live Termux Qdrant acceptance: **NOT RUN**. Windows/Linux/Qdrant live acceptance: **NOT RUN**.
- Ordinary production insert, edit, delete, revectorization, automatic vectorization, verified full inventory/export and legacy migration: **DISABLED**.

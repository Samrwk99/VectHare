# C10 — Verification report

**Source baseline:** `VectHare-Step9-C09-Cumulative-Retrieval-Checkpoint.zip` (`e6647c66007dea86abe1f05ce1fa7b358c314f6e9748077798c262936608b209`)  
**Read-only reference plugin:** `VectHare-Similharity-Plugin.zip` (`51f74de9c7e57524cc3f1f881b03069805e654b162a8f5ccb77d012b0a2604a7`)

## Cumulative Node tests

| Suite | Passed |
|---|---:|
| I01–I18 regressions | 199/199 |
| Phase 0 | 33/33 |
| C01 | 50/50 |
| C04/C06/C11-A | 24/24 |
| C04/C06/C11-B | 31/31 |
| C03 | 38/38 |
| C07 | 40/40 |
| C02 operation safety | 50/50 |
| C02 integration | 11/11 |
| Step 6 completion | 35/35 |
| Step 6 cache | 2/2 |
| C05 | 47/47 |
| C08 | 44/44 |
| C09 hybrid | 4/4 |
| C09 pipeline | 3/3 |
| C09 retrieval | 40/40 |
| New C10 | 58/58 |
| **Total** | **709/709** |

- **Syntax check:** `node --check` on all **161** project JavaScript/ESM files: passed.
- All suites were independently executed with `node --test` (and `--experimental-vm-modules` when needed); log files saved in `/mnt/data/c10_final_*.log` in the build session.
- **Node worker instability:** An initial multi-file C09 run reported a SIGSEGV in `c09-hybrid`; a later single-file run also intermittently crashed. A successful isolated rerun passed all four assertions. This is a runner instability; not presented as fully diagnosed.
- No live SillyTavern host, completion request capture, or live Similharity server was tested. Host API availability is verified only from public SillyTavern docs/source/type references; event ordering and live behavior remain unverified.
- No uploaded plugin file was edited or bundled; SHA-256 reference above.

## C10 fault coverage

- Missing/invalid context size, tight budgets, cap/margin and shared multi-position token counting.
- Long text trimming without splitting emoji/surrogate pairs, wrapper overhead, exact frozen registration text, changing macros.
- Asynchronous/throwing tokenizer fallback and block oversize rejection.
- Registration-only, full/partial/missing event inclusion, text/chat payloads, malformed and dry-run events, expired/replayed receipt, chat switch and cancellation.
- Durable per-turn storage receipt, reload/duplicate/idempotency, storage readback failure, collection isolation and session clearing.

## Explicit unfinished work

- **C10 real-host acceptance:** confirm completion-style event timing, final request text, tokenizer counts, and history headroom with captures in a disposable SillyTavern environment.
- **C08 #88:** live frequency rules remain gated until real receipt coverage is proven; durable localStorage/sessionStorage receipt storage has not been cross-tab transaction-certified.
- Server/plugin security and deletion blockers from earlier stages are unchanged.

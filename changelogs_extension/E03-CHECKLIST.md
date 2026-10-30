# VectHare E03 — Completion Checklist

## Completed locally

- [x] Read and reuse existing C01/C02/C03 journal, lock and recovery implementations.
- [x] C02 journal create/update independently read back committed IndexedDB entries.
- [x] C02 list/get wait until transaction completion; invalid entries fail closed.
- [x] Production insert, targeted delete, C01 deletion and C02 replacements require Web Locks.
- [x] Qdrant and Milvus use shared physical backend lock names per browser origin.
- [x] Timeout and abort ordering tested without releasing active mutation locks prematurely.
- [x] Deferred C03 writes refused when pre-dispatch browser-local marker save/readback fails.
- [x] Host persistence API requires a real server acknowledgement and fresh read; absent means denied.
- [x] IndexedDB receipt helper detects dropped and changed writes; rejects secret-like fields.
- [x] Startup C01/C02/C03 recovery is consolidated without automatic mutations.
- [x] 27 new E03 tests passed.
- [x] Previous 910 tests exercised in partitioned suite; historical tests passed.
- [x] E01/E02/E03 static audits and JS syntax checks passed.
- [x] Similharity unchanged; E02 capability matrix unchanged.

## Not complete / requires a real host or later checkpoint

- [ ] Verify current stable SillyTavern server-save and fresh-read contract; wire host adapter only with proven semantics.
- [ ] Verify settings save/reload with server restart and two browsers/users.
- [ ] Run browser-based two-tab lock contention, crash, abort and reload tests.
- [ ] Observe journal consistency after real process termination (not just fake IDB transactions).
- [ ] Prove full scoped backend inventory and mutation outcomes (E05/E06).
- [ ] Confirm no other extension/server process writes around browser Web Locks.
- [ ] Run clean all-files VM suite without intermittent Node SIGSEGV; investigate runner/environment separately.
- [ ] Certify real-host user workflows (E07).

**E03 status:** extension-side persistence and recovery hardening implemented and locally tested. Host durability/real browser acceptance **not certified**. No capabilities unlocked.

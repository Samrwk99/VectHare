# VectHare dependency checkpoint verification

Source: cumulative C01 safety build. Environment: Node.js 22, no live SillyTavern or Similharity servers.

| Check | Result |
|---|---|
| I01–I18 (`node --experimental-vm-modules --test --test-concurrency=1 tests/i*.node.test.mjs`) | **199 passed, 0 failed** on rerun |
| Phase 0 (`tests/p0-*.node.test.mjs`) | **33 passed, 0 failed** |
| C01 (`tests/c01-*.node.test.mjs`) | **35 passed, 0 failed** |
| Dependency checkpoint (`tests/c04-c06-c11.node.test.mjs`) | **24 passed, 0 failed** |
| JS/MJS syntax | Pass |
| Packaging ZIP CRC | See external release manifest |

**Total: 291 locally passing tests across the four groups.** No live-server certification. The regression runner using experimental VM modules intermittently exited with signal SIGSEGV (observed in I17 and I08 workers, including against an unchanged baseline); subsequent full serial rerun passed. This residual runner-level instability is explicitly disclosed.

Important: mock `requireTenantScope()` stubs in pre-existing I04/I05 tests are **test-only** to exercise response handling. The 24 new tests run the real capability gate and assert zero requests for unverified operations. No setting flips capability flags to `verified` in this release.

No server-side destructive operations were executed. Settings/persistence durability remains unverified and live C01 deletion is disabled.

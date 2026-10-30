# P-A.4 — Automated verification evidence

Date 2026-10-30; Node.js v22.16.0. Script used: `node --experimental-vm-modules --test --test-concurrency=1` in 12-file batches, plus `--no-opt` for extension Node VM tests.

| Component | Files | Passing | Failing | Notes |
| --- | ---: | ---: | ---: | --- |
| Plugin | 99 | 867 | 0 | Nine bounded batches; final local source manifest matches package. |
| Extension Node suite | 88 | 1,245 | 0 | Eight bounded batches using `--no-opt` on this Node 22 runtime. |
| Total | 187 | 2,112 | 0 | Does not include live SillyTavern / physical backend. |

Earlier runs hit `SIGSEGV` in Node VM tests (`c09-hybrid`, sometimes `i17-emotion-cache`) without `--no-opt`; VM tests passed with the flag. Older M3/M4 fixture tests omitted the verification state and were fixed without weakening the runtime check. An unrelated writer-lock test's child process lifetime/exit handling was repaired, and it passes.

`*.test.js` Vitest files are not part of the 88-file Node suite. Vitest dependencies are not bundled in the ZIP/environment, so the separate Vitest suite was not rerun.

Source-manifest local fingerprint: `db854ef36df5a511988053b623889c49cf1e723d845f17e2a20b6bc7a74c51f1`. This is NOT host/dependency/live-backend attestation.

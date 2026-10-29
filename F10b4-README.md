# F10b.4 matched handover

Read `F10b4-RELEASE-DECISION.md` before deploying. The updated plugin provides a **private read-only recovery case builder** for scoped interrupted S04/managed-record/lock states; the extension is pinned to the exact plugin build. `F10b4-HOST-TEST-RUNBOOK.md` documents administrator CLI use on disposable data.

The implementation does **not** resolve uncertain database writes or release retained locks. Overall F10b remains OPEN and production mutation/restore remains denied.

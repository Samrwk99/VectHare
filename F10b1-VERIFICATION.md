# F10b.1 — Verification

- Similharity plugin `3.2.10-s10.36-f10b1`: **511/511** Node tests passed, clean combined suite.
- F10b.1 focused tests: **15/15** passed; they use disposable local filesystem fixtures, not a SillyTavern deployment or physical vector database.
- VectHare extension `2.2.0-alpha.s11.37-f10b1`: **1,169/1,169** assertions passed in a clean controlled (`--test-concurrency=2`) run. The initial unthrottled run experienced the previously seen Node `SIGSEGV` in `i17-emotion-cache`; it passed on retest and the final controlled full suite passed cleanly.
- JavaScript syntax: all **123 plugin** and **259 extension** `.js`/`.mjs` sources passed `node --check`.
- Plugin S10 fingerprint: `3ff893e22f41d99e7b9878a460eb45ccc5e406eb1ec579e8d0e4e6f6c4f27d0c`, **62 executable manifest files**; matched by the extension pin.
- No real Termux/SillyTavern or Qdrant/LanceDB/Vectra/Milvus data has been backed up or restored in this build environment.
- **Result:** F10b.1 offline control-plane rehearsal complete; F10b comprehensive backup/restore still OPEN; F09c host acceptance still OPEN; production NO GO.

# F09c.10 matched handover

VectHare `2.2.0-alpha.s11.36-f09c10` + Similharity `3.2.10-s10.35-f09c10`. Plugin SHA-256 source fingerprint `4e75319f79d32930b2d9d3f169011fab342b32c44a0a0ffd1db808248bb9e8cc`.

New: **automatic trusted collection lock for every normal S04 v2 mutation** plus **same lock around F03 collection provisioning**. Four backend mock routes, inter-process contention and forced crash tests pass locally. The design covers cooperating writers with one shared root only, as accepted by the user.

Plugin **496/496**, extension **1,169/1,169**, clean runs; JavaScript syntax clean. Actual physical backend testing **not executed**, production writes **DENIED**, F09c **OPEN**. Run F09c.6–F09c.9 disposable host tests and F09c.10 integrated real host acceptance before F09c.11 matrix decisions.

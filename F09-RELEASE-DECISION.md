# F09 release decision

**Status: PARTIAL F09 DEVELOPMENT CHECKPOINT — NOT A FULL-FUNCTIONALITY RELEASE.**

F09 adds authenticated source-scoped candidate preview and a GUI path for newly provisioned v2 memories on Qdrant, LanceDB, plugin Vectra and Milvus. Source/branch authorization and the F02 schema/read checks remain enforced. Stable v2 record IDs are preserved and no legacy hash-based record identity is fabricated.

All automatic memory creation, deletion, revectorization, summary and World Info mutation, full inventory/export, ordinary retrieval-to-final-prompt injection and legacy data conversion remain blocked or unimplemented. The new preview route deliberately returns `automaticInjectionEnabled:false` and `productionWritesEnabled:false`.

**Do not declare F09 finished or proceed directly to general production activation.** Complete the outstanding tasks in `F09-REMAINING-WORK.md`, then collect host/backend acceptance and proceed to F10–F12.

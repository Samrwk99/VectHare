# M0 Frozen v2 record and gateway contract

Baseline F10b.10. This is a **schema definition**, not an already migrated
Qdrant / Milvus / LanceDB / Vectra collection. `S04`'s legacy mutation plan has
`schemaVersion:4` (operation plan); the new persisted **record schema** has
`schemaVersion:2`. Those values refer to distinct objects.

- `recordId`: deterministic UUID-v8-style ID from server-attested
  `(userScopeId, sourceId, branchId, sourceEntryId)`, independent of record
  revision or text. The existing S02 physical ID mapping is preserved for v2
  S04 plans; no migration or rekeying is implicit.
- `identity`: `userScopeId`, `sourceId`, `branchId`, `sourceEntryId`.
- `source`: saved-source kind, exact saved-file fingerprint, saved=true,
  optional non-authoritative location. Never accepted from a browser.
- `revision`: positive explicit integer (not a backend-generated version).
  `contentHash`: sha256 of authoritative saved text.
- `embedding`: `source, model, dimension, metric, profileFingerprint`, all
  bound to server-side embedding profile and collection F03 receipt.
- `tombstone`: one of ACTIVE, WRITE_PENDING, DELETE_PENDING, DELETED;
  `deletedAt` and `operationId` explicit nullable fields.
- `links`: typed `{sourceRecordUUID,targetRecordUUID,relationship,scope,sourceRevision}`.
  Source UUID must match the containing record; foreign scopes refused.
- `conditions`: typed `{id,type,operator,value,enabled}`. Syntax is reserved,
  evaluation is not implemented until M6.
- `parent`: nullable `{recordId,sourceRevision}`.
- `summary`: nullable `{templateVersion,sourceSpanHash,approved,generationModel,parentRecordUUIDs}`.
- `lorebook`: nullable `{uid,triggers,conditions,enabled}`.
- `metadata`: bounded own object of non-identity user data (32KiB).

Legacy F09b.3/F09b.4/F09b.6 payload formats have **not** been rewritten to
this schema; they are disabled at the new public boundary. M1 must connect
saved-source extraction to this schema and version any physical record layout.

## Trusted gateway contract

`POST /v2/collections/:logicalKey/records/plan` accepts only a backend selector,
optional server-side config selector, typed saved-source selector, action, and
server-discoverable record UUID. The plugin independently checks F01/F02
source identity, S02 derived logical binding, F09b.5 embedding profile and F03
schema receipt. It returns **non-executable** plan metadata. No text, vectors,
physical names, owner identity, credentials, or filesystem paths in the request.

`POST /v2/mutations/execute` is deliberately REFUSED at M0. It must not
proxy to blocked generic S04 `/submit` or legacy `/chunks/*`. M1 must connect
one reviewed pipeline:

`S02 binding -> F03 verification -> S04 durable receipt -> managed registry
intent -> F09c.10 physical lock -> backend dispatch -> authoritative readback
-> managed registry commit`.

`GET /v2/m0/capabilities` lists 70 fail-closed backend/operation cells;
`GET /v2/collections/:logicalKey/capabilities` refuses until a source-bound
scoped retrieval is implemented. No public API accepts capability evidence or
an enable flag.

## M0 reference conformance and D7 hypothesis

The 12-method contract includes optional lifecycle methods as explicit
`M0_ADAPTER_OPERATION_NOT_CERTIFIED` refusal for the Qdrant reference wrapper.
Mock backend exercises write/conflict/fault/backup paths, but is not a
substitute for Qdrant on a disposable real server.

D7 spike observation on simulated Qdrant transport: S02 physical ID stable
across an update, explicit revision advances in persisted payload and a
successful readback observes goal state. **UNPROVEN** on a real Qdrant host:
atomicity/linearization across processes and race with unrelated writers.
Readback proves observed state, not necessarily which write produced it.
Production policy remains blocked until live proof; if it fails, only
adjudication (not automatic replay) is acceptable.

## D6 endpoint configuration

New gateway does not accept network addresses or credentials. M0 additionally
blocks browser-managed embedding profiles and legacy in-browser Qdrant/Milvus connection mutations in both extension
and plugin, retaining read-only connection inspection; administrator-configured
server connection files and Qdrant loopback selector remain the supported path.
Stored older GUI connection files can still be read by legacy BackendPool;
M1 must enforce admin-only precedence before enabling real mutations.

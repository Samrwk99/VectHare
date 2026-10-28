> **S02 identity checkpoint (28 October 2026): offline-only, not a write-enabled release.**  S02 introduces stable, scoped UUID identities, collision-resistant physical collection naming, a durable reservation registry, fail-closed ambiguous legacy names, and a read-only migration planner. No server-authoritative identity resolution exists yet; S03 must establish that before any new write route is opened. All S01 legacy mutation restrictions remain in force. Qualified legacy Qdrant and lossy LanceDB names can now be rejected pending explicit migration review. See `S02-CHANGELOG.md`, `S02-VERIFICATION.md`, and `S02-NEXT-STEPS.md`.

> **S01 safety checkpoint (28 October 2026): Not a production-ready or functional write release.**  All legacy plugin write/edit/delete/purge HTTP routes return `409 S01_MUTATION_BLOCKED` until later S02–S04 contracts are implemented and tested.  Qdrant/Milvus direct legacy mutations are disabled, read failures propagate, destructive mismatch handling is removed.  See `S01-CHANGELOG.md` and `S01-VERIFICATION.md`.  Do not replace a valuable working installation without reviewing the restrictions.

# Similharity Server Plugin

**Checkpoint version 3.2.2-s02.0** (historical installation guidance below may reference older upstream versions).

Server-side plugin for [the VectHare](https://github.com/Conejachibi/VectHare) extension that provides enhanced vector database backends and full metadata storage capabilities.

---

## Features

- **LanceDB Backend** - Disk-based vector storage with Apache Arrow format
- **Qdrant Backend** - High-performance vector search with multitenancy support
- **Enhanced Vectra** - Full metadata storage (bypasses ST's hash/text/index limitation)
- **Collection Browser** - List all collections across all backends
- **Folder Explorer** - Open collection folders directly from UI

---

## Installation

### Step 1: Enable Server Plugins

Add to your `config.yaml` (in SillyTavern root folder):

```yaml
enableServerPlugins: true
```

### Step 2: Install Plugin via Git (RECOMMENDED)

**This method enables automatic updates!**

Open a terminal/command prompt in your SillyTavern folder and run:

```bash
cd plugins
git clone -b Similharity-Plugin https://github.com/Coneja-Chibi/VectHare.git similharity
cd similharity
npm install
```

Your folder structure should now look like:
```
SillyTavern/
└── plugins/
    └── similharity/
        ├── .git/          <-- THIS IS IMPORTANT FOR AUTO-UPDATES
        ├── index.js
        ├── package.json
        ├── lancedb-backend.js
        ├── qdrant-backend.js
        └── README.md
```

### Step 3: Restart SillyTavern

Check console for:
```
[similharity] Initializing v3.0.0...
[similharity] Plugin initialized successfully
```

---

## Auto-Updates

**If you installed via `git clone` (Step 2 above)**, the plugin will automatically update every time you restart SillyTavern!

SillyTavern runs `git pull` on all plugin folders that are git repositories on startup. This is enabled by default.

### Verify Auto-Update is Working

1. Check that `.git` folder exists inside `plugins/similharity/`
2. On startup, look for this message in console:
   ```
   Auto-updating server plugins...
   ```

### If You Downloaded Manually (ZIP)

If you downloaded the plugin as a ZIP file instead of using `git clone`, auto-updates **will not work**. To fix this:

1. Delete the `plugins/similharity` folder
2. Follow Step 2 above to reinstall via git
3. Your settings and data are stored separately and won't be lost

### Disable Auto-Updates (Optional)

If you want to disable auto-updates, add to `config.yaml`:

```yaml
enableServerPluginsAutoUpdate: false
```

---

## API Endpoints

All endpoints are prefixed with `/api/plugins/similharity`

### Health Check

#### `GET /health`

Returns plugin status and capabilities.

**Response:**
```json
{
  "status": "ok",
  "plugin": "similharity",
  "version": "2.0.0",
  "features": [
    "vectra-full-metadata",
    "lancedb",
    "qdrant",
    "collection-browser",
    "folder-explorer"
  ]
}
```

---

## Collection Management

### List All Collections

#### `GET /collections`

Scans all vector backends (Standard/Vectra, LanceDB, Qdrant) and returns unified collection list.

**Response:**
```json
{
  "success": true,
  "count": 3,
  "collections": [
    {
      "id": "similharity_chat_Alice",
      "source": "transformers",
      "backend": "standard",
      "chunkCount": 150,
      "modelCount": 1
    },
    {
      "id": "similharity_lore_WorldInfo",
      "source": "lancedb",
      "backend": "lancedb",
      "chunkCount": 500,
      "modelCount": 1
    },
    {
      "id": "similharity_global",
      "source": "qdrant",
      "backend": "qdrant",
      "chunkCount": 1000,
      "modelCount": 1
    }
  ]
}
```

### Get Collection Info

#### `GET /collection/:id?source=transformers`

Returns detailed info about a specific collection.

**Parameters:**
- `id` (path) - Collection ID
- `source` (query) - Embedding source (default: `transformers`)

**Response:**
```json
{
  "success": true,
  "info": {
    "id": "similharity_chat_Alice",
    "source": "transformers",
    "exists": true,
    "models": [
      {
        "name": "Xenova_all-MiniLM-L6-v2",
        "size": 524288
      }
    ],
    "totalChunks": 150,
    "totalSize": 524288
  }
}
```

### List Embedding Sources

#### `GET /sources`

Lists all available embedding sources in the vectors directory.

**Response:**
```json
{
  "success": true,
  "count": 3,
  "sources": ["transformers", "openai", "palm"]
}
```

### Open Collection Folder

#### `POST /open-folder`

Opens the collection folder in file explorer (platform-specific).

**Request:**
```json
{
  "collectionId": "similharity_chat_Alice",
  "backend": "standard"
}
```

**Response:**
```json
{
  "success": true,
  "path": "C:/ST/data/vectors/transformers/similharity_chat_Alice"
}
```

**Note:** Qdrant collections have no local folder (remote storage).

---

## LanceDB Backend

### Initialize

#### `POST /lancedb/init`

Initializes LanceDB database connection.

**Response:**
```json
{
  "success": true,
  "message": "LanceDB initialized"
}
```

### Health Check

#### `GET /lancedb/health`

Checks LanceDB connection health.

**Response:**
```json
{
  "success": true,
  "healthy": true
}
```

### Insert Vectors

#### `POST /lancedb/insert`

Inserts vectors with full metadata into a collection.

**Request:**
```json
{
  "collectionId": "similharity_chat_Alice",
  "items": [
    {
      "hash": "abc123",
      "text": "We explored the ancient ruins together.",
      "index": 0,
      "vector": [0.1, 0.2, 0.3, ...],
      "name": "Ruins Exploration",
      "importance": 150,
      "keywords": ["ruins", "adventure"],
      "disabled": false
    }
  ]
}
```

**Response:**
```json
{
  "success": true,
  "inserted": 1
}
```

### Query Collection

#### `POST /lancedb/query`

Searches collection for similar vectors.

**Request:**
```json
{
  "collectionId": "similharity_chat_Alice",
  "queryVector": [0.1, 0.2, 0.3, ...],
  "topK": 10
}
```

**Response:**
```json
{
  "success": true,
  "results": [
    {
      "hash": "abc123",
      "text": "We explored the ancient ruins together.",
      "score": 0.92,
      "metadata": {
        "name": "Ruins Exploration",
        "importance": 150,
        "keywords": ["ruins", "adventure"]
      }
    }
  ]
}
```

### List Saved Hashes

#### `POST /lancedb/list`

Returns all hashes in collection.

**Request:**
```json
{
  "collectionId": "similharity_chat_Alice"
}
```

**Response:**
```json
{
  "success": true,
  "hashes": ["abc123", "def456", "ghi789"]
}
```

### Delete Vectors

#### `POST /lancedb/delete`

Deletes specific items by hash.

**Request:**
```json
{
  "collectionId": "similharity_chat_Alice",
  "hashes": ["abc123", "def456"]
}
```

**Response:**
```json
{
  "success": true,
  "deleted": 2
}
```

### Purge Collection

#### `POST /lancedb/purge`

Deletes entire collection.

**Request:**
```json
{
  "collectionId": "similharity_chat_Alice"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Collection similharity_chat_Alice purged"
}
```

### Purge All Collections

#### `POST /lancedb/purge-all`

Deletes ALL LanceDB collections. **Use with caution!**

**Response:**
```json
{
  "success": true,
  "message": "All collections purged"
}
```

### Get Collection Statistics

#### `GET /lancedb/stats/:collectionId`

Returns statistics for a collection.

**Response:**
```json
{
  "success": true,
  "stats": {
    "rowCount": 150,
    "sizeBytes": 1048576
  }
}
```

---

## Qdrant Backend

**Multitenancy Support:** Qdrant uses a single collection with payload filters to separate data from different sources (chat/character/global).

### Initialize

#### `POST /qdrant/init`

Connects to Qdrant server.

**Request:**
```json
{
  "url": "http://localhost:6333",
  "apiKey": "your-api-key"
}
```

**Alternative (host/port):**
```json
{
  "host": "localhost",
  "port": 6333,
  "apiKey": "your-api-key"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Qdrant initialized"
}
```

### Health Check

#### `GET /qdrant/health`

Checks Qdrant server health.

**Response:**
```json
{
  "healthy": true
}
```

### Insert Vectors (Multitenancy)

#### `POST /qdrant/insert`

Inserts vectors with tenant metadata for filtering.

**Request:**
```json
{
  "collectionId": "similharity_global",
  "items": [
    {
      "hash": "abc123",
      "text": "Ancient lore about dragons",
      "vector": [0.1, 0.2, 0.3, ...],
      "importance": 200,
      "keywords": ["dragon", "lore"]
    }
  ],
  "tenantMetadata": {
    "type": "chat",
    "sourceId": "alice_chat_001"
  }
}
```

**Response:**
```json
{
  "success": true,
  "inserted": 1
}
```

### Query Collection (Multitenancy)

#### `POST /qdrant/query`

Searches with payload filters for multitenancy.

**Request:**
```json
{
  "collectionId": "similharity_global",
  "queryVector": [0.1, 0.2, 0.3, ...],
  "topK": 10,
  "filters": {
    "type": "chat",
    "sourceId": "alice_chat_001",
    "minImportance": 100
  }
}
```

**Response:**
```json
{
  "success": true,
  "results": [
    {
      "hash": "abc123",
      "text": "Ancient lore about dragons",
      "score": 0.95,
      "metadata": {
        "importance": 200,
        "keywords": ["dragon", "lore"]
      }
    }
  ]
}
```

### List Hashes (Multitenancy)

#### `POST /qdrant/list`

Lists hashes with tenant filters.

**Request:**
```json
{
  "collectionId": "similharity_global",
  "filters": {
    "type": "chat",
    "sourceId": "alice_chat_001"
  }
}
```

**Response:**
```json
{
  "success": true,
  "hashes": ["abc123", "def456"]
}
```

### Delete Vectors

#### `POST /qdrant/delete`

Deletes specific items by hash.

**Request:**
```json
{
  "collectionId": "similharity_global",
  "hashes": ["abc123", "def456"]
}
```

**Response:**
```json
{
  "success": true,
  "deleted": 2
}
```

### Purge Collection (Multitenancy)

#### `POST /qdrant/purge`

Purges vectors matching tenant filters.

**Request:**
```json
{
  "collectionId": "similharity_global",
  "filters": {
    "type": "chat",
    "sourceId": "alice_chat_001"
  }
}
```

**Response:**
```json
{
  "success": true,
  "message": "Collection similharity_global purged"
}
```

### Purge All Collections

#### `POST /qdrant/purge-all`

Deletes ALL Qdrant collections. **Use with extreme caution!**

**Response:**
```json
{
  "success": true,
  "message": "All collections purged"
}
```

---

## Vectra (Standard Backend) - Enhanced

**Why Enhanced Vectra?**

SillyTavern's `/api/vector/insert` is hardcoded to only store `{hash, text, index}`. This plugin provides custom endpoints that store **full metadata** for chunk properties like importance, keywords, conditions, etc.

### Insert with Full Metadata

#### `POST /vectra/insert`

Stores ALL chunk metadata fields (not just hash/text/index).

**Request:**
```json
{
  "collectionId": "similharity_chat_Alice",
  "source": "transformers",
  "items": [
    {
      "hash": "abc123",
      "text": "We defeated the dragon in the mountains.",
      "index": 0,
      "name": "Dragon Battle",
      "importance": 150,
      "keywords": ["dragon", "combat", "victory"],
      "disabled": false,
      "customWeight": 1.5,
      "conditions": {
        "enabled": true,
        "rules": [
          { "type": "keyword", "operator": "contains", "value": "dragon" }
        ]
      },
      "chunkGroup": "Combat Scenes",
      "groupBoost": 1.2,
      "summaryVectors": ["Epic dragon fight"],
      "isSummaryChunk": false,
      "parentHash": null,
      "metadata": {
        "timestamp": 1234567890,
        "messageIndex": 42,
        "sceneTitle": "Mountain Battle"
      }
    }
  ]
}
```

**Response:**
```json
{
  "success": true,
  "inserted": 1
}
```

### List with Full Metadata

#### `POST /vectra/list`

Returns ALL items with complete metadata (not just hash/text/index).

**Request:**
```json
{
  "collectionId": "similharity_chat_Alice",
  "source": "transformers"
}
```

**Response:**
```json
[
  {
    "hash": "abc123",
    "text": "We defeated the dragon in the mountains.",
    "index": 0,
    "vector": [0.1, 0.2, 0.3, ...],
    "metadata": {
      "hash": "abc123",
      "text": "We defeated the dragon in the mountains.",
      "index": 0,
      "name": "Dragon Battle",
      "importance": 150,
      "keywords": ["dragon", "combat", "victory"],
      "disabled": false,
      "customWeight": 1.5,
      "conditions": {...},
      "chunkGroup": "Combat Scenes",
      "groupBoost": 1.2,
      "summaryVectors": ["Epic dragon fight"],
      "isSummaryChunk": false,
      "parentHash": null,
      "timestamp": 1234567890,
      "messageIndex": 42,
      "sceneTitle": "Mountain Battle"
    }
  }
]
```

### Query with Full Metadata

#### `POST /vectra/query`

Searches and returns results with ALL metadata.

**Request:**
```json
{
  "collectionId": "similharity_chat_Alice",
  "source": "transformers",
  "searchText": "dragon battle",
  "topK": 10,
  "threshold": 0.5
}
```

**Response:**
```json
[
  {
    "hash": "abc123",
    "text": "We defeated the dragon in the mountains.",
    "index": 0,
    "score": 0.92,
    "metadata": {
      "name": "Dragon Battle",
      "importance": 150,
      "keywords": ["dragon", "combat", "victory"],
      ...
    }
  }
]
```

---

## Embedding Utilities

### Query with Vectors

#### `POST /query-with-vectors`

Returns results **with embedding vectors** (for client-side similarity calculations).

**Request:**
```json
{
  "collectionId": "similharity_chat_Alice",
  "source": "transformers",
  "queryVector": [0.1, 0.2, 0.3, ...],
  "topK": 10,
  "threshold": 0.5
}
```

**Response:**
```json
[
  {
    "hash": "abc123",
    "text": "We defeated the dragon in the mountains.",
    "index": 0,
    "vector": [0.1, 0.2, 0.3, ...],
    "score": 0.92
  }
]
```

### List with Vectors

#### `POST /list-with-vectors`

Returns all items **with embedding vectors**.

**Request:**
```json
{
  "collectionId": "similharity_chat_Alice",
  "source": "transformers"
}
```

**Response:**
```json
[
  {
    "hash": "abc123",
    "text": "We defeated the dragon in the mountains.",
    "index": 0,
    "vector": [0.1, 0.2, 0.3, ...]
  }
]
```

### Get Embedding

#### `POST /get-embedding`

Generates embedding for a single text using configured provider.

**Request:**
```json
{
  "text": "dragon battle in the mountains",
  "source": "transformers",
  "model": "Xenova/all-MiniLM-L6-v2"
}
```

**Response:**
```json
{
  "success": true,
  "embedding": [0.1, 0.2, 0.3, ...]
}
```

### Batch Embeddings

#### `POST /batch-embeddings`

Generates embeddings for multiple texts.

**Request:**
```json
{
  "texts": [
    "dragon battle",
    "ancient ruins",
    "forest encounter"
  ],
  "source": "transformers",
  "model": "Xenova/all-MiniLM-L6-v2"
}
```

**Response:**
```json
{
  "success": true,
  "embeddings": [
    [0.1, 0.2, 0.3, ...],
    [0.4, 0.5, 0.6, ...],
    [0.7, 0.8, 0.9, ...]
  ]
}
```

---

## Supported Embedding Sources

The plugin supports all SillyTavern embedding providers:

- `transformers` - Local transformers.js models
- `openai` - OpenAI embeddings API
- `togetherai` - Together AI
- `mistral` - Mistral AI
- `nomicai` - Nomic AI
- `cohere` - Cohere embeddings
- `ollama` - Ollama local embeddings
- `llamacpp` - llama.cpp server
- `vllm` - vLLM server
- `palm` - Google PaLM API
- `vertexai` - Google Vertex AI
- `extras` - SillyTavern Extras

---

## Metadata Schema

Similharity stores rich metadata with each vector chunk:

### Core Fields (ST Compatibility)
- `hash` - Content hash
- `text` - Chunk text
- `index` - Chunk index

### Similharity Rich Metadata
- `name` - Custom chunk name
- `disabled` - Enable/disable chunk
- `importance` - Importance weighting (0-200%)
- `keywords` - Keyword array for boosting
- `customWeight` - Custom similarity weight multiplier

### Conditional Activation
- `conditions` - Rules for when chunk should activate
  - `enabled` - Enable/disable conditions
  - `rules` - Array of condition rules

### Dual-Vector
- `summaryVectors` - Summary text embeddings
- `isSummaryChunk` - Is this a summary chunk?
- `parentHash` - Parent chunk hash

### Chunk Groups
- `chunkGroup` - Group name
- `groupBoost` - Group similarity boost multiplier

### Temporal Data
- `timestamp` - Unix timestamp
- `messageIndex` - Message index in chat
- `sceneIndex` - Scene index
- `sceneTitle` - Scene title

---

## Error Handling

All endpoints return standard error responses:

```json
{
  "success": false,
  "error": "Error message here"
}
```

Or for simple errors:

```json
{
  "error": "Error message here"
}
```

---

## Security Note

This plugin provides direct access to vector databases. Only install if you trust the Similharity extension. Never expose plugin endpoints to untrusted clients.

---

## License

MIT

## Author

Coneja-Chibi

## Repository

[https://github.com/Conejachibi/VectHare](https://github.com/Conejachibi/VectHare)


## S03 authorization/isolation checkpoint (development only)

This checkpoint requires a host-authenticated SillyTavern `req.user` with `profile.handle` (or string `id`) and an existing user vectors directory on all non-health routes. Remote Qdrant/Milvus configuration is **administrator-only** via `SIMILHARITY_SERVER_CONFIG_DIR`, with no browser-supplied URL/API key/token. See `S03-SERVER-CONFIG-RUNBOOK.md`. A missing private configuration or unknown host identity refuses requests. The read-only `/v2/identity/resolve` response is **not** physical tenancy proof. S01 legacy mutations remain blocked, and S03 blocks legacy shared Qdrant/Milvus reads pending verified S05 ownership. No deployment, migration, write activation or live backend tests were conducted. Run `npm run test:s03` and `npm run check:s03` for offline tests.

## S04 guarded mutation foundation (2026-10-28)

The S04 checkpoint (`3.2.4-s04.0`) adds v2 **preflight validation**, an internal
on-disk operation ledger and a **mock-adapter-tested** insert/update/delete
coordinator. This is *not* an activated vector-write implementation. All S01
legacy mutation guards remain enabled, and public v2 `submit`/`reconcile`
endpoints return HTTP 409. No real backend adapter is attached to the S04
coordinator because host-authoritative source ownership, backend readback,
concurrency and schema acceptance remain outstanding. Do not deploy this build
as a replacement for a working production plugin without the appropriate
SillyTavern and backend compatibility testing.

Run `npm run test:s04` and `npm run check:s04` for cumulative offline checks.
See `S04-CHANGELOG.md`, `S04-VERIFICATION.md`, `S04-CAPABILITY-MATRIX.json`,
and `S04-NEXT-STEPS.md`. The authenticated preflight request validates a
proposed operation; it does **not** grant permission or store vector data.

## S05 checkpoint notice (3.2.5-s05.0)

S05 adds offline-tested **internal v2 scoped read adapters** for Qdrant/Milvus, strict record/embedding/inventory validation, and **preflight-only** HTTP read routes. They are not public active read routes. All S01 mutation blocks and S03 legacy shared-read restrictions remain in place. New schema/migration and source-ownership attestation are not completed. See `S05-CHANGELOG.md`, `S05-VERIFICATION.md` and `S05-NEXT-STEPS.md` before deploying this checkpoint.

## S06 cumulative checkpoint (developer test build)

S06 adds `lib/s06-qdrant.js`, a Qdrant v2 **internal disposable-test** adapter with schema inspection, full scope filters, controlled fixture writes and independent readback. **It does not reactivate public reads or writes.** The new API retains S01–S05 legacy route blocks; do not deploy over valuable data. See `S06-CHANGELOG.md`, `S06-VERIFICATION.md`, `S06-CAPABILITY-MATRIX.json`, and `S06-NEXT-STEPS.md`.

## S07 safety checkpoint (3.2.7-s07.0)

S07 adds an **internal, disposable-fixture-only** Milvus v2 adapter in
`lib/s07-milvus.js`, with strict physical-schema and vector-index inspection,
canonical UUID primary keys, complete scalar ownership fields, verified
query/get/list validation, a deliberately bounded offset-page contract, and
scope-qualified insert/upsert/delete with readback and conservative errors.
It is **not registered on the HTTP routes**, and it does not enable writes,
legacy migration, verified inventory/export, or automatic collection recreation.

The Milvus v2 schema uses explicit fixed columns, a VarChar `physicalId`
primary key with AutoID disabled, JSON metadata/embedding, a FloatVector field,
and scalar user/collection/source/branch/record identifiers. Provisioning is
restricted to an explicitly marked disposable fixture and refuses existing
collections. **Milvus upsert is not atomic revision CAS**; public updates and
writes stay denied until server-wide writer exclusion and live acceptance.

Use `npm run test:s07` and `npm run check:s07` for offline checks. Read
`S07-VERIFICATION.md` and `S07-NEXT-STEPS.md` before attempting integration.


## S08 checkpoint — local backend v2 adapters (offline only)

S08 adds internal LanceDB and plugin Vectra v2 adapters (`lib/s08-lancedb.js`, `lib/s08-vectra.js`), with canonical ownership, revision-aware disposable-fixture mutations, bounded read contracts, S04 ledger tests and no new public route activation. The native SillyTavern Standard API is separate. For safety restrictions see `S08-VERIFICATION.md` and `S08-NEXT-STEPS.md`.

## S09 — Migration / compatibility (offline only)

S09 introduces `lib/s09-manifest.js` for strict read-only legacy identity mapping, collision and dependency quarantine, and an integrity-checked manifest, plus `lib/s09-fixture.js` for an **isolated disposable local-file rehearsal** of snapshot backup, v2 row transformation, readback and staged rollback. It does **not** copy any real Qdrant, Milvus, LanceDB or Vectra collection, change server registry activation, authorize a cutover, or restore public mutation routes.

Run `node tools/s09-plan.mjs inventory.json` with an explicitly prepared local inventory. A valid manifest still contains `cutoverAllowed: false`: its owner mapping references are *unverified claims* until a trusted live host and independently verified backend inventory establish ownership and completeness. See `S09-MIGRATION-RUNBOOK.md` for limitations, mandatory proofs, and the disposable fixture procedure.

# 🐰 VectHare - Advanced RAG for SillyTavern

> *It's like having a perfect memory for your roleplay conversations.* VectHare brings intelligent context retrieval to SillyTavern with temporal decay, conditional activation, and multiple vector backends.

![Version](https://img.shields.io/badge/version-4.0.0-blue) ![License](https://img.shields.io/badge/license-MIT-green) ![Status](https://img.shields.io/badge/status-Active-brightgreen)

---

This is forked from Coneja-Chibi/Vecthare since it is missing fixes.

## 🎯 What is VectHare?

VectHare is an **advanced Retrieval-Augmented Generation (RAG) system** for SillyTavern that transforms how your AI characters recall and use past events. Instead of traditional memory tokens, VectHare vectorizes your chat history and intelligently retrieves relevant context when generating responses.

### The Problem It Solves

- 😩 Your character forgets important story details from 50 messages ago
- 💸 Long conversations choke your token budget with irrelevant history
- ✍️ You manually edit context to remind characters of key events
- 🤖 Character memories aren't flexible or intelligent

**VectHare's Solution:** Automatically extract relevant memories from your entire chat history using semantic search, with smart temporal decay that lets older memories fade naturally, and conditional rules to control exactly when memories activate.

---

## ✨ Key Features

### 🧠 Intelligent Context Retrieval
- **Semantic search** through your entire chat history
- Find relevant messages even from hundreds of messages ago
- Replace manual memory management with automatic retrieval
- Works with any embedding model (local or cloud-based)

### ⏰ Temporal Decay System
- **Memories naturally fade** over time, just like humans
- Exponential or linear decay modes
- Set custom half-life for how quickly memories decay
- Protect important scenes from fading (temporally blind)
- Optional feature—disable if you want permanent memory

### 🎭 Conditional Activation Rules
- Activate memory chunks based on **character emotions** (happy, sad, angry, etc.)
- Trigger on **conversation topics** or keywords
- Smart recency checks (activate only for recent events)
- Character Expressions integration for sprite-based emotion detection
- Fallback to keyword-based emotions if no expressions extension

### 🎬 Scene Management
- **Mark scenes** in your chat to group related messages
- Scene chunks are treated as single units for retrieval
- Perfect for story arcs, major events, or important character moments

### 📦 Multiple Vector Backends
- **Standard (Vectra)**: ST's built-in file-based storage (great for getting started)
- **LanceDB**: Disk-based, handles millions of vectors, production-ready
- **Qdrant**: Enterprise-grade with HNSW indexing, cloud support, advanced filtering
- **Milvus**: Scalable vector database server

### 📄 Multi-Content Vectorization
- Chat conversations (with automatic chunking strategies)
- Lorebook entries (preserve structure with per-entry chunks)
- Character definitions and personality
- Custom content types

### 🔍 Advanced Chunking Strategies
- **Per Message**: Each message = one chunk (best for chat recall)
- **Conversation Turns**: Group by speaker turns
- **Message Batch**: Process in configurable batches
- **Per Scene**: Scene-marked groups become chunks

### 🗃️ Database Browser
- Browse all vector collections (chat, lorebook, character)
- View chunk counts and metadata
- Enable/disable collections on the fly
- Export and import collections for backup/sharing

### 🔎 Chunk Visualizer
- View all chunks in a collection
- Edit chunk text and metadata
- Mark chunks as temporally blind (immune to decay)
- Search and filter chunks

### 🚨 Comprehensive Diagnostics
Built-in diagnostic tool that checks everything and offers auto-fixes for common issues.

---

## 🚀 How It Works

### The RAG Pipeline

```
┌─────────────────────────────────────────────────────────────┐
│  1. VECTORIZATION                                           │
│  ─────────────────                                          │
│  Chat messages are chunked and embedded into vectors        │
│  Each chunk stores: text, metadata, keywords, source        │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│  2. SEARCH & RETRIEVAL                                      │
│  ──────────────────────                                     │
│  When generating a response, recent messages are queried    │
│  against the vector database to find semantically similar   │
│  chunks from your chat history                              │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│  3. FILTERING & SCORING                                     │
│  ─────────────────────                                      │
│  • Apply temporal decay (older = lower score)               │
│  • Evaluate conditional activation rules                    │
│  • Boost by keywords                                        │
│  • Re-rank by relevance                                     │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│  4. CONTEXT INJECTION                                       │
│  ───────────────────                                        │
│  Top-scoring chunks are formatted and injected into the     │
│  prompt before generation                                   │
└─────────────────────────────────────────────────────────────┘
```

---

## 🗄️ Backend Comparison

| Backend | Best For | Pros | Cons |
|---------|----------|------|------|
| **Standard (Vectra)** | Getting started, small datasets | No database server needed, works out of box | Slower with large datasets |
| **LanceDB** | Medium to large datasets | Handles millions of vectors, very fast | Requires Similharity plugin |
| **Qdrant** | Production, cloud deployments | Enterprise-grade, advanced filtering | Requires a running Qdrant server, version 1.15 or newer |
| **Milvus** | Large deployments | Scalable, server-based | Requires a running Milvus server, version 2.2.9 or newer |

> 💡 **Need help choosing?** Start with Standard. Upgrade to LanceDB when you have 10k+ vectors.

---

## ⏳ Temporal Decay System

Memories don't stick around forever. VectHare implements intelligent temporal decay that makes memories naturally fade over time.

### How It Works

**Exponential Decay** (default):
```
relevance = original_score × (0.5 ^ (message_age / half_life))
```

For example, with half-life = 50:
| Messages Ago | Relevance |
|--------------|-----------|
| 0 | 100% |
| 50 | 50% |
| 100 | 25% |
| 150 | 12.5% |

### Configuration Options
Temporal weighting is set **per collection** (Database Browser → collection settings); the settings panel sets the default for new collections.
- **Enabled**: Toggle decay on/off (default: OFF)
- **Type**: Decay (favour recent) or Nostalgia (favour older memories)
- **Mode**: Exponential or Linear
- **Half-life**: Messages until 50% relevance (default: 50)
- **Floor**: Minimum relevance, prevents complete forgetting (default: 0.3)
- **Temporally Blind**: Mark important chunks to be immune to decay

> 💡 **Pro Tip:** Set a high floor (0.5+) to keep important memories accessible even when old. Mark character introductions as temporally blind!

---

## 🎭 Conditional Activation Rules

Control precisely **when** chunks activate using intelligent rules.

### Rule Types

| Type | Description | Example |
|------|-------------|---------|
| 🎬 **Emotion** | Activate when character feels specific emotion | Activate sad memories when character is sad |
| 🔑 **Keyword** | Activate when keywords appear in chat | Activate "treasure" memories when discussing treasure |
| 📍 **Recency** | Activate only for recent messages | Only use memories from last 10 messages |
| 🎯 **Combined** | Mix multiple conditions with AND/OR | Emotion=happy AND keyword contains "party" |

Supports 28 emotion types with Character Expressions integration!

---

## 💾 Installation

### Step 1: Install the Extension

1. Open SillyTavern in your browser
2. Go to **Extensions** panel (puzzle piece icon)
3. Click **"Install Extension"**
4. Paste this URL:
   ```
    https://github.com/Dogoo9/VectHare
   ```
5. Click **Install**

That's it! VectHare will be downloaded and enabled automatically.

### Step 2: Configure Embedding Provider
1. Open **VectHare Settings** (🐰 icon in the extensions panel)
2. Select your embedding provider (Transformers, OpenAI, Ollama, BananaBread, etc.)
3. Configure API keys if using cloud providers

### Step 3: Install the Similharity Plugin

**Needed for Qdrant, LanceDB and Milvus, and for full Standard (Vectra) support.**

Install the plugin with the **same version number** as VectHare. The health panel shows both versions and whether they work together; a mismatch also shows a warning when SillyTavern loads.

```bash
cd SillyTavern/plugins
git clone https://github.com/Samrwk99/Similharity-VectHare-Plugin.git similharity
cd similharity
npm install
```

Add to `config.yaml`:
```yaml
enableServerPlugins: true
```

Restart SillyTavern.

---

## 🔄 Auto-Updates

This fork ships with `auto_update: false` in its manifest, so SillyTavern will not replace it with the upstream VectHare on an extension update (which would silently remove this fork's fixes). Update it by replacing the extension folder yourself.

---

## ⚙️ Settings Overview

### 🎛️ Core Settings
| Setting | Description |
|---------|-------------|
| **Vector Backend** | Standard, LanceDB, Qdrant, or Milvus |
| **Embedding Provider** | 15+ providers supported |
| **API URL** | Custom endpoint for local providers |

### 💬 Chat Vectorization
| Setting | Description |
|---------|-------------|
| **Enable Auto-Sync** | Add new messages of this chat to its memories as you go (per chat) |
| **Score Threshold** | Memories scoring below this are not recalled (0.0-1.0) |
| **Query Depth** | How many recent messages are used to search for memories |
| **Top K** | Most memories recalled per message, across all collections |
| **Skip Memories Already in Context** | Don't recall this chat's messages that are still in the prompt (below SillyTavern's orange dashed line). Other collections are not affected. The panel shows where the line is (on by default) |
| **Dedup Depth** | Skip memories that repeat one of the last N messages. Only used with the option above off |
| **Injection Depth** | For In-Chat @ Depth: how many messages from the end. If that is above the orange line, memories are moved just below it so they aren't cut |
| **Place Memories at the Top of the Context** | Insert in-chat memories just below the orange line (off by default) |
| **Apply "Alter Outgoing Prompt" Regex to Memories** | Runs your prompt regex scripts on recalled chat and lorebook memories (on by default) |

### 🆕 New Collection Defaults
Starting settings when you vectorize something new; you can change them each time, and existing collections keep their own.
| Setting | Description |
|---------|-------------|
| **Chunking Strategy (chats)** | Per Message, Conversation Turns (with pairing order) or Message Batch (with batch size) |
| **Text Cleaning** | Preset, or Custom patterns from the Text Cleaning manager |
| **Keyword Extraction** | Off / Minimal / Balanced / Aggressive, and the keyword weight |
| **Temporal Weighting** | Off, Decay or Nostalgia |

### ⏰ Temporal Decay (per collection)
| Setting | Description |
|---------|-------------|
| **Enabled** | Toggle decay or nostalgia for the collection |
| **Type** | Decay (recent first) or Nostalgia (older first) |
| **Mode** | Exponential or Linear |
| **Half-life** | Messages until 50% relevance |
| **Floor** | Minimum relevance multiplier |

---

## 🎯 Pro Tips & Best Practices

### 🧠 Memory Quality
- **Per Message chunks work best** for dialogue-heavy chats
- **Mark scenes for major events** to keep them cohesive
- **Set temporally blind on character intros** so your AI never forgets who people are

### 🚀 Performance
- **Start with Standard backend** - upgrade to LanceDB when needed
- **Large chats (10k+ messages)?** LanceDB handles it smoothly
- **Lower score threshold** if memories aren't being retrieved (try 0.3)

### 🎭 Conditional Activation
- **Pair emotions with Character Expressions** for sprite-based detection
- **Add topic keywords** to make memories context-aware
- **Use recency rules** for time-sensitive information

### 💾 Data Management
- **Export collections regularly** as backups
- **Run diagnostics** if something feels off
- **Check the Database Browser** to see what's actually stored

---

## 🐛 Troubleshooting

### "No embeddings available"
1. Select embedding provider in VectHare settings
2. Add API key if using cloud provider
3. Run Diagnostics to verify connectivity

### Chunks not being retrieved
1. Click "Vectorize" button to index current chat
2. Lower score threshold (try 0.3)
3. Check Chunk Visualizer to verify chunks exist
4. Run Diagnostics for detailed health check

### "Backend health check failed"
1. Run Diagnostics to see which backend failed
2. **LanceDB**: Ensure Similharity plugin is installed
3. **Qdrant / Milvus**: Ensure the server is running and reachable
4. **Fallback**: Switch to Standard backend

### Slow performance
1. Switch to LanceDB backend for large datasets
2. Increase chunk size (fewer, larger chunks)
3. Reduce query depth and insert count

### Memory forgetting important details
1. Mark important chunks as **temporally blind**
2. Increase the decay floor value
3. Lower score threshold
4. Add conditional activation rules for topic-specific recall

---

## 🔗 Requirements

### Required
- **SillyTavern** (latest version)
- **Embedding Provider** (one of 15+ supported)
- **Similharity Plugin** (same version as VectHare) - Needed for Qdrant, LanceDB and Milvus, and for full Standard support

### Optional
- **Character Expressions** - For sprite-based emotion detection

---

## 🤝 Contributing

Found a bug? Have an idea? Contributions welcome!

- 🐛 **Issues**: Report bugs on GitHub
- 💡 **Features**: Open a discussion first
- 🔧 **PRs**: Follow the existing code style

---

## 📜 License

MIT License - See LICENSE file for details.

---

## 🙏 Credits

**VectHare** created with 💜 by **Coneja Chibi**

Special thanks to the SillyTavern community for feedback and testing!

---

## 🌟 Support

If VectHare helps your roleplay:
- ⭐ Star the repo on GitHub
- 💬 Share your experience
- 🐛 Report bugs to help improve it
- 📚 Contribute docs or examples

---

*"It's like having a memory that actually works."* 🐰✨

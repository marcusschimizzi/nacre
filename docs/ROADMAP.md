# Nacre — Roadmap

> From personal memory graph to Memory-as-a-Service.

Last updated: 2026-02-03

---

## Where We Are Today

**What exists and works:**
- Core graph engine — CRUD, typed nodes/edges, Ebbinghaus decay math, entity resolution (Levenshtein fuzzy matching), query engine
- Parser pipeline — file discovery (SHA-256 hashing), markdown→AST (unified/remark), triple extraction (structural + NLP + custom rules), merge pipeline with co-occurrence thresholds
- Intelligence layer — connection suggestions, labeled clusters, significance analysis (emerging/anchors/fading), structural hole detection
- CLI — consolidate, query, brief, alerts, insights, suggest, serve
- Visualization — 3D force graph, Three.js, custom nacre iridescent GLSL shader, time scrub, search, cluster zoom, node details
- 85 passing tests
- Clawdbot skill integration (consolidate runs during heartbeats)

**What it can't do yet:**
- No semantic/vector search (embeddings)
- No API (CLI only)
- No MCP server
- No SDK
- Graph stored as JSON (won't scale)
- No episodic or procedural memory types (only semantic graph)
- No conversation ingestion (markdown files only)
- No multi-graph / multi-tenant
- Viz requires WebGL (doesn't work in headless/sandbox environments)

---

## Milestone Map

Each milestone has a clear deliverable, a demo moment, and estimated scope. Dependencies are explicit.

```
                        ┌─────────────┐
                        │   M0: Repo  │
                        │   Cleanup   │
                        └──────┬──────┘
                               │
                        ┌──────▼──────┐
                        │ M1: SQLite  │
                        │  Migration  │
                        └──────┬──────┘
                               │
                ┌──────────────┼──────────────┐
                │              │              │
         ┌──────▼──────┐ ┌────▼─────┐  ┌─────▼──────┐
         │ M2: Embed-  │ │ M3: API  │  │ M4: Episod │
         │ dings Layer │ │  Server  │  │ ic Memory  │
         └──────┬──────┘ └────┬─────┘  └─────┬──────┘
                │             │              │
                └──────┬──────┘              │
                       │                     │
                ┌──────▼──────┐              │
                │  M5: Hybrid │              │
                │   Recall    │              │
                └──────┬──────┘              │
                       │                     │
                ┌──────▼──────┐              │
                │ M6: MCP     │              │
                │  Server     │◄─────────────┘
                └──────┬──────┘
                       │
          ┌────────────┼────────────┐
          │            │            │
   ┌──────▼────┐ ┌────▼─────┐ ┌───▼────────┐
   │ M7: TS    │ │ M8: Proc │ │ M9: Conv   │
   │ SDK       │ │ Memory   │ │ Ingester   │
   └──────┬────┘ └────┬─────┘ └───┬────────┘
          │           │           │
          └─────┬─────┘           │
                │                 │
         ┌──────▼──────┐         │
         │  M10: Viz   │◄────────┘
         │  Dashboard  │
         └──────┬──────┘
                │
         ┌──────▼──────┐
         │  M11: Docs  │
         │  & Launch   │
         └─────────────┘
```

---

## M0: Repo Cleanup & Open-Source Prep
*Get the house in order before building on it*

**Depends on:** nothing
**Scope:** small (1-2 days)

- [ ] Choose license (recommendation: Apache 2.0 — enterprise-friendly, patent grant, permissive)
- [ ] Add LICENSE, CONTRIBUTING.md, CODE_OF_CONDUCT.md
- [ ] Clean up package.json metadata (description, keywords, repository, homepage)
- [ ] Add proper .gitignore (cover data/, graphs/, *.db)
- [ ] README.md rewrite — positioning, quick start, architecture overview
- [ ] Remove any personal/internal references (Lobstar-specific entity maps, workspace paths)
- [ ] Ensure all tests pass in clean checkout
- [ ] CI: GitHub Actions for test + lint on PR

**Demo:** Clean repo that someone could clone and understand in 5 minutes.

---

## M1: SQLite Migration
*Solid foundation for everything that follows*

**Depends on:** M0
**Scope:** medium (3-5 days)

The current JSON file store works for ~100 nodes but won't scale and can't support concurrent access, indexing, or vector extensions. SQLite is the natural choice — single file, portable, battle-tested, local-first.

### Schema

```sql
-- Core graph
CREATE TABLE nodes (
  id          TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  type        TEXT NOT NULL,          -- person, project, tool, concept, ...
  aliases     TEXT,                   -- JSON array
  first_seen  TEXT NOT NULL,          -- ISO date
  last_reinforced TEXT NOT NULL,
  mention_count   INTEGER DEFAULT 1,
  reinforcement_count INTEGER DEFAULT 0,
  source_files    TEXT,               -- JSON array
  excerpts        TEXT,               -- JSON array of {file, text, date}
  metadata        TEXT                -- JSON blob for extensibility
);

CREATE TABLE edges (
  id          TEXT PRIMARY KEY,       -- source--target--type
  source      TEXT NOT NULL REFERENCES nodes(id),
  target      TEXT NOT NULL REFERENCES nodes(id),
  type        TEXT NOT NULL,          -- explicit, co-occurrence, temporal, causal
  directed    INTEGER DEFAULT 0,
  weight      REAL NOT NULL,
  base_weight REAL NOT NULL,
  stability   REAL DEFAULT 1.0,
  reinforcement_count INTEGER DEFAULT 0,
  first_formed    TEXT NOT NULL,
  last_reinforced TEXT NOT NULL,
  evidence    TEXT,                   -- JSON array
  UNIQUE(source, target, type)
);

-- Indexing
CREATE INDEX idx_nodes_type ON nodes(type);
CREATE INDEX idx_nodes_label ON nodes(label);
CREATE INDEX idx_edges_source ON edges(source);
CREATE INDEX idx_edges_target ON edges(target);
CREATE INDEX idx_edges_type ON edges(type);

-- File tracking (existing hash-based change detection)
CREATE TABLE processed_files (
  path        TEXT PRIMARY KEY,
  hash        TEXT NOT NULL,          -- SHA-256
  processed_at TEXT NOT NULL,
  node_count  INTEGER,
  edge_count  INTEGER
);

-- Graph metadata
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
```

### Tasks

- [ ] Create `@nacre/store` package (or add to core) with SQLite backend
- [ ] Implement graph CRUD operations against SQLite (matching current `graph.ts` interface)
- [ ] JSON → SQLite migration script (import existing graphs)
- [ ] SQLite → JSON export (for portability, viz consumption, backwards compat)
- [ ] Update all core functions to use new store
- [ ] Update CLI commands
- [ ] Update tests (swap fixture loading)
- [ ] Benchmark: insert 10k nodes, query patterns, compare to JSON
- [ ] Update viz loader to read from JSON export (viz stays static-file based for now)

**Demo:** `nacre consolidate` runs against SQLite. `nacre query marcus` returns results from SQLite. Existing graphs import cleanly. Performance noticeably better for larger graphs.

---

## M2: Embedding Layer
*Semantic search capability*

**Depends on:** M1 (SQLite needed for sqlite-vec)
**Scope:** medium (3-5 days)

### Architecture

```typescript
// Provider interface — pluggable embedding backends
interface EmbeddingProvider {
  readonly dimensions: number;
  readonly name: string;
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
}

// Implementations
class OnnxEmbedder implements EmbeddingProvider { ... }     // local, default
class OllamaEmbedder implements EmbeddingProvider { ... }   // local, better quality
class OpenAIEmbedder implements EmbeddingProvider { ... }   // cloud, best quality
```

### Storage (sqlite-vec)

```sql
-- Vector table alongside graph tables in same DB
CREATE VIRTUAL TABLE embeddings USING vec0(
  id        TEXT PRIMARY KEY,
  type      TEXT,                    -- 'node', 'episode', 'procedure'
  embedding FLOAT[384]              -- dimension matches provider
);

-- Similarity search
SELECT id, vec_distance_cosine(embedding, ?) AS distance
FROM embeddings
WHERE type = 'node'
ORDER BY distance ASC
LIMIT 20;
```

### Tasks

- [ ] `EmbeddingProvider` interface definition
- [ ] ONNX provider (all-MiniLM-L6-v2, ~80MB, runs locally, no deps)
- [ ] Ollama provider (nomic-embed-text or similar — for users who have Ollama)
- [ ] OpenAI provider (text-embedding-3-small — for users with API keys)
- [ ] Provider config in nacre config file (`nacre.config.json` or similar)
- [ ] sqlite-vec integration — create/query vector table
- [ ] Embedding generation during consolidation:
  - For each node: embed concatenation of label + excerpts
  - For each processed file: embed section summaries
- [ ] `nacre embed` CLI command (generate/regenerate embeddings)
- [ ] `nacre similar <query>` CLI command (semantic search)
- [ ] Handle provider switching (re-embed everything if dimensions change)
- [ ] Tests with mock provider

**Demo:** `nacre similar "build tool preferences"` returns relevant nodes even without keyword matches. Works out of the box with local ONNX, upgradeable to OpenAI.

---

## M3: API Server
*HTTP interface for programmatic access*

**Depends on:** M1
**Scope:** medium (3-4 days)

### Stack

Hono (lightweight, TypeScript-native, fast) running on Node. Embedded in the CLI as `nacre serve`.

### Endpoints

```
# Graph operations
GET    /api/v1/nodes                  — list nodes (filterable by type, label)
GET    /api/v1/nodes/:id              — get node details
GET    /api/v1/edges                  — list edges (filterable)
GET    /api/v1/graph/stats            — node/edge counts, health metrics

# Memory operations
POST   /api/v1/memories               — ingest new content
DELETE /api/v1/memories/:id            — forget a specific memory
POST   /api/v1/feedback                — reinforce/penalize a memory

# Intelligent operations
GET    /api/v1/recall?q=...            — hybrid retrieval (needs M5)
GET    /api/v1/brief                   — context briefing
GET    /api/v1/alerts                  — fading/emerging/attention items
GET    /api/v1/insights                — cluster analysis, suggestions
POST   /api/v1/consolidate             — trigger consolidation cycle

# System
GET    /api/v1/health                  — system health, config, version
GET    /api/v1/config                  — current configuration
```

### Tasks

- [ ] Hono server setup with TypeScript
- [ ] Route definitions for all endpoints
- [ ] Wire to existing core functions (brief, alerts, insights, query)
- [ ] Input validation (zod schemas)
- [ ] Error handling (consistent error response format)
- [ ] CORS support (for viz dashboard)
- [ ] `nacre serve` CLI command (start server, configurable port)
- [ ] Optional: simple auth (API key header) for remote access
- [ ] OpenAPI/Swagger spec generation
- [ ] Integration tests

**Demo:** `nacre serve` starts on port 3200. `curl localhost:3200/api/v1/brief` returns a JSON briefing. The viz can fetch graph data from the API instead of static JSON files.

---

## M4: Episodic Memory
*Formalized event/interaction records*

**Depends on:** M1
**Scope:** medium (3-4 days)

Currently, episodic memory is implicit — it's the raw markdown files. This milestone formalizes it as a first-class memory type with its own storage, search, and lifecycle.

### Data Model

```typescript
interface Episode {
  id: string;                        // content hash
  timestamp: string;                 // ISO datetime
  type: EpisodeType;                 // 'conversation', 'event', 'observation', 'decision'
  
  // Content
  summary: string;                   // one-line summary
  content: string;                   // full text/details
  
  // Context
  participants: string[];            // entity IDs involved
  topics: string[];                  // entity IDs of related concepts/projects
  location?: string;                 // where (for human episodes)
  
  // Outcome
  outcome?: string;                  // what resulted from this episode
  decisions?: string[];              // decisions made
  lessons?: string[];                // lessons learned (links to procedural memory)
  
  // Lifecycle
  source: string;                    // origin file or ingestion source
  importance: number;                // 0-1, affects decay rate
  decayRate: number;                 // how fast this episode fades
  lastAccessed: string;              // for access-based reinforcement
}

type EpisodeType = 'conversation' | 'event' | 'observation' | 'decision';
```

### Storage

```sql
CREATE TABLE episodes (
  id          TEXT PRIMARY KEY,
  timestamp   TEXT NOT NULL,
  type        TEXT NOT NULL,
  summary     TEXT NOT NULL,
  content     TEXT,
  participants TEXT,                  -- JSON array of node IDs
  topics       TEXT,                  -- JSON array of node IDs
  outcome     TEXT,
  decisions   TEXT,                   -- JSON array
  source      TEXT,
  importance  REAL DEFAULT 0.5,
  decay_rate  REAL DEFAULT 0.015,
  last_accessed TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX idx_episodes_timestamp ON episodes(timestamp);
CREATE INDEX idx_episodes_type ON episodes(type);

-- Episode-entity links (join table)
CREATE TABLE episode_entities (
  episode_id TEXT REFERENCES episodes(id),
  node_id    TEXT REFERENCES nodes(id),
  role       TEXT,                    -- 'participant', 'topic', 'mentioned'
  PRIMARY KEY (episode_id, node_id)
);
```

### Tasks

- [ ] Episode data model and SQLite schema
- [ ] Episode extraction from markdown files (enhance parser to emit episodes alongside entities)
- [ ] Episode CRUD in core
- [ ] Episode-entity linking (episodes reference nodes in the graph)
- [ ] Episode search by time range, participants, topics
- [ ] Episode summarization (compress old episodes, preserve key info)
- [ ] `nacre episodes` CLI command (list, search, view)
- [ ] Embed episodes for vector search (when M2 is complete)
- [ ] Tests

**Demo:** `nacre episodes --last 7d` shows recent episodes. `nacre episodes --topic nacre` shows all episodes related to the nacre project. Episodes link to graph nodes bidirectionally.

---

## M5: Hybrid Recall
*The core retrieval engine — combining graph + vectors*

**Depends on:** M2 (embeddings) + M3 (API, for the endpoint)
**Scope:** medium (3-5 days)

This is the heart of nacre-as-a-memory-service. The `recall()` function that takes a natural language query and returns ranked, contextualized results by combining graph structure and semantic similarity.

### Algorithm

```
Input: query string, optional filters (time range, types, scope)

1. EMBED the query → query_vector

2. VECTOR SEARCH
   - Find top-K nearest neighbors in embedding index
   - Score by cosine similarity
   - Returns: candidate memories with semantic scores

3. GRAPH SEARCH
   - Extract key terms from query (lightweight NLP)
   - Find matching nodes by label/alias
   - Walk graph N hops out from matches
   - Score by: edge weight × decay factor × hop penalty
   - Returns: candidate nodes/edges with structural scores

4. ENTITY RESOLUTION
   - Merge candidates that refer to the same entities
   - Deduplicate across vector and graph results

5. HYBRID RANKING
   - Combined score = α(semantic_score) + β(graph_score) + γ(recency) + δ(importance)
   - α, β, γ, δ are tunable weights (sensible defaults, configurable)
   - Apply any filters (time range, type restrictions)

6. CONTEXT ASSEMBLY
   - For top results, gather:
     - Node details (label, type, excerpts)
     - Related edges (strongest connections)
     - Source episodes (if episodic memory exists)
     - Procedural memories (if they exist, lessons/prefs related to result)
   - Format into a context window suitable for LLM injection

Output: ranked list of RecallResult objects
```

### Interface

```typescript
interface RecallOptions {
  query: string;
  limit?: number;                    // default: 10
  minScore?: number;                 // threshold for inclusion
  types?: EntityType[];              // filter by node type
  since?: string;                    // ISO date, only memories after this
  until?: string;                    // ISO date, only memories before this
  weights?: {                        // tuning knobs
    semantic?: number;               // default: 0.4
    graph?: number;                  // default: 0.3
    recency?: number;                // default: 0.2
    importance?: number;             // default: 0.1
  };
}

interface RecallResult {
  id: string;
  label: string;
  type: string;
  score: number;                     // combined score
  scores: {                          // breakdown
    semantic: number;
    graph: number;
    recency: number;
    importance: number;
  };
  excerpts: string[];                // relevant context
  connections: Array<{               // related entities
    label: string;
    type: string;
    relationship: string;
    weight: number;
  }>;
  episodes?: Episode[];              // related events
}
```

### Tasks

- [ ] Recall algorithm implementation
- [ ] Query term extraction (lightweight, no LLM needed)
- [ ] Graph walk with hop scoring
- [ ] Hybrid score fusion with tunable weights
- [ ] Context assembly (format results for LLM consumption)
- [ ] `nacre recall "query"` CLI command
- [ ] `GET /api/v1/recall?q=...` API endpoint
- [ ] Benchmarking: recall quality on our own graph, latency targets (<200ms)
- [ ] Tuning default weights based on real usage
- [ ] Tests with synthetic graphs

**Demo:** `nacre recall "what tools do we use for coding agents?"` returns tmux, Claude Code, Codex, Gemini CLI — ranked by relevance, with context about how they're used and connections between them. Fast, useful, and smarter than pure keyword or pure vector search.

---

## M6: MCP Server
*Instant integration with Claude, Cursor, and every MCP client*

**Depends on:** M5 (hybrid recall)
**Scope:** medium (3-4 days)

The highest-leverage integration point. MCP (Model Context Protocol) is becoming the standard way AI tools discover and use external capabilities. Ship an MCP server and every MCP-compatible client gets nacre memory for free.

### Tools

```typescript
// Core memory operations
nacre_remember: {
  description: "Store a new memory — a fact, observation, or interaction",
  parameters: {
    content: string,              // the memory content
    type?: 'fact' | 'event' | 'observation' | 'decision',
    importance?: number,          // 0-1, how important is this
    entities?: string[],          // related entity names
  }
}

nacre_recall: {
  description: "Retrieve relevant memories for a query or context",
  parameters: {
    query: string,                // what to recall
    limit?: number,
    types?: string[],             // filter by entity type
    since?: string,               // time filter
  }
}

nacre_brief: {
  description: "Get a contextual briefing — top memories, recent activity, alerts",
  parameters: {
    focus?: string,               // optional topic to focus on
    depth?: 'quick' | 'full',
  }
}

nacre_lesson: {
  description: "Record a learned lesson, preference, or behavioral pattern",
  parameters: {
    lesson: string,               // what was learned
    context?: string,             // when/why this applies
    category?: 'preference' | 'skill' | 'antipattern' | 'insight',
  }
}

nacre_feedback: {
  description: "Rate a memory's usefulness — helps nacre learn what matters",
  parameters: {
    memoryId: string,
    rating: number,               // -1 (not useful) to 1 (very useful)
    reason?: string,
  }
}

nacre_forget: {
  description: "Explicitly forget a memory",
  parameters: {
    memoryId: string,
    reason?: string,
  }
}
```

### Resources

```typescript
nacre://brief          // current briefing (auto-updating)
nacre://health         // memory system health
nacre://graph/stats    // graph statistics
```

### Tasks

- [ ] MCP server implementation (using @modelcontextprotocol/sdk)
- [ ] Tool definitions with proper JSON schemas
- [ ] Resource definitions
- [ ] Wire tools to core functions (recall, brief, consolidate, etc.)
- [ ] `nacre mcp` CLI command (start MCP server via stdio)
- [ ] MCP config examples for Claude Desktop, Cursor, Windsurf
- [ ] Test with Claude Desktop (easiest MCP client to validate against)
- [ ] Documentation: "Add nacre to Claude Desktop in 2 minutes"

**Demo:** Install nacre, add 3 lines to Claude Desktop config, and Claude now has persistent memory across conversations. Remember things, recall them later, get briefings. That's the pitch in a screenshot.

---

## M7: TypeScript SDK
*Developer-friendly programmatic access*

**Depends on:** M5 (recall), M3 (API)
**Scope:** small-medium (2-3 days)

### API Design

```typescript
import { Nacre } from '@nacre/sdk';

// Local mode (embedded, no server needed)
const memory = new Nacre({ 
  path: './my-agent-memory',
  embedder: 'onnx',                 // or 'ollama', 'openai'
});

// Remote mode (connecting to nacre serve)
const memory = new Nacre({ 
  url: 'http://localhost:3200',
  apiKey: 'optional-key',
});

// Core operations
await memory.remember('Marcus prefers Vite over Webpack');
await memory.remember('Deployed the new feature to staging', { 
  type: 'event', 
  importance: 0.8 
});

const results = await memory.recall('build tool preferences');
// → [{ label: 'vite', score: 0.89, excerpts: [...], connections: [...] }]

const briefing = await memory.brief();
const briefing = await memory.brief({ focus: 'nacre project' });

await memory.lesson('Always check if the user has Ollama installed before defaulting to it');

await memory.feedback(results[0].id, { rating: 1, reason: 'exactly what I needed' });

await memory.consolidate();          // trigger a sleep cycle

// Graph access
const nodes = await memory.nodes({ type: 'project' });
const edges = await memory.edges({ source: 'marcus' });
```

### Tasks

- [ ] Package setup (@nacre/sdk)
- [ ] Local mode: embed core library directly (no server needed)
- [ ] Remote mode: HTTP client wrapping the REST API
- [ ] Unified interface (same API regardless of mode)
- [ ] TypeScript types exported (great DX)
- [ ] npm publish setup
- [ ] README with examples
- [ ] Tests

**Demo:** `npm install @nacre/sdk` → 10 lines of code → your agent has persistent memory.

---

## M8: Procedural Memory
*Learned behaviors and adaptations*

**Depends on:** M1 (SQLite), M6 (MCP, for lesson tool)
**Scope:** medium (3-5 days)

The most-differentiated memory type. Nobody else does this well.

### Data Model

```typescript
interface Procedure {
  id: string;
  type: ProcedureType;
  
  // Content
  statement: string;                 // "When X, do Y" or "User prefers Z"
  context: string;                   // when/where this applies
  
  // Evidence
  sourceEpisodes: string[];          // which episodes led to this lesson
  sourceNodes: string[];             // related graph entities
  
  // Lifecycle
  confidence: number;                // 0-1, strengthened by confirming evidence
  contradictions: number;            // times this was contradicted
  lastApplied: string;               // when this was last surfaced and used
  createdAt: string;
  updatedAt: string;
  
  // Retrieval
  triggers: string[];                // keywords/concepts that should surface this
  embedding?: Float32Array;          // for semantic matching
}

type ProcedureType = 
  | 'lesson'        // "When X happens, do Y"
  | 'preference'    // "The user prefers Z"
  | 'skill'         // "I know how to do W"
  | 'antipattern'   // "Don't do Q, it causes problems"
  | 'insight'       // "X tends to correlate with Y"
```

### Surfacing Logic

Procedural memories should be proactively surfaced when relevant:
- During `recall()`: if query matches procedure triggers/embedding, include in results
- During `brief()`: surface high-confidence procedures related to current focus
- During consolidation: look for patterns in episodic memory that could become procedures

### Tasks

- [ ] Procedure data model and SQLite schema
- [ ] Procedure CRUD in core
- [ ] Manual procedure creation (via `nacre_lesson` MCP tool, API, SDK)
- [ ] Procedure embedding (for semantic matching on recall)
- [ ] Trigger matching (keyword + semantic)
- [ ] Confidence updating (reinforcement when procedure is applied, decay when not)
- [ ] Contradiction detection (new evidence conflicts with existing procedure)
- [ ] Integration with recall (surface relevant procedures alongside graph results)
- [ ] Integration with brief (include applicable procedures)
- [ ] `nacre procedures` CLI command
- [ ] Future: automated procedure extraction from episodic patterns (M-next)

**Demo:** Agent records `nacre_lesson("When writing files that nacre needs to read, use exec not the Write tool")`. Next time the agent's context involves writing memory files, this lesson surfaces in the recall results. Over time, if the lesson proves useful (positive feedback), its confidence grows. If it's contradicted, it gets flagged for review.

---

## M9: Conversation Ingester
*Direct path from agent interactions to memory*

**Depends on:** M1 (SQLite), M4 (episodic memory)
**Scope:** medium (3-4 days)

Currently nacre only ingests markdown files. For a memory-as-a-service, agents need to feed conversations directly. This is the primary ingestion path for most integrations.

### Input Format

```typescript
interface ConversationInput {
  messages: Array<{
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
    timestamp?: string;
    name?: string;                   // participant name
  }>;
  metadata?: {
    sessionId?: string;
    platform?: string;               // 'slack', 'discord', 'cli', etc.
    topic?: string;
  };
}
```

### Processing Pipeline

```
Conversation → Chunking → Entity Extraction → Episode Creation → Graph Update → Embedding
                              │                      │                 │
                              ▼                      ▼                 ▼
                         Nodes/edges           Episodes          Vector index
                         in graph              in episode         similarity
                                               store              search
```

### Tasks

- [ ] Conversation input schema (accept various chat formats)
- [ ] Conversation chunker (split long convos into meaningful segments)
- [ ] Entity extraction from conversations (reuse/extend existing NLP pipeline)
- [ ] Episode generation from conversation chunks
- [ ] `POST /api/v1/memories` endpoint accepting conversation format
- [ ] `nacre ingest` CLI command for batch conversation import
- [ ] Adapters for common formats (Clawdbot session logs, ChatGPT exports, generic JSONL)
- [ ] Deduplication (don't re-process same conversation)
- [ ] Tests

**Demo:** Export a Clawdbot session log, `nacre ingest session.json`, and watch the graph grow with new entities and episodes from the conversation.

---

## M10: Visualization Dashboard
*Polish the secret weapon*

**Depends on:** M3 (API, for live data), M5 (recall, for search)
**Scope:** medium-large (5-7 days)

The viz exists and looks great. This milestone turns it from a developer tool into a product feature.

### Enhancements

- [ ] **Live data**: Fetch from API instead of static JSON files
- [ ] **Memory health dashboard**: Decay rates, reinforcement frequency, graph density, memory age distribution
- [ ] **Search integration**: Type a query, see matching nodes highlighted in the graph (powered by hybrid recall)
- [ ] **Episodic timeline**: Scrollable timeline of episodes alongside the graph
- [ ] **Procedural memory panel**: View lessons, preferences, skills in a sidebar
- [ ] **Consolidation visualization**: Animate the sleep cycle — watch nodes strengthen, edges decay, new connections form
- [ ] **Diff view**: Compare graph state at two points in time
- [ ] **Responsive layout**: Work on desktop and tablet
- [ ] **Embeddable mode**: `<iframe>` snippet for docs, blog posts, demos
- [ ] **Fallback for no-WebGL**: 2D force graph using d3-force for environments without GPU

**Demo:** Open the nacre dashboard, see your agent's memory as a living, breathing 3D graph. Search for a concept and watch related memories light up. Scrub through time and see how knowledge evolved. Show the health metrics. This is the screenshot/GIF that sells nacre on the README.

---

## M11: Documentation & Launch
*Make it real for other people*

**Depends on:** M6 (MCP), M7 (SDK) — core integration points must exist
**Scope:** medium (4-5 days)

### Documentation Site

- [ ] Landing page (positioning, key features, demo GIF/video)
- [ ] Quick start guide (install → first memory → recall in <5 min)
- [ ] Guides:
  - "Add memory to Claude Desktop" (MCP setup)
  - "Add memory to your LangChain agent" (SDK)
  - "Add memory to your custom agent" (API)
  - "Using nacre with Obsidian" (markdown + wikilinks)
  - "Understanding the memory model" (decay, reinforcement, consolidation)
- [ ] API reference (auto-generated from OpenAPI spec)
- [ ] SDK reference (auto-generated from TypeScript types)
- [ ] Architecture overview (adapted from VISION.md)
- [ ] Configuration reference

### Launch Checklist

- [ ] npm publish: @nacre/core, @nacre/sdk, @nacre/cli
- [ ] GitHub repo public
- [ ] Documentation site live
- [ ] Demo video/GIF for README
- [ ] Blog post: "Why we built nacre" (the thesis, the differentiation)
- [ ] Hacker News / Reddit / Twitter launch
- [ ] Discord community server
- [ ] Example projects (nacre + Claude Desktop, nacre + LangChain, nacre + Clawdbot)

---

## Post-Launch Milestones

### M12: Python SDK
- Python wrapper around the REST API
- PyPI publish
- Examples for LangChain, CrewAI, AutoGen

### M13: Inference Engine
- Pattern discovery in graph structure
- Higher-order concept generation during consolidation
- Automated procedure extraction from episodic patterns

### M14: Temporal Reasoning
- Graph snapshots on each consolidation
- Point-in-time queries
- Evolution tracking and graph diffing

### M15: Multi-Graph
- Multiple named graphs in one nacre instance
- Per-graph config (decay rates, embedding providers)
- Graph federation (cross-graph queries)

### M16: Cloud Option
- Hosted nacre-as-a-service
- User auth, billing, usage limits
- Managed consolidation (scheduled, not heartbeat-dependent)

---

## Timeline Estimates

Rough estimates assuming focused work. These are "work days," not calendar days.

| Milestone | Scope | Est. Days | Cumulative |
|-----------|-------|-----------|------------|
| M0: Repo Cleanup | Small | 1-2 | 1-2 |
| M1: SQLite | Medium | 3-5 | 4-7 |
| M2: Embeddings | Medium | 3-5 | 7-12 |
| M3: API Server | Medium | 3-4 | 10-16 |
| M4: Episodic Memory | Medium | 3-4 | 13-20 |
| M5: Hybrid Recall | Medium | 3-5 | 16-25 |
| M6: MCP Server | Medium | 3-4 | 19-29 |
| M7: TS SDK | Small-Med | 2-3 | 21-32 |
| M8: Procedural Memory | Medium | 3-5 | 24-37 |
| M9: Conv Ingester | Medium | 3-4 | 27-41 |
| M10: Viz Dashboard | Med-Large | 5-7 | 32-48 |
| M11: Docs & Launch | Medium | 4-5 | 36-53 |

**MVP for external use (M0-M7):** ~21-32 work days
**Full v1.0 launch (M0-M11):** ~36-53 work days

---

## Principles for the Build

1. **Ship incrementally.** Each milestone is independently useful. Don't wait for everything to launch something.
2. **Dogfood relentlessly.** Nacre should be Lobstar's memory first. Every feature gets tested in production (our production) before shipping.
3. **Tests aren't optional.** We have 85 passing tests. That number goes up, never down.
4. **Keep it local-first.** Cloud is always optional. The default experience requires zero external services.
5. **API before UI.** Every feature works via CLI/API before it gets a visual treatment. The viz is the cherry, not the cake.
6. **Boring technology.** SQLite, TypeScript, Hono, ONNX. No exotic dependencies. The interesting parts are the algorithms, not the stack.

---

*This roadmap is alive. Update it as we learn.*

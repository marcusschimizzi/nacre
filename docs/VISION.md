# Nacre — Vision & Architecture

> **Biological memory for long-living AI agents.**
> Open-source. Local-first. Graph-native.

---

## What is Nacre?

Nacre is a memory layer for AI agents that actually works like memory.

Not a vector database with "memory" in the marketing. Not a key-value store with timestamps. A system that models how memory actually works — formation, consolidation, decay, reinforcement, inference — and makes it available as infrastructure for agents that live for months, not minutes.

### The Problem

Every AI agent today wakes up with amnesia. Context windows are finite. Conversation history gets truncated. The agent that helped you yesterday has no idea what it learned. Current solutions are either:

- **Naive** — stuff everything into context and pray (expensive, lossy, doesn't scale)
- **Shallow** — vector search over past messages (retrieves text, doesn't understand relationships)
- **Generic** — designed for chatbots with thousands of users, not agents with one deep relationship

None of them model memory the way memory actually works.

### The Thesis

Long-living AI agents — assistants that run for months, develop genuine understanding of their human, accumulate real context — are the future. But they need memory that:

1. **Decays naturally** — not everything is worth remembering forever
2. **Strengthens through repetition** — important things get reinforced
3. **Forms connections** — memories link to each other, creating understanding
4. **Consolidates during downtime** — like sleep, batch-processing experience into knowledge
5. **Enables discovery** — the system should surface insights the agent didn't explicitly store
6. **Stays private** — your agent's memory shouldn't live on someone else's server

Nacre does all of this.

---

## Target Users

### Primary: Agent Framework Developers
People building with Clawdbot, LangGraph, CrewAI, AutoGen, Letta, or custom agent frameworks. They need a memory backend that's smarter than a vector store.

### Secondary: Long-Living Agent Operators  
People running persistent agents (personal assistants, coding companions, research agents) who need their agent to actually remember and learn over time.

### Tertiary: Knowledge Workers
Humans who want the same memory graph for their own notes (Obsidian users, researchers, journalers). Carbon + silicon — same system, same graph.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           NACRE PLATFORM                                │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                      INTEGRATION LAYER                          │    │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐   │    │
│  │  │ REST API │  │MCP Server│  │WebSocket │  │    SDKs      │   │    │
│  │  │          │  │          │  │ (live)   │  │ TS / Python  │   │    │
│  │  └────┬─────┘  └────┬─────┘  └────┬─────┘  └──────┬───────┘   │    │
│  └───────┼──────────────┼──────────────┼──────────────┼───────────┘    │
│          └──────────────┴──────┬───────┴──────────────┘                │
│                                │                                       │
│  ┌─────────────────────────────┴───────────────────────────────────┐   │
│  │                      MEMORY ENGINE                              │   │
│  │                                                                 │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐    │   │
│  │  │  SEMANTIC    │  │  EPISODIC   │  │    PROCEDURAL       │    │   │
│  │  │  MEMORY      │  │  MEMORY     │  │    MEMORY           │    │   │
│  │  │             │  │             │  │                     │    │   │
│  │  │ Knowledge   │  │ Raw events, │  │ Learned behaviors, │    │   │
│  │  │ graph with  │  │ interactions │  │ prompt adaptations, │    │   │
│  │  │ typed edges,│  │ conversations│  │ skills, patterns   │    │   │
│  │  │ decay math  │  │ with context │  │                     │    │   │
│  │  └──────┬──────┘  └──────┬──────┘  └──────────┬──────────┘    │   │
│  │         └────────────────┼────────────────────┘               │   │
│  │                          │                                     │   │
│  │  ┌───────────────────────┴──────────────────────────────┐     │   │
│  │  │              INTELLIGENCE LAYER                       │     │   │
│  │  │                                                       │     │   │
│  │  │  ┌────────────┐ ┌────────────┐ ┌──────────────────┐  │     │   │
│  │  │  │ Inference  │ │ Temporal   │ │   Consolidation  │  │     │   │
│  │  │  │ & Synthesis│ │ Reasoning  │ │   & Decay        │  │     │   │
│  │  │  │            │ │            │ │                   │  │     │   │
│  │  │  │ Discover   │ │ Evolution  │ │ Ebbinghaus decay, │  │     │   │
│  │  │  │ patterns,  │ │ tracking,  │ │ reinforcement,   │  │     │   │
│  │  │  │ generate   │ │ point-in-  │ │ smart forgetting,│  │     │   │
│  │  │  │ higher-    │ │ time       │ │ sleep/wake       │  │     │   │
│  │  │  │ order      │ │ queries,   │ │ batching         │  │     │   │
│  │  │  │ concepts   │ │ graph diff │ │                   │  │     │   │
│  │  │  └────────────┘ └────────────┘ └──────────────────┘  │     │   │
│  │  └──────────────────────────────────────────────────────┘     │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                │                                       │
│  ┌─────────────────────────────┴───────────────────────────────────┐   │
│  │                      INGESTION LAYER                            │   │
│  │                                                                 │   │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌──────────┐ │   │
│  │  │ Markdown   │  │ Conversation│  │ Structured │  │ Custom   │ │   │
│  │  │ Parser     │  │ Ingester   │  │ Data       │  │Extractors│ │   │
│  │  │            │  │            │  │ Ingester   │  │ (plugin) │ │   │
│  │  │ .md files, │  │ Chat logs, │  │            │  │          │ │   │
│  │  │ wikilinks, │  │ session    │  │ JSON, API  │  │ User-    │ │   │
│  │  │ Obsidian   │  │ transcripts│  │ responses, │  │ defined  │ │   │
│  │  │ compat     │  │            │  │ webhooks   │  │ parsers  │ │   │
│  │  └────────────┘  └────────────┘  └────────────┘  └──────────┘ │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                │                                       │
│  ┌─────────────────────────────┴───────────────────────────────────┐   │
│  │                      STORAGE LAYER                              │   │
│  │                                                                 │   │
│  │  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────┐  │   │
│  │  │   Graph Store    │  │  Vector Index    │  │  Blob Store  │  │   │
│  │  │                  │  │                  │  │              │  │   │
│  │  │  Nodes, edges,   │  │  Embeddings for  │  │  Raw files,  │  │   │
│  │  │  types, weights, │  │  semantic search │  │  snapshots,  │  │   │
│  │  │  temporal data,  │  │  over memories   │  │  excerpts    │  │   │
│  │  │  provenance      │  │                  │  │              │  │   │
│  │  │                  │  │  Local-first:    │  │              │  │   │
│  │  │  SQLite w/       │  │  sqlite-vec or   │  │  Filesystem  │  │   │
│  │  │  graph schema    │  │  LanceDB         │  │              │  │   │
│  │  └──────────────────┘  └──────────────────┘  └──────────────┘  │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                      VISUALIZATION                              │   │
│  │  3D force graph · Temporal scrub · Cluster maps · Memory health │   │
│  │  Nacre iridescent shader · Interactive exploration              │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Layer Details

### 1. Storage Layer

The foundation. Everything persists here. **Local-first by default** — a single directory on disk that contains the entire memory state.

| Store | Purpose | Technology | Notes |
|-------|---------|------------|-------|
| **Graph Store** | Nodes, edges, types, weights, temporal data, provenance | SQLite with graph schema | Upgrade from current JSON file. Single-file DB, portable, fast, battle-tested. Enables proper indexing and queries. |
| **Vector Index** | Embedding vectors for semantic similarity search | sqlite-vec (SQLite extension) or LanceDB | Co-located with graph store. Pluggable embedding providers (local ONNX, Ollama, or remote OpenAI/Voyage). |
| **Blob Store** | Raw source files, graph snapshots, large excerpts | Filesystem | Simple file storage with content-addressed hashing. Snapshots enable temporal queries. |

**Key principle**: A nacre memory is a *directory*. Copy it, back it up, version control it. No external services required.

**Migration path**: Current JSON graph → SQLite is straightforward. JSON becomes an import/export format.

### 2. Ingestion Layer

How memories get in. Currently markdown-only — needs to expand.

**Markdown Parser** *(exists)* — .md files with wikilinks, frontmatter, sections. Obsidian-compatible. Extracts entities via structural analysis, NLP, and custom rules.

**Conversation Ingester** *(new)* — Direct ingestion of chat transcripts, session logs, agent interactions. Extracts participants, topics, decisions, outcomes. This is the primary path for agent memory — the agent's conversations become memories without going through markdown first.

**Structured Data Ingester** *(new)* — JSON, API responses, webhook payloads. For agents that interact with external systems and want to remember what they learned. Schema-aware extraction.

**Custom Extractors** *(new, plugin)* — User-defined extraction pipelines for domain-specific data. A plugin interface so nacre can understand medical records, codebases, legal docs, whatever.

**All ingesters produce the same output**: entities, relationships, and raw content that feeds into the memory engine.

### 3. Memory Engine

The brain. Three memory types, inspired by cognitive science:

#### Semantic Memory — *What you know*
The knowledge graph. Entities (people, projects, concepts, tools) connected by typed, weighted, decaying edges. This is what nacre already does well.

- Typed nodes and edges with provenance
- Ebbinghaus decay with stability-through-reinforcement
- Entity resolution (fuzzy matching, alias tracking)
- Co-occurrence and causal relationship detection

#### Episodic Memory — *What happened*
Raw experiences indexed by time. Currently these are the daily markdown files, but this needs to be formalized.

- Timestamped interaction records
- Context-rich: who, what, when, where, outcome
- Linked to semantic memory (episodes reference entities)
- Searchable by time range, participants, topics
- Summarizable (compress old episodes, keep essence)

#### Procedural Memory — *What you've learned to do*
The least-explored and most-differentiated memory type. Captures behavioral patterns and adaptations.

- **Lessons**: "When X happens, do Y" (extracted from experiences)
- **Preferences**: "The user prefers Z" (accumulated from interactions)  
- **Skills**: "I learned to do W" (task-specific knowledge)
- **Anti-patterns**: "Don't do Q, it caused problems" (negative lessons)
- Surfaced proactively when relevant context appears
- Evolves over time — lessons can be revised, preferences updated

### 4. Intelligence Layer

Where nacre goes beyond storage into actual cognition.

#### Consolidation & Decay *(exists, enhance)*
- **Sleep/wake model**: Batch processing during idle periods, not real-time
- **Ebbinghaus decay**: λ=0.015/day base rate, modified by stability
- **Reinforcement**: Re-encountering a memory increases its stability, slowing future decay
- **Smart forgetting**: Below-threshold memories get pruned or archived
- **Enhancement**: Add consolidation of episodic → semantic (extracting facts from experiences) and semantic → procedural (extracting lessons from patterns)

#### Inference & Synthesis *(new)*
- **Pattern discovery**: Detect triangles, clusters, bridges in graph structure
- **Concept generation**: Create higher-order nodes from observed patterns ("Marcus works on multiple Slack-related projects" → create "Slack ecosystem" concept)
- **Gap detection**: Identify structural holes — areas where connections probably exist but haven't been observed
- **Analogy detection**: "This pattern looks like that pattern" across different domains
- **Runs during consolidation**: Not real-time, but accumulates insight over time

#### Temporal Reasoning *(new)*
- **Point-in-time queries**: "What did I know about X on January 15th?"
- **Evolution tracking**: "How has my understanding of Y changed over the last month?"
- **Graph snapshots**: Periodic full-state captures for diffing
- **Temporal edges**: "A led to B" with timestamp ordering
- **Trend detection**: "This topic is gaining/losing relevance"

### 5. Integration Layer

How agents talk to nacre.

#### REST API *(new)*
Core CRUD + intelligent operations:

```
POST   /memories          — ingest new content (text, conversation, structured)
GET    /recall             — retrieve relevant memories for a query
GET    /graph/nodes        — browse graph structure
GET    /graph/edges
POST   /consolidate        — trigger a consolidation cycle
GET    /brief              — get a context briefing
GET    /alerts             — get attention-worthy items (fading, emerging)
GET    /temporal/:date     — point-in-time graph state
GET    /health             — memory system health metrics
DELETE /memories/:id       — explicit forgetting
POST   /feedback           — reinforce or penalize specific memories
```

#### MCP Server *(new, high priority)*
Model Context Protocol server exposing nacre as tools:

```
Tools:
  nacre_remember    — store a new memory
  nacre_recall      — retrieve relevant context
  nacre_brief       — get a situation briefing  
  nacre_lesson      — record a procedural lesson
  nacre_feedback    — "this memory was useful" / "this was noise"

Resources:
  nacre://graph     — current graph state
  nacre://brief     — latest briefing
  nacre://health    — system health
```

This is probably the highest-leverage integration point. Any MCP-compatible client (Claude Desktop, Cursor, Windsurf, custom agents) gets nacre memory for free.

#### WebSocket *(new)*
Live updates for the visualization layer and real-time integrations:
- Graph mutation events (node added, edge strengthened, memory decayed)
- Consolidation progress
- Alert triggers

#### SDKs *(new)*
Thin wrappers around the API:

```typescript
// TypeScript
import { Nacre } from '@nacre/sdk';

const memory = new Nacre({ path: './my-agent-memory' }); // local
// or
const memory = new Nacre({ url: 'http://localhost:3200' }); // remote

await memory.remember('Marcus prefers Vite over Webpack');
const context = await memory.recall('build tool preferences');
await memory.lesson('When setting up a new project, always ask about build tool preference first');
```

```python
# Python
from nacre import Nacre

memory = Nacre(path="./my-agent-memory")
memory.remember("Marcus prefers Vite over Webpack")
context = memory.recall("build tool preferences")
```

### 6. Visualization

The window into the mind. **This is nacre's secret weapon.** No other memory system lets you *see* the memory.

*(Exists, needs enhancement)*

- 3D force-directed graph with nacre iridescent shader
- Temporal scrub (slide through time)
- Cluster visualization with labeled groups
- Search and zoom
- Node detail panels with provenance

**Planned enhancements:**
- Memory health dashboard (decay rates, reinforcement frequency, graph density)
- Consolidation visualization (watch the sleep cycle process)
- Comparative views (diff two points in time)
- Embedding space view (2D projection of vector similarities)
- Procedural memory display (lesson trees, behavioral patterns)
- Shareable/embeddable (for demos, docs, blog posts)

---

## Design Principles

### 1. Biological Fidelity
Memory science informs architecture, not just marketing. Ebbinghaus decay, sleep consolidation, spaced repetition, interference theory — these aren't metaphors, they're implementation details.

### 2. Local-First, Cloud-Optional
A nacre memory is a directory on disk. It works offline. It requires no external services. Cloud hosting is an option for convenience, never a requirement.

### 3. Graph-Native
The knowledge graph is the primary data structure, not a secondary index. Embeddings augment the graph; the graph doesn't augment the embeddings.

### 4. Observable
You can see the memory. Inspect it. Explore it. Debug it. The visualization isn't a feature — it's a principle. Opaque memory systems breed distrust.

### 5. Incremental
Never rebuild from scratch. Process new data, update the graph, decay what's old. The system evolves continuously, like memory does.

### 6. Carbon + Silicon
Same system works for AI agents and human knowledge workers. Your agent's memory graph and your Obsidian vault can coexist, interlink, or run independently.

---

## Competitive Positioning

| | Nacre | Supermemory | Mem0 | Zep | Letta |
|---|---|---|---|---|---|
| **Primary structure** | Knowledge graph | Hybrid (vector + graph) | Vector + optional graph | Temporal knowledge graph | Hierarchical tiers |
| **Decay model** | Ebbinghaus w/ reinforcement stability | Basic decay/forgetting | Usage-based pruning | Edge invalidation | LLM-driven triage |
| **Consolidation** | Sleep/wake batch (biologically inspired) | Refinement + inference | Short→long term shift | Async precomputation | Self-directed (LLM) |
| **Procedural memory** | Yes (planned) | No | No | No | Partial (via LLM) |
| **Visualization** | 3D interactive graph | No | No | No | No |
| **Local-first** | Yes (core principle) | No (cloud API) | Self-host option | Cloud + AWS | Self-host option |
| **MCP support** | Planned | No | No | No | No |
| **Open source** | Yes | Partial | Yes | Yes | Yes |
| **Target use case** | Long-living agents | General AI memory | General AI memory | Enterprise agents | Stateful agents |

---

## Phased Roadmap

### Phase A — Foundation (Current → Solid)
*Make what exists production-ready*

- [ ] Migrate graph store from JSON → SQLite
- [ ] Add embedding layer (sqlite-vec + pluggable providers)
- [ ] Semantic search: `recall(query)` with vector similarity + graph context
- [ ] Formalize episodic memory (structured event records, not just markdown parsing)
- [ ] Performance profiling and optimization for 10k+ node graphs
- [ ] Test suite expansion, CI/CD

### Phase B — Integration
*Make nacre accessible to agents*

- [ ] REST API server (Express or Hono)
- [ ] MCP Server (highest priority integration)
- [ ] TypeScript SDK (@nacre/sdk)
- [ ] Python SDK (nacre-python)
- [ ] Conversation ingester (direct chat log → memory)
- [ ] Webhook receiver (for event-driven memory)

### Phase C — Intelligence
*Make nacre smarter than a database*

- [ ] Procedural memory type (lessons, preferences, anti-patterns)
- [ ] Inference engine (pattern discovery, concept synthesis)
- [ ] Temporal snapshots and point-in-time queries
- [ ] Feedback loops (agent rates memory usefulness)
- [ ] Cross-memory-type consolidation (episodic → semantic → procedural)
- [ ] Benchmarking against LongMemEval, LOCOMO

### Phase D — Platform
*Make nacre a product*

- [ ] Multi-graph support (multiple agents, multiple users)
- [ ] Cloud hosting option (nacre-as-a-service)
- [ ] Plugin/extractor marketplace
- [ ] Visualization dashboard (standalone web app)
- [ ] Documentation site, tutorials, examples
- [ ] Community building, Discord/forum

### Phase E — Ecosystem
*Make nacre a standard*

- [ ] Framework integrations (LangChain, CrewAI, AutoGen, Clawdbot)
- [ ] Import/export from other memory systems (Mem0, Zep)
- [ ] Federation (agents share memories across nacre instances)
- [ ] Advanced viz (VR/AR memory exploration?)
- [ ] Research publication (the biological memory model)

---

## Open Questions

1. **SQLite vs. something else for graph store?** SQLite is the local-first champion, but graph queries on a relational schema can get awkward. DuckDB? SurrealDB? Or keep it simple?

2. **Embedding model choice?** Need a default that's small, fast, and good. all-MiniLM-L6-v2 is the classic. Newer options like nomic-embed-text or gte-small might be better. Should be pluggable regardless.

3. **How much LLM involvement in consolidation?** Current system is rule-based (NLP extraction, co-occurrence thresholds). Competitors use LLMs for memory extraction. We could do hybrid — structural extraction as baseline, optional LLM enhancement for inference/synthesis. Keeps the local-first story (works without an API key) while enabling richer cognition when available.

4. **Licensing?** MIT is simple and permissive. AGPLv3 forces cloud providers to share modifications. Apache 2.0 is the enterprise-friendly middle ground. This matters for adoption.

5. **Name/brand?** "Nacre" is great — iridescent, layered, formed over time, protective. But is it googleable? Memorable? Does it need a tagline?

---

*This is a living document. It will evolve as nacre does.*

---

## The Human Layer — Nacre App

*Added 2026-02-05. This section is exploratory — a workshop space for ideas that will evolve.*

### The Insight

Every agentic memory system today is headless infrastructure. Supermemory, Mem0, Zep — they're APIs. The agent gets memory, but the human gets nothing. No way to see, curate, or contribute to the shared knowledge.

On the other side, Obsidian, Notion, Roam are great human tools with zero concept of agentic memory. When AI shows up in these tools, it's a feature in a sidebar, not a participant in the knowledge space.

The nacre app fills both gaps: **a shared thinking space where human and AI develop memory together.**

### Three Modes, One Space

**Capture** — completely low-friction input. Open the app, start typing. No folders, no categories, no "where does this go?" The AI finds structure, creates links, surfaces related context. You think; the system organizes.

**Converse** — chat with your AI companion, but within the knowledge space. Not a separate chatbot — conversation that happens in context (a project dashboard, a review surface, the graph view). Every conversation becomes memory. Decisions get extracted, insights get linked, action items surface later.

**Explore** — see the shared knowledge. The 3D graph, project dashboards, timelines, review surfaces. The agent's own perspective on what's important. What's fading, what's emerging, what new connections formed.

The key: **the boundary between "using the app" and "talking to your AI" disappears.** It's one environment where capturing thoughts, having conversations, and reviewing knowledge are all the same activity.

### Generative UI — Memories Have Shapes

The deeper idea: memories aren't all the same shape, so they shouldn't all look the same.

- A *decision* has a shape — options, tradeoffs, outcome, rationale
- A *timeline* has a shape — events in sequence, cause and effect
- A *cluster of related ideas* has a shape — a constellation, a mind map
- A *project status* has a shape — progress, blockers, next steps
- An *evolving understanding* has a shape — versions over time, how thinking changed
- A *lesson learned* has a shape — context, mistake, insight, application
- A *person* has a shape — relationship, interactions, shared context, preferences

Forcing all of these into "markdown note with a title" is like forcing all food into sandwich form. It works, but you lose a lot.

**Generative UI means the memory's shape determines its display.** The AI doesn't just know *what* the memory contains — it knows what *kind* of thing it is, and it picks (or composes) the right visual representation.

This was the original insight behind Strata's "Notes with Superpowers" — you shouldn't have to wrangle a template for a Project page, a Person page, or an Area page in something like Notion. The system should understand the shape of the data. Nacre takes this further: the AI not only understands the shape, it actively participates in filling it out, connecting it, and evolving the display as the memory evolves.

### Architecture (Sketch)

Three layers, loosely coupled:

**Primitive components** (`@nacre/ui`) — a design system of composable visual building blocks. Text blocks, cards, timelines, tables, kanban columns, comparison views, conversation threads, mini-graphs, callouts, charts. Designed to be renderable from a JSON spec.

**Compositions** — pre-built arrangements of primitives for common memory shapes: decision view, timeline view, project dashboard, lesson card, person profile, constellation map. These cover ~80% of cases and serve as examples for custom compositions.

**AI rendering pipeline** — given a memory (or group of memories) and context, produce a rendering specification. The AI selects a composition or assembles primitives, maps data to components, chooses emphasis, and suggests related memories. The UI library renders the spec.

```typescript
// AI produces a render spec
interface MemoryRender {
  layout: string;                    // composition name or 'custom'
  sections: Array<{
    component: string;               // primitive component name
    data: Record<string, any>;       // data for the component
    emphasis?: 'primary' | 'secondary' | 'subtle';
  }>;
  related: string[];                 // memory IDs to surface alongside
  actions: string[];                 // suggested next actions
}

// UI library renders it
<MemoryView spec={render} />
```

**Experimentation-first approach:**
1. Build the primitive component library (useful regardless)
2. Hand-craft a few compositions for common shapes
3. Build the AI rendering pipeline (start simple: AI picks from presets)
4. Ship and observe — let real usage guide what to build next
5. Evolve toward custom AI-composed views over time

### The Bigger Idea

The nacre app should feel more like a *place* than a *tool*. Tools have fixed interfaces. Places have rooms that look different depending on what's in them. A knowledge space that reshapes itself around what you're thinking about — that's what generative UI offers, and it's what no one else is building.

### Product Stack

- **Nacre Engine** — open-source memory infrastructure (graph, embeddings, decay, consolidation, recall)
- **Nacre App** — the human interface (web app, eventually desktop via Tauri)
- **Nacre MCP/SDK/API** — the agent interface (for third-party integrations)
- **Nacre Viz** — the 3D graph visualization (embeddable, part of the app but also standalone)

The engine ships first. The MCP/SDK makes it useful to the agent ecosystem. The app makes it tangible to humans. The viz makes it beautiful.

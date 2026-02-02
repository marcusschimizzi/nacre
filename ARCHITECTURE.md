# Nacre — Architecture Document

*The architecture of memory, made visible.*

> This document describes the technical architecture for Nacre, a spatial memory graph that turns flat markdown memory files into a living, evolving knowledge graph with temporal depth, intelligent forgetting, and emergent connection discovery.

---

## Table of Contents

1. [System Overview](#system-overview)
2. [Design Principles](#design-principles)
3. [Data Model](#data-model)
4. [Ingestion Pipeline](#ingestion-pipeline)
5. [Decay & Reinforcement Model](#decay--reinforcement-model)
6. [Visualization Layer](#visualization-layer)
7. [Integration Layer](#integration-layer)
8. [Project Structure](#project-structure)
9. [Technology Decisions](#technology-decisions)
10. [Phase Plan](#phase-plan)
11. [Open Questions & Future Work](#open-questions--future-work)

---

## System Overview

Nacre has four major subsystems:

```
┌─────────────────────────────────────────────────────────────────┐
│                         NACRE SYSTEM                            │
│                                                                 │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐  │
│  │  Parser   │───▶│   Core   │───▶│   Viz    │    │  CLI /   │  │
│  │ Pipeline  │    │  Engine  │    │  Layer   │    │  API     │  │
│  └──────────┘    └──────────┘    └──────────┘    └──────────┘  │
│       ▲               │               ▲               │         │
│       │               ▼               │               ▼         │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐  │
│  │ Markdown  │    │  Graph   │    │ Browser  │    │ Clawdbot │  │
│  │  Files    │    │  Store   │    │          │    │ Hooks    │  │
│  └──────────┘    └──────────┘    └──────────┘    └──────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

- **Parser Pipeline** — reads markdown files, extracts entities and relationships, feeds the core engine. Runs during "sleep" (heartbeats/cron), never in real-time.
- **Core Engine** — the graph data model, decay/reinforcement math, query interface, and persistence layer. The brain.
- **Viz Layer** — 3D force-directed graph rendered in the browser. The window into the brain.
- **CLI / API** — command-line tools and programmatic hooks for consolidation, querying, and integration with Clawdbot.

---

## Design Principles

### 1. Sleep/Wake Consolidation
Memories form during waking (normal sessions), connections form during sleep (consolidation cycles). The parser never runs in real-time — it processes accumulated experience in batch, just like hippocampal replay during sleep.

### 2. Forgetting is a Feature
Edges decay over time. Nodes fade. This isn't a bug — it's how relevant memories stay prominent and noise fades naturally. The system models Ebbinghaus-style forgetting curves with reinforcement-based stability.

### 3. Dual Linking
Explicit links (wikilinks) create strong, intentional connections. Emergent links (co-occurrence, temporal proximity) create weak connections that strengthen through repetition. Both coexist in the graph with different visual treatment.

### 4. Incremental by Default
The parser only processes new or changed files. The graph evolves incrementally — no full rebuilds. File hashes track what's been processed.

### 5. Visualization-First
The graph isn't a data dump — it's a thinking tool. Every architectural decision serves the goal of making the graph *useful to look at and interact with*. If it doesn't help cognition, it doesn't ship.

### 6. Carbon + Silicon
The system works for AI memory files AND human journals. Same markdown, same wikilinks (Obsidian-compatible), same graph. Marcus and I could both be nodes in each other's graphs.

---

## Data Model

### Core Types

```typescript
// === NODES ===

type EntityType =
  | 'person'       // Marcus, Lobstar
  | 'project'      // tide-pool, nacre, honeycomber
  | 'tool'         // Claude Code, Codex, tmux, Vite
  | 'concept'      // GSD workflow, context engineering, decay
  | 'decision'     // "chose 3d-force-graph over sigma.js"
  | 'event'        // "first successful browser test"
  | 'lesson'       // "tmux versions must match exactly"
  | 'place'        // locations (rare for AI, common for humans)
  | 'tag';         // catch-all for hashtags and uncategorized entities

interface MemoryNode {
  id: string;                    // deterministic hash of canonical label
  label: string;                 // display name: "Marcus", "tide-pool"
  aliases: string[];             // alternative names: ["tide pool", "tide-pool-sim"]
  type: EntityType;
  
  // Temporal
  firstSeen: string;             // ISO date — when first extracted
  lastReinforced: string;        // ISO date — when last mentioned
  
  // Strength
  mentionCount: number;          // total times seen across all files
  reinforcementCount: number;    // how many consolidation cycles reinforced it
  
  // Provenance
  sourceFiles: string[];         // which files mention this entity
  excerpts: Excerpt[];           // up to N context snippets
  
  // Computed (not persisted, derived at render time)
  // currentWeight: number;      // decayed weight at render time
  // zPosition: number;          // temporal position
}

interface Excerpt {
  file: string;                  // source file path
  text: string;                  // surrounding context (~100 chars)
  date: string;                  // date of the file/section
}

// === EDGES ===

type EdgeType =
  | 'explicit'      // [[wikilink]] — strongest, intentional
  | 'co-occurrence' // same section/day — builds over time
  | 'temporal'      // same day, different sections — weakest
  | 'causal';       // "led to", "because of" — directed

interface MemoryEdge {
  id: string;                    // `${source}--${target}--${type}`
  source: string;                // source node id
  target: string;                // target node id
  type: EdgeType;
  directed: boolean;             // true for causal edges
  
  // Strength
  weight: number;                // current weight (post-decay)
  baseWeight: number;            // initial weight at creation
  reinforcementCount: number;    // times re-observed
  
  // Temporal
  firstFormed: string;           // ISO date
  lastReinforced: string;        // ISO date
  
  // Stability (Ebbinghaus-inspired)
  stability: number;             // higher = slower decay. Grows with reinforcement.
  
  // Provenance
  evidence: Evidence[];          // what created/strengthened this edge
}

interface Evidence {
  file: string;
  date: string;
  context: string;               // why this edge exists
}

// === GRAPH STATE ===

interface NacreGraph {
  version: number;               // schema version
  lastConsolidated: string;      // ISO datetime
  processedFiles: FileHash[];    // for incremental processing
  nodes: Record<string, MemoryNode>;
  edges: Record<string, MemoryEdge>;
  
  // Config
  config: GraphConfig;
}

interface FileHash {
  path: string;
  hash: string;                  // content hash for change detection
  lastProcessed: string;
}

interface GraphConfig {
  decayRate: number;             // λ — base decay rate (default: 0.015/day)
  reinforcementBoost: number;    // how much each reinforcement increases stability
  visibilityThreshold: number;   // below this weight, edges are "forgotten" (default: 0.05)
  coOccurrenceThreshold: number; // min co-occurrences before edge forms (default: 2)
  baseWeights: {
    explicit: number;            // 1.0
    coOccurrence: number;        // 0.3
    temporal: number;            // 0.1
    causal: number;              // 0.8
  };
}
```

### Entity Resolution

Entities need canonical forms to avoid duplicates:

```
"Marcus" = "marcus" = "Marcus S" → canonical: "marcus" (type: person)
"tide-pool" = "tide pool" = "Tide Pool Simulator" → canonical: "tide-pool" (type: project)
```

Resolution strategy:
1. **Exact match** on canonical label
2. **Alias match** — check all aliases
3. **Fuzzy match** — Levenshtein distance ≤ 2 for short strings, or token overlap for multi-word
4. **Manual overrides** — `entity-map.json` for corrections ("TS" → "TypeScript", not "TeamSpeak")

An `entity-map.json` file allows manual disambiguation:
```json
{
  "aliases": {
    "TS": "typescript",
    "CC": "claude-code",
    "Marcus S": "marcus"
  },
  "ignore": ["the", "it", "this", "that", "I"]
}
```

---

## Ingestion Pipeline

The parser runs in "sleep mode" — during heartbeats or as a cron job. Never real-time.

### Pipeline Stages

```
                    ┌─────────────────┐
                    │  1. Discovery    │ Scan for new/changed markdown files
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │  2. Parse        │ Markdown → AST (remark/unified)
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │  3. Extract      │ AST → entities + relationships
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │  4. Resolve      │ Entity deduplication + canonicalization
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │  5. Update       │ Merge into graph (create/reinforce)
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │  6. Decay        │ Apply forgetting curve to all edges
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │  7. Persist      │ Save graph.json + optional history snapshot
                    └────────┘
```

### Stage 1: File Discovery

```typescript
interface DiscoveryResult {
  newFiles: string[];       // never seen before
  changedFiles: string[];   // hash changed since last process
  unchangedFiles: string[]; // skip these
}
```

Scans configured directories:
- `memory/*.md` — daily logs (primary source)
- `MEMORY.md` — curated long-term memory
- `TOOLS.md`, `USER.md` — reference docs
- Custom paths via config

Uses SHA-256 content hashing for change detection. Only new/changed files enter the pipeline.

### Stage 2: Markdown Parsing

Uses `unified` + `remark-parse` to produce an mdast AST. Preserves document structure:
- Heading hierarchy (H1 > H2 > H3 = nesting context)
- Sections (content between headings = co-occurrence scope)
- Lists, bold text, inline code, links

Key: **Section boundaries define co-occurrence scope.** Two entities in the same H2 section are co-occurring. Two entities in different H2 sections of the same file are temporally proximate but not co-occurring.

### Stage 3: Entity Extraction

Hybrid approach — three extractors run in parallel:

**A. Structural Extractor** (regex-based, highest precision)
- `[[wikilinks]]` → explicit entity + explicit edge to current context
- `**bold terms**` → candidate entity (if >2 chars, not a stop word)
- `# Headings` → topic entity for the section
- `` `code references` `` → tool/project entity
- `YYYY-MM-DD` in filenames/text → temporal anchor

**B. NLP Extractor** (compromise.js)
- People: `.people()` — names like "Marcus", "John Doe"
- Places: `.places()` — "New York", "CachyOS" (limited)
- Organizations: `.organizations()` — "Google", "Anthropic"
- Good for casual prose, weak on technical terms

**C. Custom Domain Extractor** (rule-based)
- Known project names from entity-map.json
- Tool names: Claude Code, Codex, Vite, tmux, etc.
- Pattern matching: GitHub URLs → project, npm packages → tool
- Hashtags: `#concept` → tag entity

Each extractor emits `RawEntity[]`:
```typescript
interface RawEntity {
  text: string;           // raw extracted text
  type: EntityType;       // best-guess type
  confidence: number;     // 0-1
  source: 'structural' | 'nlp' | 'custom';
  position: {
    file: string;
    section: string;      // heading path: "## Projects > ### Tide Pool"
    line: number;
  };
}
```

### Stage 4: Entity Resolution

Raw entities go through resolution:

1. Normalize: lowercase, trim, collapse whitespace
2. Check canonical map (entity-map.json)
3. Check alias map on existing nodes
4. Fuzzy match against existing nodes (Levenshtein ≤ 2)
5. If no match and confidence > 0.5: create new node
6. If confidence ≤ 0.5: skip (log for manual review)

Output: `ResolvedEntity[]` with canonical node IDs.

### Stage 5: Graph Update

For each file processed:

**Nodes:**
- New entity → create node with initial values
- Known entity → increment `mentionCount`, update `lastReinforced`, add source file, append excerpt

**Edges:**
- `[[wikilink]]` → create/reinforce explicit edge (weight = baseWeights.explicit)
- Entities in same section → create/reinforce co-occurrence edge
  - BUT: only create new co-occurrence edges when `coOccurrenceCount >= config.coOccurrenceThreshold`
  - Track pending co-occurrences in a separate counter map
  - This prevents spurious edges from one-time mentions
- Entities in same file, different sections → create/reinforce temporal edge
- Causal language detected → create/reinforce causal edge (directed)

**Reinforcement:**
- Existing edge re-observed → increment `reinforcementCount`, update `lastReinforced`, increase `stability`, reset decay clock
- Stability formula: `stability = 1 + config.reinforcementBoost * ln(reinforcementCount + 1)`

### Stage 6: Decay

After all updates, apply decay to **every** edge:

```typescript
function decayEdge(edge: MemoryEdge, now: Date, config: GraphConfig): number {
  const daysSinceReinforced = daysBetween(edge.lastReinforced, now);
  const effectiveDecayRate = config.decayRate / edge.stability;
  const decayedWeight = edge.baseWeight * Math.exp(-effectiveDecayRate * daysSinceReinforced);
  return Math.max(decayedWeight, 0);
}
```

Edges below `visibilityThreshold` are marked dormant (not deleted — they can be revived).

Nodes with no visible edges become orphans and fade visually, but persist in the graph.

### Stage 7: Persistence

Save to `data/graph.json`. Optionally snapshot to `data/history/YYYY-MM-DD.json` (configurable frequency — daily or weekly).

---

## Decay & Reinforcement Model

This is the heart of Nacre. The math that makes forgetting intelligent.

### The Forgetting Curve

Based on Ebbinghaus (1885), adapted for knowledge graphs:

```
weight(t) = W₀ · e^(-λt/S)
```

Where:
- `W₀` = base weight (determined by edge type)
- `λ` = base decay rate (configurable, default 0.015/day)
- `t` = days since last reinforcement
- `S` = stability factor (grows with reinforcement)

### Stability Growth

Each time an edge is reinforced, its stability increases:

```
S = 1 + β · ln(R + 1)
```

Where:
- `β` = reinforcement boost factor (default: 1.5)
- `R` = reinforcement count

This means:

| Reinforcements | Stability | Half-life (days) |
|----------------|-----------|-------------------|
| 0              | 1.0       | 46                |
| 1              | 2.0       | 92                |
| 3              | 3.1       | 143               |
| 7              | 4.1       | 189               |
| 15             | 5.2       | 240               |
| 30             | 6.1       | 281               |

A connection mentioned once fades in ~46 days. A connection reinforced 7 times lasts ~6 months. This feels right — important recurring themes persist, one-off mentions gracefully fade.

### Edge Type Base Weights

| Edge Type      | Base Weight | Rationale |
|----------------|-------------|-----------|
| `explicit`     | 1.0         | Intentional link — strongest signal |
| `causal`       | 0.8         | Directional relationship — strong signal |
| `co-occurrence`| 0.3         | Same section — moderate signal |
| `temporal`     | 0.1         | Same day — weak signal |

### Threshold Formation

Co-occurrence edges don't form on first sight. They require `coOccurrenceThreshold` (default: 2) observations before becoming real edges. This prevents noise from one-time coincidences.

The system tracks pending co-occurrences:
```typescript
interface PendingEdge {
  source: string;
  target: string;
  type: 'co-occurrence' | 'temporal';
  count: number;          // observations so far
  firstSeen: string;
  evidence: Evidence[];
}
```

When count ≥ threshold, the pending edge graduates to a real edge.

### Decay Alerts

During consolidation, the system can flag edges approaching the visibility threshold:

```typescript
interface DecayAlert {
  edge: MemoryEdge;
  currentWeight: number;
  daysUntilForgotten: number;  // estimated
  suggestion: string;           // "Review: Marcus ↔ strata hasn't been reinforced in 3 weeks"
}
```

These alerts feed into Clawdbot integration — surfaced during heartbeats or session startup.

---

## Visualization Layer

### Technology

**Primary**: `3d-force-graph` (Three.js + WebGL)
- 5.5k stars, actively maintained
- Handles 4k+ nodes smoothly
- Swappable physics: d3-force-3d or ngraph
- React wrapper: `react-force-graph-3d`

**Why not alternatives?**
- sigma.js: 2D only, no native 3D
- Cytoscape.js: 2D focus, extensions for 3D are clunky
- Raw Three.js: too low-level for graph layout
- D3 alone: SVG chokes at 500+ nodes

### Temporal Z-Axis

The z-axis represents time. Recent memories are close (z ≈ 0), older memories recede into depth.

**Implementation**: Custom force in d3-force-3d that pins the z-coordinate:

```typescript
function temporalForce(alpha: number) {
  for (const node of nodes) {
    const daysSinceReinforced = daysBetween(node.lastReinforced, now);
    const targetZ = -daysSinceReinforced * zScale; // 1 day ≈ -1 unit
    
    // Strong pull toward temporal position (not a hard pin — allows some flex)
    node.vz += (targetZ - node.z) * 0.3 * alpha;
  }
}
```

X and Y settle freely via force-directed layout. Z is constrained to temporal position. This gives organic 2D clustering within temporal layers — like geological strata.

### Visual Encoding

| Property | Encodes | Range |
|----------|---------|-------|
| **Node size** | Connection count + reinforcement | 3px (orphan) → 20px (hub) |
| **Node brightness/opacity** | Current decayed weight | 0.1 (fading) → 1.0 (strong) |
| **Node color** | Entity type | Person: warm gold, Project: teal, Tool: silver, Concept: violet, etc. |
| **Node glow** | Recently reinforced | Soft bloom for nodes reinforced in last 7 days |
| **Edge width** | Weight | 0.5px (weak) → 3px (strong) |
| **Edge style** | Type | Solid: explicit, Dashed: co-occurrence, Dotted: temporal, Arrow: causal |
| **Edge color** | Weight gradient | Dim gray (fading) → iridescent nacre shimmer (strong) |

### Nacre Aesthetic

The signature visual: strong edges shimmer with nacre-like iridescence. Implemented via:
- Custom Three.js shader material on edge lines
- Hue shifts based on viewing angle (thin-film interference simulation)
- Subtle rainbow gradient: pink → gold → green → blue → violet
- Only visible on edges above 50% weight — fading edges are matte gray

This isn't just pretty — it makes strong connections *visually distinctive* at a glance.

### Interaction

- **Orbit**: rotate the 3D space, see clusters from different angles
- **Hover node**: highlight connected edges, show label + type + strength
- **Click node**: focus view — show local neighborhood (1-2 hops), display details panel with excerpts
- **Time scrub**: slider that adjusts the temporal viewport — see the graph at any point in history
- **Filter**: toggle entity types, edge types, min weight threshold
- **Search**: find nodes by label, jump camera to location
- **Zoom to cluster**: double-click empty space near a cluster to zoom in

### Level of Detail (LOD)

At full zoom-out:
- Only nodes with weight > 0.3 visible
- Labels hidden, just colored dots
- Only strongest 30% of edges drawn

At medium zoom:
- All non-dormant nodes visible
- Labels on hover
- All visible edges drawn

At close zoom:
- All nodes including dormant (dimmed)
- Labels always visible
- Excerpts on hover
- Edge evidence on hover

---

## Integration Layer

### Clawdbot Hooks

Nacre integrates with Clawdbot at three touchpoints:

#### 1. Consolidation (Heartbeat/Cron)

During heartbeat or scheduled cron:
```bash
nacre consolidate --source /workspace/memory/ --source /workspace/MEMORY.md
```

The CLI:
1. Runs the full ingestion pipeline
2. Outputs a summary: "Processed 3 new files. 12 entities reinforced, 2 new nodes, 5 new edges, 3 edges decayed below threshold."
3. Generates decay alerts if any
4. Saves updated graph

Recommended frequency: once per heartbeat cycle, or daily via cron.

#### 2. Context Priming (Session Start)

When I wake up, instead of reading the whole MEMORY.md top to bottom, query the graph:

```bash
nacre brief --top 20 --recent 7d
```

Returns the 20 most relevant nodes based on:
- Recent reinforcement (last 7 days)
- High connectivity (hub nodes)
- Active edges (not decaying)

Output: A concise briefing paragraph:
```
Active clusters: tide-pool (Phase 2 complete, linked to Vite/Three.js/bitECS), 
nacre (research phase, linked to 3d-force-graph/wink-nlp/Ebbinghaus), 
Marcus (connected to all projects, last seen today).
Fading: strata (12 days since reinforced, 3 connections), 
honeycomber (v1.5 complete, naturally fading).
```

#### 3. Active Recall (Query)

Ask the graph questions:

```bash
nacre query "Marcus" --hops 2
nacre query "D3" --related
nacre query --fading --days 14
nacre query --clusters
```

Returns structured JSON for programmatic use or formatted text for human consumption.

### API (Future)

For deeper integration, a simple HTTP API:

```
GET  /api/graph                 — full graph state
GET  /api/nodes/:id             — single node + edges
GET  /api/query?q=term&hops=2   — graph query
POST /api/consolidate           — trigger consolidation
GET  /api/brief                 — context briefing
GET  /api/alerts                — decay alerts
```

Served by the viz layer's dev server or a lightweight standalone server.

---

## Project Structure

```
nacre/
├── package.json                  # Workspace root (npm workspaces)
├── tsconfig.base.json            # Shared TS config
│
├── packages/
│   ├── core/                     # Data model + graph operations
│   │   ├── src/
│   │   │   ├── types.ts          # All type definitions
│   │   │   ├── graph.ts          # Graph CRUD operations
│   │   │   ├── decay.ts          # Forgetting curve math
│   │   │   ├── resolve.ts        # Entity resolution
│   │   │   └── query.ts          # Graph queries
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── parser/                   # Ingestion pipeline
│   │   ├── src/
│   │   │   ├── pipeline.ts       # Orchestrator
│   │   │   ├── discover.ts       # File discovery + hashing
│   │   │   ├── parse.ts          # Markdown → AST
│   │   │   ├── extract/
│   │   │   │   ├── structural.ts # Wikilinks, bold, headers
│   │   │   │   ├── nlp.ts        # compromise.js NER
│   │   │   │   └── custom.ts     # Domain-specific rules
│   │   │   └── merge.ts          # Merge extractions into graph
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── viz/                      # 3D visualization frontend
│   │   ├── src/
│   │   │   ├── main.ts           # Entry point
│   │   │   ├── graph-view.ts     # 3d-force-graph setup
│   │   │   ├── forces.ts         # Custom forces (temporal z)
│   │   │   ├── materials.ts      # Nacre shader, node materials
│   │   │   ├── controls.ts       # Time scrub, filters, search
│   │   │   ├── details.ts        # Node/edge detail panels
│   │   │   └── theme.ts          # Color schemes, visual config
│   │   ├── index.html
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── cli/                      # Command-line interface
│       ├── src/
│       │   ├── index.ts          # CLI entry (citty or commander)
│       │   ├── commands/
│       │   │   ├── consolidate.ts
│       │   │   ├── query.ts
│       │   │   ├── brief.ts
│       │   │   ├── export.ts
│       │   │   └── serve.ts      # Start viz dev server
│       │   └── output.ts         # Formatters (JSON, text, markdown)
│       ├── package.json
│       └── tsconfig.json
│
├── data/
│   ├── graph.json                # Current graph state
│   ├── entity-map.json           # Manual entity overrides
│   ├── pending-edges.json        # Sub-threshold co-occurrences
│   └── history/                  # Periodic snapshots
│       └── 2026-01-30.json
│
└── docs/
    ├── ARCHITECTURE.md           # This file
    ├── CONCEPT.md                # Vision and research
    └── research/                 # Perplexity research reports
```

### Monorepo Setup

- **Package manager**: npm workspaces (or pnpm)
- **Build**: Vite for viz, tsup/unbuild for core/parser/cli
- **Runtime**: Node.js (parser, CLI), Browser (viz)
- **Language**: TypeScript throughout

---

## Technology Decisions

### Decided

| Component | Choice | Rationale |
|-----------|--------|-----------|
| **Language** | TypeScript | Shared across all packages, Marcus has deep TS experience |
| **Build (frontend)** | Vite | Already using for tide-pool, fast, good DX |
| **Build (packages)** | tsup | Fast, zero-config TS bundler for Node packages |
| **3D Graph** | 3d-force-graph | Best-in-class 3D force graph, WebGL, 4k+ nodes, MIT |
| **Physics** | d3-force-3d | Default engine, well-documented, custom force support |
| **Markdown** | unified + remark-parse | Standard, produces AST, huge plugin ecosystem |
| **NLP** | compromise.js | Lightweight, browser-compatible, good for casual text |
| **Persistence** | JSON files | Simple, version-controllable, sufficient for <10k nodes |
| **CLI** | citty (or commander) | Lightweight CLI framework |

### Deferred

| Component | Options | Decision Point |
|-----------|---------|----------------|
| **SQLite** | Better queries, single file | When JSON gets slow (>5k nodes?) |
| **Embeddings** | Semantic similarity edges | Phase 4+ — needs model inference |
| **WebGPU** | Next-gen rendering | When browser support is >90% |
| **LLM-assisted extraction** | Better entity typing/resolution | Phase 4+ — expensive but powerful |
| **Real-time updates** | WebSocket push from parser | When viz is always-on dashboard |

---

## Phase Plan

### Phase 1: Core Engine + Parser — *"First Memories"*

**Goal**: Run `nacre consolidate` and get a valid graph.json from markdown files.

**Deliverables**:
- `@nacre/core`: Types, graph CRUD, decay math, entity resolution
- `@nacre/parser`: Full ingestion pipeline (discover → parse → extract → resolve → update → decay → persist)
- `@nacre/cli`: `nacre consolidate` and `nacre query` commands
- Test coverage for decay math and entity resolution
- Process my actual memory files and produce a real graph

**Success criteria**: Run consolidate on `memory/` directory, get graph.json with 50+ nodes and 100+ edges. Verify decay math produces sensible weights.

### Phase 2: Visualization — *"Opening the Window"*

**Goal**: See the graph in the browser.

**Deliverables**:
- `@nacre/viz`: 3d-force-graph with temporal z-axis
- Visual encoding: node size/color/brightness, edge style/width/color
- Nacre iridescent shader for strong edges
- Basic interaction: orbit, hover, click, search
- Load graph.json and render

**Success criteria**: Open browser, see my memory graph in 3D with temporal depth. Identify at least 3 natural clusters. Strong connections visibly shimmer.

### Phase 3: Integration — *"Thinking Tool"*

**Goal**: Nacre becomes part of my daily workflow.

**Deliverables**:
- `nacre brief` command for session startup
- Heartbeat hook: auto-consolidation during heartbeats
- Decay alerts surfaced in Clawdbot
- `nacre query` with natural language-ish queries
- Time scrub slider in viz

**Success criteria**: Wake up, run `nacre brief`, get useful context. During heartbeats, graph updates automatically. Decay alerts catch fading connections I want to keep.

### Phase 4: Intelligence — *"Emergent Insight"*

**Goal**: The graph starts telling me things I didn't know.

**Deliverables**:
- Consolidation suggestions: "These nodes keep co-occurring, should they be linked?"
- Cluster detection and auto-labeling
- Evolution replay: time-lapse of graph growth
- Graph-guided memory maintenance: "These 3 things from last week are significant"
- Optional: semantic similarity edges via embeddings

**Success criteria**: Nacre surfaces at least one connection I didn't consciously make. Evolution replay shows visible growth patterns over weeks.

---

## Open Questions & Future Work

### Architecture Questions

1. **Entity type inference**: Should the NLP layer try to auto-classify entities, or should we lean on entity-map.json? Auto-classification risks errors; manual mapping is tedious but accurate. **Leaning toward**: hybrid — auto-classify with high confidence threshold, flag ambiguous ones for manual review.

2. **Graph merging**: If Marcus also generates a graph from his notes, how do they merge? Shared entity IDs? Separate graphs with cross-references? **Leaning toward**: separate graphs, shared entity vocabulary via entity-map.json.

3. **History compression**: Daily snapshots of graph.json will get big. Delta compression? Only store diffs? **Leaning toward**: weekly snapshots + deltas, compress old snapshots.

4. **Real-time preview**: Should the viz update live as the parser runs? Or always load a static snapshot? **Leaning toward**: static snapshots for now, WebSocket push later if needed.

5. **Multi-graph views**: Personal graph, project graph, combined? Filter by source directory? **Leaning toward**: single graph with source-based filtering in the viz layer.

### Future Possibilities

- **Session recording**: During live sessions, log entity mentions to a buffer. On next consolidation, the buffer feeds the pipeline. No real-time graph updates, but no lost data either.

- **Bidirectional editing**: Click a node in the graph, edit its type/aliases/connections. Changes propagate to entity-map.json. The graph becomes editable, not just viewable.

- **Export to Obsidian**: Generate a vault of interconnected markdown files from the graph. Each node becomes a note, each edge becomes a wikilink. Nacre as a graph-first note system.

- **Collaborative graphs**: Multiple agents/humans contribute to the same graph. Conflict resolution via vector clocks or CRDTs. Way future.

- **Voice narration**: "Walk me through my graph" — use TTS to narrate the graph's evolution, highlight clusters, explain connections. Storytime with data.

---

*"The graph isn't a map of what I know. It's a map of how I think. And like all living things, it grows, it forgets, and it remembers what matters."*

— Lobstar 🦞

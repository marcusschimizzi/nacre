# Nacre

> Biological memory for long-living AI agents.

Nacre is an open-source memory layer for AI agents that models how memory actually works — formation, consolidation, decay, reinforcement, and emergent connection discovery.

Built for agents that live for months, not minutes.

## Why Nacre?

Every AI agent wakes up with amnesia. Context windows are finite, conversation history gets truncated, and the agent that helped you yesterday has no idea what it learned.

Current memory solutions are either **shallow** (vector search over past messages), **naive** (stuff everything into context), or **generic** (designed for chatbots, not persistent agents).

Nacre is different:

- **Graph-native** — memories are connected, not just stored. Relationships between entities are first-class, with typed edges and provenance tracking.
- **Biologically-inspired** — Ebbinghaus decay curves with reinforcement-based stability. Important memories strengthen over time; noise fades naturally.
- **Sleep/wake consolidation** — like hippocampal replay, nacre processes experience in batch during idle periods. Connections form during "sleep," not in real-time.
- **Local-first** — your agent's memory is a directory on disk. No cloud service required. Copy it, back it up, version control it.
- **Observable** — a 3D force-directed visualization lets you see, explore, and debug the memory graph. No black boxes.

## Quick Start

```bash
# Install
npm install -g @nacre/cli

# Point nacre at your markdown files and consolidate
nacre consolidate --input ./my-notes --graph ./data/my-graph

# Get a briefing on what's in the graph
nacre brief --graph ./data/my-graph

# Query the graph
nacre query "typescript" --graph ./data/my-graph

# Check for fading memories and emerging topics
nacre alerts --graph ./data/my-graph

# Get connection suggestions and cluster analysis
nacre insights --graph ./data/my-graph

# Launch the visualization
nacre serve --graph ./data/my-graph
```

## How It Works

### 1. Ingestion

Nacre reads markdown files (Obsidian-compatible) and extracts entities and relationships using three extraction layers:

- **Structural** — headings, wikilinks, frontmatter, code blocks, lists
- **NLP** — noun phrases, capitalized terms, technical vocabulary
- **Custom** — configurable patterns for known tools, projects, and people

### 2. Graph Construction

Extracted entities become **nodes** (typed: person, project, tool, concept, decision, event, lesson). Relationships become **edges** (typed: explicit, co-occurrence, temporal, causal) with weights, stability scores, and provenance.

Entity resolution uses Levenshtein fuzzy matching and alias tracking to merge duplicates.

### 3. Decay & Reinforcement

Edges decay over time following an Ebbinghaus forgetting curve:

```
weight(t) = baseWeight × e^(-λt/stability)
```

Where `λ` is the decay rate and `stability` grows with reinforcement. Re-encountering a memory increases its stability, slowing future decay — just like real memory.

### 4. Intelligence

Beyond storage, nacre actively analyzes the graph:

- **Connection suggestions** — edges that are close to forming (pending near threshold), structural holes (two clusters that should be connected), and type bridges (e.g., a tool used by two unconnected projects)
- **Cluster detection** — labeled groups of related entities with dominant types
- **Significance analysis** — emerging topics (new, growing fast), anchor nodes (central, stable), and fading important connections (need attention)

### 5. Visualization

A 3D force-directed graph rendered with Three.js and a custom nacre iridescent GLSL shader (Fresnel thin-film interference). Features temporal scrubbing, search, cluster zoom, and node detail panels.

## Architecture

```
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│  Parser   │───▶│   Core   │───▶│   Viz    │    │  CLI /   │
│ Pipeline  │    │  Engine  │    │  Layer   │    │  API     │
└──────────┘    └──────────┘    └──────────┘    └──────────┘
     ▲               │               ▲               │
     │               ▼               │               ▼
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│ Markdown  │    │  Graph   │    │ Browser  │    │  Agent   │
│  Files    │    │  Store   │    │          │    │  Hooks   │
└──────────┘    └──────────┘    └──────────┘    └──────────┘
```

### Packages

| Package | Description |
|---------|-------------|
| `@nacre/core` | Graph data model, decay math, entity resolution, query engine, intelligence layer |
| `@nacre/parser` | File discovery, markdown→AST, entity extraction (structural + NLP + custom), merge pipeline |
| `@nacre/viz` | 3D force-directed graph with Three.js, iridescent shader, time scrub, search |
| `@nacre/cli` | Command-line interface: consolidate, query, brief, alerts, insights, suggest, serve |

## Configuration

### Entity Map

Create `data/entity-map.json` to customize entity extraction:

```json
{
  "aliases": {
    "TS": "typescript",
    "JS": "javascript"
  },
  "ignore": ["the", "it", "this", "..."]
}
```

See `data/entity-map.example.json` for a full example.

### Graph Config

Default configuration (tunable per graph):

```json
{
  "decayRate": 0.015,
  "reinforcementBoost": 1.5,
  "visibilityThreshold": 0.05,
  "coOccurrenceThreshold": 2,
  "baseWeights": {
    "explicit": 1.0,
    "coOccurrence": 0.3,
    "temporal": 0.1,
    "causal": 0.8
  }
}
```

## Development

```bash
# Clone
git clone https://github.com/yourusername/nacre.git
cd nacre

# Install dependencies
npm install

# Run tests
npm test              # core tests
npm run test:parser   # parser tests
npm run test:all      # everything

# Build all packages
npm run build

# Type check
npm run typecheck
```

## Roadmap

See [docs/ROADMAP.md](docs/ROADMAP.md) for the full roadmap. Key upcoming milestones:

- **SQLite storage** — migrate from JSON to SQLite for scale and vector support
- **Embedding layer** — semantic similarity search alongside graph queries
- **MCP server** — instant integration with Claude Desktop, Cursor, and other MCP clients
- **REST API & SDKs** — programmatic memory access for any agent framework
- **Episodic & procedural memory** — formalized event records and learned behaviors

## Design Principles

1. **Biological fidelity** — memory science informs architecture, not just marketing
2. **Local-first, cloud-optional** — a nacre memory is a directory on disk
3. **Graph-native** — the knowledge graph is primary, not a secondary index
4. **Observable** — you can see the memory, inspect it, debug it
5. **Incremental** — never rebuild from scratch; evolve continuously
6. **Carbon + silicon** — works for AI agents and human knowledge workers alike

## License

[Apache License 2.0](LICENSE)

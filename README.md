# Nacre

A spatial memory graph that turns flat markdown files into a living knowledge graph with temporal depth, intelligent forgetting, and emergent connection discovery.

Nacre is general-purpose tooling — not tied to any specific agent or workflow. Point it at a directory of markdown files, run `nacre consolidate`, and get a graph with entities, relationships, decay curves, and a 3D visualization.

## Quick Start

```bash
npm install
npm run build

# Ingest markdown files
npx nacre consolidate ./my-notes/

# See what's in the graph
npx nacre brief

# Search for something
npx nacre query -s "typescript"

# Launch the 3D visualization
npx nacre serve
```

## How It Works

**Ingestion** reads markdown files and extracts entities (people, projects, tools, concepts, decisions, events, lessons, places, tags) using three layers: structural analysis (wikilinks, bold terms, headings, code refs), NLP via compromise.js, and custom pattern matching (GitHub URLs, hashtags, scoped npm packages).

**Entity resolution** deduplicates extractions through normalization, alias lookup (configurable via `entity-map.json`), exact matching on existing labels, and fuzzy matching (Levenshtein distance for short strings, token overlap for long ones).

**Relationship detection** produces four edge types:
- **Explicit** — `[[wikilinks]]` in markdown
- **Co-occurrence** — entities mentioned in the same section or day
- **Temporal** — events close in time
- **Causal** — detected via phrases like "led to", "because of"

**Decay** follows the Ebbinghaus forgetting curve: `W(t) = W0 * e^(-lambda*t/S)` where stability `S = 1 + beta * ln(R+1)` grows with reinforcement count. Unreinforced edges fade; re-mentioned connections strengthen. Edges below the visibility threshold (0.05) go dormant.

**Incremental processing** uses SHA-256 content hashing — only new or changed files get reprocessed.

## Project Structure

```
packages/
  core/     Data model, graph CRUD, decay math, entity resolution, queries, intelligence
  parser/   7-stage pipeline: discover -> parse -> extract -> resolve -> update -> decay -> persist
  viz/      3D force-directed graph (Three.js / WebGL via 3d-force-graph)
  cli/      Command-line interface (7 commands)
data/       Graph output, entity map
test/       Integration tests and fixtures (131 tests)
```

## CLI Commands

All commands support `--format json` for programmatic use. Default graph path: `data/graphs/default/graph.json`.

### consolidate

Run the ingestion pipeline on markdown files.

```bash
nacre consolidate <source> [--out=data/graphs/default] [--entity-map=data/entity-map.json]
```

Produces `graph.json` and `pending-edges.json` in the output directory.

### query

Look up entities in the graph.

```bash
nacre query <search> [--hops=1] [--related] [--fading] [--clusters] [--brief]
nacre query -s "search terms" [--type=person] [--since=7]
```

Modes: neighborhood traversal (default), `--related` (by edge weight), `--fading` (approaching dormancy), `--clusters`, `--brief`, or `-s` for fuzzy multi-term search. Filter with `--type` and `--since`.

### brief

Context briefing — top entities, active nodes, fading edges, clusters, graph stats.

```bash
nacre brief [--top=20] [--recent-days=7]
```

### alerts

Health check — fading connections, orphan nodes, overall health score.

```bash
nacre alerts
```

### suggest

Connection suggestions — pending edges near threshold, structural holes, type bridges.

```bash
nacre suggest [--pending=...] [--max=10]
```

### insights

Significance analysis — emerging topics, anchor nodes, fading-but-important entities.

```bash
nacre insights [--recent-days=7]
```

### serve

Launch the 3D visualization. Copies graph.json into the viz package and starts a Vite dev server.

```bash
nacre serve [--graph=data/graphs/default/graph.json] [--port=5173] [--no-open]
```

## Visualization

The viz is a force-directed 3D graph built on Three.js/WebGL:

- Temporal z-axis — older nodes recede into depth, recent ones stay in the foreground
- Node size scales with connectivity and mention count (log scale)
- Node color by entity type, opacity by connection strength
- Glow on recently reinforced nodes (< 7 days)
- Iridescent nacre shader on strong edges (weight >= 0.5) — Fresnel-based spectral color that shifts with camera angle
- Hover tooltips on nodes (label, type, connections) and edges (source/target, weight, evidence context)
- Click to fly-to-node with details panel (excerpts, sources, dates, neighbors)
- Double-click a node to frame its 1-hop neighborhood
- Labels appear as camera gets close (< 150 units)
- Search bar, entity/edge type filter toggles, weight threshold slider
- Time scrub slider with play/pause for evolution replay

## Entity Map

Customize entity resolution with `data/entity-map.json`:

```json
{
  "aliases": {
    "marcus": "Marcus S",
    "ms": "Marcus S",
    "vscode": "VS Code"
  },
  "ignore": ["the", "this", "that", "monday", "tuesday"]
}
```

Aliases map variant names to canonical forms. Ignored terms are skipped during extraction.

## Data Model

Graph version: **2** (breaking change from v1 — relative paths in processedFiles, 16-char node IDs). Re-run consolidation to migrate from v1.

**Nodes**: 16-char hex ID (SHA-256 of normalized label), label, aliases, entity type, timestamps, mention/reinforcement counts, source files, excerpts.

**Edges**: ID as `source--target--type`, weight with Ebbinghaus decay, stability, evidence array (capped at 20 entries).

**Decay parameters** (defaults): decay rate 0.015, reinforcement boost 1.5, visibility threshold 0.05, co-occurrence threshold 2.

## Development

```bash
npm run build          # Build all 4 packages
npm run test:all       # Run all 131 tests
npm run test           # Core tests only
npm run test:parser    # Parser tests only
npm run test:integration  # Integration tests only
```

The viz dev server runs independently:

```bash
cd packages/viz && npx vite
```

## Tech Stack

TypeScript, Vite, tsup, npm workspaces, 3d-force-graph, Three.js, compromise.js, unified/remark-parse, citty, JSON persistence.

## Further Reading

- `CONCEPT.md` — vision, research findings, design principles
- `ARCHITECTURE.md` — full technical architecture, data model details, phase plan
- `research/` — technology research reports

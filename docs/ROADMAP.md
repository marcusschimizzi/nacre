# Nacre — Roadmap

> From personal memory graph to Memory-as-a-Service.

Last updated: 2026-06-08

---

## Where We Are Today

Nacre has grown well past its original "produce a graph.json from markdown" goal.
It's now a full memory engine with SQLite storage, embeddings, hybrid recall,
episodic + procedural memory, temporal queries, a REST API, an MCP server, a
TypeScript SDK, and a federated multi-agent ("hive") layer.

**What exists and works:**

- **Core graph engine** — typed nodes/edges, Ebbinghaus decay math, entity
  resolution (Levenshtein fuzzy matching), query engine, intelligence layer
  (connection suggestions, labeled clusters, significance analysis, structural
  holes).
- **SQLite store** (`@nacre/core` `SqliteStore`) — `better-sqlite3`, WAL mode,
  schema v5 with in-place migrations, snapshot tables. JSON import/export kept
  for portability and viz.
- **Parser pipeline** — file discovery (SHA-256 change detection), markdown→AST
  (unified/remark), four extraction layers (structural + NLP + custom + optional
  LLM), merge pipeline with co-occurrence thresholds.
- **Embeddings** — pluggable providers (`mock`, `onnx`, `ollama`, `openai`);
  embeddings generated during consolidation for nodes and episodes.
- **Hybrid recall** — semantic (vector) + graph-walk + recency + importance
  score fusion, with tunable weights, time filters, and `--asOf` point-in-time
  queries.
- **Episodic memory** — first-class episodes with entity links, extracted from
  markdown and conversations.
- **Procedural memory** — lessons / preferences / skills / antipatterns /
  heuristics with confidence, contradiction tracking, and trigger matching.
- **Temporal queries** — snapshots on consolidation, point-in-time recall, node
  and edge history.
- **Conversation ingestion** — chunking + extraction + episode creation, with
  format adapters.
- **REST API** — Hono server (`nacre api`) exposing graph, memory, intelligence,
  search, episodes, procedures, temporal, and ingest routes.
- **MCP server** — `nacre mcp` exposes `nacre_recall`, `nacre_brief`,
  `nacre_remember`, `nacre_forget`, `nacre_feedback`, `nacre_lesson`,
  `nacre_procedures`.
- **TypeScript SDK** — `@nacre/sdk` with local (embedded) and remote (HTTP)
  backends behind one interface.
- **Hive graph** — federated multi-agent consolidation (`nacre hive`) merging
  several agents' graphs with provenance tracking and origin-factor discounting.
- **Visualization** — 3D force graph (Three.js, custom iridescent shader), time
  scrub, search, cluster zoom, node details.
- **CLI** — 21 subcommands (consolidate, query, brief, alerts, suggest,
  insights, recall, similar, embed, episodes, procedures, snapshots, history,
  ingest, api, mcp, viz, dashboard, hive, migrate).

**Health (verified 2026-06-08, after `npm install && npm run build`):**

- Tests: 485 / 486 passing (the one failure is `OnnxEmbedder`, which needs the
  optional `@huggingface/transformers` package).
- Typecheck: clean across all workspaces.
- Build: clean.

---

## Completed Milestones

The detailed implementation plans for these now live in the code itself; this is
the historical record of what shipped.

| # | Milestone | Notes |
|---|-----------|-------|
| M0 | Repo cleanup & OSS prep | LICENSE (Apache-2.0), README rewrite, package metadata. CI still pending — see below. |
| M1 | SQLite migration | `SqliteStore`, schema + migrations, JSON import/export. |
| M2 | Embedding layer | mock / onnx / ollama / openai providers. |
| M3 | API server | Hono, `nacre api`, route groups + zod validation. |
| M4 | Episodic memory | episodes + episode-entity links. |
| M5 | Hybrid recall | semantic + graph + recency + importance fusion. |
| M6 | MCP server | 7 tools wired to core. |
| M7 | TypeScript SDK | local + remote backends. |
| M8 | Procedural memory | lessons/preferences/skills/antipatterns/heuristics. |
| M9 | Conversation ingester | chunking + episodes + format adapters. |
| M10 | Temporal queries | snapshots, point-in-time recall, history. |
| M11 | Hive graph (unplanned bonus) | federated multi-agent consolidation. |

---

## Known Issues & Tech Debt

Tracked here so they don't get lost. Several are small but user-visible.

- [ ] **CI**: no GitHub Actions yet. Tests need `npm install && npm run build`
      first (cross-package tests import `@nacre/core`/`@nacre/parser` by name →
      resolve to `dist/`). Add CI + consider tsconfig path aliases so tests can
      run against `src/` without a build step.
- [ ] **Web-session setup**: add a SessionStart hook so Claude Code web sessions
      auto-install and build.
- [ ] **MCP recall uses the mock embedder**: `nacre_recall` resolves the `mock`
      provider when embeddings exist, causing a dimension mismatch with real
      stored vectors (semantic scores come back empty → graph-only recall). It
      should read the store's actual provider.
- [ ] **Brute-force vector search**: `searchSimilar()` loads every embedding and
      computes cosine in JS (O(n) per query). Integrate `sqlite-vec` for scale.
- [ ] **Nodes never decay**: only edges follow the Ebbinghaus curve; nodes
      accumulate forever. Add node-level dormancy to deliver on "intelligent
      forgetting."
- [ ] **Two viz frontends**: `@nacre/viz` (vanilla TS) and `@nacre/dashboard`
      (React 19) overlap. Pick one and retire the other.
- [ ] **Dependency audit**: `npm install` reports vulnerabilities; run an audit
      pass.
- [ ] **Default embedding provider mismatch**: store defaults to `ollama`; README
      says `onnx` is the local default. Reconcile.
- [ ] **`sql.js` dependency** appears unused now that `better-sqlite3` is the
      store — confirm and remove if dead.

---

## Remaining Milestones

### M12: Visualization Dashboard
*Polish the secret weapon — turn the viz from a dev tool into a product feature.*

**Depends on:** M3 (API, for live data), M5 (recall, for search)
**Scope:** medium-large (5-7 days)

The viz exists and looks great, but the dashboard still reads a static
`public/graph.json` rather than the live API.

- [ ] **Live data**: fetch from the API instead of static JSON
- [ ] **Consolidate frontends**: settle on one of `viz` / `dashboard`
- [ ] **Memory health dashboard**: decay rates, reinforcement frequency, graph
      density, memory age distribution
- [ ] **Search integration**: type a query, see matching nodes highlight
      (powered by hybrid recall)
- [ ] **Episodic timeline**: scrollable timeline of episodes alongside the graph
- [ ] **Procedural memory panel**: view lessons, preferences, skills in a sidebar
- [ ] **Consolidation visualization**: animate the sleep cycle — nodes
      strengthen, edges decay, new connections form
- [ ] **Diff view**: compare graph state at two points in time
- [ ] **Responsive layout**: desktop and tablet
- [ ] **Embeddable mode**: `<iframe>` snippet for docs/blog/demos
- [ ] **Fallback for no-WebGL**: 2D force graph (d3-force) for headless/sandbox

**Demo:** open the dashboard, see memory as a living 3D graph, search and watch
related memories light up, scrub through time, show health metrics. This is the
screenshot/GIF that sells nacre.

### M13: Integrations
*Bridge nacre to coding agents.*

**Depends on:** M6 (MCP), M7 (SDK), M9 (conversation ingester)
**Scope:** small (1-2 days each)

Lightweight integration packages for popular agent frameworks:

- [ ] **nacre-opencode** — wrapper for OpenCode
- [ ] **nacre-claude** — wrapper for Claude Code
- [ ] **nacre-openclaw** — wrapper for OpenClaw agents
- [ ] **nacre-langchain** — LangChain integration

Each provides CLI commands (e.g. `opencode-nacre remember "X"`), a programmatic
API wrapping the SDK/CLI, and memory hooks for automatic persistence during
coding sessions.

### M14: Documentation & Launch
*Make it real for other people.*

**Depends on:** M6, M7

- [ ] Landing page (positioning, key features, demo GIF/video)
- [ ] Quick start guide (install → first memory → recall in <5 min)
- [ ] Guides: "Add memory to Claude Desktop" (MCP), "…to your LangChain agent"
      (SDK), "…to your custom agent" (API), "Using nacre with Obsidian"
- [ ] API reference (auto-generated from OpenAPI spec)
- [ ] SDK reference (auto-generated from TypeScript types)
- [ ] Architecture overview (adapted from VISION.md)
- [ ] Configuration reference
- [ ] npm publish: `@nacre/core`, `@nacre/sdk`, `@nacre/cli`

### M15: Python SDK
- [ ] Python wrapper around the REST API
- [ ] PyPI publish
- [ ] Examples for LangChain, CrewAI, AutoGen

### M16: Inference Engine
*The biggest differentiator — nobody else does this well.*

- [ ] Pattern discovery in graph structure
- [ ] Higher-order concept generation during consolidation
- [ ] **Automated procedure extraction** from episodic patterns (the schema
      already tracks `confidence`, `contradictions`, `flaggedForReview`)

### M17: Multi-Graph
- [ ] Multiple named graphs in one nacre instance
- [ ] Per-graph config (decay rates, embedding providers)
- [ ] Graph federation / cross-graph queries (the hive layer is a first step)

### M18: Cloud Option
- [ ] Hosted nacre-as-a-service
- [ ] User auth, billing, usage limits
- [ ] Managed consolidation (scheduled, not heartbeat-dependent)

---

## Principles for the Build

1. **Ship incrementally.** Each milestone is independently useful.
2. **Dogfood relentlessly.** Nacre is the agent's memory first.
3. **Tests aren't optional.** The passing-test count goes up, never down.
4. **Keep it local-first.** Cloud is always optional; the default needs zero
   external services.
5. **API before UI.** Every feature works via CLI/API before it gets a visual
   treatment. The viz is the cherry, not the cake.
6. **Boring technology.** SQLite, TypeScript, Hono, ONNX. The interesting parts
   are the algorithms, not the stack.

---

*This roadmap is alive. Update it as we learn.*

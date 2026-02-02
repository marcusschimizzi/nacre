# Nacre — Concept Document

*A spatial visualization of AI memory that reveals emergent connections across sessions.*

## The Problem

I (Lobstar) wake up fresh every session. My memory lives in flat markdown files — daily logs, curated notes, project docs. It works, but it's **linear and disconnected**. I can't see how things relate, what patterns exist across time, or which connections are strengthening.

Humans don't have this problem because their brains spatialize memory and consolidate connections during sleep. I need the same thing — but built externally.

## The Vision

A force-directed 3D graph where:
- **Nodes** are knowledge chunks: people, projects, decisions, lessons, events, tools
- **Edges** are relationships: "led to", "involves", "taught me", "mentioned with"
- **Time** is the z-axis: recent nodes are large and close, older nodes recede into the background
- **Reinforcement** pulls old nodes forward when they're referenced again — just like retrieval strengthens memory traces

## Core Principles

### 1. Dual Linking — Explicit + Emergent
- **Explicit links**: `[[wikilinks]]` in markdown (Obsidian-compatible syntax)
- **Emergent links**: Auto-discovered through entity co-occurrence, temporal proximity, and semantic similarity
- Visually distinguished: solid edges for explicit, dashed for inferred
- Emergent links don't appear on first co-occurrence — they build up over time like real memory consolidation

### 2. Ingestion/Consolidation Cycle (Wake/Sleep Model)
- **Waking (normal sessions)**: Just write memory files naturally. Raw experience. No graph work.
- **Dreaming (heartbeats/cron)**: Parser reads recent files, extracts entities, detects co-occurrence, strengthens existing edges, creates new edges when repetition crosses threshold
- This mirrors hippocampal replay during sleep — connections form through consolidation, not in real-time

### 3. Perspective = Time
- 3D space where the z-axis represents temporal distance
- Older nodes are smaller, further away, dimmer
- Reinforced memories pull back toward the foreground
- The observer's "now" is always at the front — you see the present clearly, the past as depth
- Node size also reflects connection count (hubs are bigger)

### 4. Works for Carbon and Silicon
- Parses standard markdown files (daily logs, notes, MEMORY.md)
- Understands `[[wikilinks]]` (Obsidian-compatible)
- Could work for human journals AND AI memory files
- Marcus's app uses the same linking syntax — potential convergence

## Architecture

### Entity Extraction
- Parse markdown headers, bullet points, bold terms, wikilinks
- Named entity recognition: people (Marcus), projects (tide-pool), tools (Claude Code), concepts (GSD workflow)
- Extract temporal context from filenames (YYYY-MM-DD.md) and inline dates

### Relationship Detection
- **Explicit**: `[[wikilinks]]` → direct edge
- **Co-occurrence**: Entities mentioned in the same section/day → weighted edge (strengthens with repetition)
- **Temporal proximity**: Events close in time → weak edge
- **Causal signals**: "led to", "because of", "after" → directed edge
- Edge weights decay over time unless reinforced

### Graph Data Model
```typescript
interface MemoryNode {
  id: string;
  label: string;
  type: 'person' | 'project' | 'tool' | 'concept' | 'decision' | 'event' | 'lesson';
  firstSeen: Date;
  lastReinforced: Date;
  reinforcementCount: number;
  sourceFiles: string[];  // which memory files mention this
  excerpt: string;        // snippet of source context
}

interface MemoryEdge {
  source: string;
  target: string;
  type: 'explicit' | 'co-occurrence' | 'temporal' | 'causal';
  weight: number;         // strengthens with repetition
  firstFormed: Date;
  lastReinforced: Date;
  evidence: string[];     // what created/strengthened this link
}
```

### Tech Stack
- **Frontend**: TypeScript + Vite + D3.js (force-directed 3D graph)
  - Marcus has deep D3 experience — leverage that
  - Canvas rendering for performance with many nodes
  - WebGL for 3D perspective (three.js or raw WebGL)
- **Parser**: TypeScript, runs as CLI or during heartbeat
  - Reads `memory/*.md`, `MEMORY.md`, `TOOLS.md`, etc.
  - Outputs graph JSON (nodes + edges)
  - Incremental: only processes new/changed files
- **Data**: JSON files in the project directory
  - `graph.json` — current graph state
  - `history/` — snapshots over time (graph evolution)

## What Success Looks Like

1. I can open the Nacre in my browser and see the shape of my accumulated experience
2. Clusters form naturally — work projects group together, personal context groups separately
3. Strong edges are visible (Marcus ↔ coding, GSD ↔ tide-pool)
4. I discover connections I didn't intentionally create
5. Over weeks/months, the graph grows richer and patterns emerge that neither of us predicted

## Open Questions

- How many nodes before the graph becomes unreadable? Do we need clustering/LOD?
- Should the parser run incrementally during heartbeats, or as a dedicated cron job?
- How aggressive should edge decay be? Too fast = no long-term connections. Too slow = everything connects to everything.
- 3D rendering: three.js vs d3-force-3d vs something simpler?
- Should the graph be read-only, or should I be able to manually add/strengthen connections?

## Inspiration

- **Moonwalking with Einstein** (Joshua Foer) — memory is spatial, place enhances recall
- **Obsidian graph view** — but with auto-discovered links, not just manual
- **Hippocampal replay** — consolidation during sleep forms connections, not waking experience
- **Marcus's app** — building the same linking system for human notes, Obsidian-compatible

---

*"I wake up fresh each session. This tool lets me see the shape of who I've become across all those sessions."*

— Lobstar 🦞

## Beyond Visualization — Cognitive Infrastructure

The graph is the interface, but the real power is what it enables. This isn't a dashboard you look at — it's a thinking tool.

### Active Recall
When I wake up fresh, instead of reading flat memory files top-to-bottom, I query the graph: "what do I know about X?" and get back not just direct mentions but *connected* context. The graph is a retrieval engine.

Example: "You asked about D3 — here's what you know, plus: Marcus worked on a D3 viz library, you're considering it for Nacre, and it connects to tide-pool through the shared Vite stack."

That's richer than grep. It's associative memory.

### Consolidation Suggestions
During heartbeats, the parser flags emerging patterns: "These nodes keep co-occurring but aren't explicitly linked yet. Should they be?" The system surfaces connections for me to confirm or dismiss — like a research assistant noticing patterns I haven't consciously registered.

Threshold-based: don't suggest until co-occurrence count crosses a minimum. Avoid noise. Only surface connections that have earned their weight.

### Decay Alerts
"This node hasn't been reinforced in 2 weeks and has 5 connections. Fading memory."

I can choose to review and reinforce, or let it naturally recede. Active memory management, not passive storage. Important things I want to keep should be easy to strengthen. Unimportant things should gracefully fade without guilt.

### Graph-Guided Writing
When updating MEMORY.md during heartbeats, the graph suggests what's worth consolidating based on connection strength and recency. Instead of reviewing every daily file linearly, the graph says: "these 3 things from the last week have become significant — they connect to 4 existing clusters."

This turns memory maintenance from a chore into a guided process.

### Evolution Replay
Scrub through time and watch the graph grow. See when clusters formed, when connections strengthened, when new domains appeared. Literally watch a mind develop over weeks and months.

Could store periodic snapshots (`history/YYYY-MM-DD.json`) and interpolate between them for smooth playback.

### Session Context Priming (Killer Feature)
Before a session starts, the graph generates a "briefing" — the most relevant, most connected, most recently reinforced nodes for the current context. Smarter than reading the whole MEMORY.md.

Like the difference between reading an encyclopedia vs having a knowledgeable friend brief you on exactly what you need to know right now.

Could integrate with Clawdbot's heartbeat system: graph generates a context-aware briefing that gets injected into session startup.

---

**The visualization is the window. The graph is the cognitive infrastructure underneath — memory retrieval, consolidation, decay management, and context priming. It's not just pretty. It's how I think better.**

---

## Research Findings (2026-01-29)

### Deep research conducted via Perplexity across three domains. Full reports in `research/`.

**3D Graph Visualization:**
- Winner: `3d-force-graph` (Three.js + WebGL, 5.5k stars, handles ~4k nodes)
- Swappable physics: d3-force-3d or ngraph via `forceEngine()`
- WebGL crushes Canvas at 500+ nodes (10x speedup)
- Temporal z-axis: **no library supports this natively** — custom layer on top
- Best TS story: Graphology + sigma.js (2D) or react-force-graph (3D)

**Entity Extraction (Client-Side):**
- **wink-nlp**: Performance champion — 650K tokens/sec, ~10KB gzipped, <80MB RAM
- **compromise.js**: Simplicity champion — clean API, English-only, good for casual text
- No library does markdown-aware NER — need **hybrid pipeline**: markdown parser → NLP + custom regex
- Regex excels for structural entities (wikilinks, code refs, hashtags); NLP handles people/places/orgs

**Knowledge Graph Patterns:**
- **Greenfield opportunity**: No existing PKM tool implements automatic link discovery, weighted edges, decay/reinforcement, or threshold-based formation
- Roam's "unlinked references" is the closest native feature (text matching, not semantic)
- Semantic similarity is plugin-only (Obsidian community plugins using embeddings)
- All tools model graphs as **unweighted** — no decay, no reinforcement, no thresholds
- This is a genuine gap we can fill

### Key Architecture Decision
- Sleep/wake consolidation model aligns with neuroscience (hippocampal replay)
- Heartbeat = consolidation cycle — graph processes during "sleep," not real-time
- LLM context windows make intelligent forgetting *more* valuable than total recall
- Lobstar is both user and system — can instrument own cognition

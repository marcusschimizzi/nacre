# Nacre — Claude Code Instructions

## What Is This?
Nacre is a spatial memory graph visualization for Lobstar (an AI agent). It turns flat markdown memory files into a living, evolving knowledge graph with temporal depth, intelligent forgetting, and emergent connection discovery.

## Key Docs
- `CONCEPT.md` — vision, research findings, what success looks like
- `ARCHITECTURE.md` — full technical architecture, data model, phase plan
- `research/` — Perplexity research reports on tech choices

## Tech Stack (Decided)
- TypeScript throughout
- Vite for frontend builds
- tsup for library/CLI packages
- npm workspaces (monorepo)
- 3d-force-graph (Three.js/WebGL) for viz (Phase 2)
- compromise.js for NLP entity extraction
- unified + remark-parse for markdown parsing
- JSON file persistence

## Project Structure
This is a monorepo with npm workspaces under `packages/`:
- `packages/core/` — data model, graph CRUD, decay math, entity resolution, queries
- `packages/parser/` — ingestion pipeline (discover → parse → extract → resolve → update → decay → persist)
- `packages/viz/` — 3D visualization (Phase 2)
- `packages/cli/` — command-line interface
- `data/` — graph state, entity map, history snapshots

## Current Phase: Phase 1 — "First Memories"
Goal: Run `nacre consolidate` and produce a valid graph.json from markdown files.

### Phase 1 Deliverables
1. `@nacre/core`: Types, graph CRUD, decay math, entity resolution
2. `@nacre/parser`: Full ingestion pipeline
3. `@nacre/cli`: `nacre consolidate` and `nacre query` commands
4. Process real memory files from `/workspace/memory/` (or test fixtures)

### Success Criteria
- Run consolidate on memory directory → get graph.json with 50+ nodes and 100+ edges
- Decay math produces sensible weights (see ARCHITECTURE.md for the Ebbinghaus model)
- Entity resolution deduplicates properly (Marcus = marcus = "Marcus S")

## Conventions
- Conventional commits (feat:, fix:, docs:, etc.)
- One commit per logical unit of work
- TypeScript strict mode
- Tests for core math (decay curves, entity resolution)

## Memory Files Location
Real memory files to test against: the agent's workspace has memory files at a configurable path.
For development, create realistic test fixtures based on the patterns described in CONCEPT.md.

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
- SQLite persistence (`better-sqlite3`), with JSON import/export for portability
- Hono for the REST API
- ONNX / Ollama / OpenAI pluggable embedding providers
- 3d-force-graph (Three.js/WebGL) for viz
- compromise.js for NLP entity extraction
- unified + remark-parse for markdown parsing

## Project Structure
This is a monorepo with npm workspaces under `packages/`:
- `packages/core/` — data model, graph CRUD, decay math, entity resolution, queries, embeddings, recall, episodic/procedural/temporal memory, hive
- `packages/parser/` — ingestion pipeline (discover → parse → extract → resolve → update → decay → persist)
- `packages/cli/` — command-line interface, plus the REST API and MCP servers
- `packages/sdk/` — TypeScript SDK (local + remote backends)
- `packages/viz/` — 3D visualization (vanilla TS + Three.js)
- `packages/dashboard/` — React 3D dashboard (newer; intended successor to `viz`)
- `data/` — graph state, entity map, history snapshots

## Current Status
The original Phase 1 goal (consolidate markdown → graph) shipped long ago.
Milestones M0–M11 plus a federated multi-agent "hive" layer are complete. See
`docs/ROADMAP.md` for the authoritative status, known issues, and remaining work.

Quick reality check: a clean clone needs `npm install && npm run build` before
the full test suite passes (cross-package tests resolve `@nacre/*` from `dist/`).

## Conventions
- Conventional commits (feat:, fix:, docs:, etc.)
- One commit per logical unit of work
- TypeScript strict mode
- Tests for core math (decay curves, entity resolution)

## Memory Files Location
Real memory files to test against: the agent's workspace has memory files at a configurable path.
For development, create realistic test fixtures based on the patterns described in CONCEPT.md.

# Findings

## Project Context
- Task: Build Nacre Phase 1 core engine, parser pipeline, and CLI in a monorepo with npm workspaces under packages/.
- Required reads: CLAUDE.md, CONCEPT.md, ARCHITECTURE.md in repo root.
- Tooling: tsup for package builds; unified+remark-parse for markdown; compromise.js for entity extraction.
- Phase 1 success: consolidate memory directory into graph.json with 50+ nodes and 100+ edges.
- Conventions: conventional commits, strict TypeScript, tests for decay math and entity resolution.
 - Current repo has only docs/research/planning files; no package.json or packages/ yet.

## Product Notes
- Explicit links via [[wikilinks]] and emergent links via co-occurrence/temporal/causal signals.
- Entities from headers, bullets, bold terms, wikilinks, and NLP (people/projects/tools/concepts).
- Graph stored as JSON (graph.json + history snapshots).

## Architecture Highlights
- Core types: MemoryNode, MemoryEdge, NacreGraph, GraphConfig, FileHash, Evidence, Excerpt.
- Entity resolution: normalize -> entity-map.json -> alias -> fuzzy match (Levenshtein <= 2) -> create if confidence > 0.5.
- Pipeline stages: discover, parse (mdast), extract (structural + NLP + custom), resolve, update, decay, persist.
- Co-occurrence edges require threshold; track PendingEdge counts before creation.
- Decay math: weight = W0 * e^(-lambda * t / S), S = 1 + beta * ln(R + 1).
 - CLI targets: consolidate, query (brief/other commands are future; Phase 1 needs consolidate + query).
 - Package layout includes packages/core, packages/parser, packages/cli; data/ graph.json + entity-map.json + pending-edges.json.

## Constraints / Notes
- Repository does not appear to be a git repo (git diff failed).
- Must follow superpowers workflows: brainstorming -> plan -> worktree (if available) -> TDD before implementation.

## Open Questions
- Confirm whether this directory is a git repo or if commits should be skipped.
- Confirm desired worktree location if git is initialized.

# V2-1 Design — Truth Layer & Capture Path

Status: **accepted** · 2026-07-17
Roadmap: [ROADMAP.md](./ROADMAP.md) → V2-1

> Commit to "truth in files, indexes derived" everywhere. Durable memory is
> human-editable, git-diffable markdown; SQLite, embeddings, and entity pages
> are compiled, rebuildable views.

---

## Context

Today nacre has a split truth story:

- **Markdown-ingested memory** already follows the right pattern: files are
  authoritative, the graph is compiled from them (SHA-256 change detection,
  deterministic extraction).
- **MCP/API-written memory does not.** `nacre_remember` creates an entity
  node directly in SQLite with `evidence: [{file: 'mcp'}]` — those memories
  have no file existence, no git history, no human-editable form, and no way
  to travel to another device except copying the `.db`.

The research corpus is near-unanimous on the fix: keep a human-editable
source-of-truth layer and compile/index it into fast derived views
("scoped truth + rebuildable recall"). This milestone commits nacre to that
rule and closes the MCP gap. It also lays the schema foundation for V2-3
(memory objects) and makes V2-7 (multi-device via git sync) possible.

## Goals

1. Every durable memory has a canonical, human-editable markdown file.
2. MCP/API writes land in a capture tier and are **promoted** by
   consolidation — never written straight into the durable store.
3. `nacre rebuild` reproduces the graph, embeddings, and indexes on a fresh
   machine from the memory directory alone.
4. Recall can return verbatim source text, not only derived excerpts.
5. Embedding vectors are pinned to the encoder that produced them; mismatches
   fail loudly.

## Non-goals

- Lifecycle machinery (supersession chains, contradiction detection,
  candidate review UX) — that is V2-3. V2-1 only defines the fields.
- Scope enforcement/policy — V2-2. V2-1 only encodes scope in paths and
  frontmatter.
- Sync orchestration, conflict resolution, auto-pull/push — V2-7. In V2-1
  the memory directory is just a git repo the user syncs however they like.
- Migrating how anyone writes daily logs/notes today. Existing free-form
  markdown remains a capture source, unchanged.

---

## Architecture: three tiers

Following the raw-intake / canonical-pages / derived-indexes separation:

```
Tier 1 — CAPTURE (append-only, messy, not searchable as truth)
  · existing free-form markdown (daily logs, notes)     [already exists]
  · MCP/API writes → capture spool (JSONL)              [new]
  · session slices from agent hooks                      [V2-6]

        ↓ consolidation — the existing sleep cycle becomes
          the ONLY promotion path into durable memory

Tier 2 — CANONICAL (git-synced markdown; THE truth layer)   [new]
  · one file per memory object
  · YAML frontmatter (the V2-3 Memory schema) + body
  · scope-organized directories

        ↓ compile — parser pipeline; deterministic for memory
          files (frontmatter parse, no NLP guessing), NLP/entity
          extraction only over bodies and capture sources

Tier 3 — DERIVED (rebuildable at any time)
  · SQLite graph (nodes/edges/episodes/procedures)
  · embeddings (pinned to an encoder fingerprint)
  · compiled entity pages / indexes / viz JSON
```

The invariant: **deleting every Tier 3 artifact loses nothing durable.**
Tier 1 spool entries not yet promoted are the only other state that matters,
and they are durable files too.

---

## Canonical memory format

### Directory layout

```
memory/
  user/
    preferences/prefers-typescript-strict.md
    facts/…
  projects/
    nacre/
      decisions/sqlite-over-json.md
      lessons/…
  agent/                  # agent-scope durable memory (local-operational,
    …                     # still file-backed; sync policy comes in V2-2/V2-7)
  .capture/               # Tier 1 spool — JSONL, append-only
    2026-07-17.jsonl
```

- Path encodes scope: `memory/<scope>/…` where scope ∈
  `user | projects/<name> | agent`. Session scratch is **not** file-backed
  (it is operational state, V2-2).
- Filenames are human-readable slugs; the stable identity is the `id` in
  frontmatter, not the path. Renames/moves are safe.
- The directory is Obsidian-compatible: it opens as a vault, wikilinks work.

### File format

```markdown
---
id: mem_a1b2c3d4            # stable, generated at promotion, never reused
type: decision              # claim | preference | decision | fact | lesson
scope: project/nacre        # must agree with path; path wins on conflict
confidence: 0.9
sensitivity: low            # low | personal | sensitive | secret(→rejected)
created: 2026-07-17
last_confirmed: 2026-07-17
supersedes: mem_x9y8        # optional; lifecycle semantics land in V2-3
superseded_by:              # optional
sources:
  - episode:ep_2026-06-08_1
  - file:docs/REVIEW-2026-06.md
salience:
  reinforcement_count: 3    # updated ONLY at consolidation (see below)
  last_reinforced: 2026-07-15
---
Chose SQLite over JSON persistence for the graph store, because [[better-sqlite3]]
gives WAL-mode durability and the JSON export remains for portability.

## Source

> "JSON import/export kept for portability and viz" — ROADMAP, 2026-06-08
```

Rules:

- **Body first paragraph = the claim.** This is what gets embedded and what
  recall returns by default.
- **`## Source` section = verbatim evidence.** Optional but strongly
  encouraged at promotion time; recall gains `includeSource` to return it.
  This kills the "summarization corrupts UUIDs/paths/IDs" failure mode —
  exact identifiers live in the verbatim block even when the claim
  paraphrases.
- **`[[wikilinks]]` in the body feed the entity graph** exactly as the
  parser works today. Entities remain the associative index *over* memories;
  entity pages, if we ever render them, are compiled Tier 3 views — never
  authored.
- **Frontmatter is a closed schema.** Unknown keys are a compile warning.
  The field set is exactly the V2-3 `Memory` object so V2-3 adds behavior,
  not migration.
- `sensitivity: secret` is rejected at promotion (zero-retention class —
  passwords/keys/OTPs never become durable memory).

### Salience in frontmatter (decision)

`reinforcement_count` / `last_reinforced` live in frontmatter, **written only
during consolidation** (never on the read/recall hot path). Decayed weight is
never persisted anywhere — it stays computed at read time, as today.

Rationale: reinforcement is shared-durable state — a memory strengthened on
one device should be strong on every device, and "this memory keeps getting
reinforced" is a meaningful git history, not noise. Batching writes into the
consolidation commit bounds the churn: one consolidation = one commit.

Fallback (only if commit noise proves painful in practice): move salience to
a single synced `memory/.salience.json` sidecar. Explicitly rejected: keeping
salience SQLite-only, because per-device divergence and lossy rebuilds defeat
the truth layer.

---

## Capture spool & the MCP write path

### Spool format

`memory/.capture/YYYY-MM-DD.jsonl`, append-only, one JSON object per line:

```json
{"ts":"2026-07-17T09:14:02Z","origin":"mcp","tool":"nacre_remember",
 "agent":"lobstar","sessionId":"…","payload":{"content":"…","type":"fact",
 "context":"…","links":["nacre"]}}
```

- Append is the only operation. No parsing, no network, no LLM — the write
  path stays deterministic and fast (spool-and-drain pattern).
- The spool is durable WAL: unpromoted entries survive crashes and are picked
  up by the next consolidation.
- Whether `.capture/` is gitignored or synced is a policy knob
  (`nacre.config.json`); default **synced** so un-consolidated memories
  aren't stranded on one device. Entries are pruned N days after promotion.

### `nacre_remember` (and the API ingest routes) become two-phase

1. **Append to the spool** (the durable act).
2. **Compile a candidate into SQLite immediately** — node + embedding, marked
   `status: candidate` — so the agent's expectation of instant recallability
   is preserved (current auto-embed behavior, no UX regression).

At the next consolidation, the candidate is promoted: canonical file
materialized (id minted, slug chosen, source attached), SQLite row flipped to
`status: promoted` and re-pointed at the file. Recall may include candidates
by default but receipts (V2-4) will distinguish them.

Rebuild-from-scratch therefore = replay canonical files + replay unpromoted
spool entries as candidates. Nothing else.

### Store changes

- `nodes` (and later `memories`) gain `status: candidate | promoted` and
  `canonical_path`.
- Consolidation gains the promotion step: spool → canonical file → compiled
  row. This is deliberately the *same* pipeline stage that today merges
  markdown extractions — one promotion path, as the corpus prescribes
  (quarantined capture queue, background archivist as sole promoter).

---

## `nacre rebuild`

The acceptance test for the whole milestone:

```
nacre rebuild --memory-dir ./memory --out nacre.db
```

- Parses canonical files (frontmatter: strict/deterministic; bodies: existing
  entity-extraction layers), replays unpromoted spool entries, recreates
  graph + episodes + procedures, re-embeds everything with the configured
  provider.
- **Determinism contract:** two rebuilds from the same directory and same
  encoder produce semantically identical stores — same memories, same
  entities, same edges, same salience. (Embedding vectors are identical only
  under the same encoder fingerprint; that is what pinning is for.)
- Existing SHA-256 change detection makes incremental recompile cheap; full
  rebuild is the cold-start/new-device path.

## Encoder-fingerprint pinning

- Fingerprint = `provider:model:dimensions:revision`
  (e.g. `onnx:all-MiniLM-L6-v2:384:main`).
- Stored once in an `embedding_meta` table and stamped on the store at first
  embed; `nacre.config.json` declares the intended provider.
- Every `searchSimilar` / embed call verifies the active provider's
  fingerprint against the store. Mismatch → **hard error** with remediation:
  `encoder mismatch: store has onnx:…:384, active is ollama:…:768 — run
  'nacre embed --rebuild' or fix nacre.config.json`.
- Never compare vectors across spaces; never silently fall back to
  graph-only recall (that is the "outage masked as empty result" failure
  mode — degrade loudly).

## Git mechanics (V2-1 scope only)

- nacre does not run git itself. The memory directory is an ordinary repo;
  the user (or agent heartbeat) commits/pushes/pulls.
- Optional `git.autoCommit: true` — consolidation ends with
  `git add -A && git commit` in the memory dir, message summarizing the
  cycle (`consolidate: +3 memories, 2 reinforced, 1 promoted from capture`).
- Merge conflicts are one-file-per-memory small and human-readable by
  design; automated resolution is V2-7's problem.

---

## Build order

1. **Encoder pinning** — smallest, independent, immediately fixes a real
   correctness hole. (`embedding_meta` table, fingerprint checks,
   `embed --rebuild`.)
2. **Canonical format** — serializer/deserializer in `@nacre/core`
   (`memory-file.ts`: frontmatter schema via zod, body/source parsing,
   slug generation). Closed-schema warnings.
3. **`nacre rebuild`** — compile canonical dir → store; determinism test.
4. **Capture spool + two-phase `nacre_remember`/API ingest** — spool writer,
   candidate status, promotion step in consolidation.
5. **Salience to frontmatter** — consolidation writes reinforcement state
   back to files; rebuild round-trips it.
6. **`export` migration** — one-shot `nacre export --canonical` that emits
   canonical files for every existing SQLite-only memory (the current
   MCP-written nodes), so existing graphs migrate into the truth layer.

## Acceptance criteria

- [ ] Fresh machine + memory dir + `nacre rebuild` → recall results
      equivalent to the origin machine (same encoder).
- [ ] `rm nacre.db` loses nothing durable.
- [ ] `nacre_remember` → entry visible in spool file; memory recallable
      immediately as candidate; canonical file exists after next
      `nacre consolidate`; git diff shows exactly that file.
- [ ] Editing a canonical file by hand (fix a claim, bump confidence) →
      next consolidation recompiles it; no drift, no duplicate.
- [ ] Recall with `includeSource` returns the verbatim `## Source` block.
- [ ] Swapping embedding provider fails loudly with remediation text;
      `nacre embed --rebuild` recovers.
- [ ] Reinforcement counts survive rebuild and travel through git.

## Open questions (deferred, tracked)

- Slug collision policy for near-identical memories (probably: dedup is a
  V2-3 contradiction/merge concern; V2-1 just suffixes).
- Should episodes get canonical files too? Lean **no** for V2-1 — episodes
  are operational evidence (Tier 1/3), not durable beliefs; revisit in V2-3
  when deciding what episode data memory objects cite.
- `.capture/` retention window default (proposal: prune 30 days after
  promotion).

## Corpus references

- Scoped truth + rebuildable recall; quarantined capture queue; Index-tree
  navigation — `Context Databases.md`
- Raw intake / canonical pages / derived views as separate artifact classes —
  `Project Context Artifacts.md`
- Verbatim source recall; superseded memories and action guards — Midas, via
  `Low-LLM Memory Writes.md`
- Markdown/git substrate camp; git diffs as mutation audit trail —
  `Memory OS and Agent Coherence Infrastructure.md`
- Encoder-fingerprint pinning; outage contracts — `Context Databases.md`,
  `Memory Failure Modes.md`
- Zero-retention secret class — `Privacy-Preserving Memory.md`

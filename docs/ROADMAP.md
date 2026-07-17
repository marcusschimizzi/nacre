# Nacre — Roadmap

> From personal memory graph to cross-agent memory substrate.

Last updated: 2026-07-16

---

## Where We Are Today

Nacre is a full memory engine with SQLite storage, embeddings, hybrid recall,
episodic + procedural memory, temporal queries, a REST API, an MCP server, a
TypeScript SDK, and a federated multi-agent ("hive") layer. The June 2026
review-and-remediation sprint (REVIEW-2026-06.md → commits of Jun 14–19)
hardened the API, added CI and Biome, eliminated the recall N+1, cached store
reads, delta-upserted consolidation, indexed entity resolution, and made MCP
writes auto-embed.

In July 2026 we assessed nacre against the agentic-memory research corpus
(~60 systems and papers, maintained in `radar/notes/Agentic Memory/`). The
verdict shapes everything below.

---

## The V2 Thesis

Nacre was designed before the research corpus existed. Measured against it:

**What nacre got right — and should keep:**

- **The salience engine.** Ebbinghaus decay with reinforcement-based
  stability, weighted emergent edges, threshold-gated link formation. The
  corpus confirms no other tool does this ("all tools model graphs as
  unweighted — no decay, no reinforcement"). This is nacre's rare part.
- **No-LLM hot path.** Deterministic extraction, optional LLM layer, batch
  consolidation off the hot path — exactly the "Low-LLM Memory Writes"
  prescription. The sleep/wake cycle is the "quarantined capture queue +
  background archivist" pattern.
- **Closed ontology.** Nine node types, four edge types. The corpus is
  emphatic that free-typed LLM extraction invents duplicate types.
- **Temporal snapshots + `--asOf`** — a real step toward bi-temporal memory.
- **Hive federation with origin discounting** — anticipates the
  cross-agent-fleet trend and the provenance-gated admission pattern.

**What the corpus says is missing (ranked):**

1. **No scope model.** One global graph per agent. Cross-agent memory needs
   explicit scopes — user / project / agent / session, shared-durable vs.
   local scratch — with different defaults and permissions.
2. **Entities aren't beliefs.** Nacre's atom is an entity with excerpts; the
   field's atom is a memory object — a claim with source, confidence,
   sensitivity, trust, and supersession/correction lineage. Nacre models
   *salience* but not *belief lifecycle*.
3. **No receipts, no admission layer.** `nacre_brief` injects context without
   recording what was included, rejected, or why; recall gates on similarity
   only, not appropriateness (scope, freshness, sensitivity).
4. **No memory eval harness.** Good unit tests, zero memory-quality evals
   (forgetting-absence, P@k, module-level failure attribution).
5. **Truth-layer ambiguity.** Markdown-ingested memory follows
   "human-editable truth, derived index" — but MCP writes live only in
   SQLite, with no human-editable, git-diffable existence.
6. **Exact-fact fidelity.** ~100-char excerpts risk the
   "summarization corrupts UUIDs/paths/IDs" failure mode; recall should be
   able to return verbatim source.

**Verdict: keep the engine, re-architect the memory model on top of it.**
Not a rewrite — the gaps are additive layers around a good core, and the
parts nacre has are the ones you can't get anywhere else.

**Two load-bearing decisions locked in for V2:**

1. **Truth layer**: git-synced markdown is authoritative for durable memory;
   SQLite (graph, embeddings, indexes) is a derived, rebuildable view.
2. **Scope model**: `user / project / agent / session`, where user and
   project scopes are shared-durable (they travel via git) and agent/session
   scopes are local-operational (they live with the agent host).

---

## Completed Milestones

Historical record of what shipped (detailed plans live in the code).

| # | Milestone | Notes |
|---|-----------|-------|
| M0 | Repo cleanup & OSS prep | LICENSE (Apache-2.0), README rewrite, package metadata. |
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
| M11 | Hive graph | federated multi-agent consolidation. |
| — | June 2026 hardening sprint | CI, Biome, API hardening, perf fixes, MCP auto-embed. |

---

## V2 Milestones

Ordered by dependency: the truth layer and scope model are foundations; the
memory-object layer is the centerpiece; receipts, evals, and integrations
make it trustworthy and used; sync makes it multi-device.

### V2-1: Truth layer & capture path

*Commit to "truth in files, indexes derived" everywhere.*

Design: [V2-1-TRUTH-LAYER.md](./V2-1-TRUTH-LAYER.md) (accepted 2026-07-17,
**implemented** 2026-07-17)

- [x] Durable memories serialize to a canonical markdown format in a
      git-manageable directory; SQLite becomes a compiled view of it
      (`memory-file.ts`, `compileMemoryDir`, `nacre rebuild`).
- [x] MCP/API writes (`nacre_remember`, `POST /memories`) land in a capture
      spool (raw intake), promoted into canonical markdown by consolidation —
      never straight into the durable store. (`nacre_lesson` → procedures
      remains SQLite-backed; procedures join the truth layer in V2-3.)
- [x] Full round-trip: `nacre export --canonical` migrates SQLite-only
      memories; `nacre rebuild` reproduces the graph and embeddings on a
      fresh machine from the memory dir alone.
- [x] Verbatim source recall: `nacre recall --source` / MCP `includeSource`
      return the exact claim + `## Source` evidence from canonical files.
- [x] Encoder-fingerprint pinning: vectors pinned to their encoder; loud
      failure + `nacre embed --rebuild` remediation on mismatch.
- [x] Salience write-back at consolidation (monotone merge: max count,
      later date) so reinforcement travels through git.

### V2-2: Scope model

*Make "whose memory is this and where may it go" a first-class property.*

- [ ] `scope` field on nodes, memories, episodes, procedures: `user`,
      `project`, `agent`, `session`.
- [ ] Scope-aware defaults on every read/write surface (CLI, API, MCP, SDK) —
      visible and overridable, per the "explicit scope parameter" pattern.
- [ ] Per-scope policy: sync eligibility, sensitivity ceiling, retention.
      Session scratch never syncs; secrets never persist (zero-retention
      class).
- [ ] Scope isolation tests: project memories don't leak into global recall;
      agent-local memory doesn't sync to other devices.

### V2-3: Memory-object layer (belief lifecycle)

*The centerpiece: add beliefs alongside entities.*

- [ ] New `Memory` object: typed claim/preference/decision/fact with
      `source`, `confidence`, `sensitivity`, `trust_level`, `scope`,
      `last_confirmed`, `superseded_by`.
- [ ] Closed `semanticType` enum on edges (`supersedes`, `contradicts`,
      `part_of`, `led_to`, `about`, `derived_from`) alongside the existing
      mechanism types (explicit/co-occurrence/temporal/causal). Mechanism =
      how the link was found; semantics = what it means. No free-typed edges.
- [ ] Entities become the associative index *over* memories; decay and
      reinforcement govern memory salience (this subsumes the old
      "nodes never decay" issue).
- [ ] Candidate → promotion pipeline inside consolidation: raw capture →
      candidate → durable memory, with contradiction detection and
      supersession chains instead of silent overwrite.
- [ ] Correction and deletion as product operations (correct, retire, forget)
      with lineage — deleted/superseded facts must be verifiably absent from
      recall.

### V2-4: Receipts & admission

*Make injection trustworthy and debuggable.*

- [ ] Receipts on `brief` and `recall`: query, filters, included memories,
      rejected memories (and why), score breakdowns, token cost. Persisted
      and inspectable (`nacre receipts`).
- [ ] Admission layer between candidate retrieval and context assembly:
      gate on scope, freshness, sensitivity, and supersession state — not
      just similarity ("similarity is not appropriateness").
- [ ] Provenance guard: superseded or low-trust memories cannot authorize
      destructive/external actions.
- [ ] Outage contract: recall degrades loudly when embeddings/index are
      unavailable — never masks failure as an empty result.

### V2-5: Memory eval harness

*Our research edge, turned into CI.*

- [ ] Replay corpus: recorded conversations/sessions with probe points.
- [ ] Retrieval QA: P@k, R@k, NDCG, latency on a fixed query set.
- [ ] Forgetting-absence scoring: corrected/retired facts must not resurface
      (Memora/FAMA pattern) — explicit credit for current values, explicit
      penalty for leaking stale ones.
- [ ] Module-level failure attribution: label failures as extraction,
      storage, retrieval, or use (MemTrace pattern).
- [ ] Context-tokens-per-turn reported alongside recall quality — token
      economy is the value proposition.
- [ ] Runs in CI; the score goes up, never down.

### V2-6: Agent integration glue

*A memory an agent doesn't consult is a write-only archive.*

- [ ] **nacre-claude**: Claude Code hooks — SessionStart (brief injection),
      PreCompact (forced capture before lossy compression), Stop (throttled
      autosave). Capture via spool file + detached drainer; never block the
      hot path.
- [ ] **nacre-openclaw / Hermes provider**: heartbeat-driven consolidation,
      brief at session start, capture at turn boundaries.
- [ ] **nacre-opencode** wrapper.
- [ ] Consultation instructions: shippable CLAUDE.md/AGENTS.md snippets so
      agents proactively query before repeating decisions.

### V2-7: Multi-device sync

*Multi-device without building a cloud product.*

- [ ] Shared-durable scopes (user/project) sync via the git-managed markdown
      truth layer; each device rebuilds its SQLite index + embeddings
      locally (V2-1 makes this possible).
- [ ] Policy-gated sync: sensitivity labels and scope policy decide what
      leaves the device (Budgeted Memory Governance SHARE gate).
- [ ] "M18-lite": document running `nacre api` on the always-on agent host
      as the live endpoint for other devices via the SDK's `RemoteBackend`
      (already built) — network reachability via Tailscale or similar.
- [ ] Hive merge as the reconciliation path when devices diverge.

---

## Superseded / Deprioritized (old M12–M18)

| Old | Disposition |
|-----|-------------|
| M12 Visualization dashboard | **Parked.** Do the frontend consolidation as tech debt (keep `dashboard`, retire `viz`); polish only after V2-4. The viz is the cherry, not the cake. |
| M13 Integrations | **Superseded by V2-6** (promoted and reshaped around hooks + capture). |
| M14 Documentation & launch | **Deferred** until after V2-5/V2-6 — launch with evals and integrations, not before. |
| M15 Python SDK | **Deferred.** Revisit on demand. |
| M16 Inference engine | **Deferred until V2-5 exists** — build the differentiator only when we can measure it. |
| M17 Multi-graph | **Partially subsumed by V2-2 scopes**; revisit what remains after. |
| M18 Cloud option | **Replaced by V2-7** for personal multi-device. Hosted product only if nacre goes commercial. |

---

## Known Issues & Tech Debt

- [x] ~~CI~~ — `.github/workflows/ci.yml` shipped in the June sprint.
- [x] ~~MCP recall uses the mock embedder~~ — `mcp/tools.ts` now resolves the
      graph's configured provider.
- [ ] **Two viz frontends**: keep `@nacre/dashboard`, retire `@nacre/viz`
      (~7k LOC of drifting duplication).
- [ ] **API + MCP live inside the CLI package**: extract `@nacre/api` and
      `@nacre/mcp`.
- [ ] **Hand-mirrored types** across viz/dashboard/sdk (`RecallScores` has
      already diverged): share DTOs from `@nacre/core`.
- [ ] **Dead `GraphStore` abstraction**: either use the interface or delete
      it; everything couples to `SqliteStore`.
- [ ] **Brute-force vector search**: O(n) cosine scan; integrate `sqlite-vec`
      for scale.
- [ ] **Nodes never decay**: subsumed by V2-3 (salience moves to memory
      objects).
- [ ] **`sql.js`** still in the root `package.json` — confirmed unused,
      remove.
- [ ] **Dependency version drift** across workspaces (better-sqlite3 11/12,
      zod 3/4, hono 4.7/4.11).
- [ ] **Default embedding provider mismatch**: store defaults to `ollama`,
      README says `onnx`. Reconcile.
- [ ] **Web-session setup**: SessionStart hook so cloud sessions auto-install
      and build.

---

## Principles for the Build

1. **Ship incrementally.** Each milestone is independently useful.
2. **Dogfood relentlessly.** Nacre is the agent's memory first.
3. **Tests aren't optional.** The passing-test count goes up, never down.
4. **Keep it local-first.** Cloud is always optional; the default needs zero
   external services.
5. **API before UI.** Every feature works via CLI/API before it gets a
   visual treatment.
6. **Boring technology.** SQLite, TypeScript, Hono, ONNX. The interesting
   parts are the algorithms, not the stack.
7. **No LLM on the hot path.** Deterministic writes; spend LLM calls on
   gated, batched consolidation.
8. **Truth in files, indexes derived.** Durable memory is human-editable and
   git-diffable; SQLite/vectors are rebuildable views.
9. **Receipts everywhere.** Every injection and recall can explain what it
   included, what it rejected, and why.
10. **Closed ontologies.** Node types, edge semantics, and scopes are enums,
    not free text.
11. **Evals before intelligence.** No new "smart" feature without a metric
    that can catch it regressing.

---

*This roadmap is alive. Update it as we learn.*

# V2-2 Design — Scope Model

Status: **accepted** · 2026-07-19
Roadmap: [ROADMAP.md](./ROADMAP.md) → V2-2 · Builds on [V2-1-TRUTH-LAYER.md](./V2-1-TRUTH-LAYER.md)

> Make "whose memory is this and where may it go" a first-class, visible,
> enforced property on every read and write surface.

---

## Context

V2-1 gave scopes a *representation*: canonical files live in scope-encoded
paths (`user/`, `agent/`, `projects/<name>/`), frontmatter carries `scope`,
and `isValidScope`/`scopeToDir`/`pathToScope` exist in core. But nothing
*enforces* or even *records* scope in the derived store: nodes, episodes, and
procedures have no scope column; recall/brief/similar cannot filter by scope;
write surfaces accept no scope parameter (promotion silently defaults to
`agent`); and hive merging ignores scope entirely.

The research corpus is unanimous that this is table stakes for cross-agent
memory (Scope Recall for Hermes, MemOS cubes, ReMEM namespaces): explicit
scope on reads/writes/deletes, visible and changeable defaults, different
policies per scope, and store-enforced isolation.

## Goals

1. Every memory (node/episode/procedure) carries a scope in the store.
2. Every write surface (MCP, API, capture) accepts an explicit scope, with a
   visible, configurable default.
3. Every read surface (recall, similar, brief — CLI, MCP, API, SDK) accepts a
   scope filter with sane defaults.
4. Per-scope policy: sync eligibility, hive eligibility, retention. Session
   scratch never becomes durable.
5. Isolation is tested, not asserted.

## Non-goals

- Actual multi-device sync enforcement (V2-7 owns git mechanics; V2-2 makes
  the *policy* real at the spool/promotion/hive level).
- Retrieval admission/receipts (V2-4) — scope filtering here is coarse
  store-level filtering, not the policy-aware admission layer.
- Multi-user isolation. Nacre is single-user; scopes separate *contexts*
  (user vs. agent vs. projects), not principals.

---

## The scope set

```
user               durable, follows the human across everything
project/<name>     durable, bound to a project context
agent              durable, local-operational to this agent
session            scratch — never file-backed, never syncs, expires
```

`session` is new. V2-1 deliberately left session scratch out of the truth
layer ("session scratch is NOT file-backed — it is operational state"); V2-2
gives it a real home in the store with an expiry, so agents can park
working-state without polluting durable memory.

## Decisions

### D1. Entities are unscoped; scope governs memories

Entity nodes (person/tool/concept extracted from notes or wikilinks) are the
shared associative vocabulary — a `nacre` entity is referenced by memories in
every scope. Scoping entities would either fragment the graph (one entity per
scope) or falsify it (entity pinned to whichever scope saw it first).

- Memory-backed nodes, episodes, and procedures carry `scope`.
- Entity nodes have `scope = NULL` and are visible from any scope.
- Caveat, recorded here deliberately: entity *labels* can leak across scopes
  ("who is X" surfacing in an unrelated context). Label-level admission is
  V2-4's problem; V2-2 accepts this for a single-user system.

### D2. Read default: all durable scopes, never session

Recall/brief/similar default to searching `user + agent + project/*` and
exclude `session` unless explicitly requested. Rationale: for a personal
memory, cross-context recall is the product ("what did I decide about X"
should not require naming the project); the isolation requirement is that a
*requested* scope filter is airtight and that scratch never bleeds into
durable recall. `--scopes` / `scopes` params make any narrower slice
explicit.

### D3. Write default: config-resolved, visible in every response

Default scope resolution order: explicit argument → `memory.defaultScope` in
nacre.config.json → `agent`. Every write response (MCP text, API JSON) states
the scope the memory landed in, so defaults are visible, never silent.

### D4. Session scope semantics

- Session writes go to the store only: **no capture spool entry** (scratch is
  not durable by definition), `status` stays unset (they are not candidates —
  there is nothing to promote).
- Session rows expire: consolidation purges session-scoped rows older than
  `scopes.session.retentionDays` (default **7**), reporting the count.
- Rebuild never recreates them (nothing in files or spool) — correct by
  construction.
- Recall includes them only when `session` is explicitly in the scope filter.

### D5. Per-scope policy table

Defaults, overridable per scope via `nacre.config.json` → `scopes`:

| scope       | spooled/promoted | hive-eligible | expires |
|-------------|------------------|---------------|---------|
| user        | yes              | yes           | no      |
| project/*   | yes              | yes           | no      |
| agent       | yes              | **no**        | no      |
| session     | **no**           | **no**        | 7 days  |

- **Hive eligibility** is enforced now: `buildHive` already honors per-node
  `hiveExclude`; V2-2 additionally excludes nodes whose scope policy says
  no-hive. Agent-local operational memory stays out of federated graphs by
  default.
- **Sync eligibility** in the table is the V2-7 hook: it is recorded in the
  policy module now so promotion/spool decisions (session never spools) and
  future git mechanics read one source of truth.
- Sensitivity: `secret` remains globally zero-retention (V2-1). Per-scope
  sensitivity ceilings are deferred to V2-4 (admission), where sensitivity
  becomes load-bearing.

### D6. Store representation and migration

- Schema v9: `scope TEXT` column on `nodes`, `episodes`, `procedures`
  (nullable — NULL means "unscoped entity" on nodes, and "pre-scope legacy,
  treated as `agent`" on episodes/procedures until rewritten).
- Compile stamps `node.scope` from the canonical file (path-derived, which
  already wins over frontmatter). Replay and two-phase writes stamp from the
  capture payload / default. Existing memory-backed rows therefore acquire
  their scope at the first post-upgrade consolidation — no bespoke migration
  pass.
- `pathToScope` already rejects unknown top-level dirs; nothing changes in
  the file layout.

## Surfaces

| Surface | Change |
|---|---|
| MCP `nacre_remember` | `scope` param; response names the landing scope |
| MCP `nacre_recall` / `nacre_brief` | `scopes` param (default: durable scopes) |
| API `POST /memories` | `scope` in schema; echoed in response |
| API `GET /recall`, `/search`, `/brief` | `scopes` query param |
| CLI `recall` / `similar` / `brief` | `--scopes user,project/nacre,...` |
| SDK | passes scope/scopes through on remember/recall |
| Capture payload | `scope` already exists (V2-1) — now actually driven by callers |
| Hive `buildHive` | scope-policy exclusion (agent/session out by default) |
| Consolidation | session purge step with reported count |

## Isolation tests (the milestone's acceptance bar)

- [ ] A `--scopes project/a` recall never returns memories scoped
      `project/b`, `user`, `agent`, or `session` — across semantic, graph,
      and recency paths.
- [ ] Default recall returns durable scopes and never `session`.
- [ ] Session writes: absent from spool, absent after rebuild, purged after
      retention, invisible to default recall, visible to explicit
      `session` recall before expiry.
- [ ] Hive built from a graph with all four scopes contains only
      user/project memories (plus unscoped entities).
- [ ] Scope survives the full truth-layer round trip: write with scope X →
      spool → promote (file in X's directory) → compile → node.scope === X →
      rebuild → still X.
- [ ] Write responses on every surface name the landing scope.

## Build order

1. **Policy module** (`scopes.ts` in core): scope set incl. `session`,
   policy table, config overrides, `resolveDefaultScope`, `isDurableScope`.
2. **Schema v9 + stamping**: scope columns; compile/replay/two-phase writes
   populate them; round-trip test.
3. **Write surfaces**: MCP/API scope params + visible defaults; session
   short-circuit (no spool).
4. **Read surfaces**: scope filtering in recall/similar/brief through core,
   then CLI/MCP/API/SDK params.
5. **Hive + purge**: scope-policy hive exclusion; session retention purge in
   consolidation.
6. **Isolation test suite** (the checklist above).

## Open questions

- Should `project/<name>` default be inferable from the graph's location
  (e.g. a graph living inside a repo defaults new writes to that project's
  scope)? Deferred — config `memory.defaultScope` covers the need explicitly;
  inference invites surprising writes.
- Per-scope retention for durable scopes (e.g. agent memories expiring after
  N months) — the policy table has the slot; deliberately not enabled for any
  durable scope in V2-2.

## Corpus references

- Explicit scope parameter, visible defaults — `Context Databases.md`
  ("explicit scope parameter"), Scope Recall for Hermes
- Shared-durable vs. local scratch split — Scope Recall for Hermes, via
  `Memory OS and Agent Coherence Infrastructure.md`
- Scoped memory cubes/namespaces — MemOS, ReMEM
- Scope isolation as an evaluation dimension — `Memory Evaluation.md`
- Retention/sync governed per class — `Budgeted Memory Governance.md`

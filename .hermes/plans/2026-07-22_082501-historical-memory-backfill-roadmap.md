# Historical Memory Backfill Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Make Nacre capable of ingesting a large pre-existing agent conversation archive and turning it into provenance-backed, temporally correct, salience-aware working memory that Hermes can use without relying on a second memory system.

**Architecture:** Adopt the existing V2 roadmap rather than create a parallel track. Insert a new V2-3 historical-evidence foundation, then expand and renumber the existing belief lifecycle, admission, evaluation, integration, and sync milestones. Nacre remains one memory system with several internal representations: immutable evidence, normalized messages, episodes, candidate memories, canonical durable memories, and derived recall views.

**Tech Stack:** TypeScript, Node.js, SQLite/better-sqlite3, citty CLI, canonical markdown truth layer, existing Nacre parser/core/recall/MCP packages, optional offline LLM consolidation behind deterministic receipts.

---

## 1. Outcome and Definition of “Usable Here”

The work is complete for the Lobstar/Hermes use case when all of the following are true:

1. Nacre can inventory `/Users/Shared/OpenclawReference/agents/main/sessions/` without treating backup, reset, checkpoint, trajectory, and copied context files as independent evidence by default.
2. It can ingest the selected OpenClaw history into a dedicated Nacre graph while preserving source IDs, event timestamps, ingestion timestamps, agent identity, and exact source evidence.
3. Re-running the same import is a strict no-op: no new episodes, no reinforcement, no altered timestamps, and a receipt explaining what was skipped.
4. Direct dialogue, tool output, cron prompts, routed internal messages, and quoted “Recent conversation history” are retained but classified; synthetic repetition cannot inflate salience.
5. Consolidation emits typed candidate memories (`claim`, `fact`, `preference`, `decision`, `lesson`) with evidence links, confidence, scope, sensitivity, salience, and contradiction/supersession state.
6. Current facts win active admission without deleting historical facts. Queries can still reconstruct what was believed at an earlier time.
7. `nacre brief` and `nacre recall` return bounded working context with receipts showing included and rejected memories and why.
8. A fixed Lobstar replay/evaluation suite demonstrates retrieval of durable identity, project context, decisions, and lessons while penalizing stale paths and repeated synthetic context.
9. Hermes can consult Nacre at session start and during explicit recall through a supported Nacre integration, with no Holographic dependency for the imported continuity.
10. The raw OpenClaw archive remains read-only and the derived graph can be rebuilt from Nacre-owned evidence plus canonical memory files.

---

## 2. Roadmap Adoption

Update `docs/ROADMAP.md` by inserting the new foundation and shifting milestones that have not shipped. Do not maintain a separate “migration roadmap”; historical ingestion should exercise the main memory architecture.

### Revised V2 sequence

| Milestone | Name | Purpose | Exit gate |
|---|---|---|---|
| V2-1 | Truth layer & capture path | Already shipped | Canonical files rebuild SQLite |
| V2-2 | Scope model | Already shipped | Scope isolation and retention pass |
| **V2-3** | **Evidence-aware historical ingestion** | Import ledger, adapters, chronology, provenance, deterministic identity, batch/resume UX | Re-import is a no-op; source chronology and evidence classifications survive rebuild |
| **V2-4** | **Memory objects & belief lifecycle** | Expand current planned V2-3: candidates, typed beliefs, contradiction, correction, supersession | Historical sessions consolidate into canonical memories with exact evidence and lineage |
| **V2-5** | **Working memory, admission & receipts** | Expand current planned V2-4: appropriateness gates, salience, bounded brief/recall | Nacre itself supplies useful current context and explains inclusion/rejection |
| **V2-6** | **Memory evaluation & Lobstar backfill** | Expand current planned V2-5: replay corpus, retrieval and stale-memory tests, staged real import | Quality thresholds pass on the OpenClaw-derived evaluation set; full import is reproducible |
| **V2-7** | **Agent integration: Hermes first** | Expand current planned V2-6: lifecycle hooks/provider/MCP and consultation instructions | Fresh Hermes sessions consult Nacre and retrieve imported continuity |
| **V2-8** | **Multi-device sync** | Renumber current planned V2-7 | Existing sync goals remain unchanged |

### Load-bearing design rules

- Raw evidence is immutable; derived memory is rebuildable.
- Event time and ingestion time are separate fields.
- Evidence identity, not raw text frequency, drives reinforcement.
- Normalization never silently deletes source material.
- Copied/synthetic context is not independent corroboration.
- Deterministic code owns parsing, identity, chronology, storage, and receipts.
- Optional LLM work runs offline during consolidation and only proposes candidates.
- Candidate promotion remains reviewable and source-backed.
- Current recall excludes superseded memories by default but temporal recall can reconstruct them.
- Private OpenClaw logs never become committed test fixtures; use synthetic or redacted structurally representative fixtures.

---

## 3. Proposed Internal Data Flow

```text
OpenClaw archive (read-only)
        │
        ▼
source inventory + canonical file selection
        │
        ▼
Nacre-owned immutable evidence archive
(content-addressed normalized source + original digest)
        │
        ▼
normalized messages
(role, author, origin class, event time, source IDs, extraction eligibility)
        │
        ▼
episodes
(deterministic IDs, source spans, scope, bi-temporal metadata)
        │
        ▼
candidate memories
(typed claim + evidence refs + confidence + salience inputs)
        │
        ▼
consolidation
(deduplication, corroboration, contradiction, supersession, promotion)
        │
        ▼
canonical markdown truth layer
        │
        ▼
compiled SQLite graph + embeddings
        │
        ▼
admission-aware brief/recall with receipts
        │
        ▼
Hermes lifecycle integration
```

The Nacre-owned evidence archive should live under the configured memory root in an excluded internal directory such as `.evidence/conversations/`. The truth-layer compiler already ignores dot-directories. The exact serialization format must be locked in the V2-3 design document before implementation; JSONL is preferred for appendability and straightforward replay.

---

## 4. V2-3 — Evidence-Aware Historical Ingestion

### Task 1: Adopt the revised roadmap and write the V2-3 design

**Objective:** Make historical ingestion a mainline Nacre milestone with explicit invariants and schema decisions.

**Files:**
- Modify: `docs/ROADMAP.md`
- Create: `docs/V2-3-HISTORICAL-INGESTION.md`
- Reference: `docs/V2-1-TRUTH-LAYER.md`
- Reference: `docs/V2-2-SCOPE-MODEL.md`

**Steps:**

1. Add the revised V2-3 through V2-8 sequence from this plan to `docs/ROADMAP.md`.
2. Document evidence tiers, source identity, event time vs. ingestion time, rebuild behavior, retention, sensitivity, and rollback in `docs/V2-3-HISTORICAL-INGESTION.md`.
3. Decide whether `.evidence/conversations/` is copied, hard-linked, or referenced. Default to copying normalized evidence so rebuild does not depend on `/Users/Shared/OpenclawReference` remaining mounted.
4. Define the strict idempotency contract and import transaction boundary.
5. Define which data is durable by scope and which source content is zero-retention.
6. Review the design against V2-1’s “truth in files, indexes derived” invariant.
7. Commit:

```bash
git add docs/ROADMAP.md docs/V2-3-HISTORICAL-INGESTION.md
git commit -m "docs: add historical ingestion milestone"
```

**Acceptance:** The design answers how a fresh clone rebuilds episodes and memories without the original external archive and without SQLite being the only durable copy.

### Task 2: Create structurally representative OpenClaw fixtures

**Objective:** Reproduce the archive’s difficult cases without committing Marcus’s private transcripts.

**Files:**
- Create: `packages/core/src/__tests__/fixtures/openclaw/direct-session.jsonl`
- Create: `packages/core/src/__tests__/fixtures/openclaw/repeated-context.jsonl`
- Create: `packages/core/src/__tests__/fixtures/openclaw/routed-and-cron.jsonl`
- Create: `packages/core/src/__tests__/fixtures/openclaw/session.jsonl.reset.example`
- Create: `packages/core/src/__tests__/fixtures/openclaw/session.trajectory.jsonl`
- Create: `packages/core/src/__tests__/fixtures/openclaw/sessions.json`
- Create: `packages/core/src/__tests__/openclaw-adapter.test.ts`

**Steps:**

1. Write a failing fixture test covering nested OpenClaw `{"type":"message","message":...}` records.
2. Include string and content-block arrays, tool calls, tool results, internal routed messages, cron prompts, and a copied “Recent conversation history” block.
3. Include two physical files representing the same logical session so canonical inventory can be tested.
4. Use fabricated names, paths, IDs, and content.
5. Run:

```bash
npx tsx --test packages/core/src/__tests__/openclaw-adapter.test.ts
```

Expected: FAIL because no OpenClaw adapter or inventory exists.

6. Commit the failing fixtures and tests.

### Task 3: Extend conversation types to preserve evidence identity

**Objective:** Stop reducing imported messages to only role/content/timestamp.

**Files:**
- Modify: `packages/core/src/types.ts:393-420`
- Modify: `packages/core/src/adapters.ts`
- Test: `packages/core/src/__tests__/conversation.test.ts`
- Test: `packages/core/src/__tests__/openclaw-adapter.test.ts`

**Required model additions:**

```ts
export type ConversationMessageOrigin =
  | 'direct'
  | 'quoted_context'
  | 'system'
  | 'tool_call'
  | 'tool_result'
  | 'internal_route'
  | 'cron';

export interface ConversationMessage {
  id?: string;
  parentId?: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp?: string;
  name?: string;
  toolName?: string;
  toolCallId?: string;
  origin?: ConversationMessageOrigin;
  extractionEligible?: boolean;
  sourceRef?: string;
  contentHash?: string;
}
```

Extend conversation metadata with `agentId`, `sourceNamespace`, `sourceDigest`, `eventStart`, and `eventEnd` as typed optional fields.

**Steps:**

1. Write failing tests showing all evidence fields survive adapter parsing and chunking.
2. Add the minimal type changes.
3. Preserve backward compatibility for OpenAI, Anthropic, Clawdbot, JSONL, and Nacre adapters.
4. Run conversation and adapter tests.
5. Commit with `feat: preserve conversation evidence identity`.

### Task 4: Add an import ledger and deterministic episode IDs

**Objective:** Make ingestion transactional, resumable, and strictly idempotent.

**Files:**
- Modify: `packages/core/src/store.ts`
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/conversation.ts`
- Modify: `packages/core/src/ingest.ts`
- Test: `packages/core/src/__tests__/ingest.test.ts`
- Create: `packages/core/src/__tests__/import-ledger.test.ts`

**Schema direction:**

Add a schema migration after v9 for an `imports` ledger and durable evidence references. At minimum record:

- import ID
- source namespace
- logical source/session ID
- source digest
- adapter name/version
- status (`planned`, `running`, `complete`, `failed`)
- started/completed timestamps
- message/episode counts
- evidence path
- error/report payload

Episode IDs must be deterministic from import identity plus chunk identity, not `randomUUID()`.

**Steps:**

1. Write a failing test that imports the same session twice when both `metadata.source` and `metadata.sessionId` are present. This must reproduce the pilot bug: dedup currently queries by session ID while episodes store the source path.
2. Assert the second run creates no episodes and changes no node, edge, or reinforcement counters.
3. Write a failing crash/resume test where an import stops after the first chunk.
4. Add the schema migration and store operations.
5. Generate deterministic episode IDs from stable source/message boundaries.
6. Wrap each import’s derived writes in a transaction or staging/finalization protocol.
7. Only mark an import complete after all chunks and evidence writes succeed.
8. Run:

```bash
npx tsx --test packages/core/src/__tests__/ingest.test.ts packages/core/src/__tests__/import-ledger.test.ts
```

9. Commit with `feat: make conversation ingestion idempotent`.

**Acceptance:** Two imports of identical input produce byte-equivalent derived state except for an append-only “skipped import” receipt if receipts are persisted.

### Task 5: Implement the native OpenClaw adapter

**Objective:** Parse OpenClaw v3 sessions directly without an external converter.

**Files:**
- Create: `packages/core/src/adapters/openclaw.ts`
- Modify: `packages/core/src/adapters.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/__tests__/openclaw-adapter.test.ts`

**Steps:**

1. Add `openclaw` to `ConversationFormat`.
2. Parse `session` and nested `message` records.
3. Preserve OpenClaw message IDs, parent IDs, timestamps, roles, tool names/call IDs, and text content blocks.
4. Classify cron, internal-route, tool-call, tool-result, system, quoted-context, and direct records.
5. Mark classification uncertainty rather than dropping ambiguous content.
6. Preserve exact source references for every normalized message.
7. Reject malformed records with line-numbered warnings while continuing when safe.
8. Run the fixture test and existing adapter tests.
9. Commit with `feat: add OpenClaw conversation adapter`.

### Task 6: Add canonical session inventory and backup selection

**Objective:** Select one logical source per session while retaining an audit trail of alternates.

**Files:**
- Create: `packages/core/src/import-inventory.ts`
- Create: `packages/core/src/__tests__/import-inventory.test.ts`
- Modify: `packages/cli/src/commands/ingest.ts`

**Rules to implement and test:**

- Group by logical session ID from file content, not filename alone.
- Distinguish live, reset, deleted, backup, checkpoint, trajectory, and codex-app-server files.
- Prefer the most complete valid primary session by deterministic policy.
- Do not merge trajectory events into dialogue unless explicitly requested.
- Report every excluded alternate and the reason.
- Hash content so identical backups do not become evidence.
- Allow explicit override for forensic imports.

**Verification:**

```bash
npx tsx --test packages/core/src/__tests__/import-inventory.test.ts
```

Commit with `feat: inventory historical session archives`.

### Task 7: Preserve source chronology throughout ingestion

**Objective:** Ensure entity, edge, episode, and evidence dates derive from event time rather than import time.

**Files:**
- Modify: `packages/core/src/conversation.ts:153-184`
- Modify: `packages/core/src/ingest.ts:84-187`
- Modify: `packages/core/src/store.ts`
- Test: `packages/core/src/__tests__/conversation.test.ts`
- Test: `packages/core/src/__tests__/ingest.test.ts`

**Steps:**

1. Write failing tests asserting a 2026-01 conversation creates episodes, excerpts, `firstSeen`, `lastReinforced`, and edge evidence dated 2026-01—not the current clock.
2. Keep a separate ingestion timestamp in the import ledger.
3. Use the earliest contributing event for `firstSeen` and latest independent event for `lastReinforced`.
4. Never move an entity’s `firstSeen` forward during later imports.
5. Run tests and commit with `fix: preserve event chronology during ingestion`.

### Task 8: Make reinforcement evidence-aware

**Objective:** Prevent copied context and duplicate evidence from increasing salience.

**Files:**
- Create: `packages/core/src/evidence.ts`
- Modify: `packages/core/src/ingest.ts`
- Modify: `packages/core/src/store.ts`
- Test: `packages/core/src/__tests__/evidence.test.ts`
- Test: `packages/core/src/__tests__/ingest.test.ts`

**Steps:**

1. Define stable evidence IDs from source namespace, session ID, message ID/span, and content hash.
2. Store the evidence IDs responsible for node and edge reinforcement.
3. Only increment reinforcement when an independent eligible evidence ID is new.
4. Apply zero reinforcement weight to `quoted_context`, `tool_call`, and `internal_route` by default; retain them for retrieval/audit.
5. Give direct user statements higher source authority than assistant assertions, but keep authority separate from salience.
6. Add a fixture where the same paragraph appears directly once and inside four history envelopes; assert one reinforcement.
7. Commit with `feat: make salience evidence-aware`.

### Task 9: Add batch, dry-run, resume, and report UX

**Objective:** Make large historical imports operable and inspectable.

**Files:**
- Modify: `packages/cli/src/commands/ingest.ts`
- Modify: `packages/cli/src/index.ts`
- Create: `packages/cli/src/__tests__/ingest-command.test.ts`
- Modify: `packages/cli/src/api/routes/ingest.ts` only after the CLI contract is stable

**CLI contract:**

```bash
nacre ingest /archive/agents/main/sessions \
  --graph /path/lobstar.db \
  --format openclaw \
  --recursive \
  --agent main \
  --scope agent \
  --dry-run \
  --report /tmp/lobstar-import-report.json
```

A subsequent real run should support `--resume`. The report must include selected/excluded files, warnings, counts by origin class, time range, duplicate groups, estimated evidence size, and planned scope.

**Acceptance:** Dry-run performs no graph, memory-dir, or evidence writes. Interrupted runs resume without replaying completed imports.

---

## 5. V2-4 — Memory Objects and Belief Lifecycle

### Task 10: Finish the canonical memory-object schema

**Objective:** Promote typed beliefs, not entity mentions, into durable memory.

**Files:**
- Modify: `packages/core/src/memory-file.ts`
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/store.ts`
- Test: `packages/core/src/__tests__/memory-file.test.ts`
- Create: `packages/core/src/__tests__/belief-lifecycle.test.ts`

**Required fields:**

- stable memory ID
- memory type
- claim text
- scope
- confidence
- sensitivity
- trust/source authority or equivalent evidence-quality field
- created/event time
- last confirmed time
- sources/evidence spans
- salience inputs and computed score/version
- `supersedes` / `supersededBy`
- contradiction links
- lifecycle state (`candidate`, `promoted`, `superseded`, `retired`, `forgotten`)

Do not overload graph node `status` if a dedicated memory-object lifecycle table is clearer. Lock this decision in the V2-4 design before migration.

### Task 11: Add candidate memory extraction contracts

**Objective:** Turn episodes into proposed claims, preferences, decisions, facts, and lessons with exact evidence.

**Files:**
- Create: `packages/core/src/memory-extraction.ts`
- Create: `packages/core/src/__tests__/memory-extraction.test.ts`
- Modify: `packages/parser/src/conversation-extractor.ts`
- Test: `packages/parser/src/__tests__/conversation-extractor.test.ts`

**Design:**

Separate deterministic candidate scaffolding from optional semantic extraction:

```ts
interface MemoryCandidate {
  type: MemoryObjectType;
  claim: string;
  evidenceRefs: string[];
  subjectEntityIds: string[];
  confidence: number;
  scope: string;
  sensitivity: Sensitivity;
  proposedAt: string;
  extractor: { name: string; version: string; model?: string };
}
```

The extraction stage must emit receipts and never promote directly.

### Task 12: Implement consolidation, corroboration, and supersession

**Objective:** Merge compatible candidates and preserve changing beliefs over time.

**Files:**
- Create: `packages/core/src/memory-consolidate.ts`
- Modify: `packages/core/src/memory-promote.ts`
- Modify: `packages/core/src/memory-compile.ts`
- Create: `packages/core/src/__tests__/memory-consolidate.test.ts`
- Extend: `packages/core/src/__tests__/belief-lifecycle.test.ts`

**Acceptance cases:**

- Identical claims from the same copied source do not corroborate one another.
- Independent direct statements can reinforce one memory.
- “Project is not running” followed later by “Project is running” creates temporal/supersession lineage rather than an overwrite.
- A direct user correction supersedes an assistant inference.
- Current recall excludes superseded memories by default.
- `asOf` recall can return the earlier valid belief.
- Canonical markdown includes exact source references and survives rebuild.

### Task 13: Define and implement salience scoring

**Objective:** Rank durable memories by usefulness without equating repetition with importance.

**Files:**
- Modify: `packages/core/src/memory-salience.ts`
- Create: `packages/core/src/__tests__/historical-salience.test.ts`
- Document: `docs/V2-4-MEMORY-OBJECTS.md`

**Inputs to evaluate:**

- independent reinforcement count
- source authority
- explicit correction/confirmation
- decision or outcome relevance
- temporal persistence
- freshness for stateful claims
- entity/project centrality
- contradiction/supersession state
- synthetic-context discount
- confidence

Store the component breakdown or enough source inputs to reproduce the score. Do not store an opaque model-only number.

---

## 6. V2-5 — Working Memory, Admission, and Receipts

### Task 14: Add admission policy before context assembly

**Objective:** Make similarity retrieval distinct from appropriateness for active context.

**Files:**
- Create: `packages/core/src/admission.ts`
- Modify: `packages/core/src/recall.ts`
- Modify: `packages/core/src/brief.ts` or the existing brief implementation path
- Create: `packages/core/src/__tests__/admission.test.ts`
- Extend: `packages/core/src/__tests__/recall.test.ts`

**Default rejection reasons:**

- wrong scope
- session scratch not explicitly requested
- superseded/retired/forgotten
- stale stateful claim
- below confidence threshold
- sensitivity exceeds caller policy
- duplicate information
- token-budget displacement

### Task 15: Persist recall and brief receipts

**Objective:** Explain every working-memory decision.

**Files:**
- Modify: `packages/core/src/store.ts`
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/recall.ts`
- Modify: `packages/cli/src/commands/recall.ts`
- Modify: `packages/cli/src/commands/brief.ts`
- Create: `packages/cli/src/commands/receipts.ts`
- Create: `packages/core/src/__tests__/receipts.test.ts`

Receipts must include query, requested scopes, score components, included memories, rejected candidates and reasons, source refs, token budget, and engine/extractor versions.

### Task 16: Produce a bounded session-start briefing

**Objective:** Let Nacre supply the working facts required by a fresh agent session.

**Files:**
- Modify: existing brief implementation under `packages/core/src/` and `packages/cli/src/commands/brief.ts`
- Test: add a focused historical-brief integration test under `test/integration/`

**Brief sections:**

- stable identity/relationship context
- active project context
- preferences and constraints
- recent decisions
- relevant lessons/procedures
- unresolved threads
- provenance summary/receipt handle

The briefing must be token-budgeted and must not include stale operational details solely because they were frequently mentioned historically.

---

## 7. V2-6 — Evaluation and Lobstar Backfill

### Task 17: Build the replay evaluation harness

**Objective:** Measure whether Nacre turns history into useful memory rather than a large graph.

**Files:**
- Create: `packages/eval/package.json`
- Create: `packages/eval/src/replay.ts`
- Create: `packages/eval/src/metrics.ts`
- Create: `packages/eval/fixtures/README.md`
- Create: `packages/eval/cases/historical-backfill.yaml`
- Modify: root `package.json`
- Modify: `docs/ROADMAP.md`

**Metrics:**

- episode import precision
- duplicate suppression rate
- P@k, R@k, NDCG for memory retrieval
- stale/superseded leakage rate
- provenance completeness
- chronology accuracy
- context tokens per brief
- extraction/storage/retrieval/admission failure attribution
- determinism across rebuilds

### Task 18: Define Lobstar probe questions and expected memory behavior

**Objective:** Turn the OpenClaw archive into a private acceptance corpus without committing its contents.

**Private local artifact:**
- Create during execution outside git: `.hermes/eval/lobstar-openclaw-probes.yaml`

**Probe themes:**

- Lobstar identity and role relative to Marcus
- Nacre as a passion project and its enduring design principles
- Conch’s changing architecture and migration state
- the memory-deletion incident as a durable lesson
- Marcus’s preference for grounded, build-oriented work
- obsolete `/Users/apiary` paths as historical rather than current
- repeated “Recent conversation history” not increasing confidence
- direct user corrections outranking assistant assertions

Each probe needs expected current answer, acceptable historical answer under `asOf`, forbidden stale claims, and required source evidence.

### Task 19: Run a staged real import

**Objective:** Validate quality before importing the complete archive.

**Stages:**

1. 5 hand-selected direct sessions
2. 25 sessions spanning time and topics
3. all canonical Lobstar `main` sessions
4. old workspace `MEMORY.md` and daily memory files as a separate source class
5. old Nacre graph only after defining whether it is evidence, a legacy derived view, or both

At each stage:

```bash
npm run test:all
npm run eval -- --suite historical-backfill
nacre ingest <stage-path> --format openclaw --dry-run --report <report>
nacre ingest <stage-path> --format openclaw --resume --report <report>
nacre rebuild --graph <fresh-db> --memory-dir <memory-dir>
```

Compare import, rebuild, and repeated-import hashes/counts. Stop progression if stale leakage, provenance, or dedup gates fail.

### Task 20: Add a migration manifest and rollback procedure

**Objective:** Make the real backfill reversible and auditable.

**Artifacts:**

- immutable import reports
- selected/excluded source manifest
- adapter/extractor/model versions
- source digests
- graph snapshot before each stage
- canonical memory git branch or separate repository
- documented commands to rebuild or discard the derived graph

Never modify `/Users/Shared/OpenclawReference`.

---

## 8. V2-7 — Hermes Integration

### Task 21: Choose the supported Hermes integration surface

**Objective:** Integrate Nacre as the memory authority rather than as an occasional manual lookup.

**Files:**
- Create: `docs/integrations/hermes.md`
- Likely modify: `packages/cli/src/mcp/tools.ts`
- Likely create: a standalone Hermes plugin or provider outside Hermes core

Evaluate two paths with the same acceptance tests:

1. **Nacre MCP + lifecycle skill/hooks:** smallest initial integration, explicit tools, no Hermes core change.
2. **Standalone Hermes memory-provider plugin:** native session-start recall and turn-boundary capture, but tighter coupling.

Start with MCP/lifecycle glue unless it cannot satisfy session-start briefing and turn-boundary capture without brittle prompting. Do not integrate Nacre into Hermes core.

### Task 22: Add session lifecycle operations

**Objective:** Close the loop between active Hermes conversations and Nacre.

**Required lifecycle:**

- Session start: request bounded Nacre brief for current profile/project.
- Before compression: capture unresolved decisions/facts as candidate evidence.
- Turn/session end: append normalized conversation evidence without blocking the hot path.
- Explicit correction: record correction/supersession candidate.
- Explicit recall: query Nacre with scopes and return receipt/source refs.

### Task 23: Dogfood Lobstar on Nacre

**Objective:** Prove imported continuity is useful in this Hermes profile.

**Acceptance session:**

Start a fresh Lobstar session with no OpenClaw archive manually attached. Verify that Nacre can answer the private probe set, distinguish historical from current machine state, cite source episodes, and produce a compact session brief. Holographic may remain installed but must not be required for those answers.

---

## 9. Cross-Cutting Verification

Run these gates after each milestone:

```bash
npm run build
npm run typecheck
npm run test:all
npm run lint
```

Add targeted commands as files land:

```bash
npx tsx --test packages/core/src/__tests__/openclaw-adapter.test.ts
npx tsx --test packages/core/src/__tests__/import-ledger.test.ts
npx tsx --test packages/core/src/__tests__/evidence.test.ts
npx tsx --test packages/core/src/__tests__/memory-consolidate.test.ts
npx tsx --test packages/core/src/__tests__/admission.test.ts
npx tsx --test packages/core/src/__tests__/receipts.test.ts
```

### Non-negotiable regression tests

- Same source twice: no derived changes.
- Same text from copied context: no extra reinforcement.
- Same claim from independent direct evidence: reinforcement occurs once per evidence source.
- Old event imported today: event dates remain old; ingestion date remains today.
- Correction: current recall returns corrected belief; `asOf` returns prior belief.
- Rebuild: canonical memory and evidence reproduce equivalent recall results.
- Interrupted import: resume completes without duplicate episodes.
- Dry-run: no writes.
- Private fixture guard: CI rejects source paths or fixture content copied from `/Users/Shared/OpenclawReference`.
- Scope isolation: imported agent memory cannot leak into unrelated project/session scopes.

---

## 10. Risks and Tradeoffs

### Graph explosion

The pilot produced 140 nodes and 7,107 edges from ten messages. Treat this as a quality failure signal, not a success metric. Candidate extraction and edge formation need budgets, evidence thresholds, and evals before full import.

### Canonical-file explosion

A long archive may yield thousands of candidate memories. Only promoted durable memories should become canonical markdown; raw evidence belongs in the internal evidence archive. Candidate retention and review policies need explicit limits.

### Privacy and source retention

Historical logs may contain secrets, credentials, personal data, or private tool output. Add secret/PII scanning before copying evidence. Secret-class content must remain zero-retention in durable memory, consistent with `memory-file.ts`.

### LLM nondeterminism

Offline semantic consolidation can use an LLM, but every proposal needs the extractor/model/version, source evidence, and a replayable receipt. Deterministic import and storage must not depend on model behavior.

### False supersession

Two claims can conflict because they refer to different scopes or times rather than because one replaces the other. Prefer unresolved contradiction over automatic destructive supersession when subject, scope, or validity interval is ambiguous.

### Source archive ambiguity

The OpenClaw directory contains primary, reset, deleted, backup, checkpoint, trajectory, and provider-specific files. Canonical selection must be deterministic and visible in the dry-run report. Never silently union all of them.

### Integration coupling

A Hermes-native provider offers smoother lifecycle behavior but can couple Nacre to Hermes internals. Keep the Nacre API/MCP contract authoritative and package Hermes glue separately.

---

## 11. Open Decisions to Resolve in V2-3 Design Review

1. Exact durable format and location of normalized evidence under the truth layer.
2. Whether normalized evidence is git-synced by default or governed by scope/sensitivity policy.
3. Whether the import ledger is fully rebuildable from evidence receipts or partly operational SQLite state.
4. Whether message-level evidence gets a first-class table or content-addressed files plus episode spans.
5. How to represent validity intervals before full bi-temporal reasoning exists.
6. Whether confidence and source authority are separate fields.
7. The minimum deterministic extraction baseline when no LLM is configured.
8. The model/provider policy for offline candidate extraction and consolidation.
9. Promotion thresholds and whether high-impact memories require review.
10. Whether the old Nacre `graph.json` is imported as historical evidence, migrated as a legacy derived view, or used only for evaluation comparison.
11. Whether Hermes integration starts as MCP/lifecycle glue or a standalone memory-provider plugin.

---

## 12. Recommended First Implementation Slice

Implement V2-3 through a narrow end-to-end slice before touching semantic consolidation:

1. Adopt the roadmap and V2-3 design.
2. Add synthetic OpenClaw fixtures.
3. Parse one OpenClaw session natively.
4. Write Nacre-owned normalized evidence.
5. Record an import-ledger entry.
6. Create deterministic, correctly dated episodes.
7. Re-import and prove a no-op.
8. Rebuild into a fresh database and prove equivalent episodes.
9. Add CLI dry-run/report output.

This slice directly fixes every defect observed in the pilot—format handling, deduplication, chronology, repeated context classification, and rebuildability—without prematurely designing the full belief engine.

Only after that slice passes should implementation move into V2-4 candidate memories and supersession.

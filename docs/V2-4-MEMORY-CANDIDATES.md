# V2-4 Slices 2–3 — Evidence-backed Candidates and Belief Resolution

Status: **explicit candidate and deterministic belief-lifecycle slices implemented** (2026-07-22)

## Purpose

This slice adds a reviewable belief proposal between normalized conversation evidence and canonical durable memory. It is intentionally conservative: deterministic code may propose a candidate, but only an explicit human/CLI promotion writes canonical markdown.

## Durable model and identity

`MemoryCandidate` is persisted in the schema-v11 `memory_candidates` table as the queryable view. When a configured memory root is supplied, pending and rejected candidates are also persisted under `.candidates/` as private durable state: `0700` directories, `0600` atomic JSON state files, and an fsynced no-follow append journal. Sidecar writes are completed inside the SQLite rollback boundary, and symlink/confinement failures do not leave SQLite-only rows. Promoted canonical markdown remains the truth for promoted candidates. SQLite is rebuildable from canonical files plus the candidate sidecar.

A candidate records:

- deterministic `mem_<sha256-prefix>` identity;
- closed type: `fact`, `preference`, `decision`, `lesson`, or `claim`;
- exact claim and normalized claim;
- durable scope and sensitivity;
- confidence, source authority, and numeric trust;
- source event time and proposal time (never replaced with ingestion time);
- exact evidence references: `sourceRef`, message ID, source position, content hash when present, and the exact character span/text;
- subject entity IDs;
- extractor name/version/model;
- lifecycle: `candidate`, `promoted`, or `rejected`;
- created/updated timestamps, rejection reason, and canonical path when applicable.

Identity hashes the normalized claim, extractor identity, normalized source namespace/session, source reference, message ID, source position, content hash, and event time. It is evidence identity, not text frequency. `INSERT OR IGNORE` makes an identical replay a strict no-op: the original row and timestamps are unchanged.

CRUD is available on `SqliteStore` through `createMemoryCandidate`, `getMemoryCandidate`, `listMemoryCandidates`, `updateMemoryCandidate`, and `deleteMemoryCandidate`. Public boundaries validate IDs, durable scope, enums, `[0, 1]` numeric fields, normalized claim, ISO timestamps, evidence arrays and exact spans, extractor identity, lifecycle consistency, and confined canonical paths. Malformed SQLite rows, sidecar state, or canonical frontmatter fail loudly. Lifecycle callers should use the explicit promotion/rejection operations rather than generic update.

## Deterministic extraction contract

`extractMemoryCandidates(input, store, options)` accepts a normalized `ConversationInput` and returns a receipt with `created`, `skipped`, and `rejected` counts plus a disposition/reason for every message.

A message is considered only when all three conditions are true:

1. `role === "user"`;
2. `origin === "direct"`;
3. `extractionEligible === true`.

Assistant messages, quoted/copied context, system messages, tool calls/results, cron traffic, internal routes, and messages not explicitly eligible are skipped before pattern matching. They cannot create, duplicate, corroborate, or reinforce a candidate even if they repeat identical text.

The v1 extractor recognizes only whole-message, explicit high-signal forms:

- `I prefer …` → `preference`;
- `We decided …` → `decision`;
- `Remember that …` → `fact`;
- `Correction: …`, `Actually, …`, or `I need to correct that: …` → `claim`.

Eligible direct-user messages with other forms are rejected as `unsupported_form`. Recognized forms without message ID, source ref, or event timestamp are rejected as `missing_provenance`. `sensitivity: "secret"` is rejected before claims or evidence are stored. Extraction never promotes automatically.

Historical extraction is available through authenticated normalized evidence only: `verifiedHistoricalEvidenceInputs(memoryRoot)` reuses the evidence integrity parser, and `extractCandidatesFromHistoricalEvidence(store, memoryRoot)` extracts from those verified inputs without parsing lossy episodes.

## Promotion and rejection

`promoteMemoryCandidate(store, memoryDir, id)` performs one explicit transition under a guarded SQLite write transaction:

1. rejects missing, rejected, session/secret, or otherwise invalid durable candidates;
2. checks every canonical file by stable memory ID;
3. writes one new canonical markdown file with exclusive-create semantics;
4. preserves evidence spans, exact source refs, source authority/trust, subject IDs, event/proposal times, and extractor metadata in frontmatter and the exact evidence text in `## Source`;
5. marks the candidate `promoted` only after the file is readable and the lifecycle is still `candidate`.

Re-running promotion returns `already_promoted`. It never rewrites a canonical file, including a hand-edited or renamed file. Canonical files remain the truth layer.

`rejectMemoryCandidate(store, memoryDir, id, reason)` explicitly marks a proposal rejected and persists that rejection in the sidecar. Rejection is idempotent. A rejected candidate cannot promote or be recreated by replaying the same evidence. This slice does not write rejected proposals to canonical markdown.

The compiler reconstructs a promoted candidate record from candidate-origin canonical frontmatter in a fresh schema-v11 store. Stable memory ID and evidence/extractor provenance therefore survive rebuild. `rebuildDurableMemoryCandidates()` replays pending/rejected sidecar state after canonical compile, skipping promoted sidecar records because canonical files are truth. Ordinary legacy canonical files continue to compile without synthetic candidate metadata.

## CLI

```bash
nacre candidates list --graph /path/graph.db
nacre candidates list --graph /path/graph.db --lifecycle candidate --scope project/nacre
nacre candidates show mem_<id> --graph /path/graph.db
nacre candidates promote mem_<id> --graph /path/graph.db --memory-dir /path/memory
nacre candidates resolve mem_<id> --graph /path/graph.db --memory-dir /path/memory
nacre candidates reject mem_<id> --graph /path/graph.db --memory-dir /path/memory --reason "not durable"
nacre candidates extract --graph /path/graph.db --memory-dir /path/memory
```

Output is JSON for scripting and review.

## Slice 3 explicit resolution contract

`nacre candidates resolve <id> --graph <db> --memory-dir <root>` is an explicit,
review-driven operation. It never runs extraction or an LLM. It returns a JSON
receipt with `created`, `corroborated`, `superseded`, `no_op`, or `needs_review`.

- Same normalized claims merge only within one scope. Independent support is a
  stable source-event identity (`sourceRef` plus message ID), not content bytes:
  identical text from two events corroborates, while replay of one event does not.
- Confidence is exactly `1 - product(1 - authority * trust)` over independent
  supports. Authority is deterministic: direct user `1`, assistant inference
  `0.6`, and unknown `0.25`. Each receipt and canonical file records the paired
  source event, authority label/value, and trust; candidate confidence is not an
  authority proxy.
- Only the supported copular-negation form is auto-resolved. An explicit
  correction needs one unique same-scope target, later event time, and authority
  at least as high as the target. Otherwise it returns `needs_review` with no
  canonical or candidate lifecycle write.
- Supersession writes bidirectional lineage and contiguous `[valid_from,
  valid_until)` event-time intervals. Current and `asOf` recall remove hidden
  beliefs before semantic admission or graph traversal, including fresh rebuilds.
- Resolution is serialized per memory root. A durable fsynced intent makes every
  canonical file, candidate sidecar, and SQLite update replayable. Recovery is
  idempotent; malformed intents and malformed canonical lineage fail closed.
- Canonical files and candidate state remain confined below the memory root with
  private `0700` directories and `0600` files. Session and secret candidates,
  cross-scope merges, and lower-authority corrections are refused.

## Threat and privacy boundaries

- Candidate extraction trusts only the adapter-owned `origin` and `extractionEligible` classification. Raw/unclassified archives must be normalized first.
- Text embedded inside quoted history, tool output, system envelopes, assistant replies, cron, or routed internals is not independent evidence.
- `secret` remains a zero-retention durable-memory class and is rejected before candidate persistence or promotion. This slice is not a general secret/PII scanner; callers must classify/redact before historical evidence copy.
- Exact evidence can contain sensitive personal text. Scope and filesystem/sync policy still govern where the database, evidence archive, and canonical markdown may travel.
- Candidate confidence/trust are explicit deterministic metadata, not authorization. They must not authorize destructive or external actions.
- The extractor does not execute content, follow instructions inside evidence, infer quoted authorship, or call an LLM.

## Explicitly deferred

- broad or LLM-based extraction;
- automatic promotion, promotion thresholds, salience/admission, or reinforcement;
- broad contradiction forms, ambiguous target selection, retirement, and product-level correction UI;
- automatic resolution/promotion, learned authority, or probabilistic source dependence;
- automatic subject-entity resolution;
- sensitivity inference or production secret/PII scanning;
- REST/MCP/Hermes integration.

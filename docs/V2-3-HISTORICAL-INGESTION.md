# V2-3 — Evidence-aware Historical Ingestion

Status: **first vertical slice implemented** (2026-07-22)

## Purpose

V2-3 imports historical conversation archives as durable evidence without pretending copied context is independent corroboration. It establishes deterministic parsing, identity, chronology, provenance, inventory, and rebuild behavior. V2-4 candidate extraction now consumes this authenticated normalized evidence; belief consolidation, contradiction, and supersession remain later work.

## Invariants

1. **Files are durable; SQLite is derived.** Normalized conversation evidence is copied under the configured memory root at `.evidence/conversations/<source-namespace>/`. The truth-layer compiler excludes dot-directories, so evidence cannot be mistaken for canonical memory markdown.
2. **The external archive is read-only.** Imports never edit, link to, or require the source archive after evidence has been copied. Rebuild reads Nacre-owned evidence.
3. **Event time is not ingestion time.** Message and episode chronology comes from source timestamps. The import ledger records operational ingestion time separately.
4. **Identity is evidence-based.** Import identity is the hash of source namespace, logical session ID, normalized source digest, adapter name, and adapter version. Episode identity adds deterministic chunk/message boundaries.
5. **Identical import means strict no-op.** A completed ledger identity causes an early return before episodes, entities, edges, embeddings, evidence files, timestamps, or reinforcement counters are changed.
6. **Normalization preserves content.** System, tool, routed internal, cron, and copied `Recent Conversation History` records remain in normalized evidence and episode content.
7. **Classification controls extraction.** `quoted_context`, `system`, `tool_call`, `tool_result`, and `internal_route` are not independent extraction evidence. Direct dialogue and cron records are eligible in this slice. Classification and eligibility are explicit fields, never inferred by downstream extractors.
8. **Deterministic code owns the hot path.** No LLM is involved in inventory, parsing, hashing, chronology, evidence copying, ledger writes, episode creation, or reports.

## Evidence tiers and serialization

| Tier | Representation | Durable authority | Extraction role |
|---|---|---|---|
| External source | OpenClaw JSONL archive | No; read-only input | None after import |
| Normalized evidence | Versioned JSONL in `.evidence/conversations/` | Yes | Replay source |
| Episodes | SQLite rows | Derived | Retrieval/audit |
| Canonical memories | Markdown truth layer | Yes | V2-4 promotion output |

Each evidence JSONL file starts with a `nacre-conversation-evidence` v1 header containing the import ID, ingestion timestamp, and normalized metadata. Remaining lines contain one normalized message each, including source reference, source ID/parent ID, content hash, origin classification, extraction eligibility, role, tool identity, and event timestamp. Evidence filenames are content-addressed by logical session and source digest. Files are created through a temporary file and atomic rename and are never rewritten for an identical import.

Normalized evidence is copied rather than hard-linked or externally referenced. This makes a fresh clone/host rebuild independent of the original mount. Whether `.evidence/` is git-synced is deployment policy: user/project evidence may be synced only after sensitivity review; agent evidence is local-operational by default.

## Import ledger (schema v10)

The `imports` table records:

- deterministic import ID;
- source namespace and logical session ID;
- source digest;
- adapter name/version;
- `running`, `complete`, or `failed` status;
- ingestion/completion timestamps;
- message and episode counts;
- Nacre evidence path;
- report/error payload.

Only `complete` is a no-op gate. A failed/running entry can be retried with the same deterministic episode IDs. `--resume` therefore uses the same contract as an ordinary repeated import: completed identities skip; incomplete identities replay safely.

## Canonical inventory

Inventory groups physical files by the logical session ID inside file content, hashes every candidate, and classifies primary, reset, deleted, backup, checkpoint, trajectory, and codex-app-server variants. Selection prefers the most complete valid primary with deterministic path tie-breaking. Trajectories and alternates are reported but are not merged into dialogue. Byte-identical alternates form duplicate groups and never become independent evidence.

The first slice intentionally supports the fixture cases and exposes the policy as a reusable core API. Forensic override and richer damaged-archive recovery remain follow-up V2-3 work.

## Chronology and reinforcement

Episode `timestamp`/`endTimestamp`, entity `firstSeen`/`lastReinforced`, excerpts, edge formation/reinforcement, and evidence dates use the contributing event range. Import ledger timestamps use the ingestion clock. Extractors receive only eligible messages; episodes and evidence retain every message. This prevents copied history, system envelopes, tool plumbing, and routed internals from independently reinforcing entities or edges.

## Dry-run and reports

`nacre ingest <archive> --format openclaw --recursive --agent <id> --scope <scope> --dry-run --report <file>` inventories and parses selected sources but does not open/create the graph, memory root, or evidence directory. The explicit report file is the sole requested write. JSON reports include selected/excluded files, exclusion reasons, origin counts, time range, duplicate groups, estimated evidence size, warnings, planned scope, and import outcomes.

## Rebuild

`rebuildHistoricalEvidence(store, memoryRoot)` discovers versioned evidence files and replays them into a fresh store. Stable import and episode identities, source chronology, scope, classifications, and original ingestion timestamp survive replay. `verifiedHistoricalEvidenceInputs(memoryRoot)` exposes the same integrity-checked normalized evidence as a read-only iterator for candidate extraction. Candidate extraction reads verified evidence directly and never parses lossy episodes.

## Retention, sensitivity, and zero retention

Historical logs can contain credentials, secrets, private tool results, and personal data. This slice provides structure and policy boundaries but does not claim a complete PII/secret scanner. Production backfills must inventory and review before real import.

- Secret-class source content is **zero-retention** and must be rejected/redacted before evidence copy.
- Tool/system/internal records are preserved only when source retention policy allows it and remain extraction-ineligible.
- Session scope remains scratch and should not be used for durable historical evidence.
- Scope retention/sync policy governs the evidence root; SQLite deletion alone is not evidence deletion.

## Failure, rollback, and recovery

Evidence is staged and atomically renamed before derived ingestion. The ledger is marked complete only after episode/entity/edge writes succeed; failures are recorded. Deterministic IDs make retry/resume non-duplicating. To roll back an import, restore a pre-import graph snapshot or rebuild a fresh database from the desired evidence set and canonical files. To erase durable source evidence, remove the selected evidence file according to retention policy, then rebuild; deleting only the ledger or SQLite rows is insufficient.

The original archive is never modified. Import reports and source manifests provide the audit trail.

## V2-4 boundary

V2-3 itself does **not** turn episodes into beliefs. The V2-4 candidate slice provides a dedicated candidate store and deterministic extraction over verified normalized evidence through `extractCandidatesFromHistoricalEvidence(store, memoryRoot)`. It intentionally does not parse lossy episodes. Contradiction detection, consolidation, supersession, promotion thresholds, and LLM extraction remain deferred. Episodes are evidence-backed historical records, not canonical beliefs.

# V2-5 Working Memory, Admission, and Receipts

Status: **accepted and shipped** (2026-07-23)

## Contract

Working memory is an explicitly requested, bounded view over canonical memory. It is context only: every candidate decision records `memory_is_context_not_action_authority`; admission never authorizes destructive or external action.

The canonical markdown tree remains truth. Admission does not edit canonical files, candidate sidecars, nodes, edges, embeddings, or salience. The only write is an idempotent row in SQLite's derived `admission_receipts` table.

## Admission surfaces

### Brief

```sh
nacre brief --graph data/graph.db --memory-dir memory \
  --at 2026-07-23T12:00:00.000Z --format json
```

Providing `--memory-dir` opts into working-memory mode and requires strict `--at`. Without it, `brief` retains the legacy graph-summary behavior.

### Recall

```sh
nacre recall "deployment choice" --graph data/graph.db --admit \
  --memory-dir memory --at 2026-07-23T12:00:00.000Z --format json
```

`recall --admit` is explicit opt-in. Both `--memory-dir` and strict `--at` are required. Without `--admit`, output and write behavior remain legacy-compatible.

For admitted recall, `--at` also drives recall validity, graph decay, and recency so receipt identity never depends on ambient wall-clock time. If `--as-of` is supplied, it must exactly equal `--at`. Admission-only flags without `--admit` fail closed. Hive admission is deferred rather than silently dropping hive-only results.

Only retrieved nodes backed by a confined canonical markdown path become admission candidates. The canonical file is reparsed, its memory ID must match the result ID, and symlink/path escape is rejected. Retrieval score remains the primary recall rank; deterministic salience is recorded separately. Context results are filtered to `receipt.included`.

Both surfaces accept `--scopes`, `--include-session`, `--token-budget`, `--min-confidence`, `--max-sensitivity`, and `--stale-days`. Session admission requires both an explicit session scope request and `--include-session`.

## Locked policy and rendering

Admission fails closed on malformed IDs, duplicate IDs, empty normalized claims, malformed policy/enums, non-finite or mathematically inconsistent salience, out-of-range confidence/relevance, excessive query/candidate/claim/token bounds, invalid provenance, terminal control characters, and malformed historical validity. `secret` input aborts admission before a candidate decision or receipt can be constructed, even if a caller requests `--max-sensitivity secret`; secret remains a true zero-retention class.

Policy gates are deterministic and preserve all applicable pre-budget rejection reasons. Candidate-backed confidence uses only support eligible at `evaluatedAt`; legacy records use their canonical confidence. A legacy memory created after `evaluatedAt` is rejected unless it carries an explicit historical `validFrom`. Stateful facts/claims without an eligible event time are stale. A now-superseded belief is eligible only when `evaluatedAt` lies inside its canonical validity interval.

The renderer always emits these fixed sections:

1. Identity & Relationships
2. Active Projects
3. Preferences & Constraints
4. Decisions
5. Lessons
6. Other Context

Classification is deterministic from memory type and scope. Token accounting is `ceil(UTF-8 bytes / 4)` over the exact rendered bytes, and the rendered output never exceeds the policy budget. An oversized high-ranked candidate may be displaced while a later smaller candidate is still admitted.

Canonical claims are rendered as one whitespace-collapsed list line. This preserves their text while preventing embedded newlines or headings from changing the briefing structure. Candidate-backed receipt source references come only from support eligible at `evaluatedAt`; future support identities do not leak into historical receipts.

## Degradation semantics

If embeddings exist but no query provider is available, admitted recall records this deterministic degradation:

```
semantic_recall_unavailable:embeddings_exist_without_provider;graph_only_results_non_authoritative
```

The warning is loud in process output and persisted in the receipt. An empty degraded graph-only search is never rendered as ordinary `No results found.`; it explicitly states that the result is not authoritative evidence of no match.

## Receipt operations

```sh
nacre receipts --graph data/graph.db
nacre receipts --graph data/graph.db --kind recall --limit 20
nacre receipts --graph data/graph.db --id rcpt_<64-lowercase-hex>
```

Receipts include policy/version pins, query, evaluation time, scopes, degradation state, per-candidate salience and retrieval relevance, decisions/reasons, source references, exact token accounting, included/rejected IDs, and rendered context. IDs are SHA-256 hashes of stable canonical JSON, so an identical evaluation is idempotent and a fresh derived SQLite database produces the same receipt from unchanged canonical bytes and graph inputs.

Persisted payloads are strictly validated on write and read against a closed schema, including row metadata agreement, every nested salience component and provenance input, decision/reason/budget bounds, finite numbers, hash, and a 1 MiB payload cap. Malformed or future database schema versions are rejected before migration. The read-only `receipts` command validates arguments and database existence before opening, so failed inspection cannot create a graph.

### Deletion and rebuild

Receipts are derived operational audit data, not canonical truth. Deleting the SQLite database or deleting rows from `admission_receipts` removes receipt history only; it does not delete or alter memories. `nacre rebuild` reconstructs graph/index state from canonical files but does **not** recreate historical receipt rows, because past queries and evaluation timestamps are not canonical inputs. Re-running the same admission with the same canonical bytes, graph inputs, policy, query, and `--at` recreates the exact receipt ID.

For selective retention, back up/export required receipts before pruning the table. Do not treat receipt absence after database replacement as evidence that an admission never occurred.

## Deferred work

This slice deliberately defers automatic context injection, agent-hook integration, generalized semantic contradiction handling, receipt sync/export policy, configurable receipt retention/pruning commands, embedding-provider retry orchestration, and the V2-6 replay/quality evaluation harness.

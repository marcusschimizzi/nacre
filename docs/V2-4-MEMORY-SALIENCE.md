# V2-4 Slice 4 — Deterministic Memory Salience

Status: **implemented pending acceptance review** (2026-07-23)

## Purpose

Slice 4 ranks canonical durable memories by likely usefulness without treating raw repetition as importance. It is a derived, deterministic scoring layer over canonical belief truth. It does not decide admission into working context.

## Boundary

This slice adds:

- a pure salience evaluator;
- stable multi-memory ranking;
- versioned component receipts;
- deterministic graph-degree helpers;
- a read-only `nacre salience` inspection command.

It does **not** change query relevance, `recall`, `brief`, admission thresholds, token budgets, archive import, or Hermes integration. Those remain later slices.

## Evaluation contract

Every evaluation requires an explicit strict ISO timestamp:

```text
2026-07-23T12:00:00.000Z
```

No wall-clock, ingestion-time, or rebuild-time value enters the score.

Receipts use version `nacre.salience.v1` and formula:

```text
rawScore = sum(weight * component) * validity * provenance
score = round(rawScore, 6 decimal places)
```

Fixed weights:

| Component | Weight |
|---|---:|
| confidence | 0.25 |
| source authority | 0.15 |
| independent corroboration | 0.15 |
| memory-type relevance | 0.10 |
| temporal persistence | 0.10 |
| freshness | 0.10 |
| entity/project centrality | 0.10 |
| explicit confirmation or correction | 0.05 |

Every component and gate is bounded to `[0,1]`. `rawScore` remains in the receipt so the rounded public score can be checked rather than trusted as an opaque scalar.

## Components

### Confidence and authority

Candidate-backed memories are recomputed only from support records whose source event time is at or before `evaluatedAt`.

Confidence is:

```text
1 - product(1 - authority * trust)
```

Authority is the maximum eligible independent support's paired authority and trust product. A weaker corroborating event can add confidence and corroboration, but cannot dilute stronger source authority. Authority mappings remain:

- direct user: `1.0`;
- assistant inference: `0.6`;
- unknown: `0.25`.

Trust never migrates between supports.

### Independent corroboration

Evidence identity is the injective tuple `[sourceRef, messageId]`, encoded as a JSON pair in receipts. Multiple candidates for one event count once. Exact repeats are deduplicated; conflicting authority, trust, or event time for one identity fails closed. Zero-trust events do not count as support. Independent support saturates with:

```text
1 - exp(-(independentEventCount - 1) / 2)
```

Copied/replayed events therefore cannot increase corroboration, confidence, persistence, or confirmation.

### Type relevance

The fixed mapping is:

- decision: `1.0`;
- lesson: `0.9`;
- preference: `0.85`;
- fact: `0.7`;
- claim: `0.6`.

This is a transparent prior, not a truth judgment.

### Temporal persistence

Persistence uses the interval between the earliest and latest eligible independent source-event times and saturates at 180 days. One event contributes zero persistence.

### Freshness

Only `claim` and `fact` are treated as stateful in this slice. Their freshness is:

```text
exp(-ageInDays / 180)
```

Age starts at the newest eligible source event. Preferences, decisions, and lessons receive freshness `1`; they do not decay merely because time passed.

### Centrality

The graph helper counts unique adjacent node IDs, ignoring self-loops and replayed duplicate edges. Degree is transformed independently of the evaluation batch:

```text
1 - exp(-degree / 4)
```

The core evaluator accepts a deterministic degree map. The initial CLI intentionally reads canonical files only and therefore evaluates centrality as zero; callers with a rebuilt graph can supply the graph-derived map through the core API. This avoids opening or migrating SQLite during a command whose contract is read-only.

### Confirmation and correction

Candidate-backed confirmation requires more than one eligible independent event. Legacy confirmation must have occurred no later than `evaluatedAt`. A successor's explicit `supersedes` relation contributes correction only once its validity begins. A predecessor's future `supersededBy` metadata never leaks into an earlier historical score.

## Gates

### Validity

Canonical validity is `[validFrom, validUntil)`. A superseded belief can score during its historical interval. Outside that interval its validity gate is zero. Malformed or reversed intervals fail closed.

### Provenance

Candidate-backed provenance receives gate `1` only when at least one eligible, valid, correctly owned support exists. Malformed support or centrality input fails closed at score zero.

Legacy canonical files receive a conservative `0.5` provenance gate only when they retain a source and finite confidence. Legacy confidence is capped and halved. Legacy reinforcement counters never become independent historical corroboration.

Synthetic/copied context cannot create eligible candidate records upstream. Salience does not reconstruct authorship from text and never upgrades unclassified repetition.

## Historical behavior

Support records after `evaluatedAt` do not affect confidence, authority, corroboration, persistence, freshness, or confirmation. Stable ranking ties resolve by memory ID. The same canonical bytes, rebuilt graph, and evaluation timestamp produce the same receipt and order.

## Persistence and rebuild

Time-dependent scores are not written to markdown or SQLite. Canonical files retain the evidence and belief inputs needed to reproduce them; graph centrality is derived from rebuilt graph edges. Repeated evaluation writes nothing.

## CLI

```bash
nacre salience \
  --memory-dir /path/to/memories \
  --at 2026-07-23T12:00:00.000Z \
  --limit 20
```

The command emits stable JSON containing total canonical memory count and ranked receipts. It does not open a graph database or mutate the memory root.

## Explicitly deferred

- query-specific relevance and recall score integration;
- appropriateness/admission thresholds;
- rejected-memory receipts;
- token-budget displacement;
- bounded session briefings;
- real-history evaluation/import;
- Hermes lifecycle integration;
- LLM salience scoring.

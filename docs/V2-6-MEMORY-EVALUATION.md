# V2-6 Memory Replay Evaluation — Slices 1–2

Status: implemented as two bounded V2-6 vertical slices.

## Purpose

This slice turns deterministic working-memory behavior into a machine-checkable quality gate before any private Lobstar archive backfill. It evaluates canonical Nacre memories at explicit probe times; it does not use an LLM judge and does not import private history.

The second slice adds a truthful query boundary: it executes Nacre's actual hybrid recall path, captures raw ordered retrieval before canonical filtering, and scores retrieval separately from admission.

The shipped public boundary is:

```bash
nacre evaluate replay corpus.json --memory-dir /path/to/memory --format json
```

A passing report exits 0. A well-formed report that misses a threshold is still printed and exits 1. Malformed manifests, canonical memories, policies, receipts, timestamps, IDs, or thresholds fail closed.

## Replay manifest

```json
{
  "version": "nacre.replay-manifest.v1",
  "id": "synthetic-example",
  "thresholds": {
    "minCandidatePrecisionAtK": 1,
    "minCandidateRecallAtK": 1,
    "minCandidateNdcgAtK": 1,
    "minAdmissionPrecision": 1,
    "minAdmissionRecall": 1,
    "minProvenanceCompleteness": 1,
    "maxUnsupportedIncluded": 0,
    "maxForbiddenLeakage": 0,
    "maxContextTokensPerProbe": 2000
  },
  "probes": [
    {
      "id": "current-brief",
      "evaluatedAt": "2026-07-23T12:00:00.000Z",
      "expectedRelevantMemoryIds": ["mem_aaaaaaaaaaaa"],
      "forbiddenMemoryIds": [],
      "policy": { "tokenBudget": 2000 }
    }
  ]
}
```

Expectation arrays are sorted, duplicate-free, bounded lists of valid memory IDs. Every probe requires at least one relevant memory; relevant and forbidden sets must be disjoint. Probe time is strict ISO event time. Unknown fields are rejected rather than ignored. Corpora are limited to 1,000 probes, labels to 256 UTF-8 bytes, and manifests to 4 MiB. The canonical scanner stops at 20,000 entries, 64 directory levels, 10,000 memory files, 64 MiB aggregate memory bytes, or 1 MiB per memory file. Symbolic links and special files are rejected.

## Metric definitions

For each probe:

- `candidatePrecisionAtK`: relevant memories among the first `K` salience-ranked canonical admission candidates, divided by the declared `K`, where `K` is the number of expected relevant memories. Missing candidate positions count as non-relevant.
- `candidateRecallAtK`: expected relevant memories present in that same top-K candidate set.
- `candidateNdcgAtK`: binary-relevance normalized discounted cumulative gain over the ranked canonical candidates.
- `admissionPrecision`: expected relevant memories among admitted memories.
- `admissionRecall`: expected relevant memories that were admitted.
- `unsupportedIncluded`: admitted memories in neither the expected-relevant nor forbidden set.
- `forbiddenLeakage`: forbidden memories that were admitted. This is the temporal/correction leakage gate.
- `provenanceCompleteness`: admitted memories whose admission candidate carries at least one eligible source reference.
- `contextTokens`: the exact versioned UTF-8 token estimate from the admission receipt.

These are candidate-ranking metrics, not semantic-query retrieval metrics. The exported evaluator requires every probe to declare `candidateSet: "complete_canonical"` and rejects non-`brief` receipts; this makes storage-presence attribution explicit rather than inferring completeness from an arbitrary receipt. The defaults are intentionally strict: perfect candidate ranking/admission/provenance, zero unsupported or forbidden inclusion, and at most 2,000 estimated context tokens per probe. Corpora may explicitly loosen thresholds, but the report records the effective values.

## Determinism and writes

The evaluator reads canonical memory files, runs the existing event-time salience and admission pipeline, and returns a deterministic JSON report. Every probe carries its admission receipt ID, oracle IDs, ranked candidate IDs, included IDs, metrics, stage-attribution events, and explicit gate violations. Gate violations record the metric, actual value, comparator, and threshold; `passed` is derived from that list. Attribution events remain raw observations even if a corpus deliberately loosens a related threshold. The report has a `replay_<sha256>` content ID computed over canonical report JSON excluding only that ID. It does not persist admission receipts, alter canonical files, create candidates, or mutate the source corpus. Repeating the same command over the same bytes—even under a fresh filesystem root—produces byte-identical output.

The synthetic end-to-end acceptance history runs twice under independent fresh roots and requires identical candidate IDs, canonical bytes, historical/current receipts, reports, and report IDs. It covers:

1. a direct user fact;
2. a copied-context repetition that must create no candidate;
3. a later direct correction;
4. explicit candidate resolution and supersession;
5. a historical probe before the correction;
6. a current probe after the correction;
7. zero forbidden leakage and complete admitted provenance at both times.

This fixture is synthetic and committed only as test code; no private OpenClaw text or paths enter Git.

## Failure attribution coverage

This slice can distinguish:

- `storage`: an expected canonical memory never appears in the complete canonical candidate set;
- `admission`: an expected candidate is present but rejected;
- `use`: unsupported or forbidden material reaches the rendered context.

The report explicitly marks `extraction` and `retrieval` coverage as `false`, and their attribution-event counts as `null`. Storage is observable because the CLI passes the complete canonical file set into admission. It does not pretend that an unmeasured stage had zero failures. The synthetic integration test exercises extraction and canonical resolution, but production corpus-wide extraction attribution requires a later manifest carrying expected source-message identities. Actual query retrieval requires a separate raw retrieval trace and must not be inferred from an admission receipt.

## Slice 2: deterministic explicit recall

The second public boundary is:

```bash
nacre evaluate recall recall-corpus.json \
  --graph /path/to/graph.db \
  --memory-dir /path/to/memory \
  --provider mock \
  --format json
```

Manifest version `nacre.recall-replay-manifest.v1` declares the deterministic `mock:64` encoder fingerprint and one or more query probes containing strict `evaluatedAt`, bounded `limit`, explicit sorted scopes, nonempty sorted relevant IDs, separate sorted forbidden-retrieval and forbidden-admission ID sets, and optional admission policy. This first gate rejects every non-mock provider rather than pretending that a remote or locally mutable model name pins encoder behavior.

Each probe must have a unique latest eligible graph snapshot; equal latest snapshot timestamps fail closed as ambiguous. Evaluation sets `requireSnapshot: true`; it never treats live-graph fallback as historical evidence. For every probe it reconstructs an isolated graph from the selected snapshot, pins the graph configuration to the attested default values, and deterministically rebuilds `mock:64` embeddings using the CLI embed/rebuild node-text format (the snapshot-carried label and excerpts), timestamps those derived embeddings at `evaluatedAt`, and excludes live episode lookup because episode state is not part of graph snapshots. Canonical files are consulted only after raw retrieval, for strict ID/status/path projection and admission. Thus current graph configuration, current embeddings, current canonical claims, and current episode links cannot affect the raw historical retrieval trace. Retrieval uses explicit fixed weights (`semantic=0.4`, `graph=0.3`, `recency=0.2`, `importance=0.1`), two graph hops, zero minimum score, the manifest scopes, and procedures disabled. Score ties use node ID as the final stable key. The source graph must be a regular file no larger than 512 MiB, closed and checkpointed with no WAL, SHM, or rollback-journal sidecars. Because SQLite may create shared-memory sidecars even for a read-only WAL connection, the command opens a bounded, identity-checked isolated byte copy and leaves the source graph, canonical tree, and derived receipt store unchanged.

The content-addressed report keeps three artifacts distinct:

1. raw ordered ranks, graph node IDs, total/component scores, and explicit canonical mapping or `null` returned by `recall()`;
2. canonical file-backed IDs passed to admission;
3. admitted IDs and their exact rendered-context token count.

It reports retrieval P@K/R@K/NDCG@K using the manifest retrieval `limit` as K, forbidden retrieval leakage, admission precision/recall, forbidden admission leakage, provenance completeness, and exact context tokens. Storage, retrieval, admission, and use are measured; extraction remains explicitly unmeasured. The exported evaluator requires an attested complete canonical ID set, pinned retrieval parameters, score/weight coherence, explicit graph-to-canonical mappings, a coherent `recall` receipt, and exact agreement between mapped raw results and admission candidates. Repeated and fresh-root runs with identical graph/canonical bytes under the pinned mock encoder produce byte-identical `recall_replay_<sha256>` reports. Production-provider recall quality remains deferred until model/runtime digests can be pinned.

## Explicit deferrals

The accepted synthetic slices do not yet provide:

- production extraction attribution;
- latency benchmarking;
- a private five-session Lobstar corpus;
- a 25-session representative pilot;
- broad archive backfill;
- Hermes session-start injection or capture hooks;
- CI trend storage or score-regression baselines;
- LLM-based semantic grading;
- historical recall without an eligible snapshot.

The next evaluator slice should extend the manifest with source-message and candidate expectations for production extraction attribution. Latency belongs in a separate non-content-addressed operational artifact so wall-clock noise cannot alter deterministic quality report IDs. The five-session private pilot remains gated on that attribution boundary and access to the immutable private archive.

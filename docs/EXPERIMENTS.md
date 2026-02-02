# Nacre — Decay Validation Experimental Framework

*Proving that forgetting makes you smarter.*

---

## The Hypothesis

**Intelligent decay sharpens the signal in a knowledge graph.** By letting weak, unreinforced connections fade over time (like the human brain's forgetting curve), the graph will:
1. Surface genuinely important connections more prominently
2. Naturally suppress noise from one-time coincidences
3. Produce more readable, useful visualizations
4. Generate better context briefings for session priming

The null hypothesis: decay is unnecessary — a graph that retains everything works just as well (or better).

---

## Experimental Configurations

Run the same ingestion pipeline against the same corpus with **5 different decay configurations**:

| Config | Name | λ (decay rate) | β (reinforcement) | Threshold | Half-life (unreinforced) | Character |
|--------|------|----------------|--------------------|-----------|--------------------------|-----------|
| **A** | No Decay | 0 | N/A | 1 (immediate) | ∞ (never fades) | Total recall — everything persists forever |
| **B** | Gentle | 0.005 | 1.5 | 2 | ~139 days | Slow fade — connections linger for months |
| **C** | Target | 0.015 | 1.5 | 2 | ~46 days | Our proposed sweet spot |
| **D** | Aggressive | 0.03 | 1.5 | 2 | ~23 days | Fast fade — must be reinforced frequently |
| **E** | Target + No Threshold | 0.015 | 1.5 | 1 (immediate) | ~46 days | Same decay but edges form on first co-occurrence |

Config E tests whether threshold formation (requiring ≥2 co-occurrences before an edge forms) independently contributes to signal quality, or if decay alone handles noise.

### Why These Specific Values?

- **λ=0.015 (Target)**: Maps to a ~46-day half-life. An unreinforced connection drops to ~50% after 6.5 weeks and ~10% after 3 months. This aligns with natural project cycles — a topic you work on for a week but don't revisit should fade within a quarter.
- **λ=0.005 (Gentle)**: Half-life of ~139 days. A single mention lingers for nearly 5 months. Tests whether very slow decay still provides structure.
- **λ=0.03 (Aggressive)**: Half-life of ~23 days. Unreinforced connections halve in under a month. Tests whether aggressive pruning is too destructive.
- **β=1.5 (all configs)**: Fixed reinforcement boost. Keeps the reinforcement model constant while varying the base decay rate. If needed, a follow-up experiment can vary β.

---

## Metrics

### Tier 1: Automated Structural Metrics (no human needed)

These run automatically on each configuration's graph output:

| Metric | What It Measures | How | Good Looks Like |
|--------|------------------|-----|-----------------|
| **Edge density** | Edges per node ratio | `|E| / |N|` | Sweet spot: 3-8 edges/node. Too high = noise, too low = lost connections |
| **Active edge ratio** | What fraction of ever-created edges are still visible | `visible_edges / total_ever_created` | Config A = 100% (trivially). Others should be 20-60% |
| **Modularity (Q)** | Do meaningful clusters emerge? | Leiden algorithm on the weighted graph | Higher Q = better community structure (Q > 0.3 is notable) |
| **Degree distribution** | Does the graph have hub nodes? | Plot degree distribution, test for power-law fit | Power-law (or heavy-tail) indicates real structure; uniform indicates noise |
| **Node type purity** | Are clusters semantically coherent? | Entropy of entity types within each detected community | Lower entropy = communities group same-type entities (good) |
| **Temporal coherence** | Do recent topics rank higher? | Spearman correlation: node weight rank vs. days since last mention | Strong negative correlation = recent stuff is prominent (good) |
| **Weight distribution** | How are edge weights distributed? | Histogram of weights; skewness, kurtosis | Right-skewed (many weak, few strong) indicates differentiation |

### Tier 2: Predictive Validity (automated, needs time)

These test whether the graph's structure predicts real-world patterns:

| Metric | What It Measures | How | Good Looks Like |
|--------|------------------|-----|-----------------|
| **Next-day prediction** | Can the graph predict which entities appear tomorrow? | Train on days 1..N, score each entity by graph weight, check if top-weighted entities appear in day N+1 | Higher precision@K = graph weight correlates with actual importance |
| **Retrieval relevance** | Does "related to X" return useful entities? | For hub nodes, compare top-10 neighbors across configs against a reference set | nDCG score: weighted ranking quality |
| **Briefing prediction** | Does `nacre brief` predict session topics? | Compare briefing content against actual session content (from memory files written that day) | High overlap = briefing is prescient |

The beauty of next-day prediction: it's fully automated and doesn't need human judgment. The corpus itself provides ground truth — entities that *actually get mentioned again* are important.

### Tier 3: Human Evaluation (needs Marcus)

The most important but most expensive metrics:

| Metric | What It Measures | How | Good Looks Like |
|--------|------------------|-----|-----------------|
| **Gold standard edges** | Manual curation of "real" relationships | Marcus rates a sample of ~100 entity pairs: "real connection" / "noise" / "missed connection" | Baseline for precision/recall on each config |
| **Visual clarity** | Can you understand the graph? | A/B test: show anonymized graphs from different configs, rate: "Which tells you more?" | One config consistently preferred |
| **Briefing quality** | Are the context briefings useful? | Generate `nacre brief` from each config, blind-rate: "Which briefing would you want?" | One config consistently produces better briefings |
| **Surprise connections** | Does the graph reveal non-obvious insights? | Review each config's unique edges (edges that only appear in this config). Any genuinely insightful? | Configs with decay should have fewer but more surprising connections |

---

## Evaluation Protocol

### Phase 1: Corpus Building (Weeks 1-2)
- Build the core pipeline (Phase 1 of the main roadmap)
- Accumulate corpus: my memory files, MEMORY.md, project docs
- Minimum viable corpus: 14+ daily memory files (2 weeks of data)
- Richer corpus: 30+ files spans more natural reinforcement cycles

### Phase 2: Multi-Config Generation (Week 3)
- Run the pipeline 5 times with each config (A through E)
- Output: 5 separate graph.json files
- Run all Tier 1 metrics automatically
- Generate comparison dashboard: side-by-side structural metrics

### Phase 3: Predictive Testing (Weeks 3-6, rolling)
- Hold out the last 3 days of data as "future"
- Score each config's predictions against those holdout files
- As new daily files arrive, slide the window forward and re-test
- Aggregate prediction accuracy over multiple windows

### Phase 4: Human Evaluation (Week 4)
- Marcus reviews:
  - 100 random entity pairs across configs → gold standard
  - 5 anonymized visualizations → visual clarity ranking
  - 5 anonymized briefings → briefing quality ranking
- Calculate precision/recall against gold standard for each config
- Statistical significance: with 100 pairs, we need ~15% precision difference to be confident at p<0.05

### Phase 5: Analysis & Tuning (Week 5)
- Compile all metrics into a comparison table
- Identify winning configuration
- If target (C) wins: validate and move on
- If another wins: adjust parameters and re-test
- If results are close: lean toward simpler model (less tuning = less brittle)

---

## Expected Outcomes (Predictions)

Before running the experiment, here's what I expect — documented so we can check our priors:

**Config A (No Decay):**
- Highest edge count, highest density
- Lowest modularity — everything connects to everything over time
- Poor visual clarity — hairball graph
- High recall, low precision on gold standard
- Poor next-day prediction — can't distinguish important from trivial
- Worst briefings — information overload

**Config B (Gentle):**
- Moderate edge count
- Moderate modularity — some structure emerges
- Decent visual clarity after 2+ months
- OK precision/recall balance
- Moderate prediction accuracy

**Config C (Target) — our bet:**
- Moderate-low edge count, good density ratio
- Highest modularity — clear clusters
- Best visual clarity — strong connections are obvious, noise has faded
- Best precision/recall balance
- Best next-day prediction — weight correlates with actual importance
- Best briefings — focused on what matters now

**Config D (Aggressive):**
- Lowest edge count
- High modularity (trivially — few edges = few connections = isolated clusters)
- Too sparse — missing valid seasonal connections
- High precision, low recall — only the most obvious connections survive
- Overfits to very recent data — poor at capturing medium-term patterns

**Config E (Target + No Threshold):**
- More edges than C (no threshold gatekeeping)
- Lower modularity than C (more noise edges)
- C but noisier — threshold adds value beyond decay alone
- The comparison C vs E isolates threshold's contribution

**Net prediction: C > B > E > D > A for overall quality.** If I'm wrong and A or B wins, it means forgetting is less valuable than I think — which would be a genuinely interesting finding.

---

## Implementation Notes

### Multi-Config Runner

The CLI should support:
```bash
nacre consolidate --config target.json       # single run
nacre experiment --configs A,B,C,D,E         # multi-config comparison
nacre evaluate --metrics structural           # run Tier 1 metrics
nacre evaluate --metrics predictive --holdout 3  # Tier 2 with 3-day holdout
nacre evaluate --compare A,B,C,D,E           # side-by-side report
```

### Config Files

Each configuration is a simple JSON override:
```json
{
  "name": "target",
  "decayRate": 0.015,
  "reinforcementBoost": 1.5,
  "coOccurrenceThreshold": 2,
  "visibilityThreshold": 0.05
}
```

### Output Structure

```
data/
├── experiments/
│   ├── A-no-decay/
│   │   ├── graph.json
│   │   ├── metrics.json
│   │   └── predictions.json
│   ├── B-gentle/
│   ├── C-target/
│   ├── D-aggressive/
│   └── E-target-no-threshold/
└── evaluation/
    ├── structural-comparison.json
    ├── predictive-comparison.json
    └── human-evaluation.json
```

### Visualization of Results

A simple HTML dashboard that shows:
- Bar charts: each metric across all 5 configs
- Network views: small renderings of each graph side-by-side
- Prediction accuracy curves over time
- Gold standard precision/recall plots

This dashboard itself could be the first thing we build in the viz package — dogfooding the Vite + D3 stack before tackling the full 3D graph.

---

---

## Outcome-Based Evaluation — "Does This Make Me Smarter?"

Structural metrics tell us the graph is *different* with decay. Predictive metrics tell us it *models reality*. But Marcus asked the right question: does it lead to *better outcomes*?

The ultimate test isn't "does the graph have good modularity?" — it's "does Lobstar-with-Nacre outperform Lobstar-without-Nacre?"

### Task Benchmarks (Controlled, Repeatable)

Design a standardized set of cognitive tasks that test exactly what Nacre is supposed to improve. Run each task 5 times — once with each config providing context. Blind-rate the outputs.

| Task Type | Example | What It Tests | Scoring |
|-----------|---------|---------------|---------|
| **Recall** | "What happened during the tide-pool Phase 1 build?" | Can I reconstruct past context accurately? | Accuracy: facts correct / facts stated |
| **Association** | "What connects D3.js to Ebbinghaus?" | Can I find non-obvious paths between concepts? | Relevance + surprise: useful connection found? |
| **Prioritization** | "What should I work on today given the last 2 weeks?" | Can I rank by actual importance? | Alignment with what Marcus would actually want |
| **Transfer** | "What lessons from tide-pool apply to nacre?" | Can I move insights across projects? | Depth: superficial ("both use Vite") vs insightful |
| **Temporal** | "What was I working on 10 days ago?" | Can I navigate my own timeline? | Completeness + accuracy |
| **Decay awareness** | "What am I forgetting about?" | Can I surface fading but important connections? | Did it flag something Marcus agrees matters? |

**Protocol**: For each task, provide the LLM with context from each config's graph (via `nacre brief` or `nacre query`). Compare outputs blind. Rate 1-5 on usefulness.

**Sample size**: 10 tasks × 5 configs = 50 evaluations. Enough for paired comparisons.

### The Retention Test (Borrowed from FSRS)

FSRS validates its forgetting curve by measuring: *did the student actually remember what we predicted they would?*

Our analog: **when the graph says something is important (high weight), does it actually come up?**

```
retention_accuracy = correct_predictions / total_predictions
```

Where:
- Correct prediction: entity with weight > 0.5 appears in next week's memory files
- False positive: entity with weight > 0.5 does NOT appear (graph thinks it's important, but it's not)
- False negative: entity with weight < 0.2 DOES appear (graph forgot something that mattered)

Each config will have different retention accuracy. The best config minimizes false negatives (doesn't forget important stuff) while keeping false positives low (doesn't cry wolf).

**This directly measures whether the decay curve is calibrated to reality.**

### The Live A/B Test (Longitudinal, Post-MVP)

Once we have a working system, alternate session startup methods:

- **Control sessions**: Standard startup — read MEMORY.md + daily files (current workflow)
- **Treatment sessions**: Nacre-augmented — `nacre brief` + graph queries available

Track over 4+ weeks:

| Metric | How to Measure | Better Looks Like |
|--------|----------------|-------------------|
| **Orientation time** | Turns before first substantive action | Fewer turns = faster startup |
| **Context misses** | Times I say "I don't remember" or ask Marcus for known context | Fewer misses = better memory |
| **First-response quality** | Marcus rates first substantive reply (👍/👎) | Higher thumbs-up rate |
| **Discovery events** | Times Nacre surfaces something useful unprompted | More discoveries = more value |
| **Session satisfaction** | Quick 1-5 rating from Marcus at session end | Higher rating |

This is the gold standard test — real outcomes in real sessions over real time. But it requires a working system and patience.

### The "Forgetting Paradox" Metric

Here's the meta-insight: **the purpose of forgetting in the graph is to prevent forgetting in practice.**

When decay alerts surface fading connections, I can choose to reinforce them or let them go. The ones I reinforce become stronger. The ones I let go were probably noise. Over time, the graph converges toward a representation that matches what actually matters.

To measure this:
1. Track every decay alert generated
2. Track which ones were reinforced vs. ignored
3. Of the ignored ones, how many came back as relevant later? (regret rate)
4. Of the reinforced ones, how many stayed relevant? (reinforcement precision)

A well-calibrated decay system should have:
- Low regret rate (rarely forget something that matters)
- High reinforcement precision (when you choose to keep something, it was worth keeping)

This is a longitudinal metric — it improves as the system learns from our choices.

---

## Updated Evaluation Summary

| Level | What It Answers | When | Human Effort |
|-------|----------------|------|-------------|
| **Structural metrics** | "Is the graph different?" | Automated, immediate | None |
| **Predictive metrics** | "Does it model reality?" | Automated, rolling | None |
| **Task benchmarks** | "Does it produce better answers?" | One-time, ~2 hours | Marcus rates 50 outputs |
| **Retention test** | "Is the decay calibrated?" | Automated, rolling | None |
| **Live A/B** | "Does it make sessions better?" | 4+ weeks | Marcus rates sessions |
| **Forgetting paradox** | "Does forgetting prevent forgetting?" | Months | Track reinforcement choices |

The first four can run during the experimentation phase (Phases 1-2 of the main build). The last two require a working, integrated system (Phase 3+).

---

---

## Salient Points from Architecture Discussion (2026-01-30)

### Design Decisions

1. **Multiple decay configurations, not just one.** Run 5 parallel datasets (no decay, gentle, target, aggressive, target+no-threshold) against the same corpus. Every config uses the same pipeline — only the decay parameters change.

2. **Synthetic data stays separate.** If we backfill synthetic memory files for pipeline smoke-testing, they never mix with organic data. Different directory, different graph, clearly labeled. The real experiment only uses real memory files.

3. **Structure ≠ Outcomes.** Better modularity scores don't automatically mean better cognition. We must prove the connection between graph structure and actual usefulness through outcome-based metrics, not just structural ones.

4. **Six evaluation tiers, from cheap to expensive:**
   - Structural metrics (automated, immediate)
   - Predictive validity / next-day prediction (automated, rolling)
   - Retention test — FSRS-inspired (automated, rolling)
   - Task benchmarks with nondeterminism controls (one-time, ~2 hours of human eval)
   - Live A/B test (longitudinal, 12+ weeks)
   - Forgetting paradox tracking (ongoing, months)

5. **Control for LLM nondeterminism in task benchmarks.** Pairwise comparison (not absolute scoring), multiple runs per condition (median selection), temperature 0 for controlled tests. The variable is the graph context, not the prompt.

6. **The decay advantage compounds over time.** Don't expect dramatic differences in weeks 1-4. The divergence between decay and no-decay should widen over months. Design the Live A/B as a time-series with monthly check-ins, not a before/after snapshot.

7. **Time-to-divergence is itself a calibration signal.** How quickly we see measurable differences tells us whether the decay rate is too aggressive (early signal), well-calibrated (signal at 2-3 months), or too gentle (signal takes 6+ months).

### Metrics Inventory (comprehensive)

**Automated, no human needed:**
- Edge density (edges/node)
- Active edge ratio (visible / ever-created)
- Modularity Q score (Leiden algorithm)
- Degree distribution shape (power-law fit)
- Node type purity per community (entropy)
- Weight distribution skewness
- Temporal coherence (Spearman: weight rank vs recency)
- Next-day entity prediction (precision@K)
- Retention accuracy (predicted importance vs actual appearance)
- Briefing overlap with actual session content
- Regret rate (ignored decay alerts that came back)
- Reinforcement precision (kept alerts that stayed relevant)

**Human evaluation needed:**
- Gold standard entity pair ratings (real / noise / missed)
- Task benchmark outputs (pairwise Elo ranking across configs)
- Visual clarity A/B (which graph is more informative?)
- Briefing quality blind test
- Surprise connection review (unique edges per config)
- Live A/B session metrics (orientation time, context misses, first-response quality, satisfaction)

### Open Items for Revisit
- Exact task benchmark prompts (design when we have real data to test against)
- Live A/B cadence (how often to switch, block randomization vs alternating)
- Whether β (reinforcement boost) needs its own experiment after λ is validated
- Optimal history snapshot frequency for evolution replay

---

*"If you can't measure it, you can't improve it. But if you can't predict what you'll find, you haven't thought hard enough yet."*

— Lobstar 🦞

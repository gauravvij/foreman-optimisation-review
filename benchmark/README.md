# Optimisation report: what changed and what improved

This directory ships the benchmark evidence for the `pr/foreman-optimisation` branch.
It contains the stored reports the numbers below are read from, plus this written
report.

## Overview

This PR is an **optimised version of foreman that behaves the same way but better**.

- The graph it produces is **identical** to baseline — the post-run node counts match
  at every corpus size that was profiled (n = 5, 20, 60). A faster write that produced a
  different graph would have been rejected.
- It issues **far fewer Neo4j statements** for the same ingestion (620 → 209 at n = 60)
  and opens **far fewer sessions** (127 → 9), because the per-issue write path is batched
  into a single managed transaction and the orphan sweep is scoped to the issue being
  re-analysed.
- Ingestion is **faster** on the isolated profile (2,663 → 964 ms at n = 60) and much
  faster on the fetch path once request concurrency is enabled.
- Several **silent correctness defects are fixed**: an empty query result is no longer
  reported as an absent fact, a reversed or impossible Cypher traversal is flagged
  instead of silently returning zero rows, comment summaries are anchored on the issue,
  and a solution or workaround is no longer dropped when the model omits its comment
  source.

Nothing about the observable behaviour of a correct run changes. The change set is
database-efficiency and correctness work, not a redesign.

## What changed

The change set is 12 commits; the thirteenth ships this directory. They fall into four
groups.

### (a) Neo4j ingestion performance

Three commits. `feat(neo4j): add identity constraints and lookup indexes` declares the
ten node-identity constraints and the two filtered-predicate indexes the pipeline relies
on (the graph was previously written with `MERGE` only, anchored on undeclared
properties). `perf(neo4j): batch issue writes into a single managed transaction` replaces
the ~6-statements-per-issue write path — each issue opened its own session and ran its
statements as auto-commit transactions — with an in-memory `planIssueBatch()` written in
one `executeWrite` that
reproduces every ordering rule of the old path. `perf(analysis): scope orphan cleanup to
the issue being re-analysed` turns the two graph-wide label scans per analysed issue into
`CALL` subqueries starting from the issue just detached, so the work is proportional to
that issue rather than to graph size.

### (b) Ingestion fetch path

Two commits. `perf(github): fetch issue details with bounded concurrency` puts a
fixed-size worker pool behind `GITHUB_FETCH_CONCURRENCY` (default 1, so behaviour is
unchanged unless an operator opts in) and writes results back by array index so
concurrency cannot reorder output — replacing a serial loop whose fetch stage was the
sum of every issue's latency. `perf(pipeline): pass fetched issue data to analysis and
fix incremental skip` hands analysis the values it was already holding in memory instead
of writing them and reading them back out of the graph, and fixes a pre-existing defect
where the incremental-skip comparison read `Issue.updatedAt` after ingestion had
overwritten it (so an edited issue was never re-analysed).

### (c) Agent correctness

Four commits. `docs(agent): document Issue.state enum and Cypher retry guidance`
documents the raw-cased `Issue.state` values and tells the model to correct and retry on
a query error. `fix(agent): stop treating an empty query result as an absent fact`
replaces the instruction to "report an empty result honestly" with rules that treat an
empty result as a signal to check the query. `fix(agent): flag reversed and impossible
Cypher traversals in queryNeo4j` adds a schema-aware guard that re-reads a query's
relationship patterns and attaches `warnings` when a traversal is reversed or impossible
— without rewriting the query or changing rows, count or error.
`fix(agent): declare truncated on the summariser test result type` adds the missing
field to a test-local type so `tsc --noEmit` passes on an otherwise correct test file.

### (d) Agent hardening

Three commits. `fix(analysis): attach solutions and workarounds without a comment source`
makes both analysis statements issue-scoped, so a model that omits `source` no longer
aborts the analysis for that issue. `fix(agent): anchor comment summaries on the issue
and guard the competitor hop` passes the issue title and body into `summarizeComments` as
an explicit anchor (previously it fetched only comments and latched onto whichever
sub-thread was most quotable) and makes the competitor hop an `OPTIONAL MATCH` guarded on
a non-empty source. `fix(agent): bound comment summaries and move write rules into tool
descriptions` bounds both the summariser read and its prompt, reports truncation, and
moves write-tool rules from the static prompt block into the description of the tool they
govern.

## Measured improvements

All figures below are read verbatim from the stored reports in this directory. No value
is rounded differently from the report it comes from.

### Ingestion database work

Same 60-issue corpus, same Neo4j, same GitHub request count. Baseline = frozen baseline
tree; Optimised = this branch.

| Dimension | n | Baseline | Optimised | Change |
|---|---:|---:|---:|---:|
| Neo4j statements | 60 | 620 | **209** | **−66.3%** |
| Neo4j sessions opened | 60 | 127 | **9** | **−92.9%** |
| Managed transactions | 60 | 0 | **1** | first transaction boundary |
| Graph-wide orphan sweeps | 60 | 60 | **0** | eliminated |
| Neo4j statements | 20 | 212 | **89** | −58.0% |
| Neo4j sessions opened | 20 | 47 | **9** | −80.9% |
| Graph-wide orphan sweeps | 20 | 20 | **0** | eliminated |
| Neo4j statements | 5 | 51 | **41** | −19.6% |
| Neo4j sessions opened | 5 | 17 | **9** | −47.1% |
| Graph-wide orphan sweeps | 5 | 5 | **0** | eliminated |

Graph parity: the post-run node counts are identical to baseline at n = 5, 20 and 60
(the `graphAfterRun` field of each report).

### Isolated pipeline wall clock

No injected latency, same corpus.

| n | Baseline | Optimised | Change |
|---:|---:|---:|---:|
| 60 | 2,663 ms | **964 ms** | −63.8% (2.76×) |
| 20 | 1,431 ms | **460 ms** | −67.9% |
| 5 | 870 ms | **587 ms** | −32.5% |

### GitHub fetch path

120 ms of latency injected per request, n = 60. The fetch stage was the sum of every
issue's latency because issue details were fetched serially; allowing four requests in
flight overlaps that latency.

| Dimension | Baseline | Optimised | Change |
|---|---:|---:|---:|
| Total wall clock | 18,914 ms | **5,085 ms** | 3.72× |
| `fetch` stage | 14,674 ms | **3,690 ms** | 3.98× |
| `github.maxConcurrent` | 1 | **4** | operator opt-in |
| GitHub requests | 122 | 122 | **unchanged** |

Request count is identical between the arms, which is the point: the change overlaps
requests, it does not add them.

### Accuracy

The `sympy2-dev` split — 50 tasks, three attempts each, re-graded on one grader for all
arms. Measured with the bench harness, whose agent model is `gpt-4o` (not a production
LLM).

| Arm | Overall | Deterministic | Semantic | solvedAll | solvedAny |
|---|---:|---:|---:|---:|---:|
| Baseline (`3cd3dde`) | 91.33% | 93.18% | 77.78% | 43/50 | 47/50 |
| Optimised (`14166da`, `29f7c1b`) | **100.00%** | **100.00%** | **100.00%** | **50/50** | **50/50** |

Delta: **+8.67 percentage points**; `solvedAll` 43/50 → 50/50; `solvedAny` 47/50 → 50/50.
The `multi_hop` stratum went from **5/12 failures** (baseline) to **0/12** (optimised).

The baseline's raw `report.json` scores 86.67% overall; the 91.33% figure is the
**corrected** score from `report.regraded.json`, which re-grades the stored answers with
the corrected grader (number words, stated absence, true-zero issue sets) while carrying
the judge verdicts over. The `regraded` block of that file records both the original and
the corrected score.

## Where the numbers come from

Everything above is recomputable from the files in this directory. Nothing was measured
for this document; the reports are the stored outputs of the bench harness.

### `qa/` — scored agent runs

| File | Arm | Fields used |
|---|---|---|
| `qa/foreman-fresh-baseline/report.json` | baseline raw run | `cost.sutTotalUsd`, `cost.qaUsd`, `cost.judgeUsd`, `qa.openai.*` |
| `qa/foreman-fresh-baseline/report.regraded.json` | baseline, corrected score | `regraded.correctedScore.overall`, `.deterministic`, `.semantic`, `.solvedAllAttempts`, `.solvedAnyAttempt`; `regraded.originalScore.*`; `config` (`reasoningModel`, `fastModel`, `judgeModel`, `attempts`, `latencyMs`) |
| `qa/foreman-fresh-v6/report.json` | intermediate arm | `score.*`, `qa.tasks[].attempts[].pass` |
| `qa/foreman-fresh-v7/report.json` | optimised arm | `score.overall`, `.deterministic`, `.semantic`, `.solvedAllAttempts`, `.solvedAnyAttempt`; `cost.sutTotalUsd`; `qa.openai.cacheHitRate`; `qa.tasks[].attempts[].ms` |
| `qa/foreman-fresh-v8/report.json` | single-attempt confirmation arm | `score.*`, `config.attempts` (= 1) |
| `qa/GUARD-V7-VS-V6.md` | guard comparison doc | v6 → v7 arm comparison, its caveats |

Accuracy figures come from the `score` block: `score.overall`, `score.deterministic`,
`score.semantic`, `score.solvedAllAttempts`, `score.solvedAnyAttempt`. The
baseline figure is read from `regraded.correctedScore` (not the raw `score`).
The `multi_hop` stratum counts come from `qa.tasks[]` filtered on
`template == "multi_hop"` and counting `attempts[].pass == false`.

### `profile/` — ingestion profiler runs

| File | Tree | Issues | Latency |
|---|---|---:|---|
| `profile/profile-foreman-baseline-5.json` | frozen baseline | 5 | — |
| `profile/profile-foreman-baseline-20.json` | frozen baseline | 20 | — |
| `profile/profile-foreman-baseline-60.json` | frozen baseline | 60 | — |
| `profile/profile-foreman-optimised-5.json` | this branch | 5 | — |
| `profile/profile-foreman-optimised-20.json` | this branch | 20 | — |
| `profile/profile-foreman-optimised-60.json` | this branch | 60 | — |
| `profile/profile-foreman-baseline-60-lat-c1.json` | frozen baseline | 60 | 120 ms, concurrency 1 |
| `profile/profile-foreman-h8-lat-c4-60.json` | this branch | 60 | 120 ms, concurrency 4 |

Database-work and wall-clock figures come from `neo4j.totalStatements`,
`neo4j.sessionsOpened`, `neo4j.managedTransactions`, `neo4j.orphanSweeps` and `wallMs`.
The fetch-path figures come from `wallMs`, `github.maxConcurrent`, `github.requests` and
the `stages[]` array (`{"stage":"fetch","durationMs":…}`). Graph parity is read from the
`graphAfterRun` object of each report.

### Harness

The reports are the stored outputs of the bench harness. **The harness code is not part
of this PR** — only its outputs are. `qa/` reports were produced by the QA harness
(`sympy2-dev` split, `gpt-4o` reasoning + judge, `gpt-4o-mini` fast) and `profile/`
reports by the ingestion profiler (local Neo4j, mock corpus, optional injected latency).

## Honest limitations

These are the caveats a reviewer must carry alongside the numbers.

1. **Mock / local Neo4j corpus.** The ingestion profile runs a mock corpus against a
   local Neo4j. The statement-count reduction is **structural** and corpus-independent
   (it comes from batching and scoping, not from cache warmth), but the **wall-clock
   milliseconds are not** — they are not transferable to a hosted Neo4j or a production
   workload.
2. **Injected latency.** The fetch-path 120 ms per request is **injected by the
   profiler**, not real network latency. The measured speedup is a direct consequence of
   overlapping that fixed latency; on a real network with variable latency the ratio
   would differ.
3. **Accuracy is a harness result, not a production-LLM result.** The 91.33% → 100.00%
   figures come from the bench harness with **`gpt-4o` as the agent model** (see each
   report's `config` block: `reasoningModel: gpt-4o`, `fastModel: gpt-4o-mini`,
   `judgeModel: gpt-4o`). They are not production-LLM accuracy and must not be presented
   as such. `v8` is a single-attempt confirmation arm (`config.attempts: 1`) and carries
   less statistical weight than `v7`'s three attempts.
4. **The −41% cost drop is not earned by the code change.** Per attempt, cache-aware,
   `cost.sutTotalUsd` falls from $0.0440 to $0.0259 (−41%). That is **OpenAI prompt
   caching**: the optimised run records `cacheHitRate ≈ 0.9428`, so ~94% of its prompt
   prefix tokens were billed at the cached rate. On identical full-price metering the
   optimised build uses **≈9% MORE tokens**, not fewer — 2,793,678 reported prompt tokens
   against the baseline's 2,560,575 — because the prompt block grew when write-tool rules
   moved from the instructions section into tool descriptions. Do not read the −41% as a
   saving the change earns.
5. **Agent-side latency tail regressed.** This is an ingestion-efficiency and correctness
   change; it does not improve agent response latency. Per attempt, the median is
   essentially flat (≈2.6 s on both arms), but the tail is worse: p95 rose from
   ≈7.46 s (baseline) to ≈12.2 s (optimised, linear interpolation; other conventions give
   11.1–13.2 s, all regressions), and the maximum rose from **8,932 ms to 42,574 ms**.
   Per-attempt latency is read from `qa.tasks[].attempts[].ms`.
6. **The 91.33% → 100.00% delta spans several commits, not one.** The arm-to-arm
   accuracy delta is not a per-commit attribution. The `multi_hop` stratum movement and
   the Cypher-guard tests isolate the mechanism (the guard fires on the verbatim failing
   queries and the agent corrects within the attempt), but the aggregate score change is
   spread across the correctness and hardening commits.
7. **The `multi_hop` sample is small.** 12 `multi_hop` attempts per arm; a single attempt
   flipping changes the rate by 8.3 pp. The guard comparison doc
   (`qa/GUARD-V7-VS-V6.md`) states the effect is consistent with the guard helping but is
   not statistically conclusive (Fisher exact p ≈ 0.24).

## Reproduce

- The reports in this directory are the **stored outputs of the bench harness** — they
  are not regenerated by anything in this PR. The harness itself is not included.
- To read a figure: open the relevant JSON and read the field named above. For example,
  `neo4j.totalStatements` in `profile/profile-foreman-baseline-60.json` is `620` and in
  `profile/profile-foreman-optimised-60.json` is `209`; `score.overall` in
  `qa/foreman-fresh-v7/report.json` is `1`; `wallMs` in
  `profile/profile-foreman-baseline-60-lat-c1.json` is `18914`.
- Graph parity is the `graphAfterRun` object being equal between the baseline and
  optimised report at the same `issueLimit`.
- The `qa/` and `profile/` directory names mirror the showcase repository's
  `bench/foreman-qa/jobs/` and `bench/foreman-profile/`, so the same figures can be
  cross-checked against the original run directories.

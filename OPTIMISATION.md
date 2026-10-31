# Foreman optimisation — end-to-end report

This document is the entry point for the `pr/foreman-optimisation` branch: **what we
changed, why, and what the measurements actually show**. It is the narrative; the raw
evidence it cites ships alongside it in [`benchmark/`](benchmark/README.md).

> Scope: the PR is an **optimised version of foreman that behaves the same way but
> better** — fewer database operations, faster ingestion, and fewer silently-wrong
> answers. Nothing about the observable output of a correct run changes: the graph it
> produces is identical to baseline.

---

## 1. Summary

| Dimension | Baseline | This branch | Change |
|---|---:|---:|---:|
| Neo4j statements (n = 60 ingest) | 620 | **209** | **−66%** |
| Neo4j sessions opened (n = 60) | 127 | **9** | **−93%** |
| Graph-wide orphan sweeps | 60 | **0** | eliminated |
| Ingestion wall clock (n = 60) | 2,663 ms | **964 ms** | **−64%** |
| GitHub fetch stage (120 ms injected, n = 60) | 14,674 ms | **3,690 ms** | **−75%** |
| QA accuracy (`sympy2-dev`, 50 × 3) | 91.33% | **100.00%** | **+8.67 pts** |
| QA solved on every attempt | 43/50 | **50/50** | +7 |
| Graph produced | — | — | **identical (parity)** |

Two honest caveats are covered in §5: the −41 % cost drop is **prompt caching, not the
code**, and the agent-side latency **tail regressed** (this is a database-efficiency and
correctness change, not a latency change).

---

## 2. How it was measured

Foreman has two halves that fail differently, so there is a measurement for each.

### Ingestion — a statement-level profiler

The cost that matters in ingestion is *how much work is asked of Neo4j*, not process
wall-clock (a fast local database hides it). We instrumented the `neo4j-driver` **inside
the target tree** and counted every statement, session, transaction boundary and
graph-wide sweep. Two things had to be solved to make this measurable:

- **The repo's `GITHUB_TOKEN` is invalid**, so GraphQL calls cannot reach `api.github.com`.
  The frozen corpus is served through a **local fake GraphQL server**.
- **Latency must be injected, not inherited.** On a 0 ms loopback a serial fetch and a
  pooled fetch look identical, so the profiler adds a fixed per-request delay
  (`PROFILE_LATENCY_MS = 120 ms`) before measuring the fetch path.

Each run is repeated at **n = 5, 20 and 60 issues**, and every run is checked for **graph
parity** — a full node/edge count compared against baseline. A faster write that produced
a different graph would be rejected.

### Agent — a graded QA benchmark

The agent half is measured with the bench harness on the **`sympy2-dev` split: 50 tasks,
three attempts each**, all arms re-graded on one grader so scores are comparable. The
harness records score, per-attempt latency and cost.

The baseline's stored `report.json` scores **86.67 %** raw; the figure compared against is
**91.33 %**, the *corrected* score in `report.regraded.json` (corrected grader: number
words, stated absence, true-zero issue sets), carrying the judge verdicts over. Both ship
in `benchmark/qa/foreman-fresh-baseline/`.

---

## 3. What changed

The branch is thirteen commits — twelve of change, plus the commit that ships
`benchmark/`. They fall into four groups.

### (a) Neo4j ingestion performance

- **`feat(neo4j): add identity constraints and lookup indexes`** — the graph was written
  with `MERGE` only, anchored on properties, with nothing declared behind them.
  `setupDatabaseSchema()` now applies idempotent constraints for the ten node-identity keys
  and indexes for the two filtered predicates.
- **`perf(neo4j): batch issue writes into a single managed transaction`** — the per-issue
  write path issued ~6 statements per issue, each in its own implicit transaction over a
  fresh session. The batch is now planned in memory (`planIssueBatch()`) and written in one
  `executeWrite`. The planner reproduces every ordering rule of the old path, because a
  faster write that produces a different graph is a regression.
- **`perf(analysis): scope orphan cleanup to the issue being re-analysed`** — the orphan
  sweep ran two graph-wide label scans per analysed issue; both are now `CALL` subqueries
  starting from the issue just detached, so the work is proportional to that issue rather
  than to graph size.

### (b) Ingestion fetch path

- **`perf(github): fetch issue details with bounded concurrency`** — issue details were
  fetched serially, so the fetch stage was the sum of every issue's latency. A fixed-size
  worker pool is available behind `GITHUB_FETCH_CONCURRENCY` (**default 1**, so behaviour is
  unchanged unless an operator opts in); results are written back by array index, so
  concurrency cannot reorder output.
- **`perf(pipeline): pass fetched issue data to analysis and fix incremental skip`** — the
  pipeline wrote every issue then read it back to obtain values still held in memory; it now
  hands them over directly. While verifying, a pre-existing defect surfaced: the
  incremental-skip comparison read `Issue.updatedAt` *after* ingestion overwrote it, so an
  edited issue was never re-analysed.

### (c) Agent correctness

- **`docs(agent): document Issue.state enum and Cypher retry guidance`** — `Issue.state` was
  documented as an unconstrained string while `PullRequest.state` carried an enum. The graph
  stores GitHub's raw casing, so a model guessing lowercase got zero rows and a confident
  "there are no open issues". The tool description now also says to correct the Cypher from
  an error message and retry.
- **`fix(agent): stop treating an empty query result as an absent fact`** — the instruction
  to "report an empty result honestly" was replaced with rules that treat an empty result as
  a signal to check the query.
- **`fix(agent): flag reversed and impossible Cypher traversals in queryNeo4j`** — a reversed
  or impossible traversal is not a Cypher error: it parses, plans and returns zero rows,
  indistinguishable from "no such data". A schema-aware guard re-reads a query's relationship
  patterns against the declared schema and attaches `warnings` when it faults one. It never
  rewrites the query and never changes rows, count or error.
- **`fix(agent): declare truncated on the summariser test result type`** — a test-local type
  omitted a field the runtime returned, so `tsc --noEmit` failed on an otherwise correct file.

### (d) Agent hardening

- **`fix(analysis): attach solutions and workarounds without a comment source`** — the
  analysis ingest aborted for one issue every run because `source` was passed straight
  through and could be omitted, and the statement began with a mandatory `MATCH` on the
  comment. Both statements are now issue-scoped; the issue edge is unconditional, the comment
  edge best-effort, and an empty record is skipped before it reaches Cypher.
- **`fix(agent): anchor comment summaries on the issue and guard the competitor hop`** —
  `summarizeComments` fetched only comments, never the issue title/body, so the summariser
  latched onto whichever sub-thread was most quotable. It now selects the title and body as
  an explicit anchor; the competitor hop is an `OPTIONAL MATCH` guarded on a non-empty source.
- **`fix(agent): bound comment summaries and move write rules into tool descriptions`** —
  the summariser read had no `LIMIT` and every comment body went into one completion; both
  the read and the prompt are now bounded and truncation is reported. Write-tool rules moved
  from the static prompt block into the description of the tool they govern.

### (e) The evidence

- **`docs(benchmark): add benchmark reports and optimisation results`** — adds `benchmark/`:
  the stored reports these figures are read from, plus [`benchmark/README.md`](benchmark/README.md).
  The PR is self-contained: every number can be checked without leaving it.

---

## 4. Measured results

All figures are read verbatim from the stored reports in [`benchmark/`](benchmark/).

### 4.1 Ingestion database work

Same 60-issue corpus, same Neo4j, same GitHub request count. Baseline = frozen `3cd3dde`;
Optimised = the ingestion code as shipped here.

| Dimension | n | Baseline | Optimised | Change |
|---|---:|---:|---:|---:|
| Neo4j statements | 60 | 620 | **209** | **−66.3%** |
| Neo4j sessions opened | 60 | 127 | **9** | **−92.9%** |
| Managed transactions | 60 | 0 | **1** | first transaction boundary |
| Graph-wide orphan sweeps | 60 | 60 | **0** | eliminated |
| Neo4j statements | 20 | 212 | **89** | −58.0% |
| Neo4j sessions opened | 20 | 47 | **9** | −80.9% |
| Neo4j statements | 5 | 51 | **41** | −19.6% |
| Neo4j sessions opened | 5 | 17 | **9** | −47.1% |

**The graph is identical.** Post-run node counts match baseline exactly at n = 5, 20, 60 —
at n = 60 both trees give `{Comment: 228, Issue: 60, Label: 6, Meta: 2, Reaction: 37, User: 55}`.
This is the correctness gate the whole change set is held to: the same graph, two thirds
fewer statements, 93 % fewer sessions.

### 4.2 Ingestion wall clock

No injected latency, same corpus.

| n | Baseline | Optimised | Change |
|---:|---:|---:|---:|
| 60 | 2,663 ms | **964 ms** | −63.8% (2.76×) |
| 20 | 1,431 ms | **460 ms** | −67.9% |
| 5 | 870 ms | **587 ms** | −32.5% |

### 4.3 GitHub fetch path

120 ms latency injected per request, n = 60.

| Dimension | Baseline | Optimised | Change |
|---|---:|---:|---:|
| Total wall clock | 18,914 ms | **5,085 ms** | 3.72× |
| `fetch` stage | 14,674 ms | **3,690 ms** | 3.98× |
| `github.maxConcurrent` | 1 | **4** | operator opt-in |
| GitHub requests | 122 | 122 | **unchanged** |

Request count is identical between arms — the change **overlaps** requests, it does not add
them.

### 4.4 Agent accuracy

`sympy2-dev`, 50 tasks × 3 attempts, one grader for all arms, `gpt-4o` as the agent model
(**not** a production LLM).

| Arm | Overall | Deterministic | Semantic | solvedAll | solvedAny |
|---|---:|---:|---:|---:|---:|
| Baseline (`3cd3dde`) | 91.33% | 93.18% | 77.78% | 43/50 | 47/50 |
| Optimised (`14166da`, `29f7c1b`) | **100.00%** | **100.00%** | **100.00%** | **50/50** | **50/50** |

Delta **+8.67 pts**; `solvedAll` 43/50 → 50/50; `solvedAny` 47/50 → 50/50. The **`multi_hop`
stratum went 5/12 failures → 2/12 (`v6`) → 0/12 (`v7`)** — exactly the class of question the
reversed-traversal guard and empty-result rules target.

The arm SHAs are campaign heads, not commits on this branch; their `src/`+`agent/` trees are
byte-identical to branch commits `c93ef61` and `07a126d` respectively, so the figures describe
the code as shipped here.

---

## 5. Two results that look like wins and are not

### The cost drop is not earned by the code

Per attempt, cache-aware, cost falls **$0.0440 → $0.0259 (−41 %)**. This is **OpenAI prompt
caching**: the optimised run records `cacheHitRate ≈ 0.9428`. On identical **full-price**
metering the optimised build uses **≈9 % MORE tokens** (2,793,678 vs 2,560,575), because the
prompt block grew when write-tool rules moved into tool descriptions. Do not read the −41 %
as a saving the change earns.

### The latency tail regressed

Per attempt the median is flat (≈2.64 s → ≈2.84 s), but the tail is worse: p95 rose from
≈7.46 s to ≈12.2 s (linear interpolation; other conventions 11.1–13.2 s, all regressions),
and the maximum rose from **8,932 ms to 42,574 ms**. This change set is a database-efficiency
and correctness change; it does **not** improve agent response latency.

---

## 6. Verification gates

| Gate | Command | Result |
|---|---|---|
| Typecheck | `bun run typecheck` | exit 0 |
| Unit tests | `bun run test:unit` | 34 files, **588 tests passed, 0 failed** |
| Graph parity | full node/edge count vs baseline | identical at n = 5, 20, 60 |
| Batched-write failure path | forced batch failure | every issue still written, identical graph |

The suite includes `agent/tools/__tests__/cypher-guard.test.ts` and the guard-integration
tests in `query-neo4j.test.ts`, which assert the guard changes no rows, no count and no
error, and that its schema list stays in step with the relationship list in the instructions.

---

## 7. Honest limitations

1. **The database profile is a mock corpus on a local Neo4j.** The statement/session
   reduction is structural and corpus-independent; the absolute wall-clock milliseconds are
   not transferable to a hosted Neo4j.
2. **The fetch speedup uses injected latency.** The 120 ms is imposed by the profiler, not
   observed on a real network; the ratio would differ on a variable-latency network.
3. **Accuracy is a harness result, not a production-LLM result.** The figures use `gpt-4o`
   as the agent model and must not be presented as production accuracy.
4. **The accuracy delta spans several commits**, not one. The `multi_hop` movement and the
   guard tests isolate the mechanism, but the aggregate delta is not a per-commit attribution.
5. **The `multi_hop` sample is small** (12 attempts/arm); a single flip moves the rate by
   8.3 pp.
6. **The −41 % cost drop is prompt caching**, and the optimised build uses ≈9 % more tokens
   at full price (see §5).
7. **The agent-side latency tail regressed** (see §5).

---

## 8. Where the evidence lives

| What | Where |
|---|---|
| This report | `OPTIMISATION.md` (this file) |
| Written evidence index + reproduction | [`benchmark/README.md`](benchmark/README.md) |
| Ingestion profiler reports | [`benchmark/profile/`](benchmark/profile) |
| Scored QA runs | [`benchmark/qa/`](benchmark/qa) |

Everything above is recomputable from the files in `benchmark/`. Nothing was measured for
this document; the reports are stored outputs of the bench harness. The harness code itself
is **not** part of this PR — only its outputs are.

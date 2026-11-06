# WORKDONE — Foreman optimisation branch

**Read this first if you own the foreman repo and are seeing this branch for the first time.**
It is a plain-language inventory of *what changed, where, and why* — so you can review the
branch without having to reverse-engineer it from the diff. For the one-page version see
[`SUMMARY.md`](SUMMARY.md); for the measurements and the independent check see
[`OPTIMISATION.md`](OPTIMISATION.md).

---

## 1. What this branch is

| | |
|---|---|
| **PR base** | `origin/main` = `306d0ce` (this is what the diff / PR is against) |
| **Behavioural baseline** | `3cd3dde` — the parent of `306d0ce`. `306d0ce` adds only the `fern/` docs site, so `3cd3dde` and `306d0ce` are the *same code*. `OPTIMISATION.md` calls `3cd3dde` "the original". |
| **Branch** | `pr/foreman-optimisation` (head `258000c`) |
| **Commits ahead of `origin/main`** | 13 (12 code commits + 1 docs/evidence commit) |
| **Plus** | a set of **uncommitted** tidy-up changes in the working tree (group E below) |
| **What it does** | Makes reading GitHub issues into the Neo4j graph cheaper (fewer database requests), and makes the assistant answer questions more reliably (fewer confidently-wrong answers) |
| **What it does *not* do** | It does not change *what* ends up in the graph on a normal run — the stored content is byte-for-byte identical (verified). |

Everything below is grouped the same way as **section 3 of `OPTIMISATION.md`** (groups A–E),
so the two documents line up. Commit ids are in backticks so you can `git show` any of them.

---

## 2. TL;DR of the changes

- **Group A — fewer database requests when ingesting.** Set up constraints/indexes once per
  run; write issues in one batched transaction instead of ~6 requests each; scope the
  post-analysis cleanup to the issue being re-analysed instead of scanning the whole database.
- **Group B — leaner fetch→analysis hand-off.** Optional bounded-concurrency GitHub fetch
  (off by default); pass fetched data straight to analysis instead of write-then-read-back;
  fixes a bug where edited issues were never re-analysed.
- **Group C — fewer confidently-wrong answers.** Teach the assistant the real `OPEN`/`CLOSED`
  state spelling; stop it treating an empty result as an absent fact; add a **query checker**
  that warns on reversed/impossible graph traversals (it never edits the query or its results).
- **Group D — sturdier analysis and summaries.** Keep a solution even when the model omits its
  comment source; give the summariser the issue's title/body; bound long threads; tighten the
  model client (timeout, retries, token cap, one shared connection).
- **Group E — tidy-ups made during the independent check** (uncommitted): 26 new tests for the
  ingest code, a neutral example in the instructions, formatting, evidence files, and two test
  infrastructure fixes.

No change is a rewrite. Every change is either (a) a database *how*, not *what*, or (b) an
addition to the assistant's instructions/tools that is easy to read in isolation.

---

## 3. Change inventory — the problem, the fix, and how

Each row is one change: **the issue it fixes → the fix → how it was made** (with the commit and
the files). Grouped A–E to match `OPTIMISATION.md` §3.

### Group A — Less database work when reading issues in

| Issue it fixes | Commit | Files | How it was fixed |
|---|---|---|---|
| Reading issues in was expensive: ~6 separate write requests per issue, a **new database connection per issue**, and a whole-database tidy-up scan after every issue. At 60 issues that was 620 requests and 127 connections. | `dc34767` | `src/services/neo4j.ts`, `src/services/pipeline.ts` | Applies the graph schema **once per run**: 10 uniqueness constraints (an issue/person/comment can't be stored twice) + 2 indexes for common lookups. |
| The writes themselves were chatty — one request per kind of row per issue. | `f126f42` | `src/services/neo4j.ts` | Writes **all issues in a single managed transaction** (one batch) instead of ~6 requests each. On failure it **falls back to per-issue writes**, so nothing is lost. |
| A full-database scan ran after every issue to tidy up leftovers. | `2a16b83` | `src/services/analysis.ts` | On re-analysis, cleans up **only the orphan rows that issue created**. |

### Group B — A leaner hand-off from fetching to analysis

| Issue it fixes | Commit | Files | How it was fixed |
|---|---|---|---|
| Each issue was written to the graph and then **read straight back out** for analysis (wasted round-trips). Also a **bug**: an issue edited on GitHub was compared against itself, so it was **never re-analysed**. | `4dfa100` | `src/services/pipeline.ts`, `src/services/neo4j.ts` | Hands freshly-fetched data **directly to analysis** instead of write-then-read-back; fixes the re-analysis skip. |
| Fetching was strictly one issue at a time. | `8977994` | `src/services/github.ts` | Adds `GITHUB_FETCH_CONCURRENCY` (bounded concurrent fetch). **Off by default**; results stay in original order. |

### Group C — Fewer confidently-wrong answers

| Issue it fixes | Commit | Files | How it was fixed |
|---|---|---|---|
| The assistant guessed the issue state was `open`, got no results, and answered "there are no open issues" — the state is actually stored `OPEN`/`CLOSED`. | `89d5a98` | `agent/instructions.ts`, `agent/tools/query-neo4j.ts` | Documents the real `OPEN`/`CLOSED` spelling. |
| An empty result was reported as an absent fact. | `1bedad9` | `agent/instructions.ts` | New rule: "an empty result may mean your query is wrong — check it first". |
| Queries followed graph links the wrong way round, or links that can't exist, and silently returned nothing. | `c93ef61` | `agent/tools/cypher-guard.ts` *(new)*, `agent/tools/query-neo4j.ts` | Adds a **query checker** that appends a warning on reversed/impossible traversals. **It never changes the query or its results.** |
| A type error. | `07a126d` | `agent/tools/__tests__/summarize-comments.test.ts` | Adds a missing field so the type checker passes. |

### Group D — Sturdier analysis and summaries

| Issue it fixes | Commit | Files | How it was fixed |
|---|---|---|---|
| If the model proposed a solution but omitted which comment it came from, the **whole analysis for that issue failed**. | `a6c1ae1` | `src/services/analysis.ts`, `src/services/issue-analysis.ts` | Keeps the solution and links it to the issue instead of failing. |
| Summaries drifted onto the most quotable comment thread instead of the issue's real problem. | `19061b9` | `agent/tools/summarize-comments.ts`, `src/services/analysis.ts`, `agent/instructions.ts` (+ several tool files) | Anchors the summariser on the **issue's title and body**; guards the "competitor" comment hop. |
| Long threads were unbounded, and the model client had **no timeout, retries, or output cap**. | `4762100` | `agent/tools/*`, `agent/instructions.ts`, `src/services/models.ts` | Bounds thread length (and **says so when it truncates**); moves write-rules into the tool descriptions they apply to; adds `MODEL_TIMEOUT_MS` (60s), 2 retries, `MODEL_MAX_TOKENS` (1024), one shared connection, one tool-call retry. |

**New dependency:** `gpt-tokenizer` (dev-only, used by one test that keeps the instructions
within their size budget). No runtime dependencies were added.

### Group E — Tidy-ups made during the independent check *(uncommitted in the working tree)*

| Issue it fixes | Change | Files |
|---|---|---|
| The reading-in code had **no tests**. | 26 new tests (17 + 9) — also checked by breaking the code on purpose in 4 places; they caught all 4. | `src/services/__tests__/ingest-batch.test.ts` *(new)*, `src/services/__tests__/github-concurrency.test.ts` *(new)* |
| An instruction example was **taken from one of the question sets** (leakage). | A neutral example (`"Good First Issue"`). | `agent/instructions.ts` |
| Style drift. | Formatting / style fixes. **Behaviour unchanged.** | ~32 source files |
| Machine-written record files were being style-checked. | Excluded `benchmark/**` from the style checker. | `biome.json` |
| Evidence was not captured in the repo. | More test evidence (fresh re-test, repeated timings, check record). | `benchmark/qa/rerun/`, `benchmark/profile/repeat-runs.json`, `benchmark/verification.json` *(new)* |
| The AI judge used the same model it was scoring, so it **marked its own work**. | `MODEL_JUDGE` moves only the judge; `JUDGE_GATEWAY_URL` + `JUDGE_GATEWAY_API_KEY` can send it to another provider. With neither set, nothing changes. | `src/services/models.ts`, `README.md`, `fern/pages/ref/env-vars.mdx` |
| The eval suite **silently drifted** to a one-line stand-in prompt (it regex-extracted the prompt from `agent/index.ts`, which stopped matching). | Builds the prompt the same way production does (`buildInstructions`); uses only the read-only tools. | `test/evals/agent.eval.ts` |

---

## 4. Files touched — complete list

**Source & tests (committed, groups A–D):**

```
agent/instructions.ts
agent/__tests__/instructions.test.ts
agent/tools/category-rules.ts
agent/tools/create-issue.ts
agent/tools/cypher-guard.ts          (new)
agent/tools/guidance.ts
agent/tools/ingest-missing-issues.ts
agent/tools/issue-types.ts
agent/tools/prioritize-issues.ts
agent/tools/pull-requests.ts
agent/tools/query-neo4j.ts
agent/tools/reconcile-issue-state.ts
agent/tools/record-assessment.ts
agent/tools/refresh-issues.ts
agent/tools/refresh-pull-requests.ts
agent/tools/set-board-column.ts
agent/tools/summarize-comments.ts
agent/tools/sync-board-fields.ts
agent/tools/update-issue.ts
agent/tools/__tests__/cypher-guard.test.ts
agent/tools/__tests__/query-neo4j.test.ts
agent/tools/__tests__/summarize-comments.test.ts
src/services/analysis.ts
src/services/github.ts
src/services/issue-analysis.ts
src/services/models.ts
src/services/neo4j.ts
src/services/pipeline.ts
src/services/__tests__/analysis.test.ts
src/services/__tests__/models.test.ts
test/integration/cypher.test.ts
package.json  (+ bun.lock)
```

**Uncommitted (group E) adds:** `src/services/__tests__/ingest-batch.test.ts`,
`src/services/__tests__/github-concurrency.test.ts`, `biome.json`,
`test/evals/agent.eval.ts`, `README.md`, `fern/pages/ref/env-vars.mdx`.

**Evidence / docs (not part of the shipped code):** `benchmark/**`, `OPTIMISATION.md`.
(The `fern/**` docs site was added in an earlier commit already on `origin/main`, not by this branch.)

---

## 5. Things to be aware of (new env vars & intentional behaviour changes)

**New environment variables**

| Variable | Default | Effect |
|---|---|---|
| `GITHUB_FETCH_CONCURRENCY` | off / 1 | Fetch this many issues from GitHub at once. |
| `MODEL_TIMEOUT_MS` | 60000 | Per-call model timeout. |
| `MODEL_MAX_TOKENS` | 1024 | Cap on free-text model output. |
| `MODEL_JUDGE` | = `MODEL_FAST` | Eval suite only: the model that scores answers. |
| `JUDGE_GATEWAY_URL` / `JUDGE_GATEWAY_API_KEY` | unset | Eval suite only: send the judge to a different OpenAI-compatible endpoint. The key is required, so the gateway key is never sent elsewhere. |

**Intentional behaviour changes** (these are deliberate; the *stored graph on a normal run is
unaffected*):

1. **Edited issues are now re-analysed on a "changes only" sync** (previously they were silently
   skipped). Scheduled syncs will now make model calls for edited issues.
2. **Orphan cleanup is narrower** — only removes rows the re-analysed issue created; pre-existing
   strays are left in place.
3. **A solution without a comment source is kept** rather than failing the whole issue's analysis.
4. **Schema bootstrap can report an error on a database that already contains duplicates** —
   ingestion still works and the graph ends up the same, but `ingestion/index.ts` exits 1 until
   the duplicates are removed.
5. **Model-call limits** (timeout + token cap) can cut off a very slow/long answer; both tunable
   by env var.
6. **Concurrent fetch is off by default** and should be enabled with care (GitHub rate limits).
7. **Repeated reactions on separate comments are preserved** — the reaction merge key now
   includes the comment id, fixing data loss that the earlier fixture comparison didn't exercise.

---

## 6. Suggested review order

1. `git show dc34767 f126f42 2a16b83` — the database-write changes (group A). These are the
   highest-impact and the ones to scrutinise most.
2. `git show 4dfa100 8977994` — the fetch→analysis hand-off and the re-analysis bug fix (group B).
3. `git show c93ef61` — the new `cypher-guard.ts` (group C). Read the tool in isolation; it only
   appends warnings and never rewrites a query.
4. `git show 89d5a98 1bedad9` — the two instruction changes (group C).
5. `git show a6c1ae1 19061b9 4762100` — analysis robustness + summariser + model client (group D).
6. `git diff` (working tree) — group E tidy-ups, mostly formatting + the new tests.
7. Skim `OPTIMISATION.md` §5–§7 for the measurements and the independent verification.

---

## 7. Evidence behind the claims

- `benchmark/verification.json` — every check made on the benchmark and its outcome.
- `benchmark/profile/repeat-runs.json` — database counts, repeat timings, database comparison.
- `benchmark/qa/rerun/` — the fresh question tests, original vs branch, per question set.
- `benchmark/README.md` — how to read each file and re-derive a number yourself.
- `OPTIMISATION.md` — the full report (results in §5, checks in §7).

---

## 8. Not in this PR

- The `perf/agent-latency-bound` branch (commit `f38d52d`, "bound a stalled model call to 15s")
  is **separate and not part of this PR**.
- The test program that produced the `benchmark/` files is not included — only its output.

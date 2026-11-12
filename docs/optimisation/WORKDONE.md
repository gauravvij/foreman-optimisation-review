# Work done: the foreman optimisation branch, commit by commit

**The review guide.** It lists *what changed, where, and why*, commit by commit, so you can
review the branch without reverse-engineering it from the diff. For the one-page version see
[`README.md`](README.md); for the measurements and the independent check see
[`OPTIMISATION.md`](OPTIMISATION.md). File paths here are from the repository root.

---

## 1. What this branch is

| | |
|---|---|
| **PR base** | `origin/main` = `306d0ce` (the diff and the PR are against this) |
| **Original code** | `3cd3dde`, the parent of `306d0ce`. `306d0ce` adds only the `fern/` docs site, so the two are the *same code*. `OPTIMISATION.md` calls `3cd3dde` "the original". |
| **Branch** | `pr/foreman-optimisation`, 18 commits ahead of `origin/main`: 12 code commits (groups A–D), 1 evidence commit (`258000c`), and 5 commits made during the independent check (group E) |
| **What it does** | Makes reading GitHub issues into the Neo4j graph cheaper (fewer database requests), and makes the assistant answer questions more reliably (fewer confidently wrong answers) |
| **What it does *not* do** | It does not change *what* ends up in the graph: on the test data the stored content is identical to the original's (verified at 5, 20 and 60 issues). The one deliberate exception is a data-loss fix for repeated reactions (section 5, item 7). |

Everything below is grouped the same way as **section 3 of `OPTIMISATION.md`** (groups A–E),
so the two documents line up. Commit ids are in backticks so you can `git show` any of them.

---

## 2. The changes in brief

- **Group A: fewer database requests when reading issues in.** Set up constraints and indexes
  once per run; write issues in one batched transaction instead of about 6 requests each; limit
  the post-analysis tidy-up to the issue being re-analysed instead of scanning the whole database.
- **Group B: a leaner fetch-to-analysis hand-off.** Optional bounded-concurrency GitHub fetch
  (off by default); pass fetched data straight to analysis instead of writing it and reading it
  back; fix a bug where edited issues were never re-analysed.
- **Group C: fewer confidently wrong answers.** Teach the assistant the real `OPEN`/`CLOSED`
  state spelling; stop it treating an empty result as an absent fact; add a **query checker**
  that warns on reversed or impossible graph traversals (it never edits the query or its results).
- **Group D: sturdier analysis and summaries.** Keep a solution even when the model omits its
  comment source; give the summariser the issue's title and body; bound long threads; tighten
  the model client (timeout, retries, token cap, one shared connection).
- **Group E: changes made during the independent check.** Tests for the reading-in code and for
  each change that had none, the repeated-reaction fix, a neutral example in the instructions, a
  separate judge for the eval suite, formatting, docs for the new settings, the OpenHands 600
  results over three runs, and a script that re-checks every reported number.

No change is a rewrite. Every change is either (a) a database *how*, not *what*, or (b) an
addition to the assistant's instructions or tools that is easy to read on its own.

---

## 3. Change inventory: the problem, the fix, and how

Each row is one change: **the problem it fixes, the fix, and how it was made** (with the commit
and the files). Grouped A–E to match `OPTIMISATION.md` section 3.

### Group A: Less database work when reading issues in

| Problem it fixes | Commit | Files | How it was fixed |
|---|---|---|---|
| Reading issues in was expensive: about 6 separate write requests per issue, a **new database connection per issue**, and a whole-database tidy-up scan after every issue. At 60 issues that was 620 requests and 127 connections. | `dc34767` | `src/services/neo4j.ts`, `src/services/pipeline.ts` | Applies the graph schema **once per run**: 10 uniqueness constraints (an issue, person or comment can't be stored twice) and 2 indexes for common lookups. |
| The writes themselves were chatty: one request per kind of row per issue. | `f126f42` | `src/services/neo4j.ts` | Writes **all issues in a single managed transaction** (one batch) instead of about 6 requests each. If the batch fails it **falls back to per-issue writes**, so nothing is lost. |
| A full-database scan ran after every issue to tidy up leftovers. | `2a16b83` | `src/services/analysis.ts` | On re-analysis, cleans up **only the leftover entries that issue released**. |

### Group B: A leaner hand-off from fetching to analysis

| Problem it fixes | Commit | Files | How it was fixed |
|---|---|---|---|
| Each issue was written to the graph and then **read straight back out** for analysis (wasted round-trips). Also a **bug**: an issue edited on GitHub was compared against itself, so it was **never re-analysed**. | `4dfa100` | `src/services/pipeline.ts`, `src/services/neo4j.ts` | Hands freshly fetched data **directly to analysis** instead of writing it and reading it back; fixes the re-analysis skip. |
| Fetching was strictly one issue at a time. | `8977994` | `src/services/github.ts` | Adds `GITHUB_FETCH_CONCURRENCY` (bounded concurrent fetch). **Off by default**; results stay in their original order. |

### Group C: Fewer confidently wrong answers

| Problem it fixes | Commit | Files | How it was fixed |
|---|---|---|---|
| The assistant guessed the issue state was `open`, got no results, and answered "there are no open issues". The state is stored `OPEN`/`CLOSED`. | `89d5a98` | `agent/instructions.ts`, `agent/tools/query-neo4j.ts` | Documents the real `OPEN`/`CLOSED` spelling. |
| An empty result was reported as an absent fact. | `1bedad9` | `agent/instructions.ts` | New rule: "an empty result may mean your query is wrong; check it first". |
| Queries followed graph links the wrong way round, or links that can't exist, and silently returned nothing. | `c93ef61` | `agent/tools/cypher-guard.ts` *(new)*, `agent/tools/query-neo4j.ts` | Adds a **query checker** that appends a warning on reversed or impossible traversals. **It never changes the query or its results.** |
| A type error. | `07a126d` | `agent/tools/__tests__/summarize-comments.test.ts` | Adds a missing field so the type checker passes. |

### Group D: Sturdier analysis and summaries

| Problem it fixes | Commit | Files | How it was fixed |
|---|---|---|---|
| If the model proposed a solution but left out which comment it came from, the **whole analysis for that issue failed**. | `a6c1ae1` | `src/services/analysis.ts`, `src/services/issue-analysis.ts` | Keeps the solution and links it to the issue instead of failing. |
| Summaries drifted onto the most quotable comment thread instead of the issue's real problem. | `19061b9` | `agent/tools/summarize-comments.ts`, `src/services/analysis.ts`, `agent/instructions.ts` (and several tool files) | Anchors the summariser on the **issue's title and body**; guards the "competitor" comment hop. |
| Long threads were unbounded, and the model client had **no timeout, retries or output cap**. | `4762100` | `agent/tools/*`, `agent/instructions.ts`, `src/services/models.ts` | Bounds thread length (and **says so when it truncates**); moves write rules into the descriptions of the tools they apply to; adds `MODEL_TIMEOUT_MS` (60 s), 2 retries, `MODEL_MAX_TOKENS` (1024), one shared connection, and one retry when the model skips a required tool call. |

**New dependency:** `gpt-tokenizer` (development only, used by one test that keeps the
instructions within their size budget). No runtime dependencies were added.

### Group E: Changes made during the independent check

Five commits:

| Id | Commit | Contents |
|---|---|---|
| E1 | `10d6ea3` docs: add WORKDONE.md and SUMMARY.md, tidy-ups and final test evidence | The tidy-ups, the reaction fix, the judge option, new tests and evidence |
| E2 | test: cover re-analysis, the narrower tidy-up and repeated reactions; format batch ingest | Tests for three changes that had none, formatting, one corrected comment |
| E3 | docs: document the tuning environment variables | Six settings added by groups A, B and D, now in the README and the docs site |
| E4 | docs: move the optimisation report and evidence into docs/optimisation | This folder, the first OpenHands 600 run and the numbers check |
| E5 | docs: report OpenHands 600 over three runs | Two more OpenHands 600 runs, reported with the first as three runs; the earlier 60-issue OpenHands results removed |

| Problem it fixes | Change | Commit | Files |
|---|---|---|---|
| The reading-in code had **no tests**. | 26 new tests (17 + 9). They were also checked by breaking the code on purpose in 4 places; they caught all 4. | E1 | `src/services/__tests__/ingest-batch.test.ts` *(new)*, `src/services/__tests__/github-concurrency.test.ts` *(new)* |
| An instruction example was **taken from one of the question sets** (leakage). | A neutral example (`"Good First Issue"`). | E1 | `agent/instructions.ts` |
| Repeated reactions were **lost**: one person's same reaction on two comments of an issue was merged into one. Found by the database check of the OpenHands test. | Comment reactions include the comment id in their merge key; issue-level reactions match only other issue-level reactions. | E1 | `src/services/neo4j.ts` |
| The AI judge used the same model it was scoring, so it **marked its own work**. | `MODEL_JUDGE` moves only the judge; `JUDGE_GATEWAY_URL` + `JUDGE_GATEWAY_API_KEY` can send it to another provider. With neither set, nothing changes. | E1 | `src/services/models.ts`, `README.md`, `fern/pages/ref/env-vars.mdx` |
| The eval suite **silently drifted** to a one-line stand-in prompt (it regex-extracted the prompt from `agent/index.ts`, which stopped matching). | Builds the prompt the same way production does (`buildInstructions`); uses only the read-only tools. | E1 | `test/evals/agent.eval.ts` |
| Style drift. | Formatting and style fixes. **Behaviour unchanged.** | E1, E2 | the changed `agent/` and `src/` files |
| Machine-written record files were being style-checked. | The evidence folder is excluded from the style checker. | E1 (path updated in E4) | `biome.json` |
| Evidence was not captured in the repo. | Test evidence: fresh re-test, repeated timings, check record. | E1 | `docs/optimisation/benchmark/qa/rerun/`, `docs/optimisation/benchmark/profile/repeat-runs.json`, `docs/optimisation/benchmark/verification.json` |
| Three changes had **no test in the repository**: re-analysing edited issues, the narrower tidy-up, and the reaction fix on a real database. | A test for each; each fails on the original code. | E2 | `src/services/__tests__/pipeline-incremental.test.ts` *(new)*, `test/integration/cypher.test.ts` |
| One comment overstated a retry. | Corrected. **Behaviour unchanged.** | E2 | `src/services/models.ts` |
| Six new settings were **not documented**. | Each documented with its default. | E3 | `README.md`, `fern/pages/ref/env-vars.mdx` |
| The OpenHands test covered only 60 issues, in one run. | Original vs branch on **OpenHands 600** (600 issues, 150 questions, 1 attempt per question), run three times. | E4, E5 | `docs/optimisation/benchmark/qa/rerun/*-oh-600-run{1,2,3}.json` *(new)* |
| Readers had no quick way to see each change work, or to check the report's numbers. | A "See each change working" table, and one command that re-checks every number. | E4 | `docs/optimisation/README.md`, `docs/optimisation/benchmark/check-numbers.ts` *(new)* |
| The report and its evidence sat at the repository root. | Moved into one folder, `docs/optimisation/`. | E4 | `docs/optimisation/**` |

---

## 4. Files touched: complete list

**Code** (groups A–E):

```
agent/instructions.ts
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
src/services/analysis.ts
src/services/github.ts
src/services/issue-analysis.ts
src/services/models.ts
src/services/neo4j.ts
src/services/pipeline.ts
package.json  (+ bun.lock: the gpt-tokenizer dev dependency)
```

**Tests:**

```
agent/__tests__/instructions.test.ts
agent/tools/__tests__/cypher-guard.test.ts            (new)
agent/tools/__tests__/query-neo4j.test.ts
agent/tools/__tests__/summarize-comments.test.ts
src/services/__tests__/analysis.test.ts
src/services/__tests__/github-concurrency.test.ts     (new)
src/services/__tests__/ingest-batch.test.ts           (new)
src/services/__tests__/models.test.ts
src/services/__tests__/pipeline-incremental.test.ts   (new)
test/evals/agent.eval.ts
test/integration/cypher.test.ts
```

**Docs and settings:** `README.md` and `fern/pages/ref/env-vars.mdx` (the new environment
variables), `biome.json` (excludes the evidence folder from the style checker).

**This folder, not part of the shipped code:** `docs/optimisation/**`, the report and its
evidence. (The `fern/**` docs site itself was added by `306d0ce`, already on `origin/main`.)

---

## 5. Things to be aware of (new settings and intentional behaviour changes)

**New environment variables**

| Variable | Default | Effect |
|---|---|---|
| `GITHUB_FETCH_CONCURRENCY` | 1 (one at a time) | Fetch this many issues from GitHub at once. |
| `MODEL_TIMEOUT_MS` | 60000 | Per-call model timeout. |
| `MODEL_MAX_TOKENS` | 1024 | Cap on free-text model output (summaries, not structured analysis). |
| `NEO4J_INGEST_BATCH_SIZE` | 250 | Issues written to the database in one transaction. |
| `SUMMARIZE_COMMENT_LIMIT` | 200 | Most comments the summariser reads per issue (the newest). |
| `SUMMARIZE_PROMPT_CHAR_CAP` | 40000 | Most characters of comments the summariser sends to the model. |
| `MODEL_JUDGE` | the `MODEL_FAST` model | Eval suite only: the model that scores answers. |
| `JUDGE_GATEWAY_URL` / `JUDGE_GATEWAY_API_KEY` | unset | Eval suite only: send the judge to a different OpenAI-compatible endpoint. The key is required, so the gateway key is never sent elsewhere. |

**Intentional behaviour changes** (deliberate; on the test data the stored graph is unaffected):

1. **Edited issues are now re-analysed on a "changes only" sync** (before, they were silently
   skipped). Scheduled syncs will now make model calls for edited issues.
2. **The tidy-up is narrower**: it only removes leftover entries the re-analysed issue
   released; stray entries from earlier are left in place.
3. **A solution without a comment source is kept** instead of failing the whole issue's analysis.
4. **Setting up the schema can report an error on a database that already contains
   duplicates.** Ingestion still works and the graph ends up the same, but `ingestion/index.ts`
   exits 1 until the duplicates are removed. The same rules cannot hold a solution or workaround
   text over about 8,000 characters; such an issue's analysis is not stored and the run reports
   an error.
5. **Model-call limits** (timeout and token cap) can cut off a very slow or very long answer;
   both can be changed by environment variable.
6. **Concurrent fetch is off by default** and should be turned on with care (GitHub rate limits).
7. **Repeated reactions on separate comments are kept.** The reaction merge key now includes
   the comment id, fixing data loss that the Hugging Face database comparison did not exercise.

---

## 6. Suggested review order

1. `git show dc34767 f126f42 2a16b83`: the database-write changes (group A). These have the
   most impact and deserve the closest look.
2. `git show 4dfa100 8977994`: the fetch-to-analysis hand-off and the re-analysis bug fix (group B).
3. `git show c93ef61`: the new `cypher-guard.ts` (group C). Read the tool on its own; it only
   appends warnings and never rewrites a query.
4. `git show 89d5a98 1bedad9`: the two instruction changes (group C).
5. `git show a6c1ae1 19061b9 4762100`: analysis robustness, the summariser and the model
   client (group D).
6. `git log -p 10d6ea3~1..HEAD -- agent src test`: the group E code and test changes (mostly
   formatting, the reaction fix, the judge option and the new tests).
7. Run the commands under "See each change working" in [`README.md`](README.md), then skim
   `OPTIMISATION.md` sections 5 to 7 for the measurements and the independent check.

---

## 7. Evidence behind the claims

- [`benchmark/verification.json`](benchmark/verification.json): every check made on the
  benchmark and its outcome.
- [`benchmark/profile/repeat-runs.json`](benchmark/profile/repeat-runs.json): database counts,
  repeat timings, database comparison.
- [`benchmark/qa/rerun/`](benchmark/qa/rerun/): the fresh question tests, original vs branch,
  per question set.
- [`benchmark/README.md`](benchmark/README.md): how to read each file and re-derive a number yourself.
- `bun docs/optimisation/benchmark/check-numbers.ts`: re-checks every number in the report
  against those files.
- [`OPTIMISATION.md`](OPTIMISATION.md): the full report (results in section 5, checks in section 7).

---

## 8. Not in this PR

- A separate experiment that bounds a stalled model call to 15 s is **not part of this PR**.
- The test program that produced the `benchmark/` files is not included, only its output
  (`benchmark/README.md` says what it is and where it lives).

# Foreman optimisation

**Start here.** This page is the one-page version: what the problems were, what was fixed, a
command to see each fix working, and the headline results. The other files in this folder go
deeper:

| File | Read it for |
|---|---|
| This page | The problems, the fixes, how to see each fix work, and the headline results |
| [`WORKDONE.md`](WORKDONE.md) | Reviewing the code: every commit, the files it touches and the problem it fixes, in a suggested review order |
| [`OPTIMISATION.md`](OPTIMISATION.md) | The full report: how the tests work, every result with its proof file, the behaviour changes, how the work was checked, and the limits |
| [`benchmark/`](benchmark/) | The proof files behind every number, and `check-numbers.ts`, which re-checks the report's numbers against them |

Foreman reads a project's GitHub issues into a Neo4j graph, then answers questions about them.
This branch makes the **reading-in** cheaper (fewer database requests) and the **answering**
more reliable (fewer confidently wrong answers). It changes *how* foreman writes to the
database, not *what* it stores: on the test data the stored graph is identical to the
original's (verified at 5, 20 and 60 issues). The one deliberate difference is a data-loss fix:
when one person gives the same reaction on two comments of an issue, the original kept only one
of them, and the branch keeps both (`OPTIMISATION.md` section 6, item 7).

---

## The problems, the fixes, and how each was made

| # | The problem | What was fixed | How it was fixed (group · commit) |
|---|---|---|---|
| 1 | Reading issues in was expensive: about **6 separate write requests per issue**, a **new database connection per issue**, and a **whole-database tidy-up scan after every issue**. At 60 issues: 620 requests, 127 connections, 2.8 s. | 620 → **209** requests, 127 → **9** connections, 2.8 s → **0.8 s**, with an identical database. | **A**: apply the database rules once per run (`dc34767`), write all issues in one all-or-nothing batch (`f126f42`), limit the tidy-up to the issue being re-analysed (`2a16b83`). |
| 2 | Wasteful hand-off: each issue was written to the graph and then **read straight back out** for analysis. And a **bug**: an issue edited on GitHub was compared against itself, so it was **never re-analysed**. | Fetched data goes **straight to analysis**; edited issues are **re-analysed**; optional faster fetching. | **B**: pass fetched data to analysis and fix the skip (`4dfa100`); add `GITHUB_FETCH_CONCURRENCY`, **off by default** (`8977994`). |
| 3 | The assistant gave **confidently wrong answers**: it guessed the issue state was `open` (it is stored `OPEN`), followed graph links the wrong way round, and treated an empty result as proof the data did not exist. | On the three main question sets, every one-answer question was then right on **every** attempt (**483 of 483**); SymPy Core 50 went from 91.3% to **100%**. | **C**: document the `OPEN`/`CLOSED` state (`89d5a98`), change the "empty result" rule (`1bedad9`), add a **query checker** that warns on reversed or impossible links without changing the query (`c93ef61`). |
| 4 | Fragile analysis: if the model proposed a solution but **left out which comment it came from**, the **whole analysis for that issue failed**. Summaries drifted onto the most quotable comment instead of the issue's real problem. Long threads were unbounded, and the model client had **no timeout, retries or output cap**. | Solutions are **kept**; summaries are **anchored on the issue**; long threads are **bounded and say so**; the model client has a timeout, retries and a cap. | **D**: keep a solution with no comment source (`a6c1ae1`), anchor the summariser on the title and body (`19061b9`), bound threads and add the timeout, retries and token cap (`4762100`). |
| 5 | Gaps found during the independent check: the reading-in code had **no tests**; an instruction example was **taken from a test set**; the eval suite had **silently drifted** to a one-line stand-in prompt; the AI judge **marked its own model's work**; repeated reactions were **lost**. | New tests, a **neutral** example, style fixes, a fixed eval suite, a **separate judge**, the reaction fix, and a script that re-checks every reported number. | **E**: `10d6ea3` and the commits after it. |

---

## See each change working

Each command runs the tests that show one change. Run them from the repository root after
`bun install`. The last two need Docker, because they start a real Neo4j.

| Change | Why it matters | Run |
|---|---|---|
| Database rules set up once per run | Lookups use an index; the same issue cannot be stored twice | `bun x vitest run --project unit -t "setupDatabaseSchema"` |
| All issues written in one batch, retried one by one if it fails | About a third of the database work, and nothing lost on a bad issue | `bun x vitest run --project unit -t "ingestMultipleIssues"` |
| Edited issues are re-analysed on a "changes only" sync | Before, an edited or new issue was never re-analysed | `bun x vitest run --project unit -t "incremental sync re-analysis"` |
| Optional parallel fetch, off by default | Faster fetching when turned on, same order of results | `bun x vitest run --project unit -t "worker pool"` |
| Query checker warns on reversed or impossible links | A wrong query no longer looks like "no such data" | `bun x vitest run --project unit -t "checkCypherAgainstSchema"` |
| The checker never changes a query or its result | Safe to add: it only adds a warning | `bun x vitest run --project unit -t "changes nothing but warnings"` |
| A solution without a comment source is kept | Before, one missing detail lost the issue's whole analysis | `bun x vitest run --project unit -t "solutions and workarounds"` |
| Summaries anchored on the issue, long threads bounded | Summaries stay on the issue's real problem and within budget | `bun x vitest run --project unit -t "summarizeCommentsTool"` |
| The judge can be a different model | The judge no longer marks its own model's work | `bun x vitest run --project unit -t "judge"` |
| Re-analysis tidies up only what the issue left behind | No whole-database sweep after every issue | `bun x vitest run --project integration -t "tidies up only"` |
| Repeated reactions on different comments are kept | Before, they were merged and lost | `bun x vitest run --project integration -t "reaction ingestion"` |

To re-check every number in the report against the proof files (no keys, database or network
needed; it exits 1 if any number differs):

```bash
bun docs/optimisation/benchmark/check-numbers.ts
```

---

## Headline results

"Original" is foreman before these changes (commit `3cd3dde`). An **attempt** is one try at one
question; each question was asked 3 times, except in OpenHands 600, where it was asked once per
run, in three separate runs.

| What was measured | Original | This branch |
|---|---:|---:|
| Database requests to read in 60 issues | 620 | **209** |
| Database connections for the same job | 127 | **9** |
| Time to read in 60 issues (median of 5 runs) | 2.8 s | **0.8 s** |
| What ends up in the database (Hugging Face test data) | | **exactly the same** |
| SymPy Core 50: attempts right | 137/150 (91.3%) | **150/150 (100%)** |
| Hugging Face 50: attempts right | 148/150 (98.7%) | **150/150 (100%)** |
| SymPy Extended 81: attempts right | 239/243 (98.4%) | **242/243 (99.6%)** |
| One-answer attempts right, across those three sets | 472/483 | **483/483** |
| OpenHands 600 (a project not used to build the fixes): attempts right, 150 questions × 3 runs | 380/450 (84.4%) | **430/450 (95.6%)** |
| OpenHands 600: attempts right in each run (of 150) | 126, 127, 127 | **144, 141, 145** |
| Database requests to read in those 600 issues, average of 3 runs | 8,700 | **3,028** |

On the first three sets no question did worse on the branch. On OpenHands 600, in each of the
three runs 19 to 21 questions improved and 2 to 5 got worse. The answers come from `gpt-4o`,
not from the models foreman uses in production. Details, caveats and proof files are in
[`OPTIMISATION.md`](OPTIMISATION.md), sections 5 and 7.

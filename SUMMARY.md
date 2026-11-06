# SUMMARY — Foreman optimisation

**One page. What the problem was, what was fixed, and how.** For the full per-commit
inventory (exact files and commits) see [`WORKDONE.md`](WORKDONE.md); for the measurements
and the independent verification see [`OPTIMISATION.md`](OPTIMISATION.md).

Foreman reads a project's GitHub issues into a Neo4j graph, then answers questions about them.
This branch makes the **reading-in** cheaper (fewer database requests, same result) and the
**answering** more reliable (fewer confidently-wrong answers). It changes *how* foreman writes,
never *what* it stores on a normal run — the stored graph is byte-for-byte identical (verified).

---

## The issues, the fixes, and how each was made

| # | The problem | What was fixed | How it was fixed (group · commit) |
|---|---|---|---|
| 1 | Reading issues in was expensive: about **6 separate write requests per issue**, a **new database connection per issue**, and a **whole-database tidy-up scan after every issue**. At 60 issues: 620 requests, 127 connections, 2.8 s. | 620 → **209** requests, 127 → **9** connections, 2.8 s → **0.8 s**, with an identical database. | **A** — apply the rules once per run (`dc34767`), write all issues in one all-or-nothing batch (`f126f42`), scope the tidy-up to the issue being re-analysed (`2a16b83`). |
| 2 | Wasteful hand-off: each issue was written to the graph and then **read straight back out** for analysis. And a **bug**: an issue edited on GitHub was compared against itself, so it was **never re-analysed**. | Fetched data goes **straight to analysis**; edited issues are **re-analysed**; optional faster fetching. | **B** — pass fetched data to analysis and fix the skip (`4dfa100`); add `GITHUB_FETCH_CONCURRENCY`, **off by default** (`8977994`). |
| 3 | The assistant gave **confidently-wrong answers**: it guessed the issue state was `open` (it is stored `OPEN`), followed graph links the wrong way round, and treated an empty result as proof the data did not exist. | On the three question sets, every one-answer question was then right on **every** attempt (**483/483**); SymPy Core 50 went 91.3% → **100%**. | **C** — document the `OPEN`/`CLOSED` state (`89d5a98`), change the "empty result" rule (`1bedad9`), add a **query checker** that warns on reversed/impossible links without changing the query (`c93ef61`). |
| 4 | Fragile analysis: if the model proposed a solution but **omitted which comment it came from**, the **whole analysis for that issue failed**. Summaries drifted onto the most quotable comment instead of the issue's real problem. Long threads were unbounded, and the model client had **no timeout, retries, or output cap**. | Solutions are **kept**; summaries are **anchored on the issue**; long threads are **bounded and say so**; the model client is hardened. | **D** — keep a source-less solution (`a6c1ae1`), anchor the summariser on the title/body (`19061b9`), bound threads and add timeout/retries/token cap (`4762100`). |
| 5 | Gaps found during the independent check: the reading-in code had **no tests**; an instruction example was **taken from a test set**; the eval suite had **silently drifted** to a one-line stand-in prompt; the AI judge **marked its own model's work**. | 26 new tests, a **neutral** example, style fixes, a fixed eval harness, and a **decoupled judge**. | **E** — (uncommitted working tree). |

---

## Headline results

| What was measured | Original | This branch |
|---|---:|---:|
| Database requests to read in 60 issues | 620 | **209** |
| Database connections for the same job | 127 | **9** |
| Time to read in 60 issues (median of 5 runs) | 2.8 s | **0.8 s** |
| What ends up in the database (earlier fixture) | — | **exactly the same** |
| SymPy Core 50 · attempts answered correctly | 137/150 (91.3%) | **150/150 (100%)** |
| Hugging Face 50 · attempts answered correctly | 148/150 (98.7%) | **150/150 (100%)** |
| SymPy Extended 81 · attempts answered correctly | 239/243 (98.4%) | **242/243 (99.6%)** |
| One-answer attempts right, across those three sets | 472/483 | **483/483** |
| OpenHands Dev 50 (a new project) · attempts right | 124/150 (82.7%) | **144/150 (96.0%)** |

No question did worse on the branch on those three sets. Details, caveats and proof files are
in [`OPTIMISATION.md`](OPTIMISATION.md) §5 and §7.

---

## Read next

| File | What it is |
|---|---|
| [`WORKDONE.md`](WORKDONE.md) | Full change inventory — every commit, the files it touches, and the issue it fixes. **Start here to review the branch.** |
| [`OPTIMISATION.md`](OPTIMISATION.md) | The full report: method, results, behaviour changes, and the independent check. |
| `benchmark/` | The evidence files behind the numbers. |

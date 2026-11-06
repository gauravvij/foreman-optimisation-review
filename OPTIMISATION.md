# Foreman optimisation report

> **Who did this work.** This optimisation was carried out by **NEO**
> ([heyneo.com](https://heyneo.com)), an autonomous AI engineering agent. NEO ran the
> optimisation end to end on its own: it profiled foreman, chose and made the code changes,
> and built the benchmark used to measure them (the question sets, the scoring program and the
> ingestion profiler). The benchmark and the results were then checked for robustness and
> correctness with **Claude Code**, Anthropic's AI coding agent, using **Claude Opus 5.5** for
> the final verification. Section 7 lists every check and its result.

---

## 1. At a glance

Foreman is an assistant that reads a project's GitHub issues into a database (a Neo4j
graph) and then answers questions about them. This work made it more efficient at reading
issues in, and more reliable at answering questions.

| What was measured | Original version | This branch |
|---|---:|---:|
| Database requests to read in 60 issues | 620 | **209** |
| Database connections opened for the same job | 127 | **9** |
| Time to read in 60 issues (middle value of 5 runs) | 2.8 s | **0.8 s** |
| What ends up in the database on the earlier Hugging Face fixture | | **exactly the same** |
| **SymPy Core 50**: attempts answered correctly | 137 of 150 (91.3%) | **150 of 150 (100%)** |
| **Hugging Face 50**: attempts answered correctly | 148 of 150 (98.7%) | **150 of 150 (100%)** |
| **SymPy Extended 81**: attempts answered correctly | 239 of 243 (98.4%) | **242 of 243 (99.6%)** |
| Attempts at questions with one right answer, these three sets | 472 of 483 | **483 of 483** |
| Questions that did worse on the branch, these three sets | | **none** |
| **OpenHands Dev 50** (a new project, tested last): attempts answered correctly | 124 of 150 (82.7%) | **144 of 150 (96.0%)** |

The four names in bold are the four **question sets**, and an **attempt** is one try at
one question. Both terms are explained in section 4. OpenHands Dev 50 was built after the work,
from a project that was not used to build it, and is described in section 7.

In short: the earlier fixture ends up in the database with about a third of the database
work, and the assistant gives the right answer more often. On the first three question sets,
every question with a single right answer was answered correctly on every attempt by the
branch. On OpenHands Dev 50 the branch also did clearly better, although it still misses some
questions about dates (section 7). OpenHands dev also exposed repeated comment reactions that
were previously lost; the branch now preserves them (section 6).

"Original version" means foreman as it was before these changes (commit `3cd3dde`). "This
branch" means the code in this pull request. This report calls them the *original* and the
*branch*. Section 4 says exactly which version of the branch each result was measured on.

---

## 2. Where NEO started and what it set out to do

Foreman has two jobs, and NEO looked at each.

1. **Reading issues in.** For every issue, foreman fetched it from GitHub, wrote it to the
   database one small step at a time, read it back out, and then asked an AI model to
   classify it. This made many separate database requests, and some of them scanned the
   whole database to tidy up after each issue.
2. **Answering questions.** The assistant turns a question into a database query. NEO found
   cases where the query was subtly wrong but still ran, returned nothing, and the assistant
   then said "there is no such data" with full confidence.

So the goals were: less database work with an identical result, and fewer confidently wrong
answers. Making answers cheaper or faster was not a goal; section 5.6 reports what happened to
cost and speed anyway.

---

## 3. What changed, and where

NEO made 12 code commits (groups A to D) and one commit that adds the test evidence. Group E
lists tidy-ups made during the independent check (section 7). Commit ids are in backticks so
each change can be found in the history.

| Group | In one line | Commits |
|---|---|---|
| **A. Less database work when reading issues in** | Apply the database rules once per run; write all issues in one all-or-nothing batch instead of about six requests per issue; tidy up only the leftovers the re-analysed issue created, instead of scanning the whole database. | `dc34767`, `f126f42`, `2a16b83` |
| **B. A leaner hand-off from fetching to analysis** | Add an optional bounded-concurrency GitHub fetch (**off by default**); hand freshly fetched data straight to analysis instead of writing it and reading it back; fixes a bug where an issue edited on GitHub was never re-analysed. | `8977994`, `4dfa100` |
| **C. Fewer confidently wrong answers** | Tell the assistant an issue's state is stored `OPEN`/`CLOSED`; treat an empty result as a possible query mistake rather than an absent fact; add a **query checker** that warns on reversed or impossible links (it never changes a query or its results). | `89d5a98`, `1bedad9`, `c93ef61`, `07a126d` |
| **D. Sturdier analysis and summaries** | Keep a solution even when the model omits its comment source; anchor the comment summariser on the issue's title and body; bound how much of a long thread is summarised; tighten the model client (60s timeout, two retries, a 1,024-token cap, one shared connection). | `a6c1ae1`, `19061b9`, `4762100` |
| **E. Tidy-ups made during the independent check** | 26 new tests for the reading-in code, a neutral example in the instructions, formatting and style fixes, more test evidence, and two test-infrastructure fixes. | (uncommitted working tree) |

The only new dependency is a development-only helper, `gpt-tokenizer`, used by a test that
keeps the instructions within their size budget.

> **The full, per-commit breakdown of every change — the exact files, what each change does,
> and the problem each one fixes — is in [`WORKDONE.md`](WORKDONE.md), and a one-page version
> is in [`SUMMARY.md`](SUMMARY.md).** This section is the short version; those files are the
> detailed change inventory.

---

## 4. How the tests work

NEO built two tests. Both compare the original with the branch under the same conditions.

### Test 1: reading issues in

Both versions read the same 60 real issues (from the Hugging Face `datasets` project) into an
empty database. A small local program stood in for GitHub, and a stand-in AI model answered
the analysis step, so the only thing that differed was foreman's own code. The test counts:

- **Requests**: individual database commands sent.
- **Connections** (sessions): times foreman opened a connection to the database.
- **Time**: how long the whole job took. Time varies from one run to the next, so each setup
  was run five times and this report gives the **median** (the middle value).

After each run the *content* of the database was also compared: every item, every link between
items, and every stored detail.

### Test 2: answering questions

The assistant is asked questions whose correct answers are known, and each answer is marked
right or wrong. Two terms matter here, and this report uses them the same way throughout.

> **Question set.** A fixed list of questions about a fixed collection of 60 GitHub issues.
> There are three question sets: **SymPy Core 50**, **Hugging Face 50** and
> **SymPy Extended 81**. The number in each name is how many questions it holds.
>
> **Attempt.** One try at answering one question. Every question was asked **3 times**, and
> each of those 3 tries is an attempt, marked right or wrong on its own. So the 50 questions
> of SymPy Core 50 give 150 attempts, and the three sets together give 543 attempts
> (150 + 150 + 243). A question is **solved on every attempt** when all 3 of its attempts
> are right.

The three question sets (the name used in the stored files is in brackets):

| Question set | Questions | One-answer / summaries | Attempts | What it is |
|---|---:|---:|---:|---|
| **SymPy Core 50** (`sympy2-dev`) | 50 | 44 / 6 | 150 | Questions about 60 issues from SymPy, a maths library: counts, dates, labels, authors, two-step questions such as "which users commented on issues labelled X", and summaries. **NEO used this set while building the fixes**, so it is the least independent of the three. |
| **Hugging Face 50** (`lewtun-holdout`) | 50 | 44 / 6 | 150 | Questions about 60 issues from a different project, Hugging Face `datasets`. **Not used while building the fixes.** |
| **SymPy Extended 81** (`sympy2-dev-81`) | 81 | 73 / 8 | 243 | Questions about the same 60 SymPy issues: facts about one issue (title, author, number of comments), label counts and members, month counts, and summaries. **Not used while building the fixes**, although 23 of its 81 questions also appear in SymPy Core 50. |

#### How each attempt is marked right or wrong

Every question comes with its correct answer, worked out in advance by a program from the
stored copy of the 60 issues. The program only creates a question when the answer is
unambiguous, for example when there is no tie. Section 7 shows that every one of these answers
was later checked again independently.

Questions come in two kinds, and they are marked differently:

| Kind of question | Who marks it | How it decides |
|---|---|---|
| **One-answer question** (483 of the 543 attempts): a count, a name, or a list of issue numbers | A program. No AI is involved. | **A count:** the answer must state the right number, in digits or in words ("three"). Numbers copied from the question, or inside code and links, are ignored. It is marked wrong if it also states a likely wrong number listed with the question, such as the total of 60 when asked how many issues are open. **A name or fact:** the required words must appear, such as the right username. **A list of issues:** it must name exactly the right issue numbers. |
| **Summary** (60 attempts): "summarise the discussion on issue N" | An AI judge, `gpt-4o`. | The judge is given the question, the assistant's answer, the facts of the issue taken from the stored data (title, state, author, number of comments and the issue text), and a short set of rules. It passes the summary if it describes the same core problem, contradicts none of those facts, and is not a refusal. It must not fail a summary for leaving detail out or for its style. |

The program always gives the same verdict for the same answer. The judge was set to be as
consistent as possible, but its marks are still less certain than the program's.

**Which AI models were used.** The assistant answered with `gpt-4o` (it uses the smaller
`gpt-4o-mini` for its comment-summary helper). The judge was also `gpt-4o`, so the same model
answered and judged the summaries. (The OpenHands test in section 7 used a different judge.) Both versions were marked by the same judge with the same
rules, so the comparison between them is fair, but a judge marking answers from its own model
may be generous. Both versions used the same test program, scoring rules and cost meter.

### Which version of the branch each result was measured on

| Result | Measured on |
|---|---|
| Database requests, connections and contents (5.1, 5.2) and the behaviour changes (6) | the final branch, with every change in this pull request |
| Timing and the fetch option (5.3, 5.4) | commit `258000c`. Later changes touch this code only for formatting. |
| Question sets, both versions (5.5, 5.6) | commit `258000c`, the 12 code changes |
| Question set after the final tidy-ups (5.5) | the final branch, SymPy Core 50 only |

---

## 5. Results

### 5.1 The database ends up identical

After reading in 5, 20 and 60 issues, the original and the branch leave exactly the same
content in the database: the same items, the same links, and the same stored details. The
only difference is two timestamps that record when the run happened. Each database's content
was exported, sorted and fingerprinted, and the fingerprints are identical.

The check was repeated with richer data (solutions, workarounds, competitors and categories)
and a second analysis pass over the same issues. The result was again identical.

*Proof:* `benchmark/profile/repeat-runs.json`, section `database_comparison`.

### 5.2 Less database work

These counts are exact. They were identical in every repeat: 24 runs of the original and 12
of the branch at each size.

| Issues read in | Requests: original → branch | Connections: original → branch |
|---:|---:|---:|
| 5 | 51 → **41** | 17 → **9** |
| 20 | 212 → **89** | 47 → **9** |
| 60 | 620 → **209** | 127 → **9** |

At 60 issues, the 60 whole-database tidy-up scans are gone entirely, and all issues are
written in one all-or-nothing step.

**Why fewer requests still give the same database.** The table below sorts the 60-issue
requests by what they do.

| What the requests do | Original | Branch |
|---|---:|---:|
| Write the issues, people, comments, labels, reactions and the links between them | 372 | **9** |
| Read each issue back after writing it | 60 | **0** |
| Save each issue's analysis (clear the old result, tidy up, save the new one) | 180 | 180 |
| Set up the uniqueness rules and lookup shortcuts (once) | 0 | 12 |
| Start-up and sync bookkeeping | 8 | 8 |
| **Total** | **620** | **209** |

- **Writing.** The original sent each kind of write separately for every issue, for example one
  request to store issue 1's comments, another for issue 2's, and so on. The branch sends the
  same kinds of write with the same data, but each kind goes once with a list covering all 60
  issues. The database works through each list in order, so it stores exactly what the separate
  requests stored.
- **Reading back.** The original read every issue back out of the database straight after
  writing it. Those requests only read; they never changed anything, so removing them cannot
  change what is stored.
- **Analysis.** Still three requests per issue. The tidy-up inside them now looks only at the
  entries that issue released, not the whole database. In a normal run that removes exactly the
  same entries; the one exception is stray entries left over from earlier, described in
  section 6.
- **Connections.** The original opened a new database connection for each issue. The branch
  reuses a few connections for the whole job, which is why 127 becomes 9.

Section 5.1 shows the result: the stored contents are identical.

*Proof:* `benchmark/profile/repeat-runs.json`, section `database_work_counts`. The full list of
requests for each version is in the `statements` field of `profile-foreman-baseline-60.json` and
`profile-foreman-optimised-60.json`.

### 5.3 Faster reading-in

Each setup was run five times, alternating between the versions, with the database rules
already in place. The table gives the median.

| Issues read in | Original | Branch | Faster by |
|---:|---:|---:|---:|
| 5 | 545 ms | **177 ms** | 3.1× |
| 20 | 1,388 ms | **452 ms** | 3.1× |
| 60 | 2,827 ms | **805 ms** | 3.5× |

At every size, the branch's slowest run beat the original's fastest run. The saving comes
from writing to the database: at 60 issues that step went from about 2.0 s to 0.15 s.

Good to know: the very first run on a brand-new database also creates the rules and lookup
shortcuts. That takes about half a second to a second, once.

Times come from a local database, so treat them as a comparison between the two versions, not
as a prediction for another setup.

*Proof:* `benchmark/profile/repeat-runs.json`, sections `timing` (including
`median_stage_ms`) and `branch_first_run_on_new_database`.

### 5.4 Optional: fetching several issues at once

The option is off by default. To show that it works, every GitHub request was given an extra
120 ms delay and 60 issues were read in:

| Setting | Time spent fetching | Whole job |
|---|---:|---:|
| Original (one at a time) | 14.6 s | 18.1 s |
| Branch, default (one at a time) | 14.6 s | 16.5 s |
| Branch, four at a time | **3.7 s** | **5.7 s** |

Four at a time is about four times faster at fetching because every request has the same
delay. This shows the option works; it does not predict what real GitHub will do. The number
of requests is unchanged, but they arrive closer together, and GitHub limits how fast requests
may arrive, so the option should be turned on with care.

*Proof:* `benchmark/profile/repeat-runs.json`, section
`fetch_with_120ms_added_per_request_60_issues`.

### 5.5 More questions answered correctly

Both versions were tested again from scratch on all three question sets, with 3 attempts per
question.

| Question set | Attempts right: original | Attempts right: branch | Questions solved on every attempt: original → branch |
|---|---:|---:|---:|
| SymPy Core 50 | 137 of 150 (91.3%) | **150 of 150 (100%)** | 44 → **50** of 50 |
| Hugging Face 50 | 148 of 150 (98.7%) | **150 of 150 (100%)** | 49 → **50** of 50 |
| SymPy Extended 81 | 239 of 243 (98.4%) | **242 of 243 (99.6%)** | 79 → **80** of 81 |




In every question set, no question had fewer right attempts on the branch than on the
original.

**The same results, split by kind of question:**

| Question set | One-answer attempts right: original → branch | Summary attempts right: original → branch |
|---|---:|---:|
| SymPy Core 50 | 122 → **132** of 132 | 15 → **18** of 18 |
| Hugging Face 50 | 132 → **132** of 132 | 16 → **18** of 18 |
| SymPy Extended 81 | 218 → **219** of 219 | 21 → **23** of 24 |

On every one-answer question, the branch got all 3 attempts right, in all three question
sets: 483 of 483 attempts.

**What the original got wrong on SymPy Core 50, and what fixed it.** In this test the original
had 13 wrong attempts:

| Wrong attempts | Question | What went wrong | Fixed by |
|---:|---|---|---|
| 5 | Two-step: "which users commented on issues labelled X" | The query followed a link the wrong way round, found nothing, and the assistant said "no users". | The query checker and the "check an empty result" rule |
| 3 | "How many issues are tagged bug" | The label was matched with the wrong spelling or the wrong field. | The capitals and spelling guidance |
| 3 | Summary of issue #15623 | The summary missed the actual problem, a LaTeX error. | Giving the summariser the issue's title and body |
| 1 | "How many people commented on issue 5295" | A link followed the wrong way round, answered "none". | The query checker |
| 1 | "How many different people opened issues" | A link followed the wrong way round, answered "none". | The query checker |

Across all three question sets the original had 11 wrong attempts at one-answer questions.
Running the query checker over the queries behind them, it warns on 8 of the 11. The other 3
are the "tagged bug" spelling mistake, which the instruction changes fix instead.

**How much weight to give these results.**

- SymPy Core 50 is the set NEO used while building the fixes, so its 100% is the least
  independent number.
- On the other two sets, the original already got every one-answer question right on Hugging
  Face 50, and missed one attempt on SymPy Extended 81. The branch matched or improved on that
  everywhere. On Hugging Face 50 the two attempts that separate the versions are summaries.
  On a second reading, the original's two failed summaries there are close to its passing
  ones, so treat Hugging Face 50 as "no change, and no regression".
- After the final tidy-ups (section 3, group E), SymPy Core 50 was tested again on the final
  branch code: 149 of 150 attempts right (99.3%). Every one-answer question was still right on
  all 3 attempts. The one miss is a summary of issue #15623, which the original also misses.

*Proof:* `benchmark/qa/rerun/` (one file per version per question set; the final-code test is
`branch-neutral-example-sympy2-dev.json`). The earlier stored results in `benchmark/qa/` agree:
91.33% → 100% on SymPy Core 50, after the scoring rules were corrected to accept spelled-out
numbers such as "three".

### 5.6 Cost and response time

Making answers cheaper or faster was not a goal, so both were measured to make sure nothing
changed unexpectedly. Both versions were measured the same way:

- **Cost per attempt** is 5 to 7% higher on the branch, depending on the question set
  ($0.0236 → $0.0253 on SymPy Core 50). The fixed instructions are about 9% longer, which adds
  5 to 6% to the text sent with each attempt. For both versions, 94 to 97% of that text is
  served from the model provider's cache.
- **Response time** shows no consistent change. The median moves by less than 4% and the mean
  by about 5% or less, in both directions across the three sets (median 2.29 s → 2.21 s on
  SymPy Core 50).

*Proof:* `benchmark/qa/rerun/` (fields `cost.qaUsd`, `qa.openai.cacheHitRate`, and `ms` for
each attempt).

---

## 6. Behaviour changes to be aware of

These change on purpose. The database a normal, correct run produces is not affected.

1. **Edited issues are now re-analysed on a "changes only" sync.** Before, the check compared
   an issue's last-updated time with itself, so every issue looked unchanged. In a test where
   5 issues were edited on GitHub, the original analysed none of them and the branch analysed
   all 5. Scheduled syncs will now make AI-model calls for edited issues.
2. **Tidying leftovers is narrower.** The branch removes only the leftover entries that the
   re-analysed issue created. In a test with two stray entries left from earlier, the original
   removed them and the branch left them in place.
3. **A solution without a comment source is kept.** Before, one missing detail made the whole
   analysis for that issue fail. In a test where it was missing for every issue, all 20 issues
   failed on the original and none on the branch.
4. **Setting up the uniqueness rules can fail on a database that already has duplicates.**
   Reading issues in still works and the database ends up the same, but the run reports an
   error, and `ingestion/index.ts` exits with code 1 until the duplicates are removed.
5. **Limits on AI-model calls.** The 60-second timeout and the 1,024-token cap (roughly 750
   words) can cut off a very slow or very long answer. Both can be changed with environment variables.
6. **Fetching several issues at once is off by default** and should be turned on with care
   (section 5.4).
7. **Repeated reactions on separate comments are preserved.** The OpenHands dev integrity check
   found that a reaction from the same user with the same content on two comments of one issue
   was merged into one graph node. Comment reactions now include the comment ID in their merge
   key. Issue-level reactions are matched only against other issue-level reactions, so adding one
   later cannot be swallowed by an existing comment reaction. A real batch-ingest regression test
   covers both cases. A mock ingest of the 60 OpenHands dev issues passes all 18 exact graph
   checks, including reaction links. This fixes data loss that the earlier Hugging Face database
   comparison did not exercise; its identical-content finding applies to the corpus used there.

*Proof:* `benchmark/profile/repeat-runs.json`, section `database_comparison`,
`richer_model_output_20_issues`.

---

## 7. How the work was checked

NEO built the benchmark. To make sure the benchmark and the results are robust and correct,
they were checked independently with Claude Code, Anthropic's AI coding agent, using Claude
Opus 5.5 for the final verification. The check re-tested both versions from scratch (the
results in section 5), tested both on a new question set from a new project (the end of this
section), and verified the following:

| Check | Result |
|---|---|
| The question sets have not been altered | The SymPy issue data and the SymPy Core 50 questions match the fingerprints recorded when they were frozen. The other two sets had no earlier fingerprint; theirs are now recorded in `verification.json`, and their expected answers were re-derived (next row). |
| The expected answers are right | Every expected answer to a one-answer question (161 across the three sets) was worked out again from the raw issue data by a separate program. All 161 match. Three wrong answers planted on purpose were all caught. |
| Each test used these questions | All 12 stored test reports contain exactly these questions and expected answers, and each asks every question 3 times (except one single-attempt confirmation run). |
| Each test ran the code it claims | Each report records a fingerprint of the code it tested; recomputing them ties every report to its version. |
| Answers were marked correctly | Every one-answer attempt in every stored report was marked again with the scoring program and got the same verdict. The only exception is 7 correct answers in the oldest stored report that earlier scoring rules wrongly rejected; its corrected copy, which is the one used, matches. Every headline score was recomputed from its attempts and matches. |
| Wrong answers are really wrong | Every failed attempt was read. All 11 failed one-answer attempts of the original are genuinely wrong. Summaries are marked by an AI judge and are less certain (see 5.5). |
| The database is identical | Re-run on the final branch code, with matching fingerprints (section 5.1). |
| The code builds and its tests pass | Type check passes; 618 of 618 automated tests pass (the original has 494); no new style problems (26 in the whole project, 29 before); the benchmark's own scoring self-tests pass 90 of 90. |
| The new tests can fail | The code was broken on purpose in four places; the tests caught all four. |

*Proof:* `benchmark/verification.json` records every check and its result.

### A fresh test on a new project: OpenHands Dev 50

Both versions were also tested on **OpenHands Dev 50**, a new question set from a project not
used to build the fixes: 50 questions about 60 OpenHands issues, 3 attempts each. The assistant
used `gpt-4o-2024-08-06`, and a different **judge** model, `Claude Haiku 5.5`, judged the summaries. The
branch here is `258000c` plus the changes not yet committed. A sealed second set, OpenHands
Holdout 50, is kept for one final run.

**Answering questions**

| What was measured | What it means | Original | Branch |
|---|---|---:|---:|
| One-answer questions: attempts right | 44 questions with one correct answer (a count, a name or a list of issues). Each was asked 3 times, so 132 attempts, each marked right or wrong by a program | 115 of 132 (87.1%) | **127 of 132 (96.2%)** |
| Summaries: attempts right | 6 questions of the form "summarise the discussion on issue N". Each was asked 3 times, so 18 attempts, marked by the AI judge | 9 of 18 (50.0%) | **17 of 18 (94.4%)** |
| Questions solved on every attempt | Of all 50 questions, how many were answered right on all 3 attempts. A question answered right only some of the time does not count | 36 of 50 | **46 of 50** |

12 questions improved and 2 got one attempt worse, a split that would happen by luck only about
1 time in 77. The original's mistakes were the kinds section 5.5 fixes. Both versions still
sometimes refuse date questions as "in the future", which is 4 of the branch's 6 wrong attempts.

**Reading the 60 issues into the database**

| What was measured | What it means | Original | Branch |
|---|---|---:|---:|
| Database requests | Individual commands sent to the database during the whole read-in, including saving each issue's analysis | 958 | **345** |
| Database connections | How many times foreman opened a connection to the database | 126 | **8** |
| Database checks passed | After reading in, everything stored (issues, comments, labels, people, reactions and the links between them) is compared with the original issue data in 18 checks | 17 of 18 | **18 of 18** |
| Comment reactions stored correctly | The issues' comments carry 56 emoji reactions (such as 👍), each from one person. This counts how many were stored with the right person, emoji and comment | 35 of 56 | **56 of 56** |

The one failed check is the comment reactions: the original lost 21 of them, counted in a repeat
read-in of the same issues (section 6, item 7).
These are different issues from section 5.2, and the analysis step used a real AI model, so
compare the two versions with each other, not with section 5.2.

*Proof:* `benchmark/qa/rerun/baseline-oh-dev.json` and `branch-oh-dev.json`. How the set was
built: `benchmark/OPENHANDS.md`.

---

## 8. Do the changes carry over to other projects?

**In short:** the database changes do, by design. The assistant fixes are built to apply to any
project. On a project that was not used to build them (OpenHands, section 7) they gave a clear
gain

### The database changes

These change *how* foreman writes, not *what* it writes, so they do not depend on which
project's issues are read in.

- Writing the issues takes at most 9 requests per batch of up to 250 issues, whatever the
  issues contain. The original needed about 6 per issue, plus one more to read each issue back.
- The whole-database tidy-up scans are gone for every project.
- So the saving grows with the number of issues. Measured: 20% fewer requests at 5 issues,
  58% at 20, and 66% at 60. Worked out from how the code works (not measured): for a large
  project the branch makes about 3 requests per issue instead of about 10.
- The database came out identical at all three sizes and with richer data (section 5.1).
- On a database reached over a network, every request has to travel to the database and back,
  so fewer requests should help at least as much there. This was not measured.

### The assistant fixes

What supports them carrying over:

- **They are not tied to SymPy.** The query checker compares each query with foreman's own
  data layout, which is the same for every project foreman reads. The state rule reflects how
  GitHub always stores issue states (`OPEN`, `CLOSED`). The empty-result rule applies to any
  question.
- **The borrowed example did not matter.** The one example taken from the test data was
  replaced with a neutral one, and the result held (149 of 150 on SymPy Core 50).
- **The checker catches more than the mistakes it was built from.** Its tests were written from
  two failing queries in SymPy Core 50. In the fresh test it also warned on failed queries of
  other kinds (counting commenters, counting issue authors, finding the top author), 8 in all,
  including one in SymPy Extended 81.
- **Nothing got worse on new data.** On Hugging Face 50, a different project, the branch kept
  every one-answer attempt right (132 of 132). On SymPy Extended 81, which has 58 questions not
  seen before, the one mistake the original made was fixed (218 → 219 of 219).
- **A clear gain on a new project.** On OpenHands Dev 50, not used to build the fixes, one-answer
  attempts right went from 115 to 127 of 132 (section 7).

What is not yet shown:

- **One model.** All answers came from `gpt-4o`. Foreman's production models may make these
  mistakes less often, so the gain there could be smaller. The sealed OpenHands Holdout 50 has
  not been run yet.

---

## 9. Limits of this evidence

- The reading-in tests use a stand-in for GitHub and the AI model, and a local database.
  The request counts carry over to other setups. The times do not.
- The fetch-several-at-once result uses an artificial delay, not real GitHub.
- The question tests use `gpt-4o`, not the models foreman uses in production. A stronger model
  may make fewer of these mistakes to begin with, so the improvement there could be smaller.
- The improvement comes from several changes together. The query checker evidence shows why
  it works, but not how much each commit contributed.
- The two-step questions have only 4 questions (12 attempts) per version in SymPy Core 50, so
  they are the thinnest part of the evidence.
- Summaries are marked by an AI judge, and in section 5.5 the judge (`gpt-4o`) is the same model
  that answered, so those marks are less certain than the one-answer results.

---

## 10. Where the proof is

| You want to see | Open |
|---|---|
| Every check made on the benchmark and the results, and its outcome | `benchmark/verification.json` |
| Database counts, repeat timings, fetch option, database comparison | `benchmark/profile/repeat-runs.json` |
| Single-run reading-in results for each size | `benchmark/profile/profile-foreman-*.json` |
| The fresh question tests, original vs branch, for each question set | `benchmark/qa/rerun/` |
| The OpenHands test (section 7) and how its questions were built | `benchmark/qa/rerun/*-oh-dev.json`, `benchmark/OPENHANDS.md` |
| The earlier stored question results | `benchmark/qa/` |
| How to read each file and check a number yourself | `benchmark/README.md` |

The test program that produced these files is not part of this pull request, only its
output. Two notes on the stored files:

- The single-run files in `benchmark/profile/` show timings that differ from section 5.3
  because one run varies a lot. Section 5.3 uses medians from repeated runs.
- `profile-foreman-h8-lat-c4-60.json` was recorded on an earlier, uncommitted version of the
  branch. Use `repeat-runs.json` for the fetch option.

---

## Glossary

- **Original / branch:** foreman before these changes (`3cd3dde`) and the code in this pull
  request.
- **Question set:** a fixed list of questions about a fixed collection of 60 GitHub issues.
  There are three in section 5: SymPy Core 50, Hugging Face 50 and SymPy Extended 81. Section 7
  adds OpenHands Dev 50.
- **Attempt:** one try at answering one question. Every question is asked 3 times.
- **Solved on every attempt:** all 3 attempts at a question were right.
- **One-answer question:** a question with a single correct answer (a count, a name, a list of
  issue numbers), checked by a program.
- **Summary:** a question asking for a summary of a discussion, marked by an AI judge.
- **Two-step question:** a question needing two links to be followed, such as "which users
  commented on issues labelled X".
- **Run (reading-in test):** one complete read-in of the issues into an empty database.
- **Median:** the middle value when runs are sorted; it ignores one-off slow or fast runs.
- **Request (statement):** one command sent to the database.
- **Connection (session):** one connection opened to the database.
- **Transaction:** a group of database changes saved together, all or nothing.
- **Uniqueness rule (constraint):** a database rule that stops the same item being stored twice.
- **Lookup shortcut (index):** a database structure that makes searching a field faster.
- **Query:** the command the assistant writes to look something up in the database.
- **Fingerprint:** a short code computed from a file or a database's contents; identical
  content always gives the same fingerprint.
- **Cache:** the model provider reuses text it has already seen, which lowers the cost.

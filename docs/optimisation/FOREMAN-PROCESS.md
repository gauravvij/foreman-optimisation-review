# foreman optimisation — process record

> **What this document is.** The process record of the foreman optimisation: what NEO was
> given, how it set up measurement, what it found, what it changed, how it verified the
> changes, and the results. It documents *how the work was done*.
>
> **What this document is not.** It is not a second narrative and not a replacement for the
> report. Two documents already own those roles:
> - [`FOREMAN-BLOG.md`](FOREMAN-BLOG.md) — the short narrative walkthrough.
> - [`foreman/docs/optimisation/OPTIMISATION.md`](../foreman/docs/optimisation/OPTIMISATION.md)
>   — the authoritative, verified technical report.
>
> Where this document and those disagree, they win. For the claim-to-evidence map see
> [`FOREMAN-PR/EVIDENCE.md`](FOREMAN-PR/EVIDENCE.md).

---

## 0. The task in one paragraph

**foreman** is an assistant that reads a project's GitHub issues into a Neo4j graph, then
answers questions about them ("how many issues are open?", "who commented on the bug
reports?"). NEO was asked to **optimise it in place, prove correctness, and measure the
result with a real graded QA benchmark** — under a hard constraint: **local-only. No push,
no PR, no remote writes.** The frozen baseline was never touched.

The work followed an earlier "champion" campaign on a sibling repo, which supplied a set of
candidate hypotheses (the H-series). Every hypothesis was **measured on foreman itself** —
none was assumed to transfer.

---

## 1. Inputs: what NEO was given

| Given | Detail |
|---|---|
| Target repo | `astropods/foreman` |
| Frozen baseline | `3cd3dde` — a pristine clone at `/tmp/foreman_probe`, `git status` empty. The "before" reference, untouched throughout. |
| Working copy | `/home/azureuser/githubIssue/foreman` — where all changes land |
| Prior campaign | A "champion" repo that had already done a similar optimisation → supplied hypotheses H1–H12 to test |
| Constraints | No push, no PR, no remote writes; do not modify the baseline or `verification_bench/` |
| Definition of done | A working optimisation **plus** the benchmark to measure it **plus** proof the graph is unchanged |

Two setup facts shaped everything downstream:

1. **No Astro gateway credentials exist in the environment.** foreman's production config runs
   Claude via the Astropods gateway; the gateway is OpenAI-compatible, so NEO pointed it at
   `api.openai.com` with `gpt-4o`. Every accuracy number is therefore **foreman-on-gpt-4o**,
   stated openly — not foreman-on-Claude.
2. **foreman hardcodes `https://api.github.com/graphql`.** So NEO built an **in-process fake
   GitHub server** and rewrote `globalThis.fetch` to redirect to it. The SUT is untouched;
   only GitHub latency is synthetic (120 ms fixed).

---

## 2. Step 1 — Build the measurement rig first

This was the first decision, and it matters. You cannot claim an optimisation you cannot
measure, so the harness was built before any code changed.

**a) A statement-level profiler.** NEO instrumented the `neo4j-driver` inside the target tree
to count, per run:

- `neo4j.totalStatements`, `neo4j.sessionsOpened`, `neo4j.managedTransactions`
- `github.requests`, `github.maxConcurrent`
- stage timings, and the **raw `statements[]` array**

Run against the same 60-issue corpus at **n = 5, 20, 60**. This is what allowed the
decomposition of "620 database requests" into *where each one came from*.

**b) A graph-parity gate.** `compare-parity.py` exports the resulting graph and compares it
node-by-node, relationship-by-relationship, property-by-property against the baseline. A
faster write that changes the answer is not an optimisation — this gate makes that claim
testable.

**c) A graded QA benchmark.** A real question-answering harness: fixed question sets, 3
attempts per question, programmatic grading for single-answer questions, an LLM judge for
summaries, and integrity checks (23/23). This is what catches the *silent* wrong answers
that turned out to be the main story.

**d) Correctness gates.** `typecheck` (exit 0), the full unit suite, integration tests against
a real Neo4j, and `lint` (no new errors vs upstream).

Because the rig was built first, the campaign found bugs that reading the code alone would
not have surfaced. Every change below follows the same loop: **measure → change → re-measure.**

---

## 3. Step 2 — Problems found

There are **two families** of problems, and they differ in character.

### Family A — Ingestion inefficiency (the stated task)

Profiling 60 issues showed the baseline performs **620 Neo4j statements across 127 sessions**
for a fairly small corpus. Decomposing the raw statement list:

| Bucket | Count | Cause |
|---|---:|---|
| Per-issue write statements | 372 | 6+ separate round-trips *per issue* |
| Analysis-stage read-back | 60 | reading back a value just written |
| Graph-wide orphan sweep | 60 | scanning the **whole graph** after every issue |
| Clear + set per issue | 120 | two statements where one would do |
| Schema bootstrap | 0 | **there was none at all** |
| Misc | 8 | meta / vocab / etc. |

Four distinct inefficiencies, all visible in the numbers.

### Family B — Silent agent-correctness defects (found by measuring)

This is the more important half, and it was not in the brief.

The trigger was a question that got a **confident wrong answer**: foreman was asked which
issues were open, looked in the graph, found nothing, and said there were none. Nothing
crashed. No error. The query asked for state `open`; the graph stores `OPEN`. **A query that
matches nothing is indistinguishable from a database that contains nothing** — so foreman
reported an absence that was not real.

Once that was visible, the same *shape* of defect turned up in several places:

- **Reversed Cypher traversals** — e.g. `MATCH (c:Comment)<-[:AUTHORED_BY]-(u:User)` runs
  fine, returns nothing, and looks like a valid "no". Every failing two-step question in the
  baseline was one of these.
- **`#1776` silent data loss** — a solution/workaround record with no comment `source` made
  Neo4j *reject the statement* (`Expected parameter(s): text, source`); a per-issue `catch`
  swallowed the throw, and because classification ran *after* the solution loop, the issue's
  classification never landed either. Result: `issues_with_priority` read 59/60, and 2 orphan
  Solution nodes existed that no query could reach.
- **Summaries describing the wrong issue** — `summarize-comments.ts` fetched *only comments*,
  never the issue title/body, so a thread with no subject latched onto whichever sub-thread
  was most concrete. Two semantic tasks scored 0.00 / 0.67 in every prior build.
- **A latent competitor drop** — `ingestCompetitors` had the same unguarded-source defect;
  competitors with an unresolvable source were silently dropped.
- **A grader bug** — `hasNumber` rejected a number that ended a sentence (`"…there are 4."`
  failed because the lookahead was `(?!\d)`).

The main lesson of the campaign came out of this family: **an empty result is not a fact until
the query behind it has been checked.**

---

## 4. Step 3 — The changes

Order matters: **meter first → schema → write path → read path → network → prompt/instructions
→ robustness.**

### 4.1 Ingestion (H-series)

The H-series is the set of candidate fixes carried over from an earlier campaign. Each one was
**re-measured on foreman itself** — none was assumed to transfer. Read each item as:
**the problem → what NEO did → the result.**

| ID | The problem (in plain terms) | What NEO did | File | Result at n=60 |
|---|---|---|---|---|
| **H1** | The graph had **no constraints and no indexes** — nothing stopped duplicate nodes | Create them once, at startup | `neo4j.ts` | **+12** statements — a *cost*, kept for guarantees, not speed |
| **H2** | Writing 60 issues took **372 separate statements** — 6+ round-trips per issue | Batch the whole write set into one transaction | `neo4j.ts` | 372 → **9**; sessions 127→69; ingest 1,818→379 ms |
| **H3** | After **every** issue it scanned the **entire graph** to tidy up orphans | Tidy only the issue that changed | `analysis.ts` | 60 whole-graph scans → **0** |
| **H8** | GitHub data was fetched **one request at a time** | Fetch with a small worker pool (opt-in; default 1) | `github.ts` | **3.98×** faster fetch stage at 4 workers (injected latency) |
| **H9** | Data was **written, then read straight back** — so an edited issue was **never re-analysed** | Hand fetched data forward; snapshot timestamps first | `pipeline.ts` | 269 → **209** statements; sessions 69 → **9** |
| **H10** | When a generated query failed, the model had **no instruction to fix it** | Tell it to correct and retry | `query-neo4j.ts` | no gain claimed — cheap robustness |
| **H12** | The schema said `Issue.state` was a **bare `STRING`** — the model had to guess the values | Document it as `OPEN, CLOSED` | `instructions.ts` | correctness only; a ceiling effect hid any gain |

**H1 — earlier, the database had no schema at all.**
*The problem:* the profiler counted **zero** constraints and **zero** indexes. In plain terms:
nothing in the database stopped two ingestion runs from creating two `Issue` nodes with the same
number, and every lookup had to scan.
*What NEO did:* an idempotent `setupDatabaseSchema()` that creates **10 uniqueness constraints +
2 indexes**, run once per process.
*Result:* it *costs* 12 statements at n=60 — kept anyway, because correctness (no duplicate
`Issue` under concurrent ingestion) and faster lookups matter more than 12 statements.

**H2 — earlier, writing 60 issues took 372 separate database statements.**
*The problem:* 60 issues produced **372 write statements** — 6+ separate round-trips to Neo4j
*per issue*. Every round-trip costs latency, and there were 372 of them for a tiny corpus.
*What NEO did:* send the whole write set in **one transaction** using `UNWIND` (one statement per
row kind), keeping the old per-issue path as a fallback. NEO *proved* the fallback by writing
`verify-fallback.ts`, which **forces the batch to fail** and confirms the chunked path still
writes all 60 issues with a byte-identical graph.
*Result:* 372 writes → **9** statements; sessions 127 → 69; ingest stage 1,818 → 379 ms.

**H3 — earlier, it scanned the whole graph after every single issue.**
*The problem:* 60 of the statements were a graph-wide orphan sweep — scanning the **entire graph**
after **each** issue. That is O(graph) work repeated 60 times, and it grows with the graph.
*What NEO did:* replaced the sweep with an issue-scoped `CALL { WITH i … }` subquery that only
touches the issue that changed.
*Result:* 60 sweeps → **0**; the cost goes from O(graph) to O(issue).

**H8 — earlier, GitHub data was fetched one request at a time.**
*The problem:* fetches ran serially, so the fetch stage dominated wall-clock — each request waited
for the previous one to finish.
*What NEO did:* a bounded worker pool behind `GITHUB_FETCH_CONCURRENCY`, **default 1** (so nothing
changes unless you opt in). The request *count* is unchanged — only how many are in flight — so it
cannot trip rate limits by itself.
*Result:* **3.98×** faster fetch stage at 4 workers *with injected latency*; not proven against
real GitHub rate limits.

**H9 — earlier, data was written and then read straight back — hiding a real bug.**
*The problem:* the pipeline ingested at step 3, then read `Issue.updatedAt` back at step 4. Because
the read followed the write, the comparison was always *new-vs-new* — so **no edited issue was
ever re-analysed**. This was pre-existing (the frozen baseline fails identically), not a
regression the campaign introduced.
*What NEO did:* pass the fetched data straight to analysis instead of re-reading it, and snapshot
previous timestamps *before* ingestion (`getIssueUpdatedAtBatch()`).
*Result:* 269 → **209** statements, sessions 69 → **9**; `verify-incremental.ts` went 7/8 →
**8/8**.

**H10 — earlier, the model had no instruction when its own query broke.**
*The problem:* when a generated Cypher failed, nothing told the model to fix it — it had no path
back to a working query.
*What NEO did:* the tool description now tells the model to correct and retry on a Cypher error.
*Result:* no measured benefit is claimed — this is robustness insurance, kept because it is cheap
and risk-free.

**H12 — earlier, the schema left `Issue.state` as a bare `STRING`.**
*The problem:* the prompt told the model the field existed but not what it contained, so the model
had to **guess** whether the value was `open` or `OPEN`.
*What NEO did:* document `Issue.state` as `OPEN, CLOSED`.
*Result:* correctness only — a ceiling effect on the test set hid any measurable gain.

### 4.2 Agent correctness

These fixes came out of *answering* questions, not out of the ingestion profile. The trigger was
a **confident wrong answer**; once that shape was visible, NEO went looking for it elsewhere. Read
each item the same way: **the problem → what NEO did → the result.**

| ID | The problem (in plain terms) | What NEO did | File | Result |
|---|---|---|---|---|
| **C1** | A **backwards query returned zero rows**, and foreman reported that as **"nothing there"** | Add a schema checker that **warns** on reversed / impossible traversals | `cypher-guard.ts` | 8 of the 11 baseline failures (all 5 two-step) now warn |
| **C2** | The rule told the model to **trust** an empty result | Rewrite it to "check the query first" | `instructions.ts` | pairs with C1 — warn, then act |
| **C3** | Some issues **silently lost their data** — no error, wrong counts | Make the statements issue-scoped; default `source` to `''`; guard malformed rows | `analysis.ts` | param errors 1→**0**; orphans 2→**0**; 59→**60** |
| **C4** | Two summary questions scored **0.00 / 0.67 in every build** | Fetch the issue title/body, not just the comments | `summarize-comments.ts` | 0.00→**1.00**, 0.67→**1.00** |
| **C5** | Competitors with **no source were silently dropped** | Guard the comment hop (same pattern as C3) | `analysis.ts` | latent drop closed |
| **C6** | Three failure classes traced back to **vague rules** | Add the category enum, label casing, arrow direction | `instructions.ts` | observed, not guessed |
| **C7** | The prompt **duplicated rules** it already contained | Drop the duplicate column + restated prose | `instructions.ts` | 29,781→**27,535** chars (−7.5%) |

---

**C1 — earlier, foreman gave confident wrong answers when a query was written backwards.**
*The problem:* the baseline failed **11** one-answer attempts. **8** of them — including **all 5**
two-step questions — failed the same way. Concretely, foreman was asked *who commented on the bug
reports* and wrote a query like:

```cypher
MATCH (u:User)-[:AUTHORED_BY]->(i:Issue)   // ← arrow points the wrong way
RETURN u.login, i.number
```

The rows exist, but the query traverses the relationship in the reverse direction, so it matches
**nothing**. Cypher does not treat that as an error — it returns zero rows, and foreman reported
that as "no one commented". From the row count alone, *"the query is wrong"* and *"the data is
absent"* look identical.

*What NEO did:* a checker that reads each generated query, compares the relationship it traverses
against foreman's real data layout (a literal list of the **21** declared relationships), and
**attaches a warning** when a traversal is reversed or impossible. It **never rewrites the query
or changes rows** — it only tells the model what looks wrong. For the query above it emits:

> Cypher traversal `(u:User)-[:AUTHORED_BY]->(i:Issue)` runs against the arrow: it asserts
> `(u:User)-[:AUTHORED_BY]->(i:Issue)`, but the schema has `(Issue)-[:AUTHORED_BY]->(User)`.
> A reversed arrow is not a syntax error — it silently returns zero rows, which looks exactly
> like the data being absent.

The schema list it checks against is a literal in the file:

```ts
// agent/tools/cypher-guard.ts
export const SCHEMA_EDGES: readonly SchemaEdge[] = [
  { from: 'Issue',   rel: 'HAS_COMMENT', to: 'Comment' },
  { from: 'Issue',   rel: 'AUTHORED_BY', to: 'User' },
  { from: 'Comment', rel: 'AUTHORED_BY', to: 'User' },
  { from: 'Issue',   rel: 'HAS_LABEL',   to: 'Label' },
  …
];
```

*Result:* the 8 reversed-arrow failures now carry a warning the model sees *before* it answers.
A unit test asserts this list still matches the prompt, so the two cannot drift apart.

**C2 — earlier, the instructions told the model to trust an empty result.**
*The problem:* the old rule said "report an empty result honestly" — which told the model to
*accept* a zero-row answer. That is exactly the C1 failure: it made "nothing there" the safe thing
to say, so a wrong query produced a confident wrong answer.
*What NEO did:* replaced it with a rule that treats an empty result as a **signal to check**:

```
// agent/instructions.ts
- If a query returns no results, treat that as a signal to check the query before
  concluding the data is absent. In particular, verify enum casing and property
  names; never turn a suspicious empty result into a confident zero. A malformed
  query and a genuinely empty answer look identical from the row count alone, so
  re-read your Cypher against the schema below and retry before you answer.
```

*Result:* the checker surfaces the warning and the instruction tells the model to act on it — the
two work as a pair.

**C3 — earlier, some issues silently lost their data (runtime-only, commit `1d0b8c1`).**
*The problem:* `issues_with_priority` read **59/60**, and **2 orphan `Solution` nodes** existed that
no query could reach. The cause was a record with no comment `source`: the query then sent
`source: undefined`, Neo4j **rejected the statement** (`Expected parameter(s): text, source`), and a
per-issue `catch` swallowed the throw. Because classification ran *after* the solution loop, the
issue's classification never landed either — so the issue lost its data **and** its classification,
with **no error surfaced**.

*What NEO did:* three changes. (a) The comment hop became best-effort instead of a hard `MATCH`
that drops the whole row when it misses:

```cypher
-- before: a missing source matched nothing and killed the row
OPTIONAL MATCH (c:Comment {commentId: $source})
-- after: guard the hop, and only link when a comment was actually found
OPTIONAL MATCH (c:Comment {commentId: $source})
WHERE $source <> ''
FOREACH (_ IN CASE WHEN c IS NULL THEN [] ELSE [1] END |
  MERGE (c)-[:HAS_SOLUTION]->(s)
)
```

(b) `source` now defaults to `''` instead of `undefined` (`source: solution.source ?? ''`).
(c) malformed records are skipped *before* Cypher by a guard:

```ts
// src/services/analysis.ts
function usableText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
```

The extraction prompt stayed **byte-identical**, so this cannot move QA scores for prompt reasons.
*Result:* `Expected parameter(s)` 1→**0**, orphaned nodes 2→**0**, `issues_with_priority`
59→**60**.

**C4 — earlier, two summary questions scored 0.00 and 0.67 in every build.**
*The problem:* the summariser fetched *only comments* and never the issue's own title/body. A
comment thread read on its own has no subject, so the model latched onto whichever sub-thread was
most concrete. The file records the exact case: a summary of **#5111** ("map and filter not working
properly in multiprocessing") came back describing a `copenlu/answerable_tydiqa` repro snippet from
one comment, instead of the reported bug.
*What NEO did:* fetch the issue title and body alongside the comments and anchor the prompt on them:

```cypher
// agent/tools/summarize-comments.ts
MATCH (i:Issue {number: $n})
OPTIONAL MATCH (i)-[:HAS_COMMENT]->(c:Comment)
OPTIONAL MATCH (c)-[:AUTHORED_BY]->(u:User)
RETURN i.title    AS issueTitle,     // ← the anchor that was missing
       i.bodyText AS issueBody,
       c.bodyText AS text, c.createdAt AS date, u.login AS author
```

*Result:* `dev-038` 0.00→**1.00**, `dev-040` 0.67→**1.00**.

**C5 — earlier, competitors with a missing source were silently dropped.**
*The problem:* `ingestCompetitors` had the same unguarded-`source` defect as C3. A competitor the
model reported without a comment source matched nothing on the Comment hop, and the whole row
vanished from the count — with no Comment edge written and no error raised.
*What NEO did:* made the Comment hop best-effort, exactly as in C3:

```cypher
// src/services/analysis.ts
OPTIONAL MATCH (cmt:Comment {commentId: comp.source})
WHERE comp.source IS NOT NULL AND comp.source <> ''
FOREACH (_ IN CASE WHEN cmt IS NULL THEN [] ELSE [1] END |
  MERGE (cmt)-[:MENTIONS_COMPETITOR]->(c)
)
```

*Result:* closed as a correctness fix — a latent drop, not a headline number.

**C6 — earlier, three failure classes traced back to vague rules.**
*The problem:* three failures kept showing up — an out-of-range `Issue.category`, `Label.name`
casing mismatches, and wrong-direction `AUTHORED_BY` traversals. None was the model's fault; each
traced back to an under-specified instruction. For example the prompt never said what values
`category` could take, so the model invented them.
*What NEO did:* made the three rules explicit:

```
// agent/instructions.ts
- Issue.category is one of: frontend, backend, cli, infra, docs, security,
  observability, tooling, other.
- Free-text values are stored exactly as GitHub spells them … Match free text
  case-insensitively, e.g. WHERE toLower(l.name) = toLower($name).
- Write the arrow exactly as the list gives it: (Issue)-[:AUTHORED_BY]->(User) …
  never (User)-[:AUTHORED_BY]->(Issue).
```

*Result:* each targets a failure that was **observed, not guessed**.

**C7 — earlier, the prompt duplicated rules it already contained.**
*The problem:* the prompt carried a duplicated "Ask like this" example column and prose that
restated rules already in `# Important rules` — wasted tokens that added no instruction.
*What NEO did:* dropped the duplicate column and the restated prose; the static block went **29,781
→ 27,535 chars (−7.5%)**, with `# Important rules` and `# Database Schema` **byte-identical**.
*Result:* a smaller prompt with no rule removed.

### 4.3 Latency (separate opt-in branch)

Trace analysis (`LATENCY-RESEARCH.md`) found an answering turn is **~98% model-call
wall-clock**, tools + Neo4j <1%, and the tail is the *variance of a single model call ×
sequential round-trips*. Real `gpt-4o` calls: p50 ≈ 1.3 s, max ≈ 9.4 s (7.2× ratio). On
`perf/agent-latency-bound`, NEO lowered the default single-call ceiling **60 s → 15 s**
(`MODEL_TIMEOUT_MS`) — a **tail cap**, not a throughput knob.

---

## 5. Step 4 — Verification

Every change was validated by four independent mechanisms:

1. **Graph parity** — MATCH at n=5, 20, 60 (identical node/edge/property fingerprints),
   repeated on the final code.
2. **Correctness gates** — typecheck exit 0, unit suite green, integration 13/13 against real
   Neo4j, no new lint errors.
3. **Before/after measurement** — repeated-run medians for timing (the slowest branch run beat
   the fastest baseline run at every size).
4. **Independent verification** — the benchmark itself was audited: every expected answer
   re-derived from raw data (**161/161 match**), question files unaltered, every stored
   verdict re-marked, every score recomputed, each report tied to the code it tested.
   `check-numbers.ts` re-checks every reported number against stored proof files (**117/117**).

Plus a **no-op confirmation arm (v5)**: same code, fresh run, 98.67% → 98.67%. This is the
cheapest way to show the result reproduces.

---

## 6. Step 5 — Results

### Improved

**Ingestion, 60 issues:**

| | Before | After |
|---|---:|---:|
| Database requests | 620 | **209 (−66%)** |
| Database connections | 127 | **9 (−93%)** |
| Whole-graph tidy-up scans | 60 | **0** |
| Time (median of 5) | 2.8 s | **0.8 s** |
| Graph produced | | **identical** |

**Accuracy (gpt-4o harness):**

| Question set | Before | After |
|---|---:|---:|
| SymPy Core 50 (the set fixes were built against) | 91.3% | **100%** |
| Hugging Face 50 (different project) | 98.7% | **100%** |
| SymPy Extended 81 | 98.4% | **99.6%** |
| OpenHands 600 (600 issues, project not used to build fixes) | 84.4% | **95.6%** |

### Not claimed

These keep the results honest, and each is backed by the report:

- **Cost did NOT fall — it rose 5–7% per attempt**, because the prompt got slightly longer. An
  early internal figure of **"41% cheaper" was a metering artifact** (the original was
  measured before the meter could see cached tokens), and it was **removed** from the report.
- **Response time did not change consistently** — median and mean move a few percent either way.
- **Parallel fetch is opt-in** and its speedup follows from the injected-latency setup; it is
  not proven against real GitHub rate limits.
- **`dev-018` is a grader artifact**, not a behaviour change (the baseline spelled "Four" once
  where the grader wants a digit).
- **The `lewtun-holdout` 100% is a *corpus* holdout, not a *task-shape* holdout** — same repo,
  17/18 templates shared with `dev`. It is presented as such.
- The latency A/B **did not exercise the bound** (0 timeouts fired, slowest attempt
  14,835 ms < 15,000 ms), so **no latency win is claimed** — the tail delta is run-to-run
  variance.

---

## 7. Step 6 — The final package

- **`pr/foreman-optimisation`** (foreman repo) — the 12 code commits + 1 `docs(benchmark)`
  evidence commit, so a maintainer can review the code **and** the stored benchmark reports it
  was measured against without leaving the PR. `PR-SPLIT.md` recommends **four stacked PRs**
  rather than one, because H9 is a bug fix that deserves review on its own.
- **`perf/agent-latency-bound`** — the optional 15 s cap, one commit on top, **not** bundled
  into the PR.
- **Bundles** — `foreman-pr.bundle` (2 refs) and `outer.bundle` (1 ref), both
  `git bundle verify` = *okay*, refs matching live `rev-parse`.
- **Status: local-only.** Push returned `403 Write access not granted`; forking is disabled on
  the repo. Nothing was ever written to `astropods/foreman`.

---

## 8. Lessons

1. **An empty result is not "nothing there".** A query that runs can still be wrong, and a row
   count cannot tell the difference. The checker catches this at query time, before the answer
   is given.
2. **The simple changes held up best.** Batch the writes, tidy only what changed, hand data
   forward instead of re-reading it. None of these are complex changes, and all of them
   improved the numbers without changing a single answer.
3. **Check a good-looking number before using it.** The 41% saving belonged to the cache, not
   the code. Re-running both versions under the same meter showed this, and the report is
   stronger for it.

---

## 9. Where the artifacts live

| Document | Read it for |
|---|---|
| [`FOREMAN-BLOG.md`](FOREMAN-BLOG.md) | The short narrative walkthrough |
| [`foreman/docs/optimisation/OPTIMISATION.md`](../foreman/docs/optimisation/OPTIMISATION.md) | The authoritative report: method, every result with its proof file, behaviour changes, checks and limits |
| [`FOREMAN-PR/EVIDENCE.md`](FOREMAN-PR/EVIDENCE.md) | Every claim mapped to the report file it comes from, and how it was checked |
| [`FOREMAN-PR/PR-DESCRIPTION.md`](FOREMAN-PR/PR-DESCRIPTION.md) | Ready-to-paste PR title and body |
| [`FOREMAN-PR/PR-SPLIT.md`](FOREMAN-PR/PR-SPLIT.md) | How to split the branch into four stacked PRs |
| [`FOREMAN-PR/LATENCY-CHANGE.md`](FOREMAN-PR/LATENCY-CHANGE.md) | The opt-in latency tail cap, with its honest reading |
| [`FOREMAN-PR/PUSH-READY.md`](FOREMAN-PR/PUSH-READY.md) | Why nothing was pushed, and the exact steps to push when access is granted |

> **Point-in-time note.** The package documents describe the branch at **13 commits
> (`258000c`)**; the live `pr/foreman-optimisation` tip has since moved to **`c49318c`**, and
> `perf/agent-latency-bound` sits at `f38d52d`. Where a document quotes commit counts or SHAs,
> treat it as a snapshot and confirm against live `git rev-parse`.

---

*Prepared by NEO. Local-only. No remote write was performed at any point.*

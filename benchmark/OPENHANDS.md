# OpenHands question sets: a fresh, independent benchmark for foreman

**Status (2026-11-05):** the question sets are built, frozen, audited and pinned, and foreman
ingests them correctly. **Foreman has not been scored on them yet.** No number in this file is a
score.

Verification on this branch also ran the dev corpus through the current foreman pipeline with a
mock model and a disposable Neo4j container. The graph matched the corpus on issues (60),
comments (237), labels (24), users (73), and reactions (68). All 18 required graph integrity
checks passed, including exact issue fields, label memberships, comment fields and authors, and
both kinds of reaction links. No comparison run or score was produced; the profile lives under
`/tmp`, outside foreman.

## The question this answers

Every foreman QA result so far comes from SymPy and Hugging Face `datasets` issues. The fixes in
this branch were developed against SymPy Core 50. A result on those sets cannot rule out
that the branch fits those projects in particular. We need a set from a project that nobody tuned
against, whose labels come in a form the earlier sets did not have.

**OpenHands/OpenHands** fits:
- No earlier campaign touched it, and it is not in SWE-bench.
- At build time it had 603 open and about 4,900 closed issues.
- Its labels come in shapes the other sets lack: prefixed (`<group>:<value>`) and mixed-case.
  Real label names are left out of this file on purpose, because the sealed holdout asks about them.

## The two sets

| Plain name | File name | Issues | Questions | Role |
|---|---|---:|---:|---|
| **OpenHands Dev 50** | `oh-dev` | 60 (built 40% open, 60% closed) | 50 | Measure and develop against |
| **OpenHands Holdout 50** | `oh-holdout` | 60 (built 40% open, 60% closed) | 50 | **Sealed.** Score it once, only on a final candidate |

The two sets share no issue.

Terms used here:
- **Question set:** a fixed list of questions about one set of issues. Each question comes with an expected answer worked out from the issue data, not written by a model.
- **Attempt:** one try at one question. Runs normally use 3 attempts per question.
- **One-answer question:** marked by a program. It compares a number, a set of issue numbers,
  or required words in the answer against the expected answer. Each set has 44.
- **Summary question:** marked by a fixed AI judge (`gpt-4o`) against a rubric. Each set has 6.
- **Stratum:** the kind of question. Each set has exactly the counts below:

| Stratum | Questions | What it asks |
|---|---:|---|
| `canary` | 2 | Total issues and total comments. If either fails, check the graph before believing anything |
| `enum_state` | 7 | Open and closed counts, alone or combined with a label |
| `label` | 5 | Label counts and members, including one label asked for in a different casing from how it is stored |
| `author` | 4 | Who opened issues, and how many each person opened |
| `date_range` | 5 | Counts before, after or between dates (UTC). Each boundary falls on a day with no issue, so "before" and "on or before" agree |
| `aggregation` | 5 | Most comments, most reactions, issues with no comments, and similar. A "most" question is only asked when there is no tie |
| `text_search` | 3 | Titles, and which issues mention a term in their **title or body** |
| `multi_hop` | 4 | Two-step questions, e.g. who commented on issues with label X |
| `true_zero` | 5 | Questions whose correct answer really is zero |
| `paraphrase` | 4 | The same question in different wording |
| `semantic` | 6 | Summarise an issue's discussion (the judge marks these) |

## Where the files are

The files are in the workspace around this repo, **not in the foreman repository**:

| What | Path (from the workspace root) |
|---|---|
| Issue data, frozen | `verification_bench/corpus/oh-{dev,holdout}.json` |
| Questions, frozen | `verification_bench/tasks/oh-{dev,holdout}.jsonl` |
| SHA-256 pins for the four files above | `verification_bench/SPLITS.sha256` |
| Byte-identical copies the foreman runner reads | `bench/corpus/oh-*.json`, `bench/tasks/oh-*.source.jsonl` |
| Questions converted for the foreman runner | `bench/tasks/oh-*.jsonl` |
| SHA-256 pins for the six `bench/` files | `bench/foreman-qa/OPENHANDS.sha256` |
| Audit script | `bench/foreman-qa/audit-openhands.py` |
| Full build notes | `verification_bench/BENCH-V2.md`, section "OpenHands" |

## How the sets were built

1. **Closed issues (36 per set).** These are issues GitHub records as closed as `COMPLETED` by a
   **merged pull request in the same repository**. They are sampled with a fixed seed across the
   repo's whole history.
   - Closures by the stale bot, "not planned" closures, and PRs from forks or other repos are left out.
   - Each linked PR's changed files are kept, so what foreman extracts can later be checked against
     what the fix actually touched.
   - The builder is `verification_bench/scripts/build-corpus-v2.ts --linked prs`. Holdout is built
     with `--exclude oh-dev`.
2. **Open issues (24 per set).** These are sampled with the same seeded shuffle across all open issues.
3. **Questions.** `verification_bench/scripts/build-tasks-v2.ts --split <set>` generates them.
4. **Conversion for foreman.** `bun bench/foreman-qa/adapt-tasks.ts --split <set> --verify`
   changes only the `template` and `kind` fields. It checks that no question, marking rule or
   expected answer moved.

Rebuilding today would pick different issues, because the live repository changes over time. The pinned
files are the dataset.

## What was checked

| Check | Result |
|---|---|
| The four frozen files match their SHA-256 pins, and the 16 earlier pins are unchanged | 20 of 20 |
| The six `bench/` files match their pins | 6 of 6 |
| Every expected answer recomputed from an ingested graph with separately written queries (`verify-oracles-v2.ts`) | 53 of 53 checks per set |
| **Every** issue compared with live GitHub through the REST API (a separate path from the GraphQL builder), on title, state, author, labels, comment count, reaction count, creation date and empty body | 120 of 120 exact. So nothing was cut off at a fetch limit |
| Foreman ingests each set with a mock model (`bench/foreman-profile/run.ts`). Graph compared with the issue data | Issue, comment and label counts exact on both sets |
| Linked PRs whose file list is empty | 0 |
| `audit-openhands.py` (details below) | 0 problems |
| Foreman source (`agent/`, `src/`, `ingestion/`, tests) searched for OpenHands repo, label and login strings | None found |
| End-to-end demo of the real runner on this branch: OpenHands Dev 50, first 7 questions, 1 attempt each, real models. It covered number, issue-list and required-word questions, but not the judge. Its report, its graph and the profiling graph were then deleted, and the workspace was confirmed unchanged | Integrity checks all pass; 7 of 7 correct, each answer read by hand; $0.24 in total |
| Exact graph check on the current branch, with a mock model and disposable Neo4j | 18 of 18 required checks pass. It found and prompted a fix for repeated reactions by one user on different comments. No question was scored. |
| Four-question real-run smoke check on the current branch (`oh-dev-001`, `007`, `032`, `045`; one attempt each) | All 18 graph checks passed; 4 of 4 answers passed, with no agent errors. The questions covered a canary, an issue list, a two-step commenter query and an AI-judged summary. Ingest, QA and judge cost about $0.16 combined. The job directory, log and isolated Neo4j container were deleted after inspection. **This is a smoke check, not a score for either 50-question set.** |

`audit-openhands.py` checks each set's integrity:
- 60 unique issues, and comment counts that agree with the comment lists;
- no list at a fetch cap;
- no two labels whose names collide when case is ignored;
- every closed issue has a linked PR.

It checks for leakage:
- no shared issues, titles or bodies between dev and holdout.

And it checks each question:
- true-zero labels, authors and terms really are absent;
- term-search answers equal a case-insensitive substring search over title and body;
- no date boundary has an issue on that UTC day;
- each title question's words appear in that title;
- every judge question has a reference and a rubric;
- the `bench/` copies and the converted rows equal the frozen originals.

The graph integrity suite also tests an incremental reaction update: after the same user reacts
to two comments, adding an issue-level reaction with the same content must retain all three
links. The batch ingest test and the four-question smoke run pass on the current branch.

## Known properties: read before quoting a score

These are not defects. They do change what a score means.

1. **10 holdout questions are identical to a dev question, in wording and in answer.** They are
   holdout `001, 003, 004, 006, 011, 036, 037, 039, 041, 042`.
   - Five follow from the shared build shape: total issues, open, closed, and the two closed-count paraphrases.
   - Three come from the shared pool of absent labels and authors.
   - Two are coincidences: the same label count and open-label count.

   They are not independent evidence. Report the holdout on all 50 questions **and** on the other
   40, so anyone can see whether those 10 move the result.
2. **Dates are UTC.** One holdout boundary has an issue 0.6 hours from it. The answer is unambiguous in
   UTC, which is how the graph stores dates. An agent that converted timezones could get it wrong.
3. **Term search is scoped to title and body.** In one holdout question, the term also appears only in
   the comments of three issues. An agent that also searches comments will list too many issues and fail. The question
   says "in their title or body", so that failure is a real error.
4. **Term search matches substrings, case-insensitively.** For both sets' term questions, whole-word and
   substring matching give the same answer, so this does not change any expected answer.
5. **One holdout issue's text cites a dev issue number.** That number is not in the holdout graph. It
   gives no answer away.
6. **The foreman task adapter calls every one-answer question `structural`.** The source has some
   `retrieval` kinds, but the adapter preserves their `stratum` as `template`. Use the per-stratum
   and deterministic figures for these sets; `score.byKind.retrieval` has no tasks.
7. **The judge is the same model as the agent.** Both default to `gpt-4o`
   (`--reasoning-model` and `--judge-model` in `bench/foreman-qa/run.ts`), so the model marks summaries
   written by itself. Three things limit how much that matters, and one does not:
   - **What the judge sees.** It is given the question, a reference built from the raw issue (title, state, author, comment
     count, the first 6,000 characters of the body, and the first 1,200 characters of each comment), a
     fixed rubric and the answer. The call uses temperature 0 and a strict JSON verdict.
   - **What it is asked.** The rubric is deliberately narrow: pass if the answer is about the same issue, contradicts none of
     title, state, author or comment count, and is not a refusal. Completeness and style are not
     marked. So the judge mainly catches the wrong issue or wrong facts, where preferring its own
     writing has little room to act.
   - **Where it lives.** The reference sits only in the question file's `check`. The agent never sees it.
   - **What remains: noise and a small sample.** There are 6 judged questions per set, so one question moves the semantic
     score by 16.7 points. On byte-identical code, judged scores have moved by 20 points
     (`VERIFICATION.md`, around line 113). Treat the 44 one-answer questions as the primary
     result and the 6 summaries as a guardrail.

   **Pin the versions.** `gpt-4o` is an alias that OpenAI can repoint. Every earlier foreman report in
   `qa/` resolved it to `gpt-4o-2024-08-06`, and the cost meter prices that snapshot the same as the
   alias. The commands below therefore pin it for both the agent and the judge. This keeps the baseline and the branch on the same models even if the alias moves between the two runs.

## How to continue

Run these from the workspace root. Docker is required (the runner starts Neo4j), and an OpenAI key is required.

```bash
# 0. Confirm the files are the pinned ones, and re-run the audit (free)
(cd bench && sha256sum -c foreman-qa/OPENHANDS.sha256)
python3 -I bench/foreman-qa/audit-openhands.py .

# 1. Score this branch on OpenHands Dev 50 (about $4-5 at 3 attempts: the demo under "What was checked" cost $0.028 per answer)
PIN="--reasoning-model gpt-4o-2024-08-06 --judge-model gpt-4o-2024-08-06"
bun bench/foreman-qa/run.ts --target "$PWD/foreman" --split oh-dev --job foreman-oh-dev --attempts 3 $PIN

# 2. Same for the baseline commit, for a paired comparison
git -C foreman worktree add /tmp/foreman-baseline <baseline-commit>
bun bench/foreman-qa/run.ts --target /tmp/foreman-baseline --split oh-dev --job foreman-baseline-oh-dev --attempts 3 $PIN
```

**Re-grade before quoting a score.** The runner uses `bench/harness/grade.ts`. Its current version
accepts stated zero counts and spelled-out counts, but still accepts an empty response to a
true-zero issue-set question. `verification_bench/grade-v2.ts` rejects that non-answer. Re-grade
both reports against the same frozen split and quote the corrected figures:

```bash
bun bench/foreman-qa/regrade-fresh.ts --split oh-dev --job foreman-oh-dev --job foreman-baseline-oh-dev
```

The regrader rejects incomplete reports or the wrong split, preserves each raw `report.json`,
and refuses to replace an existing re-graded report unless passed `--overwrite`. The runner checks
all six OpenHands file pins before spending, then marks a run invalid if any required graph
integrity check or canary fails. Its integrity checks compare issue fields, label memberships,
and comment fields and authors, as well as counts.

**Keep the holdout sealed.**
- Do not open `oh-holdout` questions or answers while changing foreman.
- Do not add OpenHands label names, logins or issue numbers to foreman's prompts or code.
- Re-running the source search from "What was checked" before scoring the holdout should still find nothing.

**Open next steps**
- [x] Add `--split` to `regrade-fresh.ts` and check report completeness before re-grading.
- [ ] Score the baseline and the branch on OpenHands Dev 50, then re-grade both.
- [ ] Only once a final candidate is chosen: score OpenHands Holdout 50 once, and report it on all 50 and on the 40 independent questions.

## Can this benchmark live inside foreman?

**The question sets can; the harness should not, at least not in this PR.**

- **Data only (about 1.3 MB) could move into `benchmark/openhands/`.** It is self-contained:
  issue JSON, question JSONL and their SHA-256 pins. Anyone with this repo could then read the
  exact questions behind an OpenHands score.
- **The harness is about 2,200 lines outside this repo:**
  - the foreman runner (`bench/foreman-qa/run.ts`, `integrity.ts`);
  - the fake GitHub server, cost meter, Neo4j lifecycle and grader (`bench/harness/*`);
  - the corrected grader (`verification_bench/grade-v2.ts`);
  - the re-grade script.

  This PR's `benchmark/README.md` already states that the harness is not part of the PR. Bringing it in would multiply the PR's size with code
  reviewers did not ask for.
- **If foreman should own its benchmark, the natural home is a fourth project in `vitest.config.ts`.**
  `vitest.config.ts` already has `unit`, `integration` and `evals` projects, and foreman already
  depends on `@testcontainers/neo4j`. That could replace the runner's own Docker handling. This is
  a separate, later PR.

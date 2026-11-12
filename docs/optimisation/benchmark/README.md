# Benchmark evidence

This folder holds the stored reports behind the numbers in [`../OPTIMISATION.md`](../OPTIMISATION.md).
Read that document first: it explains what changed, what each number means, and where the
results are weak. This file only says which report supports which claim and how to read it.

The benchmark harness is **not** part of this PR. Only its outputs are, so every figure can be
checked without leaving the branch.

The OpenHands question sets, built from OpenHands/OpenHands issues, are described in
[`OPENHANDS.md`](OPENHANDS.md). OPTIMISATION.md section 7 reports one of them, OpenHands 600,
over three runs.

## What each report shows

### `profile/`: ingestion runs

Produced by a profiler that wraps the Neo4j driver, against a local Neo4j with a mock GitHub
server (60 real `huggingface/datasets` issues) and a mock model.

| File | What it is |
|---|---|
| `repeat-runs.json` | **The figures quoted in OPTIMISATION.md sections 5.1 to 5.4 and 6.** Sections: `database_work_counts` (requests and connections, identical in every repeat), `timing` (5 runs per setup, medians and per-step times), `branch_first_run_on_new_database`, `fetch_with_120ms_added_per_request_60_issues`, and `database_comparison` (fingerprints of the database contents, and the behaviour-change tests). |
| `profile-foreman-baseline-{5,20,60}.json` | Single baseline runs at 5, 20 and 60 issues. Source of the statement and session counts. |
| `profile-foreman-optimised-{5,20,60}.json` | Single runs of the branch at the same sizes, recorded on an earlier commit (`758a06d`) from before the history was tidied and before the reaction fix; that commit is not in this branch. Their request and connection counts equal `repeat-runs.json`, and the final code gives the same counts (209 requests and 9 connections at 60 issues). |
| `profile-foreman-baseline-60-lat-c1.json` | Baseline with 120 ms added per request. |
| `profile-foreman-h8-lat-c4-60.json` | Parallel fetch with 120 ms added. **Recorded on an earlier, uncommitted version of the branch**, so it still shows a read-back the final code removes. Use `repeat-runs.json` instead. |

How to read the single-run files: `neo4j.totalStatements`, `neo4j.sessionsOpened`,
`neo4j.managedTransactions` and `neo4j.orphanSweeps` are exact and repeatable. `wallMs` is **not**:
the same configuration varied by up to a factor of two between runs, which is why OPTIMISATION.md
(section 5.3) uses medians from `repeat-runs.json`.

`graphAfterRun` in each single-run file is only a count of nodes per label. The stronger
comparison (every node, relationship and property, fingerprinted) is under `database_comparison` in
`repeat-runs.json`.

### `qa/`: scored agent runs

Produced by a harness that asks the agent questions with known answers and marks each answer.
Two terms: a **question set** is a fixed list of questions about a fixed set of GitHub issues
(60, or 600 for OpenHands 600), and an **attempt** is one try at one question. Every question is
asked 3 times, so each question has 3 attempts; `v8` and each OpenHands 600 run ask each question once.
The agent model is `gpt-4o`, so these are **not** results for the models foreman uses in
production. The judge for summary questions is `gpt-4o` too, except in the OpenHands reports,
which used `claude-haiku-5.5`.

| File | What it is |
|---|---|
| `qa/foreman-fresh-baseline/report.json` | The original baseline run. Raw score 86.67%. |
| `qa/foreman-fresh-baseline/report.regraded.json` | The same answers re-graded with the corrected grader (spelled-out numbers, stated absences). Score 91.33%. This is the baseline figure used. |
| `qa/foreman-fresh-v6`, `v7`, `v8` | Earlier arms of the branch, three attempts (v8: one attempt). v7 and v8 score 100% on `sympy2-dev`. |
| `qa/GUARD-V7-VS-V6.md` | Comparison of the Cypher guard arm against the arm before it, with its statistical caveats. |

`v6`, `v7`, `v8` and `GUARD-V7-VS-V6.md` come from the working history before it was tidied into
this branch's commits, so the commits they name (`14166da`, `29f7c1b`) are not in this branch.
`v8` has the same code fingerprint as `258000c`. OPTIMISATION.md cites these only as earlier
results that agree; its numbers come from `qa/rerun/`.
| `qa/rerun/baseline-<set>.json`, `qa/rerun/branch-<set>.json` | **Fresh re-run** of baseline and branch, same harness, same grader, same cost meter. The three sets below are the source of OPTIMISATION.md section 5.5; `oh-600-run1` to `run3` are the source of section 7. |
| `qa/rerun/branch-neutral-example-sympy2-dev.json` | The final branch code (after the prompt's borrowed label example was replaced by a neutral one), SymPy Core 50: 149 of 150 attempts right. |

Sets (plain names used in OPTIMISATION.md, with the file names used here): **SymPy Core 50**
(`sympy2-dev`, 50 questions, the set the fixes were developed against), **Hugging Face 50**
(`lewtun-holdout`, 50 questions about a different project, not tuned against) and
**SymPy Extended 81** (`sympy2-dev-81`, 81 questions about the same SymPy issues, 23 of which
repeat SymPy Core 50 questions). Section 7 adds **OpenHands 600** (`oh-600`, 150 questions about
600 issues, one attempt per question), run three times: `qa/rerun/baseline-oh-600-run{1,2,3}.json`
and `qa/rerun/branch-oh-600-run{1,2,3}.json`. See `OPENHANDS.md`.

The OpenHands reports record the original's failed reaction check (`comment_reactions_match`)
only as "content differs": the original merges a reaction into an earlier one by the same person
with the same emoji on the same issue. The test in `test/integration/cypher.test.ts` shows the
same merge on a real database.

Each question set has one-answer questions (checked by a program) and summaries (marked by an
AI judge): SymPy Core 50 has 44 and 6, Hugging Face 50 has 44 and 6, SymPy Extended 81 has 73 and 8,
OpenHands 600 has 140 and 10.

Useful fields in each report: `score.overall`, `score.solvedAllAttempts`, `qa.tasks[].attempts[]`
(`pass`, `answer`, `reason`, `ms`, `toolCalls`), `cost.qaUsd`, `qa.openai.cacheHitRate`, and
`sut`: `hash` is a fingerprint of the code that was tested, `head` the commit checked out, and
`dirty` whether there were uncommitted edits. When `dirty` is true, the fingerprint is what ties
the report to a commit (see `verification.json`).

### `verification.json`: the independent check

The record of the checks listed in OPTIMISATION.md section 7: the question files are unaltered,
every expected answer re-derived from the raw issue data, every stored verdict re-marked, every
score recomputed, each report tied to the code it tested, and the code checks. Each entry gives
the result and what was checked.

## Things to know before quoting a number

- **Cost.** Only the `qa/rerun` reports measure the baseline and the branch with the same
  cache-aware cost meter. The original baseline report predates that meter, so its cost is not
  comparable with the later arms.
- **The original baseline was scored by two graders.** The raw 86.67% and the corrected 91.33%
  are the same answers. Use the corrected one and say so.
- **Timing is a local database.** The statement and session counts carry over to other
  deployments. The milliseconds do not.
- **Parallel fetch** was measured with a fixed delay added to every request. It shows that the
  pool works, not what real GitHub will do.

## Checking a figure yourself

`bun docs/optimisation/benchmark/check-numbers.ts` (from the repository root) re-checks every
headline number in OPTIMISATION.md against these files and exits 1 if one differs. To check one
figure by hand, from this folder:

```
# exact and repeatable
python3 -c "import json;d=json.load(open('profile/profile-foreman-baseline-60.json'));print(d['neo4j']['totalStatements'])"   # 620
python3 -c "import json;d=json.load(open('profile/profile-foreman-optimised-60.json'));print(d['neo4j']['totalStatements'])"  # 209

# accuracy: share of attempts graded correct
python3 - <<'EOF'
import json
r = json.load(open('qa/rerun/branch-sympy2-dev.json'))
a = [x['pass'] for t in r['qa']['tasks'] for x in t['attempts']]
print(sum(a), '/', len(a))   # 150 / 150
EOF
```

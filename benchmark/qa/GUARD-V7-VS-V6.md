# Guard arm: `foreman-fresh-v7` vs `foreman-fresh-v6`

The confirmation arm for the schema-aware Cypher guard. One arm, run once,
compared against the arm it was designed to beat. Read the caveats before
quoting the numbers: the sample is small and the delta is not statistically
significant.

## Headline

| | v6 (before) | v7 (with guard) |
|---|---|---|
| SUT head | `217a60d4` | `14166da6` |
| SUT dirty | **true** | false |
| SUT files | 83 | 85 |
| SUT fingerprint | `36164810e1301679` | `0ebf07fbef3b087d` |
| Tasks × attempts | 50 × 3 = 150 | 50 × 3 = 150 |
| Overall score | 98.67% | **100.00%** |
| Failed attempts (all) | 2 / 150 (1.33%) | **0 / 150 (0.00%)** |
| `multi_hop` failed attempts | **2 / 12 (16.7%)** | **0 / 12 (0.00%)** |
| Canary | PASS | PASS |
| Integrity | 23/23 | 23/23 |
| agentErrorRate | 0 | 0 |
| Cost | — | $3.8909 (ingest $0.0344 + qa $3.8566 + judge $0.1026) |
| Latency | — | p50 ~2.5s, 120ms reported |

Both failing attempts in v6 were `multi_hop` (tasks `sympy2-dev-032` and
`sympy2-dev-033`, each `passRate 0.67`). In v7 both are `passRate 1.00` and the
arm is clean.

## The comparison is not confounded by the dirty tree

v6 ran on a **dirty** worktree (`dirty=true`, head `217a60d`) and v7 on a clean
commit (`dirty=false`, head `14166da`). A dirty worktree is a real risk of
confounding, so it was checked rather than assumed.

`0982bdb` ("harden: bound comment summaries, trim rules into tool
descriptions…") sits between the two heads and is an ancestor of v7's head but
**not** of v6's head. It is a large change — `instructions.ts` −145 lines,
`summarize-comments.ts` +149 — and it shrinks the system prompt from **4,402
tokens (at `217a60d`) to 2,671 tokens (at `0982bdb`)**.

The decisive evidence is the harness's own SUT fingerprint, which hashes every
`.ts`/`.json`/`.yml` file under `src`, `agent` and `ingestion`:

- v6 (dirty, head `217a60d`) → `36164810e1301679`, 83 files
- `foreman-rung-81` (clean, committed head `0982bdb`) → `36164810e1301679`, 83 files

**Identical.** v6's dirty tree therefore already contained `0982bdb`'s content.
The token evidence agrees: if v6 had run on `217a60d`'s 4,402-token prompt, v7's
2,671-token prompt would show ~1,700 *fewer* input tokens per attempt; instead
v7 shows 18,624 vs v6's 18,319 (+305, consistent with the added guard text and
noise).

So the delta v6 → v7 is **exactly the guard commit** (`14166da`): two added
files and the `query-neo4j.ts` change. It is a clean guard-vs-no-guard
comparison, not a folded-in harden comparison.

## What the guard actually did in the SUT

The guard is not merely unit-tested — it fired on real agent queries during the
arm. `fresh-v7-run.log` contains **5 schema warnings** across 150 attempts:

| Count | Edge flagged | Kind | Tasks |
|---|---|---|---|
| 1 | `(c:Comment)-[:AUTHORED_BY]->(u:User)` | reversed arrow | issue #5295 |
| 4 | `(l:Label)-[:HAS_COMMENT]->(c:Comment)` | impossible chain | `sympy2-dev-032` ("Wrong Result"), `sympy2-dev-034` ("core") |

In **every** one of the 5 cases the agent re-issued a corrected query on its
next step, and the attempt passed. Example, verbatim from the log:

```
MATCH (i:Issue {number: 5295})-[:HAS_COMMENT]->(c:Comment)<-[:AUTHORED_BY]-(u:User) RETURN COUNT(DISTINCT u) …
  [queryNeo4j] schema warning: … runs against the arrow: it asserts (u:User)-[:AUTHORED_BY]->(c:Comment) …
  [queryNeo4j] returned 1 rows
MATCH (i:Issue {number: 5295})-[:HAS_COMMENT]->(c:Comment)-[:AUTHORED_BY]->(u:User) RETURN COUNT(DISTINCT u) …
```

and for `sympy2-dev-032` attempt 1, where v6 lost the attempt:

```
v6 attempt 1:  … (i)-[:HAS_COMMENT]->(c:Comment)<-[:AUTHORED_BY]-(u:User) …   → 0 rows, no warning
               answer: "There are no users who have commented on issues labeled 'Wrong Result'."

v7 attempt 1:  … (l:Label {name: "Wrong Result"})-[:HAS_COMMENT]->(c:Comment) …
               schema warning: … impossible …
               … (i)-[:HAS_LABEL]->(l:Label), (i)-[:HAS_COMMENT]->(c:Comment)-[:AUTHORED_BY]->(u:User) …
               answer: passes
```

The recovery-on-warning behaviour is the mechanism the guard was built for, and
it is observed, not assumed.

## Why the result is NOT conclusive

**The sample is too small.** There are only **12 `multi_hop` attempts per arm**.
A single attempt flipping changes the rate by **8.3pp**; the whole observed
effect is 2 attempts. At this n a null result would be non-conclusive, and so is
this positive one.

- Fisher exact, one-sided, `multi_hop` failures 2/12 → 0/12: **p ≈ 0.24**
- Fisher exact, one-sided, all failures 2/150 → 0/150: **p ≈ 0.25**

Neither clears any conventional threshold. On the evidence available, the
correct statement is *"the two failures observed in v6 were not observed in
v7"* — **not** *"the guard fixed the defect"*.

**The arms are not paired on the failure mode.** v6 lost `sympy2-dev-032`
attempt 1 to a **reversed arrow**; v7's attempt 1 for the same task contained a
**different** malformation (a `Label`-out chain) which the agent then corrected.
The malformation the agent reaches for varies run to run, so the guard's effect
is not isolated to one reproducible error.

**The guard is a safety net, not a prevention.** The v7 agent still wrote
schema-violating traversals — 5 times in 150 attempts, at a rate similar to
before. The guard changes what happens *after* a malformed query (the agent is
told the traversal is wrong instead of being left to read an empty row count),
it does not stop the agent writing them.

## Honest summary

- The guard is implemented, committed (`14166da`), and **does fire in the SUT**
  on real agent queries, naming the specific bad edge (5/150 attempts).
- In every observed firing the agent corrected within the attempt and passed —
  the intended recovery behaviour.
- The arm scored 100.00% with 0 `multi_hop` failures vs v6's 2, on a
  **verified non-confounded** delta (identical SUT fingerprint across the two
  heads modulo the guard).
- **This is not proof the defect is fixed.** 12 `multi_hop` attempts per arm
  give p ≈ 0.24. Treat the result as *consistent with* the guard helping, on
  the strength of the observed recovery behaviour — not as a measured fix.
- To measure it properly would need a `multi_hop`-only arm at ~10× the attempts
  per arm (a few hundred `multi_hop` attempts), which the 4-task/50-task split
  cannot supply.

No push, no PR, no remote write.

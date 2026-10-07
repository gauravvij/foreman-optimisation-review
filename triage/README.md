# Issue triage workflows

Three Claude Code workflow scripts that take an issue, check whether it is still
relevant against the codebase, plan it, and judge whether the plan is safe to
post. They are **not** part of the agent. They are saved here to be folded into
it, because nothing in the agent does this today: the agent's tools classify,
label, and sync a board, but none of them read the repository to decide whether
an issue still applies, and none of them write a plan.

Recovered from Claude Code session state on 2026-09-17. `ready-small-plan`
existed only inside a run's JSON record, with no script file on disk, so it was
one cleanup away from being lost.

## The three

| Script | Question it answers | Phases |
|--------|--------------------|--------|
| `issue-relevance-pilot.js` | Does this issue still apply, and what is the plan? | Analyze, Judge |
| `ready-small-plan.js` | Same, for a chunk of Ready/small issues, and is it really small? | Analyze, Judge |
| `closure-check.js` | Its linked PR merged, so can the issue be closed? | Assess, Verify |

`ready-small-plan` is `issue-relevance-pilot` narrowed to a triaged chunk, plus
a third verdict axis (`agrees-small` / `larger-than-small` / `cannot-determine`)
that checks the board's own Size against what the plan turned out to need.

## Shape

Every script is two phases run as a `pipeline`, so an issue reaches the judge as
soon as its own analysis lands rather than waiting for the batch:

1. **Analyze / Assess** — one agent per issue, grounded in the monorepo. Emits a
   structured verdict: `stillRelevant`, `verdict`, `plan`, `openQuestions`,
   `evidence` as `path:line` citations.
2. **Judge / Verify** — an independent agent on `claude-sonnet-5`, told to
   default to not-confident, that opens the cited files and checks they say what
   the analysis claims.

The gate on posting is the same in all three:

```js
const postable = (r) => r.judgement.confident && r.judgement.blockingDefects.length === 0
```

`blockingDefects` overrides `confident` on purpose. A judge can rate an analysis
useful and still have found a checkable falsehood inside it, and posting on the
boolean alone once put a false claim on a live issue.

None of them write to GitHub. Each returns `toPost`, `toReview`, `skipped`, and
`failedIssueNumbers`, and posting is a separate, deliberate step.

## Run preflight first, every time

```bash
./modules/agents/github-issue-analyzer/triage/preflight.sh   # exit 1 means do not run
```

An analysis is a set of `path:line` citations, and a citation is only true of one
tree. Run against a stale checkout and every line number may have shifted, and
an issue can be called relevant after its fix has landed.

This is not hypothetical. The first real run was made against a checkout **49
commits behind `origin/main`**, and a judge caught it on exactly one issue
(#2562) by noticing a stale line number. Every other analysis in that batch
carried the same risk silently, so the batch had to be redone. Nothing in the
workflow can detect this itself: the scripts have no filesystem access, and an
agent reading a stale file sees a perfectly consistent tree.

The gate checks four things, each of which has already gone wrong once:

1. **The superproject is not behind its upstream.** Pull before running.
2. **No submodule is checked out behind its pin.** `git pull` without
   `--recurse-submodules` moves the pins and leaves the submodule trees behind,
   so agents read older code than the commit under test. A submodule *ahead* of
   its pin is local work and passes with a note.
3. **Every submodule's remote refs are fetched.** The prompts tell agents to
   check whether a fix landed upstream in a submodule, which reads
   remote-tracking refs. Stale refs make that check quietly wrong.
4. **Tracked modifications are reported.** Agents read the working tree, so
   uncommitted edits become citations describing your edits.

It prints `revision=<sha>`. Stamp that into the payload, as
`repair-and-rejudge.js` does, so any result can be audited against the tree it
was written for. A result without a revision cannot be trusted later.

## Input contract

```js
Workflow({ scriptPath: 'triage/issue-relevance-pilot.js', args: {
  repoRoot: '/Users/you/projects/postman/astro',
  automationAuthors: ['some-bot'],   // issue-relevance-pilot only
  issues: [ /* from build-triage-payload */ ],
}})
```

Build `issues` with `test/build-triage-payload.ts`, which is already in this
repo and is the only supported source:

```bash
bun test/build-triage-payload.ts --limit 10 --exclude 57,61 --out /tmp/triage-payload.json
```

It reads the scored issues from Neo4j, then adds two things the graph does not
hold: `linkedOpenPRs` from the GraphQL API, and `liveState`, so a run never
analyses an issue that is already closed. Its header is explicit that no field
may be hand-authored, because a paraphrased body silently invalidates a run.

## What to carry across, not just the code

The prompts encode failures from earlier runs. These are the parts worth keeping
if the logic moves into a tool:

- **Repo-relative paths only.** An absolute path is meaningless in a public
  comment, and the analyzer emitted them.
- **Re-read the line before citing it.** Several citations were off by one or
  two and landed on the wrong line of the right paragraph.
- **A submodule fix is not shipped.** Check the submodule's commits, not just
  its working tree, then trace delivery: a Go module pinned in `go.mod` needs a
  version bump, not just a submodule-pointer move.
- **`already-specified` is a real verdict.** When the issue body already lays
  out an adequate plan, restating it back to the author is noise.
- **An open PR beats every other signal**, including the bot exemption.
- **Never skip a bot-captured issue.** A human-authored proposal carries its own
  plan, so re-planning it is noise, but a bot-captured issue is an unvetted
  transcript, which is exactly what needs checking. Automation authors are
  matched by `/automat|bot/i` rather than an allow-list, so a new bot is not
  silently treated as a human.

## Overlap with the agent

Folding these in has two existing surfaces to reconcile:

- `needsClarification` / `clarificationReason` already mean "cannot be acted on
  as written", which is what `verdict: needs-clarification` decides. They should
  not become two competing notions of actionability.
- `updateIssue` already posts a comment behind a confirmation gate, so it is the
  natural way to write a plan. It takes one issue at a time.

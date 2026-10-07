export const meta = {
  name: 'repair-and-rejudge',
  description: 'Fix the blocking defects a judge found in an analysis, re-verify every citation, then judge again',
  phases: [
    { title: 'Repair', detail: 'one agent per analysis, correcting only what the judge named' },
    { title: 'Rejudge', detail: 'the original judge prompt, unchanged, on the corrected text' },
  ],
}

const ANALYSIS = {
  type: 'object',
  properties: {
    issueNumber: { type: 'number' },
    stillRelevant: {
      type: 'string',
      enum: ['relevant', 'already-addressed', 'partially-addressed', 'cannot-determine'],
    },
    evidence: {
      type: 'array',
      description: 'Concrete file:line citations that justify the relevance verdict',
      items: { type: 'string' },
    },
    verdict: {
      type: 'string',
      enum: ['has-plan', 'needs-clarification', 'already-specified'],
    },
    plan: {
      type: 'string',
      description: 'Concrete implementation steps naming real files, or empty if needs-clarification',
    },
    openQuestions: {
      type: 'array',
      description: 'What a human must decide before this is actionable; empty if has-plan',
      items: { type: 'string' },
    },
    summary: { type: 'string', description: 'Two sentences max, the headline finding' },
    repairs: {
      type: 'array',
      description: 'One line per defect: what it claimed, what the code actually says, what you changed',
      items: { type: 'string' },
    },
    unrepaired: {
      type: 'array',
      description:
        'Only a named defect you could not correct, and why. Blocks posting. Not for a fact '
        + 'this environment cannot reach: that goes in limits.',
      items: { type: 'string' },
    },
    limits: {
      type: 'array',
      description:
        'Facts no amount of repair could settle from a checkout: an unreachable link, something '
        + 'needing a browser or a live cluster, a claim only the author can confirm. Does not '
        + 'block posting. Surfaced to the human reviewing the comment.',
      items: { type: 'string' },
    },
  },
  required: [
    'issueNumber', 'stillRelevant', 'evidence', 'verdict', 'plan',
    'openQuestions', 'summary', 'repairs', 'unrepaired', 'limits',
  ],
  additionalProperties: false,
}

const JUDGEMENT = {
  type: 'object',
  properties: {
    confident: {
      type: 'boolean',
      description: 'True only if this is accurate and useful enough to post publicly on the issue',
    },
    reasons: { type: 'array', items: { type: 'string' } },
    blockingDefects: {
      type: 'array',
      description:
        'Anything that MUST be fixed before this text is posted: a checkable false claim, a '
        + 'fabricated or misread citation, a wrong line number, an absolute filesystem path. '
        + 'Any entry here means it cannot post as written, whatever confident says.',
      items: { type: 'string' },
    },
    advisoryNotes: {
      type: 'array',
      description: 'Weaknesses worth knowing that do not block posting',
      items: { type: 'string' },
    },
  },
  required: ['confident', 'reasons', 'blockingDefects', 'advisoryNotes'],
  additionalProperties: false,
}

log(`Repairing ${args.entries.length} analyses against ${args.repoRoot} at ${args.revision}`)

const results = await pipeline(
  args.entries,

  (entry) =>
    agent(
      `An analysis of a GitHub issue was judged not safe to post. Your job is to correct it, not to
rewrite it. Every defect below is a checkable falsehood that a maintainer would catch.

REPO: ${args.repoRoot} (a Go + TypeScript monorepo: apps/astro-server is Go, apps/astro-client is
React, modules/astro-cli is the Go CLI, packages/astro-spec is the shared spec). The checkout is now
at ${args.revision}. The original analysis was written against a tree 49 commits older, so a
citation that was once correct may have shifted, and work may have landed that changes the verdict.

ISSUE #${entry.issue.number}: ${entry.issue.title}
Area: ${entry.issue.category} / ${entry.issue.subcategory}   Severity: ${entry.issue.severity}
BODY:
${entry.issue.body}

THE ANALYSIS AS WRITTEN:
  relevance: ${entry.analysis.stillRelevant}
  verdict:   ${entry.analysis.verdict}
  summary:   ${entry.analysis.summary}
  evidence:
${entry.analysis.evidence.map((e) => `    - ${e}`).join('\n')}
  plan:
${entry.analysis.plan || '    (none)'}
  questions: ${entry.analysis.openQuestions.join(' | ') || '(none)'}

DEFECTS THE JUDGE FOUND, each of which blocks posting:
${entry.blockingDefects.map((d, i) => `  ${i + 1}. ${d}`).join('\n')}
${entry.advisoryNotes.length > 0 ? `\nADVISORY NOTES, worth fixing but not blocking:\n${entry.advisoryNotes.map((n) => `  - ${n}`).join('\n')}` : ''}

YOUR JOB:

1. Take each defect in turn. Open the file, read the actual line, and establish what the code says
   now. Do not trust either the analysis or the judge: the judge can be wrong too, and if it is,
   say so in repairs rather than "correcting" something that was already right.

2. Re-verify EVERY other citation in the analysis, not only the ones named. The defects are a
   sample of a process that produced them; the same error is probably elsewhere. Re-read each
   path:line and confirm the number. Re-count anything stated as a count, by actually enumerating.

3. Reconsider the verdict if the code has moved. 49 commits landed since this was written. If a fix
   shipped in them, stillRelevant becomes already-addressed or partially-addressed and the plan
   shrinks accordingly. Check git log for the files you cite.

4. Emit the corrected analysis in full, with the same meaning where it was right and corrected
   facts where it was wrong. Keep the plan under roughly 2000 characters.

CITATION RULES, all of which produced a defect in the first pass:
- Repo-relative paths only, never absolute. This text becomes a public comment.
- Re-read the exact line before you emit its number. Off-by-one and off-by-two errors were the
  single most common defect.
- Any count must be counted, not estimated. A wrong count was a blocking defect three times.
- Do not describe a dependency as pinned when package.json gives a range, or vice versa.
- Do not claim a feature shipped after the issue was filed without checking the commit date.
- If you cite a submodule (packages/astro-spec, modules/astro-cli, modules/astro-infra), check its
  commits, not just its working tree, and trace delivery: a pinned Go module needs a go.mod bump.

Put one line in repairs for every defect, saying what it claimed, what the code actually says, and
what you changed.

Then split what is left over, because the two are not the same thing:

- unrepaired: a defect you could not correct. This blocks posting, so put something here only when
  the text is still wrong and you could not fix it.
- limits: a fact no checkout could settle. An unreachable Slack link, anything needing a running
  browser or a live cluster, a number only the author knows. This does NOT block posting. It is a
  caveat for the person reviewing the comment, and writing one costs you nothing.

Most of what you cannot establish belongs in limits. Do not put an environment limit in unrepaired:
that blocks a correct analysis for being honest.`,
      { label: `repair:#${entry.issue.number}`, phase: 'Repair', schema: ANALYSIS },
    ),

  (analysis, entry) => {
    if (!analysis) return null
    const issue = entry.issue
    return agent(
      `You are the last check before this analysis is posted as a public comment on a real engineering
team's issue tracker. A wrong or vacuous comment is worse than no comment. Default to NOT confident.

ISSUE #${issue.number}: ${issue.title}
BODY (excerpt):
${issue.body.slice(0, 1200)}

PROPOSED ANALYSIS:
  relevance: ${analysis.stillRelevant}
  verdict:   ${analysis.verdict}
  summary:   ${analysis.summary}
  evidence:  ${analysis.evidence.join(' | ') || '(none given)'}
  plan:      ${analysis.plan || '(none)'}
  questions: ${analysis.openQuestions.join(' | ') || '(none)'}

Judge it against these tests, in ${args.repoRoot}:

1. VERIFY THE EVIDENCE. Actually open the cited files and confirm they say what the analysis claims.
   Fabricated or misread citations mean not confident, full stop.
2. Is the relevance verdict supported by that evidence, or is it an assertion dressed up with citations?
3. If has-plan: is the plan specific enough to act on, and does it name files that exist?
4. If needs-clarification: are the questions real blockers, or is this a cop-out on something knowable?
5. Would a maintainer who knows this codebase find this comment useful, or noise?

confident: true ONLY if it passes all five.

Then fill blockingDefects with anything that must be fixed before this text is posted: a
checkable false claim (labels, state, dates, counts), a fabricated or misread citation, a wrong
line number, an absolute filesystem path, a plan step naming a file that does not exist. Put
everything else in advisoryNotes. An analysis can be genuinely useful AND contain a defect that
must not be published; do not collapse those into one judgement.

This analysis is a second pass: an earlier version was rejected for the defects listed below, and
these were meant to be corrected. Check each one specifically, and treat a defect that is still
present as blocking however well the rest reads.
${entry.blockingDefects.map((d, i) => `  ${i + 1}. ${d}`).join('\n')}

The repairer reported these defects as still unfixed. Treat each as blocking unless you can verify
it yourself:
${analysis.unrepaired.length > 0 ? analysis.unrepaired.map((u) => `  - ${u}`).join('\n') : '  (none)'}

It also recorded these as unreachable from a checkout. They are caveats, not defects: do not mark
them blocking merely because they are unresolved. Mark one blocking only if the analysis states it
as fact anyway.
${analysis.limits.length > 0 ? analysis.limits.map((l) => `  - ${l}`).join('\n') : '  (none)'}`,
      { label: `rejudge:#${issue.number}`, phase: 'Rejudge', schema: JUDGEMENT, model: 'claude-sonnet-5' },
    ).then((j) => ({ issue, analysis, judgement: j }))
  },
)

const done = results.filter(Boolean).filter((r) => r.judgement)
// Same gate as the first pass, plus a defect the repairer admitted it could not fix. `limits` is
// deliberately not part of this: gating on it blocks a correct analysis for disclosing what it
// could not reach, which is the opposite of the incentive the prompt sets.
const postable = (r) =>
  r.judgement.confident && r.judgement.blockingDefects.length === 0 && r.analysis.unrepaired.length === 0
const toPost = done.filter(postable)
const stillBlocked = done.filter((r) => !postable(r))
const failed = args.entries.filter((e) => !done.some((d) => d.issue.number === e.issue.number))

log(`repaired and clear: ${toPost.length}, still blocked: ${stillBlocked.length}, failed: ${failed.length}`)

return {
  toPost: toPost.map((r) => ({ ...r.analysis, title: r.issue.title, judgement: r.judgement })),
  stillBlocked: stillBlocked.map((r) => ({ ...r.analysis, title: r.issue.title, judgement: r.judgement })),
  failedIssueNumbers: failed.map((e) => e.issue.number),
}

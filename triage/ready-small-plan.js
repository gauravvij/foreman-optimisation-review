export const meta = {
  name: 'ready-small-plan',
  description: 'Verify a chunk of Ready/small issues still apply, then plan each, with an adversarial check',
  phases: [
    { title: 'Analyze', detail: 'one agent per issue, grounded in the monorepo' },
    { title: 'Judge', detail: 'independent check that defaults to not confident' },
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
      description: 'Repo-relative path:line citations that justify the relevance verdict',
      items: { type: 'string' },
    },
    verdict: {
      type: 'string',
      enum: ['has-plan', 'needs-clarification', 'already-specified'],
    },
    plan: {
      type: 'string',
      description: 'Concrete steps naming real files and functions, or empty if needs-clarification',
    },
    openQuestions: {
      type: 'array',
      description: 'What a human must decide before this is actionable; empty if has-plan',
      items: { type: 'string' },
    },
    sizeCheck: {
      type: 'string',
      enum: ['agrees-small', 'larger-than-small', 'cannot-determine'],
      description: 'Whether the work the plan describes really is a contained change',
    },
    summary: { type: 'string', description: 'Two sentences max, the headline finding' },
  },
  required: [
    'issueNumber', 'stillRelevant', 'evidence', 'verdict', 'plan',
    'openQuestions', 'sizeCheck', 'summary',
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
        + 'fabricated or misread citation, a wrong line number, an absolute filesystem path, a '
        + 'plan step naming a file that does not exist. Any entry means it cannot post as written.',
      items: { type: 'string' },
    },
    advisoryNotes: { type: 'array', items: { type: 'string' } },
  },
  required: ['confident', 'reasons', 'blockingDefects', 'advisoryNotes'],
  additionalProperties: false,
}

// A human-written proposal already contains its own plan, so re-planning it is
// noise. Bot-captured issues are the opposite: the detail is an unvetted
// transcript, which is exactly what needs checking against the code.
const AUTOMATION_PATTERN = /automat|bot/i
const PROPOSAL_TITLE = /\[(feat|feature|rfc|proposal|design)\]/i
const PROPOSAL_SECTION = /^\s*(proposed solution|proposal|proposed approach|design)\s*$/im
const SOURCED_FROM_CHAT = /slack\.com|slack thread|slack discussion/i
const DETAILED = 800

function skipReason(issue) {
  // An open PR means someone is already on it, whatever the issue looks like.
  const prs = issue.openPRs ?? []
  if (prs.length > 0) return `already has an open PR: ${prs.map((p) => '#' + p).join(', ')}`
  const author = issue.author ?? ''
  if (AUTOMATION_PATTERN.test(author)) return null
  if (SOURCED_FROM_CHAT.test(issue.body)) return null
  if (PROPOSAL_TITLE.test(issue.title)) return 'human-authored proposal, title marked as feature or design'
  if (PROPOSAL_SECTION.test(issue.body) && issue.body.length >= DETAILED) {
    return `human-authored proposal section with ${issue.body.length} chars of detail`
  }
  return null
}

const SKIPPED = []
const ISSUES = []
for (const issue of args.issues) {
  const reason = skipReason(issue)
  if (reason) SKIPPED.push({ number: issue.number, title: issue.title, reason })
  else ISSUES.push(issue)
}

if (SKIPPED.length > 0) {
  log(`Filtered out ${SKIPPED.length}: ${SKIPPED.map((s) => '#' + s.number).join(', ')}`)
}
log(`Analyzing ${ISSUES.length} of ${args.issues.length} issues against ${args.repoRoot}`)

const results = await pipeline(
  ISSUES,

  (issue) =>
    agent(
      `You are assessing whether a GitHub issue is still relevant to a codebase, and if so, how to fix it.

REPO: ${args.repoRoot} (Go + TypeScript monorepo: apps/astro-server is Go, apps/astro-client is React,
modules/astro-cli is the Go CLI, packages/astro-spec is the shared spec, modules/messaging is the chat
sidecar, modules/adapters bridges agent frameworks).

DO NOT run gh or any network command. The issue text below is the issue; several agents are running at
once and the GitHub API is rate limited. Work from the local repository only: grep, glob, read, git log.

ISSUE #${issue.number}: ${issue.title}
Author: ${issue.author}   Opened: ${issue.createdAt}   Labels: ${issue.labels.join(', ') || 'none'}
Board: priority ${issue.priority ?? '-'}, size ${issue.size ?? '-'}

BODY:
${issue.body || '(empty)'}

YOUR JOB, in order:

1. Understand what the issue actually asks for. A feature request asks whether it already exists; a
   bug asks whether it still reproduces in current code. Enumerate every distinct ask: a title with
   "and" or "+" is usually two.

2. Search the repo to answer that. Use grep/glob/read aggressively and ground every claim in real
   files, cited as path:line. Do NOT guess. If you cannot find the relevant code after genuine
   effort, say cannot-determine rather than inventing a verdict.

3. Decide stillRelevant: relevant, already-addressed, partially-addressed (say which part in the
   summary), or cannot-determine.

4. Decide verdict:
   - has-plan: you can name the specific files and functions to change, concretely enough that
     another engineer could start. "Add validation" is not a plan; name the function.
   - needs-clarification: ambiguous, or depends on a product decision. List exactly what a human
     must decide in openQuestions.
   - already-specified: the issue body already lays out an adequate plan. Return this and leave
     plan empty rather than paraphrasing the author back to themselves.

5. sizeCheck: the board calls this a small change. Having read the code, say whether that holds.
   larger-than-small is a useful finding, not a failure.

CITATION RULES, each of which was violated in an earlier run:
- Paths must be REPO-RELATIVE (apps/astro-server/...), never absolute. An absolute path from a
  maintainer's machine is meaningless in a public comment.
- Before you emit path:line, re-read that exact line and confirm the number.
- For a git submodule (packages/astro-spec, modules/astro-cli, modules/adapters, modules/messaging),
  check its recent commits, not just the working tree; a fix can land upstream and look absent.
- "It landed in the submodule" does not mean it ships. A Go module pinned in go.mod needs a version
  bump, not just a submodule-pointer move. Say which is needed.
- Do not describe labels, milestone, or state beyond what is given above.

LENGTH: the plan is a comment on an issue, not a design document. Under roughly 2000 characters.
Name the files and the steps; do not write the patch.

needs-clarification is a perfectly good answer and far better than a vague plan. An
already-addressed verdict must cite the code that addresses it.`,
      { label: `analyze:#${issue.number}`, phase: 'Analyze', schema: ANALYSIS },
    ),

  (analysis, issue) => {
    if (!analysis) return null
    return agent(
      `You are the last check before this analysis is posted as a public comment on a real engineering
team's issue tracker. A wrong or vacuous comment is worse than no comment. Default to NOT confident.

DO NOT run gh or any network command; the API is rate limited and many agents are running. Verify
against the local repository only.

ISSUE #${issue.number}: ${issue.title}
BODY (excerpt):
${(issue.body || '').slice(0, 1200)}

PROPOSED ANALYSIS:
  relevance:  ${analysis.stillRelevant}
  verdict:    ${analysis.verdict}
  sizeCheck:  ${analysis.sizeCheck}
  summary:    ${analysis.summary}
  evidence:   ${analysis.evidence.join(' | ') || '(none given)'}
  plan:       ${analysis.plan || '(none)'}
  questions:  ${analysis.openQuestions.join(' | ') || '(none)'}

Judge it against these tests, in ${args.repoRoot}:

1. VERIFY THE EVIDENCE. Open the cited files and confirm they say what the analysis claims, at the
   line given. Fabricated or misread citations mean not confident, full stop.
2. Is the relevance verdict supported by that evidence, or an assertion dressed up with citations?
3. If has-plan: is it specific enough to act on, and does every file it names exist?
4. If needs-clarification: are the questions real blockers, or a cop-out on something knowable?
5. Does the analysis miss an ask the issue makes? A missed ask on an already-addressed verdict is a
   blocking defect.
6. Would a maintainer who knows this codebase find this useful, or noise?

confident: true ONLY if it passes all six.

blockingDefects: anything that must be fixed before posting, including a checkable false claim, a
misread citation, a wrong line number, an absolute path, or a named file that does not exist.
Everything else goes in advisoryNotes. An analysis can be genuinely useful AND contain a defect that
must not be published; do not collapse those into one judgement.`,
      { label: `judge:#${issue.number}`, phase: 'Judge', schema: JUDGEMENT, model: 'claude-sonnet-5' },
    ).then((j) => ({ issue, analysis, judgement: j }))
  },
)

const done = results.filter(Boolean).filter((r) => r.judgement)
// A blocking defect overrides confident: the judge can rate an analysis useful
// and still have found a false claim inside it.
const postable = (r) => r.judgement.confident && r.judgement.blockingDefects.length === 0
const toPost = done.filter(postable)
const toReview = done.filter((r) => !postable(r))
const failed = ISSUES.filter((i) => !done.some((d) => d.issue.number === i.number))

log(`ready to post: ${toPost.length}, needs your review: ${toReview.length}, failed: ${failed.length}`)

const shape = (r) => ({ ...r.analysis, title: r.issue.title, judgement: r.judgement })
return {
  skipped: SKIPPED,
  toPost: toPost.map(shape),
  toReview: toReview.map(shape),
  failedIssueNumbers: failed.map((i) => i.number),
}

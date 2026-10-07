export const meta = {
  name: 'issue-relevance-pilot',
  description: 'Check 10 GitHub issues against the codebase, plan or flag each, then judge posting confidence',
  phases: [
    { title: 'Analyze', detail: 'one agent per issue, grounded in the monorepo' },
    { title: 'Judge', detail: 'independent confidence check gating any GitHub write' },
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
  },
  required: ['issueNumber', 'stillRelevant', 'evidence', 'verdict', 'plan', 'openQuestions', 'summary'],
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

// A human-written proposal already contains its own plan, so re-planning it is
// noise. Bot-captured issues are the opposite: the detail is an unvetted
// transcript of a conversation, so it is exactly what needs checking against
// the code. Never skip those, however proposal-shaped they look.
// Match automation accounts by name rather than an allow-list, so a new bot does
// not silently get treated as a human author. A false positive only costs one
// extra analysis; a false negative silently skips an issue that needed checking.
const AUTOMATION_PATTERN = /automat|bot/i
const AUTOMATION_AUTHORS = new Set(args.automationAuthors ?? [])

function isAutomation(author) {
  if (!author) return false
  return AUTOMATION_AUTHORS.has(author) || AUTOMATION_PATTERN.test(author)
}
const PROPOSAL_TITLE = /\[(feat|feature|rfc|proposal|design)\]/i
const PROPOSAL_SECTION = /^\s*(proposed solution|proposal|proposed approach|design)\s*$/im
const SOURCED_FROM_CHAT = /slack\.com|slack thread|slack discussion/i
const DETAILED = 800

function proposalReason(issue) {
  // An open PR means someone is already on it, whatever the issue looks like.
  // Checked first: this beats every other signal, including the bot exemption.
  const prs = issue.linkedOpenPRs ?? []
  if (prs.length > 0) {
    const label = prs.map((p) => `#${p.pr}${p.draft ? ' (draft)' : ''}`).join(', ')
    return `already has an open PR: ${label}`
  }
  if (isAutomation(issue.author)) return null
  if (SOURCED_FROM_CHAT.test(issue.body)) return null
  if (PROPOSAL_TITLE.test(issue.title)) return 'human-authored proposal, title marked as a feature or design proposal'
  if (PROPOSAL_SECTION.test(issue.body) && issue.body.length >= DETAILED) {
    return `human-authored proposal section with ${issue.body.length} chars of detail`
  }
  return null
}

const SKIPPED = []
const ISSUES = []
for (const issue of args.issues) {
  const reason = proposalReason(issue)
  if (reason) SKIPPED.push({ number: issue.number, title: issue.title, reason })
  else ISSUES.push(issue)
}

if (SKIPPED.length > 0) {
  log(`Skipping ${SKIPPED.length} spec/proposal issues: ${SKIPPED.map((s) => '#' + s.number).join(', ')}`)
}

log(`Analyzing ${ISSUES.length} issues against ${args.repoRoot}`)

const results = await pipeline(
  ISSUES,

  (issue) =>
    agent(
      `You are assessing whether a GitHub issue is still relevant to a codebase, and if so, how to fix it.

REPO: ${args.repoRoot} at ${args.revision} (a Go + TypeScript monorepo: apps/astro-server is Go,
apps/astro-client is React, modules/astro-cli is the Go CLI, packages/astro-spec is the shared spec).
Cite what this tree says now. If a fix landed recently, the verdict is already-addressed or
partially-addressed, not relevant.

ISSUE #${issue.number}: ${issue.title}
Area: ${issue.category} / ${issue.subcategory}   Severity: ${issue.severity}   Opened: ${issue.createdAt}
Labels: ${issue.labels.join(', ') || 'none'}

BODY:
${issue.body}

YOUR JOB, in order:

1. Understand what the issue actually asks for. If it is a feature request, the question is whether it
   already exists. If it is a bug, the question is whether it still reproduces in the current code.

2. Search the repo to answer that. Use grep/glob/read aggressively. Ground every claim in real files.
   Cite them as path:line. Do NOT guess. If you cannot find the relevant code after genuine effort, say
   cannot-determine rather than inventing a verdict.

3. Decide stillRelevant:
   - relevant: the gap or bug is still there
   - already-addressed: the code now does what the issue asks
   - partially-addressed: some of it exists, some does not (say which in the summary)
   - cannot-determine: you could not locate the relevant code

4. Decide verdict:
   - has-plan: you can name the specific files to change and the steps, concretely enough that another
     engineer could start. A plan that says "add validation" is NOT good enough; name the function.
   - needs-clarification: the issue is ambiguous, depends on a product decision, or you lack the context
     to plan it. List exactly what a human must decide in openQuestions.
   - already-specified: the issue body already lays out an adequate plan of its own. Return this and
     leave plan empty. Do not restate back to the author what they already wrote; that is pure noise.
     Use it whenever your plan would mostly paraphrase the issue.

CITATION RULES — each of these was violated in a previous run:
- Paths must be REPO-RELATIVE (apps/astro-server/...), never absolute. Your working directory
  is a maintainer's machine; an absolute path is meaningless in a public comment.
- Before you emit path:line, re-read that exact line and confirm the number. Three citations
  last time were off by one or two and landed on the wrong line of the right paragraph.
- If you cite anything in a git submodule (packages/astro-spec, modules/astro-cli,
  modules/astro-infra), check its recent commits, not just the working tree. A fix that landed
  upstream can look absent if you only read files.
- "It landed in the submodule" does not mean it ships. Trace the delivery path: a Go module
  pinned in go.mod needs a version bump, not just a submodule-pointer move. Say which is needed.
- Do not describe an issue's labels, milestone, or state unless you actually read them; that is
  a checkable claim a maintainer sees is wrong.

LENGTH: the plan is a comment on an issue, not a design document. Keep it under roughly 2000
characters. Name the files and the steps; do not write the patch.

Be honest. needs-clarification is a perfectly good answer and far better than a vague plan. An
already-addressed verdict must cite the code that addresses it.`,
      { label: `analyze:#${issue.number}`, phase: 'Analyze', schema: ANALYSIS },
    ),

  (analysis, issue) => {
    if (!analysis) return null
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
must not be published; do not collapse those into one judgement.`,
      { label: `judge:#${issue.number}`, phase: 'Judge', schema: JUDGEMENT, model: 'claude-sonnet-5' },
    ).then((j) => ({ issue, analysis, judgement: j }))
  },
)

const done = results.filter(Boolean).filter((r) => r.judgement)
// A blocking defect overrides confident: the judge can rate an analysis useful
// and still have found a false claim inside it. Posting on the boolean alone put
// a checkable falsehood on a live issue once already.
const postable = (r) => r.judgement.confident && r.judgement.blockingDefects.length === 0
const toPost = done.filter(postable)
const toReview = done.filter((r) => !postable(r))
const failed = ISSUES.filter((i) => !done.some((d) => d.issue.number === i.number))

log(`confident: ${toPost.length}, needs your review: ${toReview.length}, failed: ${failed.length}`)

return {
  skipped: SKIPPED,
  toPost: toPost.map((r) => ({ ...r.analysis, title: r.issue.title, judgement: r.judgement })),
  toReview: toReview.map((r) => ({ ...r.analysis, title: r.issue.title, judgement: r.judgement })),
  failedIssueNumbers: failed.map((i) => i.number),
}

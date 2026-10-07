export const meta = {
  name: 'closure-check',
  description: 'Check whether issues whose linked PR merged can be closed, then adversarially verify each closure claim',
  phases: [
    { title: 'Assess', detail: 'one agent per issue: read the issue, the merged diff, and current code' },
    { title: 'Verify', detail: 'adversarial check that defaults to keeping the issue open' },
  ],
}

const CLOSURE = {
  type: 'object',
  properties: {
    issueNumber: { type: 'number' },
    resolution: {
      type: 'string',
      enum: ['fully-resolved', 'partially-resolved', 'not-resolved', 'cannot-determine'],
      description: 'How much of what the issue asks for the merged pull request actually delivered',
    },
    canClose: {
      type: 'boolean',
      description: 'True only if nothing the issue asks for remains undone',
    },
    prDidWhat: {
      type: 'string',
      description: 'What the merged pull request actually changed, from its diff, in one or two sentences',
    },
    evidence: {
      type: 'array',
      description: 'Repo-relative path:line citations, and PR numbers, that justify the verdict',
      items: { type: 'string' },
    },
    residual: {
      type: 'array',
      description: 'Parts of the issue still undone. Empty only when canClose is true.',
      items: { type: 'string' },
    },
    recommendation: {
      type: 'string',
      description: 'Either the closing comment to post, or why the issue stays open and what remains',
    },
    summary: { type: 'string', description: 'Two sentences max, the headline finding' },
  },
  required: ['issueNumber', 'resolution', 'canClose', 'prDidWhat', 'evidence', 'residual', 'recommendation', 'summary'],
  additionalProperties: false,
}

const JUDGEMENT = {
  type: 'object',
  properties: {
    confident: {
      type: 'boolean',
      description: 'True only if this verdict is accurate enough to act on, including closing a real issue',
    },
    agreesCanClose: {
      type: 'boolean',
      description: 'Your own independent call on whether the issue can be closed',
    },
    reasons: { type: 'array', items: { type: 'string' } },
    blockingDefects: {
      type: 'array',
      description:
        'Anything that MUST be fixed before acting: a checkable false claim, a fabricated or '
        + 'misread citation, a wrong line number, an absolute filesystem path, a claim about the '
        + 'pull request diff that the diff does not support. Any entry here means do not act.',
      items: { type: 'string' },
    },
    advisoryNotes: { type: 'array', items: { type: 'string' } },
  },
  required: ['confident', 'agreesCanClose', 'reasons', 'blockingDefects', 'advisoryNotes'],
  additionalProperties: false,
}

log(`Checking ${args.issues.length} issues whose linked pull request merged`)

const results = await pipeline(
  args.issues,

  (issue) =>
    agent(
      `An issue is still open, but a pull request that referenced it has already merged. Decide whether
the issue can now be closed.

REPO: ${args.repoRoot} (Go + TypeScript monorepo: apps/astro-server is Go, apps/astro-client is React,
modules/astro-cli is the Go CLI, packages/astro-spec is the shared spec).

ISSUE #${issue.number}: ${issue.title}
MERGED PULL REQUEST(S): ${issue.prs.map((p) => '#' + p).join(', ')}

None of these pull requests declared "closes #${issue.number}" — they only referenced it. So do not
assume the link means the work is done. That is the whole question.

YOUR JOB, in order:

1. Read the issue from source, do not rely on this prompt:
     gh issue view ${issue.number} --repo astropods/astro --json title,body,labels,createdAt
   Enumerate every distinct thing the issue asks for. Many issues ask for more than one; an issue
   titled "add X + fix Y" is two asks and closing it needs both.

2. Read what the pull request actually changed, from the diff, not the title:
     gh pr view <PR> --repo astropods/astro --json title,body,mergedAt,files
     gh pr diff <PR> --repo astropods/astro
   A title that sounds like the issue proves nothing. Some of these pull requests deliver a
   neighbouring feature, or a mitigation for the symptom rather than a fix for the cause.

3. Check the current code for each ask. Use grep/glob/read. For a bug, does it still reproduce by
   inspection? For a feature, does the code now do it? Cite path:line.

4. Decide resolution and canClose:
   - fully-resolved / canClose true: every ask is done. Nothing remains.
   - partially-resolved / canClose false: some asks are done. List the rest in residual.
   - not-resolved / canClose false: the pull request addressed something else, or only the symptom.
   - cannot-determine / canClose false: you could not locate the relevant code after real effort.

canClose true is a recommendation to close a real engineering team's issue. Default to false. A
mitigation is not a fix: if the issue says a bad input hangs a deployment and the pull request adds
a way to cancel a hung deployment, the bad input still hangs it, so the issue stays open.

5. recommendation: if canClose, write the closing comment, naming the pull request that did the work
   and the code that proves it. If not, say what remains, specifically enough to act on.

CITATION RULES:
- Paths must be REPO-RELATIVE (apps/astro-server/...), never absolute.
- Re-read the exact line before you cite its number.
- Do not claim a pull request changed something without having seen it in the diff.
- For a submodule (packages/astro-spec, modules/astro-cli), check its commits, not just files.

LENGTH: recommendation under roughly 1500 characters.`,
      { label: `assess:#${issue.number}`, phase: 'Assess', schema: CLOSURE },
    ),

  (assessment, issue) => {
    if (!assessment) return null
    return agent(
      `You are the last check before a real engineering team's issue is closed or left open on this
advice. Closing an issue that still has work left is the expensive mistake. Default to NOT confident
and to disagreeing with a close.

ISSUE #${issue.number}: ${issue.title}
MERGED PULL REQUEST(S): ${issue.prs.map((p) => '#' + p).join(', ')}

PROPOSED VERDICT:
  resolution:     ${assessment.resolution}
  canClose:       ${assessment.canClose}
  PR did what:    ${assessment.prDidWhat}
  summary:        ${assessment.summary}
  evidence:       ${assessment.evidence.join(' | ') || '(none given)'}
  residual:       ${assessment.residual.join(' | ') || '(none)'}
  recommendation: ${assessment.recommendation}

Judge it in ${args.repoRoot}:

1. READ THE ISSUE YOURSELF (gh issue view ${issue.number} --repo astropods/astro). Enumerate the asks
   independently. Did the assessment miss one? A missed ask is a blocking defect when canClose is true.
2. READ THE DIFF YOURSELF (gh pr diff <PR> --repo astropods/astro). Does it do what prDidWhat claims?
   A claim the diff does not support is a blocking defect.
3. VERIFY EVERY CITATION. Open the cited files and confirm the line says what is claimed. Fabricated
   or misread citations mean not confident, full stop.
4. If canClose is true: try to refute it. Find one thing the issue asks for that is not done. If you
   can, that is a blocking defect and agreesCanClose is false.
5. If canClose is false: is the residual real and still undone, or is the assessment being timid
   about something the code clearly does now? An issue kept open on a stale objection is also wrong.
6. Is a mitigation being mistaken for a fix, in either direction?

confident: true only if the verdict survives all six. agreesCanClose is your own call, independent of
the assessment's.

blockingDefects: anything that must be fixed before acting on this. Everything else goes in
advisoryNotes.`,
      { label: `verify:#${issue.number}`, phase: 'Verify', schema: JUDGEMENT, model: 'claude-sonnet-5' },
    ).then((j) => ({ issue, assessment, judgement: j }))
  },
)

const done = results.filter(Boolean).filter((r) => r.judgement)

// Both agents must independently agree, and no blocking defect may remain.
// Closing a live issue on one agent's say-so is the error this gate exists for.
const closeable = (r) =>
  r.judgement.confident
  && r.judgement.blockingDefects.length === 0
  && r.assessment.canClose
  && r.judgement.agreesCanClose

const disputed = (r) => r.assessment.canClose !== r.judgement.agreesCanClose

const toClose = done.filter(closeable)
const keepOpen = done.filter((r) => !closeable(r))
const failed = args.issues.filter((i) => !done.some((d) => d.issue.number === i.number))

log(`closeable: ${toClose.length}, keep open: ${keepOpen.length}, disputed: ${done.filter(disputed).length}, failed: ${failed.length}`)

return {
  toClose: toClose.map((r) => ({ ...r.assessment, title: r.issue.title, judgement: r.judgement })),
  keepOpen: keepOpen.map((r) => ({
    ...r.assessment,
    title: r.issue.title,
    disputed: disputed(r),
    judgement: r.judgement,
  })),
  failedIssueNumbers: failed.map((i) => i.number),
}

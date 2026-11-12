/**
 * Recomputes the numbers reported in OPTIMISATION.md and README.md (one folder
 * up) from the proof files in this folder, and says whether each one still
 * matches.
 *
 *   bun docs/optimisation/benchmark/check-numbers.ts
 *
 * Needs no API key, database or network: it only reads the JSON files next to
 * it. Exits 1 if any number differs.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = import.meta.dirname;
const load = (path: string) => JSON.parse(readFileSync(join(DIR, path), 'utf-8'));

type Attempt = { pass: boolean; ms: number };
type Task = { id: string; kind: string; attempts: Attempt[] };
type Report = {
  qa: { tasks: Task[] };
  sut: { hash: string };
  cost: { qaUsd: number; sutTotalUsd: number };
  integrity?: { pass: boolean; info?: boolean }[];
  ingest: { neo4j: { queries: number; sessions: number } };
};

const report = (name: string): Report => load(`qa/rerun/${name}.json`);
const allAttempts = (r: Report) => r.qa.tasks.flatMap((t) => t.attempts);
const attempts = (r: Report, keep: (t: Task) => boolean = () => true) => {
  const all = r.qa.tasks.filter(keep).flatMap((t) => t.attempts);
  return `${all.filter((a) => a.pass).length}/${all.length}`;
};
const oneAnswer = (t: Task) => t.kind !== 'semantic';
const summary = (t: Task) => t.kind === 'semantic';
const solved = (r: Report) =>
  `${r.qa.tasks.filter((t) => t.attempts.every((a) => a.pass)).length}/${r.qa.tasks.length}`;
const checks = (r: Report) => {
  const required = (r.integrity ?? []).filter((c) => !c.info);
  return `${required.filter((c) => c.pass).length}/${required.length}`;
};
const sum = (parts: string[]) => {
  const [right, total] = parts
    .map((p) => p.split('/').map(Number))
    .reduce(([a, b], [c, d]) => [a + c, b + d], [0, 0]);
  return `${right}/${total}`;
};
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const rows: [section: string, claim: string, expected: string | number, actual: string | number][] = [];
const add = (section: string, claim: string, expected: string | number, actual: string | number) =>
  rows.push([section, claim, expected, actual]);

// Sections 1 and 5.5: the three main question sets, 3 attempts per question.
// [name, file, attempts right, solved on every attempt, one-answer right, summaries right],
// each as [original, branch].
const sets = [
  ['SymPy Core 50', 'sympy2-dev', ['137/150', '150/150'], ['44/50', '50/50'], ['122/132', '132/132'], ['15/18', '18/18']],
  ['Hugging Face 50', 'lewtun-holdout', ['148/150', '150/150'], ['49/50', '50/50'], ['132/132', '132/132'], ['16/18', '18/18']],
  ['SymPy Extended 81', 'sympy2-dev-81', ['239/243', '242/243'], ['79/81', '80/81'], ['218/219', '219/219'], ['21/24', '23/24']],
] as const;
for (const [name, file, right, all, one, summ] of sets) {
  const o = report(`baseline-${file}`);
  const b = report(`branch-${file}`);
  add('5.5', `${name}: attempts right, original`, right[0], attempts(o));
  add('5.5', `${name}: attempts right, branch`, right[1], attempts(b));
  add('5.5', `${name}: solved on every attempt, original`, all[0], solved(o));
  add('5.5', `${name}: solved on every attempt, branch`, all[1], solved(b));
  add('5.5', `${name}: one-answer attempts, original`, one[0], attempts(o, oneAnswer));
  add('5.5', `${name}: one-answer attempts, branch`, one[1], attempts(b, oneAnswer));
  add('5.5', `${name}: summary attempts, original`, summ[0], attempts(o, summary));
  add('5.5', `${name}: summary attempts, branch`, summ[1], attempts(b, summary));
}
add('1', 'One-answer attempts, three sets, original', '472/483',
  sum(sets.map(([, f]) => attempts(report(`baseline-${f}`), oneAnswer))));
add('1', 'One-answer attempts, three sets, branch', '483/483',
  sum(sets.map(([, f]) => attempts(report(`branch-${f}`), oneAnswer))));

const neutral = report('branch-neutral-example-sympy2-dev');
add('5.5', 'SymPy Core 50 re-test after the tidy-ups: attempts right', '149/150', attempts(neutral));
add('5.5', 'SymPy Core 50 re-test after the tidy-ups: one-answer', '132/132', attempts(neutral, oneAnswer));

// Section 5.6: cost per attempt and median response time, SymPy Core 50.
for (const [label, file, usd, secs] of [
  ['original', 'baseline-sympy2-dev', '0.0236', '2.29'],
  ['branch', 'branch-sympy2-dev', '0.0253', '2.21'],
] as const) {
  const r = report(file);
  add('5.6', `SymPy Core 50: cost per attempt ($), ${label}`, usd, (r.cost.qaUsd / allAttempts(r).length).toFixed(4));
  add('5.6', `SymPy Core 50: median response time (s), ${label}`, secs,
    (median(allAttempts(r).map((a) => a.ms)) / 1000).toFixed(2));
}

// Section 7: OpenHands 600, run three times, 1 attempt per question per run.
type Template = { id: string; template: string };
const runs = [1, 2, 3].map((r) => ({ o: report(`baseline-oh-600-run${r}`), b: report(`branch-oh-600-run${r}`) }));
const expected = {
  right: [['126/150', '127/150', '127/150'], ['144/150', '141/150', '145/150']],
  oneAnswer: [['118/140', '118/140', '118/140'], ['134/140', '132/140', '135/140']],
  summaries: [['8/10', '9/10', '9/10'], ['10/10', '9/10', '10/10']],
  requests: [[8703, 8684, 8712], [3061, 3017, 3006]],
  betterWorse: [[21, 3], [19, 5], [20, 2]],
};
const rightIn = (r: Report) => new Map(r.qa.tasks.map((t) => [t.id, t.attempts.every((a) => a.pass)]));
runs.forEach(({ o, b }, i) => {
  const run = `OpenHands 600 run ${i + 1}`;
  add('7', `${run}: questions right, original`, expected.right[0][i], attempts(o));
  add('7', `${run}: questions right, branch`, expected.right[1][i], attempts(b));
  add('7', `${run}: one-answer right, original`, expected.oneAnswer[0][i], attempts(o, oneAnswer));
  add('7', `${run}: one-answer right, branch`, expected.oneAnswer[1][i], attempts(b, oneAnswer));
  add('7', `${run}: summaries right, original`, expected.summaries[0][i], attempts(o, summary));
  add('7', `${run}: summaries right, branch`, expected.summaries[1][i], attempts(b, summary));
  add('7', `${run}: database requests, original`, expected.requests[0][i], o.ingest.neo4j.queries);
  add('7', `${run}: database requests, branch`, expected.requests[1][i], b.ingest.neo4j.queries);
  add('7', `${run}: database connections, original`, 1206, o.ingest.neo4j.sessions);
  add('7', `${run}: database connections, branch`, 8, b.ingest.neo4j.sessions);
  add('7', `${run}: database checks passed, original`, '17/18', checks(o));
  add('7', `${run}: database checks passed, branch`, '18/18', checks(b));
  const ro = rightIn(o);
  const rb = rightIn(b);
  const ids = [...ro.keys()];
  add('7', `${run}: questions better on the branch`, expected.betterWorse[i][0], ids.filter((q) => rb.get(q) && !ro.get(q)).length);
  add('7', `${run}: questions worse on the branch`, expected.betterWorse[i][1], ids.filter((q) => ro.get(q) && !rb.get(q)).length);
});
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const rightCount = (r: Report) => r.qa.tasks.filter((t) => t.attempts.every((a) => a.pass)).length;
add('7', 'OpenHands 600: average questions right, original', '126.7', mean(runs.map((r) => rightCount(r.o))).toFixed(1));
add('7', 'OpenHands 600: average questions right, branch', '143.3', mean(runs.map((r) => rightCount(r.b))).toFixed(1));
add('1', 'OpenHands 600: average database requests, original', 8700, Math.round(mean(runs.map((r) => r.o.ingest.neo4j.queries))));
add('1', 'OpenHands 600: average database requests, branch', 3028, Math.round(mean(runs.map((r) => r.b.ingest.neo4j.queries))));
add('7', 'OpenHands 600: average run cost ($), original', '4.18', mean(runs.map((r) => r.o.cost.sutTotalUsd)).toFixed(2));
add('7', 'OpenHands 600: average run cost ($), branch', '4.48', mean(runs.map((r) => r.b.cost.sutTotalUsd)).toFixed(2));
const timesRight = (side: 'o' | 'b', id: string) => runs.filter((r) => rightIn(r[side]).get(id)).length;
const ids600 = runs[0].o.qa.tasks.map((t) => t.id);
add('7', 'OpenHands 600: questions right in all three runs, original', 118, ids600.filter((q) => timesRight('o', q) === 3).length);
add('7', 'OpenHands 600: questions right in all three runs, branch', 138, ids600.filter((q) => timesRight('b', q) === 3).length);
add('7', 'OpenHands 600: questions never right, original', 15, ids600.filter((q) => timesRight('o', q) === 0).length);
add('7', 'OpenHands 600: questions never right, branch', 1, ids600.filter((q) => timesRight('b', q) === 0).length);
add('7', 'OpenHands 600: questions right more often on the branch', 28, ids600.filter((q) => timesRight('b', q) > timesRight('o', q)).length);
add('7', 'OpenHands 600: questions right less often on the branch', 7, ids600.filter((q) => timesRight('b', q) < timesRight('o', q)).length);
const misses = (side: 'o' | 'b', template?: string) =>
  runs.flatMap((r) => (r[side].qa.tasks as unknown as (Task & Template)[]))
    .filter((t) => !t.attempts.every((a) => a.pass) && (!template || t.template === template)).length;
add('7', 'OpenHands 600: wrong answers over 3 runs, original', 70, misses('o'));
add('7', 'OpenHands 600: of which two-step questions', 28, misses('o', 'multi_hop'));
add('7', 'OpenHands 600: of which label questions', 12, misses('o', 'label'));
add('7', 'OpenHands 600: of which date questions', 21, misses('o', 'date_range'));
add('7', 'OpenHands 600: wrong answers over 3 runs, branch', 20, misses('b'));
add('7', 'OpenHands 600: of which date questions', 15, misses('b', 'date_range'));

// Section 5.2: database work to read in 5, 20 and 60 issues, from the repeated runs.
const repeat = load('profile/repeat-runs.json');
for (const [n, requests, connections] of [
  [5, [51, 41], [17, 9]],
  [20, [212, 89], [47, 9]],
  [60, [620, 209], [127, 9]],
] as const) {
  const c = repeat.database_work_counts.sizes[`issues_${n}`];
  add('5.2', `${n} issues: database requests, original`, requests[0], c.original.requests);
  add('5.2', `${n} issues: database requests, branch`, requests[1], c.branch.requests);
  add('5.2', `${n} issues: database connections, original`, connections[0], c.original.connections);
  add('5.2', `${n} issues: database connections, branch`, connections[1], c.branch.connections);
}
add('5.2', '60 issues: single-run profile agrees, original', 620,
  load('profile/profile-foreman-baseline-60.json').neo4j.totalStatements);
add('5.2', '60 issues: single-run profile agrees, branch', 209,
  load('profile/profile-foreman-optimised-60.json').neo4j.totalStatements);

// Section 5.3: median time to read in issues.
for (const [n, original, branch] of [
  [5, 545, 177],
  [20, 1388, 452],
  [60, 2827, 805],
] as const) {
  const t = repeat.timing.sizes[`issues_${n}`];
  add('5.3', `${n} issues: median ms, original`, original, t.original_no_rules.median_wallMs);
  add('5.3', `${n} issues: median ms, branch`, branch, t.branch_rules_present.median_wallMs);
}

// Every original-version report was run on the same code.
const originals = ['sympy2-dev', 'lewtun-holdout', 'sympy2-dev-81', 'oh-600-run1', 'oh-600-run2', 'oh-600-run3'].map(
  (f) => report(`baseline-${f}`).sut.hash,
);
add('4', 'Original reports all ran on the original code (98bff512…)', 'yes',
  originals.every((h) => h === '98bff512a1c301a8') ? 'yes' : `no: ${originals.join(', ')}`);

let failed = 0;
const width = Math.max(...rows.map((r) => r[1].length));
console.log(`${'Section'.padEnd(8)}${'Claim'.padEnd(width + 2)}${'Report says'.padStart(12)}  Proof file`);
for (const [section, claim, expected, actual] of rows) {
  const ok = String(expected) === String(actual);
  if (!ok) failed++;
  console.log(`${section.padEnd(8)}${claim.padEnd(width + 2)}${String(expected).padStart(12)}  ${String(actual).padEnd(9)}${ok ? 'ok' : 'DIFFERENT'}`);
}
console.log(`\n${rows.length - failed} of ${rows.length} numbers match the proof files.`);
process.exit(failed ? 1 : 0);

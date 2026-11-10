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

// Section 7: OpenHands Dev 50 (3 attempts) and OpenHands 600 (1 attempt).
const ohDev = { o: report('baseline-oh-dev'), b: report('branch-oh-dev') };
add('7', 'Dev 50: attempts right, original', '124/150', attempts(ohDev.o));
add('7', 'Dev 50: attempts right, branch', '144/150', attempts(ohDev.b));
add('7', 'Dev 50: one-answer attempts, original', '115/132', attempts(ohDev.o, oneAnswer));
add('7', 'Dev 50: one-answer attempts, branch', '127/132', attempts(ohDev.b, oneAnswer));
add('7', 'Dev 50: summary attempts, original', '9/18', attempts(ohDev.o, summary));
add('7', 'Dev 50: summary attempts, branch', '17/18', attempts(ohDev.b, summary));
add('7', 'Dev 50: solved on every attempt, original', '36/50', solved(ohDev.o));
add('7', 'Dev 50: solved on every attempt, branch', '46/50', solved(ohDev.b));
add('7', 'Dev 50: database requests, original', 958, ohDev.o.ingest.neo4j.queries);
add('7', 'Dev 50: database requests, branch', 345, ohDev.b.ingest.neo4j.queries);
add('7', 'Dev 50: database connections, original', 126, ohDev.o.ingest.neo4j.sessions);
add('7', 'Dev 50: database connections, branch', 8, ohDev.b.ingest.neo4j.sessions);
add('7', 'Dev 50: database checks passed, original', '17/18', checks(ohDev.o));
add('7', 'Dev 50: database checks passed, branch', '18/18', checks(ohDev.b));

const oh600 = { o: report('baseline-oh-600'), b: report('branch-oh-600') };
add('7', 'OpenHands 600: attempts right, original', '126/150', attempts(oh600.o));
add('7', 'OpenHands 600: attempts right, branch', '144/150', attempts(oh600.b));
add('7', 'OpenHands 600: one-answer attempts, original', '118/140', attempts(oh600.o, oneAnswer));
add('7', 'OpenHands 600: one-answer attempts, branch', '134/140', attempts(oh600.b, oneAnswer));
add('7', 'OpenHands 600: summary attempts, original', '8/10', attempts(oh600.o, summary));
add('7', 'OpenHands 600: summary attempts, branch', '10/10', attempts(oh600.b, summary));
add('7', 'OpenHands 600: database requests, original', 8703, oh600.o.ingest.neo4j.queries);
add('7', 'OpenHands 600: database requests, branch', 3061, oh600.b.ingest.neo4j.queries);
add('7', 'OpenHands 600: database connections, original', 1206, oh600.o.ingest.neo4j.sessions);
add('7', 'OpenHands 600: database connections, branch', 8, oh600.b.ingest.neo4j.sessions);
add('7', 'OpenHands 600: database checks passed, original', '17/18', checks(oh600.o));
add('7', 'OpenHands 600: database checks passed, branch', '18/18', checks(oh600.b));
add('7', 'OpenHands 600: run cost ($), original', '4.24', oh600.o.cost.sutTotalUsd.toFixed(2));
add('7', 'OpenHands 600: run cost ($), branch', '4.52', oh600.b.cost.sutTotalUsd.toFixed(2));

// Questions better and worse, original vs branch (a question counts as right
// when every attempt at it was right).
for (const [name, pair, better, worse] of [
  ['Dev 50', ohDev, 12, 2],
  ['OpenHands 600', oh600, 21, 3],
] as const) {
  const right = (r: Report) =>
    new Map(r.qa.tasks.map((t) => [t.id, t.attempts.every((a) => a.pass)]));
  const o = right(pair.o);
  const b = right(pair.b);
  const ids = [...o.keys()];
  add('7', `${name}: questions better on the branch`, better, ids.filter((i) => b.get(i) && !o.get(i)).length);
  add('7', `${name}: questions worse on the branch`, worse, ids.filter((i) => o.get(i) && !b.get(i)).length);
}

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
const originals = ['sympy2-dev', 'lewtun-holdout', 'sympy2-dev-81', 'oh-dev', 'oh-600'].map(
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

/**
 * Writes the derived classification to GitHub Projects v2 single-select fields.
 *
 * A project field belongs to a board item, not to the issue, so an issue that
 * is not on the board has nowhere to hold a value and is added first. Boards
 * and fields are found by name at runtime, so no project is compiled in.
 *
 * Only open issues are considered. A closed card keeps whatever it had, because
 * re-triaging finished work is noise on the board.
 */

import neo4j from 'neo4j-driver';
import { priorityBand } from './github-labels';
import { WRITE_INTERVAL_MS, githubGraphQL, sleep } from './http';
import { getDriver } from './neo4j';
import { toEffort } from './priority';
import { progress } from './progress';
import { fetchLinkedPullRequests, isShippedButOpen, summariseLinks } from './pull-requests';

const ITEM_PAGE_SIZE = 100;

/** Analyzer effort to a board size, overridable because option names vary. */
const DEFAULT_SIZE_MAP: Record<string, string> = { small: 'S', medium: 'M', large: 'L' };

/** Board column per derived state, overridable because column names vary. */
const DEFAULT_STATUS_MAP: Record<string, string> = {
  backlog: 'Backlog',
  ready: 'Ready',
  progress: 'In progress',
  review: 'In review',
  done: 'Done',
};

/**
 * Columns a person parks a card in, overridable because names vary. A board
 * without one is unaffected: the agent never derives these, it only declines
 * to move a card out of one.
 */
const DEFAULT_HOLD_COLUMNS = ['On hold'];

/** Bands that count as worth picking up now, so a clean issue can reach Ready. */
const READY_BANDS = new Set(['P0', 'P1']);

export interface ClassifiedIssue {
  number: number;
  state: string;
  priorityScore: number;
  effort: string | null;
  needsClarification: boolean;
  /** Live from GitHub, absent when the status field is not being synced. */
  assigned?: boolean;
  hasOpenReadyPR?: boolean;
  hasDraftPR?: boolean;
  hasMergedPR?: boolean;
}

/** A single-select field this agent maintains, and how it derives the value. */
export interface ManagedField {
  /** Key callers use, independent of what the board happens to call the field. */
  key: FieldKey;
  name: string;
  /** A value to set, null to clear the field, or undefined to leave it alone. */
  valueFor: (issue: ClassifiedIssue) => string | null | undefined;
  /**
   * Only ever move later in the option order. A column a person dragged a card
   * into is a coordination signal, so a repeat run advances it or leaves it,
   * and never pulls it back. Implies the field is never cleared.
   */
  forwardOnly?: boolean;
  /** Needs assignee and pull request state, which the graph does not hold. */
  needsLiveSignals?: boolean;
  /**
   * Columns the agent leaves a card in while its issue is open. Board order
   * cannot carry this: a hold reads best early in the column list, and
   * forwardOnly treats an early column as the least-progressed one and
   * promotes out of it. A closed issue still reaches Done, because a hold on
   * finished work is stale rather than a decision to respect.
   */
  holds?: Set<string>;
}

export const FIELD_KEYS = ['priority', 'size', 'status'] as const;
export type FieldKey = (typeof FIELD_KEYS)[number];

function parseMap(
  raw: string | undefined,
  fallback: Record<string, string>,
): Record<string, string> {
  if (!raw) return fallback;
  const pairs = raw
    .split(',')
    .map((entry) => entry.split('=').map((part) => part.trim()))
    .filter(
      (parts): parts is [string, string] => parts.length === 2 && Boolean(parts[0] && parts[1]),
    );
  return pairs.length > 0 ? { ...fallback, ...Object.fromEntries(pairs) } : fallback;
}

function parseList(raw: string | undefined, fallback: string[]): string[] {
  if (!raw) return fallback;
  const names = raw
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  return names.length > 0 ? names : fallback;
}

/**
 * The column an issue belongs in, from facts rather than judgment.
 *
 * Ordered by how much evidence each signal carries. A pull request that is
 * ready, or already merged, means the work is out of the author's hands. A
 * draft says work has started but is not offered for review yet, which is the
 * same claim an assignee makes. Priority is the agent's own opinion, which is
 * why it can reach Ready but no further.
 */
export function deriveStatus(
  issue: ClassifiedIssue,
  columns: Record<string, string>,
): string | undefined {
  if (issue.state !== 'OPEN') return columns.done;
  if (issue.hasOpenReadyPR || issue.hasMergedPR) return columns.review;
  if (issue.hasDraftPR || issue.assigned) return columns.progress;
  if (issue.needsClarification) return columns.backlog;
  return READY_BANDS.has(priorityBand(issue.priorityScore)) ? columns.ready : columns.backlog;
}

/** The fields this agent knows how to fill, named as the board names them. */
export function managedFields(): ManagedField[] {
  const sizeMap = parseMap(process.env.PROJECT_SIZE_MAP, DEFAULT_SIZE_MAP);
  const statusMap = parseMap(process.env.PROJECT_STATUS_MAP, DEFAULT_STATUS_MAP);
  // A closed card keeps the priority and size it was triaged with; only its
  // column moves, because re-triaging finished work is noise on the board.
  const openOnly = <T>(i: ClassifiedIssue, value: T) => (i.state === 'OPEN' ? value : undefined);

  return [
    {
      key: 'priority',
      name: process.env.PROJECT_PRIORITY_FIELD || 'Priority',
      valueFor: (i) => openOnly(i, priorityBand(i.priorityScore)),
    },
    {
      key: 'size',
      name: process.env.PROJECT_SIZE_FIELD || 'Size',
      valueFor: (i) => {
        const effort = toEffort(i.effort);
        return openOnly(i, effort ? (sizeMap[effort] ?? null) : null);
      },
    },
    {
      key: 'status',
      name: process.env.PROJECT_STATUS_FIELD || 'Status',
      valueFor: (i) => deriveStatus(i, statusMap),
      forwardOnly: true,
      needsLiveSignals: true,
      holds: new Set(parseList(process.env.PROJECT_HOLD_COLUMNS, DEFAULT_HOLD_COLUMNS)),
    },
  ];
}

export interface ResolvedField {
  key: FieldKey;
  name: string;
  fieldId: string;
  /**
   * Option name to id, in board order. forwardOnly reads that order as
   * increasing progress, which holds for the columns the agent derives. A
   * column it never derives, such as a hold, is governed by ManagedField.holds
   * rather than by where it sits.
   */
  options: Map<string, string>;
}

export interface ResolvedBoard {
  projectId: string;
  projectNumber: number;
  projectTitle: string;
  fields: ResolvedField[];
}

export interface BoardItem {
  itemId: string;
  /** Current value per field name; absent means the field is unset. */
  values: Map<string, string>;
}

export interface FieldChange {
  issueNumber: number;
  field: FieldKey;
  fieldName: string;
  from: string | null;
  /** The value to set, or null to clear the field. */
  to: string | null;
  addToBoard: boolean;
}

export interface FieldSyncResult {
  planned: FieldChange[];
  applied: number;
  added: number;
  cleared: number;
  /** Changes that still differ after this chunk. */
  remaining: number;
  /** Values a board field has no option for, so those issues are left unset. */
  unmapped: { field: string; values: string[] }[];
  /** Open issues whose pull request already merged, so they may be finished. */
  shippedButOpen: number[];
  /** Option order per field key, for ranking a change as a downgrade. */
  optionOrder: Record<string, string[]>;
  projectNumber: number;
  projectTitle: string;
  fieldNames: string[];
  dryRun: boolean;
  errors: string[];
}

interface ProjectNode {
  id: string;
  number: number;
  title: string;
  items: { totalCount: number };
  fields: {
    nodes: ({ id: string; name: string; options?: { id: string; name: string }[] } | null)[];
  };
}

const PROJECTS_QUERY = `query($owner:String!, $repo:String!) {
  repository(owner:$owner, name:$repo) {
    projectsV2(first:20) {
      nodes {
        id number title
        items(first:1) { totalCount }
        fields(first:50) {
          nodes { ... on ProjectV2SingleSelectField { id name options { id name } } }
        }
      }
    }
  }
}`;

async function fetchProjects(owner: string, repo: string): Promise<ProjectNode[]> {
  const data = await githubGraphQL<{
    repository: { projectsV2: { nodes: ProjectNode[] } } | null;
  }>(PROJECTS_QUERY, { owner, repo }, 'GitHub projects');
  return data.repository?.projectsV2.nodes ?? [];
}

/** Every project linked to the repo, for choosing a target or reporting one back. */
export async function listProjectBoards(
  owner: string,
  repo: string,
): Promise<
  { number: number; title: string; items: number; fields: { name: string; options: string[] }[] }[]
> {
  const wanted = new Set(managedFields().map((f) => f.name));
  return (await fetchProjects(owner, repo)).map((p) => ({
    number: p.number,
    title: p.title,
    items: p.items.totalCount,
    fields: p.fields.nodes
      .filter((f): f is NonNullable<typeof f> => Boolean(f?.name && wanted.has(f.name)))
      .map((f) => ({ name: f.name, options: (f.options ?? []).map((o) => o.name) })),
  }));
}

/**
 * Finds the board and the fields to write to.
 *
 * The target must be unambiguous. When the repository has more than one project
 * carrying a managed field and no number is given, this refuses and lists them
 * rather than picking one: guessing here writes to a board someone else owns. A
 * field the board does not define, or defines with no options, is dropped with
 * a note rather than failing the whole sync.
 */
export async function resolveBoard(
  owner: string,
  repo: string,
  projectNumber?: number,
  only?: FieldKey[],
): Promise<{ board: ResolvedBoard; skipped: string[] }> {
  const managed = managedFields().filter((f) => !only || only.includes(f.key));
  const envNumber = Number.parseInt(process.env.PROJECT_NUMBER ?? '', 10);
  const wantedNumber = projectNumber ?? (Number.isFinite(envNumber) ? envNumber : Number.NaN);

  const projects = await fetchProjects(owner, repo);
  if (projects.length === 0) {
    throw new Error(`no GitHub project is linked to ${owner}/${repo}`);
  }

  const targeted = Number.isFinite(wantedNumber);
  const candidates = targeted ? projects.filter((p) => p.number === wantedNumber) : projects;

  if (targeted && candidates.length === 0) {
    const seen = projects.map((p) => `#${p.number} ${p.title}`).join(', ');
    throw new Error(`${owner}/${repo} has no project #${wantedNumber} (found: ${seen})`);
  }

  const carrying = candidates.filter((p) =>
    p.fields.nodes.some((f) => f?.name && managed.some((m) => m.name === f.name)),
  );

  if (carrying.length === 0) {
    const names = managed.map((m) => `"${m.name}"`).join(' or ');
    const seen = candidates.map((p) => `#${p.number} ${p.title}`).join(', ') || 'none';
    throw new Error(
      `no single-select field named ${names} on any project for ${owner}/${repo} (checked: ${seen})`,
    );
  }

  if (carrying.length > 1) {
    const seen = carrying.map((p) => `#${p.number} "${p.title}"`).join(', ');
    throw new Error(
      `${owner}/${repo} has ${carrying.length} projects with a managed field (${seen}). Name the one to write to, so this never touches a board by accident.`,
    );
  }

  const project = carrying[0];
  const fields: ResolvedField[] = [];
  const skipped: string[] = [];

  for (const m of managed) {
    const node = project.fields.nodes.find((f) => f?.name === m.name);
    if (!node) {
      skipped.push(`${m.name} (no such field on the board)`);
      continue;
    }
    if (!node.options || node.options.length === 0) {
      skipped.push(`${m.name} (field has no options defined)`);
      continue;
    }
    fields.push({
      key: m.key,
      name: m.name,
      fieldId: node.id,
      options: new Map(node.options.map((o) => [o.name, o.id])),
    });
  }

  if (fields.length === 0) {
    throw new Error(
      `#${project.number} "${project.title}" has no usable managed field: ${skipped.join('; ')}.`,
    );
  }

  return {
    board: {
      projectId: project.id,
      projectNumber: project.number,
      projectTitle: project.title,
      fields,
    },
    skipped,
  };
}

interface BoardItemPage {
  node: {
    items: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: {
        id: string;
        content: { number: number } | null;
        fieldValues: { nodes: ({ name?: string; field?: { name?: string } } | null)[] };
      }[];
    };
  } | null;
}

/** Every issue on the board, with the managed values it currently shows. */
export async function fetchBoardItems(projectId: string): Promise<Map<number, BoardItem>> {
  const items = new Map<number, BoardItem>();
  let cursor: string | null = null;

  do {
    const data: BoardItemPage = await githubGraphQL<BoardItemPage>(
      `query($id:ID!, $after:String, $size:Int!) {
         node(id:$id) {
           ... on ProjectV2 {
             items(first:$size, after:$after) {
               pageInfo { hasNextPage endCursor }
               nodes {
                 id
                 content { ... on Issue { number } }
                 fieldValues(first:20) {
                   nodes {
                     ... on ProjectV2ItemFieldSingleSelectValue {
                       name
                       field { ... on ProjectV2SingleSelectField { name } }
                     }
                   }
                 }
               }
             }
           }
         }
       }`,
      { id: projectId, after: cursor, size: ITEM_PAGE_SIZE },
      'GitHub project items',
    );

    const page = data.node?.items;
    if (!page) break;

    for (const node of page.nodes) {
      if (!node.content?.number) continue;
      const values = new Map<string, string>();
      for (const v of node.fieldValues.nodes) {
        if (v?.field?.name && v.name) values.set(v.field.name, v.name);
      }
      items.set(node.content.number, { itemId: node.id, values });
    }

    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);

  return items;
}

/**
 * The classification each scored issue carries, straight from the graph.
 *
 * Closed issues are included so a card already on the board can reach Done. A
 * closed issue is never added to a board it is absent from.
 */
export async function loadClassifiedIssues(): Promise<ClassifiedIssue[]> {
  const session = getDriver().session({ defaultAccessMode: neo4j.session.READ });
  try {
    const result = await session.run(
      `MATCH (i:Issue)
       WHERE i.priorityScore IS NOT NULL
       RETURN i.number AS number, i.state AS state, i.priorityScore AS priorityScore,
              i.effort AS effort, i.needsClarification AS needsClarification
       ORDER BY i.number`,
    );
    return result.records.map((r) => ({
      number: neo4j.int(r.get('number')).toNumber(),
      state: (r.get('state') as string | null) ?? 'OPEN',
      priorityScore: neo4j.int(r.get('priorityScore')).toNumber(),
      effort: (r.get('effort') as string | null) ?? null,
      needsClarification: r.get('needsClarification') === true,
    }));
  } finally {
    await session.close();
  }
}

const SIGNAL_CHUNK = 50;

/**
 * Assignee state per issue, read live rather than from the graph because it
 * changes without the issue itself being touched.
 */
async function fetchAssignees(
  owner: string,
  repo: string,
  numbers: number[],
): Promise<Set<number>> {
  const assigned = new Set<number>();

  for (let i = 0; i < numbers.length; i += SIGNAL_CHUNK) {
    const chunk = numbers.slice(i, i + SIGNAL_CHUNK);
    const aliases = chunk
      .map((n) => `i${n}: issue(number:${n}) { number assignees(first:1) { totalCount } }`)
      .join('\n    ');

    const data = await githubGraphQL<{
      repository: Record<
        string,
        { number: number; assignees: { totalCount: number } } | null
      > | null;
    }>(
      `query($owner:String!, $repo:String!) {
         repository(owner:$owner, name:$repo) {
    ${aliases}
         }
       }`,
      { owner, repo },
      'GitHub issue assignees',
    );

    for (const value of Object.values(data.repository ?? {})) {
      if (value?.number && value.assignees.totalCount > 0) assigned.add(value.number);
    }
  }

  return assigned;
}

export interface IssueSignals {
  assigned: boolean;
  hasOpenReadyPR: boolean;
  hasDraftPR: boolean;
  hasMergedPR: boolean;
}

/** Everything the status column depends on that the graph does not hold. */
export async function fetchIssueSignals(
  owner: string,
  repo: string,
  numbers: number[],
): Promise<Map<number, IssueSignals>> {
  const [assigned, linked] = await Promise.all([
    fetchAssignees(owner, repo, numbers),
    fetchLinkedPullRequests(owner, repo, numbers),
  ]);

  return new Map(
    numbers.map((n) => {
      const links = summariseLinks(linked.get(n) ?? []);
      return [
        n,
        {
          assigned: assigned.has(n),
          hasOpenReadyPR: links.hasOpenReadyPR,
          hasDraftPR: links.hasDraftPR,
          hasMergedPR: links.hasMergedPR,
        },
      ];
    }),
  );
}

/**
 * Computes the field changes without contacting GitHub.
 *
 * A value the board has no option for resolves to "no value", so the field is
 * cleared rather than left showing a stale one. An off-board issue whose every
 * value is unmapped yields no change at all, and so no card: its current values
 * read as unset, which is already what the sync would leave behind.
 */
export function planFieldChanges(
  issues: ClassifiedIssue[],
  board: Map<number, BoardItem>,
  fields: ResolvedField[],
): { planned: FieldChange[]; unmapped: { field: string; values: string[] }[] } {
  const planned: FieldChange[] = [];
  const unmapped = new Map<string, Set<string>>();
  const managed = managedFields();

  for (const issue of issues) {
    const item = board.get(issue.number);
    const forIssue: FieldChange[] = [];

    for (const field of fields) {
      const spec = managed.find((m) => m.key === field.key);
      const derived = spec?.valueFor(issue);
      if (derived === undefined) continue;

      if (derived !== null && !field.options.has(derived)) {
        if (!unmapped.has(field.name)) unmapped.set(field.name, new Set());
        unmapped.get(field.name)?.add(derived);
      }

      const to = derived !== null && field.options.has(derived) ? derived : null;
      const from = item?.values.get(field.name) ?? null;
      if (from === to) continue;

      // A hold outranks the derived column whatever the board order says, so a
      // column placed before Backlog still holds.
      if (from !== null && issue.state === 'OPEN' && spec?.holds?.has(from)) continue;

      if (spec?.forwardOnly) {
        const order = [...field.options.keys()];
        // No value ranks below every option, so clearing never counts as forward.
        const rank = (value: string | null) => (value === null ? -1 : order.indexOf(value));
        if (rank(to) <= rank(from)) continue;
      }

      forIssue.push({
        issueNumber: issue.number,
        field: field.key,
        fieldName: field.name,
        from,
        to,
        addToBoard: !item,
      });
    }

    // A closed issue can be moved to Done on a board it is already on, but it
    // is never worth a new card.
    if (!item && issue.state !== 'OPEN') continue;
    planned.push(...forIssue);
  }

  return {
    planned,
    unmapped: [...unmapped.entries()]
      .map(([field, values]) => ({ field, values: [...values].sort() }))
      .sort((a, b) => a.field.localeCompare(b.field)),
  };
}

/** Resolves issue numbers to their node ids, needed to add a card to a board. */
async function fetchIssueNodeIds(
  owner: string,
  repo: string,
  numbers: number[],
): Promise<Map<number, string>> {
  const ids = new Map<number, string>();
  if (numbers.length === 0) return ids;

  const aliases = numbers.map((n) => `i${n}: issue(number:${n}) { id number }`).join('\n    ');
  const data = await githubGraphQL<{
    repository: Record<string, { id: string; number: number } | null> | null;
  }>(
    `query($owner:String!, $repo:String!) {
       repository(owner:$owner, name:$repo) {
    ${aliases}
       }
     }`,
    { owner, repo },
    'GitHub issue ids',
  );

  for (const value of Object.values(data.repository ?? {})) {
    if (value?.id) ids.set(value.number, value.id);
  }
  return ids;
}

export interface FieldSyncOptions {
  owner: string;
  repo: string;
  dryRun: boolean;
  limit?: number;
  issueNumbers?: number[];
  /** Board to write to. Falls back to PROJECT_NUMBER, then refuses if ambiguous. */
  projectNumber?: number;
  /** Restrict to some managed fields. Omit for all of them. */
  fields?: FieldKey[];
}

/** Plans the sync, and applies it unless this is a dry run. */
export async function syncFields(opts: FieldSyncOptions): Promise<FieldSyncResult> {
  const { owner, repo, dryRun, limit, issueNumbers, projectNumber, fields: only } = opts;

  const { board: resolved, skipped } = await resolveBoard(owner, repo, projectNumber, only);
  const errors = skipped.map((s) => `skipped ${s}`);
  const items = await fetchBoardItems(resolved.projectId);

  const wanted = new Set(issueNumbers ?? []);
  const issues = (await loadClassifiedIssues()).filter(
    (i) => wanted.size === 0 || wanted.has(i.number),
  );

  const shippedButOpen: number[] = [];
  const needsSignals = managedFields().some(
    (m) => m.needsLiveSignals && resolved.fields.some((f) => f.key === m.key),
  );
  if (needsSignals) {
    const open = issues.filter((i) => i.state === 'OPEN').map((i) => i.number);
    const signals = await fetchIssueSignals(owner, repo, open);
    for (const issue of issues) {
      const s = signals.get(issue.number);
      issue.assigned = s?.assigned ?? false;
      issue.hasOpenReadyPR = s?.hasOpenReadyPR ?? false;
      issue.hasDraftPR = s?.hasDraftPR ?? false;
      issue.hasMergedPR = s?.hasMergedPR ?? false;
      if (
        isShippedButOpen({
          hasMergedPR: issue.hasMergedPR,
          hasOpenReadyPR: issue.hasOpenReadyPR,
          hasDraftPR: issue.hasDraftPR,
        })
      ) {
        shippedButOpen.push(issue.number);
      }
    }
  }

  const { planned: all, unmapped } = planFieldChanges(issues, items, resolved.fields);
  const planned = typeof limit === 'number' ? all.slice(0, limit) : all;

  const base = {
    planned,
    remaining: all.length - planned.length,
    unmapped,
    optionOrder: Object.fromEntries(resolved.fields.map((f) => [f.key, [...f.options.keys()]])),
    shippedButOpen,
    projectNumber: resolved.projectNumber,
    projectTitle: resolved.projectTitle,
    fieldNames: resolved.fields.map((f) => f.name),
    errors,
  };

  if (dryRun || planned.length === 0) {
    return { ...base, applied: 0, added: 0, cleared: 0, dryRun };
  }

  const toAdd = [...new Set(planned.filter((c) => c.addToBoard).map((c) => c.issueNumber))];
  const nodeIds = await fetchIssueNodeIds(owner, repo, toAdd);
  const itemIds = new Map([...items].map(([n, i]) => [n, i.itemId]));

  let applied = 0;
  let added = 0;
  let cleared = 0;
  const report = progress('applyBoardSync', planned.length);

  for (const change of planned) {
    const field = resolved.fields.find((f) => f.key === change.field);
    if (!field) continue;

    try {
      // Several changes can share an issue, so the card is added at most once.
      if (!itemIds.has(change.issueNumber)) {
        const contentId = nodeIds.get(change.issueNumber);
        if (!contentId) {
          const detail = `#${change.issueNumber}: could not resolve the issue id`;
          errors.push(detail);
          report.fail(detail);
          continue;
        }
        const res = await githubGraphQL<{ addProjectV2ItemById: { item: { id: string } } }>(
          `mutation($project:ID!, $content:ID!) {
             addProjectV2ItemById(input:{projectId:$project, contentId:$content}) { item { id } }
           }`,
          { project: resolved.projectId, content: contentId },
          'GitHub project add',
        );
        itemIds.set(change.issueNumber, res.addProjectV2ItemById.item.id);
        added++;
        await sleep(WRITE_INTERVAL_MS);
      }

      const itemId = itemIds.get(change.issueNumber);
      if (!itemId) {
        const detail = `#${change.issueNumber}: no board item to update`;
        errors.push(detail);
        report.fail(detail);
        continue;
      }

      if (change.to === null) {
        await githubGraphQL(
          `mutation($project:ID!, $item:ID!, $field:ID!) {
             clearProjectV2ItemFieldValue(input:{projectId:$project, itemId:$item, fieldId:$field}) {
               projectV2Item { id }
             }
           }`,
          { project: resolved.projectId, item: itemId, field: field.fieldId },
          'GitHub project clear',
        );
        cleared++;
      } else {
        const optionId = field.options.get(change.to);
        if (!optionId) {
          const detail = `#${change.issueNumber}: no ${field.name} option named ${change.to}`;
          errors.push(detail);
          report.fail(detail);
          continue;
        }
        await githubGraphQL(
          `mutation($project:ID!, $item:ID!, $field:ID!, $option:String!) {
             updateProjectV2ItemFieldValue(input:{
               projectId:$project, itemId:$item, fieldId:$field,
               value:{singleSelectOptionId:$option}
             }) { projectV2Item { id } }
           }`,
          { project: resolved.projectId, item: itemId, field: field.fieldId, option: optionId },
          'GitHub project set',
        );
      }

      applied++;
      report.step(`#${change.issueNumber} ${change.fieldName} -> ${change.to ?? '(cleared)'}`);
      await sleep(WRITE_INTERVAL_MS);
    } catch (err: unknown) {
      const detail = `#${change.issueNumber} ${change.fieldName}: ${err instanceof Error ? err.message : String(err)}`;
      errors.push(detail);
      report.fail(detail);
    }
  }

  report.done();
  return { ...base, applied, added, cleared, dryRun };
}

export interface SetColumnOptions {
  owner: string;
  repo: string;
  issueNumbers: number[];
  column: string;
  projectNumber?: number;
  dryRun?: boolean;
}

export interface SetColumnResult {
  projectNumber: number;
  projectTitle: string;
  fieldName: string;
  /** The column asked for, echoed so a caller can report it without restating. */
  column: string;
  /** Every option the field has, so a caller can correct a wrong column name. */
  options: string[];
  moved: { issueNumber: number; from: string | null }[];
  /** Already in the column asked for, so nothing was written. */
  unchanged: number[];
  addedToBoard: number[];
  errors: string[];
}

/**
 * Puts cards in one column, from instruction rather than from evidence.
 *
 * syncFields derives the column from facts and refuses to move a card
 * backwards, which is what keeps a repeat run from undoing a person's
 * decision. Neither applies here: this is the person's decision arriving, so
 * it writes the column named and nothing else. It touches no other field, so
 * priority and size stay whatever triage made them.
 */
export async function setBoardColumn(opts: SetColumnOptions): Promise<SetColumnResult> {
  const { owner, repo, issueNumbers, column, projectNumber, dryRun } = opts;

  const { board, skipped } = await resolveBoard(owner, repo, projectNumber, ['status']);
  const errors = skipped.map((s) => `skipped ${s}`);
  const field = board.fields.find((f) => f.key === 'status');

  const base = {
    projectNumber: board.projectNumber,
    projectTitle: board.projectTitle,
    fieldName: field?.name ?? (process.env.PROJECT_STATUS_FIELD || 'Status'),
    column,
    options: field ? [...field.options.keys()] : [],
    moved: [] as { issueNumber: number; from: string | null }[],
    unchanged: [] as number[],
    addedToBoard: [] as number[],
    errors,
  };

  if (!field) {
    errors.push(`board #${board.projectNumber} has no ${base.fieldName} field to set`);
    return base;
  }

  const optionId = field.options.get(column);
  if (!optionId) {
    errors.push(`no ${field.name} option named ${column}`);
    return base;
  }

  const items = await fetchBoardItems(board.projectId);
  const absent = issueNumbers.filter((n) => !items.has(n));
  const nodeIds = absent.length > 0 ? await fetchIssueNodeIds(owner, repo, absent) : new Map();

  for (const number of issueNumbers) {
    const item = items.get(number);
    if (item?.values.get(field.name) === column) {
      base.unchanged.push(number);
      continue;
    }

    if (dryRun) {
      base.moved.push({ issueNumber: number, from: item?.values.get(field.name) ?? null });
      if (!item) base.addedToBoard.push(number);
      continue;
    }

    try {
      let itemId = item?.itemId;
      if (!itemId) {
        const contentId = nodeIds.get(number);
        if (!contentId) {
          errors.push(`#${number}: could not resolve the issue id`);
          continue;
        }
        const res = await githubGraphQL<{ addProjectV2ItemById: { item: { id: string } } }>(
          `mutation($project:ID!, $content:ID!) {
             addProjectV2ItemById(input:{projectId:$project, contentId:$content}) { item { id } }
           }`,
          { project: board.projectId, content: contentId },
          'GitHub project add',
        );
        itemId = res.addProjectV2ItemById.item.id;
        base.addedToBoard.push(number);
        await sleep(WRITE_INTERVAL_MS);
      }

      await githubGraphQL(
        `mutation($project:ID!, $item:ID!, $field:ID!, $option:String!) {
           updateProjectV2ItemFieldValue(input:{
             projectId:$project, itemId:$item, fieldId:$field,
             value:{singleSelectOptionId:$option}
           }) { projectV2Item { id } }
         }`,
        { project: board.projectId, item: itemId, field: field.fieldId, option: optionId },
        'GitHub project set',
      );
      base.moved.push({ issueNumber: number, from: item?.values.get(field.name) ?? null });
      await sleep(WRITE_INTERVAL_MS);
    } catch (error) {
      errors.push(`#${number}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return base;
}

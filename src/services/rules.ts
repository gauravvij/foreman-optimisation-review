/**
 * Standing classification rules, persisted in the graph.
 *
 * An Assessment records a decision about one issue. A Rule records a decision
 * about a *kind* of issue, so it keeps applying to issues that do not exist yet.
 * Without that, a correction of the form "anything with this label belongs in
 * that category" has to be repeated after every re-analysis, because the model
 * re-derives the category from scratch each run and does not remember being
 * corrected.
 *
 * Rules are applied after classification, so they always win over the model.
 */

import neo4j from 'neo4j-driver';
import { getDriver } from './neo4j';
import type { TAXONOMY } from './priority';

export type Category = (typeof TAXONOMY)[number];

export interface CategoryRule {
  label: string;
  category: Category;
  note: string | null;
  recordedAt: string;
  recordedBy: string;
}

export interface RuleApplication {
  issueNumber: number;
  from: string | null;
  to: Category;
  label: string;
}

/**
 * Records a rule mapping a GitHub label to a category. Re-recording the same
 * label replaces the rule: two rules for one label would make the outcome
 * depend on evaluation order.
 */
export async function recordCategoryRule(opts: {
  label: string;
  category: Category;
  note?: string;
  recordedBy?: string;
}): Promise<CategoryRule> {
  const { label, category, note = null, recordedBy = 'user' } = opts;
  const recordedAt = new Date().toISOString();

  const session = getDriver().session();
  try {
    await session.run(
      `MERGE (r:Rule {kind: 'category', label: $label})
       SET r.category = $category, r.note = $note,
           r.recordedAt = $recordedAt, r.recordedBy = $recordedBy`,
      { label, category, note, recordedAt, recordedBy },
    );
    return { label, category, note, recordedAt, recordedBy };
  } finally {
    await session.close();
  }
}

export async function listCategoryRules(): Promise<CategoryRule[]> {
  const session = getDriver().session({ defaultAccessMode: neo4j.session.READ });
  try {
    const res = await session.run(
      `MATCH (r:Rule {kind: 'category'})
       RETURN r.label AS label, r.category AS category, r.note AS note,
              r.recordedAt AS recordedAt, r.recordedBy AS recordedBy
       ORDER BY r.label`,
    );
    return res.records.map((r) => ({
      label: r.get('label'),
      category: r.get('category') as Category,
      note: r.get('note'),
      recordedAt: r.get('recordedAt'),
      recordedBy: r.get('recordedBy'),
    }));
  } finally {
    await session.close();
  }
}

export async function deleteCategoryRule(label: string): Promise<boolean> {
  const session = getDriver().session();
  try {
    const res = await session.run(
      `MATCH (r:Rule {kind: 'category', label: $label}) DELETE r RETURN count(*) AS n`,
      { label },
    );
    return neo4j.int(res.records[0]?.get('n') ?? 0).toNumber() > 0;
  } finally {
    await session.close();
  }
}

/**
 * Applies every category rule, optionally limited to certain issues so the
 * ingestion pipeline can correct only what it just classified.
 *
 * Returns only the issues it actually changed, so a caller can report the
 * difference rather than restating the whole rule set.
 */
export async function applyCategoryRules(issueNumbers?: number[]): Promise<RuleApplication[]> {
  const session = getDriver().session();
  try {
    const res = await session.run(
      `MATCH (r:Rule {kind: 'category'})
       MATCH (i:Issue)-[:HAS_LABEL]->(l:Label {name: r.label})
       WHERE ($numbers IS NULL OR i.number IN $numbers)
         AND (i.category IS NULL OR i.category <> r.category)
       WITH i, r, i.category AS previous
       SET i.category = r.category, i.categorySource = 'rule:' + r.label
       RETURN i.number AS number, previous AS previous, r.category AS category, r.label AS label
       ORDER BY i.number`,
      { numbers: issueNumbers ?? null },
    );
    return res.records.map((r) => ({
      issueNumber: neo4j.int(r.get('number')).toNumber(),
      from: r.get('previous'),
      to: r.get('category') as Category,
      label: r.get('label'),
    }));
  } finally {
    await session.close();
  }
}

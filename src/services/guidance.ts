/**
 * Free-text classification guidance, persisted in the graph.
 *
 * The third tier of correction, alongside Assessment and Rule:
 *
 *   Assessment  a decision about one issue           ("#12 is nice to have")
 *   Rule        a mapping from an input fact         ("label X means category Y")
 *   Guidance    a judgment about how to classify     ("category A should not
 *                                                      carry subcategory B")
 *
 * A Rule is enforced after the fact, which only works when the condition is an
 * input the code can match on. Guidance is about the model's own output, so
 * there is nothing to match and no obvious repair; the useful place for it is
 * the prompt, before the model decides. That makes it advisory rather than
 * enforced, which is the honest trade: the model can still get it wrong, but it
 * stops producing the mistake instead of having it corrected afterwards.
 */

import neo4j from 'neo4j-driver';
import { getDriver } from './neo4j';

export interface Guidance {
  id: string;
  text: string;
  recordedAt: string;
  recordedBy: string;
}

/** Stable id from the text, so re-recording the same note replaces rather than duplicates. */
function guidanceId(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 200);
}

export async function recordGuidance(opts: {
  text: string;
  recordedBy?: string;
}): Promise<Guidance> {
  const text = opts.text.trim();
  if (!text) throw new Error('guidance text is empty');

  const guidance: Guidance = {
    id: guidanceId(text),
    text,
    recordedAt: new Date().toISOString(),
    recordedBy: opts.recordedBy ?? 'user',
  };

  const session = getDriver().session();
  try {
    await session.run(
      `MERGE (g:Guidance {id: $id})
       SET g.text = $text, g.recordedAt = $recordedAt, g.recordedBy = $recordedBy`,
      guidance,
    );
    return guidance;
  } finally {
    await session.close();
  }
}

export async function listGuidance(): Promise<Guidance[]> {
  const session = getDriver().session({ defaultAccessMode: neo4j.session.READ });
  try {
    const res = await session.run(
      `MATCH (g:Guidance)
       RETURN g.id AS id, g.text AS text, g.recordedAt AS recordedAt, g.recordedBy AS recordedBy
       ORDER BY g.recordedAt`,
    );
    return res.records.map((r) => ({
      id: r.get('id'),
      text: r.get('text'),
      recordedAt: r.get('recordedAt'),
      recordedBy: r.get('recordedBy'),
    }));
  } finally {
    await session.close();
  }
}

export async function deleteGuidance(id: string): Promise<boolean> {
  const session = getDriver().session();
  try {
    const res = await session.run(
      `MATCH (g:Guidance) WHERE g.id = $id OR g.text = $id DELETE g RETURN count(*) AS n`,
      { id },
    );
    return neo4j.int(res.records[0]?.get('n') ?? 0).toNumber() > 0;
  } finally {
    await session.close();
  }
}

/** Renders guidance for the classifier prompt. Empty string when none is recorded. */
export function renderGuidance(items: Guidance[]): string {
  if (items.length === 0) return '';
  return `
**Standing guidance from the maintainers.** These are corrections to earlier
classifications. Follow them over your own judgment:
${items.map((g) => `   - ${g.text}`).join('\n')}
`;
}

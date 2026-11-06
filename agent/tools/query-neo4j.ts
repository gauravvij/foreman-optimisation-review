import { createTool } from '@mastra/core/tools';
import neo4j from 'neo4j-driver';
import { z } from 'zod';
import { getDriver } from '../../src/services/neo4j';
import { checkCypherAgainstSchema } from './cypher-guard';

export const queryNeo4jTool = createTool({
  id: 'queryNeo4j',
  description:
    'Execute a read-only Cypher query against the Neo4j knowledge graph. ' +
    'Returns JSON rows. Always use LIMIT to keep results manageable. ' +
    'Build queries ONLY with the schema provided in your instructions. ' +
    'If execution returns an error, use the exact error message to correct the ' +
    'Cypher and retry the query before answering; never treat a failed query as ' +
    'empty data.',
  inputSchema: z.object({
    cypher: z.string().describe('A read-only Cypher query'),
  }),
  outputSchema: z.object({
    rows: z.array(z.record(z.unknown())),
    count: z.number(),
    error: z.string().optional(),
    warnings: z.array(z.string()).optional(),
  }),
  execute: async (input) => {
    // A reversed or impossible traversal returns zero rows without erroring,
    // which is indistinguishable from genuine absence by row count alone. Flag
    // it up front; the guard never alters the query or its result.
    const warnings = checkCypherAgainstSchema(input.cypher);
    const session = getDriver().session({
      defaultAccessMode: neo4j.session.READ,
    });
    try {
      console.log(`  [queryNeo4j] ${input.cypher.replace(/\n/g, ' ').slice(0, 120)}…`);
      for (const warning of warnings) {
        console.warn(`  [queryNeo4j] schema warning: ${warning}`);
      }
      const result = await session.run(input.cypher);
      const rows = result.records.map((r) => {
        const obj: Record<string, unknown> = {};
        for (const key of r.keys) {
          const k = String(key);
          const val = r.get(k);
          obj[k] = neo4j.isInt(val) ? val.toNumber() : val;
        }
        return obj;
      });
      console.log(`  [queryNeo4j] returned ${rows.length} rows`);
      // The warning travels with the result so the model sees it even when the
      // rows are empty — the one case the row count cannot distinguish.
      return warnings.length > 0
        ? { rows, count: rows.length, warnings }
        : { rows, count: rows.length };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  [queryNeo4j] error: ${msg}`);
      return warnings.length > 0
        ? { rows: [], count: 0, error: msg, warnings }
        : { rows: [], count: 0, error: msg };
    } finally {
      await session.close();
    }
  },
});

/**
 * Schema-aware Cypher guard.
 *
 * A reversed or impossible relationship traversal in Cypher is not a syntax
 * error. `MATCH (c:Comment)<-[:AUTHORED_BY]-(u:User)` parses fine, plans fine
 * and returns zero rows, which from the row count alone is indistinguishable
 * from "no such data exists". The agent has the schema in its prompt and still
 * writes these traversals, then reports the empty result as a confident
 * absence — the silent-empty-result defect.
 *
 * This guard re-reads a query's relationship patterns against the declared
 * schema and names the offending edge, so the tool result can carry the
 * distinction the row count cannot.
 *
 * Contract: it never rewrites the query and never changes rows, count or
 * error. It only produces warnings, and only when it can prove a traversal
 * contradicts the schema. Anything it cannot resolve (no relationship at all,
 * an unlabelled pattern with no binding, a relationship with no type) yields
 * no warning, so the guard stays quiet rather than crying wolf.
 */

export type SchemaEdge = { from: string; rel: string; to: string };

/**
 * The 21 relationships declared in `agent/instructions.ts` (the "# Database
 * Schema" section). Kept as an explicit literal because it is the contract the
 * prompt states; `cypher-guard.test.ts` asserts it still matches the prompt, so
 * the two cannot drift apart.
 */
export const SCHEMA_EDGES: readonly SchemaEdge[] = [
  { from: 'Issue', rel: 'HAS_COMMENT', to: 'Comment' },
  { from: 'Issue', rel: 'AUTHORED_BY', to: 'User' },
  { from: 'Issue', rel: 'ASSIGNED_TO', to: 'User' },
  { from: 'Issue', rel: 'HAS_LABEL', to: 'Label' },
  { from: 'Issue', rel: 'HAS_REACTION', to: 'Reaction' },
  { from: 'Comment', rel: 'AUTHORED_BY', to: 'User' },
  { from: 'Comment', rel: 'HAS_REACTION', to: 'Reaction' },
  { from: 'Comment', rel: 'HAS_WORKAROUND', to: 'Workaround' },
  { from: 'Comment', rel: 'HAS_SOLUTION', to: 'Solution' },
  { from: 'Comment', rel: 'MENTIONS_COMPETITOR', to: 'Competitor' },
  { from: 'Workaround', rel: 'HAS_KEYWORD', to: 'Keyword' },
  { from: 'Solution', rel: 'HAS_KEYWORD', to: 'Keyword' },
  { from: 'Issue', rel: 'MENTIONS_COMPETITOR', to: 'Competitor' },
  { from: 'Issue', rel: 'HAS_WORKAROUND', to: 'Workaround' },
  { from: 'Issue', rel: 'HAS_SOLUTION', to: 'Solution' },
  { from: 'Issue', rel: 'BELONGS_TO_CATEGORY', to: 'Category' },
  { from: 'Issue', rel: 'HAS_ASSESSMENT', to: 'Assessment' },
  { from: 'PullRequest', rel: 'AUTHORED_BY', to: 'User' },
  { from: 'PullRequest', rel: 'ASSIGNED_TO', to: 'User' },
  { from: 'PullRequest', rel: 'HAS_LABEL', to: 'Label' },
  { from: 'PullRequest', rel: 'CLOSES', to: 'Issue' },
];

type NodeRef = { variable?: string; label?: string };
type Direction = 'out' | 'in' | 'undirected';
type PatternEdge = {
  from: NodeRef;
  to: NodeRef;
  rel: string;
  direction: Direction;
};

/** `(i:Issue)`, `(:Label {name: 'x'})`, `(c)`, `()` — and nothing else. */
const NODE_RE =
  /^\s*([A-Za-z_][A-Za-z0-9_]*)?\s*((?::[A-Za-z_][A-Za-z0-9_]*)+)?\s*(?:\{[\s\S]*\})?\s*$/;

/**
 * Blank out comments and quoted literals, preserving every offset so the
 * returned string can still be sliced by the original indices. Without this a
 * property value like `'Easy to Fix'` or a `// comment` would be parsed as
 * Cypher structure.
 */
function sanitize(cypher: string): string {
  const chars = cypher.split('');
  let i = 0;
  while (i < chars.length) {
    const c = chars[i];
    if (c === '/' && chars[i + 1] === '/') {
      while (i < chars.length && chars[i] !== '\n') {
        chars[i] = ' ';
        i++;
      }
    } else if (c === '/' && chars[i + 1] === '*') {
      chars[i] = ' ';
      chars[i + 1] = ' ';
      i += 2;
      while (i < chars.length && !(chars[i] === '*' && chars[i + 1] === '/')) {
        chars[i] = ' ';
        i++;
      }
      if (i < chars.length) {
        chars[i] = ' ';
        chars[i + 1] = ' ';
        i += 2;
      }
    } else if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      chars[i] = ' ';
      i++;
      while (i < chars.length) {
        if (chars[i] === '\\') {
          chars[i] = ' ';
          if (i + 1 < chars.length) chars[i + 1] = ' ';
          i += 2;
          continue;
        }
        if (chars[i] === quote) {
          chars[i] = ' ';
          i++;
          break;
        }
        chars[i] = ' ';
        i++;
      }
    } else {
      i++;
    }
  }
  return chars.join('');
}

/** Read the balanced `( ... )` starting at `start`. */
function readParen(s: string, start: number): { content: string; end: number } | null {
  if (s[start] !== '(') return null;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') {
      depth--;
      if (depth === 0) return { content: s.slice(start + 1, i), end: i + 1 };
    }
  }
  return null;
}

/** Relationship types from inside `[...]`: `[r:T]`, `[:T]`, `[r:T|U]`, `[r]`. */
function parseRelTypes(inside: string): string[] {
  let body = inside;
  const brace = body.indexOf('{');
  if (brace >= 0) body = body.slice(0, brace);
  const star = body.indexOf('*');
  if (star >= 0) body = body.slice(0, star);
  body = body.trim();
  if (!body) return [];
  const colon = body.indexOf(':');
  if (colon < 0) return [];
  return body
    .slice(colon + 1)
    .split('|')
    .map((t) => t.trim().replace(/^:/, '').trim())
    .filter((t) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(t));
}

/**
 * Read a relationship token starting at `start`, which must point at `<` or
 * `-`. Returns null for anything that is not a relationship, including a bare
 * minus sign in an expression.
 */
function readRel(
  s: string,
  start: number,
): { types: string[]; direction: Direction; end: number } | null {
  let i = start;
  let incoming = false;
  if (s[i] === '<') {
    incoming = true;
    i++;
  }
  if (s[i] !== '-') return null;
  i++;
  let types: string[] = [];
  if (s[i] === '[') {
    const close = s.indexOf(']', i);
    if (close < 0) return null;
    types = parseRelTypes(s.slice(i + 1, close));
    i = close + 1;
  }
  if (s[i] !== '-') return null;
  i++;
  let outgoing = false;
  if (s[i] === '>') {
    outgoing = true;
    i++;
  }
  if (incoming && outgoing) return null;
  const direction: Direction = incoming ? 'in' : outgoing ? 'out' : 'undirected';
  return { types, direction, end: i };
}

function parseNode(content: string): NodeRef | null {
  const m = NODE_RE.exec(content);
  if (!m) return null;
  const label = m[2] ? m[2].split(':').filter(Boolean)[0] : undefined;
  return { variable: m[1] || undefined, label };
}

/**
 * Pull every `(node)-[:REL]->(node)` triple out of a query, in written order.
 * Variables are resolved through a binding map, so `MATCH (i:Issue) … MATCH
 * (i)-[:HAS_COMMENT]->(c:Comment)` still knows `i` is an Issue.
 */
export function extractPatternEdges(cypher: string): PatternEdge[] {
  const s = sanitize(cypher);
  const bindings = new Map<string, string>();
  const edges: PatternEdge[] = [];
  let prev: NodeRef | null = null;
  let i = 0;

  const note = (node: NodeRef): NodeRef => {
    if (node.variable && node.label) bindings.set(node.variable, node.label);
    return node;
  };

  while (i < s.length) {
    const ch = s[i];
    if (ch === '(') {
      const paren = readParen(s, i);
      if (paren) {
        const node = parseNode(paren.content);
        // A paren that is not node syntax (a function call, an expression) must
        // not silently inherit the previous node as a left operand.
        prev = node ? note(node) : null;
        i = paren.end;
        continue;
      }
      i++;
      continue;
    }
    if (ch === '<' || ch === '-') {
      const rel = readRel(s, i);
      if (rel && rel.types.length > 0) {
        let j = rel.end;
        while (j < s.length && /\s/.test(s[j])) j++;
        if (s[j] === '(') {
          const paren = readParen(s, j);
          const node = paren ? parseNode(paren.content) : null;
          if (paren && node) {
            note(node);
            if (prev) {
              for (const type of rel.types) {
                edges.push({ from: prev, to: node, rel: type, direction: rel.direction });
              }
            }
            prev = node;
            i = paren.end;
            continue;
          }
        }
        i = rel.end;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }

  // Resolve labels through the completed binding map, so a variable declared
  // later in the query still resolves for an earlier edge.
  return edges.map((edge) => ({
    ...edge,
    from: { ...edge.from, label: edge.from.label ?? bindings.get(edge.from.variable ?? '') },
    to: { ...edge.to, label: edge.to.label ?? bindings.get(edge.to.variable ?? '') },
  }));
}

function formatNode(node: NodeRef): string {
  if (node.variable && node.label) return `(${node.variable}:${node.label})`;
  if (node.label) return `(:${node.label})`;
  if (node.variable) return `(${node.variable})`;
  return '()';
}

function formatSchemaEdges(defs: readonly SchemaEdge[], rel: string): string {
  return defs.map((d) => `(${d.from})-[:${rel}]->(${d.to})`).join(' or ');
}

function hasEdge(from: string, rel: string, to: string): boolean {
  return SCHEMA_EDGES.some((e) => e.from === from && e.rel === rel && e.to === to);
}

/**
 * Check one directed traversal against the schema. Returns a warning string
 * naming the offending edge, or null when the traversal is consistent with the
 * schema — or when it cannot be judged.
 */
function checkEdge(edge: PatternEdge): string | null {
  const rel = edge.rel;
  const defs = SCHEMA_EDGES.filter((e) => e.rel === rel);
  const written = `${formatNode(edge.from)}-[:${rel}]->${formatNode(edge.to)}`;

  if (defs.length === 0) {
    return `Cypher traversal ${written} uses relationship type ${rel}, which the schema does not define. Check the relationship name before trusting the result.`;
  }

  const schemaForms = formatSchemaEdges(defs, rel);
  const impossible = () =>
    `Cypher traversal ${written} is impossible: the schema defines ${rel} only as ${schemaForms}. Nothing in the graph satisfies ${written}, so it returns zero rows, which looks exactly like the data being absent.`;

  // Normalise the arrow: an incoming arrow (A)<-[:R]-(B) asserts the traversal
  // B-[:R]->A, which is the orientation the schema must contain. An undirected
  // pattern (A)-[:R]-(B) asserts either orientation.
  let assertedFrom: NodeRef;
  let assertedTo: NodeRef;
  if (edge.direction === 'in') {
    assertedFrom = edge.to;
    assertedTo = edge.from;
  } else {
    assertedFrom = edge.from;
    assertedTo = edge.to;
  }

  const from = assertedFrom.label;
  const to = assertedTo.label;
  const asserted = `${formatNode(assertedFrom)}-[:${rel}]->${formatNode(assertedTo)}`;
  const reversed = () =>
    `Cypher traversal ${written} runs against the arrow: it asserts ${asserted}, but the schema has ${schemaForms}. A reversed arrow is not a syntax error — it silently returns zero rows, which looks exactly like the data being absent.`;

  if (edge.direction === 'undirected') {
    // Either orientation is legitimate; only warn if neither is possible.
    if (from && to) {
      if (hasEdge(from, rel, to) || hasEdge(to, rel, from)) return null;
      return impossible();
    }
    if (from && !to) {
      if (defs.some((d) => d.from === from || d.to === from)) return null;
      return impossible();
    }
    if (to && !from) {
      if (defs.some((d) => d.from === to || d.to === to)) return null;
      return impossible();
    }
    return null;
  }

  // Directed (after normalisation): the query asserts `from -[:rel]-> to`.
  if (from && to) {
    if (hasEdge(from, rel, to)) return null;
    if (hasEdge(to, rel, from)) return reversed();
    return impossible();
  }
  if (from && !to) {
    if (defs.some((d) => d.from === from)) return null;
    if (defs.some((d) => d.to === from)) return reversed();
    return impossible();
  }
  if (to && !from) {
    if (defs.some((d) => d.to === to)) return null;
    if (defs.some((d) => d.from === to)) return reversed();
    return impossible();
  }
  return null;
}

/**
 * Warnings for every relationship traversal in `cypher` that the schema does
 * not contain. Deterministic and side-effect free; returns `[]` for a query it
 * cannot fault, including one it cannot parse.
 */
export function checkCypherAgainstSchema(cypher: string): string[] {
  if (typeof cypher !== 'string' || cypher.length === 0) return [];
  let edges: PatternEdge[];
  try {
    edges = extractPatternEdges(cypher);
  } catch {
    // The guard must never turn a working query into a failure.
    return [];
  }
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const edge of edges) {
    const warning = checkEdge(edge);
    if (warning && !seen.has(warning)) {
      seen.add(warning);
      warnings.push(warning);
    }
  }
  return warnings;
}

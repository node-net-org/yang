/**
 * Leafref `path` arguments (RFC 7950 §9.9.2, §14):
 *
 *   path-arg        = absolute-path / relative-path
 *   absolute-path   = 1*("/" (node-identifier *path-predicate))
 *   relative-path   = 1*("../") descendant-path
 *   descendant-path = node-identifier [*path-predicate absolute-path]
 *   path-predicate  = "[" *WSP path-equality-expr *WSP "]"
 *
 * Predicates select list entries at run time. {@link parseLeafrefPath} gives
 * only the steps, checking that brackets balance; {@link leafrefPredicates}
 * gives each step's predicates, which the compiler checks against the schema.
 * Whitespace around steps is tolerated, as many published modules have it.
 */

const NODE_ID = /^(?:([A-Za-z_][A-Za-z0-9_.-]*):)?([A-Za-z_][A-Za-z0-9_.-]*)$/;

export interface ParsedPath {
  readonly absolute: boolean;
  readonly up: number;
  readonly steps: { readonly prefix?: string; readonly name: string }[];
}

/** Parses a leafref path, returning its steps or a message. */
export function parseLeafrefPath(text: string): ParsedPath | string {
  // Remove predicates, checking that brackets balance.
  let stripped = '';
  let depth = 0;
  let quote: string | undefined;
  for (const c of text) {
    if (quote !== undefined) {
      if (c === quote) quote = undefined;
      continue;
    }
    if (depth > 0 && (c === '"' || c === "'")) quote = c;
    else if (c === '[') depth++;
    else if (c === ']') {
      if (depth === 0) return "unbalanced ']'";
      depth--;
    } else if (depth === 0) stripped += c;
  }
  if (depth !== 0 || quote !== undefined) return "unbalanced '['";

  const s = stripped.replace(/\s+/g, '');
  if (s === '') return 'the path is empty';
  const absolute = s.startsWith('/');
  const parts = (absolute ? s.slice(1) : s).split('/');
  let up = 0;
  if (!absolute) {
    while (parts[0] === '..') {
      up++;
      parts.shift();
    }
    if (up === 0) return "a relative path must start with '../'";
  }
  if (parts.length === 0) return 'the path names no node';
  const steps: { prefix?: string; name: string }[] = [];
  for (const part of parts) {
    const m = NODE_ID.exec(part);
    if (m === null) return `'${part}' is not a node name`;
    steps.push(m[1] === undefined ? { name: m[2]! } : { prefix: m[1], name: m[2]! });
  }
  return { absolute, up, steps };
}

/** A node name in a leafref path, with its prefix if it has one. */
export interface PathName {
  readonly prefix?: string;
  readonly name: string;
}

/**
 * A leafref path predicate (RFC 7950 §9.9.2, §14):
 *
 *   path-equality-expr = node-identifier *WSP "=" *WSP path-key-expr
 *   path-key-expr      = current-function-invocation *WSP "/" *WSP
 *                        rel-path-keyexpr
 *   rel-path-keyexpr   = 1*(".." *WSP "/" *WSP)
 *                        *(node-identifier *WSP "/" *WSP)
 *                        node-identifier
 */
export interface PathPredicate {
  /** The list key on the left. */
  readonly key: PathName;
  /** Number of `..` steps after `current()`. */
  readonly up: number;
  /** The node names after the `..` steps. */
  readonly steps: readonly PathName[];
}

const PREDICATE = /^\s*([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*current\s*\(\s*\)\s*\/\s*((?:\.\.\s*\/\s*)+)((?:[A-Za-z_][A-Za-z0-9_.:-]*\s*\/\s*)*[A-Za-z_][A-Za-z0-9_.:-]*)\s*$/;

function pathName(text: string): PathName | undefined {
  const m = NODE_ID.exec(text.trim());
  if (m === null) return undefined;
  return m[1] === undefined ? { name: m[2]! } : { prefix: m[1], name: m[2]! };
}

/**
 * The predicates of each node step of a leafref path, in step order (one
 * entry per step of {@link parseLeafrefPath}'s result). A predicate outside
 * the path grammar is left out: the XPath check reports it as `invalid-path`.
 * Undefined when the path itself doesn't parse.
 */
export function leafrefPredicates(text: string): PathPredicate[][] | undefined {
  const parsed = parseLeafrefPath(text);
  if (typeof parsed === 'string') return undefined;
  // Split into steps at '/' outside brackets and quotes, keeping each step's bracketed parts.
  const steps: { name: string; predicates: string[] }[] = [];
  let current = { name: '', predicates: [] as string[] };
  let depth = 0;
  let quote: string | undefined;
  let inner = '';
  for (const c of text) {
    if (depth > 0) {
      if (quote !== undefined) {
        if (c === quote) quote = undefined;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '[') depth++;
      else if (c === ']' && --depth === 0) {
        current.predicates.push(inner);
        inner = '';
        continue;
      }
      inner += c;
    } else if (c === '[') depth = 1;
    else if (c === '/') {
      steps.push(current);
      current = { name: '', predicates: [] };
    } else current.name += c;
  }
  steps.push(current);
  const named = steps.filter((s) => s.name.trim() !== '' && s.name.trim() !== '..');
  if (named.length !== parsed.steps.length) return undefined;
  return named.map((s) =>
    s.predicates.flatMap((p) => {
      const m = PREDICATE.exec(p);
      if (m === null) return [];
      const key = pathName(m[1]!);
      const names = m[3]!.split('/').map(pathName);
      if (key === undefined || names.some((n) => n === undefined)) return [];
      return [{ key, up: (m[2]!.match(/\.\./g) ?? []).length, steps: names as PathName[] }];
    }),
  );
}

/**
 * Evaluating XPath against an instance tree, for callers: subtree and XPath
 * filters, YANG Push selections, tests. Validation uses the same engine.
 */

import type { DataTree, InstanceNode } from '../data/tree.js';
import type { Expr } from './ast.js';
import { XPathDocument } from './document.js';
import { Evaluator, type XPathValue } from './evaluate.js';
import { parseXPath } from './parser.js';

export interface XPathEvaluateOptions {
  /** The context node, and `current()`. Default: the root. */
  readonly context?: InstanceNode;
  /**
   * Prefix → module name. Default: every module's name and its YANG prefix
   * (the first module to claim a prefix keeps it), so both
   * `/ietf-interfaces:interfaces` and `/if:interfaces` work.
   */
  readonly prefixes?: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
  /** The module of unprefixed names. Default: none, so an unprefixed name matches a node of any module. */
  readonly defaultModule?: string;
  /** Variable bindings, by name (`prefix:name` for a qualified one). */
  readonly variables?: Readonly<Record<string, XPathValue>>;
  /**
   * Datastore data an RPC, action or notification tree's expressions can
   * see (RFC 7950 §6.4.1): an action hangs under the matching node of it.
   */
  readonly operational?: DataTree;
  /** How many nodes the evaluation may visit before it is stopped. Default 10 million. */
  readonly budget?: number;
}

/**
 * Evaluates an XPath 1.0 expression against a tree, with YANG's function
 * library. Returns a node-set (an array of instance nodes, and the tree
 * itself for the root, in document order), a string, a number or a boolean.
 * Throws {@link XPathError} for an expression that doesn't parse, or names an
 * unknown prefix, function or variable.
 */
export function evaluateXPath(tree: DataTree, expression: string | Expr, options: XPathEvaluateOptions = {}): XPathValue {
  const expr = typeof expression === 'string' ? parseXPath(expression) : expression;
  const doc = new XPathDocument(tree, { operational: options.operational });
  const ev = new Evaluator(doc, { variables: options.variables === undefined ? undefined : new Map(Object.entries(options.variables)), budget: options.budget });
  const context = options.context ?? tree;
  return ev.evaluate(expr, context, { prefixes: prefixMap(tree, options.prefixes), defaultModule: options.defaultModule }, context, typeof expression === 'string' ? expression : '');
}

function prefixMap(tree: DataTree, given: XPathEvaluateOptions['prefixes']): ReadonlyMap<string, string> {
  if (given instanceof Map) return given;
  if (given !== undefined) return new Map(Object.entries(given));
  const map = new Map<string, string>();
  for (const m of tree.schema.modules.values()) map.set(m.name, m.name);
  for (const m of tree.schema.modules.values()) if (!map.has(m.prefix)) map.set(m.prefix, m.name);
  return map;
}

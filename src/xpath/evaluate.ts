/**
 * XPath 1.0 evaluation over instance trees, with YANG's context rules
 * (RFC 7950 §6.4.1) and function library (§10).
 *
 * Values are XPath's four types: node-sets (arrays of {@link XNode}s in
 * document order, without duplicates), strings, numbers and booleans.
 *
 * - **Names.** A prefix in a name test is looked up in the expression's
 *   prefix → module map; an unprefixed name is in the default module (the
 *   module of the node the expression belongs to, RFC 7950 §6.4.1). With no
 *   default module, an unprefixed name matches a node of any module.
 * - **String values** of leaves are canonical (RFC 7950 §9): identityrefs
 *   are `module:identity` and instance-identifiers are in their RFC 7951
 *   form, as libyang gives them.
 * - **Comparing a node with a string.** The string is first read as a value
 *   of the leaf's type, with the expression's prefixes, and compared in
 *   canonical form, so `type = 'ianaift:ethernetCsmacd'` and `d = '1.50'`
 *   match as they mean to. This is libyang's behaviour; strings that aren't
 *   valid values are compared as they are.
 * - **Numbers** are IEEE doubles, as XPath defines them: 64-bit integers
 *   beyond 2^53 and decimal64 values with many digits lose precision when
 *   converted. Equality of node values compares canonical strings and so is
 *   exact.
 */

import { XPathError } from '../errors.js';
import type { Identity, LeafListNode, LeafNode, YangType } from '../schema/model.js';
import type { Schema } from '../schema/schema.js';
import { compileXsdRegex } from '../types/xsd-regex.js';
import type { XsdRegex } from '../types/xsd-match.js';
import { formatJson, parseText, scalarText, type ValueScope } from '../data/lexical.js';
import { DataTree, LeafInstance, LeafListEntry, AnyInstance, ListEntry, type InstanceNode } from '../data/tree.js';
import type { InstanceIdentifier, TypedValue } from '../data/value.js';
import type { Axis, Expr, NodeTest, Step } from './ast.js';
import { compiledXPath } from './check.js';
import type { XNode, XPathDocument } from './document.js';
import { sameValue } from '../data/lexical.js';

export type XPathValue = boolean | number | string | readonly XNode[];

/** What names in an expression mean. */
export interface XPathScope {
  /** Prefix → module name. */
  readonly prefixes: ReadonlyMap<string, string>;
  /** The module of unprefixed names. Undefined: any module. */
  readonly defaultModule: string | undefined;
}

export interface EvaluatorOptions {
  /** Variable bindings. YANG expressions have none. */
  readonly variables?: ReadonlyMap<string, XPathValue> | undefined;
  /**
   * How many nodes one evaluation may visit before it is stopped with an
   * {@link XPathError}, so that a hostile expression can't hang the caller.
   * Default 10 million.
   */
  readonly budget?: number | undefined;
}

interface Context {
  readonly node: XNode;
  readonly position: number;
  readonly size: number;
}

/** A node-set with whether it is known to be free of nested nodes (no node an ancestor of another). */
interface Nodes {
  nodes: XNode[];
  flat: boolean;
}

const DEFAULT_BUDGET = 10_000_000;

/** Types whose canonical form doesn't depend on prefixes, so their canonised strings can be cached. */
function prefixFree(t: YangType): boolean {
  if (t.builtin === 'identityref' || t.builtin === 'instance-identifier') return false;
  if (t.builtin === 'union') return (t.types ?? []).every(prefixFree);
  if (t.builtin === 'leafref') return t.target === undefined || prefixFree(t.target.type);
  return true;
}

/** The XPath string value of a typed value: its canonical form, identityrefs as `module:identity`. */
export function valueString(v: TypedValue): string {
  if (v.type.builtin === 'empty') return '';
  return scalarText(formatJson(v));
}

export class Evaluator {
  readonly #doc: XPathDocument;
  readonly #schema: Schema;
  readonly #variables: ReadonlyMap<string, XPathValue>;
  readonly #budget: number;
  #spent = 0;
  /** Called with each node a step selects, for tracking what an expression depends on. */
  onSelect: ((n: XNode) => void) | undefined;
  readonly #canonical = new Map<YangType, Map<string, string>>();
  readonly #strings = new Map<InstanceNode, string>();
  /** Indexes of children by the string value of one of their children, for `[key = value]` predicates. */
  #indexes = new Map<XNode, Map<string, Map<string, XNode[]>>>();
  readonly #regexps = new Map<string, XsdRegex>();

  constructor(doc: XPathDocument, options: EvaluatorOptions = {}) {
    this.#doc = doc;
    this.#schema = doc.root.schema;
    this.#variables = options.variables ?? new Map();
    this.#budget = options.budget ?? DEFAULT_BUDGET;
  }

  get document(): XPathDocument {
    return this.#doc;
  }

  /** Forgets cached indexes, after the tree has changed. */
  changed(): void {
    this.#indexes = new Map();
    this.#strings.clear();
    this.#doc.changed();
  }

  /**
   * Evaluates an expression with `context` as the context node and
   * `current()` (default: the context node). Throws {@link XPathError}.
   */
  evaluate(expr: Expr, context: XNode, scope: XPathScope, current: XNode = context, text = ''): XPathValue {
    // deref() evaluates a leafref path inside another evaluation, which shares its budget.
    if (this.#nesting === 0) this.#spent = 0;
    this.#nesting++;
    try {
      const run = new Run(this, this.#doc.viewFor(current), scope, current, text);
      return run.eval(expr, { node: context, position: 1, size: 1 });
    } finally {
      this.#nesting--;
    }
  }
  #nesting = 0;

  /** Evaluates and converts to a boolean, as `must` and `when` need. */
  test(expr: Expr, context: XNode, scope: XPathScope, current: XNode = context, text = ''): boolean {
    return toBoolean(this.evaluate(expr, context, scope, current, text));
  }

  // Shared services for runs.

  spend(n: number, text: string): void {
    this.#spent += n;
    if (this.#spent > this.#budget) throw new XPathError(`evaluation visited more than ${this.#budget} nodes and was stopped`, text);
  }

  variable(name: string, text: string): XPathValue {
    const v = this.#variables.get(name);
    if (v === undefined) throw new XPathError(`variable $${name} has no value`, text);
    return v;
  }

  get schema(): Schema {
    return this.#schema;
  }

  stringOf(n: XNode): string {
    if (n instanceof LeafInstance || n instanceof LeafListEntry) {
      let s = this.#strings.get(n);
      if (s === undefined) {
        s = valueString(n.value);
        this.#strings.set(n, s);
      }
      return s;
    }
    if (n instanceof AnyInstance) return anyText(n);
    // An inner node or the root: its descendants' text, in document order.
    let out = '';
    const stack: XNode[] = [n];
    while (stack.length > 0) {
      const x = stack.pop()!;
      if (x instanceof LeafInstance || x instanceof LeafListEntry || x instanceof AnyInstance) {
        out += this.stringOf(x);
        continue;
      }
      const kids = this.#doc.children(x);
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
    }
    return out;
  }

  /** A string compared with a leaf, in the leaf type's canonical form when it is a valid value. */
  canonise(s: string, n: XNode, scope: XPathScope): string {
    if (!(n instanceof LeafInstance || n instanceof LeafListEntry)) return s;
    const type = n.schema.type;
    const cacheable = prefixFree(type);
    let cache: Map<string, string> | undefined;
    if (cacheable) {
      cache = this.#canonical.get(type);
      if (cache === undefined) this.#canonical.set(type, (cache = new Map<string, string>()));
      const hit = cache.get(s);
      if (hit !== undefined) return hit;
    }
    const v = parseText(type, s, this.valueScope(scope));
    const out = typeof v === 'string' ? s : valueString(v);
    cache?.set(s, out);
    return out;
  }

  valueScope(scope: XPathScope): ValueScope {
    const schema = this.#schema;
    return {
      format: 'xml',
      schema,
      module: (p) => {
        const name = scope.prefixes.get(p);
        return name === undefined ? undefined : schema.module(name);
      },
      unprefixed: scope.defaultModule === undefined ? undefined : schema.module(scope.defaultModule),
    };
  }

  regexp(pattern: string, text: string): XsdRegex {
    let r = this.#regexps.get(pattern);
    if (r === undefined) {
      try {
        r = compileXsdRegex(pattern);
      } catch (e) {
        throw new XPathError(`re-match: invalid pattern ${JSON.stringify(pattern)}: ${(e as Error).message}`, text);
      }
      this.#regexps.set(pattern, r);
    }
    return r;
  }

  /** The children of `parent` matching a name test, indexed by the string values of their child `key`. */
  index(doc: XPathDocument, parent: XNode, test: string, matches: (n: XNode) => boolean, key: (n: XNode) => readonly XNode[]): Map<string, XNode[]> {
    let byTest = this.#indexes.get(parent);
    if (byTest === undefined) this.#indexes.set(parent, (byTest = new Map<string, Map<string, XNode[]>>()));
    let index = byTest.get(test);
    if (index === undefined) {
      index = new Map();
      for (const c of doc.children(parent)) {
        if (!matches(c)) continue;
        const seen = new Set<string>();
        for (const k of key(c)) {
          const s = this.stringOf(k);
          if (seen.has(s)) continue;
          seen.add(s);
          let list = index.get(s);
          if (list === undefined) index.set(s, (list = []));
          list.push(c);
        }
      }
      byTest.set(test, index);
    }
    return index;
  }
}

/** One evaluation: the view, scope and current node stay fixed while it runs. */
class Run {
  constructor(
    readonly ev: Evaluator,
    readonly doc: XPathDocument,
    readonly scope: XPathScope,
    readonly current: XNode,
    readonly text: string,
  ) {}

  fail(message: string): never {
    throw new XPathError(message, this.text);
  }

  eval(e: Expr, ctx: Context): XPathValue {
    switch (e.type) {
      case 'literal':
        return e.value;
      case 'number':
        return e.value;
      case 'variable':
        return this.ev.variable(e.prefix === undefined ? e.name : `${e.prefix}:${e.name}`, this.text);
      case 'negate':
        return -this.number(this.eval(e.operand, ctx));
      case 'binary':
        return this.binary(e.op, e.left, e.right, ctx);
      case 'call':
        return this.call(e, ctx);
      case 'filter': {
        const v = this.eval(e.primary, ctx);
        if (!isNodeSet(v)) this.fail('predicates can only filter a node-set');
        let nodes = [...v];
        for (const p of e.predicates) nodes = this.predicate(nodes, p);
        return nodes;
      }
      case 'path':
        return this.path(e.start, e.steps, ctx).nodes;
    }
  }

  binary(op: string, left: Expr, right: Expr, ctx: Context): XPathValue {
    switch (op) {
      case 'or':
        return toBoolean(this.eval(left, ctx)) || toBoolean(this.eval(right, ctx));
      case 'and':
        return toBoolean(this.eval(left, ctx)) && toBoolean(this.eval(right, ctx));
      case '|': {
        const a = this.eval(left, ctx);
        const b = this.eval(right, ctx);
        if (!isNodeSet(a) || !isNodeSet(b)) this.fail("'|' needs node-sets on both sides");
        return this.union(a, b);
      }
      case '+':
        return this.number(this.eval(left, ctx)) + this.number(this.eval(right, ctx));
      case '-':
        return this.number(this.eval(left, ctx)) - this.number(this.eval(right, ctx));
      case '*':
        return this.number(this.eval(left, ctx)) * this.number(this.eval(right, ctx));
      case 'div':
        return this.number(this.eval(left, ctx)) / this.number(this.eval(right, ctx));
      case 'mod':
        return this.number(this.eval(left, ctx)) % this.number(this.eval(right, ctx));
      default:
        return this.compare(op, this.eval(left, ctx), this.eval(right, ctx));
    }
  }

  union(a: readonly XNode[], b: readonly XNode[]): XNode[] {
    if (a.length === 0) return [...b];
    if (b.length === 0) return [...a];
    const set = new Set<XNode>(a);
    for (const n of b) set.add(n);
    return this.sorted([...set]);
  }

  sorted(nodes: XNode[]): XNode[] {
    if (nodes.length < 2) return nodes;
    const doc = this.doc;
    return nodes.sort((x, y) => doc.order(x) - doc.order(y));
  }

  /** XPath §3.4 comparisons. */
  compare(op: string, a: XPathValue, b: XPathValue): boolean {
    const aSet = isNodeSet(a);
    const bSet = isNodeSet(b);
    if (aSet && bSet) {
      if (op === '=' || op === '!=') {
        const right = new Set(b.map((n) => this.ev.stringOf(n)));
        if (op === '=') return a.some((n) => right.has(this.ev.stringOf(n)));
        if (a.length === 0 || right.size === 0) return false;
        if (right.size > 1) return true;
        const only = right.values().next().value;
        return a.some((n) => this.ev.stringOf(n) !== only);
      }
      const right = b.map((n) => toNumber(this.ev.stringOf(n)));
      return a.some((n) => {
        const x = toNumber(this.ev.stringOf(n));
        return right.some((y) => relational(op, x, y));
      });
    }
    if (aSet || bSet) {
      const set = (aSet ? a : b) as readonly XNode[];
      const other = aSet ? b : a;
      // With the node-set on the right, swap the operator's direction.
      const o = aSet ? op : FLIP[op]!;
      if (typeof other === 'boolean') return scalar(o, set.length > 0, other);
      if (typeof other === 'number') return set.some((n) => scalar(o, toNumber(this.ev.stringOf(n)), other));
      const s = other as string;
      if (o === '=' || o === '!=') return set.some((n) => (this.ev.stringOf(n) === this.ev.canonise(s, n, this.scope)) === (o === '='));
      const y = toNumber(s);
      return set.some((n) => relational(o, toNumber(this.ev.stringOf(n)), y));
    }
    return scalar(op, a, b);
  }

  number(v: XPathValue): number {
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'string') return toNumber(v);
    return v.length === 0 ? NaN : toNumber(this.ev.stringOf(v[0]!));
  }

  string(v: XPathValue): string {
    if (typeof v === 'string') return v;
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') return numberToString(v);
    return v.length === 0 ? '' : this.ev.stringOf(v[0]!);
  }

  nodeSet(v: XPathValue, fn: string): readonly XNode[] {
    if (!isNodeSet(v)) this.fail(`${fn}() needs a node-set argument`);
    return v;
  }

  // -------------------------------------------------------------------------
  // Paths

  path(start: 'root' | 'context' | Expr, steps: readonly Step[], ctx: Context): Nodes {
    let set: Nodes;
    if (start === 'root') set = { nodes: [this.doc.root], flat: true };
    else if (start === 'context') set = { nodes: [ctx.node], flat: true };
    else {
      const v = this.eval(start, ctx);
      if (!isNodeSet(v)) this.fail('a path can only continue from a node-set');
      set = { nodes: [...v], flat: v.length < 2 };
    }
    for (const step of steps) {
      if (set.nodes.length === 0) break;
      set = this.step(set, step);
    }
    return set;
  }

  step(input: Nodes, step: Step): Nodes {
    const out: XNode[] = [];
    const indexed = this.indexedStep(step);
    for (const node of input.nodes) {
      let nodes = indexed === undefined ? this.axis(node, step.axis, step.test) : indexed(node);
      const reverse = REVERSE.has(step.axis);
      const predicates = indexed === undefined ? step.predicates : step.predicates.slice(1);
      for (const p of predicates) nodes = this.predicate(nodes, p);
      if (reverse) nodes.reverse();
      for (const n of nodes) out.push(n);
    }
    const onSelect = this.ev.onSelect;
    if (onSelect !== undefined) for (const n of out) onSelect(n);
    if (input.nodes.length === 1) return { nodes: out, flat: input.flat && (step.axis === 'child' || step.axis === 'self' || step.axis === 'parent' || step.axis === 'attribute') };
    // Several context nodes: remove duplicates, and sort unless the result must already be in order.
    const unique = out.length < 2 ? out : [...new Set(out)];
    const ordered = input.flat && (step.axis === 'child' || step.axis === 'self' || step.axis === 'attribute');
    return { nodes: ordered && unique.length === out.length ? unique : this.sorted(unique), flat: ordered };
  }

  predicate(nodes: XNode[], p: Expr): XNode[] {
    if (nodes.length === 0) return nodes;
    if (p.type === 'number') return nodes.length >= p.value && Number.isInteger(p.value) && p.value > 0 ? [nodes[p.value - 1]!] : [];
    const size = nodes.length;
    return nodes.filter((node, i) => {
      const v = this.eval(p, { node, position: i + 1, size });
      return typeof v === 'number' ? v === i + 1 : toBoolean(v);
    });
  }

  /**
   * For a child step whose first predicate is `[name = expression]`, with
   * `name` a child of the selected nodes and `expression` independent of the
   * context node (a literal, an absolute path, or a path from current()):
   * selects the matching nodes through an index of the parent's children by
   * that child's value, instead of testing every child. This keeps leafref
   * paths and must expressions over large lists linear.
   */
  indexedStep(step: Step): ((n: XNode) => XNode[]) | undefined {
    if (step.axis !== 'child' || step.test.kind !== 'name') return undefined;
    const first = step.predicates[0];
    if (first?.type !== 'binary' || first.op !== '=') return undefined;
    let keyExpr: Expr | undefined;
    let valueExpr: Expr | undefined;
    if (isChildName(first.left) && independent(first.right)) [keyExpr, valueExpr] = [first.left, first.right];
    else if (isChildName(first.right) && independent(first.left)) [keyExpr, valueExpr] = [first.right, first.left];
    if (keyExpr === undefined || valueExpr === undefined || keyExpr.type !== 'path') return undefined;
    const keyTest = keyExpr.steps[0]!.test;
    const value = this.eval(valueExpr, { node: this.current, position: 1, size: 1 });
    if (typeof value === 'number' || typeof value === 'boolean') return undefined;
    const test = step.test;
    const matches = (n: XNode): boolean => this.matches(n, test);
    const keyOf = (n: XNode): XNode[] => this.doc.children(n).filter((c) => this.matches(c, keyTest));
    const id = `${this.module(test.prefix) ?? '*'}:${test.name}/${keyTest.kind === 'name' ? `${this.module(keyTest.prefix) ?? '*'}:${keyTest.name}` : '*'}`;
    return (parent) => {
      const kids = this.doc.children(parent);
      if (kids.length < 16) {
        // Small: test directly, without building an index.
        return this.predicate(this.axis(parent, 'child', test), first);
      }
      this.ev.spend(1, this.text);
      const index = this.ev.index(this.doc, parent, id, matches, keyOf);
      let wanted: string[];
      if (typeof value === 'string') {
        // Canonise the string per key leaf: every key leaf of these children has the same schema node.
        const sample = index.size > 0 ? this.sampleKey(parent, matches, keyOf) : undefined;
        wanted = [sample === undefined ? value : this.ev.canonise(value, sample, this.scope)];
      } else wanted = [...new Set(value.map((n) => this.ev.stringOf(n)))];
      const found: XNode[] = [];
      // Skip entries removed since the index was built (defaults whose when was false).
      for (const w of wanted) for (const n of index.get(w) ?? []) if (this.doc.parent(n) === parent) found.push(n);
      return wanted.length > 1 ? this.sorted([...new Set(found)]) : found;
    };
  }

  sampleKey(parent: XNode, matches: (n: XNode) => boolean, keyOf: (n: XNode) => XNode[]): XNode | undefined {
    for (const c of this.doc.children(parent)) if (matches(c)) return keyOf(c)[0];
    return undefined;
  }

  /** The nodes on an axis from `node` that pass the test, in proximity order (reverse axes nearest first). */
  axis(node: XNode, axis: Axis, test: NodeTest): XNode[] {
    const doc = this.doc;
    const out: XNode[] = [];
    let visited = 0;
    const take = (n: XNode): void => {
      visited++;
      if (this.matches(n, test)) out.push(n);
    };
    const descendants = (from: XNode): void => {
      const stack: XNode[] = [];
      const kids = doc.children(from);
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
      while (stack.length > 0) {
        const n = stack.pop()!;
        take(n);
        const k = doc.children(n);
        for (let i = k.length - 1; i >= 0; i--) stack.push(k[i]!);
        if (visited > 4096) {
          this.ev.spend(visited, this.text);
          visited = 0;
        }
      }
    };
    switch (axis) {
      case 'child':
        for (const c of doc.children(node)) take(c);
        break;
      case 'self':
        take(node);
        break;
      case 'parent': {
        const p = doc.parent(node);
        if (p !== undefined) take(p);
        break;
      }
      case 'descendant':
        descendants(node);
        break;
      case 'descendant-or-self':
        take(node);
        descendants(node);
        break;
      case 'ancestor':
      case 'ancestor-or-self':
        if (axis === 'ancestor-or-self') take(node);
        for (let p = doc.parent(node); p !== undefined; p = doc.parent(p)) take(p);
        break;
      case 'following-sibling':
      case 'preceding-sibling': {
        const p = doc.parent(node);
        if (p === undefined) break;
        const sibs = doc.children(p);
        const i = sibs.indexOf(node as InstanceNode);
        if (axis === 'following-sibling') for (let k = i + 1; k < sibs.length; k++) take(sibs[k]!);
        else for (let k = i - 1; k >= 0; k--) take(sibs[k]!);
        break;
      }
      case 'following':
        for (let a: XNode | undefined = node; a !== undefined; a = doc.parent(a)) {
          const p = doc.parent(a);
          if (p === undefined) break;
          const sibs = doc.children(p);
          for (let k = sibs.indexOf(a as InstanceNode) + 1; k < sibs.length; k++) {
            take(sibs[k]!);
            descendants(sibs[k]!);
          }
        }
        break;
      case 'preceding': {
        const before: XNode[] = [];
        for (let a: XNode | undefined = node; a !== undefined; a = doc.parent(a)) {
          const p = doc.parent(a);
          if (p === undefined) break;
          const sibs = doc.children(p);
          const i = sibs.indexOf(a as InstanceNode);
          const chunk: XNode[] = [];
          for (let k = 0; k < i; k++) {
            const stack: XNode[] = [sibs[k]!];
            while (stack.length > 0) {
              const n = stack.pop()!;
              chunk.push(n);
              const kids = doc.children(n);
              for (let j = kids.length - 1; j >= 0; j--) stack.push(kids[j]!);
            }
          }
          before.unshift(...chunk);
        }
        for (let k = before.length - 1; k >= 0; k--) take(before[k]!);
        break;
      }
      case 'attribute':
      case 'namespace':
        break;
    }
    this.ev.spend(visited, this.text);
    return out;
  }

  matches(n: XNode, test: NodeTest): boolean {
    switch (test.kind) {
      case 'node':
        return true;
      case 'name': {
        if (n instanceof DataTree || n.schema.name !== test.name) return false;
        const module = this.module(test.prefix);
        return module === undefined || n.schema.module.name === module;
      }
      case 'any': {
        if (n instanceof DataTree) return false;
        if (test.prefix === undefined) return true;
        return n.schema.module.name === this.module(test.prefix);
      }
      default:
        return false;
    }
  }

  module(prefix: string | undefined): string | undefined {
    if (prefix === undefined) return this.scope.defaultModule;
    const m = this.scope.prefixes.get(prefix);
    if (m === undefined) this.fail(`prefix '${prefix}' is not defined`);
    return m;
  }

  // -------------------------------------------------------------------------
  // Functions

  call(e: Extract<Expr, { type: 'call' }>, ctx: Context): XPathValue {
    if (e.prefix !== undefined) this.fail(`function ${e.prefix}:${e.name}() is not defined`);
    const args = e.args;
    const arg = (i: number): XPathValue => this.eval(args[i]!, ctx);
    const str = (i: number): string => (i < args.length ? this.string(arg(i)) : this.string([ctx.node]));
    const nodesArg = (i: number): readonly XNode[] => (i < args.length ? this.nodeSet(arg(i), e.name) : [ctx.node]);
    switch (e.name) {
      case 'last':
        return ctx.size;
      case 'position':
        return ctx.position;
      case 'count':
        return this.nodeSet(arg(0), 'count').length;
      case 'id':
        // YANG data has no ID attributes.
        arg(0);
        return [];
      case 'local-name': {
        const n = nodesArg(0)[0];
        return n === undefined || n instanceof DataTree ? '' : n.schema.name;
      }
      case 'namespace-uri': {
        const n = nodesArg(0)[0];
        return n === undefined || n instanceof DataTree ? '' : n.schema.module.namespace;
      }
      case 'name': {
        const n = nodesArg(0)[0];
        return n === undefined || n instanceof DataTree ? '' : `${n.schema.module.name}:${n.schema.name}`;
      }
      case 'string':
        return str(0);
      case 'concat':
        return args.map((_, i) => str(i)).join('');
      case 'starts-with':
        return str(0).startsWith(str(1));
      case 'contains':
        return str(0).includes(str(1));
      case 'substring-before': {
        const s = str(0);
        const i = s.indexOf(str(1));
        return i === -1 ? '' : s.slice(0, i);
      }
      case 'substring-after': {
        const s = str(0);
        const t = str(1);
        const i = s.indexOf(t);
        return i === -1 ? '' : s.slice(i + t.length);
      }
      case 'substring':
        return substring(str(0), this.number(arg(1)), args.length > 2 ? this.number(arg(2)) : Infinity);
      case 'string-length':
        return [...str(0)].length;
      case 'normalize-space':
        return str(0).replace(/[ \t\r\n]+/g, ' ').trim();
      case 'translate': {
        const from = [...str(1)];
        const to = [...str(2)];
        return [...str(0)]
          .map((c) => {
            const i = from.indexOf(c);
            return i === -1 ? c : (to[i] ?? '');
          })
          .join('');
      }
      case 'boolean':
        return toBoolean(arg(0));
      case 'not':
        return !toBoolean(arg(0));
      case 'true':
        return true;
      case 'false':
        return false;
      case 'lang':
        // YANG data carries no xml:lang.
        str(0);
        return false;
      case 'number':
        return args.length === 0 ? this.number([ctx.node]) : this.number(arg(0));
      case 'sum':
        return this.nodeSet(arg(0), 'sum').reduce((t, n) => t + toNumber(this.ev.stringOf(n)), 0);
      case 'floor':
        return Math.floor(this.number(arg(0)));
      case 'ceiling':
        return Math.ceil(this.number(arg(0)));
      case 'round':
        return round(this.number(arg(0)));
      case 'current':
        return [this.current];
      case 're-match':
        return this.ev.regexp(str(1), this.text).test(str(0));
      case 'deref':
        return this.deref(this.nodeSet(arg(0), 'deref'));
      case 'derived-from':
      case 'derived-from-or-self': {
        const nodes = this.nodeSet(arg(0), e.name);
        const base = this.identity(str(1));
        if (base === undefined) return false;
        const orSelf = e.name === 'derived-from-or-self';
        return nodes.some((n) => {
          const id = identityOf(n);
          return id !== undefined && ((orSelf && id === base) || base.derived.has(id));
        });
      }
      case 'enum-value': {
        const n = this.nodeSet(arg(0), 'enum-value')[0];
        if (!(n instanceof LeafInstance || n instanceof LeafListEntry) || n.value.type.builtin !== 'enumeration') return NaN;
        return n.value.type.enums?.find((x) => x.name === n.value.value)?.value ?? NaN;
      }
      case 'bit-is-set': {
        const n = this.nodeSet(arg(0), 'bit-is-set')[0];
        const bit = str(1);
        if (!(n instanceof LeafInstance || n instanceof LeafListEntry) || n.value.type.builtin !== 'bits') return false;
        return (n.value.value as readonly string[]).includes(bit);
      }
      default:
        return this.fail(`function ${e.name}() is not defined`);
    }
  }

  /** An identity named `prefix:name` (or `name`, in the default module) by the expression. */
  identity(ref: string): Identity | undefined {
    const colon = ref.indexOf(':');
    const moduleName = colon === -1 ? this.scope.defaultModule : this.scope.prefixes.get(ref.slice(0, colon));
    if (moduleName === undefined) return undefined;
    return this.ev.schema.module(moduleName)?.identities.get(colon === -1 ? ref : ref.slice(colon + 1));
  }

  /** deref() (RFC 7950 §10.3.1): the nodes a leafref or instance-identifier points to. */
  deref(nodes: readonly XNode[]): XNode[] {
    const n = nodes[0];
    if (!(n instanceof LeafInstance || n instanceof LeafListEntry)) return [];
    const leafref = leafrefMember(n.schema.type, n.value.type);
    if (leafref?.path !== undefined) return leafrefTargets(this.ev, n, leafref.path);
    if (n.value.type.builtin === 'instance-identifier') return instanceTargets(this.doc, n.value.value as InstanceIdentifier);
    return [];
  }
}

/** The instances a leafref leaf points to: its path from the leaf, keeping nodes with the leaf's value. */
export function leafrefTargets(ev: Evaluator, n: LeafInstance | LeafListEntry, path = n.schema.type.path!): XNode[] {
  const scope: XPathScope = { prefixes: path.prefixes, defaultModule: n.schema.module.name };
  const found = ev.evaluate(compiledXPath(path), n, scope, n, path.text);
  if (!isNodeSet(found)) return [];
  const want = ev.stringOf(n);
  return found.filter((t) => ev.stringOf(t) === want);
}

/** The nodes an instance-identifier names, in a document. */
export function instanceTargets(doc: XPathDocument, id: InstanceIdentifier): XNode[] {
  let at: XNode[] = [doc.root];
  for (const step of id.steps) {
    const next: XNode[] = [];
    for (const parent of at) {
      let matches = doc.children(parent).filter((c) => c.schema === step.node);
      if (step.keys !== undefined) {
        const keys = step.keys;
        matches = matches.filter((c) => c instanceof ListEntry && keys.every((k) => c.keys.some((x) => x.schema === k.key && sameValue(x.value, k.value))));
      }
      if (step.value !== undefined) {
        const v = step.value;
        matches = matches.filter((c) => c instanceof LeafListEntry && sameValue(c.value, v));
      }
      if (step.position !== undefined) matches = matches.slice(step.position - 1, step.position);
      next.push(...matches);
    }
    at = next;
    if (at.length === 0) break;
  }
  return at;
}

/**
 * The leafref a value was read through: the declared type itself, or the
 * union member that matched (a value keeps the type it was read as, which for
 * a leafref is its target's).
 */
export function leafrefMember(declared: YangType, read: YangType): YangType | undefined {
  if (declared.builtin === 'leafref') return declared;
  if (declared.builtin !== 'union') return undefined;
  for (const m of declared.types ?? []) {
    if (m === read) return undefined;
    if (m.builtin === 'leafref') {
      if (m.target !== undefined && readsAs(m.target.type, read)) return m;
    } else if (m.builtin === 'union' && readsAs(m, read)) return leafrefMember(m, read);
  }
  return undefined;
}

/** Whether a value read with type `t` can have the concrete type `read`. */
function readsAs(t: YangType, read: YangType): boolean {
  if (t === read) return true;
  if (t.builtin === 'leafref') return t.target !== undefined && readsAs(t.target.type, read);
  if (t.builtin === 'union') return (t.types ?? []).some((m) => readsAs(m, read));
  return false;
}

function identityOf(n: XNode): Identity | undefined {
  if (!(n instanceof LeafInstance || n instanceof LeafListEntry) || n.value.type.builtin !== 'identityref') return undefined;
  return n.value.value as Identity;
}

function anyText(n: AnyInstance): string {
  const c = n.content;
  if (c.format === 'json') return jsonText(c.value);
  let out = '';
  const stack = [...c.nodes].reverse();
  while (stack.length > 0) {
    const x = stack.pop()!;
    if (typeof x === 'string') out += x;
    else stack.push(...[...(x.children ?? [])].reverse());
  }
  return out;
}

function jsonText(v: unknown): string {
  if (v === null) return '';
  if (Array.isArray(v)) return v.map(jsonText).join('');
  if (typeof v === 'object') return Object.values(v).map(jsonText).join('');
  return scalarText(v);
}

const REVERSE = new Set<Axis>(['ancestor', 'ancestor-or-self', 'preceding', 'preceding-sibling']);
const FLIP: Record<string, string> = { '=': '=', '!=': '!=', '<': '>', '>': '<', '<=': '>=', '>=': '<=' };

export function isNodeSet(v: XPathValue): v is readonly XNode[] {
  return Array.isArray(v);
}

export function toBoolean(v: XPathValue): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0 && !Number.isNaN(v);
  if (typeof v === 'string') return v.length > 0;
  return v.length > 0;
}

/** XPath number(string) (§4.4): optional whitespace, an optional minus, digits with an optional point. */
export function toNumber(s: string): number {
  const t = s.trim();
  return /^-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/.test(t) ? Number(t) : NaN;
}

/** XPath string(number) (§4.2): no exponent, no trailing `.0`, NaN and Infinity by name. */
export function numberToString(n: number): string {
  if (Number.isNaN(n)) return 'NaN';
  if (n === Infinity) return 'Infinity';
  if (n === -Infinity) return '-Infinity';
  if (Object.is(n, -0) || n === 0) return '0';
  const s = String(n);
  if (!s.includes('e')) return s;
  const neg = n < 0;
  const [mantissa, exp] = String(Math.abs(n)).split('e') as [string, string];
  const e = Number(exp);
  const [int, frac = ''] = mantissa.split('.') as [string, string?];
  const digits = int + frac;
  const point = int.length + e;
  let out: string;
  if (point <= 0) out = `0.${'0'.repeat(-point)}${digits}`;
  else if (point >= digits.length) out = digits + '0'.repeat(point - digits.length);
  else out = `${digits.slice(0, point)}.${digits.slice(point)}`;
  return (neg ? '-' : '') + out;
}

function relational(op: string, x: number, y: number): boolean {
  switch (op) {
    case '<':
      return x < y;
    case '>':
      return x > y;
    case '<=':
      return x <= y;
    default:
      return x >= y;
  }
}

/** Comparison of two values neither of which is a node-set (§3.4). */
function scalar(op: string, a: XPathValue, b: XPathValue): boolean {
  if (op === '=' || op === '!=') {
    let eq: boolean;
    if (typeof a === 'boolean' || typeof b === 'boolean') eq = toBoolean(a) === toBoolean(b);
    else if (typeof a === 'number' || typeof b === 'number') eq = num(a) === num(b);
    else eq = a === b;
    return op === '=' ? eq : !eq;
  }
  return relational(op, num(a), num(b));
}

function num(v: XPathValue): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') return toNumber(v);
  return NaN;
}

/** XPath round() (§4.4): halves round towards positive infinity; -0.5 ≤ x < 0 gives -0. */
function round(x: number): number {
  if (!Number.isFinite(x)) return x;
  if (x < 0 && x >= -0.5) return -0;
  return Math.floor(x + 0.5);
}

/** XPath substring() (§4.2), with its rounding and NaN rules, counting characters (code points). */
function substring(s: string, start: number, length: number): string {
  const chars = [...s];
  const first = round(start);
  const last = first + round(length);
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const pos = i + 1;
    if (pos >= first && pos < last) out += chars[i]!;
  }
  return out;
}

function isChildName(e: Expr): boolean {
  if (e.type !== 'path' || e.start !== 'context' || e.steps.length !== 1) return false;
  const s = e.steps[0]!;
  return s.axis === 'child' && s.test.kind === 'name' && s.predicates.length === 0;
}

/** True when an expression's value doesn't depend on the context node, position or size. */
function independent(e: Expr): boolean {
  switch (e.type) {
    case 'literal':
    case 'number':
    case 'variable':
      return true;
    case 'negate':
      return independent(e.operand);
    case 'binary':
      return independent(e.left) && independent(e.right);
    case 'call':
      if (e.name === 'current') return true;
      if (e.name === 'last' || e.name === 'position') return false;
      // Functions that default to the context node.
      if (e.args.length === 0 && ['string', 'number', 'string-length', 'normalize-space', 'local-name', 'name', 'namespace-uri'].includes(e.name)) return false;
      return e.args.every(independent);
    case 'filter':
      return independent(e.primary);
    case 'path':
      return e.start === 'root' || (typeof e.start === 'object' && independent(e.start));
  }
}

/** For leaves and leaf-lists: their schema node, typed. */
export type ValueNode = LeafNode | LeafListNode;

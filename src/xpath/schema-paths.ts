/**
 * Compile-time analysis of the location paths in `must` and `when`
 * expressions against the compiled schema (RFC 7950 §6.4.1), and of `when`
 * conditions that depend on each other.
 *
 * Each expression is evaluated abstractly: instead of instance nodes, a
 * path selects the schema nodes its instances could be. Choice, case,
 * input and output don't appear in data, so paths step through them. A step
 * that can select nothing is reported as a warning, never an error.
 *
 * The analysis must not warn about a path that can match, so it gives up
 * silently wherever it can't be sure: after a wildcard or node-type test, on
 * the sibling, following, preceding, attribute and namespace axes, on a path
 * that starts from a function result other than `current()`, inside anydata,
 * anyxml and mount points, and where an if-feature or deviation removed
 * nodes from the parent it searched.
 */

import type { CompiledModule, Must, SchemaNode, WhenCondition, XPathExpression } from '../schema/model.js';
import { schemaPath } from '../schema/query.js';
import type { Expr, Step } from './ast.js';
import { compiledXPath } from './check.js';
import { nodeStatus, statusReference, type StatusReferenceCode } from '../schema/status.js';

/** A problem found, for the compiler to report at the expression's location. */
export interface SchemaPathProblem {
  readonly code: 'xpath-unknown-node' | 'xpath-state-from-config' | 'xpath-not-implemented' | 'when-cycle' | StatusReferenceCode;
  readonly message: string;
  readonly expression: XPathExpression;
}

export interface SchemaPathScope {
  /** The implemented modules, whose top data nodes are the datastore's. */
  readonly implemented: readonly CompiledModule[];
  /** A loaded module by name: the implemented revision if there is one. */
  module(name: string): CompiledModule | undefined;
  /**
   * Whether an if-feature or a deviation removed something from this node
   * (or module, at the top level), so a name missing from it may be meant.
   */
  incomplete(parent: object): boolean;
  /** The top nodes of the structure a top node belongs to, if it is a structure's. */
  structure(top: SchemaNode): readonly SchemaNode[] | undefined;
}

const ROOT = { kind: 'root' } as const;
type Root = typeof ROOT;
type Pos = SchemaNode | Root;

/** Positions a path can select. `exact` is false when some it could select are unknown. */
interface Selection {
  readonly nodes: readonly Pos[];
  readonly exact: boolean;
}

const UNKNOWN: Selection = { nodes: [], exact: false };
const TRANSPARENT = new Set(['choice', 'case', 'input', 'output']);
const OPERATIONS = new Set(['rpc', 'action', 'notification']);
const DATA_KINDS = new Set(['container', 'list', 'leaf', 'leaf-list', 'anydata', 'anyxml']);
/** How many schema nodes one descendant search may visit before it gives up. */
const DESCENDANT_BUDGET = 50_000;

/** Children not known from the schema: anydata, anyxml, a mount point. */
const OPAQUE = Symbol('opaque');

/**
 * Analyses every `must` and `when` in the trees under `tops`: data nodes,
 * operations, notifications and structures of the implemented modules.
 */
export function analyseSchemaPaths(tops: readonly SchemaNode[], scope: SchemaPathScope): SchemaPathProblem[] {
  const analyser = new Analyser(scope);
  const stack = [...tops];
  while (stack.length > 0) {
    const node = stack.pop()!;
    analyser.node(node);
    for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]!);
  }
  analyser.cycles();
  return analyser.problems;
}

/** One `when`'s dependencies on other nodes, found while analysing it. */
interface WhenUse {
  readonly holder: SchemaNode;
  readonly expression: WhenCondition;
  readonly selected: Set<SchemaNode>;
}

class Analyser {
  readonly problems: SchemaPathProblem[] = [];
  readonly #scope: SchemaPathScope;
  readonly #datastore: SchemaNode[];
  readonly #byName = new WeakMap<SchemaNode, Map<string, SchemaNode[]>>();
  readonly #incomplete = new WeakMap<SchemaNode, boolean>();
  readonly #whens: WhenUse[] = [];
  readonly #statusChecked = new WeakSet<Must | WhenCondition>();

  constructor(scope: SchemaPathScope) {
    this.#scope = scope;
    this.#datastore = scope.implemented.flatMap((m) => m.dataNodes as readonly SchemaNode[]);
  }

  node(node: SchemaNode): void {
    for (const m of node.must) {
      const context = node.kind === 'input' || node.kind === 'output' ? node.parent! : node;
      const selected = new Set<SchemaNode>();
      this.#expression(m, node, context, 'must', selected);
      this.#status(m, node, 'must', selected);
    }
    for (const w of node.when) {
      const context = w.from === 'node' && DATA_KINDS.has(node.kind) ? node : (dataParent(node) ?? ROOT);
      const selected = new Set<SchemaNode>();
      this.#expression(w, node, context, 'when', selected);
      this.#status(w, node, 'when', selected);
      if (selected.size > 0) this.#whens.push({ holder: node, expression: w, selected });
    }
  }

  /**
   * Warns, once per expression, when it selects a node less current than
   * the node it is on (RFC 7950 §7.21.2), naming the first such node.
   * An expression is analysed once, at the first node it is on.
   */
  #status(x: Must | WhenCondition, holder: SchemaNode, keyword: 'must' | 'when', selected: ReadonlySet<SchemaNode>): void {
    if (this.#statusChecked.has(x)) return;
    this.#statusChecked.add(x);
    const from = { status: nodeStatus(holder), module: holder.module.name, describe: `${keyword} of ${holder.kind} '${holder.name}'` };
    if (from.status === 'obsolete') return;
    for (const n of selected) {
      const problem = statusReference(from, { status: nodeStatus(n), module: n.module.name, describe: `${n.kind} '${n.name}'` });
      if (problem !== undefined) {
        this.report({ ...problem, expression: x });
        return;
      }
    }
  }

  #expression(x: Must | WhenCondition, holder: SchemaNode, context: Pos, keyword: 'must' | 'when', selected?: Set<SchemaNode>): void {
    let ast: Expr;
    try {
      ast = compiledXPath(x);
    } catch {
      return; // reported by checkXPath
    }
    new Evaluation(this, x, holder, context, keyword, selected).run(ast);
  }

  report(problem: SchemaPathProblem): void {
    this.problems.push(problem);
  }

  get scope(): SchemaPathScope {
    return this.#scope;
  }

  get datastore(): readonly SchemaNode[] {
    return this.#datastore;
  }

  /** Data children named `name`, operations included, looking through choice, case, input and output. */
  named(node: SchemaNode, name: string): readonly SchemaNode[] {
    let map = this.#byName.get(node);
    if (map === undefined) {
      map = new Map();
      for (const c of dataChildren(node)) {
        const list = map.get(c.name);
        if (list === undefined) map.set(c.name, [c]);
        else list.push(c);
      }
      this.#byName.set(node, map);
    }
    return map.get(name) ?? [];
  }

  /** Whether an if-feature or deviation removed something from the node or a choice, case, input or output inside it. */
  incomplete(node: SchemaNode): boolean {
    let r = this.#incomplete.get(node);
    if (r === undefined) {
      r = this.#scope.incomplete(node) || node.children.some((c) => TRANSPARENT.has(c.kind) && this.incomplete(c));
      this.#incomplete.set(node, r);
    }
    return r;
  }

  /**
   * `when` conditions that depend on each other (RFC 7950 §7.21.5 can't
   * evaluate them). A `when` on H depends on K when it selects a node N
   * and K has a `when` and is N or above N, below where N's and H's
   * branches meet. Selecting H itself, or a node below it, is a cycle of
   * one. libyang rejects such modules; here they are warnings.
   */
  cycles(): void {
    const edges = new Map<SchemaNode, Map<SchemaNode, WhenCondition>>();
    const self = new Map<SchemaNode, WhenCondition>();
    for (const use of this.#whens) {
      let out = edges.get(use.holder);
      // H's ancestors: H can't exist without them, so depending on their whens is no cycle.
      const meet = new Set<SchemaNode>();
      for (let a = use.holder.parent; a !== undefined; a = a.parent) meet.add(a);
      for (const n of use.selected) {
        if (isAtOrBelow(n, use.holder)) {
          if (!self.has(use.holder)) self.set(use.holder, use.expression);
          continue;
        }
        for (let k: SchemaNode | undefined = n; k !== undefined && !meet.has(k); k = k.parent) {
          if (k.when.length === 0) continue;
          if (out === undefined) edges.set(use.holder, (out = new Map<SchemaNode, WhenCondition>()));
          if (!out.has(k)) out.set(k, use.expression);
        }
      }
    }
    for (const [holder, expression] of self) {
      this.report({ code: 'when-cycle', expression, message: `the when ${JSON.stringify(expression.text)} of ${describe(holder)} depends on the node itself or what is inside it, so it can't be evaluated (libyang rejects this)` });
    }
    for (const scc of stronglyConnected(edges)) {
      if (scc.length < 2) continue;
      const members = new Set(scc);
      const start = scc.reduce((a, b) => (schemaPath(a) <= schemaPath(b) ? a : b));
      const cycle = cycleThrough(start, members, edges);
      const expression = edges.get(start)!.get(cycle[1]!)!;
      this.report({ code: 'when-cycle', expression, message: `when conditions depend on each other: ${cycle.map(describe).join(' → ')} (libyang rejects this)` });
    }
  }
}

class Evaluation {
  readonly #a: Analyser;
  readonly #x: Must | WhenCondition;
  readonly #holder: SchemaNode;
  readonly #context: Selection;
  readonly #keyword: string;
  readonly #selected: Set<SchemaNode> | undefined;
  readonly #defaultModule: string;
  /** The operations and the input or output the expression is inside, which it alone can see. */
  readonly #inside = new Set<SchemaNode>();
  readonly #rootChildren: readonly SchemaNode[];
  readonly #config: boolean;
  readonly #reported = new Set<string>();

  constructor(a: Analyser, x: Must | WhenCondition, holder: SchemaNode, context: Pos, keyword: string, selected: Set<SchemaNode> | undefined) {
    this.#a = a;
    this.#x = x;
    this.#holder = holder;
    this.#context = { nodes: [context], exact: true };
    this.#keyword = keyword;
    this.#selected = selected;
    this.#defaultModule = holder.module.name;
    let top: SchemaNode = holder;
    for (let n: SchemaNode | undefined = holder; n !== undefined; n = n.parent) {
      if (OPERATIONS.has(n.kind) || n.kind === 'input' || n.kind === 'output') this.#inside.add(n);
      top = n;
    }
    const structure = a.scope.structure(top);
    const roots: SchemaNode[] = [...(structure ?? []), ...a.datastore];
    if (OPERATIONS.has(top.kind)) roots.push(top);
    this.#rootChildren = roots;
    this.#config = holder.config && structure === undefined;
  }

  run(ast: Expr): void {
    this.#eval(ast, this.#context);
  }

  /** Analyses an expression evaluated with `context`; returns what it selects, if it is a node-set. */
  #eval(e: Expr, context: Selection): Selection {
    switch (e.type) {
      case 'path': {
        let start: Selection;
        if (e.start === 'root') start = { nodes: [ROOT], exact: true };
        else if (e.start === 'context') start = context;
        else start = this.#eval(e.start, context);
        return this.#steps(start, e.steps);
      }
      case 'binary': {
        const left = this.#eval(e.left, context);
        const right = this.#eval(e.right, context);
        if (e.op !== '|') return UNKNOWN;
        return { nodes: [...new Set([...left.nodes, ...right.nodes])], exact: left.exact && right.exact };
      }
      case 'negate':
        this.#eval(e.operand, context);
        return UNKNOWN;
      case 'call':
        for (const arg of e.args) this.#eval(arg, context);
        if (e.prefix === undefined && e.name === 'current' && e.args.length === 0) return this.#context;
        return UNKNOWN;
      case 'filter': {
        const primary = this.#eval(e.primary, context);
        for (const p of e.predicates) this.#eval(p, primary);
        return primary;
      }
      default:
        return UNKNOWN;
    }
  }

  #steps(start: Selection, steps: readonly Step[]): Selection {
    let current = start;
    for (const step of steps) {
      if (current.exact && current.nodes.length === 0) return current;
      current = current.nodes.length === 0 ? UNKNOWN : this.#step(current, step);
      // Predicates filter what the step selects; the paths in them start from it.
      for (const p of step.predicates) this.#eval(p, current.nodes.length === 0 ? UNKNOWN : current);
    }
    return current;
  }

  #step(input: Selection, step: Step): Selection {
    const test = step.test;
    if (test.kind === 'node') {
      switch (step.axis) {
        case 'self':
          this.#select(input.nodes);
          return input;
        case 'parent':
          return this.#parents(input);
        case 'descendant-or-self':
          return this.#descendants(input, true, undefined);
        case 'descendant':
          return this.#descendants(input, false, undefined);
        default:
          return UNKNOWN;
      }
    }
    if (test.kind !== 'name') return UNKNOWN;
    let moduleName: string;
    if (test.prefix === undefined) moduleName = this.#defaultModule;
    else {
      const m = this.#x.prefixes.get(test.prefix);
      if (m === undefined) return UNKNOWN; // reported by checkXPath
      moduleName = m;
    }
    const module = this.#a.scope.module(moduleName);
    if (module === undefined) return UNKNOWN;
    const named = { name: test.name, module: moduleName };
    switch (step.axis) {
      case 'child':
        return this.#children(input, named, step, module);
      case 'self': {
        const found = input.nodes.filter((p) => p.kind !== 'root' && p.name === named.name && p.module.name === named.module);
        this.#select(found);
        return { nodes: found, exact: input.exact };
      }
      case 'parent': {
        const parents = this.#parents(input);
        return { nodes: parents.nodes.filter((p) => p.kind !== 'root' && p.name === named.name && p.module.name === named.module), exact: parents.exact };
      }
      case 'ancestor':
      case 'ancestor-or-self': {
        const found = new Set<Pos>();
        for (const p of input.nodes) {
          let n: Pos | undefined = step.axis === 'ancestor' ? up(p) : p;
          for (; n !== undefined && n.kind !== 'root'; n = up(n)) if (n.name === named.name && n.module.name === named.module) found.add(n);
        }
        return { nodes: [...found], exact: input.exact };
      }
      case 'descendant':
      case 'descendant-or-self': {
        const result = this.#descendants(input, step.axis === 'descendant-or-self', named);
        if (result.nodes.length === 0 && result.exact) this.#missing(step, module, `matches no descendant ${where(input.nodes, 'of')}`);
        return result;
      }
      default:
        return UNKNOWN;
    }
  }

  #children(input: Selection, named: { name: string; module: string }, step: Step, module: CompiledModule): Selection {
    let exact = input.exact;
    const found: SchemaNode[] = [];
    const state: SchemaNode[] = [];
    for (const p of input.nodes) {
      const kids = this.#candidates(p, named.name);
      if (kids === OPAQUE) {
        exact = false;
        continue;
      }
      let any = false;
      for (const c of kids) {
        if (c.module.name !== named.module) continue;
        any = true;
        if (this.#config && !c.config) state.push(c);
        else found.push(c);
      }
      if (!any && (p.kind === 'root' ? this.#a.scope.incomplete(module) : this.#a.incomplete(p))) exact = false;
    }
    this.#select(found);
    if (found.length === 0 && exact) {
      if (!module.implemented) this.#report('xpath-not-implemented', `'${show(step)}' is in module ${module.name}, which is not implemented, so it has no data`);
      else if (state.length > 0) this.#report('xpath-state-from-config', `'${show(step)}' is state data, which a ${this.#keyword} on configuration can't see`);
      else this.#missing(step, module, `matches no node ${where(input.nodes, 'in')}`);
    }
    return { nodes: found, exact };
  }

  /** The children of a position named `name`, as the expression can see them. */
  #candidates(p: Pos, name: string): readonly SchemaNode[] | typeof OPAQUE {
    if (p.kind === 'root') return this.#rootChildren.filter((c) => c.name === name);
    if (p.kind === 'anydata' || p.kind === 'anyxml' || isMountPoint(p)) return OPAQUE;
    if (p.kind === 'rpc' || p.kind === 'action') {
      // Only the side (input or output) the expression is in.
      const side = p.children.find((c) => this.#inside.has(c));
      return side === undefined ? [] : this.#a.named(side, name);
    }
    return this.#a.named(p, name).filter((c) => !OPERATIONS.has(c.kind) || this.#inside.has(c));
  }

  #parents(input: Selection): Selection {
    const out = new Set<Pos>();
    // The root has no parent; the others always have one.
    for (const p of input.nodes) if (p.kind !== 'root') out.add(up(p) ?? ROOT);
    if (out.size === 0 && input.exact) this.#report('xpath-unknown-node', `'..' climbs above the root`);
    return { nodes: [...out], exact: input.exact };
  }

  /** The descendants (and, with `self`, the positions themselves), all or those with a name. */
  #descendants(input: Selection, self: boolean, named: { name: string; module: string } | undefined): Selection {
    let exact = input.exact;
    const out = new Set<Pos>();
    const matches = (n: Pos): boolean => named === undefined || (n.kind !== 'root' && n.name === named.name && n.module.name === named.module);
    let budget = DESCENDANT_BUDGET;
    const stack: Pos[] = [];
    for (const p of input.nodes) {
      if (self && matches(p)) out.add(p);
      stack.push(p);
    }
    const seen = new Set<Pos>();
    while (stack.length > 0) {
      const p = stack.pop()!;
      if (seen.has(p)) continue;
      seen.add(p);
      if (--budget < 0) return UNKNOWN;
      if (p.kind === 'root') {
        if (this.#a.scope.implemented.some((m) => this.#a.scope.incomplete(m))) exact = false;
      } else if (this.#a.incomplete(p)) exact = false;
      const kids = this.#allChildren(p);
      if (kids === OPAQUE) {
        exact = false;
        continue;
      }
      for (const c of kids) {
        if (this.#config && !c.config) continue;
        if (matches(c)) out.add(c);
        stack.push(c);
      }
    }
    const nodes = [...out];
    this.#select(nodes);
    return { nodes, exact };
  }

  #allChildren(p: Pos): readonly SchemaNode[] | typeof OPAQUE {
    if (p.kind === 'root') return this.#rootChildren;
    if (p.kind === 'anydata' || p.kind === 'anyxml' || isMountPoint(p)) return OPAQUE;
    if (p.kind === 'rpc' || p.kind === 'action') {
      const side = p.children.find((c) => this.#inside.has(c));
      return side === undefined ? [] : dataChildren(side);
    }
    return dataChildren(p).filter((c) => !OPERATIONS.has(c.kind) || this.#inside.has(c));
  }

  /** Records the nodes an expression selects: for when cycles and status references. */
  #select(nodes: readonly Pos[]): void {
    if (this.#selected === undefined) return;
    for (const n of nodes) if (n.kind !== 'root') this.#selected.add(n);
  }

  #missing(step: Step, module: CompiledModule, what: string): void {
    if (!module.implemented) {
      this.#report('xpath-not-implemented', `'${show(step)}' is in module ${module.name}, which is not implemented, so it has no data`);
      return;
    }
    this.#report('xpath-unknown-node', `'${show(step)}' ${what}`);
  }

  #report(code: SchemaPathProblem['code'], detail: string): void {
    const message = `${this.#keyword} ${JSON.stringify(this.#x.text)} of ${describe(this.#holder)}: ${detail}`;
    if (this.#reported.has(message)) return;
    this.#reported.add(message);
    this.#a.report({ code, message, expression: this.#x });
  }
}

function show(step: Step): string {
  const t = step.test;
  return t.kind === 'name' ? (t.prefix === undefined ? t.name : `${t.prefix}:${t.name}`) : t.kind;
}

/** The node an expression belongs to: its data path, and for a choice or case, which one. */
function describe(n: SchemaNode): string {
  return n.kind === 'choice' || n.kind === 'case' ? `${n.kind} '${n.name}' in ${schemaPath(n)}` : schemaPath(n);
}

function where(nodes: readonly Pos[], preposition: string): string {
  const names = nodes.map((p) => (p.kind === 'root' ? (preposition === 'in' ? 'at the top level' : 'of the root') : `${preposition} ${schemaPath(p)}`));
  return names.length <= 3 ? names.join(' or ') : `${names.slice(0, 3).join(', ')} or ${names.length - 3} other places`;
}

function up(p: Pos): Pos | undefined {
  if (p.kind === 'root') return undefined;
  return dataParent(p) ?? ROOT;
}

function isMountPoint(n: SchemaNode): boolean {
  return n.extensions.some((e) => e.name === 'mount-point' && e.module === 'ietf-yang-schema-mount');
}

/** The data parent: skips choice, case, input and output, which don't appear in data. */
function dataParent(node: SchemaNode): SchemaNode | undefined {
  let p = node.parent;
  while (p !== undefined && TRANSPARENT.has(p.kind)) p = p.parent;
  return p;
}

/** Data children: looks through choice, case, input and output. */
function dataChildren(node: SchemaNode): SchemaNode[] {
  const out: SchemaNode[] = [];
  for (const c of node.children) {
    if (TRANSPARENT.has(c.kind)) out.push(...dataChildren(c));
    else out.push(c);
  }
  return out;
}

function isAtOrBelow(n: SchemaNode, top: SchemaNode): boolean {
  for (let k: SchemaNode | undefined = n; k !== undefined; k = k.parent) if (k === top) return true;
  return false;
}

/** Tarjan's algorithm, iteratively. */
function stronglyConnected<T>(edges: ReadonlyMap<T, ReadonlyMap<T, unknown>>): T[][] {
  const index = new Map<T, number>();
  const low = new Map<T, number>();
  const onStack = new Set<T>();
  const stack: T[] = [];
  const out: T[][] = [];
  let next = 0;
  for (const root of edges.keys()) {
    if (index.has(root)) continue;
    const work: { node: T; it: Iterator<T> }[] = [];
    const open = (n: T): void => {
      index.set(n, next);
      low.set(n, next);
      next++;
      stack.push(n);
      onStack.add(n);
      work.push({ node: n, it: (edges.get(n)?.keys() ?? [].values()) as Iterator<T> });
    };
    open(root);
    while (work.length > 0) {
      const top = work[work.length - 1]!;
      const r = top.it.next();
      if (!r.done) {
        const m = r.value;
        if (!index.has(m)) open(m);
        else if (onStack.has(m)) low.set(top.node, Math.min(low.get(top.node)!, index.get(m)!));
        continue;
      }
      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1]!.node;
        low.set(parent, Math.min(low.get(parent)!, low.get(top.node)!));
      }
      if (low.get(top.node) === index.get(top.node)) {
        const scc: T[] = [];
        let m: T;
        do {
          m = stack.pop()!;
          onStack.delete(m);
          scc.push(m);
        } while (m !== top.node);
        out.push(scc);
      }
    }
  }
  return out;
}

/** A shortest cycle from `start` back to itself, within `members`. */
function cycleThrough<T>(start: T, members: ReadonlySet<T>, edges: ReadonlyMap<T, ReadonlyMap<T, unknown>>): T[] {
  const prev = new Map<T, T>();
  const queue: T[] = [start];
  for (let i = 0; i < queue.length; i++) {
    const n = queue[i]!;
    for (const m of edges.get(n)?.keys() ?? []) {
      if (!members.has(m)) continue;
      if (m === start) {
        const path: T[] = [start];
        for (let k: T | undefined = n; k !== undefined && k !== start; k = prev.get(k)) path.splice(1, 0, k);
        path.push(start);
        return path;
      }
      if (!prev.has(m)) {
        prev.set(m, n);
        queue.push(m);
      }
    }
  }
  return [start, start];
}

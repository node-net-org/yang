/**
 * Before validation: default nodes added, and `when` conditions resolved.
 *
 * libyang's order, which this follows:
 *
 * 1. Every default node that could apply is added, whatever its `when`:
 *    default leaves and leaf-lists, in existing containers and list entries,
 *    in non-presence containers, and in the active case of each choice or
 *    its default case. For validation, empty non-presence containers are
 *    created too, so that their `must` and `when` are evaluated and their
 *    mandatory descendants are found missing.
 * 2. `when` conditions are evaluated, in document order. A condition that
 *    selects a node whose own `when` isn't resolved yet is postponed, and
 *    the pass repeats until nothing changes; what is left (conditions that
 *    depend on each other) is then evaluated in order. A default node whose
 *    condition is false is removed with everything in it; any other node
 *    whose condition is false is reported.
 *
 * So a default whose `when` depends on another default sees that default
 * once its own condition has held.
 */

import type { CaseNode, ChoiceNode, SchemaNode, WhenCondition } from '../schema/model.js';
import { ContainerInstance, DataTree, LeafInstance, LeafListEntry, type InnerNode, type InstanceNode } from '../data/tree.js';
import { XPathError } from '../errors.js';
import { compiledXPath } from '../xpath/check.js';
import type { XNode } from '../xpath/document.js';
import type { Evaluator } from '../xpath/evaluate.js';

/** A `when` that applies to a schema node, and where it is evaluated from. */
export interface Condition {
  readonly expr: WhenCondition;
  /** The node the `when` belongs to: the node itself, or a choice or case above it. Its module is the default for unprefixed names. */
  readonly holder: SchemaNode;
  /** True when the context node is the node itself; false for its closest data ancestor. */
  readonly self: boolean;
}

const DATA_KINDS = new Set(['container', 'list', 'leaf', 'leaf-list', 'anydata', 'anyxml']);
const CONDITIONS = new WeakMap<SchemaNode, readonly Condition[]>();

/**
 * Every `when` that decides whether an instance of `node` is valid (RFC 7950
 * §7.21.5): its own and those from `uses` and `augment`, and those of the
 * choices and cases between it and its data parent.
 */
export function conditionsOf(node: SchemaNode): readonly Condition[] {
  let out = CONDITIONS.get(node);
  if (out === undefined) {
    const list: Condition[] = [];
    for (let s: SchemaNode | undefined = node; s !== undefined; s = s.parent) {
      if (s !== node && s.kind !== 'choice' && s.kind !== 'case') break;
      for (const w of s.when) list.push({ expr: w, holder: s, self: s === node && w.from === 'node' && DATA_KINDS.has(s.kind) });
    }
    // Outermost first, as they would be met walking down.
    out = list.reverse();
    CONDITIONS.set(node, out);
  }
  return out;
}

export interface WhenProblem {
  readonly node: InstanceNode;
  /** The condition that is false, or undefined when evaluation failed. */
  readonly condition: Condition;
  /** Set when evaluation failed. */
  readonly error?: XPathError;
}

export interface PrepareOptions {
  /** Create empty non-presence containers too (validation needs them; addDefaults doesn't). */
  readonly emptyContainers: boolean;
}

export interface Prepared {
  /** The nodes added, outermost only: removing them removes everything added. */
  readonly added: InstanceNode[];
  /** Written nodes whose `when` is false. */
  readonly whenFalse: Set<InstanceNode>;
  /** Conditions that are false or couldn't be evaluated, on written nodes. */
  readonly problems: WhenProblem[];
}

/** The nodes of a tree that validation and defaults cover: an operation's parameters, or everything. */
export function regionOf(tree: DataTree): { parent: InnerNode; schema: readonly SchemaNode[] }[] {
  if (tree.kind === 'data') return [{ parent: tree, schema: tree.schema.dataNodes }];
  if (tree.kind === 'structure') {
    // The structure's top nodes are present or not; what's inside them is covered.
    const structures = tree.structure === undefined ? tree.schema.structures : [tree.structure];
    const out: { parent: InnerNode; schema: readonly SchemaNode[] }[] = [];
    for (const node of structures.flatMap((x) => x.nodes)) for (const inst of tree.children) if (inst.schema === node && 'children' in inst) out.push({ parent: inst, schema: node.children });
    return out;
  }
  const op = tree.operation;
  return op === undefined ? [] : [{ parent: op, schema: op.parameters.children }];
}

/** Adds defaults to a tree and resolves `when` conditions, as described above. */
export function prepare(tree: DataTree, ev: Evaluator, options: PrepareOptions): Prepared {
  const added: InstanceNode[] = [];
  const filler = new Filler(tree, options.emptyContainers, added);
  for (const { parent, schema } of regionOf(tree)) filler.fill(parent, schema, false);
  ev.changed();
  const addedSet = new Set<InstanceNode>();
  for (const n of added) markAll(n, addedSet);
  const result: Prepared = { added, whenFalse: new Set(), problems: [] };
  resolveWhen(tree, ev, addedSet, result);
  return result;
}

function markAll(n: InstanceNode, set: Set<InstanceNode>): void {
  const stack: InstanceNode[] = [n];
  while (stack.length > 0) {
    const x = stack.pop()!;
    set.add(x);
    if ('children' in x) stack.push(...x.children);
  }
}

function resolveWhen(tree: DataTree, ev: Evaluator, added: ReadonlySet<InstanceNode>, result: Prepared): void {
  // Pending nodes, in document order.
  const order: InstanceNode[] = [];
  const stack: InstanceNode[] = [];
  for (const { parent } of regionOf(tree)) for (let i = parent.children.length - 1; i >= 0; i--) stack.push(parent.children[i]!);
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (conditionsOf(n.schema).length > 0) order.push(n);
    if ('children' in n) for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]!);
  }
  if (order.length === 0) return;
  const pending = new Set(order);
  const doc = ev.document;

  let strict = true;
  let current: InstanceNode | undefined;
  let touched = false;
  ev.onSelect = (x) => {
    if (x === current || touched || x instanceof DataTree || !pending.has(x)) return;
    // Its own ancestors are resolved first or don't matter here.
    for (let a: XNode | undefined = current; a !== undefined; a = doc.parent(a)) if (a === x) return;
    touched = true;
  };
  try {
    while (pending.size > 0) {
      let progress = false;
      for (const n of order) {
        if (!pending.has(n)) continue;
        if (!attached(n, tree) || underFalse(n, result.whenFalse)) {
          pending.delete(n);
          continue;
        }
        current = n;
        touched = false;
        const outcome = evaluateConditions(ev, n, conditionsOf(n.schema));
        if (touched && strict) continue;
        pending.delete(n);
        progress = true;
        if (outcome === true) continue;
        if (added.has(n)) {
          n.parent?.remove(n);
          continue;
        }
        if (outcome.error === undefined) result.whenFalse.add(n);
        result.problems.push({ node: n, ...outcome });
      }
      if (!progress) strict = false;
    }
  } finally {
    ev.onSelect = undefined;
  }
}

/** True, or the first condition that is false (or failed). */
/**
 * Evaluates conditions for node `n`: true, or the first that is false (or
 * failed). Conditions on the node itself need `n`; the others are evaluated
 * from `parent`, by default `n`'s parent.
 */
export function evaluateConditions(ev: Evaluator, n: InstanceNode | undefined, conditions: readonly Condition[], parent?: XNode): true | { condition: Condition; error?: XPathError } {
  const doc = ev.document;
  for (const c of conditions) {
    const context = c.self ? n : (parent ?? (n === undefined ? undefined : doc.parent(n)));
    if (context === undefined) continue;
    try {
      if (!ev.test(compiledXPath(c.expr), context, { prefixes: c.expr.prefixes, defaultModule: c.holder.module.name }, context, c.expr.text)) return { condition: c };
    } catch (e) {
      if (!(e instanceof XPathError)) throw e;
      return { condition: c, error: e };
    }
  }
  return true;
}

function attached(n: InstanceNode, tree: DataTree): boolean {
  let p: InnerNode | undefined = n.parent;
  while (p !== undefined && !(p instanceof DataTree)) p = p.parent;
  return p === tree;
}

function underFalse(n: InstanceNode, whenFalse: ReadonlySet<InstanceNode>): boolean {
  if (whenFalse.size === 0) return false;
  for (let p: InnerNode | undefined = n.parent; p !== undefined && !(p instanceof DataTree); p = p.parent) if (whenFalse.has(p)) return true;
  return false;
}

/** Adds default nodes (RFC 7950 §7.6.1, §7.7.2, §7.9.3). */
class Filler {
  readonly #configOnly: boolean;
  constructor(
    tree: DataTree,
    private readonly emptyContainers: boolean,
    private readonly added: InstanceNode[],
  ) {
    this.#configOnly = tree.kind === 'data' && !tree.schema.holdsState;
  }

  /**
   * Fills `parent` with the defaults of `nodes`, schema children of its
   * schema node (choices and cases included). `inAdded`: the parent is itself
   * being added, so its children needn't be recorded.
   */
  fill(parent: InnerNode, nodes: readonly SchemaNode[], inAdded: boolean): void {
    const add = <T extends InstanceNode>(node: T): T => {
      node.isDefault = true;
      parent.append(node);
      if (!inAdded) this.added.push(node);
      return node;
    };
    for (const node of nodes) {
      if (this.#configOnly && !node.config) continue;
      switch (node.kind) {
        case 'leaf':
          if (node.defaultValue !== undefined && !has(parent, node)) add(new LeafInstance(node, node.defaultValue));
          break;
        case 'leaf-list':
          if (node.defaultValues.length > 0 && !has(parent, node)) for (const v of node.defaultValues) add(new LeafListEntry(node, v));
          break;
        case 'container': {
          const existing = parent.children.filter((c): c is ContainerInstance => c.schema === node);
          if (existing.length > 0) for (const c of existing) this.fill(c, node.children, inAdded);
          else if (node.presence === undefined) {
            const c = new ContainerInstance(node);
            c.isDefault = true;
            this.fill(c, node.children, true);
            if (c.children.length > 0 || this.emptyContainers) {
              parent.append(c);
              if (!inAdded) this.added.push(c);
            }
          }
          break;
        }
        case 'list':
          for (const entry of parent.children) if (entry.schema === node && 'children' in entry) this.fill(entry, node.children, inAdded);
          break;
        case 'choice': {
          const active = activeCase(parent, node) ?? node.defaultCase;
          if (active !== undefined) this.fill(parent, active.children, inAdded);
          break;
        }
        default:
          break;
      }
    }
  }
}

function has(parent: InnerNode, node: SchemaNode): boolean {
  return parent.children.some((c) => c.schema === node);
}

/** The case of a choice that has data in `parent`, if any. */
export function activeCase(parent: InnerNode, choice: ChoiceNode): CaseNode | undefined {
  const present = new Set<SchemaNode>(parent.children.map((c) => c.schema));
  return choice.children.find((c) => hasData(c, present));
}

/** Whether a case or choice has data among `present` schema nodes. */
export function hasData(n: SchemaNode, present: ReadonlySet<SchemaNode>): boolean {
  return n.kind === 'choice' || n.kind === 'case' ? n.children.some((c) => hasData(c, present)) : present.has(n);
}

/** Removes what {@link prepare} added: everything, or only the empty non-presence containers. */
export function unprepare(prepared: Prepared, keepDefaults: boolean): void {
  if (!keepDefaults) {
    for (const n of prepared.added) n.parent?.remove(n);
    return;
  }
  for (const n of prepared.added) if (n instanceof ContainerInstance) dropEmpty(n);
}

/** Removes a container added for defaults if, after removing its own empty containers, nothing is left in it. */
function dropEmpty(c: ContainerInstance): void {
  for (const child of [...c.children]) if (child instanceof ContainerInstance && child.isDefault && child.schema.presence === undefined) dropEmpty(child);
  if (c.children.length === 0) c.parent?.remove(c);
}

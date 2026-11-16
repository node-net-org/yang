/**
 * Validation of instance data against its schema's constraints (RFC 7950
 * §8): `when`, `must`, leafref and instance-identifier integrity, `unique`,
 * `min-elements` and `max-elements`, `mandatory`, choice exclusivity, and
 * unique values in configuration leaf-lists.
 *
 * Validation needs the tree with its defaults, which it adds before checking
 * and removes again afterwards (keep them with `keepDefaults`). It never
 * throws for problems in the data: it returns them.
 */

import { Issues, type IssueDetails } from '../data/build.js';
import { AnyInstance, ContainerInstance, DataTree, LeafInstance, LeafListEntry, ListEntry, OperationInstance, type InnerNode, type InstanceNode } from '../data/tree.js';
import type { InstanceIdentifier } from '../data/value.js';
import { positionsOf, type PositionTable } from '../data/positions.js';
import { XPathError, type DataIssue } from '../errors.js';
import type { SourceLocation } from '../location.js';
import type { CompiledModule, LeafListNode, LeafNode, LeafrefPath, ListNode, SchemaNode } from '../schema/model.js';
import type { Expr } from '../xpath/ast.js';
import { compiledXPath } from '../xpath/check.js';
import { XPathDocument, type XNode } from '../xpath/document.js';
import { Evaluator, instanceTargets, leafrefMember, leafrefTargets } from '../xpath/evaluate.js';
import { conditionsOf, evaluateConditions, hasData, prepare, regionOf, unprepare, type Condition } from './prepare.js';

export interface ValidateOptions {
  /**
   * Datastore data the tree's expressions can see beyond the tree itself
   * (RFC 7950 §6.4.1), as yanglint's `-O`: for an RPC, action or
   * notification, the running configuration and state data, which leafrefs
   * in its parameters and its `must` expressions refer to, and under which an
   * action or nested notification must have its parent. For a structure,
   * data an absolute path may lead into.
   */
  readonly operational?: DataTree;
  /**
   * How to report broken semantic constraints (`when`, `must`, leafref and
   * instance-identifier targets, `unique`, element counts, `mandatory`,
   * duplicate leaf-list values): as errors, or as warnings. By default
   * warnings for `<operational>` and other datastores holding state data,
   * since RFC 8342 §5.3 lets them break those constraints, and errors
   * otherwise. Data from two cases of a choice is always an error.
   */
  readonly semantics?: 'error' | 'warning';
  /**
   * The data may be partial, as in an instance-data file (RFC 9195 §2):
   * missing mandatory nodes and choices, too few elements, and leafrefs and
   * instance-identifiers whose targets aren't in the data aren't reported.
   */
  readonly partial?: boolean;
  /** Keep the default nodes validation adds (flagged `isDefault`). Default false: the tree is left as it was given. */
  readonly keepDefaults?: boolean;
  /** How many nodes one XPath evaluation may visit before it is stopped and reported. Default 10 million. */
  readonly budget?: number;
}

/** Codes of semantic constraints, which RFC 8342 §5.3 lets `<operational>` break. */
const SEMANTIC = new Set(['when-false', 'must-violation', 'missing-instance', 'not-unique', 'too-few-elements', 'too-many-elements', 'missing-mandatory', 'missing-choice', 'duplicate-entry']);
/** Codes about missing data, which partial data may lack. */
const COMPLETENESS = new Set(['missing-mandatory', 'missing-choice', 'too-few-elements', 'missing-instance']);

/**
 * Validates a tree: datastore content, an RPC or action with its input, a
 * reply, a notification, or a structure. Returns every problem found, empty
 * when the tree is valid. Issues have the RFC 7951 path of the node, and
 * those for `must` and `when` the expression and where it is defined.
 */
export function validate(tree: DataTree, options: ValidateOptions = {}): DataIssue[] {
  return new Validator(tree, options).run();
}

/** Validates a tree and throws a {@link YangDataError} listing the errors, if there are any. */
export function assertValid(tree: DataTree, options: ValidateOptions = {}): void {
  const issues = new Issues();
  issues.list.push(...validate(tree, options));
  issues.throwIfAny();
}

/** For the decoders' `validate` option: throws the decoding problems, else validates and throws its errors. */
export function validateDecoded(tree: DataTree, option: boolean | ValidateOptions | undefined, issues: Issues): void {
  if (issues.list.length === 0 && option !== undefined && option !== false) issues.list.push(...validate(tree, option === true ? {} : option));
  issues.throwIfAny();
}

class Validator {
  readonly #tree: DataTree;
  readonly #options: ValidateOptions;
  readonly #issues = new Issues();
  readonly #ev: Evaluator;
  readonly #semantics: 'error' | 'warning';
  readonly #configOnly: boolean;
  readonly #leafrefCache = new Map<LeafrefPath, Map<XNode, Set<string>>>();
  #whenFalse: ReadonlySet<InstanceNode> = new Set();
  readonly #positions: PositionTable | undefined;

  constructor(tree: DataTree, options: ValidateOptions) {
    this.#tree = tree;
    this.#options = options;
    this.#positions = positionsOf(tree);
    const doc = new XPathDocument(tree, { operational: options.operational });
    this.#ev = new Evaluator(doc, { budget: options.budget });
    const operationalStore = tree.kind === 'data' && tree.schema.datastore !== undefined && tree.schema.holdsState;
    this.#semantics = options.semantics ?? (operationalStore ? 'warning' : 'error');
    this.#configOnly = tree.kind === 'data' && !tree.schema.holdsState;
  }

  run(): DataIssue[] {
    const doc = this.#ev.document;
    for (const p of doc.problems) this.#add('missing-parent', p.message, (p.node.parent as InstanceNode | undefined)?.path ?? p.node.path, p.node);
    // The datastore data counts with its defaults too.
    const operational = this.#options.operational;
    const preparedOperational = operational === undefined ? undefined : prepare(operational, new Evaluator(new XPathDocument(operational)), { emptyContainers: false });
    if (preparedOperational !== undefined) this.#ev.changed();
    const prepared = prepare(this.#tree, this.#ev, { emptyContainers: true });
    try {
      this.#whenFalse = prepared.whenFalse;
      for (const p of prepared.problems) this.#whenProblem(p.node, p.condition, p.error);
      for (const { parent, schema } of regionOf(this.#tree)) {
        if (!(parent instanceof DataTree)) this.#walk(parent);
        else {
          this.#children(parent, schema);
          for (const c of parent.children) this.#walk(c);
        }
      }
    } finally {
      unprepare(prepared, this.#options.keepDefaults === true);
      if (preparedOperational !== undefined) unprepare(preparedOperational, false);
    }
    return this.#issues.list;
  }

  /** Records an issue about `node`, placed at it (or its nearest ancestor with a position) when the tree was decoded with positions. */
  #add(code: string, message: string, path: string, node: InstanceNode | InnerNode, details: IssueDetails = {}): void {
    if (this.#options.partial === true && COMPLETENESS.has(code)) return;
    const severity = SEMANTIC.has(code) ? this.#semantics : 'error';
    const position = this.#position(node);
    this.#issues.add(code, message, path, position === undefined ? { ...details, severity } : { ...details, severity, position });
  }

  #position(node: InstanceNode | InnerNode): SourceLocation | undefined {
    const table = this.#positions;
    if (table === undefined) return undefined;
    for (let n: InnerNode | InstanceNode | undefined = node; n !== undefined && !(n instanceof DataTree); n = n.parent) {
      const position = table.of(n);
      if (position !== undefined) return position;
    }
    return undefined;
  }

  #whenProblem(node: InstanceNode, c: Condition, error: XPathError | undefined): void {
    const where = { expression: c.expr.text, location: c.expr.location };
    if (error !== undefined) this.#add('xpath-error', `when ${JSON.stringify(c.expr.text)} couldn't be evaluated: ${error.reason}`, node.path, node, where);
    else this.#add('when-false', `${node.schema.kind} ${node.schema.name} is present, but its when condition ${JSON.stringify(c.expr.text)} is false`, node.path, node, where);
  }

  /** Checks a node and everything in it, depth first. */
  #walk(start: InstanceNode): void {
    const stack: InstanceNode[] = [start];
    while (stack.length > 0) {
      const n = stack.pop()!;
      if (this.#whenFalse.has(n)) continue;
      this.#musts(n);
      if (n instanceof LeafInstance || n instanceof LeafListEntry) this.#references(n);
      else if (n instanceof OperationInstance) this.#children(n, n.parameters.children);
      else if (n instanceof ContainerInstance || n instanceof ListEntry) this.#children(n, n.schema.children);
      if ('children' in n) for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]!);
    }
  }

  // -------------------------------------------------------------------------
  // must

  #musts(n: InstanceNode): void {
    const schema: SchemaNode = n instanceof OperationInstance ? n.parameters : n.schema;
    for (const m of schema.must) {
      const where = { expression: m.text, location: m.location, appTag: m.errorAppTag ?? 'must-violation' };
      try {
        if (this.#ev.test(compiledXPath(m), n, { prefixes: m.prefixes, defaultModule: n.schema.module.name }, n, m.text)) continue;
      } catch (e) {
        if (!(e instanceof XPathError)) throw e;
        this.#add('xpath-error', `must ${JSON.stringify(m.text)} couldn't be evaluated: ${e.reason}`, n.path, n, where);
        continue;
      }
      this.#add('must-violation', m.errorMessage ?? `must condition ${JSON.stringify(m.text)} is false`, n.path, n, where);
    }
  }

  // -------------------------------------------------------------------------
  // leafref and instance-identifier (RFC 7950 §9.9, §9.13)

  #references(n: LeafInstance | LeafListEntry): void {
    const leafref = leafrefMember(n.schema.type, n.value.type);
    if (leafref?.path !== undefined) {
      if (leafref.requireInstance === false) return;
      let found: boolean;
      try {
        found = this.#leafrefFound(n, leafref.path);
      } catch (e) {
        if (!(e instanceof XPathError)) throw e;
        this.#add('xpath-error', `leafref path ${JSON.stringify(leafref.path.text)} couldn't be evaluated: ${e.reason}`, n.path, n);
        return;
      }
      if (!found) {
        this.#add('missing-instance', `leafref value '${this.#ev.stringOf(n)}' matches no instance of ${leafref.path.text}`, n.path, n, { appTag: 'instance-required' });
      }
      return;
    }
    const v = n.value;
    if (v.type.builtin === 'instance-identifier' && v.type.requireInstance !== false) {
      if (instanceTargets(this.#ev.document, v.value as InstanceIdentifier).length === 0) {
        this.#add('missing-instance', `instance-identifier '${this.#ev.stringOf(n)}' names no existing instance`, n.path, n, { appTag: 'instance-required' });
      }
    }
  }

  /**
   * Whether a leafref's target exists. A path without predicates selects the
   * same nodes from every leaf that reaches the same starting node, so
   * their values are collected once per starting node.
   */
  #leafrefFound(n: LeafInstance | LeafListEntry, path: LeafrefPath): boolean {
    const ast = compiledXPath(path);
    const split = splitPath(path, ast);
    if (split === undefined) return leafrefTargets(this.#ev, n, path).length > 0;
    const doc = this.#ev.document;
    let start: XNode | undefined = split.absolute ? doc.root : n;
    for (let i = 0; i < split.up && start !== undefined; i++) start = doc.parent(start);
    if (start === undefined) return false;
    let byStart = this.#leafrefCache.get(path);
    if (byStart === undefined) this.#leafrefCache.set(path, (byStart = new Map<XNode, Set<string>>()));
    let values = byStart.get(start);
    if (values === undefined) {
      const found = this.#ev.evaluate(split.rest, start, { prefixes: path.prefixes, defaultModule: n.schema.module.name }, n, path.text) as readonly XNode[];
      values = new Set(found.map((t) => this.#ev.stringOf(t)));
      byStart.set(start, values);
    }
    return values.has(this.#ev.stringOf(n));
  }

  // -------------------------------------------------------------------------
  // Children: mandatory, min/max-elements, unique, choices, leaf-list duplicates

  #children(parent: InnerNode, schema: readonly SchemaNode[]): void {
    const groups = new Map<SchemaNode, InstanceNode[]>();
    for (const c of parent.children) {
      if (this.#whenFalse.has(c)) continue;
      let g = groups.get(c.schema);
      if (g === undefined) groups.set(c.schema, (g = []));
      g.push(c);
    }
    this.#check(parent, schema, groups);
  }

  #check(parent: InnerNode, schema: readonly SchemaNode[], groups: ReadonlyMap<SchemaNode, InstanceNode[]>): void {
    for (const s of schema) {
      if (this.#configOnly && !s.config) continue;
      const present = groups.get(s) ?? [];
      switch (s.kind) {
        case 'leaf':
        case 'anydata':
        case 'anyxml':
          if (s.mandatory && present.length === 0 && this.#applies(s, parent)) {
            this.#add('missing-mandatory', `mandatory ${s.kind} ${s.name} is missing`, childPath(parent, s), parent);
          }
          break;
        case 'list':
        case 'leaf-list':
          this.#counts(parent, s, present);
          if (s.kind === 'list' && present.length > 1) this.#unique(s, present as ListEntry[]);
          if (s.kind === 'leaf-list' && s.config && present.length > 1) this.#duplicates(present as LeafListEntry[]);
          break;
        case 'choice': {
          const presentSet = new Set(groups.keys());
          const active = s.children.filter((c) => hasData(c, presentSet));
          if (active.length > 1) {
            this.#add('multiple-cases', `choice ${s.name} has data from more than one case: ${active.map((c) => c.name).join(', ')}`, parentPath(parent), parent);
          }
          if (active.length === 0) {
            if (s.mandatory && this.#applies(s, parent)) this.#add('missing-choice', `mandatory choice ${s.name} has no case`, parentPath(parent), parent, { appTag: 'missing-choice', missingChoice: s.name });
          } else this.#check(parent, active[0]!.children, groups);
          break;
        }
        default:
          break;
      }
    }
  }

  #counts(parent: InnerNode, s: ListNode | LeafListNode, present: readonly InstanceNode[]): void {
    const path = childPath(parent, s);
    if (s.maxElements !== undefined && present.length > s.maxElements) {
      this.#add('too-many-elements', `${s.kind} ${s.name} has ${present.length} entries, more than max-elements ${s.maxElements}`, path, parent, { appTag: 'too-many-elements' });
    }
    if (present.length < s.minElements && this.#applies(s, parent)) {
      this.#add('too-few-elements', `${s.kind} ${s.name} has ${present.length} entr${present.length === 1 ? 'y' : 'ies'}, fewer than min-elements ${s.minElements}`, path, parent, { appTag: 'too-few-elements' });
    }
  }

  /** RFC 7950 §7.8.3: entries in which every leaf of a unique set exists must differ in their combined values. */
  #unique(list: ListNode, entries: readonly ListEntry[]): void {
    for (const set of list.unique) {
      if (set.length === 0) continue;
      const chains = set.map((leaf) => chainTo(leaf, list));
      const seen = new Map<string, { entry: ListEntry; leaves: XNode[] }>();
      for (const entry of entries) {
        const leaves: XNode[] = [];
        for (const chain of chains) {
          const leaf = descend(entry, chain);
          if (leaf === undefined) break;
          leaves.push(leaf);
        }
        if (leaves.length !== chains.length) continue;
        const key = leaves.map((l) => this.#ev.stringOf(l)).join('\u0000');
        const other = seen.get(key);
        if (other === undefined) {
          seen.set(key, { entry, leaves });
          continue;
        }
        const names = set.map((l) => l.name).join(' ');
        // Every leaf that breaks the constraint (RFC 7950 §15.1): the earlier entry's and this one's.
        this.#add('not-unique', `entries ${other.entry.path} and ${entry.path} have the same values of unique "${names}"`, entry.path, entry, {
          appTag: 'data-not-unique',
          nonUnique: [...other.leaves, ...leaves].map((l) => (l as InstanceNode).path),
        });
      }
    }
  }

  #duplicates(entries: readonly LeafListEntry[]): void {
    const seen = new Set<string>();
    for (const e of entries) {
      const s = this.#ev.stringOf(e);
      if (seen.has(s)) this.#add('duplicate-entry', `leaf-list ${e.schema.name} has the value '${s}' more than once`, e.path, e);
      seen.add(s);
    }
  }

  /**
   * Whether a constraint on an absent node applies: false when one of its
   * `when` conditions is false. A condition on the node itself is evaluated
   * with a stand-in instance, as libyang does.
   */
  #applies(s: SchemaNode, parent: InnerNode): boolean {
    const conditions = conditionsOf(s);
    if (conditions.length === 0) return true;
    // Conditions from choices, cases, uses and augments are evaluated from the parent; the stand-in serves the node's own.
    const context: XNode = parent instanceof DataTree ? this.#ev.document.root : parent;
    const stand = conditions.some((c) => c.self) ? standIn(s) : undefined;
    if (stand !== undefined) parent.append(stand);
    try {
      return evaluateConditions(this.#ev, stand, conditions, context) === true;
    } finally {
      if (stand !== undefined) parent.remove(stand);
    }
  }
}

/** An instance standing in for an absent node while its own `when` is evaluated. */
function standIn(s: SchemaNode): InstanceNode | undefined {
  switch (s.kind) {
    case 'leaf':
      return new LeafInstance(s, { type: s.type, value: '' });
    case 'leaf-list':
      return new LeafListEntry(s, { type: s.type, value: '' });
    case 'list':
      return new ListEntry(s);
    case 'container':
      return new ContainerInstance(s);
    case 'anydata':
    case 'anyxml':
      return new AnyInstance(s, { format: 'json', value: null });
    default:
      return undefined;
  }
}

function parentPath(parent: InnerNode): string {
  return parent instanceof DataTree ? '/' : parent.path;
}

/** The path an absent child would have. */
function childPath(parent: InnerNode, s: SchemaNode): string {
  if (parent instanceof DataTree) return `/${s.module.name}:${s.name}`;
  const context: CompiledModule = parent.schema.module;
  return `${parent.path}/${s.module === context ? '' : `${s.module.name}:`}${s.name}`;
}

/** The data nodes from below a list down to one of its descendant leaves. */
function chainTo(leaf: LeafNode, list: ListNode): SchemaNode[] {
  const chain: SchemaNode[] = [];
  for (let s: SchemaNode | undefined = leaf; s !== undefined && s !== list; s = s.parent) if (s.kind !== 'choice' && s.kind !== 'case') chain.unshift(s);
  return chain;
}

function descend(from: InstanceNode, chain: readonly SchemaNode[]): InstanceNode | undefined {
  let at: InstanceNode | undefined = from;
  for (const s of chain) {
    if (at === undefined || !('children' in at)) return undefined;
    at = at.children.find((c) => c.schema === s);
  }
  return at;
}

const SPLITS = new WeakMap<LeafrefPath, { absolute: boolean; up: number; rest: Expr } | null>();

/** A leafref path without predicates, split into its leading `..` steps and the rest. Undefined when it has predicates. */
function splitPath(path: LeafrefPath, ast: Expr): { absolute: boolean; up: number; rest: Expr } | undefined {
  let s = SPLITS.get(path);
  if (s === undefined) {
    s = null;
    if (ast.type === 'path' && typeof ast.start !== 'object' && ast.steps.every((st) => st.predicates.length === 0)) {
      let up = 0;
      while (ast.steps[up]?.axis === 'parent') up++;
      s = { absolute: ast.start === 'root', up, rest: { type: 'path', start: 'context', steps: ast.steps.slice(up) } };
    }
    SPLITS.set(path, s);
  }
  return s ?? undefined;
}

/**
 * Narrowing an instance tree to what a read asks for: RFC 6241 §6 subtree
 * filters, the node-set an XPath filter selects (§8.9), and RFC 8526
 * §3.1.1's `max-depth` and `config-filter`.
 *
 * Each function returns a new tree with the same schema; the input is never
 * changed, so a server can filter an immutable datastore snapshot. Nodes are
 * copied, with values and anydata content shared.
 *
 * Subtree filters and XPath selections first collect the input nodes to
 * return whole, then copy those nodes with their ancestors. A partly returned
 * list entry always keeps its keys. Collecting first means overlapping filter
 * elements return the union of what each selects, with nothing to merge.
 */

import type { CompiledModule, SchemaNode } from '../schema/model.js';
import { copyNode, copyTree } from '../edit/copy.js';
import { isElement, type XmlChild, type XmlElementLike } from '../xml/element.js';
import { modulesByNamespace } from './build.js';
import { parseText, sameValue, type ValueScope } from './lexical.js';
import { DataTree, type Annotation, type InnerNode, type InstanceNode } from './tree.js';
import type { TypedValue } from './value.js';

export interface SubtreeFilterOptions {
  /**
   * Namespace declarations in scope above the filter elements, prefix → URI
   * (`''` for the default namespace), which prefixes in content-match
   * values (identityrefs, instance-identifiers) may rely on.
   */
  readonly scope?: ReadonlyMap<string, string>;
  /**
   * The namespace of top-level filter elements that have no `ns` of their
   * own. Default `''`, the wildcard: such an element matches a node of any
   * module (RFC 6241 §6.2.1).
   */
  readonly namespace?: string;
}

export interface PruneOptions {
  /**
   * Keep nodes down to this depth: top-level nodes are depth 1. A list entry
   * at the cut keeps its keys. Must be at least 1.
   */
  readonly maxDepth?: number;
  /**
   * `true` keeps configuration only. `false` keeps state only, with the
   * ancestors (and their list keys) needed to reach it. Undefined keeps both.
   */
  readonly config?: boolean;
  /**
   * Decides, top down, what happens to each node: `'keep'` keeps it and its
   * subtree with no further calls, `'drop'` leaves it and its subtree out,
   * and `'descend'` keeps it and asks again for each of its children. It is
   * called with the input tree's nodes, never with a list entry's keys
   * (they stay with the entry). `maxDepth` and `config` apply as well. An
   * access control layer uses this to leave out what a user may not read.
   */
  readonly keep?: (node: InstanceNode) => 'keep' | 'drop' | 'descend';
}

/**
 * Applies an RFC 6241 §6 subtree filter, given as the parsed children of a
 * `<filter type="subtree">` element, to a tree.
 *
 * - An element with child elements is a containment node, one with only
 *   text is a content-match node, and an empty one is a selection node.
 * - Among siblings, every content match must hold for their parent to be
 *   selected. If the siblings are all content matches, the whole parent is
 *   returned; otherwise the matching content-match nodes, the selected
 *   nodes and what each containment node selects are (§6.2.5).
 * - Content matches compare typed values: `01` matches a uint8 `1`, and
 *   identityref prefixes resolve through the namespace declarations in scope.
 * - Attributes on a filter element must match the node's annotations
 *   (§6.2.2). An element in the empty namespace matches any module (§6.2.1).
 * - An empty filter, or one naming nodes the schema doesn't have, selects
 *   nothing.
 */
export function subtreeFilter(tree: DataTree, filter: readonly XmlChild[], options: SubtreeFilterOptions = {}): DataTree {
  const matcher = new SubtreeMatcher(tree);
  const scope = new Map([['', ''], ...(options.scope ?? [])]);
  const top = filterNodes(filter, options.namespace ?? '', scope);
  if (top.length === 0) return emptyLike(tree);
  const result = matcher.match(top, tree.children);
  if (result === 'whole') return copyTree(tree);
  return build(tree, result ?? []);
}

/**
 * The tree an XPath filter returns (RFC 6241 §8.9): the given nodes with
 * their subtrees, their ancestors, and the keys of ancestor list entries.
 * Pass the node-set `evaluateXPath` returned; the tree itself in it selects
 * everything.
 */
export function selectionTree(tree: DataTree, nodes: readonly (InstanceNode | DataTree)[]): DataTree {
  if (nodes.includes(tree)) return copyTree(tree);
  return build(tree, nodes.filter((n): n is InstanceNode => !(n instanceof DataTree)));
}

/**
 * Prunes a tree by depth and by configuration or state, as `<get-data>`'s
 * `max-depth` and `config-filter` do (RFC 8526 §3.1.1), and by a `keep`
 * callback.
 */
export function pruneTree(tree: DataTree, options: PruneOptions): DataTree {
  const maxDepth = options.maxDepth ?? Number.POSITIVE_INFINITY;
  if (!(maxDepth >= 1)) throw new RangeError(`maxDepth must be at least 1, not ${String(options.maxDepth)}`);
  const out = emptyLike(tree);
  prune(tree.children, out, 1, maxDepth, options.config, false, options.keep);
  return out;
}

// ---------------------------------------------------------------------------
// Subtree filters

type FilterKind = 'containment' | 'content' | 'selection';

interface FilterNode {
  readonly el: XmlElementLike;
  /** The resolved namespace; `''` matches any. */
  readonly ns: string;
  readonly scope: ReadonlyMap<string, string>;
  readonly kind: FilterKind;
  readonly text: string;
  readonly children: readonly FilterNode[];
}

function filterNodes(children: readonly XmlChild[], parentNs: string, parentScope: ReadonlyMap<string, string>): FilterNode[] {
  const out: FilterNode[] = [];
  for (const el of children) {
    if (!isElement(el)) continue;
    const ns = el.ns ?? parentNs;
    const scope = el.declarations === undefined || el.declarations.size === 0 ? parentScope : new Map([...parentScope, ...el.declarations]);
    const kids = filterNodes(el.children ?? [], ns, scope);
    const text = (el.children ?? []).filter((c): c is string => !isElement(c)).join('');
    const kind: FilterKind = kids.length > 0 ? 'containment' : text.trim() !== '' ? 'content' : 'selection';
    out.push({ el, ns, scope, kind, text, children: kids });
  }
  return out;
}

class SubtreeMatcher {
  readonly #byNs: Map<string, CompiledModule>;

  constructor(readonly tree: DataTree) {
    this.#byNs = modulesByNamespace(tree.schema);
  }

  /**
   * Matches one set of sibling filter nodes against one parent's children.
   * Undefined when a content match fails (the parent is not selected),
   * `'whole'` when the set has only content matches and all hold, otherwise
   * the nodes to return whole (possibly none).
   */
  match(filters: readonly FilterNode[], children: readonly InstanceNode[]): InstanceNode[] | 'whole' | undefined {
    const selected: InstanceNode[] = [];
    let onlyContent = true;
    for (const f of filters) {
      if (f.kind !== 'content') continue;
      const matched = this.#candidates(f, children).filter((c) => this.#contentMatches(f, c));
      if (matched.length === 0) return undefined;
      selected.push(...matched);
    }
    for (const f of filters) {
      if (f.kind === 'content') continue;
      onlyContent = false;
      for (const c of this.#candidates(f, children)) {
        if (f.kind === 'selection' || c.kind === 'anydata' || c.kind === 'anyxml') {
          selected.push(c);
          continue;
        }
        if (!('children' in c)) continue; // containment on a leaf matches nothing
        const inner = this.match(f.children, c.children);
        if (inner === 'whole') selected.push(c);
        else if (inner !== undefined) selected.push(...inner);
      }
    }
    return onlyContent ? 'whole' : selected;
  }

  #candidates(f: FilterNode, children: readonly InstanceNode[]): InstanceNode[] {
    return children.filter((c) => c.schema.name === f.el.name && (f.ns === '' || c.schema.module.namespace === f.ns) && this.#attributesMatch(f, c));
  }

  #contentMatches(f: FilterNode, node: InstanceNode): boolean {
    if (node.kind !== 'leaf' && node.kind !== 'leaf-list') return false;
    return this.#valueMatches(node.value, f.text, f, node);
  }

  #valueMatches(value: TypedValue, text: string, f: FilterNode, node: InstanceNode): boolean {
    const scope = this.#valueScope(f, node);
    let parsed = parseText(value.type, text, scope);
    if (typeof parsed === 'string' && text.trim() !== text) parsed = parseText(value.type, text.trim(), scope);
    return typeof parsed !== 'string' && sameValue(parsed, value);
  }

  #attributesMatch(f: FilterNode, node: InstanceNode): boolean {
    for (const a of f.el.attributes ?? []) {
      const ns = a.ns ?? '';
      const module = ns === '' ? undefined : this.#byNs.get(ns)?.name;
      const ann = node.annotations.find((x) => x.name === a.name && (x.namespace === ns || (x.namespace === undefined && module !== undefined && x.module === module)));
      if (ann === undefined || !this.#annotationMatches(ann, a.value, f, node)) return false;
    }
    return true;
  }

  #annotationMatches(ann: Annotation, text: string, f: FilterNode, node: InstanceNode): boolean {
    if (typeof ann.value === 'string') return ann.value === text;
    return this.#valueMatches(ann.value, text, f, node);
  }

  #valueScope(f: FilterNode, node: InstanceNode): ValueScope {
    const byNs = this.#byNs;
    const defaultNs = f.scope.get('');
    return {
      format: 'xml',
      schema: this.tree.schema,
      module: (prefix) => {
        const uri = f.scope.get(prefix);
        return uri === undefined ? undefined : byNs.get(uri);
      },
      unprefixed: (defaultNs === undefined || defaultNs === '' ? undefined : byNs.get(defaultNs)) ?? node.schema.module,
    };
  }
}

// ---------------------------------------------------------------------------
// Building results

function emptyLike(tree: DataTree): DataTree {
  return new DataTree(tree.schema, tree.kind, tree.structure);
}

/** A copy of `tree` holding `whole` with their subtrees, and their ancestors with list keys. */
function build(tree: DataTree, whole: readonly InstanceNode[]): DataTree {
  const full = new Set(whole);
  const partial = new Set<InstanceNode>();
  for (const n of whole) {
    let p: InnerNode | undefined = n.parent;
    while (p !== undefined && !(p instanceof DataTree) && !partial.has(p)) {
      partial.add(p);
      p = p.parent;
    }
  }
  const out = emptyLike(tree);
  copyMarked(tree.children, out, full, partial);
  return out;
}

function copyMarked(children: readonly InstanceNode[], parent: DataTree | InstanceNode, full: ReadonlySet<InstanceNode>, partial: ReadonlySet<InstanceNode>): void {
  const into = (parent as { children: InstanceNode[] }).children;
  const keys: ReadonlySet<SchemaNode> | undefined = parent instanceof DataTree || parent.kind !== 'list' ? undefined : new Set<SchemaNode>(parent.schema.keys);
  for (const c of children) {
    if (keys?.has(c.schema) === true) continue; // copied with the entry
    if (full.has(c)) {
      into.push(Object.assign(copyNode(c), { parent }));
    } else if (partial.has(c)) {
      const copy = Object.assign(copyNode(c, false), { parent });
      into.push(copy);
      if ('children' in c) copyMarked(c.children, copy, full, partial);
    }
  }
}

/**
 * Copies what survives pruning from `children` into `parent`. Returns whether
 * anything was copied.
 */
function prune(
  children: readonly InstanceNode[],
  parent: DataTree | InstanceNode,
  depth: number,
  maxDepth: number,
  config: boolean | undefined,
  inState: boolean,
  keep: PruneOptions['keep'],
): boolean {
  const into = (parent as { children: InstanceNode[] }).children;
  const keys: ReadonlySet<SchemaNode> | undefined = parent instanceof DataTree || parent.kind !== 'list' ? undefined : new Set<SchemaNode>(parent.schema.keys);
  let any = false;
  for (const c of children) {
    if (keys?.has(c.schema) === true) continue; // copied with the entry
    if (config === true && !c.schema.config) continue;
    const verdict = keep?.(c) ?? 'keep';
    if (verdict === 'drop') continue;
    const state = inState || (config === false && !c.schema.config);
    const copy = Object.assign(copyNode(c, false), { parent });
    const below = 'children' in c && depth < maxDepth ? prune(c.children, copy, depth + 1, maxDepth, config, state, verdict === 'descend' ? keep : undefined) : false;
    if (config !== false || state || below) {
      into.push(copy);
      any = true;
    }
  }
  return any;
}

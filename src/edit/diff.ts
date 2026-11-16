/**
 * Differences between two data trees, matched by schema: list entries by
 * their keys, leaf-list entries by their values. The changes can be turned
 * into an edit that {@link applyEdit} (or a NETCONF server) applies to the
 * first tree to get the second.
 */

import { sameAnyContent } from '../data/any-compare.js';
import { NETCONF_NS, YANG_NS } from '../data/build.js';
import { formatJson, sameValue, scalarText } from '../data/lexical.js';
import { AnyInstance, DataTree, LeafInstance, LeafListEntry, ListEntry, schemaOf, type Annotation, type InnerNode, type InstanceNode } from '../data/tree.js';
import { YangDataError } from '../errors.js';
import type { SchemaNode } from '../schema/model.js';
import { isXPathLiteral, xpathLiteral } from '../xpath/literal.js';
import { copyNode, entryIdentity, isDataAnnotation } from './copy.js';
import { effectiveOrigin, isOriginAnnotation, originSource, ownOrigin, sameOrigin, type Origin } from './origin.js';

/** Where a created or moved entry of an ordered-by-user list or leaf-list goes: first, or after another entry. */
export type EntryPosition = { readonly where: 'first' } | { readonly where: 'after'; readonly anchor: ListEntry | LeafListEntry };

/**
 * One difference between two trees.
 *
 * - `create`: `node` (in the second tree) and its subtree are new.
 * - `delete`: `node` (in the first tree) and its subtree are gone.
 * - `replace`: a leaf's value or anydata's content changed from `previous`
 *   (in the first tree) to `node` (in the second). anydata and anyxml are
 *   opaque (RFC 7950 §7.10.3), so a change inside their content is one
 *   `replace` of the whole node. Content written differently but meaning
 *   the same (JSON member order, prefixes, whitespace between elements,
 *   the same content read from XML and from JSON) is no change.
 * - `move`: an entry of an ordered-by-user list or leaf-list is in both
 *   trees, in a different place.
 * - `origin`: the node's effective origin in `<operational>` (RFC 8342
 *   §7.4) changed from `previousOrigin` to `origin`; `previous` is the node
 *   in the first tree. Only when origins are compared (see
 *   {@link DiffOptions}).
 *
 * Created and moved entries of ordered-by-user lists and leaf-lists have a
 * `position`, relative to the second tree's entries.
 */
export interface DataChange {
  readonly operation: 'create' | 'delete' | 'replace' | 'move' | 'origin';
  /** The node's data path, RFC 7951 style. */
  readonly path: string;
  readonly node: InstanceNode;
  readonly previous?: InstanceNode;
  readonly position?: EntryPosition;
  /** For `origin`: the node's effective origin in the second tree, undefined if it has none. See {@link effectiveOrigin}. */
  readonly origin?: Origin;
  /** For `origin`: the node's effective origin in the first tree, undefined if it had none. */
  readonly previousOrigin?: Origin;
}

export interface DiffOptions {
  /**
   * Compare the nodes' origins (the `or:origin` annotation of RFC 8342
   * §7.4). By default they are compared when both trees' schemas hold
   * state (`<operational>`, a dynamic datastore, or a schema tied to no
   * datastore), the only trees an origin can be in.
   */
  readonly origin?: boolean;
}

/**
 * The differences between two trees of `data` (the same modules, any
 * datastore), in document order: within a parent, deletions come before
 * creations and moves, which are in the second tree's order, and then the
 * changes inside nodes that are in both. Nothing inside a created or
 * deleted node is listed separately. Annotations and the `isDefault` flag
 * aren't compared, except for origins.
 *
 * Origins are compared as effective origins: a node's own `or:origin`,
 * otherwise its nearest ancestor's, compared by identity rather than by
 * the prefix written. An `origin` change is listed for a node in both
 * trees whose effective origin differs and that has an origin of its own
 * in at least one of them, after its `replace` if it has one and before
 * the changes inside it. A node that inherits its origin in both trees
 * changes with its parent, so it isn't listed again. Making an inherited
 * origin explicit, or the reverse, is no change; created and deleted nodes
 * have no `origin` change.
 */
export function diffTrees(from: DataTree, to: DataTree, options: DiffOptions = {}): DataChange[] {
  const out: DataChange[] = [];
  const origins = options.origin ?? (from.schema.holdsState && to.schema.holdsState);
  diffChildren(from, to, out, origins);
  return out;
}

/**
 * An edit that turns `from` into `to`: a `data` tree with NETCONF edit
 * annotations, for {@link applyEdit} or, encoded, an `<edit-config>` or
 * `<edit-data>` (with any default operation). Created nodes have
 * `nc:operation` `create`, deleted ones `delete`, changed leaves `replace`;
 * moved entries have `merge` with `yang:insert`, as do created entries of
 * ordered-by-user lists and leaf-lists. A node whose origin changed has
 * `merge` (unless it has another operation) with `or:origin` set to its
 * new effective origin, which {@link applyEdit} keeps only where it isn't
 * what the node inherits (a node left with no origin at all, which the
 * ietf-origin module doesn't allow at the top, can't be written, and gets
 * only the `merge`). `yang:key` names key leaves with
 * their module (`[ex:name='a']`), as RFC 7951 does. Deleting nodes of a
 * case that a created node replaces is left to the implicit deletion of
 * RFC 7950 §7.9.
 *
 * @throws YangDataError (`unwritable-anchor`) when an entry is placed after
 *   one whose key holds both `'` and `"`: `yang:key` allows only a quoted
 *   string, and XPath 1.0 has no escapes.
 */
export function diffEdit(from: DataTree, to: DataTree, options: DiffOptions = {}): DataTree {
  return editFromChanges(to.schema === from.schema ? to : from, diffTrees(from, to, options));
}

/**
 * An edit made from changes, as {@link diffEdit} makes it. `tree` gives the schema.
 * @throws YangDataError (`unwritable-anchor`) as {@link diffEdit} does.
 */
export function editFromChanges(tree: DataTree, changes: readonly DataChange[]): DataTree {
  const edit = new DataTree(tree.schema, 'data');
  const counterparts = new Map<InstanceNode, InstanceNode>();
  /** The inner nodes made in the edit, by parent, schema node and identity. */
  const byParent = new Map<InnerNode, Map<SchemaNode, Map<string, InstanceNode>>>();
  const created = new Map<string, InstanceNode[]>();
  for (const c of changes) {
    if (c.operation !== 'create') continue;
    const key = parentPath(c.node);
    const list = created.get(key);
    if (list === undefined) created.set(key, [c.node]);
    else list.push(c.node);
  }

  /** The edit's counterpart of a node, made with its ancestors (keys only) if need be. */
  const counterpart = (node: InstanceNode): InstanceNode => {
    const known = counterparts.get(node);
    if (known !== undefined) return known;
    const parent: InnerNode = node.parent === undefined || node.parent instanceof DataTree ? edit : (counterpart(node.parent) as InnerNode);
    const id = entryIdentity(node);
    let byId = byParent.get(parent)?.get(node.schema);
    if (byId === undefined) {
      const forParent = byParent.get(parent) ?? new Map<SchemaNode, Map<string, InstanceNode>>();
      byParent.set(parent, forParent);
      forParent.set(node.schema, (byId = new Map<string, InstanceNode>()));
    }
    let made = byId.get(id);
    if (made === undefined) {
      made = parent.append(copyNode(node, false, () => false));
      byId.set(id, made);
    }
    counterparts.set(node, made);
    return made;
  };
  const add = (node: InstanceNode, copy: InstanceNode): InstanceNode => {
    const parent: InnerNode = node.parent === undefined || node.parent instanceof DataTree ? edit : (counterpart(node.parent) as InnerNode);
    parent.append(copy);
    counterparts.set(node, copy);
    return copy;
  };

  for (const c of changes) {
    switch (c.operation) {
      case 'create': {
        const copy = add(c.node, copyNode(c.node, true, isDataAnnotation));
        copy.annotations.push(operation('create'), ...positionAnnotations(c));
        break;
      }
      case 'delete': {
        if (replacedCase(c.node, created.get(parentPath(c.node)) ?? [])) break;
        add(c.node, copyNode(c.node, false, () => false)).annotations.push(operation('delete'));
        break;
      }
      case 'replace':
        add(c.node, copyNode(c.node, false, isDataAnnotation)).annotations.push(operation('replace'));
        break;
      case 'move':
        counterpart(c.node).annotations.push(operation('merge'), ...positionAnnotations(c));
        break;
      case 'origin': {
        const node = counterpart(c.node);
        if (!node.annotations.some(isOperation)) node.annotations.push(operation('merge'));
        const source = originSource(c.node);
        const kept = node.annotations.filter((a) => !isOriginAnnotation(a));
        node.annotations.length = 0;
        node.annotations.push(...kept, ...(source === undefined ? [] : [source]));
        break;
      }
    }
  }
  return edit;
}

function diffChildren(from: InnerNode, to: InnerNode, out: DataChange[], origins: boolean): void {
  const groups = new Map<SchemaNode, { from: InstanceNode[]; to: InstanceNode[] }>();
  const group = (s: SchemaNode): { from: InstanceNode[]; to: InstanceNode[] } => {
    let g = groups.get(s);
    if (g === undefined) groups.set(s, (g = { from: [], to: [] }));
    return g;
  };
  // Schema nodes in the second tree's order, then those only in the first.
  for (const c of to.children) group(c.schema).to.push(c);
  for (const c of from.children) group(c.schema).from.push(c);

  for (const [schema, g] of groups) {
    if (schema.kind === 'list' || schema.kind === 'leaf-list') {
      diffEntries(g.from, g.to, schema.orderedBy === 'user', out, origins);
      continue;
    }
    const a = g.from[0];
    const b = g.to[0];
    if (a === undefined) out.push({ operation: 'create', path: b!.path, node: b! });
    else if (b === undefined) out.push({ operation: 'delete', path: a.path, node: a });
    else if (a instanceof LeafInstance && b instanceof LeafInstance) {
      if (!sameValue(a.value, b.value)) out.push({ operation: 'replace', path: b.path, node: b, previous: a });
      if (origins) diffOrigin(a, b, out);
    } else if (a instanceof AnyInstance && b instanceof AnyInstance) {
      if (!sameAnyContent(a.content, b.content, b.kind, b.schema.module.namespace, schemaOf(b))) out.push({ operation: 'replace', path: b.path, node: b, previous: a });
      if (origins) diffOrigin(a, b, out);
    } else if ('children' in a && 'children' in b) {
      if (origins) diffOrigin(a, b, out);
      diffChildren(a, b, out, origins);
    }
  }
}

/** An `origin` change, if the node's effective origin changed and it has an origin of its own in either tree. */
function diffOrigin(a: InstanceNode, b: InstanceNode, out: DataChange[]): void {
  if (ownOrigin(a) === undefined && ownOrigin(b) === undefined) return;
  const before = effectiveOrigin(a);
  const after = effectiveOrigin(b);
  if (sameOrigin(before, after)) return;
  out.push({ operation: 'origin', path: b.path, node: b, previous: a, ...(after === undefined ? {} : { origin: after }), ...(before === undefined ? {} : { previousOrigin: before }) });
}

/** Entries of one list or leaf-list. */
function diffEntries(from: InstanceNode[], to: InstanceNode[], ordered: boolean, out: DataChange[], origins: boolean): void {
  const old = new Map(from.map((n, i) => [entryIdentity(n), { node: n, index: i }]));
  const kept = new Set<string>();
  for (const n of to) kept.add(entryIdentity(n));
  for (const n of from) if (!kept.has(entryIdentity(n))) out.push({ operation: 'delete', path: n.path, node: n });

  // Common entries that keep their relative order: the longest increasing run of their old positions.
  const stay = ordered ? longestIncreasing(to.map((n) => old.get(entryIdentity(n))?.index ?? -1)) : undefined;
  let previous: InstanceNode | undefined;
  const common: [InstanceNode, InstanceNode][] = [];
  to.forEach((n, i) => {
    const before = old.get(entryIdentity(n));
    const position: EntryPosition | undefined = !ordered ? undefined : previous === undefined ? { where: 'first' } : { where: 'after', anchor: previous as ListEntry | LeafListEntry };
    if (before === undefined) out.push({ operation: 'create', path: n.path, node: n, ...(position === undefined ? {} : { position }) });
    else {
      if (stay !== undefined && !stay.has(i)) out.push({ operation: 'move', path: n.path, node: n, position: position! });
      common.push([before.node, n]);
    }
    previous = n;
  });
  for (const [a, b] of common) {
    if (origins) diffOrigin(a, b, out);
    if (a instanceof ListEntry && b instanceof ListEntry) diffChildren(a, b, out, origins);
  }
}

/** The indexes (into `values`) of a longest strictly increasing subsequence of the values that aren't -1. */
function longestIncreasing(values: readonly number[]): Set<number> {
  const tails: number[] = []; // index into values of the smallest tail of each length
  const prev = new Array<number>(values.length).fill(-1);
  values.forEach((v, i) => {
    if (v === -1) return;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (values[tails[mid]!]! < v) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1]!;
    tails[lo] = i;
  });
  const out = new Set<number>();
  for (let i = tails.length === 0 ? -1 : tails[tails.length - 1]!; i !== -1; i = prev[i]!) out.add(i);
  return out;
}

function parentPath(n: InstanceNode): string {
  return n.parent === undefined || n.parent instanceof DataTree ? '' : n.parent.path;
}

/** Whether a deleted node is in a case of a choice that a created sibling is in another case of. */
function replacedCase(node: InstanceNode, created: readonly InstanceNode[]): boolean {
  for (let s: SchemaNode | undefined = node.schema; s?.parent !== undefined; s = s.parent) {
    const kase = s.parent;
    if (kase.kind !== 'case' || kase.parent === undefined) continue;
    const choice = kase.parent;
    if (created.some((c) => caseOf(c.schema, choice) !== undefined && caseOf(c.schema, choice) !== kase)) return true;
  }
  return false;
}

function caseOf(schema: SchemaNode, choice: SchemaNode): SchemaNode | undefined {
  for (let s: SchemaNode | undefined = schema; s?.parent !== undefined; s = s.parent) if (s.parent === choice) return s;
  return undefined;
}

function isOperation(a: Annotation): boolean {
  return a.name === 'operation' && (a.namespace === NETCONF_NS || (a.namespace === undefined && a.module === 'ietf-netconf'));
}

function operation(value: string): Annotation {
  return { namespace: NETCONF_NS, module: 'ietf-netconf', name: 'operation', value, prefix: 'nc' };
}

function positionAnnotations(c: DataChange): Annotation[] {
  const p = c.position;
  if (p === undefined) return [];
  const yang = (name: string, value: string): Annotation => ({ namespace: YANG_NS, module: 'yang', name, value, prefix: 'yang' });
  if (p.where === 'first') return [yang('insert', 'first')];
  const anchor = p.anchor;
  if (anchor instanceof LeafListEntry) return [yang('insert', 'after'), yang('value', scalarText(formatJson(anchor.value)))];
  const keys = anchor.keys.map((k) => {
    const text = scalarText(formatJson(k.value));
    // yang:key follows the instance-identifier grammar, which has quoted strings
    // and nothing else (RFC 7950 §7.8.6, §9.13): no concat(), and libyang refuses one.
    if (!isXPathLiteral(text)) {
      const issue = { code: 'unwritable-anchor', message: `key ${k.schema.name} of the entry to insert after holds both ' and ", which yang:key can't express`, path: anchor.path, severity: 'error' as const };
      throw new YangDataError([issue]);
    }
    return `[${k.schema.module.name}:${k.schema.name}=${xpathLiteral(text)}]`;
  });
  return [yang('insert', 'after'), yang('key', keys.join(''))];
}

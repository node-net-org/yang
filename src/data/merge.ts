/**
 * Merging data trees: configuration with state, as `<operational>` and
 * NETCONF's `<get>` combine them (RFC 8342 §5.3).
 */

import type { SchemaNode } from '../schema/model.js';
import { copyNode, copyTree, entryIdentity } from '../edit/copy.js';
import type { Annotation, DataTree, InnerNode, InstanceNode } from './tree.js';

/**
 * Merges `sources` into a copy of `target`, in order, and returns the copy;
 * the inputs are left as they are.
 *
 * - Containers match by schema node, list entries by their keys and
 *   leaf-list entries by value. Matched nodes are merged recursively;
 *   unmatched ones are copied in, in schema order.
 * - A matched leaf or anydata takes the source's value. Annotations are
 *   combined, a source's replacing one with the same name and module.
 * - Configuration and state are both allowed. Sources may be decoded with
 *   another datastore's schema from the same compile (such as
 *   `schema.forDatastore('operational')` for a running tree).
 *
 * Nothing is validated.
 */
export function mergeTrees(target: DataTree, ...sources: readonly DataTree[]): DataTree {
  const out = copyTree(target);
  for (const source of sources) mergeChildren(out, source.children);
  return out;
}

type Index = Map<SchemaNode, Map<string, InstanceNode>>;

function indexOf(parent: InnerNode): Index {
  const index: Index = new Map();
  for (const c of parent.children) add(index, c);
  return index;
}

function add(index: Index, node: InstanceNode): void {
  let bySchema = index.get(node.schema);
  if (bySchema === undefined) index.set(node.schema, (bySchema = new Map<string, InstanceNode>()));
  bySchema.set(entryIdentity(node), node);
}

function mergeChildren(parent: InnerNode, children: readonly InstanceNode[]): void {
  if (children.length === 0) return;
  const index = indexOf(parent);
  for (const src of children) {
    const match = index.get(src.schema)?.get(entryIdentity(src));
    if (match === undefined) {
      add(index, (parent as { append(n: InstanceNode): InstanceNode }).append(copyNode(src)));
      continue;
    }
    mergeAnnotations(match, src.annotations);
    switch (match.kind) {
      case 'leaf':
        match.value = (src as typeof match).value;
        match.isDefault = src.isDefault;
        break;
      case 'anydata':
      case 'anyxml':
        match.content = (src as typeof match).content;
        break;
      case 'leaf-list':
        break;
      default:
        mergeChildren(match, (src as typeof match).children);
    }
  }
}

function mergeAnnotations(node: InstanceNode, from: readonly Annotation[]): void {
  for (const a of from) {
    const i = node.annotations.findIndex((b) => b.name === a.name && sameModule(a, b));
    if (i === -1) node.annotations.push(a);
    else node.annotations[i] = a;
  }
}

function sameModule(a: Annotation, b: Annotation): boolean {
  if (a.namespace !== undefined && b.namespace !== undefined) return a.namespace === b.namespace;
  return a.module === b.module;
}

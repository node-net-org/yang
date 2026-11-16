/** Copying instance nodes and trees, for the edit engine and diffs. */

import { isDefaultAnnotation } from '../data/defaults.js';
import { NETCONF_NS, YANG_NS } from '../data/build.js';
import { formatJson } from '../data/lexical.js';
import { AnyInstance, ContainerInstance, DataTree, LeafInstance, LeafListEntry, ListEntry, OperationInstance, type Annotation, type InstanceNode } from '../data/tree.js';

/**
 * A copy of a node without a parent: its whole subtree when `deep`, or
 * only the node itself (with its keys, for a list entry). Values and
 * anydata content are immutable and shared.
 */
export function copyNode<T extends InstanceNode>(node: T, deep = true, annotations: (a: Annotation) => boolean = () => true): T {
  let out: InstanceNode;
  switch (node.kind) {
    case 'container':
      out = new ContainerInstance(node.schema);
      break;
    case 'list':
      out = new ListEntry(node.schema);
      break;
    case 'leaf':
      out = new LeafInstance(node.schema, node.value);
      break;
    case 'leaf-list':
      out = new LeafListEntry(node.schema, node.value);
      break;
    case 'anydata':
    case 'anyxml':
      out = new AnyInstance(node.schema, node.content);
      break;
    default:
      if (!(node instanceof OperationInstance)) throw new TypeError(`unknown node kind ${(node as InstanceNode).kind}`);
      out = new OperationInstance(node.schema, node.direction);
  }
  out.isDefault = node.isDefault;
  out.annotations.push(...node.annotations.filter(annotations));
  if ('children' in node && 'children' in out) {
    const children = deep ? node.children : node.kind === 'list' ? node.keys : [];
    for (const c of children) out.children.push(Object.assign(copyNode(c, deep, annotations), { parent: out }));
  }
  return out as T;
}

/** A deep copy of a tree, with the same schema. */
export function copyTree(tree: DataTree): DataTree {
  const out = new DataTree(tree.schema, tree.kind, tree.structure);
  for (const c of tree.children) out.children.push(Object.assign(copyNode(c), { parent: out }));
  return out;
}

/** Whether an annotation is one of NETCONF's edit attributes (`nc:operation`, `yang:insert`, `yang:key`, `yang:value`). */
export function isEditAnnotation(a: Annotation): boolean {
  return a.namespace === NETCONF_NS || a.namespace === YANG_NS || (a.namespace === undefined && (a.module === 'ietf-netconf' || a.module === 'yang'));
}

/** Annotations a result node keeps: not edit attributes, and not with-defaults tags. */
export function isDataAnnotation(a: Annotation): boolean {
  return !isEditAnnotation(a) && !isDefaultAnnotation(a.namespace, a.module, a.name);
}

/** What tells an entry from its siblings: a list entry's keys, a leaf-list entry's value. `''` for other nodes. */
export function entryIdentity(n: InstanceNode): string {
  if (n instanceof ListEntry) return JSON.stringify(n.keys.map((k) => formatJson(k.value)));
  if (n instanceof LeafListEntry) return JSON.stringify(formatJson(n.value));
  return '';
}

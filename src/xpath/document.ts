/**
 * The tree XPath sees: RFC 7950 §6.4.1's accessible tree, over instance
 * nodes.
 *
 * XPath nodes are the instance nodes themselves, plus the {@link DataTree}
 * as the root node. Usually the document is the tree as it is, but a few
 * contexts join or reshape trees:
 *
 * - An RPC, action or notification checked against separate datastore data
 *   (yanglint's `-O`): the root's children are that data's top-level nodes
 *   plus, for an RPC or top-level notification, the operation; an action or
 *   nested notification hangs under the matching node of that data.
 * - A YANG data structure (RFC 8791): the structure's own nodes are the
 *   children of the root, not the container it is encoded as.
 * - A configuration node outside any datastore (a `data` tree whose schema
 *   has no datastore): only configuration nodes are visible, as RFC 7950
 *   §6.4.1 says for config true contexts.
 */

import type { SchemaNode } from '../schema/model.js';
import { DataTree, type InnerNode, type InstanceNode, ListEntry, OperationInstance } from '../data/tree.js';
import { sameValue } from '../data/lexical.js';

/** A node in XPath's view: an instance node, or the tree itself as the root. */
export type XNode = InstanceNode | DataTree;

export interface DocumentOptions {
  /**
   * Datastore data an operation tree's expressions can see: the running
   * configuration and state data (RFC 7950 §6.4.1). For a structure, data
   * an absolute path may lead into.
   */
  readonly operational?: DataTree | undefined;
}

export class XPathDocument {
  readonly root: DataTree;
  readonly #rootChildren: readonly InstanceNode[];
  readonly #parents = new Map<InstanceNode, XNode>();
  readonly #extraChildren = new Map<XNode, InstanceNode[]>();
  /** Problems joining the trees: an action whose parent isn't in the operational data. */
  readonly problems: { readonly message: string; readonly node: InstanceNode }[] = [];
  #configView: XPathDocument | undefined;
  readonly #filter: ((n: InstanceNode) => boolean) | undefined;
  #order: Map<XNode, number> | undefined;

  constructor(tree: DataTree, options: DocumentOptions = {}, filter?: (n: InstanceNode) => boolean) {
    this.root = tree;
    this.#filter = filter;
    const operational = options.operational;
    if (tree.kind === 'structure') {
      const top: InstanceNode[] = [];
      for (const n of tree.children) {
        const def = tree.schema.structures.find((s) => s.nodes.includes(n.schema as never));
        if (def?.extension === 'structure' && 'children' in n) {
          for (const c of n.children) {
            top.push(c);
            this.#parents.set(c, tree);
          }
        } else top.push(n);
      }
      if (operational !== undefined) top.push(...operational.children);
      this.#rootChildren = top;
    } else if ((tree.kind === 'rpc' || tree.kind === 'reply' || tree.kind === 'notification') && operational !== undefined) {
      const op = tree.operation;
      const top: InstanceNode[] = [...operational.children];
      if (op !== undefined) {
        if (op.parent instanceof DataTree || op.parent === undefined) top.push(op);
        else {
          const parent = counterpart(op.parent, operational);
          if (parent === undefined) {
            this.problems.push({ message: `the ${op.kind} needs its parent ${op.parent.path} to exist in the datastore data`, node: op });
            top.push(...tree.children);
          } else {
            this.#parents.set(op, parent);
            this.#extraChildren.set(parent, [op]);
          }
        }
      }
      this.#rootChildren = top;
    } else {
      this.#rootChildren = tree.children;
    }
  }

  /**
   * The view for a context node: configuration only when the node is
   * configuration in a tree that isn't a datastore's (RFC 7950 §6.4.1).
   */
  viewFor(context: XNode): XPathDocument {
    if (this.#filter !== undefined || context instanceof DataTree) return this;
    const tree = this.root;
    if (tree.kind !== 'data' || tree.schema.datastore !== undefined || !context.schema.config) return this;
    // Datastore trees have no joins, so a filtered copy of the plain document will do.
    this.#configView ??= new XPathDocument(tree, {}, (n) => n.schema.config);
    return this.#configView;
  }

  children(n: XNode): readonly InstanceNode[] {
    let out: readonly InstanceNode[];
    if (n === this.root) out = this.#rootChildren;
    else if (n instanceof DataTree || !('children' in n)) return [];
    else {
      const extra = this.#extraChildren.get(n);
      out = extra === undefined ? n.children : [...n.children, ...extra];
    }
    if (this.#filter === undefined) return out;
    // Filtered lists are cached; children are only ever added or removed, so a changed length means a stale entry.
    const cached = this.#filtered.get(n);
    if (cached !== undefined && cached.from === out.length && out === cached.source) return cached.nodes;
    const nodes = out.filter(this.#filter);
    this.#filtered.set(n, { source: out, from: out.length, nodes });
    return nodes;
  }
  readonly #filtered = new Map<XNode, { source: readonly InstanceNode[]; from: number; nodes: readonly InstanceNode[] }>();

  parent(n: XNode): XNode | undefined {
    if (n instanceof DataTree) return undefined;
    const p = this.#parents.get(n) ?? n.parent;
    return p instanceof DataTree ? this.root : p;
  }

  /** The node's position in document order (pre-order). */
  order(n: XNode): number {
    if (this.#order === undefined) {
      const order = new Map<XNode, number>();
      let i = 0;
      const stack: XNode[] = [this.root];
      while (stack.length > 0) {
        const x = stack.pop()!;
        order.set(x, i++);
        const kids = this.children(x);
        for (let k = kids.length - 1; k >= 0; k--) stack.push(kids[k]!);
      }
      this.#order = order;
    }
    return this.#order.get(n) ?? Number.MAX_SAFE_INTEGER;
  }

  /** Forgets what depends on the tree's shape, after nodes are added or removed. */
  changed(): void {
    this.#order = undefined;
    this.#filtered.clear();
    this.#configView?.changed();
  }
}

/** The node in `data` at the same place as `node` (same schema nodes, same list keys), if there is one. */
export function counterpart(node: InnerNode, data: DataTree): InnerNode | undefined {
  const chain: InstanceNode[] = [];
  for (let n: InnerNode | undefined = node; n !== undefined && !(n instanceof DataTree); n = n.parent) chain.unshift(n);
  let at: InnerNode = data;
  for (const step of chain) {
    const next: InstanceNode | undefined = at.children.find((c) => c.schema === step.schema && sameKeys(c, step));
    if (next === undefined || !('children' in next)) return undefined;
    at = next;
  }
  return at;
}

function sameKeys(a: InstanceNode, b: InstanceNode): boolean {
  if (!(a instanceof ListEntry) || !(b instanceof ListEntry)) return !(a instanceof OperationInstance);
  const ka = a.keys;
  const kb = b.keys;
  return ka.length === kb.length && ka.every((k, i) => sameValue(k.value, kb[i]!.value));
}

/** The schema node of an XPath node, undefined for the root. */
export function schemaOfNode(n: XNode): SchemaNode | undefined {
  return n instanceof DataTree ? undefined : n.schema;
}

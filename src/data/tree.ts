/**
 * The instance-data tree: YANG-modelled data independent of its encoding.
 *
 * A {@link DataTree} holds datastore content, an RPC or action invocation or
 * its reply, or a notification. Every node points to its schema node.
 * Children are kept in schema order, list keys first (the order RFC 7950
 * requires for XML keys and for RPC parameters, and the order libyang
 * prints), so encoders can write them as they are.
 *
 * Choice and case nodes have no instances: their children appear directly in
 * the parent, as in both encodings.
 */

import type {
  AnnotationDefinition,
  AnydataNode,
  CompiledModule,
  ContainerNode,
  LeafListNode,
  LeafNode,
  ListNode,
  NotificationNode,
  RpcNode,
  SchemaNode,
  StructureDefinition,
} from '../schema/model.js';
import { dataChildren, type Schema } from '../schema/schema.js';
import type { XmlChild } from '../xml/element.js';
import type { SourceLocation } from '../location.js';
import { formatJson, scalarText, type JsonValue } from './lexical.js';
import { positionsOf } from './positions.js';
import { xpathLiteral } from '../xpath/literal.js';
import type { TypedValue } from './value.js';

/**
 * A metadata annotation on a node (RFC 7952): an XML attribute, or a member
 * of a JSON metadata object. Attributes that no module defines, such as
 * NETCONF's `nc:operation`, are carried the same way.
 */
export interface Annotation {
  /** The namespace URI. `''` for an unqualified XML attribute. Undefined when only the module name is known. */
  readonly namespace: string | undefined;
  /** The defining module's name, when known: from the schema, or from the codec's `namespaces` option. */
  readonly module: string | undefined;
  readonly name: string;
  /** Typed when the schema defines the annotation, otherwise the text as written. */
  readonly value: TypedValue | string;
  /** The `md:annotation` definition, when the schema has one. */
  readonly definition?: AnnotationDefinition;
  /** The XML prefix it was written with, a hint for output. */
  readonly prefix?: string;
  /**
   * For an edit's `yang:key` or `yang:value` read from XML: the namespace
   * prefixes in scope at its element (prefix → URI), which prefixes inside
   * the value refer to.
   */
  readonly prefixes?: ReadonlyMap<string, string>;
}

/** The content of an anydata or anyxml node, kept in the encoding it was read from. */
export type AnyContent = { readonly format: 'xml'; readonly nodes: readonly XmlChild[] } | { readonly format: 'json'; readonly value: JsonValue };

export type InstanceNode = ContainerInstance | ListEntry | LeafInstance | LeafListEntry | AnyInstance | OperationInstance;
export type InnerNode = DataTree | ContainerInstance | ListEntry | OperationInstance;

/**
 * What a tree holds: datastore content, an RPC or action invocation, its
 * reply, a notification, or an instance of a YANG data structure
 * (`sx:structure`, `rc:yang-data`).
 */
export type TreeKind = 'data' | 'rpc' | 'reply' | 'notification' | 'structure';

abstract class NodeBase {
  parent: InnerNode | undefined = undefined;
  readonly annotations: Annotation[] = [];
  /**
   * True for a node that is there because of a schema default rather than
   * because it was written: added by `addDefaults`, or read with the
   * with-defaults `default` annotation set to true (RFC 6243 §6).
   */
  isDefault = false;

  abstract readonly schema: SchemaNode;

  /** The node's data path in RFC 7951 form, with list keys and leaf-list values as predicates. */
  get path(): string {
    const parent = this.parent;
    const parentPath = parent === undefined || parent instanceof DataTree ? '' : parent.path;
    const context = parent === undefined || parent instanceof DataTree ? undefined : parent.schema.module;
    return `${parentPath}/${stepName(this.schema, context)}${this.predicate()}`;
  }

  protected predicate(): string {
    return '';
  }

  /** The annotation with this name, from the module of that name (or namespace URI). */
  annotation(module: string, name: string): Annotation | undefined {
    return this.annotations.find((a) => a.name === name && (a.module === module || a.namespace === module));
  }
}

/** Shared by everything that has child nodes. */
abstract class Children extends NodeBase {
  readonly children: InstanceNode[] = [];

  /** Where each child schema node sorts, or undefined for insertion order. */
  protected abstract childOrder(): ReadonlyMap<SchemaNode, number> | undefined;

  /** Adds a child in schema order, after any existing instances of the same schema node, and returns it. */
  append<T extends InstanceNode>(node: T): T {
    insert(this as unknown as InnerNode, this.children, node, this.childOrder());
    return node;
  }

  remove(node: InstanceNode): boolean {
    const i = this.children.indexOf(node);
    if (i === -1) return false;
    this.children.splice(i, 1);
    node.parent = undefined;
    return true;
  }

  /** The first child with this name (and module, if given). */
  child(name: string, module?: string): InstanceNode | undefined {
    return this.children.find((c) => matches(c, name, module));
  }

  /** Every child with this name (and module): the entries of a list or leaf-list. */
  childrenNamed(name: string, module?: string): InstanceNode[] {
    return this.children.filter((c) => matches(c, name, module));
  }
}

export class ContainerInstance extends Children {
  readonly kind = 'container';
  constructor(readonly schema: ContainerNode) {
    super();
  }
  protected childOrder(): ReadonlyMap<SchemaNode, number> {
    return orderOf(this.schema);
  }
}

/** One entry of a list. */
export class ListEntry extends Children {
  readonly kind = 'list';
  constructor(readonly schema: ListNode) {
    super();
  }
  protected childOrder(): ReadonlyMap<SchemaNode, number> {
    return orderOf(this.schema);
  }
  /** The key leaves present, in key order. */
  get keys(): LeafInstance[] {
    return this.schema.keys.map((k) => this.children.find((c): c is LeafInstance => c.schema === k)).filter((k) => k !== undefined);
  }
  protected override predicate(): string {
    return this.keys.map((k) => `[${k.schema.name}=${xpathLiteral(scalarText(formatJson(k.value)))}]`).join('');
  }
}

export class LeafInstance extends NodeBase {
  readonly kind = 'leaf';
  constructor(
    readonly schema: LeafNode,
    public value: TypedValue,
  ) {
    super();
  }
}

/** One entry of a leaf-list. */
export class LeafListEntry extends NodeBase {
  readonly kind = 'leaf-list';
  constructor(
    readonly schema: LeafListNode,
    public value: TypedValue,
  ) {
    super();
  }
  protected override predicate(): string {
    const v = formatJson(this.value);
    return `[.=${xpathLiteral(scalarText(v))}]`;
  }
}

export class AnyInstance extends NodeBase {
  readonly kind: 'anydata' | 'anyxml';
  constructor(
    readonly schema: AnydataNode,
    public content: AnyContent,
  ) {
    super();
    this.kind = schema.kind;
  }
}

/**
 * An RPC, action or notification instance. For an RPC or action, its
 * children are the input parameters or, in a reply, the output parameters.
 */
export class OperationInstance extends Children {
  readonly kind: 'rpc' | 'action' | 'notification';
  constructor(
    readonly schema: RpcNode | NotificationNode,
    /** Input or output, for an RPC or action. Undefined for a notification. */
    readonly direction: 'input' | 'output' | undefined,
  ) {
    super();
    this.kind = schema.kind;
  }
  /** The schema node whose children the parameters are: input, output or the notification. */
  get parameters(): SchemaNode {
    if (this.schema.kind === 'notification') return this.schema;
    return this.direction === 'output' ? this.schema.output : this.schema.input;
  }
  protected childOrder(): ReadonlyMap<SchemaNode, number> {
    return orderOf(this.parameters);
  }
}

/** The root of an instance tree. Top-level nodes keep the order they were added in. */
export class DataTree {
  readonly children: InstanceNode[] = [];

  constructor(
    readonly schema: Schema,
    readonly kind: TreeKind = 'data',
    /** For a `structure` tree, the structure it holds, if it is limited to one. */
    readonly structure?: StructureDefinition,
  ) {}

  append<T extends InstanceNode>(node: T): T {
    insert(this, this.children, node, undefined);
    return node;
  }

  remove(node: InstanceNode): boolean {
    const i = this.children.indexOf(node);
    if (i === -1) return false;
    this.children.splice(i, 1);
    node.parent = undefined;
    return true;
  }

  child(name: string, module?: string): InstanceNode | undefined {
    return this.children.find((c) => matches(c, name, module));
  }

  childrenNamed(name: string, module?: string): InstanceNode[] {
    return this.children.filter((c) => matches(c, name, module));
  }

  /**
   * Where a node is in the text the tree was decoded from: the start of its
   * XML element, or of its JSON member name (a list entry's object, a
   * leaf-list entry's value). Undefined unless the tree was decoded from text
   * with the `positions` option, and for nodes added since.
   */
  position(node: InstanceNode): SourceLocation | undefined {
    return positionsOf(this)?.of(node);
  }

  /** The RPC, action or notification in an operation tree, found depth-first. */
  get operation(): OperationInstance | undefined {
    const find = (nodes: readonly InstanceNode[]): OperationInstance | undefined => {
      for (const n of nodes) {
        if (n instanceof OperationInstance) return n;
        if ('children' in n) {
          const found = find(n.children);
          if (found !== undefined) return found;
        }
      }
      return undefined;
    };
    return find(this.children);
  }

  /** Every node, depth-first in document order. */
  *walk(): Generator<InstanceNode> {
    function* visit(nodes: readonly InstanceNode[]): Generator<InstanceNode> {
      for (const n of nodes) {
        yield n;
        if ('children' in n) yield* visit(n.children);
      }
    }
    yield* visit(this.children);
  }
}

function matches(node: InstanceNode, name: string, module: string | undefined): boolean {
  return node.schema.name === name && (module === undefined || node.schema.module.name === module);
}

/** A node's name in a data path: qualified at the top and where the module changes. */
function stepName(schema: SchemaNode, context: CompiledModule | undefined): string {
  return schema.module === context ? schema.name : `${schema.module.name}:${schema.name}`;
}

const ORDER = new WeakMap<SchemaNode, ReadonlyMap<SchemaNode, number>>();

/** Sort positions of a schema node's data children: list keys first, then schema order. */
function orderOf(schema: SchemaNode): ReadonlyMap<SchemaNode, number> {
  let order = ORDER.get(schema);
  if (order === undefined) {
    const map = new Map<SchemaNode, number>();
    const keys: readonly SchemaNode[] = schema.kind === 'list' ? schema.keys : [];
    keys.forEach((k, i) => map.set(k, i));
    let i = keys.length;
    for (const c of dataChildren(schema)) if (!map.has(c)) map.set(c, i++);
    order = map;
    ORDER.set(schema, order);
  }
  return order;
}

function insert(parent: InnerNode, children: InstanceNode[], node: InstanceNode, order: ReadonlyMap<SchemaNode, number> | undefined): void {
  if (node.parent !== undefined) node.parent.remove(node);
  node.parent = parent;
  if (order === undefined) {
    // Keep instances of the same schema node together.
    let last = -1;
    for (let i = 0; i < children.length; i++) if (children[i]!.schema === node.schema) last = i;
    if (last === -1) children.push(node);
    else children.splice(last + 1, 0, node);
    return;
  }
  // Children are sorted by rank: find the first one ranked after the node.
  const rankOf = (n: InstanceNode): number => order.get(n.schema) ?? Number.MAX_SAFE_INTEGER;
  const rank = rankOf(node);
  let lo = 0;
  let hi = children.length;
  if (hi === 0 || rankOf(children[hi - 1]!) <= rank) lo = hi;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rankOf(children[mid]!) <= rank) lo = mid + 1;
    else hi = mid;
  }
  children.splice(lo, 0, node);
}

/** The schema of the tree a node is in. */
export function schemaOf(n: InstanceNode): Schema {
  let p = n.parent;
  while (p !== undefined && !(p instanceof DataTree)) p = p.parent;
  if (p === undefined) throw new TypeError(`node ${n.schema.name} is not in a tree`);
  return p.schema;
}

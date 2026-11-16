/**
 * What the XML and JSON decoders share: where nodes may appear, the checks
 * made as a tree is built, and collecting problems with their paths.
 */

import { YangDataError, type DataIssue } from '../errors.js';
import type { ValidateOptions } from '../validate/validate.js';
import type { CompiledModule, ListNode, SchemaNode } from '../schema/model.js';
import { dataChildren, type Schema } from '../schema/schema.js';
import { parseInstanceIdentifier } from './instance-id.js';
import { formatJson, scalarText } from './lexical.js';
import type { PositionTable } from './positions.js';
import { ContainerInstance, DataTree, LeafInstance, ListEntry, OperationInstance, type InnerNode, type InstanceNode, type TreeKind } from './tree.js';

/** Options both decoders take. */
export interface DecodeOptions {
  /**
   * What the input holds: datastore content (`data`, the default), an RPC or
   * action invocation (`rpc`), its reply (`reply`), or a notification.
   *
   * An operation is written as its own element (XML) or member (JSON),
   * holding the input or output parameters, inside its data ancestors for an
   * action or a nested notification. libyang reads and writes the same form.
   */
  readonly type?: TreeKind;
  /**
   * For type `structure`: the structure the input holds, as
   * `module:name`. Without it, any structure of the schema's implemented
   * modules may appear.
   */
  readonly structure?: string;
  /**
   * For `rpc`, `reply` and `notification`: the input is only the
   * parameters (or the notification's content), without the operation's
   * element, as in a NETCONF `<rpc-reply>`. The operation is given here as a
   * data path: `/module:rpc` or `/module:notification`, or for an action or
   * a nested notification the path of its parent with keys, as in
   * `/ex:servers/server[name='a']/reset`.
   */
  readonly operation?: string;
  /** What to do with nodes the schema doesn't have: report them (the default) or skip them. */
  readonly unknown?: 'error' | 'skip';
  /**
   * Namespace URI → module name, for annotations from modules the schema
   * doesn't have, such as NETCONF's `operation` attribute
   * (`urn:ietf:params:xml:ns:netconf:base:1.0` → `ietf-netconf`). Used in
   * both directions.
   */
  readonly namespaces?: Readonly<Record<string, string>>;
  /**
   * Validate the tree once it is read, as {@link validate} does, and throw
   * its errors with any others (`true`, or the validation options). Only a
   * tree that decoded without problems is validated.
   */
  readonly validate?: boolean | ValidateOptions;
  /**
   * For type `data`: the input is the content of a NETCONF edit
   * (`<edit-config>` or `<edit-data>`), as libyang's `edit` type reads it.
   * The edit annotations are then known without the `namespaces` option and
   * checked: `ietf-netconf:operation` (merge, replace, create, delete or
   * remove), and `yang:insert` (first, last, before or after) with
   * `yang:key` on an entry of an ordered-by-user list or `yang:value` on an
   * entry of an ordered-by-user leaf-list (RFC 7950 §7.7.9, §7.8.6). Their
   * values are kept as written, as libyang does. In JSON, a leaf whose own
   * operation is `delete` or `remove` may also be `null`, for an XML element
   * with no value.
   */
  readonly edit?: boolean;
  /**
   * Record where each node is in the input text, so that issues, from
   * decoding and from validating the tree later, carry a `position` (line and
   * column), and `tree.position(node)` answers. Only for text input: parsed
   * elements and JSON values have no positions. Off by default: a large
   * document's tree takes about a quarter more memory, and JSON is then read
   * by a parser that tracks positions, more slowly than by `JSON.parse`.
   */
  readonly positions?: boolean;
}

/** The NETCONF base namespace, home of the `operation` edit attribute. */
export const NETCONF_NS = 'urn:ietf:params:xml:ns:netconf:base:1.0';
/** The YANG namespace (RFC 7950 §5.3.1), home of the `insert`, `key` and `value` edit attributes. */
export const YANG_NS = 'urn:ietf:params:xml:ns:yang:1';

const EDIT_OPERATIONS = new Set(['merge', 'replace', 'create', 'delete', 'remove']);
const INSERTS = new Set(['first', 'last', 'before', 'after']);

/**
 * Checks one edit annotation (decode option `edit`) on an instance.
 * Returns the problem, or undefined when the annotation is not an edit
 * annotation or is valid. Placement of `key`/`value` without `insert`, and
 * `before`/`after` without them, is checked by {@link checkEditAnnotations}.
 */
export function editAnnotationProblem(namespace: string, name: string, value: string, inst: { readonly kind: string; readonly schema: unknown }): string | undefined {
  if (namespace === NETCONF_NS) {
    if (name !== 'operation') return `ietf-netconf:${name} is not an edit annotation; only operation is`;
    return EDIT_OPERATIONS.has(value) ? undefined : `operation '${value}' is not merge, replace, create, delete or remove`;
  }
  if (namespace !== YANG_NS) return undefined;
  const ordered = (inst.kind === 'list' || inst.kind === 'leaf-list') && (inst.schema as { orderedBy?: string }).orderedBy === 'user';
  switch (name) {
    case 'insert':
      if (!ordered) return 'yang:insert is only for an entry of an ordered-by-user list or leaf-list';
      return INSERTS.has(value) ? undefined : `insert '${value}' is not first, last, before or after`;
    case 'key':
      return ordered && inst.kind === 'list' ? undefined : 'yang:key is only for an entry of an ordered-by-user list';
    case 'value':
      return ordered && inst.kind === 'leaf-list' ? undefined : 'yang:value is only for an entry of an ordered-by-user leaf-list';
    default:
      return `yang:${name} is not an edit annotation; only insert, key and value are`;
  }
}

/** Checks that `yang:insert` before/after has its `key` or `value`, and that those come only with it. */
export function checkEditAnnotations(inst: InstanceNode, issues: Issues): void {
  const yang = inst.annotations.filter((a) => a.namespace === YANG_NS);
  if (yang.length === 0) return;
  const insert = yang.find((a) => a.name === 'insert')?.value;
  const anchor = yang.find((a) => a.name === 'key' || a.name === 'value');
  const need = inst.kind === 'list' ? 'yang:key' : 'yang:value';
  if ((insert === 'before' || insert === 'after') && anchor === undefined) issues.add('invalid-edit', `yang:insert '${insert}' needs ${need}`, inst.path, issues.at(inst));
  if (anchor !== undefined && insert !== 'before' && insert !== 'after') issues.add('invalid-edit', `yang:${anchor.name} needs yang:insert 'before' or 'after'`, inst.path, issues.at(inst));
}

/** Details an issue may carry besides its code, message and path. */
export type IssueDetails = Partial<Omit<DataIssue, 'code' | 'message' | 'path'>>;

const NO_DETAILS: IssueDetails = Object.freeze({});

export class Issues {
  readonly list: DataIssue[] = [];
  /** Where nodes are in the input, when it is decoded with positions. */
  positions: PositionTable | undefined = undefined;
  /** The position details for an issue on a node, or at an offset into the input (none without positions). */
  at(where: InstanceNode | number | undefined): IssueDetails {
    const table = this.positions;
    if (table === undefined || where === undefined) return NO_DETAILS;
    const position = typeof where === 'number' ? table.at(where) : table.of(where);
    return position === undefined ? NO_DETAILS : { position };
  }
  add(code: string, message: string, path: string, details: IssueDetails = {}): void {
    this.list.push({ code, message, path: path === '' ? '/' : path, severity: 'error', ...details });
  }
  get errors(): DataIssue[] {
    return this.list.filter((i) => i.severity === 'error');
  }
  throwIfAny(): void {
    const errors = this.errors;
    if (errors.length > 0) throw new YangDataError(errors);
  }
}

const OPERATIONS = new Set(['rpc', 'action', 'notification']);

/** Nodes that may appear at the top of a tree. */
export function topCandidates(tree: DataTree): SchemaNode[] {
  const { schema, kind } = tree;
  const flat = (nodes: readonly SchemaNode[]): SchemaNode[] => nodes.flatMap((n) => (n.kind === 'choice' ? dataChildren(n) : [n]));
  if (kind === 'structure') return flat((tree.structure === undefined ? schema.structures : [tree.structure]).flatMap((s) => s.nodes));
  const out: SchemaNode[] = flat(schema.dataNodes);
  if (kind === 'rpc' || kind === 'reply') out.push(...schema.rpcs);
  if (kind === 'notification') out.push(...schema.notifications);
  return out;
}

/** Nodes that may appear inside an instance. */
export function childCandidates(parent: InnerNode): SchemaNode[] {
  if (parent instanceof DataTree) return topCandidates(parent);
  if (parent instanceof OperationInstance) return dataChildren(parent.parameters);
  return dataChildren(parent.schema);
}

/** The path of a child named `name` in `module`, under `parent`. */
export function childPath(parent: InnerNode, module: CompiledModule | undefined, name: string): string {
  if (parent instanceof DataTree) return `/${module === undefined ? '' : `${module.name}:`}${name}`;
  return `${parent.path}/${module === undefined || module === parent.schema.module ? '' : `${module.name}:`}${name}`;
}

/** Why an operation can't appear here, or undefined if it can. */
export function operationProblem(node: SchemaNode, parent: InnerNode, kind: TreeKind): string | undefined {
  if (kind === 'data') return `${node.kind} ${node.name} can't appear in datastore content`;
  if ((kind === 'rpc' || kind === 'reply') && node.kind === 'notification') return `notification ${node.name} can't appear in an ${kind}`;
  if (kind === 'notification' && node.kind !== 'notification') return `${node.kind} ${node.name} can't appear in a notification`;
  for (let p: InnerNode | undefined = parent; p !== undefined && !(p instanceof DataTree); p = p.parent) {
    if (p instanceof OperationInstance) return `${node.kind} ${node.name} is inside another operation`;
  }
  return undefined;
}

/**
 * Why a node can't be in this tree's datastore, or undefined if it can:
 * state data (config false) in a configuration datastore (RFC 8342 §5.1).
 */
export function datastoreProblem(tree: DataTree, node: SchemaNode): string | undefined {
  if (tree.kind !== 'data' || tree.schema.holdsState || node.config) return undefined;
  return `${node.kind} ${node.name} is state data (config false), which the ${tree.schema.datastore ?? 'configuration'} datastore can't hold`;
}

/** The ietf-origin module's namespace (RFC 8342 §7.4). */
export const ORIGIN_NS = 'urn:ietf:params:xml:ns:yang:ietf-origin';

/** Why an annotation can't be in this tree's datastore: `or:origin` belongs to `<operational>` only (RFC 8342 §7.4). */
export function annotationProblem(tree: DataTree, namespace: string | undefined, module: string | undefined, name: string): string | undefined {
  if (tree.kind !== 'data' || tree.schema.holdsState || name !== 'origin') return undefined;
  if (namespace !== ORIGIN_NS && module !== 'ietf-origin') return undefined;
  return `the origin annotation belongs to the operational datastore, not ${tree.schema.datastore ?? 'a configuration datastore'}`;
}

/** Whether a single-instance node (container, leaf, anydata) already has an instance in `parent`. */
export function isDuplicate(parent: InnerNode, node: SchemaNode): boolean {
  if (node.kind === 'list' || node.kind === 'leaf-list') return false;
  return parent.children.some((c) => c.schema === node);
}

/** Tracks list entry keys per parent, to find duplicate entries. */
export class EntryKeys {
  readonly #seen = new Map<InnerNode, Map<ListNode, Set<string>>>();

  /** Checks a finished list entry: every key present, and no other entry with the same keys. */
  check(entry: ListEntry, issues: Issues): void {
    const keys = entry.keys;
    for (const k of entry.schema.keys) {
      if (!keys.some((x) => x.schema === k)) issues.add('missing-key', `list entry has no value for key '${k.name}'`, entry.path, issues.at(entry));
    }
    if (keys.length !== entry.schema.keys.length || keys.length === 0 || entry.parent === undefined) return;
    let byList = this.#seen.get(entry.parent);
    if (byList === undefined) this.#seen.set(entry.parent, (byList = new Map<ListNode, Set<string>>()));
    let set = byList.get(entry.schema);
    if (set === undefined) byList.set(entry.schema, (set = new Set<string>()));
    const signature = keys.map((k) => scalarText(formatJson(k.value))).join('\u0000');
    if (set.has(signature)) issues.add('duplicate-entry', 'another entry of this list has the same keys', entry.path, issues.at(entry));
    set.add(signature);
  }
}

/** The tree a decoder fills: its kind, and the structure named by the `structure` option. */
export function newTree(schema: Schema, options: DecodeOptions, issues: Issues): DataTree {
  const kind = options.type ?? 'data';
  if (options.structure === undefined) return new DataTree(schema, kind);
  const structure = schema.structure(options.structure);
  if (kind !== 'structure') issues.add('invalid-structure', `the structure option needs type 'structure', not '${kind}'`, '/');
  else if (structure === undefined) issues.add('invalid-structure', `'${options.structure}' is not a structure of an implemented module`, '/');
  return new DataTree(schema, kind, structure);
}

/** For trees of operations: exactly one RPC, action or notification. */
export function checkOperation(tree: DataTree, issues: Issues): void {
  if (tree.kind === 'data' || tree.kind === 'structure') return;
  let count = 0;
  for (const n of tree.walk()) if (OPERATIONS.has(n.kind)) count++;
  if (count === 0) issues.add('missing-operation', `the ${tree.kind} holds no ${tree.kind === 'notification' ? 'notification' : 'RPC or action'}`, '/');
  if (count > 1) issues.add('multiple-operations', `the ${tree.kind} holds ${count} operations, not one`, '/');
}

/**
 * Builds the operation named by the `operation` option, with its data
 * ancestors and their keys, and returns it for the parameters to go in.
 */
export function startOperation(tree: DataTree, path: string, issues: Issues): OperationInstance | undefined {
  const fail = (message: string): undefined => {
    issues.add('invalid-operation', message, path);
    return undefined;
  };
  if (tree.kind !== 'rpc' && tree.kind !== 'reply' && tree.kind !== 'notification') {
    return fail(`the operation option needs type 'rpc', 'reply' or 'notification', not '${tree.kind}'`);
  }
  const notification = tree.kind === 'notification';
  const direction = notification ? undefined : tree.kind === 'rpc' ? 'input' : 'output';
  const what = notification ? 'a notification' : 'an action';
  const split = lastStep(path.trim());
  if (split === undefined) return fail(`'${path}' is not an operation path`);
  const { parent, prefix, name } = split;
  const json = { format: 'json' as const, schema: tree.schema, module: (p: string): CompiledModule | undefined => tree.schema.module(p), unprefixed: undefined };

  if (parent === '') {
    const top = prefix === undefined ? undefined : tree.schema.module(prefix);
    const op = notification ? top?.notifications.find((n) => n.name === name) : top?.rpcs.find((r) => r.name === name);
    if (op === undefined) return fail(`'${path}' is not ${notification ? 'a notification' : 'an RPC'} of the schema`);
    return tree.append(new OperationInstance(op, direction));
  }
  const id = parseInstanceIdentifier(parent, json);
  if (typeof id === 'string') return fail(id);
  const last = id.steps[id.steps.length - 1]!.node;
  const module = prefix === undefined ? last.module : tree.schema.module(prefix);
  const kind = notification ? 'notification' : 'action';
  const nested = dataChildren(last).find((c) => c.kind === kind && c.name === name && c.module === module);
  if (nested === undefined || (nested.kind !== 'action' && nested.kind !== 'notification')) return fail(`'${path}' is not ${what} of the schema`);

  let at: InnerNode = tree;
  for (const step of id.steps) {
    const node = step.node;
    if (node.kind === 'container') at = at.append(new ContainerInstance(node));
    else if (node.kind === 'list') {
      const entry: ListEntry = at.append(new ListEntry(node));
      for (const k of step.keys ?? []) entry.append(new LeafInstance(k.key, k.value));
      if (entry.keys.length !== node.keys.length) return fail(`'${path}' doesn't give every key of ${node.name}`);
      at = entry;
    } else return fail(`'${path}' goes through ${node.kind} ${node.name}`);
  }
  return at.append(new OperationInstance(nested, direction));
}

/** Splits `/a/b[k='/x']/c` into the path before the last step, and the last step's prefix and name. */
function lastStep(path: string): { parent: string; prefix: string | undefined; name: string } | undefined {
  let depth = 0;
  let quote: string | undefined;
  let cut = -1;
  for (let i = 0; i < path.length; i++) {
    const c = path[i]!;
    if (quote !== undefined) {
      if (c === quote) quote = undefined;
    } else if (depth > 0 && (c === "'" || c === '"')) quote = c;
    else if (c === '[') depth++;
    else if (c === ']') depth--;
    else if (c === '/' && depth === 0) cut = i;
  }
  if (cut === -1) return undefined;
  const m = /^(?:([A-Za-z_][A-Za-z0-9_.-]*):)?([A-Za-z_][A-Za-z0-9_.-]*)$/.exec(path.slice(cut + 1));
  if (m === null) return undefined;
  return { parent: path.slice(0, cut), prefix: m[1], name: m[2]! };
}

/** The modules of a schema by namespace URI. */
const BY_NAMESPACE = new WeakMap<Schema, Map<string, CompiledModule>>();
export function modulesByNamespace(schema: Schema): Map<string, CompiledModule> {
  let map = BY_NAMESPACE.get(schema);
  if (map === undefined) {
    map = new Map();
    for (const m of schema.modules.values()) map.set(m.namespace, m);
    BY_NAMESPACE.set(schema, map);
  }
  return map;
}

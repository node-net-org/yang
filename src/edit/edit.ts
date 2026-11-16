/**
 * The edit engine: applies the content of a NETCONF `<edit-config>` (RFC
 * 6241 §7.2) or NMDA `<edit-data>` (RFC 8526 §3.2.2) to a copy of a
 * datastore's tree.
 *
 * The edit is a `data` tree whose nodes may carry the edit annotations the
 * decoders read with their `edit` option: `nc:operation` (merge, replace,
 * create, delete, remove) and, on entries of ordered-by-user lists and
 * leaf-lists, `yang:insert` with `yang:key` or `yang:value` (RFC 7950
 * §7.7.9, §7.8.6). A node without an operation inherits its parent's; the
 * top-level default is the `defaultOperation` option.
 */

import { sameAnyContent } from '../data/any-compare.js';
import { Issues, NETCONF_NS, YANG_NS, type IssueDetails } from '../data/build.js';
import { formatJson, parseText, scalarText, type ValueScope } from '../data/lexical.js';
import {
  AnyInstance,
  DataTree,
  ContainerInstance,
  LeafInstance,
  LeafListEntry,
  ListEntry,
  OperationInstance,
  type Annotation,
  type InnerNode,
  type InstanceNode,
} from '../data/tree.js';
import { YangDataError, type DataIssue } from '../errors.js';
import type { CompiledModule, SchemaNode } from '../schema/model.js';
import type { Schema } from '../schema/schema.js';
import { validate, type ValidateOptions } from '../validate/validate.js';
import { copyNode, copyTree, entryIdentity, isDataAnnotation } from './copy.js';
import { effectiveOrigin, isOriginAnnotation, originValue, ownOrigin, sameOrigin } from './origin.js';

/** An `nc:operation` value (RFC 6241 §7.2). */
export type EditOperation = 'merge' | 'replace' | 'create' | 'delete' | 'remove';

export interface EditOptions {
  /**
   * The operation of nodes that have none of their own and no ancestor
   * with one: `<edit-config>`'s `<default-operation>`. `merge` by default.
   * With `none`, nodes without an operation only lead to the nodes that
   * have one; a container or list entry they name that doesn't exist is
   * created only if something below it is. With `replace`, the edit
   * replaces the whole configuration: top-level nodes it doesn't name are
   * removed.
   */
  readonly defaultOperation?: 'merge' | 'replace' | 'none';
  /**
   * Validate the result, as {@link validate} does, and throw its errors
   * (`true`, or the validation options). A server validates the result
   * of an edit to `<running>`, but not one to `<candidate>` until commit.
   */
  readonly validate?: boolean | ValidateOptions;
  /**
   * Let the edit change state data (config false), for a server editing the
   * state it holds rather than a client's `<edit-config>`. It applies only
   * to a target whose schema holds state (`<operational>`): there, state
   * nodes are created, merged, replaced, deleted and removed as
   * configuration is, and `replace` replaces a node's state too. Off by
   * default, and on any other tree, as NETCONF has it: an edit of state
   * data fails with `invalid-edit`.
   */
  readonly state?: boolean;
}

/** An `<error-option>` value (RFC 6241 §7.2): what an edit does when part of it fails. */
export type ErrorOption = 'rollback-on-error' | 'stop-on-error' | 'continue-on-error';

const ERROR_OPTIONS = new Set<string>(['rollback-on-error', 'stop-on-error', 'continue-on-error']);

export interface TryEditOptions extends EditOptions {
  /**
   * What happens when part of the edit fails. `rollback-on-error` (the
   * default) applies nothing. `stop-on-error` keeps what was applied before
   * the first error. `continue-on-error` skips each part that fails and
   * applies the rest. See {@link tryApplyEdit}.
   */
  readonly errorOption?: ErrorOption;
}

/** What {@link tryApplyEdit} did. */
export interface EditResult {
  /** The result. `target` itself when the edit was rejected. */
  readonly tree: DataTree;
  /** Every error: the edit's, in document order, then validation's. Empty when the whole edit applied. */
  readonly errors: readonly DataIssue[];
  /**
   * True when nothing was applied: an error under `rollback-on-error`, or
   * a validation error under any option. Under `stop-on-error` and
   * `continue-on-error`, an edit with errors that passes validation is not
   * rejected: `tree` holds the parts that applied.
   */
  readonly rejected: boolean;
}

/**
 * Applies an edit to a copy of `target` and returns the copy. `target` is
 * not changed. Every problem is reported together and nothing is applied
 * (`<edit-config>`'s `rollback-on-error`); {@link tryApplyEdit} offers the
 * other error options and returns the errors rather than throwing them.
 *
 * - `create` fails with `data-exists` if the node exists, `delete` with
 *   `data-missing` if it doesn't; `remove` of a missing node does nothing.
 * - `merge` creates what doesn't exist and sets leaf values; `replace` makes
 *   a node's configuration exactly what the edit gives (state data in it is
 *   kept). A list entry is matched by its keys, a leaf-list entry by its
 *   value. A leaf-list entry's or leaf's value need not be given to delete it.
 * - A node that is there only as a default (`isDefault`) counts as missing,
 *   as RFC 6243 §4.5 has it for the `explicit` basic mode.
 * - A new entry of an ordered-by-user list or leaf-list goes last, or where
 *   `yang:insert` says; an existing one moves only when it has
 *   `yang:insert`, or when its parent is being replaced, in which case the
 *   entries take the edit's order. An anchor that doesn't exist fails with
 *   `missing-anchor` (app tag `missing-instance`, RFC 7950 §15.7).
 * - Creating a node in one case of a choice deletes the nodes of the
 *   choice's other cases (RFC 7950 §7.9). An edit that creates nodes in two
 *   cases fails with `multiple-cases`.
 * - Non-presence containers left empty by the edit are removed. Edit
 *   annotations aren't copied into the result; other annotations are.
 * - In a tree whose schema holds state (`<operational>`), an edit node's
 *   `or:origin` (RFC 8342 §7.4) replaces the node's own, so a node has at
 *   most one, however the annotations were read or built. Where it is the
 *   origin the node would inherit from its parent, the node is left with
 *   none of its own. An edit node without one leaves the node's origin as
 *   it is, and a node created without one inherits its parent's. Other
 *   trees' annotations are copied as they are.
 * - State data (config false), operations and nodes without a value where
 *   one is needed fail with `invalid-edit`; with the `state` option, on a
 *   tree that holds state, state data is edited like configuration.
 *
 * The edit's nodes must come from the same compiled modules as the
 * target's: decode it with the target's schema, or another datastore's
 * schema from the same compile.
 *
 * @throws YangDataError with every problem found; nothing is applied
 */
export function applyEdit(target: DataTree, edit: DataTree, options: EditOptions = {}): DataTree {
  const outcome = tryApplyEdit(target, edit, { ...options, errorOption: 'rollback-on-error' });
  if (outcome.rejected) throw new YangDataError(outcome.errors);
  return outcome.tree;
}

/**
 * Applies an edit to a copy of `target`, as {@link applyEdit} does, with one
 * of `<edit-config>`'s error options (RFC 6241 §7.2), and returns the result
 * with its errors rather than throwing them. `target` is not changed.
 *
 * The edit is processed in the order of its tree, depth first: a node's
 * own operation, then its children (in schema order, as a decoded tree
 * holds them, with list and leaf-list entries in the order given). An
 * error belongs to the edit node it is found at: `data-exists`,
 * `data-missing`, `missing-anchor`, `multiple-cases` or `invalid-edit`.
 *
 * - `rollback-on-error` (the default): any error rejects the edit. Every
 *   error is reported, as `applyEdit` reports them.
 * - `stop-on-error`: processing stops at the first error. The result holds
 *   what was applied before it, and nothing of the failing node, its
 *   subtree or anything after it. A `replace` that the stop cuts short
 *   doesn't remove the children it didn't name, since that comes after its
 *   children. Exactly one error is reported.
 * - `continue-on-error`: a node that fails is skipped with its subtree, and
 *   everything else is applied. Every error is reported.
 *
 * A skipped node leaves the data it names as it was, also under a node being
 * replaced. Anchors and choices are judged against the data as it is when
 * the node is reached: an anchor that a skipped node would have created is
 * missing, and a node in another case of a choice than a skipped node is no
 * conflict. Non-presence containers left empty are removed whatever the
 * option.
 *
 * With `validate`, the result is validated when the edit isn't already
 * rejected (under `stop-on-error` and `continue-on-error`, the partial
 * result), and a validation error rejects the whole edit whatever the
 * option.
 *
 * @throws TypeError if the trees aren't datastore data, or `errorOption` isn't one of the three
 */
export function tryApplyEdit(target: DataTree, edit: DataTree, options: TryEditOptions = {}): EditResult {
  if (target.kind !== 'data' || edit.kind !== 'data') throw new TypeError(`an edit applies data to data, not ${edit.kind} to ${target.kind}`);
  const errorOption = options.errorOption ?? 'rollback-on-error';
  if (!ERROR_OPTIONS.has(errorOption)) throw new TypeError(`errorOption '${String(errorOption)}' is not rollback-on-error, stop-on-error or continue-on-error`);
  const result = copyTree(target);
  const editor = new Editor(result.schema, errorOption, result.schema.holdsState, options.state === true && result.schema.holdsState);
  const root = options.defaultOperation ?? 'merge';
  const touched = editor.children(result, edit.children, root === 'none' ? undefined : root, root === 'replace');
  if (root === 'replace' && !editor.stopped) editor.removeUntouched(result, touched);
  const errors = editor.issues.errors;
  if (errors.length > 0 && errorOption === 'rollback-on-error') return { tree: target, errors, rejected: true };
  if (options.validate !== undefined && options.validate !== false) {
    const invalid = validate(result, options.validate === true ? {} : options.validate).filter((i) => i.severity === 'error');
    if (invalid.length > 0) return { tree: target, errors: [...errors, ...invalid], rejected: true };
  }
  return { tree: result, errors, rejected: false };
}

type Mode = EditOperation | undefined;

/** Where an ordered-by-user entry goes. */
interface Placement {
  readonly where: 'first' | 'last' | 'before' | 'after';
  readonly anchor?: InstanceNode;
}

const OPERATIONS = new Set<string>(['merge', 'replace', 'create', 'delete', 'remove']);

class Editor {
  readonly issues = new Issues();
  /** Set at the first error under `stop-on-error`: nothing more is applied. */
  stopped = false;
  /** Nodes this edit created or merged into, to tell a second case of a choice from an old one. */
  readonly #written = new WeakSet<InstanceNode>();
  /** Each parent's children by schema node and identity (keys or value), built when first needed. */
  readonly #indexes = new WeakMap<InnerNode, Map<SchemaNode, Map<string, InstanceNode>>>();

  constructor(
    readonly schema: Schema,
    readonly errorOption: ErrorOption,
    /** Whether origins are handled: the target's schema holds state. */
    readonly origins: boolean,
    /** Whether state data may be edited (the `state` option, on a tree that holds state). */
    readonly state: boolean = false,
  ) {}

  /** Whether a node that fails is left out. Under rollback-on-error the result is discarded, so the edit carries on as it can, to find every error. */
  get #skipping(): boolean {
    return this.errorOption !== 'rollback-on-error';
  }

  /** Records an error at edit node `e`. */
  #fail(code: string, message: string, e: InstanceNode, details?: IssueDetails): void {
    this.issues.add(code, message, e.path, details);
    if (this.errorOption === 'stop-on-error') this.stopped = true;
  }

  /**
   * Applies edit nodes to a target parent's children, with the operation
   * they inherit (undefined for `none`). Returns the target children the
   * edit named, which a replace keeps. `reorder` moves existing
   * ordered-by-user entries into the edit's order.
   */
  children(parent: InnerNode, edits: readonly InstanceNode[], inherited: Mode, reorder: boolean): Set<InstanceNode> {
    const touched = new Set<InstanceNode>();
    const keys = parent instanceof ListEntry ? new Set<SchemaNode>(parent.schema.keys) : undefined;
    for (const e of edits) {
      if (this.stopped) break;
      if (keys?.has(e.schema) === true) continue;
      const node = this.#node(parent, e, inherited, reorder);
      if (node !== undefined) touched.add(node);
    }
    return touched;
  }

  /** In a node being replaced: removes the configuration children the edit didn't name (and state ones, when state is edited), except list keys. */
  removeUntouched(parent: InnerNode, touched: ReadonlySet<InstanceNode>): void {
    const keys = parent instanceof ListEntry ? new Set<SchemaNode>(parent.schema.keys) : new Set<SchemaNode>();
    const children = parent.children;
    let kept = 0;
    for (const c of children) {
      if (touched.has(c) || (!c.schema.config && !this.state) || keys.has(c.schema)) children[kept++] = c;
      else c.parent = undefined;
    }
    if (kept === children.length) return;
    children.length = kept;
    this.#indexes.delete(parent);
  }

  /**
   * Applies one edit node. Returns the target node it names, if one is
   * left; a node that failed returns the target node as it was, so that a
   * parent being replaced keeps it.
   */
  #node(parent: InnerNode, e: InstanceNode, inherited: Mode, reorder: boolean): InstanceNode | undefined {
    const own = this.#operation(e);
    if (own === null) return this.#find(parent, e);
    const op = own ?? inherited;
    if (e instanceof OperationInstance) {
      this.#fail('invalid-edit', `an edit can't hold the ${e.kind} ${e.schema.name}`, e);
      return undefined;
    }
    if (!e.schema.config && !this.state) {
      this.#fail('invalid-edit', `${e.schema.name} is state data, which can't be edited`, e);
      return this.#find(parent, e);
    }
    const found = this.#find(parent, e);
    const existing = found !== undefined && !found.isDefault ? found : undefined;

    if (op === 'delete' || op === 'remove') {
      if (existing === undefined) {
        if (op === 'delete') this.#fail('data-missing', `${e.schema.kind} ${e.schema.name} can't be deleted: it doesn't exist`, e);
        return undefined;
      }
      this.#remove(parent, existing);
      return undefined;
    }
    if (op === 'create' && existing !== undefined) {
      this.#fail('data-exists', `${e.schema.kind} ${e.schema.name} can't be created: it already exists`, e);
      return existing;
    }

    switch (e.kind) {
      case 'leaf':
      case 'anydata':
      case 'anyxml': {
        if (op === undefined) return existing;
        if (e instanceof LeafInstance && e.value.value === null && e.value.type.builtin !== 'empty') {
          this.#fail('invalid-edit', `leaf ${e.schema.name} has no value to ${op}`, e);
          return existing;
        }
        if (existing !== undefined) {
          if (existing instanceof LeafInstance && e instanceof LeafInstance) existing.value = e.value;
          // anydata and anyxml are replaced whole, and edit attributes inside them are data (RFC 7950 §7.10.3, §7.11.3).
          // Content that means the same is kept as it is, in its own encoding.
          else if (existing instanceof AnyInstance && e instanceof AnyInstance) {
            if (!sameAnyContent(existing.content, e.content, existing.kind, existing.schema.module.namespace, this.schema)) existing.content = e.content;
          }
          this.#annotate(existing, e);
          this.#written.add(existing);
          return existing;
        }
        if (this.#caseConflict(parent, e) && this.#skipping) return found;
        if (found !== undefined) this.#remove(parent, found);
        return this.#settleOrigin(this.#create(parent, copyNode(e, false, isDataAnnotation)), e);
      }
      case 'leaf-list': {
        if (op === undefined) return existing;
        const created = existing === undefined;
        if (created && this.#caseConflict(parent, e) && this.#skipping) return found;
        const placement = this.#placement(parent, e, created, reorder);
        if (placement === null && this.#skipping) return found;
        let node = existing as LeafListEntry | undefined;
        if (node === undefined) {
          if (found !== undefined) this.#remove(parent, found);
          node = this.#settleOrigin(this.#create(parent, copyNode(e, false, isDataAnnotation)), e);
        } else {
          this.#annotate(node, e);
          this.#written.add(node);
        }
        if (placement) moveTo(parent, node, placement.where, placement.anchor);
        return node;
      }
      case 'container':
      case 'list': {
        // A container that holds only defaults is there to merge into.
        let node: ContainerInstance | ListEntry | undefined = (existing ?? (found instanceof ContainerInstance ? found : undefined)) as ContainerInstance | ListEntry | undefined;
        const created = node === undefined;
        if (created) {
          if (e instanceof ListEntry && e.keys.length < e.schema.keys.length) {
            this.#fail('invalid-edit', `list entry ${e.schema.name} has no value for every key`, e);
            return undefined;
          }
          if (this.#caseConflict(parent, e) && this.#skipping) return found;
        }
        const placement = e instanceof ListEntry ? this.#placement(parent, e, created, reorder) : undefined;
        if (placement === null && this.#skipping) return created ? found : node;
        if (node === undefined) {
          if (found !== undefined) this.#remove(parent, found);
          node = this.#settleOrigin(this.#create(parent, copyNode(e, false, isDataAnnotation), op !== undefined), e);
        } else if (op !== undefined) {
          this.#annotate(node, e);
          this.#written.add(node);
        }
        if (placement) moveTo(parent, node, placement.where, placement.anchor);
        const replacing = op === 'replace' && !created;
        const touched = this.children(node, e.children, op, op === 'replace');
        // A replace cut short by stop-on-error leaves what it didn't reach.
        if (replacing && !this.stopped) this.removeUntouched(node, touched);
        if (node.isDefault && (op !== undefined || node.children.some((c) => !c.isDefault))) node.isDefault = false;
        // Under `none`, a node is only a way to what's below it: keep it only if something was put there.
        if (created && op === undefined && !hasContent(node)) {
          this.#remove(parent, node);
          return undefined;
        }
        if (node instanceof ContainerInstance && node.schema.presence === undefined && node.children.length === 0) {
          this.#remove(parent, node);
          return undefined;
        }
        return node;
      }
    }
  }

  /** Sets the edit node's data annotations on an existing target node. */
  #annotate(target: InstanceNode, e: InstanceNode): void {
    mergeAnnotations(target, e, this.origins);
    this.#settleOrigin(target, e);
  }

  /**
   * After an edit node with an origin is written: drops the target node's
   * own origin when it is the one it inherits, as RFC 8342 §7.4 lets a
   * node leave it out. Only in trees that hold state.
   */
  #settleOrigin<T extends InstanceNode>(target: T, e: InstanceNode): T {
    if (!this.origins || ownOrigin(e) === undefined) return target;
    const own = ownOrigin(target);
    const parent = target.parent;
    const inherited = parent === undefined || parent instanceof DataTree ? undefined : effectiveOrigin(parent);
    if (own !== undefined && inherited !== undefined && sameOrigin(originValue(own), inherited)) {
      target.annotations.splice(target.annotations.indexOf(own), 1);
    }
    return target;
  }

  /** The node's own operation; null if it is invalid (and reported). */
  #operation(e: InstanceNode): EditOperation | undefined | null {
    const a = editAnnotation(e, NETCONF_NS, 'ietf-netconf', 'operation');
    if (a === undefined) return undefined;
    const v = annotationText(a);
    if (OPERATIONS.has(v)) return v as EditOperation;
    this.#fail('invalid-edit', `operation '${v}' is not merge, replace, create, delete or remove`, e);
    return null;
  }

  /** The target node an edit node names: the same leaf or container, the list entry with the same keys, the leaf-list entry with the same value. */
  #find(parent: InnerNode, e: InstanceNode): InstanceNode | undefined {
    let index = this.#indexes.get(parent);
    if (index === undefined) {
      index = new Map();
      for (const c of parent.children) addToIndex(index, c);
      this.#indexes.set(parent, index);
    }
    return index.get(e.schema)?.get(entryIdentity(e));
  }

  #remove(parent: InnerNode, node: InstanceNode): void {
    parent.remove(node);
    const forSchema = this.#indexes.get(parent)?.get(node.schema);
    const id = entryIdentity(node);
    if (forSchema?.get(id) === node) forSchema.delete(id);
  }

  /** Adds a new node, deleting the nodes of other cases of any choice it is in that this edit didn't write. */
  #create<T extends InstanceNode>(parent: InnerNode, node: T, written = true): T {
    this.#otherCases(parent, node.schema, (c) => {
      if (!this.#written.has(c)) this.#remove(parent, c);
    });
    parent.append(node);
    const index = this.#indexes.get(parent);
    if (index !== undefined) addToIndex(index, node);
    if (written) this.#written.add(node);
    return node;
  }

  /**
   * RFC 7950 §7.9: whether creating `e` would put a second case of a choice
   * into the edit, because this edit already wrote a node of another case
   * (reported as `multiple-cases`).
   */
  #caseConflict(parent: InnerNode, e: InstanceNode): boolean {
    let conflict = false;
    this.#otherCases(parent, e.schema, (c, other, kase, choice) => {
      if (conflict && this.#skipping) return;
      if (!this.#written.has(c)) return;
      this.#fail('multiple-cases', `the edit has data from cases ${other.name} and ${kase.name} of choice ${choice.name}`, e);
      conflict = true;
    });
    return conflict;
  }

  /** Calls `visit` for each child of `parent` in another case of a choice that `schema` is in, between it and the parent. */
  #otherCases(parent: InnerNode, schema: SchemaNode, visit: (child: InstanceNode, other: SchemaNode, kase: SchemaNode, choice: SchemaNode) => void): void {
    for (let s: SchemaNode | undefined = schema; s !== undefined && s.parent !== undefined && s.parent.kind !== 'container' && s.parent.kind !== 'list'; s = s.parent) {
      if (s.parent.kind !== 'case') continue;
      const kase = s.parent;
      const choice = kase.parent;
      if (choice?.kind !== 'choice') continue;
      for (const c of [...parent.children]) {
        const other = caseOf(c.schema, choice);
        if (other === undefined || other === kase) continue;
        visit(c, other, kase, choice);
      }
    }
  }

  /**
   * Where an entry of an ordered-by-user list or leaf-list goes, as its
   * `yang:insert` says: undefined to leave it where it is (or, if new, last),
   * null if the insert is wrong (and reported).
   */
  #placement(parent: InnerNode, e: ListEntry | LeafListEntry, created: boolean, reorder: boolean): Placement | undefined | null {
    if (e.schema.orderedBy !== 'user') return undefined;
    const insert = editAnnotation(e, YANG_NS, 'yang', 'insert');
    const where = insert === undefined ? undefined : annotationText(insert);
    if (where === undefined) return reorder && !created ? { where: 'last' } : undefined;
    if (where === 'first' || where === 'last') return { where };
    if (where !== 'before' && where !== 'after') {
      this.#fail('invalid-edit', `insert '${where}' is not first, last, before or after`, e);
      return null;
    }
    const isList = e instanceof ListEntry;
    const anchorAnnotation = editAnnotation(e, YANG_NS, 'yang', isList ? 'key' : 'value');
    if (anchorAnnotation === undefined) {
      this.#fail('invalid-edit', `yang:insert '${where}' needs ${isList ? 'yang:key' : 'yang:value'}`, e);
      return null;
    }
    const anchor = this.#anchor(parent, e, anchorAnnotation, where);
    return anchor === undefined ? null : { where, anchor };
  }

  /** The entry a `yang:key` or `yang:value` names, which must exist and not be the entry itself. */
  #anchor(parent: InnerNode, e: ListEntry | LeafListEntry, a: Annotation, where: string): InstanceNode | undefined {
    const text = annotationText(a);
    const scope = this.#scope(a, e.schema.module);
    let probe: ListEntry | LeafListEntry;
    if (e instanceof LeafListEntry) {
      const v = parseText(e.schema.type, text, scope);
      if (typeof v === 'string') {
        this.#fail('invalid-edit', `yang:value: ${v}`, e);
        return undefined;
      }
      probe = new LeafListEntry(e.schema, v);
    } else {
      const predicates = parsePredicates(text);
      if (predicates === undefined) {
        this.#fail('invalid-edit', `yang:key '${text}' is not a list of key predicates`, e);
        return undefined;
      }
      probe = new ListEntry(e.schema);
      for (const p of predicates) {
        const key = e.schema.keys.find((k) => k.name === p.name);
        if (key === undefined || probe.children.some((c) => c.schema === key)) {
          this.#fail('invalid-edit', `yang:key '${text}': ${key === undefined ? `${p.name} is not a key of ${e.schema.name}` : `${p.name} is given twice`}`, e);
          return undefined;
        }
        const v = parseText(key.type, p.value, scope);
        if (typeof v === 'string') {
          this.#fail('invalid-edit', `yang:key '${text}': ${v}`, e);
          return undefined;
        }
        probe.append(new LeafInstance(key, v));
      }
      if (probe.children.length !== e.schema.keys.length) {
        this.#fail('invalid-edit', `yang:key '${text}' doesn't give every key of ${e.schema.name}`, e);
        return undefined;
      }
    }
    if (entryIdentity(probe) === entryIdentity(e)) {
      this.#fail('invalid-edit', `an entry can't be inserted ${where} itself`, e);
      return undefined;
    }
    const match = this.#find(parent, probe);
    if (match === undefined) this.#fail('missing-anchor', `the entry ${a.name === 'key' ? text : `'${text}'`} to insert ${e.schema.name} next to doesn't exist`, e, { appTag: 'missing-instance' });
    return match;
  }

  /**
   * How prefixes in a `yang:key` or `yang:value` resolve: the XML prefixes
   * in scope where it was read, then module names (RFC 7951), then YANG
   * prefixes.
   */
  #scope(a: Annotation, module: CompiledModule): ValueScope {
    const schema = this.schema;
    const xml = a.prefixes;
    return {
      format: xml === undefined ? 'json' : 'xml',
      schema,
      module: (prefix) => {
        const uri = xml?.get(prefix);
        if (uri !== undefined) return [...schema.modules.values()].find((m) => m.namespace === uri);
        return schema.module(prefix) ?? [...schema.modules.values()].find((m) => m.prefix === prefix && m.implemented);
      },
      unprefixed: module,
    };
  }
}

function addToIndex(index: Map<SchemaNode, Map<string, InstanceNode>>, node: InstanceNode): void {
  let forSchema = index.get(node.schema);
  if (forSchema === undefined) index.set(node.schema, (forSchema = new Map<string, InstanceNode>()));
  const id = entryIdentity(node);
  if (!forSchema.has(id)) forSchema.set(id, node);
}

/** The edit annotation with this name, from its namespace (or, built by hand, its module). */
function editAnnotation(e: InstanceNode, namespace: string, module: string, name: string): Annotation | undefined {
  return e.annotations.find((a) => a.name === name && (a.namespace === namespace || (a.namespace === undefined && a.module === module)));
}

/** An annotation's value as text. Edit annotations are strings. */
function annotationText(a: Annotation): string {
  return typeof a.value === 'string' ? a.value : scalarText(formatJson(a.value));
}

/**
 * Sets the edit node's data annotations on the target node, replacing those
 * with the same name. With `origins`, an origin replaces the node's origin
 * however either was identified (namespace or module).
 */
function mergeAnnotations(target: InstanceNode, e: InstanceNode, origins: boolean): void {
  for (const a of e.annotations) {
    if (!isDataAnnotation(a)) continue;
    if (origins && isOriginAnnotation(a)) {
      const kept = target.annotations.filter((t) => !isOriginAnnotation(t));
      target.annotations.length = 0;
      target.annotations.push(...kept, a);
      continue;
    }
    const i = target.annotations.findIndex((t) => t.name === a.name && t.namespace === a.namespace && t.module === a.module);
    if (i === -1) target.annotations.push(a);
    else target.annotations[i] = a;
  }
}

/** Whether an inner node holds anything besides its keys. */
function hasContent(node: ContainerInstance | ListEntry): boolean {
  if (node instanceof ContainerInstance) return node.children.length > 0;
  return node.children.length > node.schema.keys.length;
}

/** The case of `choice` that a schema node is in, if any. */
function caseOf(schema: SchemaNode, choice: SchemaNode): SchemaNode | undefined {
  for (let s: SchemaNode | undefined = schema; s?.parent !== undefined; s = s.parent) if (s.parent === choice) return s;
  return undefined;
}

/** Moves an entry among its siblings of the same schema node. */
function moveTo(parent: InnerNode | DataTree, node: InstanceNode, where: 'first' | 'last' | 'before' | 'after', anchor: InstanceNode | undefined): void {
  const children = parent.children;
  const from = children.indexOf(node);
  if (from !== -1) children.splice(from, 1);
  let at: number;
  if (anchor !== undefined) {
    at = children.indexOf(anchor) + (where === 'after' ? 1 : 0);
  } else {
    const same = children.map((c, i) => (c.schema === node.schema ? i : -1)).filter((i) => i !== -1);
    if (same.length === 0) {
      if (from !== -1) children.splice(from, 0, node);
      return;
    }
    at = where === 'first' ? same[0]! : same[same.length - 1]! + 1;
  }
  children.splice(at, 0, node);
}

/** Reads `[name='value'][prefix:name="value"]…`, the form of `yang:key`. */
export function parsePredicates(text: string): { readonly prefix: string | undefined; readonly name: string; readonly value: string }[] | undefined {
  const out: { prefix: string | undefined; name: string; value: string }[] = [];
  const re = /\s*\[\s*(?:([A-Za-z_][\w.-]*):)?([A-Za-z_][\w.-]*)\s*=\s*(?:'([^']*)'|"([^"]*)")\s*\]/y;
  let i = 0;
  while (i < text.length) {
    if (text.slice(i).trim() === '') break;
    re.lastIndex = i;
    const m = re.exec(text);
    if (m === null) return undefined;
    out.push({ prefix: m[1], name: m[2]!, value: m[3] ?? m[4]! });
    i = re.lastIndex;
  }
  return out.length === 0 ? undefined : out;
}

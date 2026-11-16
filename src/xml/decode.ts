/**
 * XML → instance tree (RFC 7950 §7 and §9; draft-ietf-netmod-yang-xml).
 *
 * One element per node, in the namespace of the node's module. Choice and
 * case have no elements. List keys may come in any order (RFC 7950 requires
 * them first; we accept them anywhere, as servers sometimes get it wrong).
 * Attributes become annotations: typed when a module defines them with
 * `md:annotation`, carried as text otherwise, so `nc:operation` and the like
 * pass through untouched.
 */

import type { AnnotationDefinition, CompiledModule, SchemaNode } from '../schema/model.js';
import type { Schema } from '../schema/schema.js';
import {
  annotationProblem,
  checkEditAnnotations,
  checkOperation,
  datastoreProblem,
  childCandidates,
  editAnnotationProblem,
  childPath,
  EntryKeys,
  isDuplicate,
  Issues,
  modulesByNamespace,
  NETCONF_NS,
  newTree,
  operationProblem,
  startOperation,
  YANG_NS,
  type DecodeOptions,
  type IssueDetails,
} from '../data/build.js';
import { validateDecoded } from '../validate/validate.js';
import { defaultAnnotation, isDefaultAnnotation } from '../data/defaults.js';
import { parseText, type ValueScope } from '../data/lexical.js';
import { AnyInstance, ContainerInstance, DataTree, LeafInstance, LeafListEntry, ListEntry, OperationInstance, type Annotation, type InnerNode, type InstanceNode } from '../data/tree.js';
import { attachPositions, PositionTable } from '../data/positions.js';
import { isElement, type XmlChild, type XmlElementLike } from './element.js';
import { parseXml, type PlainElement, type XmlParseOptions } from './parse.js';
import { ChainedScope } from './scope.js';

export interface XmlDecodeOptions extends DecodeOptions, XmlParseOptions {
  /**
   * Namespace prefixes in scope above the given elements, prefix → URI, for
   * elements taken out of a larger document whose declarations they rely on
   * (`''` is the default namespace).
   */
  readonly scope?: ReadonlyMap<string, string>;
}

type Scope = ReadonlyMap<string, string>;

/**
 * Reads YANG data from XML text, from one parsed element, or from a list of
 * sibling elements (such as the children of a NETCONF `<data>` element).
 *
 * @throws YangDataError listing every problem found, each with its data path
 */
export function decodeXml(schema: Schema, input: string | XmlElementLike | readonly XmlElementLike[], options: XmlDecodeOptions = {}): DataTree {
  const positions = options.positions === true && typeof input === 'string' ? new PositionTable(input) : undefined;
  const elements: readonly XmlElementLike[] = typeof input === 'string' ? parseXml(input, options) : Array.isArray(input) ? input : [input as XmlElementLike];
  const issues = new Issues();
  const tree = newTree(schema, options, issues);
  if (positions !== undefined) {
    attachPositions(tree, positions);
    issues.positions = positions;
  }
  const decoder = new XmlDecoder(schema, tree, options, issues);
  if (options.edit === true && tree.kind !== 'data') issues.add('invalid-edit', `the edit option needs type 'data', not '${tree.kind}'`, '/');
  const scope = new Map([['', ''], ...(options.scope ?? [])]);
  let root: InnerNode | undefined = tree;
  if (options.operation !== undefined) root = startOperation(tree, options.operation, decoder.issues);
  if (root !== undefined) {
    decoder.children(elements, root, scope, scope.get('') ?? '');
    checkOperation(tree, decoder.issues);
  }
  validateDecoded(tree, options.validate, decoder.issues);
  return tree;
}

class XmlDecoder {
  readonly #entries = new EntryKeys();
  readonly #byNs: Map<string, CompiledModule>;
  readonly #positions: PositionTable | undefined;

  constructor(
    readonly schema: Schema,
    readonly tree: DataTree,
    readonly options: XmlDecodeOptions,
    readonly issues: Issues,
  ) {
    this.#byNs = modulesByNamespace(schema);
    this.#positions = issues.positions;
  }

  /** Issue details placing a problem at an element. */
  #at(el: XmlElementLike): IssueDetails {
    return this.issues.at((el as PlainElement).offset);
  }

  /** Records where a node's element is, and returns the node. */
  #placed<T extends InstanceNode>(node: T, el: XmlElementLike): T {
    const offset = (el as PlainElement).offset;
    if (this.#positions !== undefined && offset !== undefined) this.#positions.set(node, offset);
    return node;
  }

  children(elements: readonly XmlChild[], parent: InnerNode, scope: Scope, parentNs: string): void {
    const candidates = childCandidates(parent);
    for (const el of elements) {
      if (!isElement(el)) {
        if (el.trim() !== '') this.issues.add('unexpected-content', `unexpected text ${JSON.stringify(el.trim().slice(0, 40))}`, pathOf(parent), this.issues.at(parent instanceof DataTree ? undefined : parent));
        continue;
      }
      const ns = el.ns ?? parentNs;
      const s = el.declarations === undefined || el.declarations.size === 0 ? scope : new ChainedScope(el.declarations, scope);
      const node = candidates.find((c) => c.name === el.name && c.module.namespace === ns);
      if (node === undefined) {
        if (this.options.unknown === 'skip') continue;
        const module = this.#byNs.get(ns);
        const path = childPath(parent, module, el.name);
        const other = candidates.find((c) => c.name === el.name);
        if (other !== undefined) {
          this.issues.add('wrong-namespace', `element ${el.name} is in namespace '${ns}', but the schema has it in '${other.module.namespace}' (module ${other.module.name})`, path, this.#at(el));
        } else {
          this.issues.add('unknown-node', `the schema has no node ${el.name} in namespace '${ns}' here`, path, this.#at(el));
        }
        continue;
      }
      this.#node(el, node, parent, s, ns);
    }
  }

  #node(el: XmlElementLike, node: SchemaNode, parent: InnerNode, scope: Scope, ns: string): void {
    const path = childPath(parent, node.module, node.name);
    if (isDuplicate(parent, node)) {
      this.issues.add('duplicate-node', `${node.kind} ${node.name} appears more than once`, path, this.#at(el));
      return;
    }
    const state = datastoreProblem(this.tree, node);
    if (state !== undefined) {
      this.issues.add('state-data', state, path, this.#at(el));
      return;
    }
    const kids = el.children ?? [];
    switch (node.kind) {
      case 'container': {
        const inst = parent.append(this.#placed(new ContainerInstance(node), el));
        this.#annotations(el, inst, scope, ns);
        this.children(kids, inst, scope, ns);
        return;
      }
      case 'list': {
        const entry = parent.append(this.#placed(new ListEntry(node), el));
        this.#annotations(el, entry, scope, ns);
        // Keys first, so paths below carry them.
        const isKey = (c: XmlChild): boolean => isElement(c) && node.keys.some((k) => k.name === c.name && (c.ns ?? ns) === k.module.namespace);
        this.children([...kids.filter(isKey), ...kids.filter((c) => !isKey(c))], entry, scope, ns);
        this.#entries.check(entry, this.issues);
        return;
      }
      case 'leaf':
      case 'leaf-list': {
        const text = this.#text(el, path);
        if (text === undefined) return;
        const deleting = node.kind === 'leaf' && text.trim() === '' && this.#deleting(el);
        const v = deleting ? { type: node.type, value: null } : parseText(node.type, text, this.#valueScope(scope, ns));
        if (typeof v === 'string') {
          this.issues.add('invalid-value', v, node.kind === 'leaf' ? path : `${path}[.=${JSON.stringify(text)}]`, this.#at(el));
          return;
        }
        const inst = parent.append(this.#placed(node.kind === 'leaf' ? new LeafInstance(node, v) : new LeafListEntry(node, v), el));
        this.#annotations(el, inst, scope, ns);
        return;
      }
      case 'anydata':
      case 'anyxml': {
        const inst = parent.append(this.#placed(new AnyInstance(node, { format: 'xml', nodes: kids.map((c) => resolveContent(c, ns)) }), el));
        this.#annotations(el, inst, scope, ns);
        return;
      }
      case 'rpc':
      case 'action':
      case 'notification': {
        const problem = operationProblem(node, parent, this.tree.kind);
        if (problem !== undefined) {
          this.issues.add('unexpected-operation', problem, path, this.#at(el));
          return;
        }
        const op = parent.append(this.#placed(new OperationInstance(node, node.kind === 'notification' ? undefined : this.tree.kind === 'reply' ? 'output' : 'input'), el));
        this.#annotations(el, op, scope, ns);
        this.children(kids, op, scope, ns);
        return;
      }
      case 'choice':
      case 'case':
      case 'input':
      case 'output':
        return; // never data children
    }
  }

  /** The text content of a leaf element, or undefined (and an issue) if it has child elements. */
  #text(el: XmlElementLike, path: string): string | undefined {
    let text = '';
    for (const c of el.children ?? []) {
      if (isElement(c)) {
        this.issues.add('unexpected-content', `a leaf can't contain element ${c.name}`, path, this.#at(c));
        return undefined;
      }
      text += c;
    }
    return text;
  }

  #valueScope(scope: Scope, ns: string): ValueScope {
    const byNs = this.#byNs;
    const defaultNs = scope.get('');
    return {
      format: 'xml',
      schema: this.schema,
      module: (prefix) => {
        const uri = scope.get(prefix);
        return uri === undefined ? undefined : byNs.get(uri);
      },
      unprefixed: byNs.get(defaultNs === undefined || defaultNs === '' ? ns : defaultNs),
    };
  }

  /** In an edit, whether an element's own operation is delete or remove: then a leaf needn't have a value. */
  #deleting(el: XmlElementLike): boolean {
    if (this.options.edit !== true) return false;
    const op = el.attributes?.find((a) => a.ns === NETCONF_NS && a.name === 'operation')?.value;
    return op === 'delete' || op === 'remove';
  }

  #annotations(el: XmlElementLike, inst: InstanceNode, scope: Scope, ns: string): void {
    this.#readAnnotations(el, inst, scope, ns);
    if (this.options.edit === true) checkEditAnnotations(inst, this.issues);
  }

  #readAnnotations(el: XmlElementLike, inst: InstanceNode, scope: Scope, ns: string): void {
    for (const a of el.attributes ?? []) {
      const namespace = a.ns ?? '';
      if (this.options.edit === true && (namespace === NETCONF_NS || namespace === YANG_NS)) {
        const problem = editAnnotationProblem(namespace, a.name, a.value, inst);
        if (problem !== undefined) {
          this.issues.add('invalid-edit', problem, inst.path, this.issues.at(inst));
          continue;
        }
        const anchor = namespace === YANG_NS && (a.name === 'key' || a.name === 'value');
        inst.annotations.push({
          namespace,
          module: namespace === NETCONF_NS ? 'ietf-netconf' : 'yang',
          name: a.name,
          value: a.value,
          prefix: a.prefix ?? (namespace === NETCONF_NS ? 'nc' : 'yang'),
          ...(anchor ? { prefixes: scope } : {}),
        });
        continue;
      }
      const module = namespace === '' ? undefined : this.#byNs.get(namespace);
      const moduleName = module?.name ?? (namespace === '' ? undefined : this.options.namespaces?.[namespace]);
      const definition: AnnotationDefinition | undefined = module?.annotations.get(a.name);
      if (isDefaultAnnotation(namespace, moduleName, a.name)) {
        const v = a.value.trim();
        if (v !== 'true' && v !== 'false') {
          this.issues.add('invalid-value', `the with-defaults default annotation is '${a.value}', not true or false`, inst.path, this.issues.at(inst));
          continue;
        }
        inst.annotations.push(defaultAnnotation(v === 'true', a.prefix));
        if (v === 'true') inst.isDefault = true;
        continue;
      }
      const misplaced = annotationProblem(this.tree, namespace, moduleName, a.name);
      if (misplaced !== undefined) {
        this.issues.add('unexpected-annotation', misplaced, inst.path, this.issues.at(inst));
        continue;
      }
      const base = { namespace, module: moduleName, name: a.name, ...(a.prefix === undefined ? {} : { prefix: a.prefix }) };
      if (definition?.type === undefined) {
        inst.annotations.push({ ...base, value: a.value });
        continue;
      }
      const v = parseText(definition.type, a.value, this.#valueScope(scope, ns));
      if (typeof v === 'string') {
        this.issues.add('invalid-value', `annotation ${moduleName ?? ''}:${a.name}: ${v}`, inst.path, this.issues.at(inst));
        continue;
      }
      const annotation: Annotation = { ...base, value: v, definition };
      inst.annotations.push(annotation);
    }
  }
}

function pathOf(parent: InnerNode): string {
  return parent instanceof DataTree ? '/' : parent.path;
}

/** anydata/anyxml content, with every element's namespace made explicit. */
function resolveContent(c: XmlChild, ns: string): XmlChild {
  if (!isElement(c)) return c;
  const own = c.ns ?? ns;
  return {
    name: c.name,
    ns: own,
    prefix: c.prefix,
    attributes: c.attributes ?? [],
    children: (c.children ?? []).map((k) => resolveContent(k, own)),
    declarations: c.declarations ?? new Map(),
  };
}


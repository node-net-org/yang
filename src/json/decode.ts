/**
 * RFC 7951 JSON → instance tree.
 *
 * Member names carry a module name at the top level and wherever the module
 * changes. Lists and leaf-lists are arrays. Values must have the JSON type
 * RFC 7951 §6 gives their YANG type, which also picks the union member.
 * Metadata (RFC 7952 §5.2) is an `@` member inside objects, and an
 * `@name` sibling for leaves, leaf-lists (an array, entry by entry) and
 * anyxml.
 */

import type { CompiledModule, SchemaNode } from '../schema/model.js';
import type { Schema } from '../schema/schema.js';
import {
  annotationProblem,
  checkEditAnnotations,
  checkOperation,
  datastoreProblem,
  childCandidates,
  editAnnotationProblem,
  NETCONF_NS,
  YANG_NS,
  childPath,
  EntryKeys,
  isDuplicate,
  Issues,
  newTree,
  operationProblem,
  startOperation,
  type DecodeOptions,
} from '../data/build.js';
import { validateDecoded } from '../validate/validate.js';
import { attachPositions, PositionTable } from '../data/positions.js';
import { JsonSyntaxProblem, parseJsonText, type JsonPlace } from './parse.js';
import { defaultAnnotation, isDefaultAnnotation } from '../data/defaults.js';
import { describe, parseJson, scalarText, type JsonValue, type ValueScope } from '../data/lexical.js';
import { AnyInstance, ContainerInstance, DataTree, LeafInstance, LeafListEntry, ListEntry, OperationInstance, type Annotation, type InnerNode, type InstanceNode } from '../data/tree.js';

export type JsonDecodeOptions = DecodeOptions;

type JsonObject = { readonly [member: string]: unknown };

const MEMBER = /^(?:([A-Za-z_][A-Za-z0-9_.-]*):)?([A-Za-z_][A-Za-z0-9_.-]*)$/;

function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Reads YANG data from RFC 7951 JSON: text, or a value from JSON.parse.
 *
 * With the `operation` option the input is the operation's parameters,
 * either directly or wrapped in a `module:input` or `module:output` member
 * as RESTCONF writes them (RFC 8040 §3.6).
 *
 * @throws YangDataError listing every problem found, each with its data path
 */
export function decodeJson(schema: Schema, input: unknown, options: JsonDecodeOptions = {}): DataTree {
  const issues = new Issues();
  const tree = newTree(schema, options, issues);
  let value: unknown = input;
  let places: WeakMap<object, JsonPlace> | undefined;
  if (typeof input === 'string' && options.positions === true) {
    const positions = new PositionTable(input);
    attachPositions(tree, positions);
    issues.positions = positions;
    try {
      ({ value, places } = parseJsonText(input));
    } catch (err) {
      if (!(err instanceof JsonSyntaxProblem)) throw err;
      issues.add('json-syntax', `malformed JSON: ${err.message}`, '/', issues.at(err.offset));
      issues.throwIfAny();
    }
  } else if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch (err) {
      issues.add('json-syntax', `malformed JSON: ${err instanceof Error ? err.message : String(err)}`, '/');
      issues.throwIfAny();
    }
  }
  const decoder = new JsonDecoder(schema, tree, options, issues, places);
  if (!isObject(value)) {
    decoder.issues.add('unexpected-content', `the document is ${describe(value)}, not an object`, '/');
    decoder.issues.throwIfAny();
  }
  let root: InnerNode | undefined = tree;
  let body = value as JsonObject;
  if (options.operation !== undefined) {
    root = startOperation(tree, options.operation, decoder.issues);
    const keys = Object.keys(body);
    const wrapper = keys.length === 1 && root instanceof OperationInstance && root.direction !== undefined ? `${root.schema.module.name}:${root.direction}` : undefined;
    if (wrapper !== undefined && keys[0] === wrapper && isObject(body[wrapper])) body = body[wrapper];
  }
  if (root !== undefined) {
    decoder.object(body, root);
    checkOperation(tree, decoder.issues);
  }
  validateDecoded(tree, options.validate, decoder.issues);
  return tree;
}

class JsonDecoder {
  readonly #entries = new EntryKeys();
  readonly #namespaces = new Map<string, string>();

  constructor(
    readonly schema: Schema,
    readonly tree: DataTree,
    readonly options: JsonDecodeOptions,
    readonly issues: Issues,
    /** With positions: where each object and array of the input is. */
    readonly places?: WeakMap<object, JsonPlace>,
  ) {
    if (options.edit === true) {
      this.#namespaces.set('ietf-netconf', NETCONF_NS);
      this.#namespaces.set('yang', YANG_NS);
      if (tree.kind !== 'data') issues.add('invalid-edit', `the edit option needs type 'data', not '${tree.kind}'`, '/');
    }
    for (const [ns, module] of Object.entries(options.namespaces ?? {})) this.#namespaces.set(module, ns);
  }

  /** Records where a node is, and returns it. */
  #placed<T extends InstanceNode>(node: T, offset: number | undefined): T {
    if (offset !== undefined) this.issues.positions?.set(node, offset);
    return node;
  }

  /** In an edit, the members whose own operation is delete or remove: those leaves may be null. */
  #deletions(obj: JsonObject): Set<string> {
    const out = new Set<string>();
    if (this.options.edit !== true) return out;
    for (const [member, value] of Object.entries(obj)) {
      if (member.length < 2 || !member.startsWith('@') || !isObject(value)) continue;
      const op = value['ietf-netconf:operation'];
      if (op === 'delete' || op === 'remove') out.add(member.slice(1));
    }
    return out;
  }

  /** The members of an object: child nodes, then `@` metadata. */
  object(obj: JsonObject, parent: InnerNode): void {
    const candidates = childCandidates(parent);
    const context = parent instanceof DataTree ? undefined : parent.schema.module;
    const created = new Map<SchemaNode, InstanceNode[]>();
    const metadata: [string, unknown][] = [];
    const deletions = this.#deletions(obj);
    const offsets = this.places?.get(obj)?.members;
    let members = Object.entries(obj);
    if (parent instanceof ListEntry) {
      // Keys first, so paths below carry them.
      const keys = new Set(parent.schema.keys.flatMap((k) => [k.name, `${k.module.name}:${k.name}`]));
      members = [...members.filter(([m]) => keys.has(m)), ...members.filter(([m]) => !keys.has(m))];
    }
    for (const [member, value] of members) {
      if (member.startsWith('@')) {
        metadata.push([member, value]);
        continue;
      }
      const offset = offsets?.get(member);
      const node = this.#resolve(member, candidates, context, parent, offset);
      if (node === undefined) continue;
      created.set(node, this.#node(node, value, parent, deletions.has(member), offset));
    }
    for (const [member, value] of metadata) {
      const offset = offsets?.get(member);
      if (member === '@') {
        if (parent instanceof DataTree) this.issues.add('unexpected-content', "the top level can't have metadata", '/@', this.issues.at(offset));
        else this.#annotations(value, parent);
        continue;
      }
      const node = this.#resolve(member.slice(1), candidates, context, parent, offset);
      if (node === undefined) continue;
      const instances = created.get(node);
      const path = childPath(parent, node.module, node.name);
      if (instances === undefined) {
        this.issues.add('unknown-node', `metadata ${member} is for a node that isn't present`, path, this.issues.at(offset));
      } else if (instances.length === 0) {
        // The node itself was rejected, and that is already reported.
      } else if (node.kind === 'leaf-list') {
        if (!Array.isArray(value)) {
          this.issues.add('unexpected-content', `metadata for a leaf-list is ${describe(value)}, not an array`, path, this.issues.at(offset));
          continue;
        }
        value.forEach((m, i) => {
          if (m === null) return;
          const entry = instances[i];
          if (entry === undefined) this.issues.add('unexpected-content', `metadata ${member} has more entries than the leaf-list`, path, this.issues.at(offset));
          else this.#annotations(m, entry);
        });
      } else if (node.kind === 'leaf' || node.kind === 'anyxml') {
        this.#annotations(value, instances[0]!);
      } else {
        this.issues.add('unexpected-content', `metadata for ${node.kind} ${node.name} goes in its own '@' member, not ${member}`, path, this.issues.at(offset));
      }
    }
  }

  /** Finds the schema node a member name refers to, or reports why there is none. */
  #resolve(member: string, candidates: readonly SchemaNode[], context: CompiledModule | undefined, parent: InnerNode, offset: number | undefined): SchemaNode | undefined {
    const m = MEMBER.exec(member);
    const skip = this.options.unknown === 'skip';
    const where = parent instanceof DataTree ? '' : parent.path;
    if (m === null) {
      if (!skip) this.issues.add('unknown-node', `'${member}' is not a member name`, `${where}/${member}`, this.issues.at(offset));
      return undefined;
    }
    const name = m[2]!;
    const moduleName = m[1];
    const module = moduleName === undefined ? context : this.schema.module(moduleName);
    if (module === undefined) {
      if (!skip) {
        const path = `${where}/${member}`;
        if (moduleName === undefined) this.issues.add('unknown-node', `top-level member '${member}' has no module name`, path, this.issues.at(offset));
        else this.issues.add('unknown-node', `module ${moduleName} is not in the schema`, path, this.issues.at(offset));
      }
      return undefined;
    }
    const node = candidates.find((c) => c.name === name && c.module === module);
    if (node === undefined && !skip) {
      const path = childPath(parent, module, name);
      const other = candidates.find((c) => c.name === name);
      if (other !== undefined) this.issues.add('wrong-namespace', `${name} is in module ${other.module.name}, not ${module.name}`, path, this.issues.at(offset));
      else this.issues.add('unknown-node', `the schema has no node ${module.name}:${name} here`, path, this.issues.at(offset));
    }
    return node;
  }

  /** Reads one member's value into instances of `node`. Returns the instances made. */
  #node(node: SchemaNode, value: unknown, parent: InnerNode, deleting: boolean, offset: number | undefined): InstanceNode[] {
    const path = childPath(parent, node.module, node.name);
    /** Where each item of an array value is. */
    const items = Array.isArray(value) ? this.places?.get(value)?.items : undefined;
    if (isDuplicate(parent, node)) {
      this.issues.add('duplicate-node', `${node.kind} ${node.name} appears more than once`, path, this.issues.at(offset));
      return [];
    }
    const state = datastoreProblem(this.tree, node);
    if (state !== undefined) {
      this.issues.add('state-data', state, path, this.issues.at(offset));
      return [];
    }
    const expect = (what: string): [] => {
      this.issues.add('unexpected-content', `${node.kind} ${node.name} is ${describe(value)}, not ${what}`, path, this.issues.at(offset));
      return [];
    };
    switch (node.kind) {
      case 'container': {
        if (!isObject(value)) return expect('an object');
        const inst = parent.append(this.#placed(new ContainerInstance(node), offset));
        this.object(value, inst);
        return [inst];
      }
      case 'list': {
        if (!Array.isArray(value)) return expect('an array');
        const out: InstanceNode[] = [];
        for (let i = 0; i < value.length; i++) {
          const item: unknown = value[i];
          if (!isObject(item)) {
            this.issues.add('unexpected-content', `an entry of list ${node.name} is ${describe(item)}, not an object`, path, this.issues.at(items?.[i]));
            continue;
          }
          const entry = parent.append(this.#placed(new ListEntry(node), items?.[i]));
          this.object(item, entry);
          this.#entries.check(entry, this.issues);
          out.push(entry);
        }
        return out;
      }
      case 'leaf': {
        // An edit deleting the leaf needn't give its value (an empty XML element).
        if (value === null && deleting) return [parent.append(this.#placed(new LeafInstance(node, { type: node.type, value: null }), offset))];
        const v = parseJson(node.type, value, this.#scope(node.module));
        if (typeof v === 'string') {
          this.issues.add('invalid-value', v, path, this.issues.at(offset));
          return [];
        }
        return [parent.append(this.#placed(new LeafInstance(node, v), offset))];
      }
      case 'leaf-list': {
        if (!Array.isArray(value)) return expect('an array');
        const out: InstanceNode[] = [];
        for (let i = 0; i < value.length; i++) {
          const item: unknown = value[i];
          const v = parseJson(node.type, item, this.#scope(node.module));
          if (typeof v === 'string') {
            this.issues.add('invalid-value', v, `${path}[.=${JSON.stringify(scalarText(item))}]`, this.issues.at(items?.[i]));
            continue;
          }
          out.push(parent.append(this.#placed(new LeafListEntry(node, v), items?.[i])));
        }
        return out;
      }
      case 'anydata':
      case 'anyxml': {
        if (node.kind === 'anydata' && !isObject(value)) return expect('an object');
        const inst = parent.append(this.#placed(new AnyInstance(node, { format: 'json', value: stripMetadata(value as JsonValue) }), offset));
        if (isObject(value) && '@' in value) this.#annotations(value['@'], inst);
        return [inst];
      }
      case 'rpc':
      case 'action':
      case 'notification': {
        const problem = operationProblem(node, parent, this.tree.kind);
        if (problem !== undefined) {
          this.issues.add('unexpected-operation', problem, path, this.issues.at(offset));
          return [];
        }
        if (!isObject(value)) return expect('an object');
        const op = parent.append(this.#placed(new OperationInstance(node, node.kind === 'notification' ? undefined : this.tree.kind === 'reply' ? 'output' : 'input'), offset));
        this.object(value, op);
        return [op];
      }
      case 'choice':
      case 'case':
      case 'input':
      case 'output':
        return [];
    }
  }

  #scope(own: CompiledModule): ValueScope {
    return { format: 'json', schema: this.schema, module: (p) => this.schema.module(p), unprefixed: own };
  }

  /** A metadata object (RFC 7952 §5.2.1): members `module:annotation`. */
  #annotations(value: unknown, inst: InstanceNode): void {
    if (!isObject(value)) {
      this.issues.add('unexpected-content', `metadata is ${describe(value)}, not an object`, inst.path, this.issues.at(inst));
      return;
    }
    for (const [member, v] of Object.entries(value)) {
      const m = MEMBER.exec(member);
      if (m?.[1] === undefined) {
        this.issues.add('unknown-annotation', `annotation '${member}' has no module name`, inst.path, this.issues.at(inst));
        continue;
      }
      const moduleName = m[1];
      const name = m[2]!;
      if (isDefaultAnnotation(undefined, moduleName, name)) {
        if (typeof v !== 'boolean') {
          this.issues.add('invalid-value', `annotation ${member} is ${describe(v)}, not true or false`, inst.path, this.issues.at(inst));
          continue;
        }
        inst.annotations.push(defaultAnnotation(v));
        if (v) inst.isDefault = true;
        continue;
      }
      const module = this.schema.module(moduleName);
      const namespace = module?.namespace ?? this.#namespaces.get(moduleName);
      if (namespace === undefined) {
        this.issues.add('unknown-annotation', `annotation ${member} is from a module the schema doesn't have; give its namespace in the namespaces option`, inst.path, this.issues.at(inst));
        continue;
      }
      if (this.options.edit === true && (namespace === NETCONF_NS || namespace === YANG_NS)) {
        if (typeof v !== 'string') {
          this.issues.add('invalid-value', `annotation ${member} is ${describe(v)}, not a string`, inst.path, this.issues.at(inst));
          continue;
        }
        const problem = editAnnotationProblem(namespace, name, v, inst);
        if (problem !== undefined) {
          this.issues.add('invalid-edit', problem, inst.path, this.issues.at(inst));
          continue;
        }
        inst.annotations.push({ namespace, module: moduleName, name, value: v, prefix: namespace === NETCONF_NS ? 'nc' : 'yang' });
        continue;
      }
      const misplaced = annotationProblem(this.tree, namespace, moduleName, name);
      if (misplaced !== undefined) {
        this.issues.add('unexpected-annotation', misplaced, inst.path, this.issues.at(inst));
        continue;
      }
      const definition = module?.annotations.get(name);
      if (definition?.type === undefined) {
        if (typeof v === 'object' && v !== null) {
          this.issues.add('invalid-value', `annotation ${member} is ${describe(v)}, not a scalar`, inst.path, this.issues.at(inst));
          continue;
        }
        inst.annotations.push({ namespace, module: moduleName, name, value: scalarText(v) });
        continue;
      }
      const typed = parseJson(definition.type, v, this.#scope(definition.module));
      if (typeof typed === 'string') {
        this.issues.add('invalid-value', `annotation ${member}: ${typed}`, inst.path, this.issues.at(inst));
        continue;
      }
      const annotation: Annotation = { namespace, module: moduleName, name, value: typed, definition };
      inst.annotations.push(annotation);
    }
    if (this.options.edit === true) checkEditAnnotations(inst, this.issues);
  }
}

/** anydata content without its own `@` member, which is the node's metadata. */
function stripMetadata(value: JsonValue): JsonValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !('@' in value)) return value;
  const { '@': _metadata, ...rest } = value;
  return rest;
}

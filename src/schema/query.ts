/**
 * Schema queries for interactive tools: what can go at a path, with what
 * values. Built for tab completion in nnc (@node-net/netconf's CLI), so paths are
 * read tolerantly: a step may name its module by module name or YANG prefix,
 * or not at all when the name is unambiguous; list predicates are skipped;
 * and the last step may be partly typed.
 */

import type { BuiltinTypeName, Identity, LeafListNode, LeafNode, SchemaNode, SchemaNodeKind, Status, YangType } from './model.js';
import { dataChildren, type Schema } from './schema.js';
import { formatIntervals } from '../types/range.js';

/** What a schema node is, for display and completion. */
export interface NodeInfo {
  readonly name: string;
  /** The module whose namespace the node is in. */
  readonly module: string;
  readonly kind: SchemaNodeKind;
  /** The node's data path, RFC 7951 style, without predicates. */
  readonly path: string;
  readonly config: boolean;
  readonly status: Status;
  /** True for a mandatory leaf, choice, anydata or anyxml, and for a list or leaf-list with min-elements above 0. */
  readonly mandatory: boolean;
  /** True when the node can have child nodes: containers, lists, operations. */
  readonly hasChildren: boolean;
  readonly description?: string;
  /** List keys, in key order. */
  readonly keys?: readonly string[];
  /** The meaning of a presence container. */
  readonly presence?: string;
  readonly type?: TypeSummary;
  /** The default value of a leaf, its own or its type's. */
  readonly default?: string;
  /** The default values of a leaf-list. */
  readonly defaults?: readonly string[];
  readonly units?: string;
  readonly orderedBy?: 'system' | 'user';
  readonly minElements?: number;
  readonly maxElements?: number;
  /** The compiled schema node. */
  readonly node: SchemaNode;
}

/** A leaf or leaf-list type, summarised. */
export interface TypeSummary {
  /** The type as written: `uint16`, `inet:ipv4-address`. */
  readonly name: string;
  readonly builtin: BuiltinTypeName;
  /** One line for display: `uint16 (68..65535)`, `enumeration (up | down)`. */
  readonly text: string;
  readonly enums?: readonly { readonly name: string; readonly value: number; readonly description?: string }[];
  readonly bits?: readonly { readonly name: string; readonly position: number; readonly description?: string }[];
  /** The identities an identityref accepts, as `module:identity`. */
  readonly identities?: readonly { readonly name: string; readonly description?: string }[];
  readonly range?: string;
  readonly length?: string;
  readonly patterns?: readonly string[];
  readonly fractionDigits?: number;
  /** Union members, in order. */
  readonly members?: readonly TypeSummary[];
  /** A leafref's target, as a data path. */
  readonly target?: string;
}

export interface QueryOptions {
  /** Only configuration nodes, as for an edit or a read of a configuration datastore. */
  readonly config?: boolean;
  /** Include RPCs, actions and notifications. Default false: data nodes only. */
  readonly operations?: boolean;
}

/** One completion of a partly typed path. */
export interface PathCompletion {
  /**
   * The whole word with the completion applied: earlier steps as typed, the
   * completed step in canonical form (`module:name` where the module changes).
   */
  readonly text: string;
  /**
   * False when `text` doesn't start with what was typed: the step was typed
   * without its module name (`ip` → `ietf-ip:ipv4`), or with a YANG prefix
   * instead of a module name. Line editors that only append need true.
   */
  readonly extends: boolean;
  /** A node name, a list key name, or a value for a key or leaf-list predicate. */
  readonly kind: 'node' | 'key' | 'value';
  /** The node completed, or whose key or value is completed. */
  readonly node: NodeInfo;
}

const OPERATION_KINDS = new Set<SchemaNodeKind>(['rpc', 'action', 'notification']);

/** A step of a typed path. */
interface Step {
  readonly prefix: string | undefined;
  readonly name: string;
}

/** Splits a path into steps, skipping predicates. Returns the steps and the unfinished text after the last `/`. */
function splitPath(path: string): { steps: string[]; rest: string } {
  const steps: string[] = [];
  let current = '';
  let depth = 0;
  let quote: string | undefined;
  for (const c of path) {
    if (quote !== undefined) {
      if (c === quote) quote = undefined;
      current += c;
      continue;
    }
    if (depth > 0 && (c === "'" || c === '"')) quote = c;
    else if (c === '[') depth++;
    else if (c === ']') depth = Math.max(0, depth - 1);
    else if (c === '/' && depth === 0) {
      if (current !== '') steps.push(current);
      current = '';
      continue;
    }
    current += c;
  }
  return { steps, rest: current };
}

function parseStep(text: string): Step | undefined {
  const m = /^\s*(?:([A-Za-z_][A-Za-z0-9_.-]*):)?([A-Za-z_][A-Za-z0-9_.-]*)\s*(?:\[.*)?$/s.exec(text);
  return m === null ? undefined : { prefix: m[1], name: m[2]! };
}

export class SchemaQuery {
  constructor(readonly schema: Schema) {}

  /** The modules a step prefix may mean: by module name first, then by YANG prefix. */
  #modulesFor(prefix: string): string[] {
    const byName = this.schema.module(prefix);
    if (byName !== undefined) return [byName.name];
    return this.schema.implemented.filter((m) => m.prefix === prefix).map((m) => m.name);
  }

  /** Children of a node (or of the top level), choice and case looked through, list keys first, filtered by options. */
  candidates(parent: SchemaNode | undefined, options: QueryOptions): SchemaNode[] {
    const nodes =
      parent === undefined
        ? [...this.schema.dataNodes, ...this.schema.rpcs, ...this.schema.notifications].flatMap((n) => (n.kind === 'choice' ? dataChildren(n) : [n]))
        : parent.kind === 'rpc' || parent.kind === 'action'
          ? [...dataChildren(parent.input), ...dataChildren(parent.output)]
          : parent.kind === 'list'
            ? [...parent.keys, ...dataChildren(parent).filter((n) => !(n.kind === 'leaf' && n.isKey))]
            : dataChildren(parent);
    return nodes.filter((n) => (options.operations === true || !OPERATION_KINDS.has(n.kind)) && (options.config !== true || n.config || OPERATION_KINDS.has(n.kind)));
  }

  /** Resolves one step among candidates, tolerating a YANG prefix or a missing module name. */
  #step(step: Step, candidates: readonly SchemaNode[], inherited: string | undefined): SchemaNode | undefined {
    const named = candidates.filter((c) => c.name === step.name);
    if (step.prefix !== undefined) {
      const modules = this.#modulesFor(step.prefix);
      return named.find((c) => modules.includes(c.module.name));
    }
    return named.find((c) => c.module.name === inherited) ?? (named.length === 1 ? named[0] : undefined);
  }

  /** Resolves a whole path. Undefined for `/`; null when the path names nothing. */
  resolve(path: string, options: QueryOptions = {}): SchemaNode | undefined | null {
    const { steps, rest } = splitPath(path);
    if (rest.trim() !== '') steps.push(rest);
    let node: SchemaNode | undefined;
    for (const text of steps) {
      const step = parseStep(text);
      if (step === undefined) return null;
      const next = this.#step(step, this.candidates(node, options), node?.module.name);
      if (next === undefined) return null;
      node = next;
    }
    return node;
  }

  info(node: SchemaNode): NodeInfo {
    return nodeInfo(node);
  }

  complete(partial: string, options: QueryOptions = {}): PathCompletion[] {
    const { steps, rest } = splitPath(partial);
    let node: SchemaNode | undefined;
    for (const text of steps) {
      const step = parseStep(text);
      if (step === undefined) return [];
      const next = this.#step(step, this.candidates(node, options), node?.module.name);
      if (next === undefined) return [];
      node = next;
    }
    const head = partial.slice(0, partial.length - rest.length);
    const bracket = rest.indexOf('[');
    if (bracket !== -1) return this.#completePredicate(rest, head, node, options);

    const colon = rest.indexOf(':');
    const typedPrefix = colon === -1 ? undefined : rest.slice(0, colon);
    const typedName = colon === -1 ? rest : rest.slice(colon + 1);
    const modules = typedPrefix === undefined ? undefined : this.#modulesFor(typedPrefix);
    const out: PathCompletion[] = [];
    for (const c of this.candidates(node, options)) {
      const qualified = c.module !== node?.module;
      const canonical = qualified ? `${c.module.name}:${c.name}` : c.name;
      let match: boolean;
      if (modules !== undefined) match = modules.includes(c.module.name) && c.name.startsWith(typedName);
      else match = c.name.startsWith(rest) || (qualified && canonical.startsWith(rest));
      if (!match) continue;
      const text = head + canonical;
      out.push({ text, extends: text.startsWith(partial), kind: 'node', node: this.info(c) });
    }
    return out.sort((a, b) => a.text.localeCompare(b.text));
  }

  /** Completes inside a predicate: a key name after `[`, or a key's value after `=`. */
  #completePredicate(rest: string, head: string, parent: SchemaNode | undefined, options: QueryOptions): PathCompletion[] {
    const bracket = rest.lastIndexOf('[');
    const stepText = rest.slice(0, rest.indexOf('['));
    const step = parseStep(stepText);
    if (step === undefined) return [];
    const node = this.#step(step, this.candidates(parent, options), parent?.module.name);
    if (node === undefined) return [];
    const before = head + rest.slice(0, bracket + 1);
    const inside = rest.slice(bracket + 1);
    const info = this.info(node);
    const eq = inside.indexOf('=');
    if (eq === -1) {
      const names = node.kind === 'list' ? node.keys.map((k) => k.name).filter((k) => !rest.slice(0, bracket).includes(`[${k}=`)) : node.kind === 'leaf-list' ? ['.'] : [];
      return names
        .filter((k) => k.startsWith(inside.trim()))
        .map((k) => ({ text: `${before}${k}=`, extends: true, kind: 'key' as const, node: info }));
    }
    const keyName = inside.slice(0, eq).trim();
    const valueTyped = inside.slice(eq + 1);
    const quote = valueTyped.startsWith('"') ? '"' : "'";
    const typed = valueTyped.replace(/^['"]/, '');
    const leaf: LeafNode | LeafListNode | undefined = keyName === '.' && node.kind === 'leaf-list' ? node : node.kind === 'list' ? node.keys.find((k) => k.name === keyName) : undefined;
    if (leaf === undefined) return [];
    return valuesOf(leaf.type)
      .filter((v) => v.startsWith(typed))
      .map((v) => {
        const text = `${before}${keyName}=${quote}${v}${quote}]`;
        return { text, extends: text.startsWith(head + rest), kind: 'value' as const, node: info };
      });
  }
}

/** The values a type can take when it is a closed set: enum names, identities, booleans. */
export function valuesOf(type: YangType): string[] {
  switch (type.builtin) {
    case 'enumeration':
      return (type.enums ?? []).map((e) => e.name);
    case 'boolean':
      return ['true', 'false'];
    case 'identityref':
      return identitiesOf(type).map((i) => `${i.module.name}:${i.name}`);
    case 'leafref':
      return type.target === undefined ? [] : valuesOf(type.target.type);
    case 'union':
      return [...new Set((type.types ?? []).flatMap(valuesOf))];
    default:
      return [];
  }
}

/** Identities an identityref accepts: derived from every base (RFC 7950 §9.10.2). */
function identitiesOf(type: YangType): Identity[] {
  const bases = type.bases ?? [];
  if (bases.length === 0) return [];
  return [...bases[0]!.derived].filter((i) => bases.every((b) => b.derived.has(i))).sort((a, b) => `${a.module.name}:${a.name}`.localeCompare(`${b.module.name}:${b.name}`));
}

/** The data path of a schema node, RFC 7951 style. */
export function schemaPath(node: SchemaNode): string {
  const steps: string[] = [];
  for (let n: SchemaNode | undefined = node; n !== undefined; n = n.parent) {
    if (n.kind === 'choice' || n.kind === 'case' || n.kind === 'input' || n.kind === 'output') continue;
    let parent = n.parent;
    while (parent !== undefined && (parent.kind === 'choice' || parent.kind === 'case' || parent.kind === 'input' || parent.kind === 'output')) parent = parent.parent;
    steps.unshift(parent === undefined || parent.module !== n.module ? `${n.module.name}:${n.name}` : n.name);
  }
  return `/${steps.join('/')}`;
}

function typeDefault(type: YangType): string | undefined {
  for (let t: YangType | undefined = type; t !== undefined; t = t.typedef?.type) {
    if (t.typedef?.default !== undefined) return t.typedef.default;
  }
  return undefined;
}

export function summarizeType(type: YangType): TypeSummary {
  const fd = type.fractionDigits;
  const range = type.range === undefined ? undefined : formatIntervals(type.range, fd ?? 0);
  const length = type.length === undefined ? undefined : formatIntervals(type.length);
  const patterns = type.patterns.map((p) => p.source);
  const members = type.types?.map(summarizeType);
  const enums = type.enums?.map((e) => ({ name: e.name, value: e.value, ...(e.description === undefined ? {} : { description: e.description }) }));
  const bits = type.bits?.map((b) => ({ name: b.name, position: b.position, ...(b.description === undefined ? {} : { description: b.description }) }));
  const identities =
    type.builtin === 'identityref' ? identitiesOf(type).map((i) => ({ name: `${i.module.name}:${i.name}`, ...(i.description === undefined ? {} : { description: i.description }) })) : undefined;
  const target = type.target === undefined ? undefined : schemaPath(type.target);

  let detail: string | undefined;
  switch (type.builtin) {
    case 'enumeration':
      detail = enums?.map((e) => e.name).join(' | ');
      break;
    case 'bits':
      detail = bits?.map((b) => b.name).join(' ');
      break;
    case 'identityref':
      detail = `base ${(type.bases ?? []).map((b) => `${b.module.name}:${b.name}`).join(', ')}`;
      break;
    case 'union':
      detail = members?.map((m) => m.text).join(' | ');
      break;
    case 'leafref':
      detail = target === undefined ? type.path?.text : `→ ${target}`;
      break;
    case 'decimal64':
      detail = [range, `fraction-digits ${fd ?? 0}`].filter((x) => x !== undefined).join(', ');
      break;
    default:
      detail = [range, length === undefined ? undefined : `length ${length}`, patterns.length > 0 ? `pattern ${patterns.map((p) => JSON.stringify(p)).join(' ')}` : undefined]
        .filter((x) => x !== undefined)
        .join(', ');
  }
  const name = type.name === type.builtin || detail === undefined || detail === '' ? type.name : `${type.name} [${type.builtin}]`;
  return {
    name: type.name,
    builtin: type.builtin,
    text: detail === undefined || detail === '' ? type.name : `${name} (${detail})`,
    ...(enums === undefined ? {} : { enums }),
    ...(bits === undefined ? {} : { bits }),
    ...(identities === undefined ? {} : { identities }),
    ...(range === undefined ? {} : { range }),
    ...(length === undefined ? {} : { length }),
    ...(patterns.length === 0 ? {} : { patterns }),
    ...(fd === undefined ? {} : { fractionDigits: fd }),
    ...(members === undefined ? {} : { members }),
    ...(target === undefined ? {} : { target }),
  };
}

const INFO = new WeakMap<SchemaNode, NodeInfo>();

export function nodeInfo(node: SchemaNode): NodeInfo {
  const cached = INFO.get(node);
  if (cached !== undefined) return cached;
  const base = {
    name: node.name,
    module: node.module.name,
    kind: node.kind,
    path: schemaPath(node),
    config: node.config,
    status: node.status,
    hasChildren: ['container', 'list', 'rpc', 'action', 'notification', 'input', 'output'].includes(node.kind),
    node,
    ...(node.description === undefined ? {} : { description: node.description }),
  };
  let extra: Partial<Omit<NodeInfo, 'node'>> & { mandatory: boolean };
  switch (node.kind) {
    case 'container':
      extra = { mandatory: false, ...(node.presence === undefined ? {} : { presence: node.presence }) };
      break;
    case 'list':
      extra = {
        mandatory: node.minElements > 0,
        keys: node.keys.map((k) => k.name),
        orderedBy: node.orderedBy,
        minElements: node.minElements,
        ...(node.maxElements === undefined ? {} : { maxElements: node.maxElements }),
      };
      break;
    case 'leaf': {
      const dflt = node.default ?? (node.mandatory || node.isKey ? undefined : typeDefault(node.type));
      extra = {
        mandatory: node.mandatory,
        type: summarizeType(node.type),
        ...(dflt === undefined ? {} : { default: dflt }),
        ...(node.units === undefined ? {} : { units: node.units }),
      };
      break;
    }
    case 'leaf-list': {
      const own = node.defaults.length > 0 ? node.defaults : undefined;
      const typed = typeDefault(node.type);
      const defaults = own ?? (typed === undefined || node.minElements > 0 ? undefined : [typed]);
      extra = {
        mandatory: node.minElements > 0,
        type: summarizeType(node.type),
        orderedBy: node.orderedBy,
        minElements: node.minElements,
        ...(node.maxElements === undefined ? {} : { maxElements: node.maxElements }),
        ...(defaults === undefined ? {} : { defaults }),
        ...(node.units === undefined ? {} : { units: node.units }),
      };
      break;
    }
    case 'choice':
    case 'anydata':
    case 'anyxml':
      extra = { mandatory: node.mandatory };
      break;
    default:
      extra = { mandatory: false };
  }
  const info: NodeInfo = { ...base, ...extra };
  INFO.set(node, info);
  return info;
}

/**
 * Instance tree → RFC 7951 JSON.
 *
 * Member names are qualified with the module name at the top level and
 * where the module changes (§4). Values take the JSON type §6 gives their
 * YANG type: 64-bit integers and decimal64 as strings, empty as `[null]`,
 * identityrefs as `module:identity`. Metadata (RFC 7952 §5.2) goes in an `@`
 * member for containers, list entries, anydata and operations, and in an
 * `@name` sibling for leaves, leaf-lists (one array element per entry, null
 * where an entry has none) and anyxml.
 */

import { anyXmlToJson } from '../data/any.js';
import { Issues, modulesByNamespace } from '../data/build.js';
import { formatJson, type JsonValue } from '../data/lexical.js';
import { DataTree, schemaOf, type Annotation, type InstanceNode } from '../data/tree.js';
import type { CompiledModule } from '../schema/model.js';
import type { Schema } from '../schema/schema.js';

export interface JsonEncodeOptions {
  /** Namespace URI → module name, for annotations from modules the schema doesn't have. As in the decoders. */
  readonly namespaces?: Readonly<Record<string, string>>;
}

type JsonObject = { [member: string]: JsonValue };

/**
 * Writes a tree, or some of its nodes, as an RFC 7951 JSON object (a value
 * for JSON.stringify).
 *
 * @throws YangDataError if an annotation's module can't be found
 */
export function encodeJson(input: DataTree | InstanceNode | readonly InstanceNode[], options: JsonEncodeOptions = {}): JsonObject {
  const nodes: readonly InstanceNode[] = input instanceof DataTree ? input.children : Array.isArray(input) ? input : [input as InstanceNode];
  const encoder = new JsonEncoder(options, input instanceof DataTree ? input.schema : nodes[0] === undefined ? undefined : schemaOf(nodes[0]));
  const out: JsonObject = {};
  encoder.members(nodes, undefined, out);
  encoder.issues.throwIfAny();
  return out;
}

/** Writes a tree, or some of its nodes, as RFC 7951 JSON text. */
export function toJson(input: DataTree | InstanceNode | readonly InstanceNode[], options: JsonEncodeOptions & { readonly indent?: number | string } = {}): string {
  return JSON.stringify(encodeJson(input, options), null, options.indent);
}

class JsonEncoder {
  readonly issues = new Issues();

  constructor(
    readonly options: JsonEncodeOptions,
    readonly schema: Schema | undefined,
  ) {}

  members(nodes: readonly InstanceNode[], context: CompiledModule | undefined, out: JsonObject): void {
    const leafListMeta = new Map<string, (JsonObject | null)[]>();
    for (const n of nodes) {
      const name = n.schema.module === context ? n.schema.name : `${n.schema.module.name}:${n.schema.name}`;
      switch (n.kind) {
        case 'container':
        case 'rpc':
        case 'action':
        case 'notification':
          out[name] = this.#object(n);
          break;
        case 'list':
          ((out[name] ??= []) as JsonValue[]).push(this.#object(n));
          break;
        case 'leaf':
          out[name] = formatJson(n.value);
          if (n.annotations.length > 0) out[`@${name}`] = this.#metadata(n);
          break;
        case 'leaf-list': {
          const values = (out[name] ??= []) as JsonValue[];
          values.push(formatJson(n.value));
          let meta = leafListMeta.get(name);
          if (meta === undefined) leafListMeta.set(name, (meta = []));
          meta.push(n.annotations.length > 0 ? this.#metadata(n) : null);
          break;
        }
        case 'anydata': {
          const content = this.#anyContent(n);
          const object: JsonObject = typeof content === 'object' && content !== null && !Array.isArray(content) ? content : {};
          out[name] = n.annotations.length > 0 ? { '@': this.#metadata(n), ...object } : object;
          break;
        }
        case 'anyxml':
          out[name] = this.#anyContent(n);
          if (n.annotations.length > 0) out[`@${name}`] = this.#metadata(n);
          break;
      }
    }
    for (const [name, meta] of leafListMeta) if (meta.some((m) => m !== null)) out[`@${name}`] = meta;
  }

  #object(n: InstanceNode & { readonly children: readonly InstanceNode[] }): JsonObject {
    const out: JsonObject = {};
    if (n.annotations.length > 0) out['@'] = this.#metadata(n);
    this.members(n.children, n.schema.module, out);
    return out;
  }

  #anyContent(n: InstanceNode & { kind: 'anydata' | 'anyxml' }): JsonValue {
    const content = n.content;
    return content.format === 'json' ? content.value : anyXmlToJson(content.nodes, n.schema.module.namespace, this.schema ?? schemaOf(n));
  }

  #metadata(n: InstanceNode): JsonObject {
    const out: JsonObject = {};
    for (const a of n.annotations) {
      const module = this.#moduleOf(a, n);
      if (module === undefined) {
        const what = a.namespace === '' ? `unqualified attribute ${a.name}` : `annotation ${a.name} in namespace '${a.namespace ?? ''}'`;
        this.issues.add('unknown-annotation', `${what} has no module name for JSON; give it in the namespaces option`, n.path);
        continue;
      }
      out[`${module}:${a.name}`] = typeof a.value === 'string' ? a.value : formatJson(a.value);
    }
    return out;
  }

  #moduleOf(a: Annotation, n: InstanceNode): string | undefined {
    if (a.module !== undefined) return a.module;
    if (a.namespace === undefined || a.namespace === '') return undefined;
    return modulesByNamespace(this.schema ?? schemaOf(n)).get(a.namespace)?.name ?? this.options.namespaces?.[a.namespace];
  }
}

/**
 * Instance tree → XML (RFC 7950 §7 and §9; draft-ietf-netmod-yang-xml).
 *
 * Each element declares the default namespace where the module changes.
 * Prefixes needed inside values (identityref, instance-identifier) and for
 * annotation attributes are declared on the element that uses them, named
 * after the module's YANG prefix, as libyang does.
 */

import { anyJsonToXml } from '../data/any.js';
import { Issues, YANG_NS } from '../data/build.js';
import { isDefaultAnnotation } from '../data/defaults.js';
import { formatText } from '../data/lexical.js';
import { DataTree, schemaOf, type Annotation, type InstanceNode } from '../data/tree.js';
import type { CompiledModule } from '../schema/model.js';
import type { Schema } from '../schema/schema.js';
import type { XmlAttributeLike, XmlChild } from './element.js';
import type { PlainElement } from './parse.js';
import { serializeXml, type XmlSerializeOptions } from './serialize.js';

export interface XmlEncodeOptions {
  /** Namespace URI → module name, for annotations known only by module name. As in the decoders' `namespaces` option. */
  readonly namespaces?: Readonly<Record<string, string>>;
  /**
   * Nodes to leave out, with their subtrees, as if they weren't in the tree.
   * An access control layer uses this to send a shared, immutable tree
   * without the nodes a user may not read, instead of copying the tree.
   */
  readonly skip?: (node: InstanceNode) => boolean;
}

/**
 * Writes a tree, or some of its nodes, as XML elements: one per top-level
 * node. Pass an operation's children to get only its parameters, as in a
 * NETCONF `<rpc-reply>`.
 *
 * @throws YangDataError if an annotation's namespace can't be found
 */
export function encodeXml(input: DataTree | InstanceNode | readonly InstanceNode[], options: XmlEncodeOptions = {}): PlainElement[] {
  const nodes: readonly InstanceNode[] = input instanceof DataTree ? input.children : Array.isArray(input) ? input : [input as InstanceNode];
  const schema = input instanceof DataTree ? input.schema : undefined;
  const encoder = new XmlEncoder(options, schema);
  const scope = new Map([['', '']]);
  const skip = options.skip;
  const out = (skip === undefined ? nodes : nodes.filter((n) => !skip(n))).map((n) => encoder.node(n, scope));
  encoder.issues.throwIfAny();
  return out;
}

/** Writes a tree, or some of its nodes, as XML text. */
export function toXml(input: DataTree | InstanceNode | readonly InstanceNode[], options: XmlEncodeOptions & XmlSerializeOptions = {}): string {
  return serializeXml(encodeXml(input, options), options);
}

class XmlEncoder {
  readonly issues = new Issues();
  readonly #moduleNamespaces = new Map<string, string>();

  constructor(
    readonly options: XmlEncodeOptions,
    readonly schema: Schema | undefined,
  ) {
    for (const [ns, module] of Object.entries(options.namespaces ?? {})) this.#moduleNamespaces.set(module, ns);
  }

  /** The children to write: all of them, less those `skip` leaves out. */
  #children(children: readonly InstanceNode[]): readonly InstanceNode[] {
    const skip = this.options.skip;
    return skip === undefined ? children : children.filter((c) => !skip(c));
  }

  node(n: InstanceNode, parentScope: ReadonlyMap<string, string>): PlainElement {
    const module = n.schema.module;
    const ns = module.namespace;
    const declarations = new Map<string, string>();
    const scope = new Map(parentScope);
    if (scope.get('') !== ns) {
      declarations.set('', ns);
      scope.set('', ns);
    }
    const prefixFor = (uri: string, preferred: string): string => {
      for (const [p, u] of scope) if (p !== '' && u === uri) return p;
      let p = preferred;
      for (let i = 1; scope.has(p); i++) p = `${preferred}${i}`;
      declarations.set(p, uri);
      scope.set(p, uri);
      return p;
    };
    // Prefixes inside a value are declared on the value's own element, even
    // when an ancestor binds them, so the element stands alone (as libyang
    // writes it).
    const prefix = (m: CompiledModule): string => {
      for (const [p, u] of declarations) if (p !== '' && u === m.namespace) return p;
      let p = m.prefix;
      for (let i = 1; scope.has(p) && scope.get(p) !== m.namespace; i++) p = `${m.prefix}${i}`;
      declarations.set(p, m.namespace);
      scope.set(p, m.namespace);
      return p;
    };

    // Prefixes inside an edit's yang:key or yang:value, bound on the element
    // once the value's own prefixes are chosen.
    const anchors: [string, string][] = [];
    const declare = (p: string, uri: string): void => void anchors.push([p, uri]);
    const attributes = n.annotations.flatMap((a) => this.#attribute(a, n, prefixFor, prefix, declare));
    let children: XmlChild[];
    switch (n.kind) {
      case 'container':
      case 'list':
      case 'rpc':
      case 'action':
      case 'notification':
        children = this.#children(n.children).map((c) => this.node(c, scope));
        break;
      case 'leaf':
      case 'leaf-list': {
        const text = formatText(n.value, prefix, this.schema ?? schemaOf(n));
        children = text === '' ? [] : [text];
        break;
      }
      case 'anydata':
      case 'anyxml':
        children = n.content.format === 'xml' ? [...n.content.nodes] : anyJsonToXml(n.content.value, ns, this.schema ?? schemaOf(n));
        break;
    }
    for (const [p, uri] of anchors) {
      if (scope.get(p) === uri) continue;
      declarations.set(p, uri);
      scope.set(p, uri);
    }
    return { name: n.schema.name, ns, prefix: undefined, attributes, children, declarations };
  }

  #attribute(
    a: Annotation,
    n: InstanceNode,
    prefixFor: (uri: string, preferred: string) => string,
    valuePrefix: (m: CompiledModule) => string,
    declare: (prefix: string, uri: string) => void,
  ): XmlAttributeLike[] {
    const module = a.module === undefined || (a.namespace !== undefined && a.prefix !== undefined) ? undefined : (this.schema ?? schemaOf(n)).module(a.module);
    const namespace = a.namespace ?? module?.namespace ?? (a.module === undefined ? undefined : this.#moduleNamespaces.get(a.module));
    if (namespace === undefined) {
      this.issues.add('unknown-annotation', `annotation ${a.module ?? ''}:${a.name} has no known namespace; give it in the namespaces option`, n.path);
      return [];
    }
    const value = typeof a.value === 'string' ? a.value : formatText(a.value, valuePrefix);
    if (namespace === YANG_NS && (a.name === 'key' || a.name === 'value') && typeof a.value === 'string') this.#anchorPrefixes(a.value, a.prefixes, n, declare);
    if (namespace === '') return [{ name: a.name, ns: undefined, value }];
    // RFC 6243's examples write the with-defaults attribute as wd:default.
    const p = prefixFor(namespace, a.prefix ?? module?.prefix ?? (isDefaultAnnotation(a.namespace, a.module, a.name) ? 'wd' : 'a'));
    return [{ name: a.name, ns: namespace, prefix: p, value }];
  }

  /**
   * `yang:key` and `yang:value` are written as given, so the prefixes in
   * them are declared: as they were bound where the edit was read from
   * XML, or else as module names (the RFC 7951 form), which are valid XML
   * prefixes too.
   */
  #anchorPrefixes(value: string, prefixes: ReadonlyMap<string, string> | undefined, n: InstanceNode, declare: (prefix: string, uri: string) => void): void {
    const schema = this.schema ?? schemaOf(n);
    for (const m of value.matchAll(/([A-Za-z_][\w.-]*):(?=[A-Za-z_])/g)) {
      const p = m[1]!;
      const uri = prefixes?.get(p) ?? schema.module(p)?.namespace;
      if (uri !== undefined && p !== 'xml' && p !== 'xmlns') declare(p, uri);
    }
  }
}

/**
 * Whether two anydata or anyxml contents mean the same.
 *
 * RFC 7950 §7.10.3 and §7.11.3 make anydata and anyxml opaque: an edit
 * replaces the content whole. So a diff only has to tell whether the
 * content changed, and must not report a change where the content is
 * written differently but means the same. There is no schema for the
 * content, so the rules are structural, and every doubt counts as
 * different: a false "different" costs one needless replace, while a false
 * "same" loses a change.
 *
 * - JSON: object member order is ignored, array order is kept, numbers are
 *   compared by value, and a number differs from a string with the same
 *   digits. Nested `@` members are compared as data.
 * - XML: element and attribute prefixes are ignored (namespace URIs are
 *   compared), as are attribute order, namespace declarations,
 *   whitespace-only text between elements (except in mixed content, where
 *   it is text), and `<a/>` against `<a></a>`.
 *   Text is compared exactly as written: without a schema, `1.0` isn't `1`
 *   and `a:x` isn't `b:x` even where `a` and `b` name the same namespace.
 *   In anydata, which holds YANG-modelled data, the order of sibling
 *   elements with different names is ignored (RFC 7950 §7.5.7), while
 *   same-named siblings, as list or leaf-list entries, keep their order. In
 *   anyxml, which may hold any XML, element order is kept.
 * - XML against JSON: the JSON is written as XML, as {@link anyJsonToXml}
 *   does, and the two are compared as XML. Where that isn't faithful (a
 *   member in a module the schema doesn't know, an `@` metadata member, an
 *   array that isn't a member's value), the contents count as different.
 */

import type { Schema } from '../schema/schema.js';
import { isElement, type XmlChild } from '../xml/element.js';
import { anyJsonToXml } from './any.js';
import type { JsonValue } from './lexical.js';
import type { AnyContent } from './tree.js';

const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';

/**
 * Whether two contents of one anydata or anyxml node mean the same.
 * `kind` is the node's kind, `ns` its module's namespace (the namespace of
 * unqualified content) and `schema` the schema that names the modules in
 * JSON member names.
 */
export function sameAnyContent(a: AnyContent, b: AnyContent, kind: 'anydata' | 'anyxml', ns: string, schema: Schema): boolean {
  if (a.format === 'json' && b.format === 'json') return sameJson(a.value, b.value);
  const x = a.format === 'xml' ? a.nodes : jsonAsXml(a.value, ns, schema);
  const y = b.format === 'xml' ? b.nodes : jsonAsXml(b.value, ns, schema);
  if (x === undefined || y === undefined) return false;
  return sameNorm(normalise(x, ns, kind === 'anydata'), normalise(y, ns, kind === 'anydata'));
}

function sameJson(a: JsonValue, b: JsonValue): boolean {
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => sameJson(v, b[i]!));
  }
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => Object.hasOwn(b, k) && sameJson(a[k]!, b[k]!));
}

/** JSON content written as XML, or undefined where that wouldn't be faithful. */
function jsonAsXml(value: JsonValue, ns: string, schema: Schema): XmlChild[] | undefined {
  if (Array.isArray(value)) return undefined;
  return faithful(value, schema) ? anyJsonToXml(value, ns, schema) : undefined;
}

function faithful(value: JsonValue, schema: Schema): boolean {
  if (value === null || typeof value !== 'object') return true;
  if (Array.isArray(value)) return false;
  for (const [member, v] of Object.entries(value)) {
    if (member.startsWith('@')) return false;
    const colon = member.indexOf(':');
    if (colon !== -1 && schema.module(member.slice(0, colon)) === undefined) return false;
    const items = Array.isArray(v) ? v : [v];
    if (!items.every((item) => !Array.isArray(item) && faithful(item, schema))) return false;
  }
  return true;
}

/** XML content in a form where content that means the same is equal. */
type Norm = string | { readonly ns: string; readonly name: string; readonly attrs: string; readonly children: readonly Norm[] };

function normalise(nodes: readonly XmlChild[], parentNs: string, unordered: boolean): Norm[] {
  if (!nodes.some(isElement)) {
    const text = nodes.filter((n): n is string => typeof n === 'string').join('');
    return text === '' ? [] : [text];
  }
  // In mixed content (text beside elements), whitespace between elements is text too.
  const mixed = nodes.some((n) => typeof n === 'string' && n.trim() !== '');
  const out: Norm[] = [];
  let text: string | undefined;
  const flush = (): void => {
    if (text !== undefined && text !== '' && (mixed || text.trim() !== '')) out.push(text);
    text = undefined;
  };
  for (const n of nodes) {
    if (!isElement(n)) {
      text = (text ?? '') + n;
      continue;
    }
    flush();
    const ns = n.ns ?? parentNs;
    const attrs = JSON.stringify(
      (n.attributes ?? [])
        .filter((t) => t.ns !== XMLNS_NS && !(t.ns === undefined && t.name === 'xmlns'))
        .map((t) => [t.ns ?? '', t.name, t.value])
        .sort(),
    );
    out.push({ ns, name: n.name, attrs, children: normalise(n.children ?? [], ns, unordered) });
  }
  flush();
  // Siblings with different names in any order, unless there is text among them.
  if (unordered && out.every((c) => typeof c !== 'string')) out.sort((x, y) => compare(nameKey(x), nameKey(y)));
  return out;
}

function nameKey(n: Norm): string {
  return typeof n === 'string' ? '' : `${n.ns}\u0000${n.name}`;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sameNorm(a: readonly Norm[], b: readonly Norm[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i]!;
    if (typeof x === 'string' || typeof y === 'string') return x === y;
    return x.ns === y.ns && x.name === y.name && x.attrs === y.attrs && sameNorm(x.children, y.children);
  });
}

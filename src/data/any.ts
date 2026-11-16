/**
 * anydata and anyxml content converted between encodings.
 *
 * Their content is kept in the encoding it was read from, so writing it back
 * in that encoding is exact. Converting it to the other encoding has no
 * schema to go by, so it is structural and lossy, like libyang's:
 *
 * - XML → JSON: an element with child elements becomes an object, any other
 *   element a string; repeated names become arrays; names are qualified with
 *   a module name where the namespace changes and the schema knows the
 *   namespace. Attributes are dropped.
 * - JSON → XML: members become elements in the namespace of their module
 *   (or the parent's), arrays repeated elements, scalars text, `null` and
 *   `[null]` empty elements. `@` metadata members are dropped.
 */

import type { Schema } from '../schema/schema.js';
import { isElement, type XmlChild, type XmlElementLike } from '../xml/element.js';
import { modulesByNamespace } from './build.js';
import { scalarText, type JsonValue } from './lexical.js';

export function anyXmlToJson(nodes: readonly XmlChild[], parentNs: string, schema: Schema): JsonValue {
  const elements = nodes.filter(isElement);
  if (elements.length === 0) return nodes.filter((n): n is string => typeof n === 'string').join('');
  const byNs = modulesByNamespace(schema);
  const out: Record<string, JsonValue> = {};
  for (const el of elements) {
    const ns = el.ns ?? parentNs;
    const module = ns === parentNs ? undefined : byNs.get(ns);
    const key = module === undefined ? el.name : `${module.name}:${el.name}`;
    const kids = el.children ?? [];
    const value = kids.some(isElement) ? anyXmlToJson(kids, ns, schema) : kids.filter((k): k is string => typeof k === 'string').join('');
    const existing = out[key];
    if (existing === undefined) out[key] = value;
    else if (Array.isArray(existing) && REPEATED.has(existing)) existing.push(value);
    else out[key] = repeated([existing, value]);
  }
  return out;
}

/** Arrays made from repeated elements, as opposed to values that are arrays. */
const REPEATED = new WeakSet<JsonValue[]>();
function repeated(values: JsonValue[]): JsonValue[] {
  REPEATED.add(values);
  return values;
}

export function anyJsonToXml(value: JsonValue, parentNs: string, schema: Schema): XmlChild[] {
  if (value === null || typeof value !== 'object') return value === null ? [] : [scalarText(value)];
  if (Array.isArray(value)) return value.length === 1 && value[0] === null ? [] : value.flatMap((v) => anyJsonToXml(v, parentNs, schema));
  const out: XmlElementLike[] = [];
  for (const [member, v] of Object.entries(value)) {
    if (member.startsWith('@')) continue;
    const colon = member.indexOf(':');
    const ns = colon === -1 ? parentNs : (schema.module(member.slice(0, colon))?.namespace ?? parentNs);
    const name = colon === -1 ? member : member.slice(colon + 1);
    const items = Array.isArray(v) && !(v.length === 1 && v[0] === null) ? v : [v];
    for (const item of items) out.push({ name, ns, children: anyJsonToXml(item, ns, schema) });
  }
  return out;
}

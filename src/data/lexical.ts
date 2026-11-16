/**
 * Reading and writing typed values: the XML lexical form (RFC 7950 §9) and
 * the JSON form (RFC 7951 §6), in both directions.
 *
 * Prefixes inside values (identityref, instance-identifier) mean different
 * things in the two encodings: XML namespace prefixes in scope at the element,
 * module names in JSON. A {@link ValueScope} hides the difference.
 */

import { decodeBase64, encodeBase64, sameBytes } from './base64.js';
import type { CompiledModule, Identity, YangType } from '../schema/model.js';
import type { Schema } from '../schema/schema.js';
import { parseNumber } from '../types/range.js';
import { checkValue, type ValueContext } from '../types/value.js';
import { formatInstanceIdentifier, parseInstanceIdentifier } from './instance-id.js';
import { isXPath10, readXPathValue, writeXPathXml } from './xpath-value.js';
import { Decimal64, type InstanceIdentifier, type TypedValue, type YangValue } from './value.js';

/** A JSON value, as JSON.parse returns it. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [member: string]: JsonValue };

/** How prefixes written inside a value map to modules. */
export interface ValueScope {
  readonly format: 'xml' | 'json';
  readonly schema: Schema;
  /** XML: the module whose namespace a prefix is bound to. JSON: the module of that name. */
  module(prefix: string): CompiledModule | undefined;
  /**
   * The module an unprefixed name belongs to. XML: the module of the default
   * namespace in scope. JSON: the module of the node holding the value
   * (RFC 7951 §6.8).
   */
  readonly unprefixed: CompiledModule | undefined;
}

/** Writes the prefix for a module's namespace into XML output, declaring it if needed. */
export type PrefixWriter = (module: CompiledModule) => string;

const INTEGER_TYPES = new Set(['int8', 'int16', 'int32', 'uint8', 'uint16', 'uint32']);
const BIG_TYPES = new Set(['int64', 'uint64']);
/** Types whose lexical form has no meaningful leading or trailing whitespace. */
const TRIMMED = new Set(['int8', 'int16', 'int32', 'int64', 'uint8', 'uint16', 'uint32', 'uint64', 'decimal64', 'boolean', 'enumeration', 'identityref', 'instance-identifier']);

/** Reads a value in its lexical (XML) form. Returns the typed value, or a message saying why it's invalid. */
export function parseText(type: YangType, text: string, scope: ValueScope): TypedValue | string {
  switch (type.builtin) {
    case 'leafref':
      return type.target === undefined ? { type, value: text } : parseText(type.target.type, text, scope);
    case 'union': {
      for (const member of type.types ?? []) {
        const v = parseText(member, text, scope);
        if (typeof v !== 'string') return v;
      }
      return `'${text}' matches none of the union's member types`;
    }
    default:
      return parseSingle(type, TRIMMED.has(type.builtin) ? text.trim() : text, scope);
  }
}

/**
 * Reads a value in its JSON form (RFC 7951 §6). The JSON type must suit the
 * YANG type: numbers for integers up to 32 bits, strings for 64-bit integers
 * and decimal64, `[null]` for empty. That also selects the union member
 * (§6.10), so `"1"` is never an integer.
 */
export function parseJson(type: YangType, json: unknown, scope: ValueScope): TypedValue | string {
  switch (type.builtin) {
    case 'leafref':
      if (type.target === undefined) return typeof json === 'string' ? { type, value: json } : `${describe(json)} is not a string`;
      return parseJson(type.target.type, json, scope);
    case 'union': {
      for (const member of type.types ?? []) {
        const v = parseJson(member, json, scope);
        if (typeof v !== 'string') return v;
      }
      return `${describe(json)} matches none of the union's member types`;
    }
    default: {
      const text = jsonText(type, json);
      return text.ok ? parseSingle(type, text.text, scope) : text.message;
    }
  }
}

function jsonText(type: YangType, json: unknown): { ok: true; text: string } | { ok: false; message: string } {
  const b = type.builtin;
  if (INTEGER_TYPES.has(b)) {
    if (typeof json === 'number' && Number.isInteger(json)) return { ok: true, text: String(json) };
    return { ok: false, message: `${describe(json)} is not a JSON number, as ${b} requires (RFC 7951 §6.1)` };
  }
  if (BIG_TYPES.has(b) || b === 'decimal64') {
    if (typeof json === 'string') return { ok: true, text: json };
    return { ok: false, message: `${describe(json)} is not a JSON string, as ${b} requires (RFC 7951 §6.1)` };
  }
  if (b === 'boolean') {
    if (typeof json === 'boolean') return { ok: true, text: String(json) };
    return { ok: false, message: `${describe(json)} is not true or false` };
  }
  if (b === 'empty') {
    if (Array.isArray(json) && json.length === 1 && json[0] === null) return { ok: true, text: '' };
    return { ok: false, message: `${describe(json)} is not [null], the value of type empty` };
  }
  if (typeof json === 'string') return { ok: true, text: json };
  return { ok: false, message: `${describe(json)} is not a JSON string, as ${b} requires` };
}

/** A short description of a JSON value for messages. */
export function describe(json: unknown): string {
  if (typeof json === 'string') return `'${json.length > 60 ? `${json.slice(0, 57)}...` : json}'`;
  if (Array.isArray(json)) return 'an array';
  if (json === null) return 'null';
  if (typeof json === 'object') return 'an object';
  return scalarText(json);
}

function identityResolver(scope: ValueScope): ValueContext {
  return {
    resolveIdentity: (prefix, name): Identity | undefined => {
      const module = prefix === undefined ? scope.unprefixed : scope.module(prefix);
      return module?.identities.get(name);
    },
  };
}

/** Reads a value of a type that is neither leafref nor union. */
function parseSingle(type: YangType, text: string, scope: ValueScope): TypedValue | string {
  if (type.builtin === 'instance-identifier') {
    const id = parseInstanceIdentifier(text, scope);
    return typeof id === 'string' ? id : { type, value: id };
  }
  const context = identityResolver(scope);
  const problem = checkValue(type, text, context);
  if (problem !== undefined) return problem;
  if (type.builtin === 'string' && isXPath10(type)) {
    const read = readXPathValue(text, scope.format, (p) => scope.module(p));
    return typeof read === 'string' ? read : { type, value: read.json };
  }
  return { type, value: convert(type, text, context) };
}

/** Converts a lexical value that checkValue accepted into its typed form. */
function convert(type: YangType, text: string, context: ValueContext): YangValue {
  switch (type.builtin) {
    case 'int8':
    case 'int16':
    case 'int32':
    case 'uint8':
    case 'uint16':
    case 'uint32':
      return Number(text);
    case 'int64':
    case 'uint64':
      return BigInt(text);
    case 'decimal64': {
      const digits = type.fractionDigits ?? 0;
      return new Decimal64(parseNumber(text, true, digits) as bigint, digits);
    }
    case 'boolean':
      return text === 'true';
    case 'empty':
      return null;
    case 'binary':
      return decodeBase64(text);
    case 'bits': {
      const set = new Set(text.split(/[ \t\r\n]+/));
      return (type.bits ?? []).filter((b) => set.has(b.name)).sort((a, b) => a.position - b.position).map((b) => b.name);
    }
    case 'identityref': {
      const i = text.indexOf(':');
      return context.resolveIdentity(i === -1 ? undefined : text.slice(0, i), i === -1 ? text : text.slice(i + 1))!;
    }
    case 'string':
    case 'enumeration':
    case 'instance-identifier':
    case 'leafref':
    case 'union':
      return text;
  }
}

/**
 * The canonical lexical (XML) form of a value. `prefix` supplies namespace
 * prefixes for identityref, instance-identifier and `yang:xpath1.0` values.
 * An xpath1.0 value is held with module names as prefixes, so it needs the
 * `schema` to find them; without one it is written as it is held.
 */
export function formatText(v: TypedValue, prefix: PrefixWriter, schema?: Schema): string {
  const value = v.value;
  // A leaf an edit deletes without giving its value (decode option edit).
  if (value === null) return '';
  switch (v.type.builtin) {
    case 'empty':
      return '';
    case 'binary':
      return encodeBase64(value as Uint8Array);
    case 'bits':
      return (value as readonly string[]).join(' ');
    case 'identityref': {
      const id = value as Identity;
      return `${prefix(id.module)}:${id.name}`;
    }
    case 'instance-identifier':
      return formatInstanceIdentifier(value as InstanceIdentifier, { prefix });
    case 'string':
      return schema !== undefined && typeof value === 'string' && isXPath10(v.type) ? writeXPathXml(value, schema, prefix) : scalarText(value);
    default:
      return scalarText(value);
  }
}

/** The text of a scalar: a string, number, bigint, boolean or Decimal64. Anything else gives ''. */
export function scalarText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') return v.toString();
  if (v instanceof Decimal64) return v.toString();
  return '';
}

/** The JSON form of a value (RFC 7951 §6). */
export function formatJson(v: TypedValue): JsonValue {
  const value = v.value;
  if (value === null && v.type.builtin !== 'empty') return null;
  switch (v.type.builtin) {
    case 'int8':
    case 'int16':
    case 'int32':
    case 'uint8':
    case 'uint16':
    case 'uint32':
      return value as number;
    case 'boolean':
      return value as boolean;
    case 'empty':
      return [null];
    case 'identityref': {
      // Always qualified: RFC 7951 §6.8 allows it everywhere and requires it across modules.
      const id = value as Identity;
      return `${id.module.name}:${id.name}`;
    }
    case 'instance-identifier':
      return formatInstanceIdentifier(value as InstanceIdentifier, { json: true });
    case 'binary':
    case 'bits':
      return formatText(v, () => '');
    default:
      return scalarText(value);
  }
}

/** Compares two values of the same type for equality. */
export function sameValue(a: TypedValue, b: TypedValue): boolean {
  if (a.type.builtin !== b.type.builtin) return false;
  const x = a.value;
  const y = b.value;
  if (x instanceof Decimal64 && y instanceof Decimal64) return x.equals(y);
  if (x instanceof Uint8Array && y instanceof Uint8Array) return sameBytes(x, y);
  if (Array.isArray(x) && Array.isArray(y)) return x.length === y.length && x.every((e, i) => e === y[i]);
  if (a.type.builtin === 'instance-identifier') return formatJson(a) === formatJson(b);
  return x === y;
}

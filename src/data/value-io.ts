/**
 * Single values between RFC 7951 JSON and XML text, for callers that build
 * XML themselves from a schema walk (such as a NETCONF subtree filter's
 * content-match nodes) rather than from a whole instance tree.
 */

import type { CompiledModule, YangType } from '../schema/model.js';
import type { Schema } from '../schema/schema.js';
import { formatText, parseJson, parseText, scalarText, type ValueScope } from './lexical.js';
import type { TypedValue } from './value.js';

export interface ReadJsonValueOptions {
  /**
   * Also accept the value's text where its JSON type is wrong for the YANG
   * type: `"1500"` for a uint16, `1500` for an int64. Default false (RFC 7951's
   * types, strictly).
   */
  readonly lenient?: boolean;
}

/**
 * Reads one value of `type` in its RFC 7951 JSON form. `module` is the module
 * of the node holding the value, which an unqualified identityref belongs to.
 * @returns the typed value, or a message saying why it isn't one
 */
export function readJsonValue(schema: Schema, type: YangType, json: unknown, module: CompiledModule, options: ReadJsonValueOptions = {}): TypedValue | string {
  const scope: ValueScope = { format: 'json', schema, module: (p) => schema.module(p), unprefixed: module };
  const strict = parseJson(type, json, scope);
  if (typeof strict !== 'string' || options.lenient !== true) return strict;
  if (typeof json !== 'string' && typeof json !== 'number' && typeof json !== 'boolean') return strict;
  const loose = parseText(type, scalarText(json), scope);
  return typeof loose === 'string' ? strict : loose;
}

/**
 * Writes a typed value as XML text. `prefix` gives the XML prefix to write for
 * a module whose identity or node a value names (identityref,
 * instance-identifier, `yang:xpath1.0`); the caller declares it. A
 * `yang:xpath1.0` value names modules by name, so it needs the `schema` to
 * be written with prefixes; without one it is written as it is held.
 */
export function writeXmlText(value: TypedValue, prefix: (module: CompiledModule) => string, schema?: Schema): string {
  return formatText(value, prefix, schema);
}

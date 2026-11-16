/**
 * XML ↔ RFC 7951 JSON in one call, through the instance tree.
 *
 * Decoding checks everything the schema says about each node (names,
 * namespaces, values, list keys), so a conversion either succeeds or throws
 * a YangDataError listing every problem with its data path.
 */

import type { DataTree } from './data/tree.js';
import type { JsonValue } from './data/lexical.js';
import { decodeJson, type JsonDecodeOptions } from './json/decode.js';
import { encodeJson, type JsonEncodeOptions } from './json/encode.js';
import type { Schema } from './schema/schema.js';
import { decodeXml, type XmlDecodeOptions } from './xml/decode.js';
import type { XmlElementLike } from './xml/element.js';
import { toXml, type XmlEncodeOptions } from './xml/encode.js';
import type { XmlSerializeOptions } from './xml/serialize.js';

/**
 * Converts YANG data in XML (text or parsed elements) to an RFC 7951 JSON
 * object.
 *
 * @throws YangDataError
 */
export function xmlToJson(
  schema: Schema,
  xml: string | XmlElementLike | readonly XmlElementLike[],
  options: XmlDecodeOptions & JsonEncodeOptions = {},
): { [member: string]: JsonValue } {
  return encodeJson(decodeXml(schema, xml, options), options);
}

/**
 * Converts RFC 7951 JSON (text or a parsed value) to XML text.
 *
 * @throws YangDataError
 */
export function jsonToXml(schema: Schema, json: unknown, options: JsonDecodeOptions & XmlEncodeOptions & XmlSerializeOptions = {}): string {
  const tree: DataTree = decodeJson(schema, json, options);
  return toXml(tree, options);
}

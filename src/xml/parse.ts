/**
 * XML text → {@link XmlElementLike} elements, with namespaces resolved.
 *
 * `@rgrove/parse-xml` (the parser @node-net/netconf uses) checks well-formedness.
 * On top of that, any DOCTYPE is rejected (ruling out entity expansion and
 * external entities), prefixes are resolved to namespace URIs, and depth and
 * size limits apply. The text may hold several top-level elements, as YANG
 * data for more than one module does.
 */

import { parseXml as parseDocument, XmlElement as RawElement, XmlError, XmlText as RawText, type XmlNode as RawNode } from '@rgrove/parse-xml';
import { codePointToUtf16 } from '../data/positions.js';
import { YangDataError } from '../errors.js';
import { LineIndex } from '../location.js';
import type { XmlAttributeLike, XmlChild, XmlElementLike } from './element.js';

export const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';

export interface XmlParseOptions {
  /** Maximum element nesting depth. Default 256. */
  readonly maxDepth?: number;
  /** Maximum number of elements and text nodes. Default 5,000,000. */
  readonly maxNodes?: number;
  /**
   * Record each element's offset into the text (`offset`), and report syntax
   * errors with their position.
   */
  readonly positions?: boolean;
}

const NCNAME = /^[\p{L}_][\p{L}\p{N}\p{Mn}\p{Mc}._\-·‿⁀]*$/u;

/** A plain, mutable element as the parser and encoder build it. */
export interface PlainElement extends XmlElementLike {
  readonly name: string;
  readonly ns: string;
  readonly prefix: string | undefined;
  readonly attributes: XmlAttributeLike[];
  readonly children: XmlChild[];
  readonly declarations: Map<string, string>;
  /** With the `positions` option: the offset of the element's `<` in the text, in UTF-16 code units. */
  readonly offset?: number;
}

/** Where a syntax error is: an offset into the text it is in. */
interface ErrorPlace {
  readonly text: string;
  readonly offset: number;
}

function fail(message: string, cause?: unknown, place?: ErrorPlace): never {
  const position = place === undefined ? {} : { position: new LineIndex(place.text).locate(place.offset) };
  throw new YangDataError([{ code: 'xml-syntax', message, path: '/', severity: 'error', ...position }], cause === undefined ? undefined : { cause });
}

/**
 * Parses XML text into its top-level elements. Comments and processing
 * instructions are dropped, and whitespace-only text beside elements too.
 *
 * @throws YangDataError with an `xml-syntax` issue
 */
export function parseXml(text: string, options: XmlParseOptions = {}): PlainElement[] {
  const positioned = options.positions === true;
  const doctype = /<!DOCTYPE/i.exec(text);
  if (doctype !== null) fail('DOCTYPE declarations are not allowed', undefined, positioned ? { text, offset: doctype.index } : undefined);
  const body = text.replace(/^\uFEFF?\s*<\?xml[^?]*\?>/u, '');
  // Offsets in the wrapped text, less this, are offsets in the text.
  const shift = text.length - body.length - WRAPPER.length;
  let root: RawElement | null;
  try {
    // A wrapper element lets the text hold several top-level elements.
    root = parseDocument(`${WRAPPER}${body}</w>`, { includeOffsets: positioned }).root;
  } catch (err) {
    const where = positioned && err instanceof XmlError ? { text, offset: Math.min(text.length, Math.max(0, codePointToUtf16(`${WRAPPER}${body}`, err.pos) + shift)) } : undefined;
    const message = err instanceof Error ? err.message.split('\n')[0]! : String(err);
    // parse-xml's own line and column count from the wrapper; the position replaces them.
    fail(`malformed XML: ${where === undefined ? message : message.replace(/ \(line \d+, column \d+\)$/, '')}`, err, where);
  }
  if (root === null) fail('no root element');
  const state: ConvertState = { maxDepth: options.maxDepth ?? 256, maxNodes: options.maxNodes ?? 5_000_000, nodes: 0, text: positioned ? text : undefined, shift };
  const scope = new Map([
    ['', ''],
    ['xml', XML_NS],
  ]);
  const out: PlainElement[] = [];
  for (const c of root.children as readonly RawNode[]) {
    if (c instanceof RawElement) out.push(convert(c, scope, 1, state));
    else if (c instanceof RawText && c.text.trim() !== '') fail('text outside an element', undefined, place(c, state));
  }
  return out;
}

const WRAPPER = '<w>';

interface ConvertState {
  readonly maxDepth: number;
  readonly maxNodes: number;
  nodes: number;
  /** With positions: the text, and how far wrapped-text offsets are from text offsets. */
  readonly text: string | undefined;
  readonly shift: number;
}

function place(raw: RawNode, state: ConvertState): ErrorPlace | undefined {
  return state.text === undefined ? undefined : { text: state.text, offset: raw.start + state.shift };
}

function convert(raw: RawElement, parentScope: ReadonlyMap<string, string>, depth: number, state: ConvertState): PlainElement {
  const at = place(raw, state);
  if (depth > state.maxDepth) fail(`element nesting exceeds ${state.maxDepth}`, undefined, at);
  if (++state.nodes > state.maxNodes) fail(`the document has more than ${state.maxNodes} nodes`, undefined, at);

  const entries = Object.entries(raw.attributes);
  const declarations = new Map<string, string>();
  for (const [name, uri] of entries) {
    if (name !== 'xmlns' && !name.startsWith('xmlns:')) continue;
    const prefix = name === 'xmlns' ? '' : name.slice(6);
    if (prefix !== '' && (!NCNAME.test(prefix) || uri === '')) fail(`invalid namespace declaration ${name}="${uri}"`, undefined, at);
    if (prefix === 'xmlns' || uri === XMLNS_NS || (prefix === 'xml') !== (uri === XML_NS)) fail(`reserved namespace prefix or URI misused: ${name}="${uri}"`, undefined, at);
    declarations.set(prefix, uri);
  }
  const scope = declarations.size === 0 ? parentScope : new Map([...parentScope, ...declarations]);

  const q = splitName(raw.name, at);
  const ns = q.prefix === undefined ? (scope.get('') ?? '') : resolve(q.prefix, scope, raw.name, at);

  const attributes: XmlAttributeLike[] = [];
  const seen = new Set<string>();
  for (const [name, value] of entries) {
    if (name === 'xmlns' || name.startsWith('xmlns:')) continue;
    const a = splitName(name, at);
    const ans = a.prefix === undefined ? undefined : resolve(a.prefix, scope, name, at);
    const key = `${ans ?? ''} ${a.local}`;
    if (seen.has(key)) fail(`duplicate attribute ${name} on <${raw.name}>`, undefined, at);
    seen.add(key);
    attributes.push({ name: a.local, ns: ans, ...(a.prefix === undefined ? {} : { prefix: a.prefix }), value });
  }

  const children: XmlChild[] = [];
  let text = '';
  let hasElements = false;
  for (const c of raw.children as readonly RawNode[]) {
    if (c instanceof RawElement) {
      if (text !== '') children.push(text);
      text = '';
      hasElements = true;
      children.push(convert(c, scope, depth + 1, state));
    } else if (c instanceof RawText) {
      text += c.text;
    }
  }
  if (text !== '') children.push(text);
  if (hasElements) {
    for (let i = children.length - 1; i >= 0; i--) if (typeof children[i] === 'string' && (children[i] as string).trim() === '') children.splice(i, 1);
  }
  state.nodes += children.length;
  if (at === undefined) return { name: q.local, ns, prefix: q.prefix, attributes, children, declarations };
  return { name: q.local, ns, prefix: q.prefix, attributes, children, declarations, offset: at.offset };
}

function splitName(qname: string, at: ErrorPlace | undefined): { prefix: string | undefined; local: string } {
  const i = qname.indexOf(':');
  const prefix = i === -1 ? undefined : qname.slice(0, i);
  const local = i === -1 ? qname : qname.slice(i + 1);
  if (!NCNAME.test(local) || (prefix !== undefined && !NCNAME.test(prefix))) fail(`invalid name ${JSON.stringify(qname)}`, undefined, at);
  return { prefix, local };
}

function resolve(prefix: string, scope: ReadonlyMap<string, string>, qname: string, at: ErrorPlace | undefined): string {
  const uri = scope.get(prefix);
  if (uri === undefined || prefix === '') fail(`namespace prefix of ${JSON.stringify(qname)} is not declared`, undefined, at);
  return uri;
}

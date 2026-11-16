/**
 * YIN (RFC 7950 §13): the XML syntax of YANG, read into the same statement
 * tree as YANG text, and written from one.
 *
 * Each statement is an element in the YIN namespace (or, for an extension,
 * in its module's namespace). The argument is an attribute or a child
 * element, as the table in §13.1 says for core statements and the
 * extension's `argument` / `yin-element` say for extensions.
 *
 * An extension's definition is usually in another module, which a single
 * file can't see. Definitions in the same file are used; otherwise an
 * extension's argument is its one attribute, or else its first child
 * element when that element is in the extension's namespace, has no
 * attributes and holds only text (the `yin-element true` form).
 */

import { parseXml as parseDocument, XmlElement as RawElement, XmlError, XmlText as RawText } from '@rgrove/parse-xml';
import { YangSyntaxError } from '../errors.js';
import { checkModule, declaredVersion } from '../grammar/check.js';
import { LineIndex, type SourceLocation } from '../location.js';
import type { ParsedModule } from './module.js';
import { decodeText, MAX_DEPTH, type ParseOptions } from './parser.js';
import type { Statement } from './statement.js';

export const YIN_NAMESPACE = 'urn:ietf:params:xml:ns:yang:yin:1';

/** RFC 7950 §13.1, Table 1: the argument name of each core statement, and whether it is an element. Absent: no argument. */
export const YIN_ARGUMENTS: Readonly<Record<string, readonly [name: string, element: boolean] | null>> = {
  action: ['name', false],
  anydata: ['name', false],
  anyxml: ['name', false],
  argument: ['name', false],
  augment: ['target-node', false],
  base: ['name', false],
  'belongs-to': ['module', false],
  bit: ['name', false],
  case: ['name', false],
  choice: ['name', false],
  config: ['value', false],
  contact: ['text', true],
  container: ['name', false],
  default: ['value', false],
  description: ['text', true],
  deviate: ['value', false],
  deviation: ['target-node', false],
  enum: ['name', false],
  'error-app-tag': ['value', false],
  'error-message': ['value', true],
  extension: ['name', false],
  feature: ['name', false],
  'fraction-digits': ['value', false],
  grouping: ['name', false],
  identity: ['name', false],
  'if-feature': ['name', false],
  import: ['module', false],
  include: ['module', false],
  input: null,
  key: ['value', false],
  leaf: ['name', false],
  'leaf-list': ['name', false],
  length: ['value', false],
  list: ['name', false],
  mandatory: ['value', false],
  'max-elements': ['value', false],
  'min-elements': ['value', false],
  modifier: ['value', false],
  module: ['name', false],
  must: ['condition', false],
  namespace: ['uri', false],
  notification: ['name', false],
  'ordered-by': ['value', false],
  organization: ['text', true],
  output: null,
  path: ['value', false],
  pattern: ['value', false],
  position: ['value', false],
  prefix: ['value', false],
  presence: ['value', false],
  range: ['value', false],
  reference: ['text', true],
  refine: ['target-node', false],
  'require-instance': ['value', false],
  revision: ['date', false],
  'revision-date': ['date', false],
  rpc: ['name', false],
  status: ['value', false],
  submodule: ['name', false],
  type: ['name', false],
  typedef: ['name', false],
  unique: ['tag', false],
  units: ['name', false],
  uses: ['name', false],
  value: ['value', false],
  when: ['condition', false],
  'yang-version': ['value', false],
  'yin-element': ['value', false],
};

type Scope = ReadonlyMap<string, string>;

/** An extension's argument, from its definition. */
interface ExtensionArgument {
  readonly name: string | undefined;
  readonly element: boolean;
}

/**
 * Parses one YIN module or submodule and checks it against the YANG
 * grammar, giving the same result as {@link parseModule} gives for the
 * equivalent YANG text (locations aside).
 *
 * Throws {@link YangSyntaxError} when the text isn't well-formed XML or its
 * root isn't a YIN `module` or `submodule`.
 */
export function parseYin(input: string | Uint8Array, options: ParseOptions = {}): ParsedModule {
  const text = decodeText(input, options.source);
  const lines = new LineIndex(text, options.source);
  if (/<!DOCTYPE/i.test(text)) throw new YangSyntaxError('DOCTYPE declarations are not allowed in YIN', lines.locate(text.search(/<!DOCTYPE/i)));
  let doc;
  try {
    doc = parseDocument(text, { includeOffsets: true });
  } catch (err) {
    if (err instanceof XmlError) throw new YangSyntaxError(`malformed YIN: ${err.message.split('\n')[0]!}`, lines.locate(err.pos), { cause: err });
    throw err;
  }
  const root = doc.root;
  if (root === null) throw new YangSyntaxError('expected a YIN module or submodule, found no element', lines.locate(0));
  const reader = new YinReader(text, lines, MAX_DEPTH);
  const scope = reader.scope(root, new Map([['xml', 'http://www.w3.org/XML/1998/namespace']]));
  const { ns, local } = reader.name(root, scope);
  if (ns !== YIN_NAMESPACE || (local !== 'module' && local !== 'submodule')) {
    throw new YangSyntaxError(`expected a YIN module or submodule (namespace ${YIN_NAMESPACE}), found ${root.name}`, reader.at(root));
  }
  reader.collectDefinitions(root, scope);
  const statement = reader.statement(root, scope, 0);
  return { statement, yangVersion: declaredVersion(statement), diagnostics: [...reader.diagnostics, ...checkModule(statement, [], lines)] };
}

class YinReader {
  readonly diagnostics: ParsedModule['diagnostics'] = [];
  /** Extensions defined in this file, by namespace and name. */
  readonly #definitions = new Map<string, ExtensionArgument>();

  constructor(
    readonly text: string,
    readonly lines: LineIndex,
    readonly maxDepth: number,
  ) {}

  at(el: RawElement): SourceLocation {
    return this.lines.locate(el.start);
  }

  scope(el: RawElement, parent: Scope): Scope {
    let scope: Map<string, string> | undefined;
    for (const [name, value] of Object.entries(el.attributes)) {
      if (name === 'xmlns' || name.startsWith('xmlns:')) {
        scope ??= new Map(parent);
        scope.set(name === 'xmlns' ? '' : name.slice(6), value);
      }
    }
    return scope ?? parent;
  }

  name(el: RawElement, scope: Scope): { ns: string | undefined; prefix: string | undefined; local: string } {
    const colon = el.name.indexOf(':');
    const prefix = colon === -1 ? undefined : el.name.slice(0, colon);
    const local = colon === -1 ? el.name : el.name.slice(colon + 1);
    const ns = scope.get(prefix ?? '');
    if (prefix !== undefined && ns === undefined) throw new YangSyntaxError(`namespace prefix '${prefix}' is not declared`, this.at(el));
    return { ns: ns === '' ? undefined : ns, prefix, local };
  }

  /** The extensions this file defines, so their instances can be read exactly. */
  collectDefinitions(root: RawElement, scope: Scope): void {
    const ownPrefix = this.#ownPrefix(root, scope);
    const ns = ownPrefix === undefined ? undefined : scope.get(ownPrefix);
    if (ns === undefined) return;
    for (const c of root.children) {
      if (!(c instanceof RawElement) || c.name !== 'extension' && !c.name.endsWith(':extension')) continue;
      const name = c.attributes['name'];
      if (name === undefined) continue;
      const arg = c.children.find((a): a is RawElement => a instanceof RawElement && /(^|:)argument$/.test(a.name));
      const yinElement = arg?.children.find((y): y is RawElement => y instanceof RawElement && /(^|:)yin-element$/.test(y.name));
      this.#definitions.set(`${ns} ${name}`, { name: arg?.attributes['name'], element: yinElement?.attributes['value'] === 'true' });
    }
  }

  /** The module's own prefix: from `prefix`, or `belongs-to/prefix` in a submodule. */
  #ownPrefix(root: RawElement, scope: Scope): string | undefined {
    const find = (el: RawElement, local: string): RawElement | undefined =>
      el.children.find((c): c is RawElement => c instanceof RawElement && this.name(c, scope).local === local && this.name(c, scope).ns === YIN_NAMESPACE);
    const prefix = find(root, 'prefix') ?? (() => {
      const b = find(root, 'belongs-to');
      return b === undefined ? undefined : find(b, 'prefix');
    })();
    return prefix?.attributes['value'];
  }

  statement(el: RawElement, parentScope: Scope, depth: number): Statement {
    if (depth > this.maxDepth) throw new YangSyntaxError(`statements are nested more than ${this.maxDepth} deep`, this.at(el));
    const scope = this.scope(el, parentScope);
    const { ns, prefix, local } = this.name(el, scope);
    const location = this.at(el);
    let keyword: string;
    let yangPrefix: string | undefined;
    let arg: ExtensionArgument | null;
    if (ns === YIN_NAMESPACE) {
      keyword = local;
      const entry = YIN_ARGUMENTS[local];
      if (entry === undefined) {
        this.diagnostics.push({ severity: 'error', code: 'unknown-statement', message: `'${local}' is not a YANG statement`, location });
        arg = this.#guess(el, scope, ns);
      } else arg = entry === null ? null : { name: entry[0], element: entry[1] };
    } else {
      yangPrefix = prefix ?? [...scope].find(([p, u]) => p !== '' && u === ns)?.[0];
      if (yangPrefix === undefined) throw new YangSyntaxError(`element ${el.name} is neither a YIN statement nor in the namespace of an imported module`, location);
      keyword = `${yangPrefix}:${local}`;
      arg = this.#definitions.get(`${ns ?? ''} ${local}`) ?? this.#guess(el, scope, ns);
    }

    let argument: string | undefined;
    let argumentLocation: SourceLocation | undefined;
    let argumentElement: RawElement | undefined;
    if (arg !== null && arg.name !== undefined) {
      if (arg.element) {
        argumentElement = el.children.find((c): c is RawElement => {
          if (!(c instanceof RawElement)) return false;
          const n = this.name(c, this.scope(c, scope));
          return n.local === arg.name && n.ns === ns;
        });
        if (argumentElement !== undefined) {
          argument = textOf(argumentElement);
          argumentLocation = this.lines.locate(contentStart(this.text, argumentElement));
        }
      } else {
        const value = el.attributes[arg.name];
        if (value !== undefined) {
          argument = value;
          argumentLocation = this.lines.locate(attributeOffset(this.text, el, arg.name));
        }
      }
      if (argument === undefined) {
        this.diagnostics.push({ severity: 'error', code: 'missing-argument', message: `${keyword} needs its argument '${arg.name}'${arg.element ? ' as an element' : ''}`, location });
      }
    }

    const substatements: Statement[] = [];
    for (const c of el.children) {
      if (c === argumentElement) continue;
      if (c instanceof RawText) {
        if (c.text.trim() !== '') {
          this.diagnostics.push({ severity: 'error', code: 'unexpected-text', message: `text isn't allowed directly in ${keyword}`, location: this.lines.locate(c.start) });
        }
        continue;
      }
      if (c instanceof RawElement) substatements.push(this.statement(c, scope, depth + 1));
    }
    return {
      keyword,
      ...(yangPrefix === undefined ? {} : { prefix: yangPrefix }),
      ...(argument === undefined ? {} : { argument }),
      substatements,
      location,
      ...(argumentLocation === undefined ? {} : { argumentLocation }),
    };
  }

  /** The argument of an extension whose definition isn't in this file. */
  #guess(el: RawElement, scope: Scope, ns: string | undefined): ExtensionArgument | null {
    const attributes = Object.keys(el.attributes).filter((a) => a !== 'xmlns' && !a.startsWith('xmlns:') && !a.includes(':'));
    if (attributes.length > 0) return { name: attributes[0]!, element: false };
    const first = el.children.find((c) => c instanceof RawElement || (c instanceof RawText && c.text.trim() !== ''));
    if (first instanceof RawElement) {
      const s = this.scope(first, scope);
      const n = this.name(first, s);
      const plain = Object.keys(first.attributes).every((a) => a === 'xmlns' || a.startsWith('xmlns:'));
      if (n.ns === ns && plain && first.children.every((c) => c instanceof RawText)) return { name: n.local, element: true };
    }
    return null;
  }
}

function textOf(el: RawElement): string {
  return el.children.map((c) => (c instanceof RawText ? c.text : '')).join('');
}

/** Where an element's content starts: after its start tag. */
function contentStart(text: string, el: RawElement): number {
  const close = text.indexOf('>', el.start);
  return close === -1 ? el.start : close + 1;
}

/** Where an attribute's value starts in an element's start tag. */
function attributeOffset(text: string, el: RawElement, name: string): number {
  const tagEnd = text.indexOf('>', el.start);
  const tag = text.slice(el.start, tagEnd === -1 ? undefined : tagEnd);
  const m = new RegExp(`\\s${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*["']`).exec(tag);
  return m === null ? el.start : el.start + m.index + m[0].length;
}

// ---------------------------------------------------------------------------
// Writing

export interface YinWriteOptions {
  /**
   * Namespace URIs by prefix, for the `xmlns` declarations on the root
   * element: the module's own prefix and each imported module's. Every
   * extension's prefix needs one.
   */
  readonly namespaces: Readonly<Record<string, string>>;
  /** Extension arguments by `prefix:name`, from their definitions. Without one, an extension's argument is written as an attribute named `value`. */
  readonly extensions?: Readonly<Record<string, { readonly argument: string; readonly yinElement: boolean }>>;
}

/** Writes a statement tree as YIN text. */
export function writeYin(statement: Statement, options: YinWriteOptions): string {
  const declarations = [` xmlns="${YIN_NAMESPACE}"`, ...Object.entries(options.namespaces).map(([p, u]) => ` xmlns:${p}="${escapeXml(u, true)}"`)].join('');
  const out: string[] = ['<?xml version="1.0" encoding="UTF-8"?>\n'];
  const write = (s: Statement, indent: string, root: boolean): void => {
    let argName: string | undefined;
    let element = false;
    if (s.prefix === undefined) {
      const entry = YIN_ARGUMENTS[s.keyword];
      if (entry !== null && entry !== undefined) [argName, element] = entry;
      else if (entry === undefined && s.argument !== undefined) argName = 'value';
    } else if (s.argument !== undefined) {
      const ext = options.extensions?.[s.keyword];
      element = ext?.yinElement ?? false;
      // An argument element is in the extension's namespace (RFC 7950 §13.1.1).
      argName = ext === undefined ? 'value' : element ? `${s.prefix}:${ext.argument}` : ext.argument;
    }
    const attr = argName !== undefined && !element && s.argument !== undefined ? ` ${argName}="${escapeXml(s.argument, true)}"` : '';
    const open = `${indent}<${s.keyword}${root ? declarations : ''}${attr}`;
    const hasBody = s.substatements.length > 0 || (element && s.argument !== undefined);
    if (!hasBody) {
      out.push(`${open}/>\n`);
      return;
    }
    out.push(`${open}>\n`);
    if (element && s.argument !== undefined) out.push(`${indent}  <${argName!}>${escapeXml(s.argument, false)}</${argName!}>\n`);
    for (const c of s.substatements) write(c, `${indent}  `, false);
    out.push(`${indent}</${s.keyword}>\n`);
  };
  write(statement, '', true);
  return out.join('');
}

function escapeXml(s: string, attribute: boolean): string {
  let out = s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  if (attribute) out = out.replaceAll('"', '&quot;').replaceAll('\n', '&#10;').replaceAll('\t', '&#9;').replaceAll('\r', '&#13;');
  else out = out.replaceAll('\r', '&#13;');
  return out;
}

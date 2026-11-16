/**
 * {@link XmlElementLike} elements → XML text.
 *
 * Namespaces are written from what each element needs, not trusted from
 * its declarations alone: an element whose namespace isn't the default in
 * scope gets an `xmlns`, and a qualified attribute gets a prefix declared.
 * Declarations an element carries (such as prefixes used in identityref
 * values) are written as they are.
 */

import { isElement, type XmlChild, type XmlElementLike } from './element.js';
import { XML_NS } from './parse.js';

export interface XmlSerializeOptions {
  /**
   * Indentation for pretty printing: a number of spaces or a string. Elements
   * with text content are never re-indented, so values are kept exactly.
   * Default: no added whitespace.
   */
  readonly indent?: number | string;
}

export function serializeXml(nodes: XmlChild | readonly XmlChild[], options: XmlSerializeOptions = {}): string {
  const indent = typeof options.indent === 'number' ? ' '.repeat(options.indent) : (options.indent ?? '');
  const list: readonly XmlChild[] = Array.isArray(nodes) ? nodes : [nodes as XmlChild];
  const scope = new Map([
    ['', ''],
    ['xml', XML_NS],
  ]);
  const parts = list.map((n) => (isElement(n) ? element(n, scope, '', indent, '') : escapeText(n)));
  return parts.join(indent === '' ? '' : '\n');
}

function element(el: XmlElementLike, parentScope: ReadonlyMap<string, string>, parentNs: string, indent: string, depth: string): string {
  const ns = el.ns ?? parentNs;
  const declarations = new Map(el.declarations ?? []);
  const scope = new Map([...parentScope, ...declarations]);
  const declare = (prefix: string, uri: string): void => {
    declarations.set(prefix, uri);
    scope.set(prefix, uri);
  };

  let prefix: string | undefined;
  if (el.prefix !== undefined && el.prefix !== '' && scope.get(el.prefix) === ns) prefix = el.prefix;
  else if (scope.get('') !== ns) declare('', ns);

  let attrs = '';
  const attrPrefixes = new Set<string>();
  for (const a of el.attributes ?? []) {
    let name = a.name;
    if (a.ns !== undefined && a.ns !== '') {
      let p = a.prefix !== undefined && scope.get(a.prefix) === a.ns ? a.prefix : [...scope].find(([k, v]) => k !== '' && v === a.ns)?.[0];
      if (p === undefined) {
        const base = a.prefix ?? 'ns';
        p = base;
        for (let i = 1; scope.has(p); i++) p = `${base}${i}`;
        declare(p, a.ns);
      }
      attrPrefixes.add(p);
      name = `${p}:${a.name}`;
    }
    attrs += ` ${name}="${escapeAttribute(a.value)}"`;
  }

  const qname = prefix === undefined ? el.name : `${prefix}:${el.name}`;
  // Declarations for the element's own namespace and its attributes come
  // first, then the attributes, then other declarations (prefixes used in
  // values), in the order libyang writes them.
  let head = '';
  let tail = '';
  for (const [p, uri] of declarations) {
    if (parentScope.get(p) === uri && !(el.declarations?.has(p) ?? false)) continue;
    const decl = p === '' ? ` xmlns="${escapeAttribute(uri)}"` : ` xmlns:${p}="${escapeAttribute(uri)}"`;
    if (p === '' || attrPrefixes.has(p)) head += decl;
    else tail += decl;
  }
  const decls = head;
  attrs += tail;
  const children = el.children ?? [];
  if (children.length === 0) return `${depth}<${qname}${decls}${attrs}/>`;
  const pretty = indent !== '' && children.every((c) => isElement(c) || c.trim() === '');
  const inner = pretty
    ? children
        .filter(isElement)
        .map((c) => element(c, scope, ns, indent, depth + indent))
        .join('\n')
    : children.map((c) => (isElement(c) ? element(c, scope, ns, '', '') : escapeText(c))).join('');
  return pretty ? `${depth}<${qname}${decls}${attrs}>\n${inner}\n${depth}</${qname}>` : `${depth}<${qname}${decls}${attrs}>${inner}</${qname}>`;
}

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#13;');
}

function escapeAttribute(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/\t/g, '&#9;').replace(/\n/g, '&#10;').replace(/\r/g, '&#13;');
}

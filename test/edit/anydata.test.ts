import { beforeAll, describe, expect, it } from 'vitest';
import {
  AnyInstance,
  applyEdit,
  decodeJson,
  decodeXml,
  diffTrees,
  encodeJson,
  toXml,
  tryApplyEdit,
  type DataTree,
  type ErrorOption,
  type Schema,
  type XmlElementLike,
} from '../../src/index.js';
import { compile, mod } from '../compile/support.js';

// anydata and anyxml are opaque (RFC 7950 §7.10.3, §7.11.3): diffs compare
// what the content means, and edits replace it whole.
const m = mod(
  'm',
  `container top {
    anydata d;
    anyxml x;
    choice c {
      case one { anydata a1; }
      case two { leaf b2 { type string; } }
    }
  }`,
  '  import ietf-origin { prefix or; }',
);
const o = mod('o', 'leaf unused { type string; }');

const NC = 'urn:ietf:params:xml:ns:netconf:base:1.0';
const OR = 'urn:ietf:params:xml:ns:yang:ietf-origin';
let full: Schema;
let s: Schema;
beforeAll(async () => {
  full = await compile([m, o], { implement: ['m', 'o', 'ietf-origin'] });
  s = full.forDatastore('running');
});

function xml(body: string, schema: Schema = s): DataTree {
  return decodeXml(schema, `<top xmlns="urn:m" xmlns:nc="${NC}">${body}</top>`);
}
function json(top: object | string): DataTree {
  return decodeJson(s, typeof top === 'string' ? `{"m:top":${top}}` : { 'm:top': top });
}
function diff(a: DataTree, b: DataTree): string[] {
  return diffTrees(a, b).map((c) => `${c.operation} ${c.path}`);
}
function anyNode(t: DataTree, name: string): AnyInstance {
  const top = t.children[0]!;
  const n = 'children' in top ? top.children.find((c) => c.schema.name === name) : undefined;
  if (!(n instanceof AnyInstance)) throw new Error(`no ${name}`);
  return n;
}

const D = ['replace /m:top/d'];
const X = ['replace /m:top/x'];

describe('diffs of JSON content', () => {
  it('ignores member order, keeps array order', () => {
    expect(diff(json({ d: { a: '1', b: { c: [1, 2] } } }), json({ d: { b: { c: [1, 2] }, a: '1' } }))).toEqual([]);
    expect(diff(json({ d: { c: [1, 2] } }), json({ d: { c: [2, 1] } }))).toEqual(D);
  });

  it('compares numbers by value, and a number with a string as different', () => {
    expect(diff(json('{"d":{"n":1.0}}'), json('{"d":{"n":1}}'))).toEqual([]);
    expect(diff(json({ d: { n: 1 } }), json({ d: { n: '1' } }))).toEqual(D);
  });

  it('reports genuine changes', () => {
    expect(diff(json({ d: { a: '1' } }), json({ d: { a: '2' } }))).toEqual(D);
    expect(diff(json({ d: { a: '1' } }), json({ d: { a: '1', b: '2' } }))).toEqual(D);
    expect(diff(json({ d: { a: {} } }), json({ d: { a: '' } }))).toEqual(D);
    // A nested @ member is data.
    expect(diff(json({ d: { a: '1', '@a': { 'o:k': 'x' } } }), json({ d: { a: '1', '@a': { 'o:k': 'y' } } }))).toEqual(D);
    expect(diff(json({ d: { a: '1', '@a': { 'o:k': 'x' } } }), json({ d: { '@a': { 'o:k': 'x' }, a: '1' } }))).toEqual([]);
  });
});

describe('diffs of XML content', () => {
  it('ignores whitespace between elements', () => {
    expect(diff(xml('<d>\n  <a>1</a>\n  <b><c>2</c></b>\n</d>'), xml('<d><a>1</a><b><c>2</c></b></d>'))).toEqual([]);
    // Already-parsed elements can carry the whitespace and split text the parser drops or joins.
    const parsed = (children: XmlElementLike['children']): DataTree =>
      decodeXml(s, { name: 'top', ns: 'urn:m', children: [{ name: 'd', ns: 'urn:m', children }] });
    const plain = parsed([{ name: 'a', children: ['1'] }]);
    expect(diff(plain, parsed(['\n  ', { name: 'a', children: ['1'] }, '\n']))).toEqual([]);
    expect(diff(plain, parsed([{ name: 'a', children: ['', '1'] }]))).toEqual([]);
    expect(diff(plain, parsed([{ name: 'a', children: [' 1'] }]))).toEqual(D);
    // In mixed content, whitespace between elements is text.
    const mixed = (children: XmlElementLike['children']): DataTree =>
      decodeXml(s, { name: 'top', ns: 'urn:m', children: [{ name: 'x', ns: 'urn:m', children: [{ name: 'p', children }] }] });
    const words = mixed(['say ', { name: 'b', children: ['x'] }, ' ', { name: 'i', children: ['y'] }]);
    expect(diff(words, mixed(['say ', { name: 'b', children: ['x'] }, { name: 'i', children: ['y'] }]))).toEqual(X);
    expect(diff(words, mixed(['say', ' ', { name: 'b', children: ['x'] }, ' ', { name: 'i', children: ['y'] }]))).toEqual([]);
  });

  it('ignores prefixes, attribute order, namespace declarations and the empty-element form', () => {
    expect(diff(xml('<d><p:a xmlns:p="urn:o">1</p:a></d>'), xml('<d><a xmlns="urn:o">1</a></d>'))).toEqual([]);
    expect(diff(xml('<d xmlns:p="urn:z"><a p:k="1" j="2"/></d>'), xml('<d><a j="2" xmlns:q="urn:z" q:k="1"/></d>'))).toEqual([]);
    expect(diff(xml('<d><a/></d>'), xml('<d><a></a></d>'))).toEqual([]);
  });

  it('ignores the order of differently named siblings in anydata, but not in anyxml', () => {
    expect(diff(xml('<d><a>1</a><b>2</b></d>'), xml('<d><b>2</b><a>1</a></d>'))).toEqual([]);
    expect(diff(xml('<d><e>1</e><e>2</e></d>'), xml('<d><e>2</e><e>1</e></d>'))).toEqual(D);
    expect(diff(xml('<x><a>1</a><b>2</b></x>'), xml('<x><b>2</b><a>1</a></x>'))).toEqual(X);
  });

  it('compares text exactly', () => {
    expect(diff(xml('<d><a>1.0</a></d>'), xml('<d><a>1</a></d>'))).toEqual(D);
    // Same namespace, different prefix in a value: without a schema, text is text.
    expect(diff(xml('<d xmlns:a="urn:o" xmlns:b="urn:o"><v>a:x</v></d>'), xml('<d xmlns:a="urn:o" xmlns:b="urn:o"><v>b:x</v></d>'))).toEqual(D);
  });

  it('reports genuine changes', () => {
    expect(diff(xml('<d><a>1</a></d>'), xml('<d><a>1</a><b/></d>'))).toEqual(D);
    expect(diff(xml('<d><a k="1"/></d>'), xml('<d><a k="2"/></d>'))).toEqual(D);
    expect(diff(xml('<d><a k="1"/></d>'), xml('<d><a/></d>'))).toEqual(D);
    expect(diff(xml('<d><a xmlns="urn:o">1</a></d>'), xml('<d><a xmlns="urn:p">1</a></d>'))).toEqual(D);
    expect(diff(xml('<x>hello</x>'), xml('<x>hello </x>'))).toEqual(X);
  });
});

describe('diffs across encodings', () => {
  it('compares XML with JSON written as XML', () => {
    expect(diff(xml('<d><a>1</a><o:f xmlns:o="urn:o">x</o:f><g><h>true</h></g></d>'), json({ d: { g: { h: true }, 'o:f': 'x', a: 1 } }))).toEqual([]);
    expect(diff(json({ d: { e: [1, 2], z: [null] } }), xml('<d><e>1</e><e>2</e><z/></d>'))).toEqual([]);
    expect(diff(json({ x: 'hello' }), xml('<x>hello</x>'))).toEqual([]);
  });

  it('reports genuine changes', () => {
    expect(diff(xml('<d><a>1</a></d>'), json({ d: { a: 2 } }))).toEqual(D);
    expect(diff(xml('<d><e>1</e><e>2</e></d>'), json({ d: { e: [2, 1] } }))).toEqual(D);
    expect(diff(xml('<d><a k="1">1</a></d>'), json({ d: { a: 1 } }))).toEqual(D);
  });

  it('counts content as different where the conversion is not faithful', () => {
    // A module the schema doesn't know.
    expect(diff(xml('<d><f xmlns="urn:zz">x</f></d>'), json({ d: { 'zz:f': 'x' } }))).toEqual(D);
    // Metadata.
    expect(diff(xml('<d><a>1</a></d>'), json({ d: { a: '1', '@a': { 'o:k': 'x' } } }))).toEqual(D);
    // Arrays that aren't a member's value.
    expect(diff(xml('<x>12</x>'), json({ x: [1, 2] }))).toEqual(X);
    expect(diff(xml('<d><e>1</e><e>2</e></d>'), json({ d: { e: [[1], [2]] } }))).toEqual(D);
  });
});

describe('edits', () => {
  const OPTIONS: ErrorOption[] = ['rollback-on-error', 'stop-on-error', 'continue-on-error'];
  const edit = (body: string, schema: Schema = s): DataTree =>
    decodeXml(schema, `<top xmlns="urn:m" xmlns:nc="${NC}" xmlns:or="${OR}">${body}</top>`, { edit: true });

  it('keeps edit attributes inside XML content as data', () => {
    const target = xml('<d><a>1</a><b>2</b></d>');
    const change = edit('<d nc:operation="merge"><a nc:operation="delete">1</a><c nc:operation="create">3</c></d>');
    const expected = xml(`<d><a nc:operation="delete">1</a><c nc:operation="create">3</c></d>`);
    expect(diff(applyEdit(target, change), expected)).toEqual([]);
    for (const errorOption of OPTIONS) {
      const r = tryApplyEdit(target, change, { errorOption });
      expect(r.errors).toEqual([]);
      expect(diff(r.tree, expected)).toEqual([]);
    }
    expect(toXml(applyEdit(target, change))).toContain(`nc:operation="delete"`);
  });

  it('keeps edit metadata inside JSON content as data', () => {
    const target = json({ d: { a: '1' } });
    const change = decodeJson(s, { 'm:top': { d: { a: '2', '@a': { 'ietf-netconf:operation': 'delete' } } } }, { edit: true });
    const content = { a: '2', '@a': { 'ietf-netconf:operation': 'delete' } };
    expect(encodeJson(applyEdit(target, change))).toEqual({ 'm:top': { d: content } });
    for (const errorOption of OPTIONS) {
      const r = tryApplyEdit(target, change, { errorOption });
      expect(r.errors).toEqual([]);
      expect(encodeJson(r.tree)).toEqual({ 'm:top': { d: content } });
    }
  });

  it('replaces content whole', () => {
    const target = xml('<d><a>1</a><b>2</b></d>');
    for (const op of ['merge', 'replace']) {
      expect(diff(applyEdit(target, edit(`<d nc:operation="${op}"><c>3</c></d>`)), xml('<d><c>3</c></d>'))).toEqual([]);
    }
  });

  it('leaves content that means the same as it was', () => {
    const target = json({ d: { a: '1', b: '2' } });
    for (const op of ['merge', 'replace']) {
      const result = applyEdit(target, edit(`<d nc:operation="${op}">\n  <b>2</b>\n  <a>1</a>\n</d>`));
      expect(diff(target, result)).toEqual([]);
      expect(anyNode(result, 'd').content).toBe(anyNode(target, 'd').content);
    }
    // Content that differs is replaced, in the edit's encoding.
    const changed = applyEdit(target, edit('<d><a>1</a><b>3</b></d>'));
    expect(diff(target, changed)).toEqual(D);
    expect(anyNode(changed, 'd').content.format).toBe('xml');
  });

  it('still counts content that means the same as written', () => {
    const target = xml('<a1><k>1</k></a1>');
    // The edit names case one and case two of choice c, whether or not a1 changes.
    for (const errorOption of OPTIONS) {
      const r = tryApplyEdit(target, edit('<a1><k>1</k></a1><b2>v</b2>'), { errorOption });
      expect(r.errors.map((e) => e.code)).toEqual(['multiple-cases']);
    }
    expect(diff(target, applyEdit(target, edit('<b2>v</b2>')))).toEqual(['create /m:top/b2', 'delete /m:top/a1']);
  });

  it('applies the edit annotations of content that means the same', () => {
    const op = full.forDatastore('operational');
    const target = decodeXml(op, `<top xmlns="urn:m" xmlns:or="${OR}" or:origin="or:intended"><d><a>1</a></d></top>`);
    const result = applyEdit(target, edit('<d or:origin="or:learned"><a>1</a></d>', op));
    expect(diffTrees(target, result).map((c) => `${c.operation} ${c.path}`)).toEqual(['origin /m:top/d']);
  });
});

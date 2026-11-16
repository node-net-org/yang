/**
 * Values of type yang:xpath1.0 and typedefs derived from it, such as NACM's
 * node-instance-identifier (RFC 6991 §3, RFC 8341 §3.5.2): checked as XPath,
 * held with module names as prefixes, and written with namespace prefixes in XML.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { decodeJson, decodeXml, encodeJson, jsonToXml, toXml, xmlToJson, YangDataError, type Schema } from '../../src/index.js';
import { compile, mod } from '../compile/support.js';

const XP = mod(
  'xp',
  `
  typedef my-path { type nacm:node-instance-identifier { length "1..40"; } }
  typedef xpath1.0 { type string; }
  container top {
    leaf expr { type yang:xpath1.0; }
    leaf mine { type my-path; }
    leaf either { type union { type uint8; type yang:xpath1.0; } }
    leaf fake { type xpath1.0; }
    leaf-list exprs { type yang:xpath1.0; }
    list item { key name; leaf name { type string; } }
  }`,
  '  import ietf-yang-types { prefix yang; }\n  import ietf-netconf-acm { prefix nacm; }',
);
const XQ = mod('xq', '  augment "/xp:top/xp:item" { container extra { leaf on { type boolean; } leaf where { type t:xpath1.0; } } }', '  import xp { prefix xp; }\n  import ietf-yang-types { prefix t; }');

let schema: Schema;
beforeAll(async () => {
  schema = await compile([XP, XQ], { implement: ['xp', 'xq', 'ietf-netconf-acm'] });
  expect(schema.errors).toEqual([]);
});

const NS = 'xmlns="urn:xp" xmlns:a="urn:xp" xmlns:b="urn:xq"';
const xml = (leaf: string, text: string, ns = NS): string => `<top ${ns}><${leaf}>${text}</${leaf}></top>`;
const value = (tree: ReturnType<typeof decodeJson>, leaf: string): unknown => (encodeJson(tree) as { 'xp:top': Record<string, unknown> })['xp:top'][leaf];

/** The messages of the issues decoding throws, or [] if it doesn't. */
function problems(decode: () => unknown): string[] {
  try {
    decode();
    return [];
  } catch (e) {
    if (!(e instanceof YangDataError)) throw e;
    return e.issues.map((i) => `${i.code} ${i.path}: ${i.message}`);
  }
}

describe('reading yang:xpath1.0 values', () => {
  it('holds an XML value with module names, qualified where the module changes', () => {
    const tree = decodeXml(schema, xml('expr', "/a:top/a:item[a:name='x']/b:extra/b:on"));
    expect(value(tree, 'expr')).toBe("/xp:top/item[name='x']/xq:extra/on");
  });

  it('keeps the rest of the expression as written', () => {
    const tree = decodeXml(schema, xml('expr', "count( //a:item [ a:name != 'a:b' ] ) &gt; 1 and /a:top/*"));
    expect(value(tree, 'expr')).toBe("count( //xp:item [ name != 'a:b' ] ) > 1 and /xp:top/*");
  });

  it('takes an unprefixed XML name to be in the previous step’s module', () => {
    expect(value(decodeXml(schema, xml('expr', '/a:top/item')), 'expr')).toBe('/xp:top/item');
  });

  it('reads JSON values with module names, unprefixed names inheriting', () => {
    const tree = decodeJson(schema, { 'xp:top': { expr: '/xp:top/xp:item/xq:extra', exprs: ['/xp:top', 'xp:top/item'] } });
    expect(value(tree, 'expr')).toBe('/xp:top/item/xq:extra');
    expect(value(tree, 'exprs')).toEqual(['/xp:top', 'xp:top/item']);
  });

  it('allows variables, and doesn’t look names up in the schema', () => {
    expect(value(decodeJson(schema, { 'xp:top': { expr: '/xp:top/nosuch[name=$USER]' } }), 'expr')).toBe('/xp:top/nosuch[name=$USER]');
  });

  it('reports invalid expressions as invalid-value, with why', () => {
    const json = (expr: string): string[] => problems(() => decodeJson(schema, { 'xp:top': { expr } }));
    expect(json('/xp:top[')).toEqual([expect.stringMatching(/^invalid-value \/xp:top\/expr: invalid XPath: /)]);
    expect(json('/nosuch:top')).toEqual(["invalid-value /xp:top/expr: invalid XPath: 'nosuch' in '/nosuch:top' is not a known module"]);
    expect(json('xp:frob(1)')).toEqual([expect.stringContaining('xp:frob() in "xp:frob(1)" is not an XPath or YANG function')]);
    expect(json('count()')).toEqual([expect.stringContaining('count() takes 1 argument, not 0')]);
    expect(problems(() => decodeXml(schema, xml('expr', '/zz:top')))).toEqual(["invalid-value /xp:top/expr: invalid XPath: prefix 'zz' in '/zz:top' is not a namespace prefix of a known module"]);
    // Bound, but to a namespace no module has.
    expect(problems(() => decodeXml(schema, xml('expr', '/u:top', `${NS} xmlns:u="urn:unknown"`)))).toEqual([expect.stringContaining("prefix 'u'")]);
  });

  it('checks typedefs derived from it, keeping their restrictions', () => {
    expect(value(decodeJson(schema, { 'xp:top': { mine: '/xp:top/item' } }), 'mine')).toBe('/xp:top/item');
    expect(problems(() => decodeJson(schema, { 'xp:top': { mine: '/xp:top[' } }))).toHaveLength(1);
    expect(problems(() => decodeJson(schema, { 'xp:top': { mine: `/xp:top/item[name='${'x'.repeat(40)}']` } }))).toEqual([expect.stringContaining('length')]);
  });

  it('checks it as a union member', () => {
    expect(value(decodeXml(schema, xml('either', '5')), 'either')).toBe(5);
    expect(value(decodeXml(schema, xml('either', '/a:top')), 'either')).toBe('/xp:top');
    expect(problems(() => decodeXml(schema, xml('either', '/zz:top')))).toEqual([expect.stringContaining("matches none of the union's member types")]);
  });

  it('recognises the typedef whatever prefix a module imports it with', () => {
    expect(problems(() => decodeJson(schema, { 'xp:top': { item: [{ name: 'i', 'xq:extra': { where: '/nosuch:x' } }] } }))).toEqual([expect.stringContaining("'nosuch' in '/nosuch:x' is not a known module")]);
  });

  it('recognises the typedef itself, not its name', () => {
    expect(value(decodeXml(schema, xml('fake', '/zz:top[')), 'fake')).toBe('/zz:top[');
  });
});

describe('writing yang:xpath1.0 values', () => {
  it('writes XML with namespace prefixes declared on the element', () => {
    const tree = decodeJson(schema, { 'xp:top': { expr: "/xp:top/item[name='x']/xq:extra/on" } });
    expect(toXml(tree)).toBe('<top xmlns="urn:xp"><expr xmlns:xp="urn:xp" xmlns:xq="urn:xq">/xp:top/xp:item[xp:name=\'x\']/xq:extra/xq:on</expr></top>');
  });

  it('leaves unprefixed names with nothing to inherit, and *, unprefixed', () => {
    const tree = decodeJson(schema, { 'xp:top': { expr: 'name(*) = "a" or /xp:top/*' } });
    expect(toXml(tree)).toContain('>name(*) = "a" or /xp:top/*<');
  });

  it('round-trips XML → JSON → XML and JSON → XML → JSON', () => {
    const x = xml('expr', "/a:top/a:item[a:name='x']/b:extra[b:on='true']");
    const json = xmlToJson(schema, x);
    expect(json).toEqual({ 'xp:top': { expr: "/xp:top/item[name='x']/xq:extra[on='true']" } });
    expect(xmlToJson(schema, jsonToXml(schema, json))).toEqual(json);
    expect(toXml(decodeXml(schema, jsonToXml(schema, json)))).toBe(toXml(decodeXml(schema, x)));
    const j = { 'xp:top': { expr: '/xp:top/item/xq:extra/on', mine: '//xq:extra', exprs: ['/xp:top', '$USER'] } };
    expect(xmlToJson(schema, jsonToXml(schema, j))).toEqual(j);
  });
});

describe('NACM rule paths', () => {
  const rules = (path: string): object => ({ 'ietf-netconf-acm:nacm': { 'rule-list': [{ name: 'r', rule: [{ name: 'a', path, action: 'permit' }] }] } });

  it('accepts and converts a valid path in either encoding', () => {
    const json = rules('/xp:top/item[name=$USER]/xq:extra');
    const x = jsonToXml(schema, json);
    expect(x).toContain('<path xmlns:xp="urn:xp" xmlns:xq="urn:xq">/xp:top/xp:item[xp:name=$USER]/xq:extra</path>');
    expect(xmlToJson(schema, x)).toEqual(json);
  });

  it('rejects an invalid path in JSON and in XML', () => {
    expect(problems(() => decodeJson(schema, rules('/nosuch:top')))).toEqual([expect.stringMatching(/^invalid-value \/ietf-netconf-acm:nacm\/rule-list\[name='r'\]\/rule\[name='a'\]\/path: invalid XPath: /)]);
    const x = `<nacm xmlns="urn:ietf:params:xml:ns:yang:ietf-netconf-acm"><rule-list><name>r</name><rule><name>a</name><path>/if:interfaces</path><action>permit</action></rule></rule-list></nacm>`;
    expect(problems(() => decodeXml(schema, x))).toEqual([expect.stringContaining("prefix 'if' in '/if:interfaces' is not a namespace prefix of a known module")]);
  });
});

/**
 * Source positions on data issues (the decoders' `positions` option): where
 * in the XML or JSON text each problem is, from decoding and from
 * validation.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { DataTree, decodeJson, decodeXml, formatLocation, LeafInstance, parseXml, toJson, toXml, validate, YangDataError, type DataIssue, type DecodeOptions, type LeafNode, type Schema } from '../../src/index.js';
import { compile, mod } from '../compile/support.js';

const BODY = `container c {
  list item {
    key name;
    unique code;
    max-elements 3;
    must "code != 99" { error-message "code 99 is reserved"; }
    leaf name { type string; }
    leaf code { type uint8; }
    leaf ref { type leafref { path "../../item/name"; } }
    leaf kind { type enumeration { enum a; enum b; } }
    leaf extra { when "../kind = 'b'"; type string; }
  }
  leaf-list tag { type string; }
  leaf m { type string; mandatory true; }
  choice ch {
    mandatory true;
    leaf x { type string; }
    leaf y { type string; }
  }
  list need { key id; min-elements 2; leaf id { type string; } }
  container sub { leaf d { type string; default "dflt"; must ". = 'dflt' or . = 'ok'"; } }
  container dc { presence "p"; leaf e { type string; default "z"; must ". != 'z'"; } }
}
leaf top { type string; mandatory true; }`;

let schema: Schema;
beforeAll(async () => {
  schema = await compile([mod('pos', BODY)]);
});

/** The issues a decode throws, or none. */
function thrown(f: () => unknown): DataIssue[] {
  try {
    f();
    return [];
  } catch (e) {
    if (!(e instanceof YangDataError)) throw e;
    return [...e.issues];
  }
}

/** `code path line:column` for each issue, `-` where there is no position. */
function placed(issues: readonly DataIssue[]): string[] {
  return issues.map((i) => `${i.code} ${i.path} ${i.position === undefined ? '-' : `${i.position.line}:${i.position.column}`}`);
}

/** `line:column` of the first occurrence of `needle` on 1-based line `line` of `text`. */
function at(text: string, line: number, needle: string): string {
  const l = text.split('\n')[line - 1]!;
  const i = l.indexOf(needle);
  if (i === -1) throw new Error(`'${needle}' is not on line ${line}: ${l}`);
  return `${line}:${i + 1}`;
}

const withPositions: DecodeOptions = { positions: true };

describe('positions of JSON issues', () => {
  const lines = [
    '{', // 1
    '  "pos:c": {', // 2
    '    "item": [', // 3
    '      {"name": "a", "code": 1, "kind": "a", "extra": "e"},', // 4
    '      {"name": "b", "code": 1, "ref": "zz"},', // 5
    '      {"name": "c", "code": 99}', // 6
    '    ],', // 7
    '    "tag": ["t", "t"],', // 8
    '    "x": "1", "y": "2",', // 9
    '    "need": [{"id": "n"}],', // 10
    '    "sub": {"d": "bad"}', // 11
    '  },', // 12
    '  "pos:top": "here"', // 13
    '}', // 14
  ];
  const text = lines.join('\n');

  it('places every validation issue in a multi-line document at a known line', () => {
    const tree = decodeJson(schema, text, withPositions);
    expect(placed(validate(tree))).toEqual(
      expect.arrayContaining([
        `when-false /pos:c/item[name='a']/extra ${at(text, 4, '"extra"')}`,
        `not-unique /pos:c/item[name='b'] 5:7`,
        `missing-instance /pos:c/item[name='b']/ref ${at(text, 5, '"ref"')}`,
        `must-violation /pos:c/item[name='c'] 6:7`,
        `duplicate-entry /pos:c/tag[.='t'] ${at(text, 8, '"t"]')}`,
        // Missing data is placed at the parent it belongs in.
        `missing-mandatory /pos:c/m 2:3`,
        `multiple-cases /pos:c 2:3`,
        `too-few-elements /pos:c/need 2:3`,
        `must-violation /pos:c/sub/d ${at(text, 11, '"d"')}`,
      ]),
    );
    expect(placed(validate(tree))).toHaveLength(9);
  });

  it('gives the literal line and column of a member name, counted from 1', () => {
    const tree = decodeJson(schema, text, withPositions);
    const issue = validate(tree).find((i) => i.code === 'missing-instance')!;
    expect(issue.position).toEqual({ line: 5, column: 32, offset: text.indexOf('"ref"') });
    expect(formatLocation(issue.position!)).toBe('<input>:5:32');
  });

  it('places decoding issues, including on nodes that were rejected', () => {
    const bad = [
      '{', // 1
      '  "pos:c": {', // 2
      '    "item": [', // 3
      '      {"name": "a", "code": 300},', // 4
      '      {"code": 2},', // 5
      '      7', // 6
      '    ],', // 7
      '    "tag": ["t", 5],', // 8
      '    "bogus": 1,', // 9
      '    "sub": [],', // 10
      '    "@m": {"pos:x": 1}', // 11
      '  },', // 12
      '  "nomod": 1', // 13
      '}', // 14
    ].join('\n');
    expect(placed(thrown(() => decodeJson(schema, bad, withPositions)))).toEqual([
      `invalid-value /pos:c/item[name='a']/code ${at(bad, 4, '"code"')}`,
      `missing-key /pos:c/item 5:7`,
      `unexpected-content /pos:c/item ${at(bad, 6, '7')}`,
      `invalid-value /pos:c/tag[.="5"] ${at(bad, 8, '5')}`,
      `unknown-node /pos:c/bogus ${at(bad, 9, '"bogus"')}`,
      `unexpected-content /pos:c/sub ${at(bad, 10, '"sub"')}`,
      `unknown-node /pos:c/m ${at(bad, 11, '"@m"')}`,
      `unknown-node /nomod ${at(bad, 13, '"nomod"')}`,
    ]);
  });

  it('places malformed JSON at the syntax error', () => {
    expect(placed(thrown(() => decodeJson(schema, '{\n  "pos:c": {\n    "m": "x",\n  }\n}', withPositions)))).toEqual(['json-syntax / 4:3']);
    expect(placed(thrown(() => decodeJson(schema, '{\n  "pos:top": "ab', withPositions)))).toEqual(['json-syntax / 2:14']);
    expect(placed(thrown(() => decodeJson(schema, '{"pos:top": "a"} x', withPositions)))).toEqual(['json-syntax / 1:18']);
  });

  it('counts columns in UTF-16 code units, past characters outside the BMP', () => {
    const t = '{"pos:c": {"m": "😀😀", "bogus": 1}}';
    const [issue] = thrown(() => decodeJson(schema, t, withPositions));
    expect(issue!.position).toEqual({ line: 1, column: t.indexOf('"bogus"') + 1, offset: t.indexOf('"bogus"') });
  });

  it('counts CRLF as one line ending', () => {
    const t = '{\r\n  "pos:c": {\r\n    "bogus": 1\r\n  }\r\n}';
    expect(placed(thrown(() => decodeJson(schema, t, withPositions)))).toEqual(['unknown-node /pos:c/bogus 3:5']);
  });

  it('gives the same tree and issues as decoding without positions', () => {
    const tree = decodeJson(schema, text, withPositions);
    const plain = decodeJson(schema, text);
    expect(toJson(tree)).toBe(toJson(plain));
    const strip = (issues: readonly DataIssue[]): DataIssue[] => issues.map(({ position: _p, ...rest }) => rest);
    expect(strip(validate(tree))).toEqual(validate(plain));
    const bad = '{"pos:c": {"item": [{"name": "a", "code": 300}], "bogus": 1}, "@": {}}';
    expect(strip(thrown(() => decodeJson(schema, bad, withPositions)))).toEqual(thrown(() => decodeJson(schema, bad)));
  });
});

describe('positions of XML issues', () => {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>', // 1
    '<c xmlns="urn:pos">', // 2
    '  <item><name>a</name><code>1</code><kind>a</kind><extra>e</extra></item>', // 3
    '  <item><name>b</name><code>1</code><ref>zz</ref></item>', // 4
    '  <item><name>c</name><code>99</code></item>', // 5
    '  <tag>t</tag>', // 6
    '  <tag>t</tag>', // 7
    '  <x>1</x><y>2</y>', // 8
    '  <need><id>n</id></need>', // 9
    '  <sub><d>bad</d></sub>', // 10
    '</c>', // 11
    '<top xmlns="urn:pos">here</top>', // 12
  ];
  const text = lines.join('\n');

  it('places every validation issue in a multi-line document at a known line', () => {
    const tree = decodeXml(schema, text, withPositions);
    const issues = placed(validate(tree));
    expect(issues).toEqual(
      expect.arrayContaining([
        `when-false /pos:c/item[name='a']/extra ${at(text, 3, '<extra>')}`,
        `not-unique /pos:c/item[name='b'] 4:3`,
        `missing-instance /pos:c/item[name='b']/ref ${at(text, 4, '<ref>')}`,
        `must-violation /pos:c/item[name='c'] 5:3`,
        `duplicate-entry /pos:c/tag[.='t'] 7:3`,
        `missing-mandatory /pos:c/m 2:1`,
        `multiple-cases /pos:c 2:1`,
        `too-few-elements /pos:c/need 2:1`,
        `must-violation /pos:c/sub/d ${at(text, 10, '<d>')}`,
      ]),
    );
    expect(issues).toHaveLength(9);
  });

  it('places decoding issues, including on rejected elements', () => {
    const bad = [
      '<c xmlns="urn:pos">', // 1
      '  <item><name>a</name><code>300</code></item>', // 2
      '  <item><code>2</code></item>', // 3
      '  <m>x</m>', // 4
      '  <m>y</m>', // 5
      '  <bogus/>', // 6
      '  <x xmlns="urn:other">1</x>', // 7
      '  <tag><b/></tag>', // 8
      '</c>', // 9
    ].join('\n');
    expect(placed(thrown(() => decodeXml(schema, bad, withPositions)))).toEqual([
      `invalid-value /pos:c/item[name='a']/code ${at(bad, 2, '<code>')}`,
      `missing-key /pos:c/item 3:3`,
      `duplicate-node /pos:c/m 5:3`,
      `unknown-node /pos:c/bogus 6:3`,
      `wrong-namespace /pos:c/x 7:3`,
      `unexpected-content /pos:c/tag ${at(bad, 8, '<b/>')}`,
    ]);
  });

  it('measures from the start of the text, before any XML declaration and byte order mark', () => {
    const t = '﻿<?xml version="1.0"?>\n\n  <bogus xmlns="urn:pos"/>';
    expect(thrown(() => decodeXml(schema, t, withPositions))[0]!.position).toEqual({ line: 3, column: 3, offset: t.indexOf('<bogus') });
  });

  it('counts columns in UTF-16 code units, past characters outside the BMP', () => {
    const t = '<c xmlns="urn:pos"><m>😀😀</m><bogus/></c>';
    expect(thrown(() => decodeXml(schema, t, withPositions))[0]!.position).toEqual({ line: 1, column: t.indexOf('<bogus') + 1, offset: t.indexOf('<bogus') });
  });

  it('places malformed XML at the syntax error, without the parser’s own line and column', () => {
    const [issue] = thrown(() => decodeXml(schema, '<c xmlns="urn:pos">😀\n  <m>x</c>', withPositions));
    expect(issue!.code).toBe('xml-syntax');
    expect(issue!.position).toMatchObject({ line: 2, column: 7 });
    expect(issue!.message).not.toMatch(/line \d+, column/);
    expect(placed(thrown(() => decodeXml(schema, '<c xmlns="urn:pos">\n  <p:m>x</p:m>\n</c>', withPositions)))).toEqual(['xml-syntax / 2:3']);
    expect(placed(thrown(() => decodeXml(schema, '<a/>\n<!DOCTYPE x>', withPositions)))).toEqual(['xml-syntax / 2:1']);
  });

  it('gives the same tree and issues as decoding without positions', () => {
    const tree = decodeXml(schema, text, withPositions);
    const plain = decodeXml(schema, text);
    expect(toXml(tree)).toBe(toXml(plain));
    const strip = (issues: readonly DataIssue[]): DataIssue[] => issues.map(({ position: _p, ...rest }) => rest);
    expect(strip(validate(tree))).toEqual(validate(plain));
  });
});

describe('when there are no positions', () => {
  const json = '{\n  "pos:c": {"bogus": 1}\n}';
  const xml = '<c xmlns="urn:pos">\n  <bogus/>\n</c>';

  it('records none without the option', () => {
    expect(thrown(() => decodeJson(schema, json))[0]!.position).toBeUndefined();
    expect(thrown(() => decodeXml(schema, xml))[0]!.position).toBeUndefined();
    expect(thrown(() => decodeJson(schema, '{,'))[0]!.position).toBeUndefined();
    expect(thrown(() => decodeXml(schema, '<a>'))[0]!.position).toBeUndefined();
    const tree = decodeJson(schema, '{"pos:c": {"m": "x"}}');
    expect(validate(tree).every((i) => i.position === undefined)).toBe(true);
    expect(tree.position(tree.children[0]!)).toBeUndefined();
  });

  it('has none for already-parsed input', () => {
    expect(thrown(() => decodeJson(schema, JSON.parse(json), withPositions))[0]!.position).toBeUndefined();
    expect(thrown(() => decodeXml(schema, parseXml(xml), withPositions))[0]!.position).toBeUndefined();
  });

  it('has none for a tree built in code, nor for nodes added to a decoded tree', () => {
    const tree = decodeJson(schema, '{\n  "pos:c": {"m": "x", "x": "1", "need": [{"id": "1"}, {"id": "2"}]}\n}', withPositions);
    const c = tree.children[0]!;
    expect(tree.position(c)).toMatchObject({ line: 2, column: 3 });
    const top = schema.find('/pos:top') as LeafNode;
    const added = tree.append(new LeafInstance(top, { type: top.type, value: 'v' }));
    expect(tree.position(added)).toBeUndefined();
    expect(validate(tree)).toEqual([]);
    const built = new DataTree(schema);
    built.append(new LeafInstance(top, { type: top.type, value: 'v' }));
    const issues = validate(built);
    expect(issues.map((i) => i.code)).toContain('missing-mandatory');
    expect(issues.every((i) => i.position === undefined)).toBe(true);
  });
});

describe('positions on a tree validated later', () => {
  it('are kept by the tree, and a default takes its nearest positioned ancestor’s', () => {
    const text = '{\n  "pos:c": {\n    "m": "x", "x": "1",\n    "need": [{"id": "1"}, {"id": "2"}],\n    "dc": {}\n  },\n  "pos:top": "t"\n}';
    const tree = decodeJson(schema, text, withPositions);
    // The default leaf e, added while validating, breaks its must; dc is where it was written.
    expect(placed(validate(tree))).toEqual([`must-violation /pos:c/dc/e ${at(text, 5, '"dc"')}`]);
    expect(placed(validate(tree))).toEqual([`must-violation /pos:c/dc/e ${at(text, 5, '"dc"')}`]);
  });

  it('places a missing top-level node nowhere, since its parent is the document', () => {
    const tree = decodeJson(schema, '{\n  "pos:c": {"m": "x", "x": "1", "need": [{"id": "1"}, {"id": "2"}]}\n}', withPositions);
    expect(placed(validate(tree))).toEqual(['missing-mandatory /pos:top -']);
  });

  it('come back with the decoders’ validate option too', () => {
    const text = '{\n  "pos:c": {"m": "x", "x": "1", "need": [{"id": "1"}]},\n  "pos:top": "t"\n}';
    expect(placed(thrown(() => decodeJson(schema, text, { positions: true, validate: true })))).toEqual(['too-few-elements /pos:c/need 2:3']);
  });
});

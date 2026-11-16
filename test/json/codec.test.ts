import { beforeAll, describe, expect, it } from 'vitest';
import { decodeJson, decodeXml, encodeJson, toJson, toXml, YangDataError, type DataIssue, type JsonDecodeOptions, type Schema } from '../../src/index.js';
import { exSchema, kids } from '../data/support.js';

let schema: Schema;
beforeAll(async () => {
  schema = await exSchema();
});

function issues(json: unknown, options: JsonDecodeOptions = {}): DataIssue[] {
  try {
    decodeJson(schema, json, options);
  } catch (err) {
    // Decoding problems are all errors; compare the rest.
    if (err instanceof YangDataError) return err.issues.map(({ severity, ...rest }) => (severity === 'error' ? rest : { severity, ...rest }) as DataIssue);
    throw err;
  }
  return [];
}

const fromXml = (xml: string): unknown => encodeJson(decodeXml(schema, xml));

describe('JSON encoding (RFC 7951)', () => {
  it('qualifies member names at the top and where the module changes (§4)', () => {
    expect(fromXml('<c xmlns="urn:ex"><s>a</s><more xmlns="urn:ex-aug"><deep>1</deep></more></c><top xmlns="urn:ex"><name>x</name></top>')).toEqual({
      'ex:c': { s: 'a', 'ex-aug:more': { deep: 1 } },
      'ex:top': [{ name: 'x' }],
    });
  });

  it('writes lists and leaf-lists as arrays, entries in order (§5.3, §5.4)', () => {
    expect(fromXml('<c xmlns="urn:ex"><l><k1>b</k1><k2>1</k2></l><l><k1>a</k1><k2>2</k2></l><ll>3</ll><ll>1</ll></c>')).toEqual({
      'ex:c': { ll: [3, 1], l: [{ k1: 'b', k2: 1 }, { k1: 'a', k2: 2 }] },
    });
  });

  it('writes a presence container as an empty object and empty as [null]', () => {
    expect(fromXml('<c xmlns="urn:ex"><e/><p/></c>')).toEqual({ 'ex:c': { e: [null], p: {} } });
  });

  it('places metadata per RFC 7952 §5.2', () => {
    const xml = `<c xmlns="urn:ex" xmlns:ex="urn:ex" ex:weight="1"><s ex:note="n">x</s><ll>1</ll><ll ex:note="b">2</ll><ll>3</ll>
      <l ex:big="9"><k1>a</k1><k2>1</k2></l><ax ex:note="any">t</ax><ad ex:note="data"><x xmlns="urn:ex">1</x></ad></c>`;
    expect(fromXml(xml)).toEqual({
      'ex:c': {
        '@': { 'ex:weight': 1 },
        s: 'x',
        '@s': { 'ex:note': 'n' },
        ll: [1, 2, 3],
        '@ll': [null, { 'ex:note': 'b' }, null],
        ad: { '@': { 'ex:note': 'data' }, x: '1' },
        ax: 't',
        '@ax': { 'ex:note': 'any' },
        l: [{ '@': { 'ex:big': '9' }, k1: 'a', k2: 1 }],
      },
    });
  });

  it('needs a module name for every annotation', () => {
    const tree = decodeXml(schema, '<c xmlns="urn:ex" xmlns:t="urn:tags" t:tag="x" plain="y"/>');
    expect(() => encodeJson(tree)).toThrow(YangDataError);
    try {
      encodeJson(tree);
    } catch (err) {
      expect((err as YangDataError).issues.map((i) => i.message)).toEqual([
        "annotation tag in namespace 'urn:tags' has no module name for JSON; give it in the namespaces option",
        'unqualified attribute plain has no module name for JSON; give it in the namespaces option',
      ]);
    }
    const nc = decodeXml(schema, '<c xmlns="urn:ex" xmlns:t="urn:tags" t:tag="x"/>');
    expect(encodeJson(nc, { namespaces: { 'urn:tags': 'example-tags' } })).toEqual({ 'ex:c': { '@': { 'example-tags:tag': 'x' } } });
  });

  it('writes operations wrapped in their own member', () => {
    expect(encodeJson(decodeXml(schema, '<r xmlns="urn:ex"><a>x</a><b>5</b></r>', { type: 'rpc' }))).toEqual({ 'ex:r': { b: '5', a: 'x' } });
  });

  it('converts anydata and anyxml content structurally', () => {
    expect(fromXml('<c xmlns="urn:ex"><ad><a xmlns="urn:ex-aug">1</a><b>2</b><b>3</b><o><p>q</p></o></ad></c>')).toEqual({
      'ex:c': { ad: { 'ex-aug:a': '1', b: ['2', '3'], o: { p: 'q' } } },
    });
    const tree = decodeJson(schema, { 'ex:c': { ad: { 'ex-aug:a': 1, b: ['2', '3'], e: [null], '@': { 'ex:note': 'n' } }, ax: 'text' } });
    expect(toXml(tree)).toBe(
      '<c xmlns="urn:ex"><ad xmlns:ex="urn:ex" ex:note="n"><a xmlns="urn:ex-aug">1</a><b>2</b><b>3</b><e/></ad><ax>text</ax></c>',
    );
  });

  it('serialises with indentation', () => {
    expect(toJson(decodeXml(schema, '<c xmlns="urn:ex"><s>a</s></c>'), { indent: 2 })).toBe('{\n  "ex:c": {\n    "s": "a"\n  }\n}');
  });
});

describe('JSON decoding', () => {
  it('reads text or parsed values, both directions agreeing', () => {
    const json = { 'ex:c': { s: 'a', i64: '-1', d: '0.10', b: 'three one', idr: 'ex-ids:widget', ll: [2, 1], 'ex-aug:extra': 'x' } };
    const tree = decodeJson(schema, JSON.stringify(json));
    expect(encodeJson(tree)).toEqual({ 'ex:c': { s: 'a', i64: '-1', d: '0.1', b: 'one three', idr: 'ex-ids:widget', ll: [2, 1], 'ex-aug:extra': 'x' } });
    expect(toXml(tree)).toBe(
      '<c xmlns="urn:ex"><s>a</s><i64>-1</i64><d>0.1</d><b>one three</b><idr xmlns:ids="urn:ex-ids">ids:widget</idr><ll>2</ll><ll>1</ll><extra xmlns="urn:ex-aug">x</extra></c>',
    );
  });

  it('accepts a qualified name where the simple one would do', () => {
    expect(encodeJson(decodeJson(schema, { 'ex:c': { 'ex:s': 'a' } }))).toEqual({ 'ex:c': { s: 'a' } });
  });

  it('attaches sibling metadata to the leaf and to each leaf-list entry', () => {
    const tree = decodeJson(schema, { 'ex:c': { '@s': { 'ex:note': 'n' }, s: 'x', ll: [1, 2, 3], '@ll': [null, { 'ex:weight': 4 }] } });
    const c = tree.children[0]!;
    expect(kids(c)[0]!.annotation('ex', 'note')!.value).toMatchObject({ value: 'n' });
    expect(kids(c).map((n) => n.annotations.length)).toEqual([1, 0, 1, 0]);
  });

  it('reads bare parameters with the operation option, wrapped as RESTCONF does or not', () => {
    expect(encodeJson(decodeJson(schema, { 'ex:output': { o: 'done' } }, { type: 'reply', operation: '/ex:r' }))).toEqual({ 'ex:r': { o: 'done' } });
    expect(encodeJson(decodeJson(schema, { 'ex:o': 'done' }, { type: 'reply', operation: '/ex:r' }))).toEqual({ 'ex:r': { o: 'done' } });
    expect(encodeJson(decodeJson(schema, { 'ex:input': { x: 'go' } }, { type: 'rpc', operation: '/ex:c/act' }))).toEqual({ 'ex:c': { act: { x: 'go' } } });
  });

  it('reports every problem, with paths', () => {
    expect(
      issues({
        c: {},
        'zz:c': {},
        'ex:c': {
          nope: 1,
          extra: 'x',
          i8: '1',
          u64: 5,
          e: null,
          s: { not: 'a string' },
          l: [{ k1: 'a' }, { k1: 'b', k2: 1 }, { k1: 'b', k2: 1 }],
          ll: 1,
          inner: 'x',
          '@s': 'not an object',
          '@ll': [],
          '@nothing': {},
          '@': { note: 'unqualified', 'ex:weight': 'heavy', 'zz:x': 1 },
        },
      }),
    ).toEqual([
      { code: 'unknown-node', message: "top-level member 'c' has no module name", path: '/c' },
      { code: 'unknown-node', message: 'module zz is not in the schema', path: '/zz:c' },
      { code: 'unknown-node', message: 'the schema has no node ex:nope here', path: '/ex:c/nope' },
      { code: 'wrong-namespace', message: 'extra is in module ex-aug, not ex', path: '/ex:c/extra' },
      { code: 'invalid-value', message: "'1' is not a JSON number, as int8 requires (RFC 7951 §6.1)", path: '/ex:c/i8' },
      { code: 'invalid-value', message: '5 is not a JSON string, as uint64 requires (RFC 7951 §6.1)', path: '/ex:c/u64' },
      { code: 'invalid-value', message: 'null is not [null], the value of type empty', path: '/ex:c/e' },
      { code: 'invalid-value', message: 'an object is not a JSON string, as string requires', path: '/ex:c/s' },
      { code: 'missing-key', message: "list entry has no value for key 'k2'", path: "/ex:c/l[k1='a']" },
      { code: 'duplicate-entry', message: 'another entry of this list has the same keys', path: "/ex:c/l[k1='b'][k2='1']" },
      { code: 'unexpected-content', message: 'leaf-list ll is 1, not an array', path: '/ex:c/ll' },
      { code: 'unknown-node', message: 'the schema has no node ex:inner here', path: '/ex:c/inner' },
      { code: 'unknown-node', message: 'the schema has no node ex:nothing here', path: '/ex:c/nothing' },
      { code: 'unknown-annotation', message: "annotation 'note' has no module name", path: '/ex:c' },
      { code: 'invalid-value', message: "annotation ex:weight: 'heavy' is not a JSON number, as uint16 requires (RFC 7951 §6.1)", path: '/ex:c' },
      {
        code: 'unknown-annotation',
        message: "annotation zz:x is from a module the schema doesn't have; give its namespace in the namespaces option",
        path: '/ex:c',
      },
    ]);
  });

  it('rejects malformed JSON and non-object documents', () => {
    expect(issues('{')[0]).toMatchObject({ code: 'json-syntax', path: '/' });
    expect(issues('[]')).toEqual([{ code: 'unexpected-content', message: 'the document is an array, not an object', path: '/' }]);
  });

  it('reports metadata in the wrong place', () => {
    expect(issues({ 'ex:c': { inner: 1 } })[0]!.code).toBe('unknown-node');
    expect(issues({ 'ex:c': { p: {}, '@p': { 'ex:note': 'x' } } })).toEqual([
      { code: 'unexpected-content', message: "metadata for container p goes in its own '@' member, not @p", path: '/ex:c/p' },
    ]);
    expect(issues({ 'ex:c': { ll: [1], '@ll': [null, { 'ex:note': 'x' }] } })).toEqual([
      { code: 'unexpected-content', message: 'metadata @ll has more entries than the leaf-list', path: '/ex:c/ll' },
    ]);
  });
});

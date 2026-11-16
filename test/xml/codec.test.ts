import { beforeAll, describe, expect, it } from 'vitest';
import type {
  LeafInstance} from '../../src/index.js';
import {
  decodeXml,
  encodeXml,
  ListEntry,
  OperationInstance,
  parseXml,
  serializeXml,
  toXml,
  YangDataError,
  type DataIssue,
  type DataTree,
  type Identity,
  type Schema,
  type XmlDecodeOptions,
} from '../../src/index.js';
import { exSchema, kids } from '../data/support.js';

let schema: Schema;
beforeAll(async () => {
  schema = await exSchema();
});

const NC = 'urn:ietf:params:xml:ns:netconf:base:1.0';

function issues(xml: string, options: XmlDecodeOptions = {}): DataIssue[] {
  try {
    decodeXml(schema, xml, options);
  } catch (err) {
    // Decoding problems are all errors; compare the rest.
    if (err instanceof YangDataError) return err.issues.map(({ severity, ...rest }) => (severity === 'error' ? rest : { severity, ...rest }) as DataIssue);
    throw err;
  }
  return [];
}

const roundTrip = (xml: string, options: XmlDecodeOptions = {}): string => toXml(decodeXml(schema, xml, options), { indent: 2 });

describe('XML parsing and serialising', () => {
  it('parses several top-level elements and resolves namespaces', () => {
    const [a, b] = parseXml('<?xml version="1.0"?>\n<a xmlns="urn:a" xmlns:p="urn:p" p:x="1"><p:b/></a><c xmlns="urn:c">t</c>');
    expect(a).toMatchObject({ name: 'a', ns: 'urn:a', attributes: [{ name: 'x', ns: 'urn:p', prefix: 'p', value: '1' }] });
    expect(a!.children[0]).toMatchObject({ name: 'b', ns: 'urn:p', prefix: 'p' });
    expect(b).toMatchObject({ name: 'c', ns: 'urn:c', children: ['t'] });
  });

  it('rejects DOCTYPE, undeclared prefixes and malformed text', () => {
    const code = (text: string): string => {
      try {
        parseXml(text);
        return 'none';
      } catch (err) {
        return (err as YangDataError).issues[0]!.message;
      }
    };
    expect(code('<!DOCTYPE x [<!ENTITY a "b">]><x>&a;</x>')).toBe('DOCTYPE declarations are not allowed');
    expect(code('<p:x/>')).toBe('namespace prefix of "p:x" is not declared');
    expect(code('<x>')).toMatch(/^malformed XML/);
    expect(code('text<x/>')).toBe('text outside an element');
  });

  it('declares what each element needs and escapes text and attributes', () => {
    const xml = serializeXml([{ name: 'a', ns: 'urn:a', attributes: [{ name: 'q', ns: 'urn:q', value: '"<&>\n' }], children: ['x < y & z', { name: 'b', ns: 'urn:b' }] }]);
    expect(xml).toBe('<a xmlns="urn:a" xmlns:ns="urn:q" ns:q="&quot;&lt;&amp;>&#10;">x &lt; y &amp; z<b xmlns="urn:b"/></a>');
  });
});

describe('XML decoding and encoding (RFC 7950 XML rules)', () => {
  it('writes canonical values, keys first, children in schema order', () => {
    const xml = `<c xmlns="urn:ex">
      <u>12</u><l><v>vv</v><k2>007</k2><k1>a</k1></l><s>x</s><d>1.50</d><b>three one</b><e/>
    </c>`;
    expect(roundTrip(xml)).toBe(`<c xmlns="urn:ex">
  <s>x</s>
  <d>1.5</d>
  <e/>
  <b>one three</b>
  <u>12</u>
  <l>
    <k1>a</k1>
    <k2>7</k2>
    <v>vv</v>
  </l>
</c>`);
  });

  it('writes identityrefs and instance-identifiers with prefixes declared on the element', () => {
    const xml = `<c xmlns="urn:ex" xmlns:x="urn:ex-ids"><idr>x:gadget</idr><ii xmlns:e="urn:ex" xmlns:a="urn:ex-aug">/e:c/a:more/a:deep</ii></c>`;
    const tree = decodeXml(schema, xml);
    const idr = kids(tree.children[0]);
    expect(((idr[0] as LeafInstance).value.value as Identity).name).toBe('gadget');
    expect(toXml(tree)).toBe(
      '<c xmlns="urn:ex"><idr xmlns:ids="urn:ex-ids">ids:gadget</idr><ii xmlns:ex="urn:ex" xmlns:aug="urn:ex-aug">/ex:c/aug:more/aug:deep</ii></c>',
    );
  });

  it('resolves an unprefixed identityref in the default namespace', () => {
    const tree = decodeXml(schema, '<c xmlns="urn:ex"><idr>local-thing</idr></c>');
    expect(toXml(tree)).toBe('<c xmlns="urn:ex"><idr xmlns:ex="urn:ex">ex:local-thing</idr></c>');
  });

  it('switches the default namespace for augmented nodes', () => {
    expect(toXml(decodeXml(schema, '<c xmlns="urn:ex"><more xmlns="urn:ex-aug"><deep>1</deep></more><s>a</s></c>'))).toBe(
      '<c xmlns="urn:ex"><s>a</s><more xmlns="urn:ex-aug"><deep>1</deep></more></c>',
    );
  });

  it('makes choice and case invisible', () => {
    const tree = decodeXml(schema, '<c xmlns="urn:ex"><ca>1</ca><cb>2</cb></c>');
    expect(kids(tree.children[0]).map((n) => n.schema.name)).toEqual(['ca', 'cb']);
  });

  it('keeps leaf-list entries and list entries in order', () => {
    const xml = '<c xmlns="urn:ex"><lls>b</lls><lls>a</lls><ll>3</ll><ll>1</ll></c>';
    expect(toXml(decodeXml(schema, xml))).toBe('<c xmlns="urn:ex"><ll>3</ll><ll>1</ll><lls>b</lls><lls>a</lls></c>');
  });

  it('leaves out the nodes skip names, with their subtrees, at the top and below', () => {
    const tree = decodeXml(schema, '<c xmlns="urn:ex"><lls>b</lls><lls>a</lls><ll>3</ll><ll>1</ll></c>');
    const c = tree.children[0]!;
    const b = kids(c).find((n) => n.schema.name === 'lls')!;
    expect(toXml(tree, { skip: (n) => n === b })).toBe('<c xmlns="urn:ex"><ll>3</ll><ll>1</ll><lls>a</lls></c>');
    expect(encodeXml(tree, { skip: (n) => n === c })).toEqual([]);
    // The tree is unchanged.
    expect(toXml(tree)).toBe('<c xmlns="urn:ex"><ll>3</ll><ll>1</ll><lls>b</lls><lls>a</lls></c>');
  });

  it('carries annotations: typed when defined, as text otherwise, unqualified too', () => {
    const xml = `<c xmlns="urn:ex" xmlns:ex="urn:ex" xmlns:nc="${NC}" xmlns:wd="urn:ietf:params:xml:ns:netconf:default:1.0" nc:operation="merge">
      <s ex:note="hi" ex:weight=" 0012 " wd:default="true" plain="1">x</s></c>`;
    const tree = decodeXml(schema, xml);
    const c = tree.children[0]!;
    expect(c.annotations).toEqual([{ namespace: NC, module: 'ietf-netconf', name: 'operation', prefix: 'nc', value: 'merge' }]);
    const s = kids(c)[0]!;
    expect(s.annotation('ex', 'weight')!.value).toMatchObject({ value: 12 });
    // RFC 6243's annotation is known without its module (since M4), typed boolean.
    expect(s.annotation('urn:ietf:params:xml:ns:netconf:default:1.0', 'default')).toMatchObject({ module: 'ietf-netconf-with-defaults', value: { value: true } });
    expect(s.isDefault).toBe(true);
    expect(toXml(tree)).toBe(
      `<c xmlns="urn:ex" xmlns:nc="${NC}" nc:operation="merge"><s xmlns:ex="urn:ex" xmlns:wd="urn:ietf:params:xml:ns:netconf:default:1.0" ex:note="hi" ex:weight="12" wd:default="true" plain="1">x</s></c>`,
    );
  });

  it('keeps anydata and anyxml content as it is', () => {
    const xml = '<c xmlns="urn:ex"><ad><foo xmlns="urn:other"><bar>1</bar></foo></ad><ax>text <i>and</i> more</ax></c>';
    expect(toXml(decodeXml(schema, xml))).toBe('<c xmlns="urn:ex"><ad><foo xmlns="urn:other"><bar>1</bar></foo></ad><ax>text <i>and</i> more</ax></c>');
  });

  it('decodes net-netconf-style pre-parsed elements with inherited namespaces and outer prefixes', () => {
    const el = { name: 'c', ns: 'urn:ex', attributes: [], children: [{ name: 'idr', ns: undefined, children: ['i:widget'] }] };
    const tree = decodeXml(schema, el, { scope: new Map([['i', 'urn:ex-ids']]) });
    expect(toXml(tree)).toBe('<c xmlns="urn:ex"><idr xmlns:ids="urn:ex-ids">ids:widget</idr></c>');
  });

  it('reports every problem, with paths', () => {
    expect(
      issues(`<c xmlns="urn:ex">
        <nope/><s xmlns="urn:wrong">x</s><i8>300</i8>
        <l><k1>a</k1><v>1</v></l>
        <l><k1>b</k1><k2>1</k2></l><l><k1>b</k1><k2>01</k2></l>
        <bool>true</bool><bool>false</bool>
        <idr>zz:thing</idr><s><x/></s>
      </c><unknown xmlns="urn:nothing"/>`),
    ).toEqual([
      { code: 'unknown-node', message: "the schema has no node nope in namespace 'urn:ex' here", path: '/ex:c/nope' },
      { code: 'wrong-namespace', message: "element s is in namespace 'urn:wrong', but the schema has it in 'urn:ex' (module ex)", path: '/ex:c/s' },
      { code: 'invalid-value', message: 'value is outside the allowed range -128..127', path: '/ex:c/i8' },
      { code: 'missing-key', message: "list entry has no value for key 'k2'", path: "/ex:c/l[k1='a']" },
      { code: 'duplicate-entry', message: 'another entry of this list has the same keys', path: "/ex:c/l[k1='b'][k2='1']" },
      { code: 'duplicate-node', message: 'leaf bool appears more than once', path: '/ex:c/bool' },
      { code: 'invalid-value', message: "'zz:thing' is not a known identity", path: '/ex:c/idr' },
      { code: 'unexpected-content', message: "a leaf can't contain element x", path: '/ex:c/s' },
      { code: 'unknown-node', message: "the schema has no node unknown in namespace 'urn:nothing' here", path: '/unknown' },
    ]);
  });

  it('skips unknown nodes when asked', () => {
    expect(toXml(decodeXml(schema, '<c xmlns="urn:ex"><nope/><s>x</s></c><zz xmlns="urn:zz"/>', { unknown: 'skip' }))).toBe('<c xmlns="urn:ex"><s>x</s></c>');
  });

  it('rejects an annotation value that is invalid for its type', () => {
    expect(issues('<c xmlns="urn:ex" xmlns:ex="urn:ex"><s ex:weight="-1">x</s></c>')).toEqual([
      { code: 'invalid-value', message: 'annotation ex:weight: value is outside the allowed range 0..65535', path: '/ex:c/s' },
    ]);
  });
});

describe('XML operations', () => {
  it('reads an RPC invocation and writes parameters in schema order', () => {
    const tree = decodeXml(schema, '<r xmlns="urn:ex"><a>x</a><b>5</b></r>', { type: 'rpc' });
    expect(tree.operation).toBeInstanceOf(OperationInstance);
    expect(toXml(tree)).toBe('<r xmlns="urn:ex"><b>5</b><a>x</a></r>');
  });

  it('reads an action inside its data ancestors', () => {
    const tree = decodeXml(schema, "<c xmlns='urn:ex'><act><y>3</y><x>a</x></act></c>", { type: 'rpc' });
    expect(tree.operation!.path).toBe('/ex:c/act');
    expect(toXml(tree)).toBe('<c xmlns="urn:ex"><act><x>a</x><y>3</y></act></c>');
  });

  it('reads bare reply parameters given the operation, as in a NETCONF rpc-reply', () => {
    const reply = decodeXml(schema, '<o xmlns="urn:ex">done</o>', { type: 'reply', operation: '/ex:r' });
    expect(toXml(reply)).toBe('<r xmlns="urn:ex"><o>done</o></r>');
    expect(toXml(reply.operation!.children)).toBe('<o xmlns="urn:ex">done</o>');
    const action = decodeXml(schema, '<out xmlns="urn:ex">ok</out>', { type: 'reply', operation: '/ex:c/act' });
    expect(action.operation!.path).toBe('/ex:c/act');
  });

  it('builds list ancestors with their keys for a bare action reply', () => {
    const reply = decodeXml(schema, '<ok xmlns="urn:ex">true</ok>', { type: 'reply', operation: "/ex:c/l[k1='a'][k2='07']/reset" });
    expect(reply.operation!.path).toBe("/ex:c/l[k1='a'][k2='7']/reset");
    expect(reply.operation!.parent).toBeInstanceOf(ListEntry);
    expect(toXml(reply)).toBe('<c xmlns="urn:ex"><l><k1>a</k1><k2>7</k2><reset><ok>true</ok></reset></l></c>');
    expect(issues('<ok xmlns="urn:ex">true</ok>', { type: 'reply', operation: "/ex:c/l[k1='a']/reset" })).toEqual([
      { code: 'invalid-operation', message: "'/ex:c/l[k1='a']/reset' doesn't give every key of l", path: "/ex:c/l[k1='a']/reset" },
    ]);
  });

  it('reads a notification nested in data', () => {
    const notif = decodeXml(schema, '<c xmlns="urn:ex"><n><z>1</z></n></c>', { type: 'notification' });
    expect(notif.operation!.kind).toBe('notification');
    expect(issues('<ev xmlns="urn:ex"/>', { type: 'rpc' })).toEqual([
      { code: 'unknown-node', message: "the schema has no node ev in namespace 'urn:ex' here", path: '/ex:ev' },
      { code: 'missing-operation', message: 'the rpc holds no RPC or action', path: '/' },
    ]);
  });

  it('reports operations in the wrong place', () => {
    expect(issues('<r xmlns="urn:ex"/>')).toEqual([{ code: 'unknown-node', message: "the schema has no node r in namespace 'urn:ex' here", path: '/ex:r' }]);
    expect(issues('<c xmlns="urn:ex"><act/></c>')).toEqual([{ code: 'unexpected-operation', message: "action act can't appear in datastore content", path: '/ex:c/act' }]);
    expect(issues('<c xmlns="urn:ex"/>', { type: 'rpc' })).toEqual([{ code: 'missing-operation', message: 'the rpc holds no RPC or action', path: '/' }]);
    expect(issues('<o xmlns="urn:ex">x</o>', { type: 'reply', operation: '/ex:nope' })[0]).toMatchObject({ code: 'invalid-operation' });
  });
});

describe('encoding trees built in code', () => {
  it('writes annotations known only by module name, given namespaces', () => {
    const tree: DataTree = decodeXml(schema, '<c xmlns="urn:ex"><s>x</s></c>');
    const s = kids(tree.children[0])[0]!;
    s.annotations.push({ namespace: undefined, module: 'example-tags', name: 'tag', value: 'blue' });
    expect(() => encodeXml(tree)).toThrow('/ex:c/s: annotation example-tags:tag has no known namespace; give it in the namespaces option');
    expect(toXml(tree, { namespaces: { 'urn:tags': 'example-tags' } })).toBe('<c xmlns="urn:ex"><s xmlns:a="urn:tags" a:tag="blue">x</s></c>');
    s.annotations.push({ namespace: undefined, module: 'ietf-netconf', name: 'operation', value: 'delete' });
    expect(toXml(kids(tree.children[0])[0]!, { namespaces: { 'urn:tags': 'example-tags' } })).toBe(
      `<s xmlns="urn:ex" xmlns:a="urn:tags" xmlns:nc="${NC}" a:tag="blue" nc:operation="delete">x</s>`,
    );
  });
});

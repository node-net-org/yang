import { beforeAll, describe, expect, it } from 'vitest';
import { Decimal64, type LeafListNode, type LeafNode, type Schema, type TypedValue } from '../../src/index.js';
import { formatJson, formatText, parseJson, parseText, type ValueScope } from '../../src/data/lexical.js';
import { exSchema } from './support.js';

let schema: Schema;
beforeAll(async () => {
  schema = await exSchema();
  expect(schema.errors).toEqual([]);
});

const leaf = (name: string): LeafNode => schema.find(`/ex:c/${name}`) as LeafNode;

/** XML scope: prefixes as declared, default namespace urn:ex. */
function xml(prefixes: Record<string, string> = { ex: 'urn:ex', ids: 'urn:ex-ids' }): ValueScope {
  const byNs = new Map([...schema.modules.values()].map((m) => [m.namespace, m]));
  return { format: 'xml', schema, module: (p) => byNs.get(prefixes[p] ?? ''), unprefixed: schema.module('ex') };
}
function json(): ValueScope {
  return { format: 'json', schema, module: (p) => schema.module(p), unprefixed: schema.module('ex') };
}
const prefixOf = (m: { prefix: string }): string => m.prefix;

function text(name: string, t: string): TypedValue {
  const v = parseText(leaf(name).type, t, xml());
  if (typeof v === 'string') throw new Error(v);
  return v;
}

describe('XML lexical values', () => {
  it.each([
    ['i8', ' -5 ', -5, '-5'],
    ['i8', '+007', 7, '7'],
    ['u32', '4294967295', 4294967295, '4294967295'],
    ['i64', '-9000000000000', -9000000000000n, '-9000000000000'],
    ['u64', '18446744073709551615', 18446744073709551615n, '18446744073709551615'],
    ['bool', 'true', true, 'true'],
    ['e', '', null, ''],
    ['en', 'down', 'down', 'down'],
    ['s', '  spaced  ', '  spaced  ', '  spaced  '],
  ])('%s %j', (name, input, value, canonical) => {
    const v = text(name, input);
    expect(v.value).toEqual(value);
    expect(formatText(v, prefixOf)).toBe(canonical);
  });

  it('gives decimal64 its canonical form', () => {
    expect((text('d', '1.500').value as Decimal64).toString()).toBe('1.5');
    expect((text('d', '-0.250').value as Decimal64).toString()).toBe('-0.25');
    expect((text('d', '12').value as Decimal64).toString()).toBe('12.0');
    expect((text('d', '0.001').value as Decimal64).toString()).toBe('0.001');
    expect(text('d', '1.5').value).toEqual(new Decimal64(1500n, 3));
    expect(parseText(leaf('d').type, '1.2345', xml())).toBe("'1.2345' has more than 3 fraction digits");
  });

  it('orders bits by position and drops extra whitespace', () => {
    const v = text('b', '  three\tone ');
    expect(v.value).toEqual(['one', 'three']);
    expect(formatText(v, prefixOf)).toBe('one three');
  });

  it('decodes binary from base64, ignoring whitespace', () => {
    const v = text('bin', 'AQID\nBA==');
    expect(v.value).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(formatText(v, prefixOf)).toBe('AQIDBA==');
  });

  it('resolves identityrefs through XML namespace prefixes', () => {
    const v = parseText(leaf('idr').type, 'x:gadget', xml({ x: 'urn:ex-ids' }));
    expect(typeof v === 'string' ? v : formatText(v, prefixOf)).toBe('ids:gadget');
    expect(parseText(leaf('idr').type, 'local-thing', xml()) as TypedValue).toMatchObject({ value: { name: 'local-thing' } });
    expect(parseText(leaf('idr').type, 'zz:gadget', xml())).toBe("'zz:gadget' is not a known identity");
    expect(parseText(leaf('idr').type, 'ids:thing', xml())).toBe("'ids:thing' is not derived from ex-ids:thing");
  });

  it('takes the first union member that accepts the text', () => {
    expect(text('u', '12')).toMatchObject({ type: { builtin: 'int32' }, value: 12 });
    expect(text('u', '13.5')).toMatchObject({ type: { builtin: 'string' }, value: '13.5' });
    expect(text('u2', 'unlimited')).toMatchObject({ type: { builtin: 'enumeration' } });
  });

  it('reads a leafref as its target type', () => {
    expect(text('lr', 'abc')).toMatchObject({ type: { builtin: 'string' }, value: 'abc' });
  });

  it('rejects invalid values with a message', () => {
    expect(parseText(leaf('i8').type, '128', xml())).toBe('value is outside the allowed range -128..127');
    expect(parseText(leaf('en').type, 'sideways', xml())).toBe("'sideways' is not one of the enum values");
    expect(parseText(leaf('e').type, 'x', xml())).toBe('a value of type empty has no content');
  });
});

describe('JSON values (RFC 7951 §6)', () => {
  const j = (name: string, value: unknown): TypedValue | string => parseJson(leaf(name).type, value, json());

  it('requires numbers for small integers and strings for 64-bit ones and decimal64', () => {
    expect(j('i8', 5)).toMatchObject({ value: 5 });
    expect(j('i8', '5')).toBe("'5' is not a JSON number, as int8 requires (RFC 7951 §6.1)");
    expect(j('i64', '-5')).toMatchObject({ value: -5n });
    expect(j('i64', 5)).toBe('5 is not a JSON string, as int64 requires (RFC 7951 §6.1)');
    expect(j('d', '2.50')).toMatchObject({ value: new Decimal64(2500n, 3) });
    expect(j('i8', 1.5)).toBe('1.5 is not a JSON number, as int8 requires (RFC 7951 §6.1)');
  });

  it('writes the JSON form of each type', () => {
    const f = (name: string, t: string): unknown => formatJson(text(name, t));
    expect(f('i8', '-5')).toBe(-5);
    expect(f('u64', '7')).toBe('7');
    expect(f('d', '1.50')).toBe('1.5');
    expect(f('e', '')).toEqual([null]);
    expect(f('bool', 'false')).toBe(false);
    expect(f('idr', 'ids:widget')).toBe('ex-ids:widget');
    expect(f('idr', 'local-thing')).toBe('ex:local-thing');
    expect(f('bin', 'AQID')).toBe('AQID');
  });

  it('selects the union member by JSON type (§6.10)', () => {
    expect(j('u', 12)).toMatchObject({ type: { builtin: 'int32' } });
    expect(j('u', '12')).toMatchObject({ type: { builtin: 'string' }, value: '12' });
    expect(j('u', 13.5)).toBe("13.5 matches none of the union's member types");
    expect(j('u2', '5')).toMatchObject({ type: { builtin: 'uint64' }, value: 5n });
  });

  it('reads identityrefs by module name, unprefixed meaning the leaf’s own module', () => {
    expect(j('idr', 'ex-ids:gadget')).toMatchObject({ value: { name: 'gadget' } });
    expect(j('idr', 'local-thing')).toMatchObject({ value: { name: 'local-thing' } });
    expect(j('idr', 'ids:gadget')).toBe("'ids:gadget' is not a known identity");
  });

  it('accepts only [null] for empty', () => {
    expect(j('e', [null])).toMatchObject({ value: null });
    expect(j('e', null)).toBe('null is not [null], the value of type empty');
  });
});

describe('instance-identifier values', () => {
  it('reads XML prefixes and writes JSON module names only where the module changes', () => {
    const v = parseText(leaf('ii').type, "/ex:c/ex:l[ex:k1='a'][ex:k2=\"007\"]/ex:inner/ex:x", xml());
    expect(typeof v).toBe('object');
    const tv = v as TypedValue;
    expect(formatJson(tv)).toBe("/ex:c/l[k1='a'][k2='7']/inner/x");
    expect(formatText(tv, prefixOf)).toBe("/ex:c/ex:l[ex:k1='a'][ex:k2='7']/ex:inner/ex:x");
  });

  it('crosses modules, with identityref keys and leaf-list and position predicates', () => {
    const v = parseJson(leaf('ii').type, "/ex:c/ex-aug:more/deep", json()) as TypedValue;
    expect(formatText(v, prefixOf)).toBe('/ex:c/aug:more/aug:deep');
    const k = parseJson(leaf('ii').type, "/ex:c/ids[id='ex-ids:gadget']", json()) as TypedValue;
    expect(formatText(k, prefixOf)).toBe("/ex:c/ex:ids[ex:id='ids:gadget']");
    expect(formatJson(k)).toBe("/ex:c/ids[id='ex-ids:gadget']");
    const ll = parseJson(leaf('ii').type, "/ex:c/lls[.=\"it's\"]", json()) as TypedValue;
    expect(formatJson(ll)).toBe(`/ex:c/lls[.="it's"]`);
    expect(formatJson(parseJson(leaf('ii').type, '/ex:c/l[2]', json()) as TypedValue)).toBe('/ex:c/l[2]');
  });

  it('explains what is wrong', () => {
    const p = (s: string): unknown => parseJson(leaf('ii').type, s, json());
    expect(p('ex:c')).toBe("'ex:c' is not an instance identifier: it must start with '/'");
    expect(p('/c')).toBe("the first node name in '/c' has no module name");
    expect(p('/ex:c/nope')).toBe("'/ex:c/nope' names ex:nope, which is not a data node here");
    expect(p("/ex:c/l[v='x']")).toBe("'v' in '/ex:c/l[v='x']' is not a key of l");
    expect(p("/ex:c/l[k2='300']")).toBe("in '/ex:c/l[k2='300']': value is outside the allowed range 0..255");
    expect(p("/ex:c/l[k1='a'")).toBe("']' is missing at offset 14 in '/ex:c/l[k1='a''");
    expect(p('/zz:c')).toBe("'zz' in '/zz:c' is not a known module");
  });

  it('reads leaf-list values in predicates with the leaf-list type', () => {
    const v = parseJson(leaf('ii').type, "/ex:c/ll[.='07']", json()) as TypedValue;
    expect(formatJson(v)).toBe("/ex:c/ll[.='7']");
    expect((schema.find('/ex:c/ll') as LeafListNode).kind).toBe('leaf-list');
  });
});

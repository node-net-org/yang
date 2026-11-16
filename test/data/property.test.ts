import fc from 'fast-check';
import { beforeAll, describe, expect, it } from 'vitest';
import { decodeJson, decodeXml, encodeJson, toXml, YangDataError, type Schema, type XmlElementLike } from '../../src/index.js';
import { exSchema } from './support.js';

let schema: Schema;
beforeAll(async () => {
  schema = await exSchema();
});

/** Strings that stress escaping: markup characters, quotes, whitespace (CR included), non-ASCII. */
const text = fc.string({ unit: fc.constantFrom('a', 'Z', '0', ' ', '\t', '\n', '\r', '<', '>', '&', '"', "'", ']', 'é', '😀'), maxLength: 10 });
const key = fc.string({ unit: fc.constantFrom('a', 'b', ' ', "'", '/', ']', '='), minLength: 1, maxLength: 4 }).filter((s) => !(s.includes("'") && s.includes('"')));
const decimal = fc.bigInt({ min: -(10n ** 18n), max: 10n ** 18n }).map((n) => {
  const neg = n < 0n;
  const digits = (neg ? -n : n).toString().padStart(4, '0');
  return `${neg ? '-' : ''}${digits.slice(0, -3)}.${digits.slice(-3)}`;
});

/** Valid RFC 7951 content for /ex:c, with every type, metadata and augmented nodes. */
const exData = fc
  .record(
    {
      s: text,
      i8: fc.integer({ min: -128, max: 127 }),
      u32: fc.integer({ min: 0, max: 4294967295 }),
      i64: fc.bigInt({ min: -(2n ** 63n), max: 2n ** 63n - 1n }).map(String),
      u64: fc.bigInt({ min: 0n, max: 2n ** 64n - 1n }).map(String),
      d: decimal,
      bool: fc.boolean(),
      e: fc.constant([null]),
      en: fc.constantFrom('up', 'down'),
      b: fc.subarray(['one', 'two', 'three']).map((a) => a.join(' ')),
      bin: fc.uint8Array({ maxLength: 8 }).map((a) => Buffer.from(a).toString('base64')),
      idr: fc.constantFrom('ex-ids:widget', 'ex-ids:gadget', 'ex:local-thing'),
      ii: fc.constantFrom('/ex:c/s', "/ex:c/l[k1='a'][k2='7']/inner/x", '/ex:c/ex-aug:more/deep', "/ex:c/lls[.='x']", "/ex:c/ids[id='ex-ids:widget']"),
      // A string member that can't be read as int32, so XML gives it back as a string.
      u: fc.oneof(fc.integer({ min: -(2 ** 31), max: 2 ** 31 - 1 }), text.map((t) => `x${t}`)),
      ll: fc.array(fc.integer({ min: 0, max: 255 }), { maxLength: 4 }),
      lls: fc.array(text, { maxLength: 3 }),
      l: fc.uniqueArray(fc.record({ k1: key, k2: fc.integer({ min: 0, max: 255 }) }), { selector: (e) => `${e.k1} ${e.k2}`, maxLength: 3 }),
      'ex-aug:extra': text,
      'ex-aug:more': fc.record({ deep: fc.integer({ min: -(2 ** 31), max: 2 ** 31 - 1 }) }),
      '@s': fc.record({ 'ex:note': text, 'ex:weight': fc.integer({ min: 0, max: 65535 }) }, { requiredKeys: [] }),
      '@': fc.record({ 'ex:big': fc.bigInt({ min: -(2n ** 63n), max: 2n ** 63n - 1n }).map(String) }),
    },
    { requiredKeys: [] },
  )
  .map((c) => {
    const out: Record<string, unknown> = { ...c };
    if (Array.isArray(out['ll']) && out['ll'].length === 0) delete out['ll'];
    if (Array.isArray(out['lls']) && out['lls'].length === 0) delete out['lls'];
    if (Array.isArray(out['l']) && out['l'].length === 0) delete out['l'];
    if (out['@s'] !== undefined && out['s'] === undefined) delete out['@s'];
    return { 'ex:c': out };
  });

describe('codec properties', () => {
  it('converts JSON → XML → JSON without change', () => {
    fc.assert(
      fc.property(exData, (json) => {
        const first = decodeJson(schema, json);
        const xml = toXml(first);
        const second = decodeXml(schema, xml);
        expect(encodeJson(second)).toEqual(encodeJson(first));
        expect(toXml(second)).toBe(xml);
      }),
      { numRuns: 300 },
    );
  });

  const MEMBERS = ['ex:c', 'ex:top', 'ex:state', 'c', 's', 'i8', 'u64', 'e', 'l', 'k1', 'k2', 'll', 'idr', 'ii', 'ad', 'ax', 'p', 'act', 'ex-aug:more', 'deep', '@', '@s', '@ll', 'ex:note', 'ex:weight', 'zz:x'];
  const jsonish: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
    value: fc.oneof({ depthSize: 'small', withCrossShrink: true }, fc.jsonValue({ maxDepth: 1 }), tie('object'), fc.array(tie('value'), { maxLength: 3 })),
    object: fc.dictionary(fc.constantFrom(...MEMBERS), tie('value'), { maxKeys: 5 }),
  })).value;

  it('never fails on arbitrary JSON except with a YangDataError', () => {
    fc.assert(
      fc.property(jsonish, fc.constantFrom('data', 'rpc', 'reply', 'notification' as const), (json, type) => {
        try {
          decodeJson(schema, json, { type });
        } catch (err) {
          if (!(err instanceof YangDataError)) throw err;
          expect(err.issues.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 1000 },
    );
  });

  const NAMES = ['c', 's', 'l', 'k1', 'k2', 'll', 'idr', 'ii', 'e', 'ad', 'act', 'x', 'r', 'a', 'ev', 'more', 'deep', 'top', 'name'];
  const NAMESPACES = ['urn:ex', 'urn:ex-aug', 'urn:other', undefined];
  const element: fc.Arbitrary<XmlElementLike> = fc.letrec((tie) => ({
    el: fc.record({
      name: fc.constantFrom(...NAMES),
      ns: fc.constantFrom(...NAMESPACES),
      attributes: fc.array(fc.record({ name: fc.constantFrom('note', 'weight', 'x'), ns: fc.constantFrom('urn:ex', undefined, 'urn:z'), value: fc.constantFrom('1', '-1', 'a', '') }), { maxLength: 2 }),
      children: fc.array(fc.oneof({ depthSize: 'small' }, fc.constantFrom('1', 'ex:c', ' ', 'ids:widget', '/ex:c/s'), tie('el')), { maxLength: 3 }),
      declarations: fc.constantFrom(new Map<string, string>(), new Map([['ids', 'urn:ex-ids']]), new Map([['ex', 'urn:ex']])),
    }),
  })).el as fc.Arbitrary<XmlElementLike>;

  it('never fails on arbitrary XML elements except with a YangDataError', () => {
    fc.assert(
      fc.property(fc.array(element, { maxLength: 3 }), fc.constantFrom('data', 'rpc', 'reply', 'notification' as const), (elements, type) => {
        try {
          decodeXml(schema, elements, { type });
        } catch (err) {
          if (!(err instanceof YangDataError)) throw err;
        }
      }),
      { numRuns: 1000 },
    );
  });
});

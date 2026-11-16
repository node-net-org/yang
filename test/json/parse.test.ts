/**
 * The position-tracking JSON parser behind the decoders' `positions` option:
 * the same values as JSON.parse, the same documents rejected, and where each
 * object, member and array item is.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { JsonSyntaxProblem, parseJsonText } from '../../src/json/parse.js';

function nativeOrError(text: string): { value: unknown } | 'error' {
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return 'error';
  }
}

function oursOrError(text: string): { value: unknown } | 'error' {
  try {
    return { value: parseJsonText(text).value };
  } catch (e) {
    if (!(e instanceof JsonSyntaxProblem)) throw e;
    return 'error';
  }
}

/** JSON text with random whitespace between tokens. */
const spaced = fc.tuple(fc.json(), fc.constantFrom(' ', '\n', '\r\n', '\t', '  \n  ')).map(([t, ws]) => t.replace(/([,:[\]{}])/g, `$1${ws}`));

describe('parseJsonText', () => {
  it('gives the same values as JSON.parse', () => {
    fc.assert(
      fc.property(fc.oneof(fc.json(), spaced, fc.jsonValue().map((v) => JSON.stringify(v, null, 2))), (text) => {
        expect(oursOrError(text)).toEqual(nativeOrError(text));
      }),
      { numRuns: 2000 },
    );
  });

  it('rejects exactly what JSON.parse rejects', () => {
    const fragments = fc.constantFrom('{', '}', '[', ']', ',', ':', '"a"', '"\\u00e9"', '"\\x"', '1', '-0', '1e5', '01', '.5', 'true', 'nul', 'null', ' ', '\n', '"\t"', '\\');
    fc.assert(
      fc.property(fc.array(fragments, { maxLength: 12 }).map((p) => p.join('')), (text) => {
        expect(oursOrError(text)).toEqual(nativeOrError(text));
      }),
      { numRuns: 5000 },
    );
  });

  it('matches JSON.parse on the awkward cases', () => {
    for (const text of [
      '{"__proto__": {"x": 1}}',
      '{"a": 1, "b": 2, "a": 3}',
      '"\\ud800"',
      '"\\uDE00\\ud83d"',
      '-0',
      '1E+400',
      '123456789012345678901234567890',
      '"\\/\\b\\f\\n\\r\\t\\"\\\\"',
      '  [ ]  ',
      '{}',
      '"😀"',
    ]) {
      expect(oursOrError(text), text).toEqual(nativeOrError(text));
    }
    const proto = parseJsonText('{"__proto__": {"x": 1}}').value as object;
    expect(Object.getPrototypeOf(proto)).toBe(Object.prototype);
    expect(Object.keys(proto)).toEqual(['__proto__']);
    expect(Object.keys(parseJsonText('{"a": 1, "b": 2, "a": 3}').value as object)).toEqual(['a', 'b']);
  });

  it('parses nesting deeper than the call stack allows recursion', () => {
    const depth = 100_000;
    const text = `${'['.repeat(depth)}1${']'.repeat(depth)}`;
    let v = parseJsonText(text).value;
    for (let i = 0; i < depth; i++) v = (v as unknown[])[0];
    expect(v).toBe(1);
  });

  it('records where objects, members and items are', () => {
    const text = '{\n  "a": [1, {"b": true}],\n  "a": [2]\n}';
    const { value, places } = parseJsonText(text);
    const obj = value as { a: unknown[] };
    expect(places.get(obj)?.offset).toBe(0);
    // A repeated member is placed at its last occurrence, whose value it keeps.
    expect(places.get(obj)?.members?.get('a')).toBe(text.lastIndexOf('"a"'));
    expect(places.get(obj.a)?.items).toEqual([text.indexOf('2')]);
    const first = parseJsonText('[ 1 , {"b": true} ]');
    const arr = first.value as unknown[];
    expect(first.places.get(arr)?.items).toEqual([2, 6]);
    expect(first.places.get(arr[1] as object)).toEqual({ offset: 6, members: new Map([['b', 7]]) });
  });

  it('says where a syntax error is', () => {
    const where = (text: string): number => {
      try {
        parseJsonText(text);
      } catch (e) {
        if (e instanceof JsonSyntaxProblem) return e.offset;
        throw e;
      }
      throw new Error('parsed');
    };
    expect(where('{"a": 1,}')).toBe(8);
    expect(where('[1 2]')).toBe(3);
    expect(where('"abc')).toBe(0);
    expect(where('{"a" 1}')).toBe(5);
    expect(where('')).toBe(0);
    expect(where('[1] x')).toBe(4);
  });
});

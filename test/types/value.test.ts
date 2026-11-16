import { describe, expect, it } from 'vitest';
import { checkValue, type Identity, type YangType } from '../../src/index.js';
import { parseIntervals, parseNumber } from '../../src/types/range.js';

const noIdentities = { resolveIdentity: () => undefined };
const type = (t: Partial<YangType> & Pick<YangType, 'builtin'>): YangType => ({ name: t.builtin, patterns: [], ...t });

describe('parseIntervals', () => {
  const uint8 = [{ min: 0n, max: 255n }];
  it.each([
    ['1..10', [{ min: 1n, max: 10n }]],
    ['min..max', uint8],
    ['1 | 3..4 | max', [{ min: 1n, max: 1n }, { min: 3n, max: 4n }, { min: 255n, max: 255n }]],
  ])('%j', (text, expected) => {
    expect(parseIntervals(text, uint8, false)).toEqual(expected);
  });

  it.each([
    ['10..1', "'10..1': the upper bound is below the lower bound"],
    ['5 | 1', "'1' is not in ascending order or overlaps the part before it"],
    ['0..256', "'0..256' is not within the range allowed by the base type"],
    ['1..2..3', "'1..2..3' is not a valid range part"],
    ['a', "'a' is not an integer"],
  ])('rejects %j', (text, message) => {
    expect(parseIntervals(text, uint8, false)).toBe(message);
  });

  it('scales decimal64 bounds and limits fraction digits', () => {
    expect(parseNumber('-1.5', true, 3)).toBe(-1500n);
    expect(parseNumber('2', true, 2)).toBe(200n);
    expect(parseNumber('1.234', true, 2)).toBe("'1.234' has more than 2 fraction digits");
  });
});

describe('checkValue', () => {
  it('checks integers against their range, with hex and octal only in modules', () => {
    const t = type({ builtin: 'int16', range: [{ min: -5n, max: 5n }] });
    expect(checkValue(t, '-5', noIdentities)).toBeUndefined();
    expect(checkValue(t, '6', noIdentities)).toBe('value is outside the allowed range -5..5');
    expect(checkValue(t, '0x5', noIdentities)).toBe("'0x5' is not an integer");
    expect(checkValue(t, '0x5', { ...noIdentities, inModule: true })).toBeUndefined();
    expect(checkValue(type({ builtin: 'uint64' }), '18446744073709551615', noIdentities)).toBeUndefined();
    expect(checkValue(type({ builtin: 'uint64' }), '18446744073709551616', noIdentities)).toMatch(/outside/);
  });

  it('counts string length in characters, not UTF-16 units', () => {
    const t = type({ builtin: 'string', length: [{ min: 1n, max: 1n }] });
    expect(checkValue(t, '😀', noIdentities)).toBeUndefined();
    expect(checkValue(t, 'ab', noIdentities)).toBe('length 2 is outside the allowed lengths 1');
  });

  it('checks binary as base64 and its length in octets', () => {
    const t = type({ builtin: 'binary', length: [{ min: 2n, max: 2n }] });
    expect(checkValue(t, 'AAE=', noIdentities)).toBeUndefined();
    expect(checkValue(t, 'AA==', noIdentities)).toBe('length 1 is outside the allowed lengths 2');
    expect(checkValue(t, 'not base64!', noIdentities)).toBe("'not base64!' is not base64");
  });

  it('checks bits names and duplicates', () => {
    const t = type({ builtin: 'bits', bits: [{ name: 'a', position: 0, status: 'current' }, { name: 'b', position: 1, status: 'current' }] });
    expect(checkValue(t, '', noIdentities)).toBeUndefined();
    expect(checkValue(t, 'a b', noIdentities)).toBeUndefined();
    expect(checkValue(t, 'a a', noIdentities)).toBe("bit 'a' appears twice");
    expect(checkValue(t, 'c', noIdentities)).toBe("'c' is not a bit of this type");
  });

  it('checks identityref derivation through the context', () => {
    const base = { name: 'base', module: { name: 'm' }, derived: new Set<Identity>() } as unknown as Identity;
    const dog = { name: 'dog' } as unknown as Identity;
    (base.derived as Set<Identity>).add(dog);
    const t = type({ builtin: 'identityref', bases: [base] });
    const context = { resolveIdentity: (_p: string | undefined, n: string) => (n === 'dog' ? dog : n === 'base' ? base : undefined) };
    expect(checkValue(t, 'x:dog', context)).toBeUndefined();
    expect(checkValue(t, 'base', context)).toBe("'base' is not derived from m:base");
    expect(checkValue(t, 'cat', context)).toBe("'cat' is not a known identity");
  });

  it('tries union members in order', () => {
    const t = type({ builtin: 'union', types: [type({ builtin: 'uint8' }), type({ builtin: 'boolean' })] });
    expect(checkValue(t, '7', noIdentities)).toBeUndefined();
    expect(checkValue(t, 'true', noIdentities)).toBeUndefined();
    expect(checkValue(t, 'x', noIdentities)).toBe("'x' matches none of the union's member types");
  });
});

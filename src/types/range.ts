/**
 * `range` and `length` arguments (RFC 7950 §9.2.4, §9.4.4):
 *
 *   range-arg = range-part *(optsep "|" optsep range-part)
 *   range-part = range-boundary [optsep ".." optsep range-boundary]
 *   range-boundary = "min" / "max" / integer-value / decimal-value
 *
 * Bounds are bigints. For decimal64 they are scaled by 10^fraction-digits,
 * so 1.5 with two fraction digits is 150n.
 */

import type { BuiltinTypeName, Interval } from '../schema/model.js';

const INT_BOUNDS: Partial<Record<BuiltinTypeName, Interval>> = {
  int8: { min: -128n, max: 127n },
  int16: { min: -32768n, max: 32767n },
  int32: { min: -2147483648n, max: 2147483647n },
  int64: { min: -9223372036854775808n, max: 9223372036854775807n },
  uint8: { min: 0n, max: 255n },
  uint16: { min: 0n, max: 65535n },
  uint32: { min: 0n, max: 4294967295n },
  uint64: { min: 0n, max: 18446744073709551615n },
  decimal64: { min: -9223372036854775808n, max: 9223372036854775807n },
};

/** The full range of a numeric built-in type (decimal64 scaled), or undefined for other types. */
export function builtinRange(builtin: BuiltinTypeName): Interval | undefined {
  return INT_BOUNDS[builtin];
}

/** Lengths are non-negative and fit in a uint64. */
export const LENGTH_BOUNDS: Interval = { min: 0n, max: 18446744073709551615n };

const INTEGER = /^[+-]?[0-9]+$/;
const DECIMAL = /^([+-]?)([0-9]+)(?:\.([0-9]+))?$/;

/**
 * Parses a number in the lexical form RFC 7950 allows for the type: an
 * integer, or for decimal64 a decimal with at most `fractionDigits` digits
 * after the point. Returns the (scaled) value, or a message.
 */
export function parseNumber(text: string, decimal: boolean, fractionDigits = 0): bigint | string {
  if (!decimal) {
    if (!INTEGER.test(text)) return `'${text}' is not an integer`;
    return BigInt(text);
  }
  const m = DECIMAL.exec(text);
  if (m === null) return `'${text}' is not a decimal number`;
  const fraction = m[3] ?? '';
  if (fraction.length > fractionDigits) return `'${text}' has more than ${fractionDigits} fraction digits`;
  const scaled = BigInt(m[2]! + fraction.padEnd(fractionDigits, '0'));
  return m[1] === '-' ? -scaled : scaled;
}

/**
 * Parses a range or length argument against the parent's allowed intervals.
 * `min` and `max` mean the parent's lowest and highest values. Returns the
 * intervals, or a message describing the first problem.
 */
export function parseIntervals(text: string, parent: readonly Interval[], decimal: boolean, fractionDigits = 0): Interval[] | string {
  const lowest = parent[0]!.min;
  const highest = parent[parent.length - 1]!.max;
  const bound = (s: string): bigint | string => {
    if (s === 'min') return lowest;
    if (s === 'max') return highest;
    return parseNumber(s, decimal, fractionDigits);
  };
  const out: Interval[] = [];
  for (const part of text.split('|')) {
    const [lo, hi, extra] = part.split('..').map((s) => s.trim());
    if (lo === undefined || lo === '' || hi === '' || extra !== undefined) return `'${part.trim()}' is not a valid range part`;
    const min = bound(lo);
    if (typeof min === 'string') return min;
    const max = hi === undefined ? min : bound(hi);
    if (typeof max === 'string') return max;
    if (max < min) return `'${part.trim()}': the upper bound is below the lower bound`;
    const previous = out[out.length - 1];
    if (previous !== undefined && min <= previous.max) return `'${part.trim()}' is not in ascending order or overlaps the part before it`;
    if (!parent.some((p) => p.min <= min && max <= p.max)) return `'${part.trim()}' is not within the range allowed by the base type`;
    out.push({ min, max });
  }
  return out;
}

export function inIntervals(value: bigint, intervals: readonly Interval[]): boolean {
  return intervals.some((i) => i.min <= value && value <= i.max);
}

/** Renders intervals in YANG syntax, for messages. */
export function formatIntervals(intervals: readonly Interval[], fractionDigits = 0): string {
  const n = (v: bigint): string => {
    if (fractionDigits === 0) return v.toString();
    const neg = v < 0n;
    const digits = (neg ? -v : v).toString().padStart(fractionDigits + 1, '0');
    return `${neg ? '-' : ''}${digits.slice(0, -fractionDigits)}.${digits.slice(-fractionDigits)}`;
  };
  return intervals.map((i) => (i.min === i.max ? n(i.min) : `${n(i.min)}..${n(i.max)}`)).join(' | ');
}

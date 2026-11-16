/**
 * Checks a value in its lexical form (RFC 7950 §9) against a resolved type:
 * the format of the built-in type and every restriction on it.
 *
 * Used for `default` values at compile time and, later, by the codecs.
 */

import type { Identity, YangType } from '../schema/model.js';
import { formatIntervals, inIntervals, LENGTH_BOUNDS, parseNumber, builtinRange } from './range.js';

export interface ValueContext {
  /**
   * Finds an identity by prefix and name. The prefix is undefined for an
   * unprefixed name. The meaning of prefixes depends on where the value is
   * written: module prefixes in a YANG `default`, XML namespace prefixes in
   * XML data, module names in JSON.
   */
  resolveIdentity(prefix: string | undefined, name: string): Identity | undefined;
  /**
   * True when the value is a YANG `default` statement, which may write
   * integers in hexadecimal or octal (RFC 7950 §9.2.1).
   */
  readonly inModule?: boolean;
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const IDENTITY_REF = /^(?:([A-Za-z_][A-Za-z0-9_.-]*):)?([A-Za-z_][A-Za-z0-9_.-]*)$/;

/** Returns undefined when `text` is a valid value of `type`, or a message saying why not. */
export function checkValue(type: YangType, text: string, context: ValueContext): string | undefined {
  switch (type.builtin) {
    case 'int8':
    case 'int16':
    case 'int32':
    case 'int64':
    case 'uint8':
    case 'uint16':
    case 'uint32':
    case 'uint64': {
      const n = parseInteger(text, context.inModule === true);
      if (typeof n === 'string') return n;
      return checkRange(type, n, 0);
    }
    case 'decimal64': {
      const n = parseNumber(text, true, type.fractionDigits ?? 0);
      if (typeof n === 'string') return n;
      return checkRange(type, n, type.fractionDigits ?? 0);
    }
    case 'string':
      return checkLength(type, BigInt(Array.from(text).length)) ?? checkPatterns(type, text);
    case 'binary': {
      const compact = text.replace(/[\s]/g, '');
      if (!BASE64.test(compact)) return `'${text}' is not base64`;
      const octets = (compact.length / 4) * 3 - (compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0);
      return checkLength(type, BigInt(octets));
    }
    case 'boolean':
      return text === 'true' || text === 'false' ? undefined : `'${text}' is not 'true' or 'false'`;
    case 'empty':
      return text === '' ? undefined : 'a value of type empty has no content';
    case 'enumeration':
      return type.enums?.some((e) => e.name === text) === true ? undefined : `'${text}' is not one of the enum values`;
    case 'bits': {
      const names = text.split(/[ \t\r\n]+/).filter((n) => n !== '');
      const seen = new Set<string>();
      for (const n of names) {
        if (type.bits?.some((b) => b.name === n) !== true) return `'${n}' is not a bit of this type`;
        if (seen.has(n)) return `bit '${n}' appears twice`;
        seen.add(n);
      }
      return undefined;
    }
    case 'identityref': {
      const m = IDENTITY_REF.exec(text.trim());
      if (m === null) return `'${text}' is not an identity name`;
      const identity = context.resolveIdentity(m[1], m[2]!);
      if (identity === undefined) return `'${text}' is not a known identity`;
      for (const base of type.bases ?? []) {
        if (!base.derived.has(identity)) return `'${text}' is not derived from ${base.module.name}:${base.name}`;
      }
      return undefined;
    }
    case 'instance-identifier':
      return text.trim().startsWith('/') ? undefined : `'${text}' is not an instance identifier`;
    case 'leafref':
      return type.target === undefined ? undefined : checkValue(type.target.type, text, context);
    case 'union': {
      for (const member of type.types ?? []) {
        if (checkValue(member, text, context) === undefined) return undefined;
      }
      return `'${text}' matches none of the union's member types`;
    }
  }
}

function parseInteger(text: string, inModule: boolean): bigint | string {
  if (/^[+-]?[0-9]+$/.test(text)) {
    if (inModule && /^[+-]?0[0-9]/.test(text)) {
      const neg = text.startsWith('-');
      const digits = text.replace(/^[+-]?0/, '');
      if (!/^[0-7]+$/.test(digits)) return `'${text}' is not a valid octal integer`;
      const v = BigInt(`0o${digits}`);
      return neg ? -v : v;
    }
    return BigInt(text);
  }
  if (inModule && /^[+-]?0x[0-9a-fA-F]+$/.test(text)) {
    const neg = text.startsWith('-');
    const v = BigInt(text.replace(/^[+-]/, ''));
    return neg ? -v : v;
  }
  return `'${text}' is not an integer`;
}

function checkRange(type: YangType, n: bigint, fractionDigits: number): string | undefined {
  const allowed = type.range ?? [builtinRange(type.builtin)!];
  return inIntervals(n, allowed) ? undefined : `value is outside the allowed range ${formatIntervals(allowed, fractionDigits)}`;
}

function checkLength(type: YangType, length: bigint): string | undefined {
  const allowed = type.length ?? [LENGTH_BOUNDS];
  return inIntervals(length, allowed) ? undefined : `length ${length} is outside the allowed lengths ${formatIntervals(allowed)}`;
}

function checkPatterns(type: YangType, text: string): string | undefined {
  for (const p of type.patterns) {
    if (p.regexp.test(text) === p.invert) {
      return p.errorMessage ?? `'${text}' ${p.invert ? 'matches' : 'does not match'} the pattern ${JSON.stringify(p.source)}`;
    }
  }
  return undefined;
}

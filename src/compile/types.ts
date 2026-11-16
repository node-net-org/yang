/**
 * Resolves `type` statements (RFC 7950 §7.3, §9): follows typedef chains to a
 * built-in type and combines the restrictions along the way, checking that
 * each restriction is allowed for the type and no less restrictive than its
 * base.
 */

import { substatement, substatements, type Statement } from '../parse/statement.js';
import type { BitItem, BuiltinTypeName, EnumItem, Identity, Pattern, Typedef, YangType } from '../schema/model.js';
import { parseLeafrefPath } from '../types/path.js';
import { builtinRange, LENGTH_BOUNDS, parseIntervals } from '../types/range.js';
import { compileXsdRegex, XsdRegexError } from '../types/xsd-regex.js';
import type { XsdRegex } from '../types/xsd-match.js';
import { docOf, statusOf, type CompileContext, type Definition, type Mutable, type Scope } from './context.js';

const BUILTINS = new Set<string>([
  'binary', 'bits', 'boolean', 'decimal64', 'empty', 'enumeration', 'identityref', 'instance-identifier',
  'int8', 'int16', 'int32', 'int64', 'leafref', 'string', 'uint8', 'uint16', 'uint32', 'uint64', 'union',
]);

const NUMERIC = new Set<BuiltinTypeName>(['int8', 'int16', 'int32', 'int64', 'uint8', 'uint16', 'uint32', 'uint64', 'decimal64']);

/** Which restriction substatements each built-in type accepts, when used directly and when derived from. */
const RESTRICTIONS: Readonly<Record<string, { direct: readonly string[]; derived: readonly string[] }>> = {
  numeric: { direct: ['range'], derived: ['range'] },
  decimal64: { direct: ['range', 'fraction-digits'], derived: ['range'] },
  string: { direct: ['length', 'pattern'], derived: ['length', 'pattern'] },
  binary: { direct: ['length'], derived: ['length'] },
  enumeration: { direct: ['enum'], derived: ['enum'] },
  bits: { direct: ['bit'], derived: ['bit'] },
  leafref: { direct: ['path', 'require-instance'], derived: ['require-instance'] },
  identityref: { direct: ['base'], derived: [] },
  'instance-identifier': { direct: ['require-instance'], derived: ['require-instance'] },
  union: { direct: ['type'], derived: [] },
  boolean: { direct: [], derived: [] },
  empty: { direct: [], derived: [] },
};

const RESTRICTION_KEYWORDS = new Set(['range', 'length', 'pattern', 'fraction-digits', 'enum', 'bit', 'path', 'require-instance', 'base', 'type']);

export class TypeResolver {
  readonly #typedefs = new Map<Statement, Typedef | 'resolving'>();

  constructor(private readonly ctx: CompileContext) {}

  /** Resolves a `type` statement in its lexical scope. Returns undefined when the type can't be resolved. */
  resolve(typeStatement: Statement, scope: Scope): YangType | undefined {
    const cached = this.ctx.typeCache.get(typeStatement);
    if (cached !== undefined) return cached ?? undefined;
    this.ctx.typeCache.set(typeStatement, null);
    const t = this.#resolve(typeStatement, scope);
    this.ctx.typeCache.set(typeStatement, t ?? null);
    return t;
  }

  /** Resolves a typedef found by lookup. */
  typedef(def: Definition): Typedef | undefined {
    const state = this.#typedefs.get(def.statement);
    if (state === 'resolving') {
      this.ctx.error('typedef-cycle', `typedef '${def.statement.argument ?? ''}' refers to itself`, def.statement);
      return undefined;
    }
    if (state !== undefined) return state;
    this.#typedefs.set(def.statement, 'resolving');
    const s = def.statement;
    const typeStatement = substatement(s, 'type');
    const inner: Scope = { file: def.scope.file, statement: s, parent: def.scope };
    const type = typeStatement === undefined ? undefined : this.resolve(typeStatement, inner);
    if (type === undefined) {
      this.#typedefs.delete(def.statement);
      return undefined;
    }
    const dflt = substatement(s, 'default')?.argument;
    const units = substatement(s, 'units')?.argument;
    const doc = docOf(s);
    const typedef: Typedef = {
      module: this.ctx.compiled.get(def.scope.file.module.key)!,
      name: s.argument ?? '',
      type,
      // A typedef inherits its base typedef's default and units unless it sets its own (RFC 7950 §7.3.4).
      ...(dflt !== undefined ? { default: dflt } : type.typedef?.default !== undefined ? { default: type.typedef.default } : {}),
      ...(units !== undefined ? { units } : type.typedef?.units !== undefined ? { units: type.typedef.units } : {}),
      status: statusOf(s),
      ...(doc.description === undefined ? {} : { description: doc.description }),
    };
    this.#typedefs.set(def.statement, typedef);
    return typedef;
  }

  #resolve(t: Statement, scope: Scope): YangType | undefined {
    const name = t.argument ?? '';
    if (BUILTINS.has(name)) return this.#derive(name, name as BuiltinTypeName, undefined, undefined, t, scope);
    const def = this.ctx.lookup('typedef', name, scope, t);
    if (def === undefined) {
      this.ctx.error('unknown-type', `type '${name}' is not defined`, t);
      return undefined;
    }
    const typedef = this.typedef(def);
    if (typedef === undefined) return undefined;
    return this.#derive(name, typedef.type.builtin, typedef.type, typedef, t, scope);
  }

  /**
   * Builds a type from a base (undefined for a built-in type used directly)
   * plus the restrictions in `t`.
   */
  #derive(name: string, builtin: BuiltinTypeName, base: YangType | undefined, typedef: Typedef | undefined, t: Statement, scope: Scope): YangType | undefined {
    const ctx = this.ctx;
    const direct = base === undefined;
    const group = NUMERIC.has(builtin) && builtin !== 'decimal64' ? 'numeric' : builtin;
    const allowed = direct ? RESTRICTIONS[group]!.direct : RESTRICTIONS[group]!.derived;
    for (const sub of t.substatements) {
      if (RESTRICTION_KEYWORDS.has(sub.keyword) && !allowed.includes(sub.keyword)) {
        ctx.error('invalid-restriction', `'${sub.keyword}' can't restrict ${direct ? 'type' : 'a type derived from'} ${builtin}`, sub);
      }
    }
    const version = scope.file.yangVersion;
    const type: Mutable<YangType> = {
      name,
      builtin,
      ...(typedef === undefined ? {} : { typedef }),
      patterns: [...(base?.patterns ?? [])],
    };
    if (base?.range !== undefined) type.range = base.range;
    if (base?.length !== undefined) type.length = base.length;
    if (base?.fractionDigits !== undefined) type.fractionDigits = base.fractionDigits;
    if (base?.enums !== undefined) type.enums = base.enums;
    if (base?.bits !== undefined) type.bits = base.bits;
    if (base?.types !== undefined) type.types = base.types;
    if (base?.bases !== undefined) type.bases = base.bases;
    if (base?.path !== undefined) type.path = base.path;
    if (base?.requireInstance !== undefined) type.requireInstance = base.requireInstance;

    switch (builtin) {
      case 'decimal64': {
        if (direct) {
          const fd = substatement(t, 'fraction-digits');
          if (fd === undefined) ctx.error('missing-fraction-digits', 'decimal64 needs a fraction-digits substatement', t);
          type.fractionDigits = Number(fd?.argument ?? 1);
        }
        this.#range(type, t);
        break;
      }
      case 'int8':
      case 'int16':
      case 'int32':
      case 'int64':
      case 'uint8':
      case 'uint16':
      case 'uint32':
      case 'uint64':
        this.#range(type, t);
        break;
      case 'string':
        this.#length(type, t);
        for (const p of substatements(t, 'pattern')) {
          const pattern = this.#pattern(p);
          if (pattern !== undefined) (type.patterns as Pattern[]).push(pattern);
        }
        break;
      case 'binary':
        this.#length(type, t);
        break;
      case 'enumeration': {
        const enums = substatements(t, 'enum');
        if (direct && enums.length === 0) ctx.error('missing-enum', 'enumeration needs at least one enum', t);
        if (enums.length > 0) {
          if (!direct && version === '1') ctx.error('invalid-restriction', 'restricting an enumeration needs yang-version 1.1', t);
          type.enums = this.#enums(enums, base?.enums, scope);
        }
        break;
      }
      case 'bits': {
        const bits = substatements(t, 'bit');
        if (direct && bits.length === 0) ctx.error('missing-bit', 'bits needs at least one bit', t);
        if (bits.length > 0) {
          if (!direct && version === '1') ctx.error('invalid-restriction', 'restricting bits needs yang-version 1.1', t);
          type.bits = this.#bits(bits, base?.bits, scope);
        }
        break;
      }
      case 'leafref': {
        if (direct) {
          const p = substatement(t, 'path');
          if (p === undefined) {
            ctx.error('missing-path', 'leafref needs a path substatement', t);
          } else {
            const parsed = parseLeafrefPath(p.argument ?? '');
            if (typeof parsed === 'string') ctx.error('invalid-path', `invalid leafref path ${JSON.stringify(p.argument)}: ${parsed}`, p);
            else type.path = { text: p.argument ?? '', ...parsed, prefixes: scope.file.prefixes };
          }
        }
        const ri = substatement(t, 'require-instance');
        if (ri !== undefined) {
          if (version === '1') ctx.error('invalid-restriction', 'require-instance on a leafref needs yang-version 1.1', ri);
          type.requireInstance = ri.argument === 'true';
        } else if (direct) {
          type.requireInstance = true;
        }
        break;
      }
      case 'instance-identifier': {
        const ri = substatement(t, 'require-instance');
        type.requireInstance = ri === undefined ? (base?.requireInstance ?? true) : ri.argument === 'true';
        break;
      }
      case 'identityref': {
        if (direct) {
          const bases = substatements(t, 'base');
          if (bases.length === 0) ctx.error('missing-base', 'identityref needs a base substatement', t);
          const resolved: Identity[] = [];
          for (const b of bases) {
            const identity = ctx.resolveIdentity(b.argument ?? '', scope.file, b, scope);
            if (identity === undefined) ctx.error('unknown-identity', `base identity '${b.argument ?? ''}' is not defined (or its if-feature is disabled)`, b);
            else resolved.push(identity);
          }
          type.bases = resolved;
        }
        break;
      }
      case 'union': {
        if (direct) {
          const members = substatements(t, 'type');
          if (members.length === 0) ctx.error('missing-type', 'union needs at least one member type', t);
          const resolved: YangType[] = [];
          for (const m of members) {
            const member = this.resolve(m, scope);
            if (member === undefined) continue;
            if (version === '1' && (member.builtin === 'empty' || member.builtin === 'leafref')) {
              ctx.error('invalid-union-member', `a union can't contain ${member.builtin} in yang-version 1`, m);
            }
            resolved.push(member);
          }
          type.types = resolved;
        }
        break;
      }
      case 'boolean':
      case 'empty':
        break;
    }
    return type;
  }

  #range(type: Mutable<YangType>, t: Statement): void {
    const r = substatement(t, 'range');
    if (r === undefined) return;
    const decimal = type.builtin === 'decimal64';
    const parent = type.range ?? [builtinRange(type.builtin)!];
    const result = parseIntervals(r.argument ?? '', parent, decimal, type.fractionDigits ?? 0);
    if (typeof result === 'string') this.ctx.error('invalid-range', `range: ${result}`, r);
    else type.range = result;
  }

  #length(type: Mutable<YangType>, t: Statement): void {
    const l = substatement(t, 'length');
    if (l === undefined) return;
    const result = parseIntervals(l.argument ?? '', type.length ?? [LENGTH_BOUNDS], false);
    if (typeof result === 'string') this.ctx.error('invalid-length', `length: ${result}`, l);
    else type.length = result;
  }

  #pattern(p: Statement): Pattern | undefined {
    let regexp: XsdRegex;
    try {
      regexp = compileXsdRegex(p.argument ?? '');
    } catch (err) {
      if (!(err instanceof XsdRegexError)) throw err;
      this.ctx.error('invalid-pattern', err.message, p);
      return undefined;
    }
    const em = substatement(p, 'error-message')?.argument;
    const tag = substatement(p, 'error-app-tag')?.argument;
    return {
      source: p.argument ?? '',
      regexp,
      invert: substatement(p, 'modifier')?.argument === 'invert-match',
      ...(em === undefined ? {} : { errorMessage: em }),
      ...(tag === undefined ? {} : { errorAppTag: tag }),
    };
  }

  /** Assigns enum values (RFC 7950 §9.6.4.2), or restricts a base enumeration to a subset. */
  #enums(statements: Statement[], base: readonly EnumItem[] | undefined, scope: Scope): EnumItem[] {
    const out: EnumItem[] = [];
    let next = 0;
    let highest: number | undefined;
    for (const e of statements) {
      const name = e.argument ?? '';
      if (out.some((o) => o.name === name)) {
        this.ctx.error('duplicate-enum', `enum '${name}' appears twice`, e);
        continue;
      }
      if (name === '' || name !== name.trim()) this.ctx.error('invalid-enum', 'an enum name must not be empty or have leading or trailing whitespace', e);
      const explicit = substatement(e, 'value')?.argument;
      let value: number;
      if (base !== undefined) {
        const inherited = base.find((b) => b.name === name);
        if (inherited === undefined) {
          this.ctx.error('invalid-restriction', `enum '${name}' is not in the base enumeration`, e);
          continue;
        }
        if (explicit !== undefined && Number(explicit) !== inherited.value) {
          this.ctx.error('invalid-restriction', `enum '${name}' must keep its base value ${inherited.value}`, e);
        }
        value = inherited.value;
      } else if (explicit !== undefined) {
        value = Number(explicit);
      } else {
        if (next > 2147483647) {
          this.ctx.error('enum-value-overflow', `enum '${name}' needs an explicit value: the next value would exceed 2147483647`, e);
          continue;
        }
        value = next;
      }
      if (base === undefined && out.some((o) => o.value === value)) this.ctx.error('duplicate-enum-value', `enum value ${value} is used twice`, e);
      if (!this.ctx.enabled(e, scope.file, scope)) continue;
      highest = highest === undefined ? value : Math.max(highest, value);
      next = highest + 1;
      const doc = docOf(e);
      out.push({ name, value, status: statusOf(e), ...(doc.description === undefined ? {} : { description: doc.description }) });
    }
    return out;
  }

  /** Assigns bit positions (RFC 7950 §9.7.4.2), or restricts base bits to a subset. */
  #bits(statements: Statement[], base: readonly BitItem[] | undefined, scope: Scope): BitItem[] {
    const out: BitItem[] = [];
    let next = 0;
    for (const b of statements) {
      const name = b.argument ?? '';
      if (out.some((o) => o.name === name)) {
        this.ctx.error('duplicate-bit', `bit '${name}' appears twice`, b);
        continue;
      }
      const explicit = substatement(b, 'position')?.argument;
      let position: number;
      if (base !== undefined) {
        const inherited = base.find((x) => x.name === name);
        if (inherited === undefined) {
          this.ctx.error('invalid-restriction', `bit '${name}' is not in the base bits type`, b);
          continue;
        }
        if (explicit !== undefined && Number(explicit) !== inherited.position) {
          this.ctx.error('invalid-restriction', `bit '${name}' must keep its base position ${inherited.position}`, b);
        }
        position = inherited.position;
      } else if (explicit !== undefined) {
        position = Number(explicit);
      } else {
        if (next > 4294967295) {
          this.ctx.error('bit-position-overflow', `bit '${name}' needs an explicit position: the next would exceed 4294967295`, b);
          continue;
        }
        position = next;
      }
      if (base === undefined && out.some((o) => o.position === position)) this.ctx.error('duplicate-bit-position', `bit position ${position} is used twice`, b);
      next = Math.max(next, position + 1);
      if (!this.ctx.enabled(b, scope.file, scope)) continue;
      const doc = docOf(b);
      out.push({ name, position, status: statusOf(b), ...(doc.description === undefined ? {} : { description: doc.description }) });
    }
    return out;
  }
}

/** True when a type contains a leafref, directly or in a union, so that each leaf needs its own copy. */
export function containsLeafref(t: YangType): boolean {
  return t.builtin === 'leafref' || (t.builtin === 'union' && (t.types ?? []).some(containsLeafref));
}

/** A copy of a type whose leafref parts can be given a per-leaf target. Types without leafrefs are shared. */
export function instantiate(t: YangType): YangType {
  if (!containsLeafref(t)) return t;
  return t.builtin === 'union' ? { ...t, types: (t.types ?? []).map(instantiate) } : { ...t };
}


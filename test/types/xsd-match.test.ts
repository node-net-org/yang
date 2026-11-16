/**
 * The linear-time matcher must accept exactly what the native translation
 * accepts. Values are generated from each parsed pattern (so many of them
 * match) and then mutated one character at a time (near misses), and every
 * value is checked against `new RegExp(translateXsdRegex(p), 'v')`.
 *
 * Patterns come from a built-in list that always runs, and from every module
 * in the corpus cache (scripts/fetch-corpus.sh) when it has been fetched.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileXsdRegex, MAX_DFA_STATES, MAX_PATTERN_SIZE, parseModule, translateXsdRegex, XsdRegexError, type Statement } from '../../src/index.js';
import { parseXsdRegex, type XsdRegexNode } from '../../src/types/xsd-regex.js';

const CACHE = join(import.meta.dirname, '..', 'corpus', '.cache');

/** Patterns from IETF, OpenConfig and SR OS modules, and some made to be awkward. */
const BUILT_IN = [
  // ietf-inet-types
  '(([0-9]|[1-9][0-9]|1[0-9][0-9]|2[0-4][0-9]|25[0-5])\\.){3}([0-9]|[1-9][0-9]|1[0-9][0-9]|2[0-4][0-9]|25[0-5])(%[\\p{N}\\p{L}]+)?',
  '((:|[0-9a-fA-F]{0,4}):)([0-9a-fA-F]{0,4}:){0,5}((([0-9a-fA-F]{0,4}:)?(:|[0-9a-fA-F]{0,4}))|(((25[0-5]|2[0-4][0-9]|[01]?[0-9]?[0-9])\\.){3}(25[0-5]|2[0-4][0-9]|[01]?[0-9]?[0-9])))(%[\\p{N}\\p{L}]+)?',
  '((([a-zA-Z0-9_]([a-zA-Z0-9\\-_]){0,61})?[a-zA-Z0-9]\\.)*([a-zA-Z0-9_]([a-zA-Z0-9\\-_]){0,61})?[a-zA-Z0-9]\\.?)|\\.',
  // ietf-yang-types
  '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[\\+\\-]\\d{2}:\\d{2})',
  '[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){5}',
  '(([0-1](\\.[1-3]?[0-9]))|(2\\.(0|([1-9]\\d*))))(\\.(0|([1-9]\\d*)))*',
  // OpenConfig and SR OS
  '[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?([.][a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*',
  '([^%]+|%[nsStTcC%])+',
  '([01]|(\\*[0123456789]+)?[oismpvc])+',
  '\\d*(\\.\\d*){1,127}',
  // Awkward
  '',
  'a{0}',
  '(a*)*',
  '(a|a)*b',
  '(|a)+',
  '()*x',
  '(a?){3}a{3}',
  'x{2,4}y{0,1}z{3}',
  '(ab|c){1,5}',
  '[a-z-[aeiou]]+\\d?',
  '[^0-9-[5]]*',
  '\\i\\c*',
  '.*😀.?',
  '\\p{Lu}\\P{L}*',
  '(a|b)*a(a|b){12}',
];

/** Characters values are built from when a class has to be sampled. */
const POOL = Array.from(
  ' \t\n\r!"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGZ[\\]^_`abcdefxyz{|}~ é٣ΩЖ中😀‌́',
);

const classTesters = new Map<string, RegExp>();
function inClass(source: string, ch: string): boolean {
  let r = classTesters.get(source);
  if (r === undefined) classTesters.set(source, (r = new RegExp(`^${source}$`, 'v')));
  return r.test(ch);
}

function random(seed: number): (n: number) => number {
  let s = seed;
  return (n) => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s % n;
  };
}

/** A value the pattern should match, or undefined when a class has no member in the pool. */
function generate(n: XsdRegexNode, rnd: (n: number) => number): string | undefined {
  switch (n.kind) {
    case 'char':
      return String.fromCodePoint(n.cp);
    case 'set': {
      const members = POOL.filter((c) => inClass(n.source, c));
      return members.length === 0 ? undefined : members[rnd(members.length)];
    }
    case 'group':
      return generate(n.inner, rnd);
    case 'alt':
      return generate(n.branches[rnd(n.branches.length)]!, rnd);
    case 'seq': {
      let out = '';
      for (const item of n.items) {
        const s = generate(item, rnd);
        if (s === undefined) return undefined;
        out += s;
      }
      return out;
    }
    case 'repeat': {
      // Usually a few more than the minimum; sometimes exactly the maximum, where off-by-one errors live.
      const atMax = n.max !== undefined && n.max - n.min <= 64 && rnd(4) === 0;
      const count = atMax ? n.max : n.min + rnd(Math.min(n.max ?? n.min + 3, n.min + 3) - n.min + 1);
      let out = '';
      for (let i = 0; i < count; i++) {
        const s = generate(n.atom, rnd);
        if (s === undefined) return undefined;
        out += s;
      }
      return out;
    }
  }
}

/** Generated values, and each with one character inserted, deleted or replaced. */
function values(pattern: string, seed: number): string[] {
  const rnd = random(seed);
  const root = parseXsdRegex(pattern);
  const out = new Set<string>(['']);
  for (let i = 0; i < 20; i++) {
    const v = generate(root, rnd);
    if (v === undefined) continue;
    out.add(v);
    const chars = Array.from(v);
    for (let j = 0; j < 4; j++) {
      const at = rnd(chars.length + 1);
      const c = POOL[rnd(POOL.length)]!;
      const kind = rnd(3);
      const m = chars.slice();
      if (kind === 0) m.splice(at, 0, c);
      else if (kind === 1) m.splice(at, 1);
      else m.splice(at, 1, c);
      out.add(m.join(''));
    }
  }
  return [...out];
}

/** Values where the two engines disagree, as `pattern / value / matcher's answer`. */
function disagreements(patterns: Iterable<string>): { checked: number; matched: number; wrong: string[] } {
  let checked = 0;
  let matched = 0;
  const wrong: string[] = [];
  let seed = 1;
  for (const p of patterns) {
    const mine = compileXsdRegex(p);
    const native = new RegExp(translateXsdRegex(p), 'v');
    for (const v of values(p, seed++)) {
      checked++;
      const expected = native.test(v);
      if (expected) matched++;
      if (mine.test(v) !== expected) wrong.push(`${JSON.stringify(p)} / ${JSON.stringify(v)} / ${!expected}`);
    }
  }
  return { checked, matched, wrong };
}

function corpusPatterns(): Set<string> {
  const out = new Set<string>();
  const walk = (s: Statement): void => {
    if (s.keyword === 'pattern' && s.argument !== undefined) out.add(s.argument);
    for (const c of s.substatements) walk(c);
  };
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) visit(path);
      else if (entry.endsWith('.yang')) walk(parseModule(readFileSync(path)).statement);
    }
  };
  for (const set of ['yangmodels', 'openconfig', 'nokia']) {
    if (existsSync(join(CACHE, set))) visit(join(CACHE, set));
  }
  return out;
}

describe('linear-time XSD matcher', () => {
  it('agrees with the native translation on built-in patterns', () => {
    const { checked, matched, wrong } = disagreements(BUILT_IN);
    expect(wrong).toEqual([]);
    expect(matched).toBeGreaterThan(checked / 4);
  });

  it.skipIf(!existsSync(CACHE))('agrees with the native translation on every pattern in the corpus', () => {
    const patterns = corpusPatterns();
    expect(patterns.size).toBeGreaterThan(100);
    const { checked, matched, wrong } = disagreements(patterns);
    expect(wrong.slice(0, 10)).toEqual([]);
    expect(matched).toBeGreaterThan(checked / 4);
  });

  it('takes linear time where backtracking takes exponential time', () => {
    const cases: [string, string, boolean][] = [
      ['([^%]+|%[nsStTcC%])+', 'a'.repeat(100_000) + '%', false],
      ['(a|a)*b', 'a'.repeat(100_000), false],
      ['(a*)*b', 'a'.repeat(100_000), false],
      ['(([a-z0-9_\\-]){1,63}\\.)*([a-z0-9_\\-]){1,63}', 'a.'.repeat(50_000) + '!', false],
      ['\\d*(\\.\\d*){1,127}', '1.'.repeat(100) + '1', true],
    ];
    for (const [pattern, value, expected] of cases) {
      const r = compileXsdRegex(pattern);
      const started = performance.now();
      expect(r.test(value)).toBe(expected);
      expect(performance.now() - started, pattern).toBeLessThan(500);
    }
  });

  it('keeps matching correctly once its state cache is full', () => {
    // A DFA for this needs 2^13 states, more than MAX_DFA_STATES.
    const pattern = '(a|b)*a(a|b){12}';
    const mine = compileXsdRegex(pattern);
    const native = new RegExp(translateXsdRegex(pattern), 'v');
    const rnd = random(7);
    let cache = '';
    for (let i = 0; i < MAX_DFA_STATES * 4; i++) cache += 'ab'[rnd(2)];
    expect(mine.test(cache)).toBe(native.test(cache));
    for (let i = 0; i < 200; i++) {
      let v = '';
      const len = 13 + rnd(40);
      for (let j = 0; j < len; j++) v += 'ab'[rnd(2)];
      expect(mine.test(v), v).toBe(native.test(v));
    }
  });

  it('walks values by code point', () => {
    expect(compileXsdRegex('.').test('😀')).toBe(true);
    expect(compileXsdRegex('..').test('😀')).toBe(false);
    expect(compileXsdRegex('.').test('\uD800')).toBe(true);
    expect(compileXsdRegex('[😀-😂]{2}').test('😁😂')).toBe(true);
  });

  it('keeps the pattern as written', () => {
    expect(compileXsdRegex('\\d+').source).toBe('\\d+');
  });

  it(`rejects patterns needing more than ${MAX_PATTERN_SIZE} instructions`, () => {
    expect(() => compileXsdRegex('[a-z]{1,1983}')).not.toThrow();
    for (const pattern of ['a{100000}', '(a{1000}){1000}', 'a{99999999999999999999}', 'a{5,99999999999999999999}', '(){99999999999}', '(a{0}){99999999999}']) {
      expect(() => compileXsdRegex(pattern), pattern).toThrow(XsdRegexError);
      expect(() => compileXsdRegex(pattern), pattern).toThrow('too large to match safely');
    }
  });
});

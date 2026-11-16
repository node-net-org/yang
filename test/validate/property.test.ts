import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import { beforeAll, describe, expect, it } from 'vitest';
import { decodeJson, decodeXml, encodeJson, toXml, validate, type Schema } from '../../src/index.js';
import { compile } from '../compile/support.js';

const VX = readFileSync(join(import.meta.dirname, '..', 'fixtures', 'validate', 'vx.yang'), 'utf8');
let vx: Schema;
beforeAll(async () => {
  vx = await compile([VX]);
});

const name = fc.constantFrom('a', 'b', 'c', 'd');
const opt = <T>(a: fc.Arbitrary<T>): fc.Arbitrary<T | undefined> => fc.option(a, { nil: undefined });

/** Random content for vx:c, valid or not: every rule vx exercises can break. */
const content = fc
  .record({
    ratio: opt(fc.integer({ min: 0, max: 255 })),
    mode: opt(fc.constantFrom('simple', 'advanced')),
    'advanced-x': opt(fc.constant('x')),
    ref: opt(name),
    val: opt(fc.integer({ min: 0, max: 30 })),
    iid: opt(name.map((n) => `/vx:c/item[name='${n}']/value`)),
    tag: opt(fc.array(fc.constantFrom('x', 'y', 'z'), { maxLength: 5 })),
    item: opt(
      fc.uniqueArray(
        fc.record({ name, value: opt(fc.constantFrom(10, 20, 2000)), sub: opt(fc.record({ x: opt(fc.constantFrom('p', 'q')) })) }, { requiredKeys: ['name'] }),
        { selector: (i) => i.name, maxLength: 4 },
      ),
    ),
    np: opt(fc.record({ need: opt(fc.constant('n')) })),
    pres: opt(fc.record({ need: opt(fc.constant('n')) })),
    'one-a': opt(fc.constant('a')),
    'one-b': opt(fc.constant('b')),
    'two-a': opt(fc.constant('t')),
    st: opt(fc.record({ seen: opt(fc.array(fc.constant('s'), { maxLength: 2 })), req: opt(fc.constant('r')) })),
  })
  .map((c) => JSON.parse(JSON.stringify({ 'vx:c': c })) as object);

const summary = (issues: ReturnType<typeof validate>): string[] => issues.map((i) => `${i.severity} ${i.code} ${i.path}`);

describe('validation properties', () => {
  it('finds the same issues after an XML ↔ JSON round trip, and leaves the tree as it was', () => {
    fc.assert(
      fc.property(content, (data) => {
        const tree = decodeJson(vx, data);
        const before = encodeJson(tree);
        const issues = summary(validate(tree));
        expect(encodeJson(tree)).toEqual(before);
        const again = decodeXml(vx, toXml(tree));
        expect(summary(validate(again))).toEqual(issues);
        expect(summary(validate(decodeJson(vx, encodeJson(again))))).toEqual(issues);
      }),
      { numRuns: 300 },
    );
  });

  it('reports nothing as an error in partial mode that it would not report otherwise', () => {
    fc.assert(
      fc.property(content, (data) => {
        const full = new Set(summary(validate(decodeJson(vx, data))));
        for (const s of summary(validate(decodeJson(vx, data), { partial: true }))) expect(full.has(s)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});

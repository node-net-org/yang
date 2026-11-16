// Random documents over test/fixtures/validate/vx.yang, mostly valid but each
// liable to break a rule or two, for scripts/yanglint-oracle.sh to judge and
// test/validate/random.test.ts to compare with @node-net/yang. The seed is fixed,
// so the same samples come out every time.
//   node scripts/validate-samples.mjs <out-dir> [count]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';

const [out, count = '400'] = process.argv.slice(2);
if (out === undefined) throw new Error('usage: validate-samples.mjs <out-dir> [count]');

const name = fc.constantFrom('a', 'b', 'c', 'd');
const opt = (a) => fc.option(a, { nil: undefined });
const usually = (v, w = 12) => fc.oneof({ weight: w, arbitrary: fc.constant(v) }, { weight: 1, arbitrary: fc.constant(undefined) });
const rarely = (a, w = 12) => fc.oneof({ weight: w, arbitrary: fc.constant(undefined) }, { weight: 1, arbitrary: a });
const content = fc.record({
  ratio: fc.oneof({ weight: 12, arbitrary: fc.integer({ min: 0, max: 100 }) }, { weight: 1, arbitrary: fc.integer({ min: 101, max: 255 }) }),
  mode: opt(fc.constantFrom('simple', 'advanced')),
  'advanced-x': rarely(fc.constant('x'), 3),
  ref: usually('a'),
  val: fc.oneof({ weight: 12, arbitrary: fc.constant(10) }, { weight: 1, arbitrary: fc.integer({ min: 0, max: 30 }) }),
  iid: fc.oneof({ weight: 12, arbitrary: fc.constant("/vx:c/item[name='a']/value") }, { weight: 1, arbitrary: name.map((n) => `/vx:c/item[name='${n}']/value`) }),
  tag: opt(fc.uniqueArray(fc.constantFrom('x', 'y', 'z', 'w'), { maxLength: 4 })),
  item: fc
    .uniqueArray(fc.record({ name, value: opt(fc.integer({ min: 9, max: 12 })), sub: opt(fc.record({ x: opt(fc.constantFrom('p', 'q')) })) }, { requiredKeys: ['name'] }), {
      selector: (i) => i.name,
      maxLength: 4,
    })
    .map((l) => [{ name: 'a', value: 10 }, ...l.filter((i) => i.name !== 'a')]),
  np: usually({ need: 'n' }),
  pres: rarely(fc.record({ need: opt(fc.constant('n')) }), 4),
  'one-a': rarely(fc.constant('a'), 4),
  'one-b': usually('b'),
  'two-a': rarely(fc.constant('t')),
  st: usually({ seen: ['s', 's'], req: 'r' }),
});

mkdirSync(out, { recursive: true });
fc.sample(content, { numRuns: Number(count), seed: 7 }).forEach((c, i) => {
  writeFileSync(join(out, `sample-${i}.json`), `${JSON.stringify({ 'vx:c': JSON.parse(JSON.stringify(c)) })}\n`);
});
console.log(`${count} samples in ${out}`);

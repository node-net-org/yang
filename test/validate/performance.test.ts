/**
 * Validation stays roughly linear on large lists: leafrefs with and without
 * predicates, unique, must, and defaults guarded by when on every entry.
 * The target is a few hundred thousand nodes in a few seconds; the bound
 * here is loose so that slow machines pass, while a quadratic regression
 * (which took 25 seconds at this size) fails.
 */
import { describe, expect, it } from 'vitest';
import { decodeJson, validate } from '../../src/index.js';
import { compile, mod } from '../compile/support.js';

const BODY = `container c {
  list item {
    key name;
    unique "code";
    must "code < 4000000000";
    leaf name { type string; }
    leaf code { type uint32; }
    leaf peer { type leafref { path "../../item/name"; } }
    leaf peer-code { type leafref { path "../../item[name = current()/../peer]/code"; } }
    leaf even { when "../code mod 2 = 0"; type string; default "yes"; }
  }
}`;

describe('validation performance', () => {
  it('validates 40,000 list entries (about 240,000 nodes with defaults) in seconds', async () => {
    const schema = await compile([mod('pf', BODY)]);
    const n = 40_000;
    const item = Array.from({ length: n }, (_, i) => ({ name: `n${i}`, code: i, peer: `n${(i * 7) % n}`, 'peer-code': (i * 7) % n }));
    item[123]!['peer-code'] = 5;
    const tree = decodeJson(schema, { 'pf:c': { item } });
    const start = performance.now();
    const issues = validate(tree, { keepDefaults: true });
    const elapsed = performance.now() - start;
    expect(issues.map((i) => [i.code, i.path])).toEqual([['missing-instance', "/pf:c/item[name='n123']/peer-code"]]);
    // Half the entries got the default: the others' when is false.
    let defaults = 0;
    for (const node of tree.walk()) if (node.isDefault) defaults++;
    expect(defaults).toBe(n / 2);
    expect(elapsed).toBeLessThan(8000);
  }, 30_000);
});

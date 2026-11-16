/**
 * Edits and diffs stay roughly linear on large lists. 40,000 entries (half
 * new, the ordered-by-user half needing a move or an anchored insert each)
 * take about a second on a laptop; the bound is loose so that slow machines
 * pass, while the quadratic versions (45 seconds at this size) fail.
 */
import { describe, expect, it } from 'vitest';
import { applyEdit, diffEdit, diffTrees, encodeJson } from '../../src/index.js';
import { data, edit, edSchema } from './support.js';

describe('edit performance', () => {
  it('merges, diffs and re-applies 40,000 list entries in seconds', async () => {
    const schema = await edSchema();
    const n = 20_000;
    const target = data(schema, {
      'ed:sys': { user: Array.from({ length: n }, (_, i) => ({ name: `u${i}`, uid: i })), iface: Array.from({ length: n }, (_, i) => ({ name: `e${i}`, unit: 0 })) },
    });
    const change = edit(schema, {
      'ed:sys': { user: Array.from({ length: n }, (_, i) => ({ name: `u${i * 2}`, uid: 1 })), iface: Array.from({ length: n }, (_, i) => ({ name: `e${i}`, unit: 1 })) },
    });
    const started = performance.now();
    const result = applyEdit(target, change);
    const changes = diffTrees(target, result);
    const again = applyEdit(target, diffEdit(target, result));
    const elapsed = performance.now() - started;
    expect(changes).toHaveLength(2 * n);
    expect(encodeJson(again)).toEqual(encodeJson(result));
    expect(elapsed).toBeLessThan(10_000);
  }, 60_000);
});

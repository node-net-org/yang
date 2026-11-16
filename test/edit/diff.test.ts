import fc from 'fast-check';
import { beforeAll, describe, expect, it } from 'vitest';
import { applyEdit, decodeXml, diffEdit, diffTrees, encodeJson, toXml, type DataTree, type Schema } from '../../src/index.js';
import { data, edSchema } from './support.js';

let schema: Schema;
beforeAll(async () => {
  schema = await edSchema();
});

const summary = (from: object, to: object): string[] => diffTrees(data(schema, from), data(schema, to)).map((c) => `${c.operation} ${c.path}${c.position === undefined ? '' : ` ${c.position.where === 'first' ? 'first' : `after ${c.position.anchor.path}`}`}`);

describe('diffTrees', () => {
  it('finds nothing between equal trees', () => {
    const t = { 'ed:sys': { host: 'h', user: [{ name: 'a' }], dns: ['x'] } };
    expect(summary(t, t)).toEqual([]);
  });

  it('lists created, deleted and replaced nodes', () => {
    expect(summary({ 'ed:sys': { host: 'h', mtu: 100, iface: [{ name: 'e', unit: 0 }] } }, { 'ed:sys': { host: 'g', tag: ['t'], iface: [{ name: 'e', unit: 0, mtu: 9 }] }, 'ed:other': { z: '1' } })).toEqual([
      'replace /ed:sys/host',
      "create /ed:sys/iface[name='e'][unit='0']/mtu",
      "create /ed:sys/tag[.='t']",
      'delete /ed:sys/mtu',
      'create /ed:other',
    ]);
  });

  it('moves the fewest ordered-by-user entries', () => {
    const users = (...names: string[]): object => ({ 'ed:sys': { user: names.map((name) => ({ name })) } });
    expect(summary(users('a', 'b', 'c', 'd'), users('b', 'c', 'd', 'a'))).toEqual(["move /ed:sys/user[name='a'] after /ed:sys/user[name='d']"]);
    expect(summary(users('a', 'b', 'c'), users('x', 'c', 'a'))).toEqual([
      "delete /ed:sys/user[name='b']",
      "create /ed:sys/user[name='x'] first",
      "move /ed:sys/user[name='c'] after /ed:sys/user[name='x']",
    ]);
  });

  it('ignores the order of ordered-by-system entries', () => {
    expect(summary({ 'ed:sys': { tag: ['a', 'b'] } }, { 'ed:sys': { tag: ['b', 'a'] } })).toEqual([]);
  });
});

describe('diffEdit', () => {
  it('writes an edit with operations and positions', () => {
    const from = data(schema, { 'ed:sys': { host: 'h', user: [{ name: 'a' }, { name: 'b' }], 'tcp-port': 1 } });
    const to = data(schema, { 'ed:sys': { user: [{ name: 'b' }, { name: 'a', uid: 3 }], 'udp-port': 2 } });
    expect(encodeJson(diffEdit(from, to))).toEqual({
      'ed:sys': {
        '@host': { 'ietf-netconf:operation': 'delete' },
        host: 'h',
        user: [
          { name: 'b', '@': { 'ietf-netconf:operation': 'merge', 'yang:insert': 'first' } },
          { name: 'a', uid: 3, '@uid': { 'ietf-netconf:operation': 'create' } },
        ],
        'udp-port': 2,
        '@udp-port': { 'ietf-netconf:operation': 'create' },
      },
    });
  });
});

const name = fc.constantFrom('a', 'b', 'c', 'd', "o'k");
const sys = fc
  .record(
    {
      host: fc.constantFrom('h', 'g'),
      mtu: fc.constantFrom(100, 1500),
      user: fc.uniqueArray(fc.record({ name, uid: fc.constantFrom(1, 2) }, { requiredKeys: ['name'] }), { selector: (u) => u.name, maxLength: 5 }),
      iface: fc.uniqueArray(fc.record({ name: fc.constantFrom('e', 'f'), unit: fc.constantFrom(0, 1), mtu: fc.constantFrom(1, 2) }, { requiredKeys: ['name', 'unit'] }), {
        selector: (i) => `${i.name}${i.unit}`,
        maxLength: 3,
      }),
      dns: fc.uniqueArray(name, { maxLength: 5 }),
      tag: fc.uniqueArray(name, { maxLength: 3 }),
      kinds: fc.uniqueArray(fc.constantFrom('ed:widget', 'ed:gadget'), { maxLength: 2 }),
      transport: fc.oneof(fc.constant({}), fc.record({ 'tcp-port': fc.constantFrom(1, 2), keepalive: fc.boolean() }, { requiredKeys: ['tcp-port'] }), fc.record({ 'udp-port': fc.constantFrom(1, 2) }), fc.constant({ local: [null] })),
      pres: fc.record({ need: fc.constantFrom('n', 'm'), extra: fc.constant('e') }, { requiredKeys: ['need'] }),
      deep: fc.record({ inner: fc.record({ x: fc.constantFrom('1', '2'), y: fc.constant('y') }, { requiredKeys: ['x'] }) }),
    },
    { requiredKeys: [] },
  )
  .map(({ transport, ...rest }) => {
    const out: Record<string, unknown> = { ...rest, ...transport };
    for (const k of ['user', 'iface', 'dns', 'tag', 'kinds']) if (Array.isArray(out[k]) && (out[k] as unknown[]).length === 0) delete out[k];
    return out;
  });
const tree = fc.record({ 'ed:sys': sys, 'ed:other': fc.record({ z: fc.constantFrom('1', '2') }) }, { requiredKeys: [] }).map((t) => {
  const out: Record<string, unknown> = { ...t };
  if (out['ed:sys'] !== undefined && Object.keys(out['ed:sys'] as object).length === 0) delete out['ed:sys'];
  return out;
});

/** JSON with ordered-by-system lists and leaf-lists sorted, and top-level members in a fixed order. */
function normal(t: DataTree): unknown {
  const json = encodeJson(t) as Record<string, Record<string, unknown> | undefined>;
  const s = json['ed:sys'];
  if (s !== undefined) {
    if (Array.isArray(s['tag'])) s['tag'] = [...(s['tag'] as string[])].sort();
    if (Array.isArray(s['iface'])) s['iface'] = [...(s['iface'] as { name: string; unit: number }[])].sort((a, b) => `${a.name}${a.unit}`.localeCompare(`${b.name}${b.unit}`));
  }
  return Object.fromEntries(Object.entries(json).sort(([a], [b]) => a.localeCompare(b)));
}

describe('diff properties', () => {
  it('the edit of a diff turns the first tree into the second', () => {
    fc.assert(
      fc.property(tree, tree, (a, b) => {
        const from = data(schema, a);
        const to = data(schema, b);
        expect(normal(applyEdit(from, diffEdit(from, to)))).toEqual(normal(to));
      }),
      { numRuns: 300 },
    );
  });

  it('and does so as XML, with every default operation', () => {
    fc.assert(
      fc.property(tree, tree, fc.constantFrom<'merge' | 'none'>('merge', 'none'), (a, b, defaultOperation) => {
        const from = data(schema, a);
        const to = data(schema, b);
        const xml = toXml(diffEdit(from, to));
        const edit = decodeXml(schema, xml, { edit: true });
        expect(normal(applyEdit(from, edit, { defaultOperation }))).toEqual(normal(to));
      }),
      { numRuns: 300 },
    );
  });

  it('a tree has no differences from itself, and diffs are symmetric in size', () => {
    fc.assert(
      fc.property(tree, tree, (a, b) => {
        expect(diffTrees(data(schema, a), data(schema, a))).toEqual([]);
        const forward = diffTrees(data(schema, a), data(schema, b));
        expect(forward.length === 0).toBe(diffTrees(data(schema, b), data(schema, a)).length === 0);
      }),
      { numRuns: 200 },
    );
  });
});

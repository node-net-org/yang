/** Merging data trees (VALIDATE-10): configuration with state, as <operational> and <get> combine them. */
import { beforeAll, describe, expect, it } from 'vitest';
import { decodeJson, encodeJson, mergeTrees, toXml, ContainerInstance, DataTree, LeafInstance, ListEntry, type Schema } from '../../src/index.js';
import { compile, mod } from '../compile/support.js';

const M = mod(
  'm',
  `
  import ietf-origin { prefix or; }
  container interfaces {
    list interface {
      key name;
      leaf name { type string; }
      leaf mtu { type uint16; }
      leaf-list tag { type string; }
      anydata extra;
      container counters { config false; leaf in { type uint64; } }
    }
  }
  container system { config false; leaf uptime { type uint32; } }
`,
);

let schema: Schema;
let op: Schema;

beforeAll(async () => {
  schema = await compile([M], { implement: ['m', 'ietf-origin'] });
  expect(schema.errors).toEqual([]);
  op = schema.forDatastore('operational');
});

const running = (): DataTree =>
  decodeJson(schema.forDatastore('running'), {
    'm:interfaces': { interface: [{ name: 'eth0', mtu: 1500, tag: ['a'] }, { name: 'eth1', mtu: 9000 }] },
  });

describe('VALIDATE-10: merge data trees, configuration and state, into one', () => {
  it('AC1: returns a new tree with every node, leaving the inputs unchanged', () => {
    const target = running();
    const state = decodeJson(op, { 'm:system': { uptime: 5 } });
    const before = [toXml(target), toXml(state)];
    const out = mergeTrees(target, state);
    expect(encodeJson(out)).toEqual({
      'm:interfaces': { interface: [{ name: 'eth0', mtu: 1500, tag: ['a'] }, { name: 'eth1', mtu: 9000 }] },
      'm:system': { uptime: 5 },
    });
    expect([toXml(target), toXml(state)]).toEqual(before);
    expect(out).not.toBe(target);
  });

  it('AC2: containers by schema, entries by keys, leaf-list entries by value; new nodes in schema order', () => {
    const src = decodeJson(op, {
      'm:interfaces': { interface: [{ name: 'eth1', tag: ['x'] }, { name: 'eth2', mtu: 1280 }, { name: 'eth0', tag: ['a', 'b'] }] },
    });
    expect(encodeJson(mergeTrees(running(), src))).toEqual({
      'm:interfaces': {
        interface: [
          { name: 'eth0', mtu: 1500, tag: ['a', 'b'] },
          { name: 'eth1', mtu: 9000, tag: ['x'] },
          { name: 'eth2', mtu: 1280 },
        ],
      },
    });
  });

  it('AC3: later sources win for leaves, anydata and annotations', () => {
    const a = decodeJson(op, { 'm:interfaces': { interface: [{ name: 'eth0', mtu: 1400, extra: { x: 1 } }] } });
    const b = decodeJson(op, {
      'm:interfaces': { interface: [{ name: 'eth0', mtu: 1300, extra: { y: 2 }, '@mtu': { 'ietf-origin:origin': 'ietf-origin:learned' } }] },
    });
    const out = encodeJson(mergeTrees(running(), a, b)) as { 'm:interfaces': { interface: Record<string, unknown>[] } };
    expect(out['m:interfaces'].interface[0]).toMatchObject({ name: 'eth0', mtu: 1300, extra: { y: 2 }, '@mtu': { 'ietf-origin:origin': 'ietf-origin:learned' } });
    const c = decodeJson(op, { 'm:interfaces': { interface: [{ name: 'eth0', mtu: 1300, '@mtu': { 'ietf-origin:origin': 'ietf-origin:system' } }] } });
    const again = encodeJson(mergeTrees(mergeTrees(running(), b), c)) as { 'm:interfaces': { interface: Record<string, unknown>[] } };
    expect(again['m:interfaces'].interface[0]!['@mtu']).toEqual({ 'ietf-origin:origin': 'ietf-origin:system' });
  });

  it('AC4: state merges into configuration list entries, from another datastore schema', () => {
    const state = decodeJson(op, { 'm:interfaces': { interface: [{ name: 'eth1', counters: { in: '7' } }] } });
    const out = mergeTrees(running(), state);
    expect(encodeJson(out)).toEqual({
      'm:interfaces': { interface: [{ name: 'eth0', mtu: 1500, tag: ['a'] }, { name: 'eth1', mtu: 9000, counters: { in: '7' } }] },
    });
    // Into an operational target as well.
    expect(encodeJson(mergeTrees(new DataTree(op), running(), state))).toEqual(encodeJson(out));
  });

  it('AC5: merging state into about 100,000 nodes takes well under a second', () => {
    const big = new DataTree(op);
    const ifs = big.append(new ContainerInstance(schema.find('/m:interfaces') as never));
    const list = schema.find('/m:interfaces/interface') as never as ListEntry['schema'];
    const nameS = schema.find('/m:interfaces/interface/name') as never as LeafInstance['schema'];
    const mtuS = schema.find('/m:interfaces/interface/mtu') as never as LeafInstance['schema'];
    const json: { name: string; counters: { in: string } }[] = [];
    for (let i = 0; i < 33_000; i++) {
      const e = ifs.append(new ListEntry(list));
      e.append(new LeafInstance(nameS, { type: nameS.type, value: `if${i}` }));
      e.append(new LeafInstance(mtuS, { type: mtuS.type, value: 1500 }));
      json.push({ name: `if${i}`, counters: { in: String(i) } });
    }
    const state = decodeJson(op, { 'm:interfaces': { interface: json } });
    const start = performance.now();
    const out = mergeTrees(big, state);
    const elapsed = performance.now() - start;
    const entries = (out.children[0] as ContainerInstance).children;
    expect(entries).toHaveLength(33_000);
    expect(encodeJson(entries[32_999]!)).toMatchObject({ 'm:interface': [{ name: 'if32999', mtu: 1500, counters: { in: '32999' } }] });
    expect(elapsed).toBeLessThan(1000);
  });
});

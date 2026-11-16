import { beforeAll, describe, expect, it } from 'vitest';
import type { Schema } from '../../src/index.js';
import { compile, mod } from '../compile/support.js';
import { apply, failure } from './support.js';

// VALIDATE-11: a server editing the state it holds in <operational>.
const m = mod(
  'm',
  `container ifs {
    list if {
      key name;
      leaf name { type string; }
      leaf mtu { type uint16; }
      container stats {
        config false;
        leaf in { type uint32; }
        leaf out { type uint32; }
      }
      leaf oper { config false; type string; }
    }
  }
  container clock { config false; leaf now { type string; } leaf zone { type string; } }`,
);

let op: Schema;
let running: Schema;
beforeAll(async () => {
  const full = await compile([m], { implement: ['m'] });
  op = full.forDatastore('operational');
  running = full.forDatastore('running');
});

const target = { 'm:ifs': { if: [{ name: 'a', mtu: 1500, oper: 'up', stats: { in: 1, out: 2 } }] }, 'm:clock': { now: '12:00', zone: 'UTC' } };

describe('VALIDATE-11 edit the state data a server holds', () => {
  it('creates, merges, replaces, deletes and removes state nodes with the state option', () => {
    const state = { state: true };
    expect(apply(op, target, { 'm:ifs': { if: [{ name: 'a', stats: { in: 5 } }] } }, state)).toEqual({
      'm:ifs': { if: [{ name: 'a', mtu: 1500, stats: { in: 5, out: 2 }, oper: 'up' }] },
      'm:clock': { now: '12:00', zone: 'UTC' },
    });
    expect(apply(op, target, { 'm:ifs': { if: [{ name: 'b', oper: 'down' }] } }, state)).toMatchObject({ 'm:ifs': { if: [{ name: 'a' }, { name: 'b', oper: 'down' }] } });
    expect(apply(op, target, { 'm:clock': { '@zone': { 'ietf-netconf:operation': 'delete' }, zone: null } }, state)).toMatchObject({ 'm:clock': { now: '12:00' } });
    expect(apply(op, target, { 'm:clock': { '@': { 'ietf-netconf:operation': 'remove' } } }, state)).not.toHaveProperty('m:clock');
    expect(failure(op, target, { 'm:clock': { '@': { 'ietf-netconf:operation': 'create' }, now: '1' } }, state)).toEqual(['data-exists /m:clock']);
    expect(failure(op, { 'm:ifs': {} }, { 'm:clock': { '@': { 'ietf-netconf:operation': 'delete' } } }, state)).toEqual(['data-missing /m:clock']);
  });

  it('replaces a node’s state as well as its configuration with the state option', () => {
    const replaced = apply(op, target, { 'm:ifs': { if: [{ '@': { 'ietf-netconf:operation': 'replace' }, name: 'a', stats: { in: 9 } }] } }, { state: true });
    expect(replaced).toMatchObject({ 'm:ifs': { if: [{ name: 'a', stats: { in: 9 } }] } });
    expect(JSON.stringify(replaced)).not.toContain('"out"');
    expect(JSON.stringify(replaced)).not.toContain('"oper"');
    expect(JSON.stringify(replaced)).not.toContain('"mtu"');
    // Without it, replace keeps state: only configuration is replaced.
    const kept = apply(op, target, { 'm:ifs': { if: [{ '@': { 'ietf-netconf:operation': 'replace' }, name: 'a', mtu: 9000 }] } });
    expect(kept).toMatchObject({ 'm:ifs': { if: [{ name: 'a', mtu: 9000, oper: 'up', stats: { in: 1, out: 2 } }] } });
  });

  it('still refuses state data without the option, or on a tree that holds no state', () => {
    expect(failure(op, target, { 'm:clock': { now: '13:00' } })).toEqual(['invalid-edit /m:clock']);
    // A configuration datastore's tree can't hold state at all; the option changes nothing there.
    expect(apply(running, { 'm:ifs': { if: [{ name: 'a', mtu: 1500 }] } }, { 'm:ifs': { if: [{ name: 'a', mtu: 1400 }] } }, { state: true })).toEqual({
      'm:ifs': { if: [{ name: 'a', mtu: 1400 }] },
    });
  });
});

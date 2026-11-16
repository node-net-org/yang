import { beforeAll, describe, expect, it } from 'vitest';
import type { PathCompletion, Schema } from '../../src/index.js';
import { exSchema } from '../data/support.js';

let schema: Schema;
beforeAll(async () => {
  schema = await exSchema();
  expect(schema.errors).toEqual([]);
});

const names = (path: string, options = {}): string[] | undefined => schema.children(path, options)?.map((n) => (n.module === 'ex' ? n.name : `${n.module}:${n.name}`));
const texts = (c: PathCompletion[]): string[] => c.map((x) => x.text);

describe('children', () => {
  it('lists top-level data nodes, operations only when asked', () => {
    expect(names('/')).toEqual(['c', 'state', 'settings', 'top']);
    // ietf-netconf is implemented too: ietf-netconf-with-defaults augments it.
    expect(names('/', { operations: true })).toEqual(['c', 'state', 'settings', 'top', 'r', ...schema.module('ietf-netconf')!.rpcs.map((r) => `ietf-netconf:${r.name}`), 'ev']);
    expect(names('/', { config: true })).toEqual(['c', 'settings', 'top']);
  });

  it('looks through choice and case, and includes augmented nodes', () => {
    expect(names('/ex:c')).toEqual([
      's', 'i8', 'u32', 'i64', 'u64', 'd', 'bool', 'e', 'en', 'b', 'bin', 'idr', 'ii', 'u', 'u2', 'lr', 'll', 'lls', 'ad', 'ax', 'l', 'ids', 'ca', 'cb', 'p',
      'ex-aug:extra', 'ex-aug:more',
    ]);
    expect(names('/ex:c', { operations: true })).toContain('act');
  });

  it('reads paths tolerantly: YANG prefixes, no prefixes, predicates, no leading slash', () => {
    const inner = ['k1', 'k2', 'v', 'inner'];
    for (const p of ['/ex:c/l', '/c/l', 'c/l', "/ex:c/l[k1='a'][k2=\"7\"]", '/ex:c/ex:l', "/c/l[k1='a/b]']"]) expect(names(p), p).toEqual(inner);
    expect(names('/ex:c/aug:more')).toEqual(['ex-aug:deep']);
    expect(names('/c/more')).toEqual(['ex-aug:deep']);
    expect(names('/ex:r', { operations: true })).toEqual(['b', 'a', 'o']);
  });

  it('gives undefined for paths that name nothing', () => {
    expect(schema.children('/ex:nope')).toBeUndefined();
    expect(schema.children('/zz:c')).toBeUndefined();
    expect(schema.children('/ex:state', { config: true })).toBeUndefined();
    expect(schema.children('/ex:c/s')).toEqual([]);
  });
});

describe('describe', () => {
  it('summarises leaves: type, defaults (own and typedef), units, description', () => {
    expect(schema.describe('/settings/level')).toMatchObject({
      kind: 'leaf',
      path: '/ex:settings/level',
      config: true,
      mandatory: false,
      default: '50',
      units: 'percent',
      description: 'How full.',
      type: { name: 'percent', builtin: 'uint8', text: 'percent [uint8] (0..100)', range: '0..100' },
    });
    expect(schema.describe('/ex:settings/mode')).toMatchObject({
      default: 'safe',
      type: { text: 'enumeration (fast | safe)', enums: [{ name: 'fast', value: 0 }, { name: 'safe', value: 1, description: 'Slow but sure.' }] },
    });
    expect(schema.describe('/ex:settings/tags')).toMatchObject({ kind: 'leaf-list', mandatory: true, minElements: 1, orderedBy: 'system' });
    expect(schema.describe('/ex:settings/ref')!.type).toMatchObject({ builtin: 'leafref', target: '/ex:c/l/k1', text: 'leafref (→ /ex:c/l/k1)' });
  });

  it('lists the identities an identityref accepts, and union members', () => {
    expect(schema.describe('/ex:c/idr')!.type).toMatchObject({
      text: 'identityref (base ex-ids:thing)',
      identities: [{ name: 'ex-ids:gadget' }, { name: 'ex-ids:widget' }, { name: 'ex:local-thing' }],
    });
    expect(schema.describe('/ex:c/u')!.type!.text).toBe('union (int32 | string)');
    expect(schema.describe('/ex:c/d')!.type!.text).toBe('decimal64 (fraction-digits 3)');
    expect(schema.describe('/ex:c/b')!.type!.text).toBe('bits (one two three)');
  });

  it('describes lists, presence containers and state', () => {
    expect(schema.describe('/ex:c/l')).toMatchObject({ kind: 'list', keys: ['k1', 'k2'], hasChildren: true, orderedBy: 'system' });
    expect(schema.describe('/ex:c/p')).toMatchObject({ kind: 'container', presence: 'enabled' });
    expect(schema.describe('/ex:state/counter')).toMatchObject({ config: false });
  });
});

describe('complete', () => {
  it('completes top-level nodes with their module names', () => {
    expect(texts(schema.complete(''))).toEqual(['ex:c', 'ex:settings', 'ex:state', 'ex:top']);
    expect(texts(schema.complete('/'))).toEqual(['/ex:c', '/ex:settings', '/ex:state', '/ex:top']);
    expect(schema.complete('/ex:s').map((c) => [c.text, c.extends])).toEqual([['/ex:settings', true], ['/ex:state', true]]);
    expect(schema.complete('/st').map((c) => [c.text, c.extends])).toEqual([['/ex:state', false]]);
  });

  it('completes children, qualifying nodes from other modules', () => {
    expect(texts(schema.complete('/ex:c/l/'))).toEqual(['/ex:c/l/inner', '/ex:c/l/k1', '/ex:c/l/k2', '/ex:c/l/v']);
    expect(schema.complete('/ex:c/ex').map((c) => [c.text, c.extends])).toEqual([['/ex:c/ex-aug:extra', true], ['/ex:c/ex-aug:more', true]]);
    expect(schema.complete('/ex:c/mo').map((c) => [c.text, c.extends])).toEqual([['/ex:c/ex-aug:more', false]]);
    expect(schema.complete('/ex:c/aug:mo').map((c) => [c.text, c.extends])).toEqual([['/ex:c/ex-aug:more', false]]);
    expect(texts(schema.complete("/c/l[k1='a'][k2='1']/inner/"))).toEqual(["/c/l[k1='a'][k2='1']/inner/x"]);
    expect(schema.complete('/ex:c/b')[0]!.node).toMatchObject({ kind: 'leaf', type: { builtin: 'bits' } });
  });

  it('completes list keys and closed-set key values inside predicates', () => {
    expect(texts(schema.complete('/ex:c/l['))).toEqual(['/ex:c/l[k1=', '/ex:c/l[k2=']);
    expect(texts(schema.complete("/ex:c/l[k1='a']["))).toEqual(["/ex:c/l[k1='a'][k2="]);
    expect(texts(schema.complete('/ex:c/ids[id='))).toEqual(["/ex:c/ids[id='ex-ids:gadget']", "/ex:c/ids[id='ex-ids:widget']", "/ex:c/ids[id='ex:local-thing']"]);
    expect(texts(schema.complete('/ex:c/ids[id="ex:'))).toEqual(['/ex:c/ids[id="ex:local-thing"]']);
    expect(texts(schema.complete('/ex:c/lls['))).toEqual(['/ex:c/lls[.=']);
    expect(schema.complete('/ex:c/l[k1=')).toEqual([]);
  });

  it('completes nothing below a path that names nothing', () => {
    expect(schema.complete('/ex:nope/')).toEqual([]);
    expect(schema.complete('/ex:state/', { config: true })).toEqual([]);
  });
});

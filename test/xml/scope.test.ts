/**
 * Decoding links each element's namespace declarations to its parent's scope
 * instead of copying it: K prefixes in scope
 * over K elements that each declare one more used to cost K² map entries.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import { decodeXml, type Identity, type LeafInstance, type Schema, type XmlElementLike } from '../../src/index.js';
import { ChainedScope } from '../../src/xml/scope.js';
import { exSchema, kids } from '../data/support.js';
import { EDIT_FIXTURES, edSchema } from '../edit/support.js';

let schema: Schema;
beforeAll(async () => {
  schema = await exSchema();
});

describe('ChainedScope', () => {
  const root = new Map([
    ['', ''],
    ['a', 'u:a'],
    ['b', 'u:b'],
  ]);
  const mid = new ChainedScope(new Map([['b', 'u:b2'], ['c', 'u:c']]), root);
  const leaf = new ChainedScope(new Map([['d', 'u:d']]), mid);

  it('looks prefixes up nearest first', () => {
    expect(leaf.get('b')).toBe('u:b2');
    expect(leaf.get('a')).toBe('u:a');
    expect(leaf.get('d')).toBe('u:d');
    expect(leaf.get('')).toBe('');
    expect(leaf.get('zz')).toBeUndefined();
    expect(leaf.has('')).toBe(true);
    expect(leaf.has('zz')).toBe(false);
  });

  it('iterates as one flat map, in first-declared order', () => {
    const flat = [
      ['', ''],
      ['a', 'u:a'],
      ['b', 'u:b2'],
      ['c', 'u:c'],
      ['d', 'u:d'],
    ];
    expect([...leaf]).toEqual(flat);
    expect([...leaf.entries()]).toEqual(flat);
    expect([...leaf.keys()]).toEqual(flat.map(([k]) => k));
    expect([...leaf.values()]).toEqual(flat.map(([, v]) => v));
    expect(leaf.size).toBe(5);
    const seen: string[] = [];
    leaf.forEach(function (this: unknown, uri, prefix, map) {
      expect(map).toBe(leaf);
      expect(this).toBe(seen);
      seen.push(`${prefix}=${uri}`);
    }, seen);
    expect(seen).toEqual(flat.map(([k, v]) => `${k}=${v}`));
  });
});

describe('ChainedScope is a Map, as the copy was', () => {
  const make = (): ChainedScope =>
    new ChainedScope(
      new Map([['c', 'u:c']]),
      new Map([
        ['', ''],
        ['a', 'u:a'],
      ]),
    );

  it('is a Map, inspected and cloned like one', () => {
    const plain = new Map([
      ['', ''],
      ['a', 'u:a'],
      ['c', 'u:c'],
    ]);
    expect(make()).toBeInstanceOf(Map);
    expect(inspect(make())).toBe(inspect(plain));
    const scope = make();
    void scope.size;
    expect([...(structuredClone(scope) as Map<string, string>)]).toEqual([...plain]);
  });

  it('can be changed, like the copy', () => {
    const scope = make();
    scope.set('d', 'u:d');
    expect(scope.get('d')).toBe('u:d');
    expect(scope.get('a')).toBe('u:a');
    expect(scope.delete('a')).toBe(true);
    expect(scope.get('a')).toBeUndefined();
    scope.clear();
    expect(scope.size).toBe(0);
    expect(scope.get('c')).toBeUndefined();
  });

  it('a yang:key annotation keeps a Map of the prefixes in scope', async () => {
    const xml = readFileSync(join(EDIT_FIXTURES, 'data', 'insert-after.xml'), 'utf8');
    const user = kids(decodeXml(await edSchema(), xml, { edit: true }).children[0])[0]!;
    const key = user.annotations.find((a) => a.name === 'key')!;
    expect(key.prefixes).toBeInstanceOf(Map);
    expect([...key.prefixes!]).toEqual([
      ['', 'urn:ed'],
      ['x', 'urn:ed'],
      ['yang', 'urn:ietf:params:xml:ns:yang:1'],
    ]);
  });
});

describe('decodeXml with many declarations', () => {
  it('resolves a prefix from the nearest of several declaring levels', () => {
    const xml = `<c xmlns="urn:ex" xmlns:x="urn:wrong" xmlns:z="urn:ex-ids"><idr xmlns:x="urn:ex-ids" xmlns:w="urn:w">x:gadget</idr></c>`;
    const idr = kids(decodeXml(schema, xml).children[0])[0] as LeafInstance;
    expect((idr.value.value as Identity).name).toBe('gadget');
    expect((idr.value.value as Identity).module.name).toBe('ex-ids');
  });

  it('K inherited prefixes over K declaring elements decode in linear time', () => {
    const K = 8000;
    const scope = new Map<string, string>();
    for (let i = 0; i < K; i++) scope.set(`p${i}`, `urn:p${i}`);
    const elements: XmlElementLike[] = [];
    for (let i = 0; i < K; i++) elements.push({ name: 'zz', ns: 'urn:zz', declarations: new Map([[`q${i}`, `urn:q${i}`]]) });
    const start = performance.now();
    decodeXml(schema, elements, { scope, unknown: 'skip' });
    // Copying the scope per element (64M entries) took several seconds.
    expect(performance.now() - start).toBeLessThan(1500);
  });
});

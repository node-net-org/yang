import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  builtinSource,
  chainSources,
  compileSchema,
  decodeJson,
  encodeJson,
  fileSource,
  memorySource,
  NetYangError,
  readInstanceData,
  toJson,
  writeInstanceData,
  YangDataError,
} from '../../src/index.js';
import { mod } from '../compile/support.js';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'instance-data');
const RFC = join(import.meta.dirname, '..', 'corpus', '.cache', 'yangmodels', 'standard', 'ietf', 'RFC');
const read = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

describe('instance-data files (RFC 9195), the RFC examples', () => {
  it('reads Figure 2: simplified-inline content schema, content decoded with it', async () => {
    const file = await readInstanceData(read('read-only-acm-rules@2022-01-20.xml'));
    expect(file.format).toBe('xml');
    expect(file.header).toEqual({
      name: 'read-only-acm-rules',
      formatVersion: '2022-01-20',
      includesDefaults: 'report-all',
      contentSchema: { kind: 'modules', modules: [{ name: 'ietf-netconf-acm', revision: '2018-02-14' }] },
      revisions: [{ date: '2018-07-04', description: 'Initial version' }],
      description: ['Default access control rules for a read-only role. This set of rules will only change when a new  software release is introduced.'],
    });
    const schema = await file.compileSchema(builtinSource);
    expect(schema.errors).toEqual([]);
    const tree = file.decode(schema);
    expect(encodeJson(tree)).toMatchObject({ 'ietf-netconf-acm:nacm': { 'enable-nacm': true, 'read-default': 'deny', 'rule-list': [{ name: 'read-only-role', rule: [{ name: 'read-all', action: 'permit' }] }] } });
  });

  it('validates content as partial data (RFC 9195 §2)', async () => {
    const file = await readInstanceData(read('read-only-acm-rules@2022-01-20.xml'));
    const schema = await file.compileSchema(builtinSource);
    // The rules alone: NACM's mandatory counters are state data the file doesn't hold.
    expect(() => file.decode(schema, { validate: true })).not.toThrow();
    expect(() => file.decode(schema, { validate: { partial: false } })).toThrow(/mandatory leaf denied-operations is missing/);
  });

  it.skipIf(!existsSync(RFC))('reads Figure 1: an inline modules-state library, and finds the RFC’s prefixed feature names', async () => {
    const file = await readInstanceData(read('acme-router-modules@2022-01-20.xml'));
    expect(file.header).toMatchObject({ name: 'acme-router-modules', contact: 'info@acme.example.com', contentSchema: { kind: 'inline' } });
    const cs = file.header.contentSchema;
    expect(cs?.kind === 'inline' ? cs.library.moduleSets[0]!.modules.map((m) => `${m.name}@${m.revision ?? ''}`) : []).toEqual([
      'ietf-yang-library@2019-01-04',
      'ietf-netconf-monitoring@2010-10-04',
    ]);
    const schema = await file.compileSchema(chainSources(fileSource([RFC]), builtinSource));
    expect(schema.errors).toEqual([]);
    let issues: readonly { code: string; path: string }[] = [];
    try {
      file.decode(schema);
    } catch (err) {
      if (err instanceof YangDataError) issues = err.issues;
    }
    expect(issues.map((i) => `${i.code} ${i.path}`)).toEqual([
      "invalid-value /ietf-yang-library:modules-state/module[name='ietf-system'][revision='2014-08-06']/feature[.=\"sys:authentication\"]",
      "invalid-value /ietf-yang-library:modules-state/module[name='ietf-system'][revision='2014-08-06']/feature[.=\"sys:local-users\"]",
    ]);
  });

  it.skipIf(!existsSync(RFC))('reads Figure 3 (corrected): JSON, with the schema given by URI', async () => {
    const file = await readInstanceData(read('acme-router-netconf-diagnostics@2018-01-25T17_00_38Z.json'));
    expect(file).toMatchObject({ format: 'json', header: { contentSchema: { kind: 'uri', uri: 'file:///acme-diagnostics-schema.json' }, timestamp: '2018-01-25T17:00:38Z' } });
    await expect(file.compileSchema(builtinSource)).rejects.toThrow(NetYangError);
    const schema = await compileSchema({ source: chainSources(fileSource([RFC]), builtinSource), modules: ['ietf-netconf-monitoring'] });
    expect(toJson(file.decode(schema))).toBe(
      '{"ietf-netconf-monitoring:netconf-state":{"statistics":{"netconf-start-time":"2018-12-05T17:45:00Z","in-bad-hellos":32,"in-sessions":397,"dropped-sessions":87,"in-rpcs":8711,"in-bad-rpcs":408,"out-rpc-errors":408,"out-notifications":39007}}}',
    );
  });

  it('rejects files that are not instance data, and headers that break the model', async () => {
    await expect(readInstanceData('<data xmlns="urn:x"/>')).rejects.toThrow(YangDataError);
    await expect(readInstanceData('{"x:y": {}}')).rejects.toThrow(YangDataError);
    await expect(readInstanceData('{"ietf-yang-instance-data:instance-data-set": {"revision": [{"date": "yesterday"}]}}')).rejects.toThrow(/date/);
  });
});

const EX = mod(
  'ex',
  `feature extra;
  container sys {
    leaf host { type string; }
    leaf mtu { type uint16; default 1500; }
    leaf up { config false; type boolean; }
    list user { key name; leaf name { type string; } leaf uid { type uint32; } leaf role { if-feature extra; type string; } }
  }`,
);
const source = chainSources(memorySource([EX]), builtinSource);

describe('writing instance-data files', () => {
  it.each(['xml', 'json'] as const)('round-trips %s with each content schema method', async (format) => {
    const schema = (await compileSchema({ source, modules: ['ex'], features: { ex: [] } })).forDatastore('operational');
    const tree = decodeJson(schema, { 'ex:sys': { host: 'r1', up: true, user: [{ name: 'a', uid: 7 }] } });
    for (const contentSchema of ['modules', 'inline'] as const) {
      const text = await writeInstanceData(
        tree,
        { name: 'snap', revisions: [{ date: '2026-11-09' }], timestamp: '2026-11-09T01:02:03Z', description: ['a & b <c>'] },
        { format, contentSchema, indent: 2 },
      );
      const file = await readInstanceData(text);
      expect(file.header).toMatchObject({ name: 'snap', datastore: 'ietf-datastores:operational', timestamp: '2026-11-09T01:02:03Z', description: ['a & b <c>'] });
      const again = await file.compileSchema(source);
      expect(again.errors).toEqual([]);
      // The inline library carries the disabled feature; the simplified form enables every feature.
      expect([...again.module('ex')!.enabledFeatures]).toEqual(contentSchema === 'inline' ? [] : ['extra']);
      expect(again.datastore).toBe('ietf-datastores:operational');
      expect(toJson(file.decode(again))).toBe(toJson(tree));
    }
  });

  it('writes the header in schema order, with defaults applied when asked', async () => {
    const schema = await compileSchema({ source, modules: ['ex'] });
    const tree = decodeJson(schema.forDatastore('running'), { 'ex:sys': { host: 'r1' } });
    const text = await writeInstanceData(tree, { name: 'cfg', contact: 'ops' }, { format: 'json', withDefaults: 'report-all' });
    expect(JSON.parse(text)).toEqual({
      'ietf-yang-instance-data:instance-data-set': {
        name: 'cfg',
        'includes-defaults': 'report-all',
        'content-schema': { module: ['ex'] },
        contact: 'ops',
        datastore: 'ietf-datastores:running',
        'content-data': { 'ex:sys': { host: 'r1', mtu: 1500 } },
      },
    });
    expect(await writeInstanceData(tree, {}, { format: 'xml', contentSchema: 'none' })).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n<instance-data-set xmlns="urn:ietf:params:xml:ns:yang:ietf-yang-instance-data"><datastore xmlns:ds="urn:ietf:params:xml:ns:yang:ietf-datastores">ds:running</datastore><content-data><sys xmlns="urn:ex"><host>r1</host><mtu>1500</mtu></sys></content-data></instance-data-set>\n',
    );
  });

  it('round-trips any data through both formats', async () => {
    const schema = await compileSchema({ source, modules: ['ex'] });
    const text = fc.string({ unit: fc.constantFrom('a', 'Z', ' ', '&', '<', '"', "'", 'é', '😀'), maxLength: 8 });
    const data = fc.record({
      host: text,
      user: fc.uniqueArray(fc.record({ name: text, uid: fc.nat({ max: 2 ** 32 - 1 }) }), { selector: (u) => u.name, maxLength: 4 }),
    });
    await fc.assert(
      fc.asyncProperty(data, fc.constantFrom('xml', 'json'), async (d, format) => {
        const tree = decodeJson(schema, { 'ex:sys': d.user.length === 0 ? { host: d.host } : d });
        const file = await readInstanceData(await writeInstanceData(tree, { name: 'p' }, { format }));
        expect(toJson(file.decode(schema))).toBe(toJson(tree));
      }),
      { numRuns: 60 },
    );
  });
});

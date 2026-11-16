import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  compileYangLibrary,
  decodeYangLibrary,
  fromCapabilities,
  memorySource,
  builtinSource,
  chainSources,
  fileSource,
  parseModuleCapability,
  readYangLibrary,
  yangLibraryData,
  YangDataError,
  type LeafNode,
  type YangLibrary,
} from '../../src/index.js';
import { mod } from '../compile/support.js';
import { CACHE, hasCorpus, librarySource, readFixture } from './support.js';

const YL = 'ietf-yang-library:yang-library';

describe('reading YANG library data (RFC 8525)', () => {
  it('reads module sets, schemas, datastores and the content-id from RFC 7951 JSON', () => {
    const lib = readYangLibrary({
      [YL]: {
        'module-set': [
          {
            name: 'config',
            module: [
              { name: 'a', revision: '2020-01-01', namespace: 'urn:a', feature: ['f'], deviation: ['d'], submodule: [{ name: 'a-sub', revision: '2020-01-01' }] },
              { name: 'd', revision: '2021-01-01', namespace: 'urn:d', 'ietf-yang-library-augmentedby:augmented-by': ['x'] },
            ],
            'import-only-module': [{ name: 't', revision: '2013-07-15', namespace: 'urn:t' }],
          },
        ],
        schema: [{ name: 's', 'module-set': ['config'] }],
        datastore: [{ name: 'ietf-datastores:running', schema: 's' }],
        'content-id': '7',
      },
    });
    expect(lib).toEqual({
      format: 'yang-library',
      moduleSets: [
        {
          name: 'config',
          modules: [
            {
              name: 'a',
              revision: '2020-01-01',
              namespace: 'urn:a',
              features: ['f'],
              deviations: [{ name: 'd', revision: '2021-01-01' }],
              submodules: [{ name: 'a-sub', revision: '2020-01-01' }],
              locations: [],
            },
            { name: 'd', revision: '2021-01-01', namespace: 'urn:d', features: [], deviations: [], submodules: [], locations: [], augmentedBy: ['x'] },
          ],
          importOnly: [{ name: 't', revision: '2013-07-15', namespace: 'urn:t', submodules: [], locations: [] }],
        },
      ],
      schemas: [{ name: 's', moduleSets: ['config'] }],
      datastores: [{ name: 'ietf-datastores:running', schema: 's' }],
      contentId: '7',
    });
  });

  it('decodes XML before any schema exists, and prefers yang-library to modules-state', async () => {
    const lib = await decodeYangLibrary(readFixture('basic.xml'));
    expect(lib.format).toBe('yang-library');
    expect(lib.contentId).toBe('1');
    expect(lib.datastores).toEqual([
      { name: 'ietf-datastores:running', schema: 'complete' },
      { name: 'ietf-datastores:operational', schema: 'complete' },
    ]);
    const set = lib.moduleSets[0]!;
    expect(set.modules.map((m) => m.name)).toEqual(['ietf-interfaces', 'ietf-ip', 'iana-if-type', 'ex-dev', 'ex-old']);
    expect(set.importOnly.map((m) => `${m.name}@${m.revision ?? ''}`)).toEqual(['ietf-yang-types@2013-07-15', 'ietf-yang-types@2010-09-24', 'ietf-inet-types@2013-07-15']);
    expect(set.modules[4]).toMatchObject({ features: ['slow'], submodules: [{ name: 'ex-old-sub', revision: '2026-11-01' }] });
  });

  it('reads RFC 7895 modules-state as one module set', async () => {
    const lib = await decodeYangLibrary(readFixture('legacy.xml'));
    expect(lib).toMatchObject({ format: 'modules-state', contentId: '42', datastores: [], schemas: [{ name: 'legacy', moduleSets: ['legacy'] }] });
    const set = lib.moduleSets[0]!;
    expect(set.modules.find((m) => m.name === 'ietf-interfaces')).toMatchObject({ features: ['if-mib'], deviations: [{ name: 'ex-dev', revision: '2026-11-09' }] });
    expect(set.importOnly.map((m) => m.name)).toEqual(['ietf-yang-types', 'ietf-yang-types', 'ietf-inet-types']);
  });

  it('decodes JSON text, and rejects data that holds neither container', async () => {
    const lib = await decodeYangLibrary(JSON.stringify({ 'ietf-yang-library:modules-state': { 'module-set-id': 'x', module: [{ name: 'a', revision: '', namespace: 'urn:a', 'conformance-type': 'implement' }] } }));
    expect(lib.moduleSets[0]!.modules).toEqual([{ name: 'a', namespace: 'urn:a', features: [], deviations: [], submodules: [], locations: [] }]);
    expect(() => readYangLibrary({})).toThrow(YangDataError);
  });
});

describe('module capabilities in a hello (RFC 7950 §5.6.4)', () => {
  it('parses a capability URI', () => {
    expect(parseModuleCapability('urn:ietf:params:xml:ns:yang:ietf-interfaces?module=ietf-interfaces&revision=2014-05-08&features=if-mib,arbitrary-names&deviations=ex-dev')).toEqual({
      namespace: 'urn:ietf:params:xml:ns:yang:ietf-interfaces',
      name: 'ietf-interfaces',
      revision: '2014-05-08',
      features: ['if-mib', 'arbitrary-names'],
      deviations: ['ex-dev'],
    });
    expect(parseModuleCapability('urn:x?module=x&amp;revision=2020-01-01')).toMatchObject({ name: 'x', revision: '2020-01-01', features: [] });
    expect(parseModuleCapability('urn:ietf:params:netconf:base:1.1')).toBeUndefined();
    expect(parseModuleCapability('urn:ietf:params:netconf:capability:with-defaults:1.0?basic-mode=explicit')).toBeUndefined();
  });

  it('builds a module list from a hello, adding unadvertised deviation modules', () => {
    const lib = fromCapabilities([
      'urn:ietf:params:netconf:base:1.1',
      'urn:a?module=a&revision=2020-01-01&features=f&deviations=d',
      'urn:ietf:params:netconf:capability:yang-library:1.1?revision=2019-01-04&content-id=abc',
    ]);
    expect(lib.format).toBe('hello');
    expect(lib.library).toEqual({ version: '1.1', revision: '2019-01-04', contentId: 'abc' });
    expect(lib.moduleSets[0]!.modules).toEqual([
      { name: 'a', revision: '2020-01-01', namespace: 'urn:a', features: ['f'], deviations: [{ name: 'd' }], submodules: [], locations: [] },
      { name: 'd', features: [], deviations: [], submodules: [], locations: [] },
    ]);
  });
});

describe('schemas from a YANG library', () => {
  const source = chainSources(
    memorySource([
      mod('cfg', 'container c { leaf x { type string; } leaf s { config false; type string; } }'),
      mod('st', 'container stats { config false; leaf n { type uint32; } }'),
      mod('f', 'feature one; feature two; leaf a { if-feature one; type string; } leaf b { if-feature two; type string; }'),
      mod('aug', 'augment /cfg:c { leaf y { type string; } }', '  import cfg { prefix cfg; }'),
      mod('t', 'feature g; identity base; identity i { if-feature g; base base; } leaf ref { type identityref { base base; } }'),
      mod('u', 'leaf v { type identityref { base t:base; } }', '  import t { prefix t; }'),
      mod('grp', 'feature ka; grouping tcp { leaf port { type uint16; } container keepalives { if-feature ka; leaf idle { type uint16; } } }'),
      mod('srv', 'container server { uses grp:tcp; }', '  import grp { prefix grp; }'),
    ]),
    builtinSource,
  );
  const library = (sets: Record<string, string[]>, schemas: Record<string, string[]>, datastores: Record<string, string>): YangLibrary => ({
    format: 'yang-library',
    moduleSets: Object.entries(sets).map(([name, modules]) => ({
      name,
      modules: modules.map((m) => {
        const [n, features] = m.split(':');
        return { name: n!, features: features === undefined ? [] : features.split(','), deviations: [], submodules: [], locations: [] };
      }),
      importOnly: [],
    })),
    schemas: Object.entries(schemas).map(([name, moduleSets]) => ({ name, moduleSets })),
    datastores: Object.entries(datastores).map(([name, schema]) => ({ name: `ietf-datastores:${name}`, schema })),
  });

  it('compiles each schema once, and gives a view per datastore', async () => {
    const lib = library({ base: ['cfg'], state: ['st'] }, { config: ['base'], again: ['base'], state: ['base', 'state'] }, { running: 'config', startup: 'again', operational: 'state' });
    const schemas = await compileYangLibrary(lib, { source });
    expect(schemas.diagnostics).toEqual([]);
    expect(schemas.schemas.get('config')).toBe(schemas.schemas.get('again'));
    const running = schemas.datastore('running')!;
    const operational = schemas.datastore('ietf-datastores:operational')!;
    expect(running).toMatchObject({ datastore: 'ietf-datastores:running', holdsState: false });
    expect(operational).toMatchObject({ datastore: 'ietf-datastores:operational', holdsState: true });
    expect(running.module('st')).toBeUndefined();
    expect(operational.module('st')!.implemented).toBe(true);
    expect(running.modules.get('cfg')).toBe(schemas.schemas.get('config')!.modules.get('cfg'));
    expect(schemas.datastore('candidate')).toBeUndefined();
    // Queries of a configuration datastore leave state data out.
    expect(running.children('/cfg:c')!.map((n) => n.name)).toEqual(['x']);
    expect(operational.children('/cfg:c')!.map((n) => n.name)).toEqual(['x', 's']);
  });

  it('enables exactly the features the library lists, and none of an import-only module', async () => {
    const lib = library({ s: ['f:two', 'u'] }, { s: ['s'] }, { running: 's' });
    const schema = (await compileYangLibrary(lib, { source })).datastore('running')!;
    expect(schema.find('/f:a')).toBeUndefined();
    expect(schema.find('/f:b')).toBeDefined();
    expect(schema.module('t')).toMatchObject({ implemented: false });
    expect([...schema.module('t')!.enabledFeatures]).toEqual([]);
    expect(schema.module('t')!.identities.has('i')).toBe(false);
    expect(schema.errors).toEqual([]);
  });

  it('compiles a subset with the modules that augment it (RFC 10035)', async () => {
    const lib: YangLibrary = {
      ...library({ s: ['cfg', 'st', 'aug'] }, { s: ['s'] }, { running: 's' }),
    };
    const withList: YangLibrary = {
      ...lib,
      moduleSets: [{ ...lib.moduleSets[0]!, modules: lib.moduleSets[0]!.modules.map((m) => (m.name === 'cfg' ? { ...m, augmentedBy: ['aug'] } : { ...m, augmentedBy: [] })) }],
    };
    const subset = (await compileYangLibrary(withList, { source, only: ['cfg'] })).datastore('running')!;
    expect(subset.implemented.map((m) => m.name).sort()).toEqual(['aug', 'cfg']);
    expect(subset.find('/cfg:c/aug:y')).toBeDefined();
    const blind = await compileYangLibrary(lib, { source, only: ['cfg'] });
    expect(blind.diagnostics.map((d) => d.code)).toEqual(['no-augmented-by']);
    expect(blind.datastore('running')!.implemented.map((m) => m.name)).toEqual(['cfg']);
  });

  it("keeps the library's features of an implemented module that a subset loads only as an import", async () => {
    // srv uses grp's grouping, so compiling only srv loads grp as an import; the server still implements grp with ka.
    const withKa = (await compileYangLibrary(library({ s: ['srv', 'grp:ka'] }, { s: ['s'] }, { running: 's' }), { source, only: ['srv'] })).datastore('running')!;
    expect(withKa.implemented.map((m) => m.name)).toEqual(['srv']);
    expect(withKa.find('/srv:server/keepalives/idle')).toBeDefined();
    const withoutKa = (await compileYangLibrary(library({ s: ['srv', 'grp'] }, { s: ['s'] }, { running: 's' }), { source, only: ['srv'] })).datastore('running')!;
    expect(withoutKa.find('/srv:server/keepalives')).toBeUndefined();
    expect(withoutKa.find('/srv:server/port')).toBeDefined();
  });

  it('serves every datastore from the one schema of a library without datastores', async () => {
    const lib = fromCapabilities(['urn:cfg?module=cfg', 'urn:f?module=f&features=one']);
    const schemas = await compileYangLibrary(lib, { source });
    expect(schemas.datastore('running')!.holdsState).toBe(false);
    expect(schemas.datastore('operational')!.holdsState).toBe(true);
    expect(schemas.datastore('running')!.find('/f:a')).toBeDefined();
    expect(schemas.datastore('running')!.find('/f:b')).toBeUndefined();
  });

  it('reports a library that names what it lacks', async () => {
    const lib: YangLibrary = { ...library({ s: ['cfg'] }, { s: ['s', 'nope'] }, { running: 's', startup: 'gone' }) };
    const deviated: YangLibrary = { ...lib, moduleSets: [{ ...lib.moduleSets[0]!, modules: [{ ...lib.moduleSets[0]!.modules[0]!, deviations: [{ name: 'dev' }] }] }] };
    const schemas = await compileYangLibrary(deviated, { source });
    expect(schemas.diagnostics.map((d) => d.code)).toEqual(['unknown-module-set', 'unknown-deviation', 'unknown-schema']);
  });
});

describe.skipIf(!hasCorpus())('YANG library contexts match yanglint -Y', () => {
  const theirs = join(CACHE, 'yanglint', 'library-basic.json');
  /** Modules libyang always has, unless a library names them. */
  const LIBYANG = new Set(['yang', 'ietf-yang-schema-mount', 'ietf-datastores', 'ietf-yang-library', 'ietf-yang-metadata', 'ietf-yang-structure-ext']);
  type Entry = { name: string; revision?: string; feature?: string[]; deviation?: string[]; submodule?: { name: string; revision?: string }[] };
  const summary = (data: unknown): { implemented: string[]; importOnly: string[] } => {
    const set = (data as Record<string, { 'module-set': { module: Entry[]; 'import-only-module'?: Entry[] }[] }>)[YL]!['module-set'][0]!;
    const line = (m: Entry): string =>
      [`${m.name}@${m.revision ?? ''}`, (m.feature ?? []).join(','), (m.deviation ?? []).join(','), (m.submodule ?? []).map((s) => `${s.name}@${s.revision ?? ''}`).join(',')].join(' ');
    const keep = (m: Entry): boolean => !LIBYANG.has(m.name);
    return { implemented: set.module.filter(keep).map(line).sort(), importOnly: (set['import-only-module'] ?? []).filter(keep).map(line).sort() };
  };

  it.each(['basic.xml', 'legacy.xml'])('%s gives the modules, revisions, features, deviations and submodules yanglint gives', async (file) => {
    if (!existsSync(theirs)) return;
    const schemas = await compileYangLibrary(await decodeYangLibrary(readFixture(file)), { source: librarySource() });
    const schema = [...schemas.schemas.values()][0]!;
    expect(schema.errors).toEqual([]);
    expect(summary(yangLibraryData(schema))).toEqual(summary(JSON.parse(readFileSync(theirs, 'utf8'))));
  });

  it('uses the import-only revision an import names', async () => {
    const schemas = await compileYangLibrary(await decodeYangLibrary(readFixture('basic.xml')), { source: librarySource() });
    const schema = schemas.datastore('operational')!;
    expect(schema.module('ietf-yang-types')!.revision).toBe('2013-07-15');
    expect(schema.find('/ex-old:counters/in')).toMatchObject({ type: { typedef: { module: { revision: '2010-09-24' } } } });
    expect(schema.find('/ex-old:counters/turbo')).toBeUndefined();
    expect(schema.find('/ex-old:counters/out')).toBeDefined();
    expect(schema.find('/ietf-interfaces:interfaces/interface/description')).toBeUndefined();
    expect((schema.find('/ietf-interfaces:interfaces/interface/ietf-ip:ipv4/mtu') as LeafNode).type.range).toEqual([{ min: 68n, max: 9000n }]);
  });
});

describe.skipIf(!existsSync(join(CACHE, 'netopeer2', 'yang-library.json')))("netopeer2's YANG library (a real server's)", () => {
  const NP = join(CACHE, 'netopeer2');
  type Entry = { name: string; revision?: string; feature?: string[]; deviation?: string[] };
  const lines = (entries: Entry[] | undefined): string[] =>
    (entries ?? []).map((m) => `${m.name}@${m.revision ?? ''} ${[...(m.feature ?? [])].sort().join(',')} ${(m.deviation ?? []).join(',')}`).sort();

  it('compiles every datastore schema without errors, matching yanglint -Y', async () => {
    const text = readFileSync(join(NP, 'yang-library.json'), 'utf8');
    const library = await decodeYangLibrary(text);
    expect(library.datastores.map((d) => d.name)).toEqual(expect.arrayContaining(['ietf-datastores:running', 'ietf-datastores:operational']));
    const schemas = await compileYangLibrary(library, { source: chainSources(fileSource([join(NP, 'yang')]), builtinSource) });
    expect(schemas.diagnostics).toEqual([]);
    // libyang's own module `yang` is yang-version 1 but has unions with empty
    // members, which RFC 6020 §9.12 forbids: a real error, which libyang
    // overlooks in its internal module.
    for (const schema of new Set(schemas.schemas.values())) {
      expect(schema.errors.filter((e) => !(e.location.source ?? '').endsWith('/yang@2022-06-16.yang'))).toEqual([]);
      expect(new Set(schema.errors.map((e) => e.code))).toEqual(new Set(['invalid-union-member']));
      // No definition refers to a less current one (RFC 7950 §7.21.2).
      expect(schema.diagnostics.filter((d) => d.code.startsWith('status-reference'))).toEqual([]);
    }
    const operational = schemas.datastore('operational')!;
    const ours = yangLibraryData(operational)[YL]['module-set'] as { module: Entry[]; 'import-only-module'?: Entry[] }[];
    type Library = Record<string, { 'module-set': { module: Entry[]; 'import-only-module'?: Entry[] }[] }>;
    const theirs = (JSON.parse(readFileSync(join(CACHE, 'yanglint', 'library-netopeer2.json'), 'utf8')) as Library)[YL]!['module-set'][0]!;
    expect(lines(ours[0]!.module)).toEqual(lines(theirs.module));
    expect(lines(ours[0]!['import-only-module'])).toEqual(lines(theirs['import-only-module']));
  });
});

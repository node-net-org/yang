import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { builtinSource, chainSources, compileSchema, fileSource, memorySource, parseModule, type LeafNode } from '../../src/index.js';
import { compile, errorCodes, mod, node } from './support.js';

const revisioned = (name: string, revision: string, body = ''): string =>
  `module ${name} { yang-version 1.1; namespace "urn:${name}"; prefix ${name}; revision ${revision}; ${body} }`;

describe('loading', () => {
  it('loads imports as import-only modules', async () => {
    const schema = await compile([mod('b', 'leaf x { type a:t; }', '  import a { prefix a; }'), mod('a', 'typedef t { type string; } container unused;')]);
    expect(schema.errors).toEqual([]);
    expect(schema.module('a')).toMatchObject({ implemented: false, dataNodes: [] });
    expect(schema.implemented.map((m) => m.name)).toEqual(['b']);
  });

  it('reports a missing import at the import statement', async () => {
    const schema = await compile([mod('b', '', '  import missing { prefix x; }')]);
    expect(schema.errors).toMatchObject([{ code: 'module-not-found', message: 'module missing was not found', location: { source: 'm0.yang', line: 5 } }]);
  });

  it('reports import cycles, duplicate prefixes and a module that imports itself', async () => {
    const a = mod('a', '', '  import b { prefix b; }');
    const b = mod('b', '', '  import a { prefix a; }\n  import a { prefix b; }');
    expect(errorCodes(await compile([a, b]))).toEqual(expect.arrayContaining(['import-cycle', 'duplicate-prefix']));
    expect(errorCodes(await compile([mod('c', '', '  import c { prefix d; }')]))).toEqual(['self-import']);
  });

  it('includes submodules, whose definitions the whole module shares', async () => {
    const m = mod('m', 'container top { uses g; }', '  include s;');
    const s = 'submodule s { yang-version 1.1; belongs-to m { prefix m; } grouping g { leaf x { type t; } } typedef t { type uint8; } leaf y { type string; } }';
    const schema = await compile([m, s]);
    expect(schema.errors).toEqual([]);
    expect(schema.module('m')!.submodules).toEqual(['s']);
    expect(node(schema, '/m:top/x').module.name).toBe('m');
    expect(node(schema, '/m:y')).toBeDefined();
  });

  it('reports a submodule that belongs to another module, and a module included as a submodule', async () => {
    const m = mod('m', '', '  include s;\n  include other;');
    const s = 'submodule s { yang-version 1.1; belongs-to x { prefix x; } }';
    const schema = await compile([m, s, mod('other', '')]);
    expect(errorCodes(schema)).toEqual(expect.arrayContaining(['wrong-belongs-to', 'wrong-module-kind']));
  });

  it('picks the latest revision, or the one an import names', async () => {
    const source = chainSources(memorySource([revisioned('a', '2020-01-01', 'leaf old { type string; }'), revisioned('a', '2024-01-01', 'leaf new { type string; }')]), builtinSource);
    const latest = await compileSchema({ source, modules: ['a'] });
    expect(latest.module('a')!.revision).toBe('2024-01-01');
    const pinned = await compileSchema({ source, modules: [{ name: 'a', revision: '2020-01-01' }] });
    expect(pinned.find('/a:old')).toBeDefined();
  });

  it('loads each revision two importers name, with the types of each (RFC 7950 §5.6.5)', async () => {
    const source = memorySource([
      revisioned('a', '2020-01-01', 'typedef t { type uint8; }'),
      revisioned('a', '2024-01-01', 'typedef t { type string; }'),
      mod('b', 'leaf x { type a:t; }', '  import a { prefix a; revision-date 2024-01-01; }\n  import c { prefix c; }'),
      mod('c', 'typedef u { type a:t; }', '  import a { prefix a; revision-date 2020-01-01; }'),
      mod('d', 'leaf y { type c:u; }', '  import c { prefix c; }'),
    ]);
    const schema = await compileSchema({ source, modules: ['b', 'd'] });
    expect(schema.diagnostics).toEqual([]);
    expect(schema.allModules.filter((m) => m.name === 'a').map((m) => m.revision)).toEqual(['2024-01-01', '2020-01-01']);
    expect(schema.module('a')!.revision).toBe('2024-01-01');
    expect(schema.module('a', '2020-01-01')!.implemented).toBe(false);
    expect(node<LeafNode>(schema, '/b:x').type.builtin).toBe('string');
    expect(node<LeafNode>(schema, '/d:y').type.builtin).toBe('uint8');
  });

  it('makes the implemented or latest requested revision the primary one', async () => {
    const source = memorySource([revisioned('a', '2020-01-01'), revisioned('a', '2024-01-01'), revisioned('a', '2022-01-01')]);
    const importOnly = await compileSchema({ source, modules: [], importOnly: [{ name: 'a', revision: '2020-01-01' }, { name: 'a', revision: '2024-01-01' }] });
    expect(importOnly.module('a')!.revision).toBe('2024-01-01');
    expect(importOnly.allModules).toHaveLength(2);
    const implemented = await compileSchema({ source, modules: [{ name: 'a', revision: '2022-01-01' }], importOnly: [{ name: 'a', revision: '2024-01-01' }] });
    expect(implemented.module('a')).toMatchObject({ revision: '2022-01-01', implemented: true });
    expect(implemented.module('a', '2024-01-01')!.implemented).toBe(false);
    const twice = await compileSchema({ source, modules: [{ name: 'a', revision: '2022-01-01' }, { name: 'a', revision: '2024-01-01' }] });
    expect(errorCodes(twice)).toEqual(['multiple-implemented-revisions']);
  });

  it('falls back on the loaded revision when the source lacks the one an import names', async () => {
    const source = memorySource([revisioned('a', '2024-01-01'), mod('b', '', '  import a { prefix a; revision-date 2020-01-01; }')]);
    const schema = await compileSchema({ source, modules: ['a', 'b'] });
    expect(schema.errors).toEqual([]);
    expect(schema.diagnostics.map((d) => d.code)).toEqual(['revision-mismatch']);
  });

  it('reports syntax errors as diagnostics, with the location', async () => {
    const schema = await compile([mod('b', '', '  import a { prefix a; }'), 'module a { prefix "a; }']);
    expect(schema.errors).toMatchObject([{ code: 'syntax-error', location: { source: 'm1.yang', line: 1, column: 19 } }]);
  });
});

describe('sources', () => {
  const dir = mkdtempSync(join(tmpdir(), 'net-yang-'));
  afterAll(() => rmSync(dir, { recursive: true }));
  writeFileSync(join(dir, 'a@2020-01-01.yang'), revisioned('a', '2020-01-01'));
  writeFileSync(join(dir, 'a@2023-06-01.yang'), revisioned('a', '2023-06-01'));
  writeFileSync(join(dir, 'b.yang'), revisioned('b', '2022-02-02'));
  writeFileSync(join(dir, 'not-yang.txt'), 'x');

  const nameOf = (text: string | Uint8Array): string | undefined => {
    const { statement } = parseModule(text);
    return statement.substatements.find((s) => s.keyword === 'revision')?.argument;
  };

  it('fileSource finds name@revision.yang, the latest by default', async () => {
    const source = fileSource([dir]);
    expect(nameOf((await source.load('a'))!.text)).toBe('2023-06-01');
    expect(nameOf((await source.load('a', '2020-01-01'))!.text)).toBe('2020-01-01');
    expect(await source.load('a', '1999-01-01')).toBeUndefined();
    expect(await source.load('zzz')).toBeUndefined();
  });

  it('fileSource reads a plain name.yang to find its revision', async () => {
    const source = fileSource([join(dir, 'missing-dir'), dir]);
    expect((await source.load('b', '2022-02-02'))?.source).toBe(join(dir, 'b.yang'));
    expect(await source.load('b', '2021-01-01')).toBeUndefined();
  });

  it('builtinSource has the IETF base modules', async () => {
    expect(nameOf((await builtinSource.load('ietf-yang-types'))!.text)).toBe('2025-12-22');
    expect(nameOf((await builtinSource.load('ietf-inet-types', '2013-07-15'))!.text)).toBe('2013-07-15');
    const schema = await compileSchema({ source: builtinSource, modules: ['ietf-yang-library', 'ietf-netconf', 'ietf-restconf'] });
    expect(schema.errors).toEqual([]);
  });
});

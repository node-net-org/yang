/**
 * YANG 1.0's narrower submodule visibility (RFC 6020 §5.1, §7.2.2): a 1.0
 * module or submodule sees only its own module-level definitions and those of
 * the submodules it includes itself, so a submodule never sees its main
 * module's. YANG 1.1 made every definition visible module-wide (RFC 7950
 * §5.1). And a module must not include a submodule of the other YANG version
 * (RFC 7950 §12).
 *
 * Both are warnings: the definition is still used, as libyang uses it. The
 * layouts in test/fixtures/submodule-visibility are compared with yanglint's
 * and pyang's verdicts when scripts/yanglint-oracle.sh and
 * scripts/pyang-oracle.sh have recorded them. yanglint accepts every layout:
 * libyang applies neither rule. pyang rejects every YANG 1.0 layout @node-net/yang
 * warns about, and both mixed-version includes.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { builtinSource, chainSources, compileSchema, memorySource, type LeafNode, type Schema } from '../../src/index.js';
import { node } from './support.js';

const DIR = join(import.meta.dirname, '..', 'fixtures', 'submodule-visibility');
const CACHE = join(import.meta.dirname, '..', 'corpus', '.cache');
const YANGLINT = join(CACHE, 'yanglint', 'submodule-visibility');
const PYANG = join(CACHE, 'pyang-submodule-visibility');

/**
 * pyang 2.7.1 never implemented YANG 1.1's module-wide scope for typedefs,
 * groupings, identities and features (only for extensions, schema nodes and
 * leafref paths), so it rejects these valid YANG 1.1 layouts too.
 */
const PYANG_DIFFERENCES = new Set([
  'sibling-typedef-1.1',
  'sibling-grouping-1.1',
  'sibling-identity-default-1.1',
  'main-typedef-1.1',
  'main-typedef-prefixed-1.1',
  'main-grouping-1.1',
  'main-identity-1.1',
  'main-identityref-1.1',
  'main-feature-1.1',
  'transitive-1.1',
]);

/** Compiles module m from the files of a fixture directory, or from in-memory texts by file name. */
async function compileLayout(files: Record<string, string>): Promise<Schema> {
  const texts = Object.entries(files).map(([name, text]) => ({ text, source: `${name}.yang` }));
  return compileSchema({ source: chainSources(memorySource(texts), builtinSource), modules: ['m'] });
}

function fixture(name: string): Record<string, string> {
  const dir = join(DIR, name);
  return Object.fromEntries(readdirSync(dir).map((f) => [f.replace(/\.yang$/, ''), readFileSync(join(dir, f), 'utf8')]));
}

/** The code, file, line and message of each diagnostic. */
function found(schema: Schema): string[] {
  return schema.diagnostics.map((d) => `${d.severity} ${d.code} ${d.location.source ?? ''}:${d.location.line}: ${d.message}`);
}

const header = (version: string, kind: 'module' | 'submodule', name: string): string =>
  kind === 'module'
    ? `module ${name} { yang-version ${version}; namespace "urn:${name}"; prefix ${name};`
    : `submodule ${name} { yang-version ${version}; belongs-to m { prefix m; }`;

describe('YANG 1.0 submodule visibility', () => {
  it('names the definition, the submodule that defines it, and the include that would make it visible', async () => {
    const schema = await compileLayout(fixture('sibling-typedef-1'));
    expect(found(schema)).toEqual([
      "warning definition-not-included s1.yang:9: typedef 't' is defined in submodule s2, which YANG 1.0 submodule s1 doesn't include; add 'include s2;' to s1 (RFC 6020 §5.1)",
    ]);
  });

  it("says a main module's definition can't be seen from its submodule", async () => {
    const schema = await compileLayout(fixture('main-typedef-1'));
    expect(found(schema)).toEqual([
      "warning definition-not-included s1.yang:9: typedef 't' is defined in module m itself, which its YANG 1.0 submodule s1 can't see; move it into a submodule that s1 includes, or use yang-version 1.1 (RFC 6020 §5.1)",
    ]);
  });

  it('names the submodule to include directly when it is only included through another', async () => {
    const schema = await compileLayout(fixture('transitive-1'));
    expect(schema.diagnostics.map((d) => d.message)).toEqual([
      "typedef 't' is defined in submodule s3, which YANG 1.0 submodule s1 doesn't include; add 'include s3;' to s1 (RFC 6020 §5.1)",
    ]);
    const module = await compileLayout(fixture('module-through-submodule-1'));
    expect(found(module)).toEqual([
      "warning definition-not-included m.yang:8: typedef 't' is defined in submodule s2, which YANG 1.0 module m doesn't include; add 'include s2;' to m (RFC 6020 §5.1)",
    ]);
  });

  it('reports each kind of definition at the statement that refers to it', async () => {
    const kinds = ['main-grouping', 'main-identity', 'main-identityref', 'main-feature', 'main-extension', 'sibling-identity-default'];
    for (const kind of kinds) {
      const files = fixture(`${kind}-1`);
      const schema = await compileLayout(files);
      expect(schema.diagnostics, kind).toHaveLength(1);
      const d = schema.diagnostics[0]!;
      const line = files[d.location.source!.replace(/\.yang$/, '')]!.split('\n')[d.location.line - 1]!;
      expect(line, kind).toMatch(/uses h|base b|if-feature f|m:e|leaf l/);
    }
  });

  it('reports a reference once, however often its grouping is used', async () => {
    const schema = await compileLayout({
      m: `${header('1', 'module', 'm')} include s1; typedef t { type string; } container a { uses g; } container b { uses g; } list l { key k; leaf k { type string; } uses g; } }`,
      s1: `${header('1', 'submodule', 's1')} grouping g { leaf x { type t; } } }`,
    });
    expect(schema.diagnostics.map((d) => d.message.replace(/,.*/, ''))).toEqual(["typedef 't' is defined in module m itself"]);
  });

  it('judges a grouping by the file it is written in, not the file that uses it', async () => {
    // m sees s1, but the grouping in s1 refers to s2, which s1 doesn't include.
    const schema = await compileLayout({
      m: `${header('1', 'module', 'm')} include s1; include s2; container c { uses g; } }`,
      s1: `${header('1', 'submodule', 's1')} grouping g { leaf x { type t; } } }`,
      s2: `${header('1', 'submodule', 's2')} typedef t { type string; } }`,
    });
    expect(schema.diagnostics.map((d) => d.location.source)).toEqual(['s1.yang']);
  });

  it('still uses the definition, so the schema is the same as without the rule', async () => {
    const v1 = await compileLayout(fixture('sibling-typedef-1'));
    const v11 = await compileLayout(fixture('sibling-typedef-1.1'));
    expect(v1.errors).toEqual([]);
    expect(node<LeafNode>(v1, '/m:c/m:l').type).toMatchObject({ builtin: 'string', name: 't' });
    expect(node<LeafNode>(v11, '/m:c/m:l').type).toMatchObject({ builtin: 'string', name: 't' });
  });

  it('leaves out schema-node paths, which address the module tree that includes merge into', async () => {
    // pyang also limits augment targets and leafref paths in YANG 1.0; libyang doesn't.
    const schema = await compileLayout({
      m: `${header('1', 'module', 'm')} include s1; container c { leaf x { type string; } } }`,
      s1: `${header('1', 'submodule', 's1')} augment /m:c { leaf y { type leafref { path /m:c/m:x; } } } }`,
    });
    expect(schema.diagnostics).toEqual([]);
  });
});

describe('mixed-version includes', () => {
  it('warns at the include of a submodule of the other YANG version', async () => {
    expect(found(await compileLayout(fixture('mixed-1-includes-1.1')))).toEqual([
      'warning include-version-mismatch m.yang:5: module m is YANG version 1, but includes submodule s1, which is version 1.1 (RFC 7950 §12)',
    ]);
    expect(found(await compileLayout(fixture('mixed-1.1-includes-1')))).toEqual([
      'warning include-version-mismatch m.yang:5: module m is YANG version 1.1, but includes submodule s1, which is version 1 (RFC 7950 §12)',
    ]);
  });

  it('warns at an include in a submodule too', async () => {
    const schema = await compileLayout({
      m: `${header('1.1', 'module', 'm')} include s1; include s2; }`,
      s1: `${header('1.1', 'submodule', 's1')} include s2; }`,
      s2: `${header('1', 'submodule', 's2')} }`,
    });
    expect(schema.diagnostics.map((d) => `${d.location.source} ${d.code}`)).toEqual(['m.yang include-version-mismatch', 's1.yang include-version-mismatch']);
  });
});

const CASES = readFileSync(join(DIR, 'cases.txt'), 'utf8')
  .split('\n')
  .filter((l) => l.trim() !== '' && !l.startsWith('#'))
  .map((l) => {
    const [name, expected] = l.trim().split(/\s+/) as [string, string];
    return { name, expected };
  });

describe('fixture layouts cover every case', () => {
  it('has a directory for each case and a case for each directory', () => {
    const dirs = readdirSync(DIR).filter((e) => e !== 'cases.txt');
    expect(dirs.sort()).toEqual(CASES.map((c) => c.name).sort());
  });
});

describe.each(CASES)('submodule-visibility fixtures: $name', ({ name, expected }) => {
  const verdict = expected === 'ok' ? 'ok' : 'warn';

  it(expected === 'ok' ? 'compiles without diagnostics' : `reports ${expected}`, async () => {
    const schema = await compileLayout(fixture(name));
    expect(schema.diagnostics.map((d) => `${d.severity}:${d.code}`)).toEqual(expected === 'ok' ? [] : [expected]);
  });

  const libyang = ['ok', 'error'].find((v) => existsSync(join(YANGLINT, `${name}.${v}`)));
  it.skipIf(libyang === undefined)('is accepted by yanglint, which applies neither rule', () => {
    expect(libyang).toBe('ok');
  });

  const pyang = ['ok', 'error'].find((v) => existsSync(join(PYANG, `${name}.${v}`)));
  it.skipIf(pyang === undefined)('agrees with pyang: rejected where @node-net/yang warns', () => {
    const expectedPyang = verdict === 'warn' || PYANG_DIFFERENCES.has(name) ? 'error' : 'ok';
    expect(pyang).toBe(expectedPyang);
  });
});

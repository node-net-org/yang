/**
 * References to less current definitions (RFC 7950 §7.21.2): a current
 * definition referring to a deprecated or obsolete one, or a deprecated one
 * to an obsolete one. The modules in test/fixtures/status are compared with
 * yanglint's and pyang's verdicts when scripts/yanglint-oracle.sh and
 * scripts/pyang-oracle.sh have recorded them; where they differ, the lists
 * below say why.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { builtinSource, chainSources, compileSchema, memorySource, type Schema } from '../../src/index.js';
import { compile, mod } from './support.js';

const CODES = new Set(['status-reference', 'status-reference-other-module']);

/** The status diagnostics: severity, code, line and message. */
function found(schema: Schema): string[] {
  return schema.diagnostics.filter((d) => CODES.has(d.code)).map((d) => `${d.severity} ${d.code} ${d.location.line}: ${d.message}`);
}

describe('status references', () => {
  it('reports a reference within a module at the referring statement, naming both sides', async () => {
    const schema = await compile([mod('m', `typedef dt { status deprecated; type string; }\n  leaf a {\n    type dt;\n  }`)]);
    expect(found(schema)).toEqual([
      "warning status-reference 8: current leaf 'a' refers to deprecated typedef 'dt' of the same module, m, which RFC 7950 §7.21.2 forbids",
    ]);
    expect(schema.diagnostics[0]!.location.column).toBe(5);
    expect(schema.errors).toEqual([]);
  });

  it('reports a reference into another module with its own code, naming that module', async () => {
    const schema = await compile([
      mod('m', `leaf a { type o:ot; }`, '  import o { prefix o; }'),
      mod('o', `typedef ot { status obsolete; type string; }`),
    ]);
    expect(found(schema)).toEqual(["warning status-reference-other-module 6: current leaf 'a' refers to obsolete typedef 'ot' of module o"]);
  });

  it('counts a submodule as its module', async () => {
    const schema = await compileSchema({
      source: memorySource([
        { text: 'module m { yang-version 1.1; namespace "urn:m"; prefix m; include s; leaf a { type dt; } }', source: 'm.yang' },
        { text: 'submodule s { yang-version 1.1; belongs-to m { prefix m; } typedef dt { status deprecated; type string; } }', source: 's.yang' },
      ]),
      modules: ['m'],
    });
    expect(schema.diagnostics.map((d) => d.code)).toEqual(['status-reference']);
  });

  it('checks a grouping where it is defined, once however often it is used', async () => {
    const schema = await compile([
      mod(
        'm',
        `typedef dt { status deprecated; type string; }
  grouping g { leaf a { type dt; } }
  container c1 { uses g; }
  container c2 { status deprecated; uses g; }
  container c3 { uses g; }`,
      ),
    ]);
    // c2 is deprecated, but the grouping's own leaf is current.
    expect(found(schema)).toEqual(["warning status-reference 7: current leaf 'a' refers to deprecated typedef 'dt' of the same module, m, which RFC 7950 §7.21.2 forbids"]);
  });

  it("uses the effective status: the least current on the definition or anything enclosing it", async () => {
    const schema = await compile([
      mod(
        'm',
        `typedef dt { status deprecated; type string; }
  typedef ot { status obsolete; type string; }
  container c {
    status deprecated;
    leaf a { type dt; }
    leaf b { status current; type dt; }
    leaf o { type ot; }
    container d { typedef nt { type string; } }
  }
  container e {
    typedef nt { type string; }
    leaf x { type nt; }
  }`,
      ),
    ]);
    // b's explicit current doesn't make it more current than its container.
    expect(found(schema)).toEqual([
      "warning status-reference 12: deprecated leaf 'o' refers to obsolete typedef 'ot' of the same module, m, which RFC 7950 §7.21.2 forbids",
    ]);
  });

  it('checks every feature an if-feature names, including ones evaluation never reaches', async () => {
    const schema = await compile([mod('m', `feature f;\n  feature df { status deprecated; }\n  leaf a { if-feature "f or (df and not f)"; type string; }`)]);
    expect(found(schema)).toEqual([
      "warning status-reference 8: current leaf 'a' refers to deprecated feature 'df' of the same module, m, which RFC 7950 §7.21.2 forbids",
    ]);
  });

  it('checks schema node references against the compiled tree, where the node is used', async () => {
    const schema = await compile([
      mod(
        'm',
        `grouping g { leaf r { type leafref { path "../x"; } } }
  container old { status deprecated; leaf x { type string; } uses g; }
  container new { leaf x { type string; status obsolete; } uses g; }`,
      ),
    ]);
    // The same leafref is fine under old, where everything is deprecated.
    expect(found(schema)).toEqual(["warning status-reference 6: current leaf 'r' refers to obsolete leaf 'x' of the same module, m, which RFC 7950 §7.21.2 forbids"]);
  });

  it('names one node per must or when, the first less current one it selects', async () => {
    const schema = await compile([
      mod('m', `container dc { status deprecated; leaf x { type string; } }\n  leaf a { type string; must "/dc/x and /dc"; }`),
    ]);
    expect(found(schema)).toEqual([
      "warning status-reference 7: current must of leaf 'a' refers to deprecated container 'dc' of the same module, m, which RFC 7950 §7.21.2 forbids",
    ]);
  });

  it("says nothing about a deviation of a deprecated node, or what isn't deprecated", async () => {
    const schema = await compile(
      [
        mod('m', `deviation /o:dc { deviate not-supported; }\n  leaf a { status deprecated; type o:t; }`, '  import o { prefix o; }'),
        mod('o', `typedef t { type string; }\n  container dc { status deprecated; leaf x { type string; } }`),
      ],
      { implement: ['m', 'o'] },
    );
    expect(found(schema)).toEqual([]);
  });
});

const DIR = join(import.meta.dirname, '..', 'fixtures', 'status');
const CACHE = join(import.meta.dirname, '..', 'corpus', '.cache');
const YANGLINT = join(CACHE, 'yanglint', 'status');
const PYANG = join(CACHE, 'pyang-status');

/**
 * Where yanglint 2.1.30 differs. It rejects a reference within a module,
 * and only warns about must and when; it says nothing across modules. It
 * doesn't check typedefs derived from typedefs, identity bases, if-feature
 * or augment targets. It checks groupings nothing uses, which @node-net/yang
 * doesn't compile. And it takes a `uses` at its own status, so a uses inside
 * a deprecated container must say `status deprecated` itself, while every
 * other definition inherits its container's.
 */
const YANGLINT_VERDICT: Record<string, string> = {
  'typedef-chain': 'ok',
  'identity-base': 'ok',
  identityref: 'ok',
  'if-feature': 'ok',
  'if-feature-or': 'ok',
  'feature-if-feature': 'ok',
  'enum-if-feature': 'ok',
  augment: 'ok',
  'ok-inherited-uses': 'error',
  'ok-unused-grouping': 'error',
};

/**
 * Where pyang 2.7.1 differs. It rejects a reference within a module and says
 * nothing across modules. It compares only the statuses written on the two
 * definitions, so references from inside a deprecated container or grouping
 * are errors, and a leaf in a deprecated container counts as current. It
 * doesn't check union members, typedefs derived from typedefs, identity
 * bases, augment targets, must or when. It checks groupings nothing uses.
 */
const PYANG_VERDICT: Record<string, string> = {
  'typedef-chain': 'ok',
  'union-member': 'ok',
  'identity-base': 'ok',
  identityref: 'ok',
  leafref: 'ok',
  augment: 'ok',
  must: 'ok',
  when: 'ok',
  'ok-inherited': 'error',
  'ok-inherited-uses': 'error',
  'ok-in-grouping': 'error',
  'ok-unused-grouping': 'error',
};

const CASES = readFileSync(join(DIR, 'cases.txt'), 'utf8')
  .split('\n')
  .filter((l) => l.trim() !== '' && !l.startsWith('#'))
  .map((l) => {
    const [name, expected] = l.trim().split(/\s+/) as [string, string];
    return { name, expected };
  });

describe.each(CASES)('status fixtures: $name', ({ name, expected }) => {
  const file = `st-${name}.yang`;
  const sameModule = expected === 'warning:status-reference';
  const libyangVerdict = YANGLINT_VERDICT[name] ?? (sameModule ? (name === 'must' || name === 'when' ? 'warn' : 'error') : 'ok');
  const pyangVerdict = PYANG_VERDICT[name] ?? (sameModule ? 'error' : 'ok');

  it(expected === 'ok' ? 'compiles without diagnostics' : `reports ${expected} once`, async () => {
    const texts = [file, 'st-base.yang'].map((f) => ({ text: readFileSync(join(DIR, f), 'utf8'), source: f }));
    const schema = await compileSchema({ source: chainSources(memorySource(texts), builtinSource), modules: [`st-${name}`, 'st-base'] });
    expect(schema.diagnostics.map((d) => `${d.severity}:${d.code}`)).toEqual(expected === 'ok' ? [] : [expected]);
    for (const d of schema.diagnostics) expect(d.location.source).toBe(file);
  });

  const libyang = ['ok', 'warn', 'error'].find((v) => existsSync(join(YANGLINT, `${name}.${v}`)));
  it.skipIf(libyang === undefined)('agrees with yanglint', () => {
    expect(libyang).toBe(libyangVerdict);
  });

  const pyang = ['ok', 'error'].find((v) => existsSync(join(PYANG, `${name}.${v}`)));
  it.skipIf(pyang === undefined)('agrees with pyang', () => {
    expect(pyang).toBe(pyangVerdict);
  });
});

/**
 * The paths in `must` and `when` followed through the compiled schema
 * (RFC 7950 §6.4.1), and `when` conditions that depend on each other. The
 * modules in test/fixtures/xpath-schema are compared with yanglint's and
 * pyang's verdicts when scripts/yanglint-oracle.sh and scripts/pyang-oracle.sh
 * have recorded them; where they differ, the lists below say why.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { builtinSource, chainSources, compileSchema, memorySource, type Schema } from '../../src/index.js';
import { compile, mod } from './support.js';

const CODES = new Set(['xpath-unknown-node', 'xpath-state-from-config', 'xpath-not-implemented', 'when-cycle']);

/** The schema-path diagnostics: severity, code, line and message. */
function found(schema: Schema): string[] {
  return schema.diagnostics.filter((d) => CODES.has(d.code)).map((d) => `${d.severity} ${d.code} ${d.location.line}: ${d.message}`);
}

describe('paths followed through the schema', () => {
  it('reports a misspelt name at the expression, naming the step and where it looked', async () => {
    const schema = await compile([
      mod(
        'm',
        `container c {
    leaf interface-name { type string; }
    leaf y { type string; must "../interface-nmae = 'a'"; }
  }`,
      ),
    ]);
    expect(found(schema)).toEqual([`warning xpath-unknown-node 8: must "../interface-nmae = 'a'" of /m:c/y: 'interface-nmae' matches no node in /m:c`]);
    expect(schema.errors).toEqual([]);
    expect(schema.diagnostics[0]!.location.column).toBe(32);
  });

  it('checks a grouping in each place it is used, naming the place', async () => {
    const schema = await compile([
      mod(
        'm',
        `grouping g { leaf v { type string; must "../k"; } }
  container a { leaf k { type string; } uses g; }
  container b { uses g; }
  container c { uses g; leaf k { type string; } }`,
      ),
    ]);
    expect(found(schema)).toEqual([`warning xpath-unknown-node 6: must "../k" of /m:b/v: 'k' matches no node in /m:b`]);
  });

  it('names a choice or case that holds the when', async () => {
    const schema = await compile([mod('m', `container c { choice ch { case one { when "../y"; leaf a { type string; } } } leaf y { type string; } }`)]);
    expect(found(schema)).toEqual([`warning xpath-unknown-node 6: when "../y" of case 'one' in /m:c: 'y' matches no node at the top level`]);
  });

  it('starts an absolute path in a structure at its container, and also sees the datastore', async () => {
    const schema = await compile([
      mod(
        'm',
        `container top { leaf t { type string; } }
  sx:structure s {
    container d {
      leaf x { type string; }
      leaf y { type string; must "/s/d/x and /top/t and ../x"; }
      leaf z { type string; must "/s/d/nope"; }
    }
  }`,
        '  import ietf-yang-structure-ext { prefix sx; }',
      ),
    ]);
    expect(found(schema)).toEqual([`warning xpath-unknown-node 11: must "/s/d/nope" of /m:s/d/z: 'nope' matches no node in /m:s/d`]);
  });

  it('says nothing of a name an if-feature removed', async () => {
    const body = `feature f;
  container c {
    leaf x { if-feature f; type string; }
    uses g { if-feature f; }
    leaf y { type string; must "not(../x) and not(../w)"; }
  }
  grouping g { leaf w { type string; } }`;
    expect(found(await compile([mod('m', body)], { features: { m: [] } }))).toEqual([]);
    expect(found(await compile([mod('m', body)]))).toEqual([]);
  });

  it('says nothing about a disabled augment, but checks the rest of its target', async () => {
    const schema = await compile([
      mod(
        'm',
        `feature f;
  container c { leaf y { type string; must "../x or ../z"; } }
  augment /m:c { if-feature f; leaf x { type string; } }`,
      ),
    ], { features: { m: [] } });
    expect(found(schema)).toEqual([]);
  });

  it('follows a path into another module by its prefix, and only that module', async () => {
    const other = mod('o', 'container oc { leaf x { type string; } }');
    const schema = await compile([mod('m', `container c { leaf y { type string; must "/o:oc/o:x and /o:oc/x"; } }`, '  import o { prefix o; }'), other], { implement: ['m', 'o'] });
    // Unprefixed, x is in module m, the module of the must.
    expect(found(schema)).toEqual([`warning xpath-unknown-node 6: must "/o:oc/o:x and /o:oc/x" of /m:c/y: 'x' matches no node in /o:oc`]);
  });

  it("warns about '..' above the root only when nothing is left", async () => {
    const schema = await compile([mod('m', `container c { leaf y { type string; must "count((/c | /)/../c) > 0 and count(/../c) = 0"; } }`)]);
    expect(found(schema)).toEqual([`warning xpath-unknown-node 6: must "count((/c | /)/../c) > 0 and count(/../c) = 0" of /m:c/y: '..' climbs above the root`]);
  });

  it('never stops a module compiling', async () => {
    const schema = await compile([mod('m', `container c { leaf x { type string; when "../y"; } leaf y { type string; when "../x and ../nope and /zz"; } }`)]);
    expect(schema.errors).toEqual([]);
    expect(schema.diagnostics.every((d) => d.severity === 'warning')).toBe(true);
    expect(schema.find('/m:c/x')).toBeDefined();
  });
});

describe('when conditions that depend on each other', () => {
  it('names the whole cycle once, at the when of its first node', async () => {
    const schema = await compile([
      mod(
        'm',
        `container c {
    leaf x { type string; when "../y"; }
    leaf y { type string; when "../z"; }
    leaf z { type string; when "../x"; }
  }`,
      ),
    ]);
    expect(found(schema)).toEqual(['warning when-cycle 7: when conditions depend on each other: /m:c/x → /m:c/y → /m:c/z → /m:c/x (libyang rejects this)']);
  });

  it('finds a cycle through the nodes above the one referred to', async () => {
    const schema = await compile([
      mod(
        'm',
        `container p { when "../q/v = 'a'"; leaf v { type string; } }
  container q { when "../p/v = 'a'"; leaf v { type string; } }`,
      ),
    ]);
    expect(found(schema)).toEqual(["warning when-cycle 6: when conditions depend on each other: /m:p → /m:q → /m:p (libyang rejects this)"]);
  });

  it('finds a when that refers to its own node', async () => {
    const schema = await compile([mod('m', `container c { leaf x { type string; when ". = 'a'"; } }`)]);
    expect(found(schema)).toEqual([
      `warning when-cycle 6: the when ". = 'a'" of /m:c/x depends on the node itself or what is inside it, so it can't be evaluated (libyang rejects this)`,
    ]);
  });

  it('does not count a reference to a node above, or a must', async () => {
    const schema = await compile([
      mod(
        'm',
        `leaf k { type string; }
  container c {
    when "../k = 'a'";
    leaf x { type string; when "../../c/y and ../../k"; must "../y"; }
    leaf y { type string; must "../x"; }
  }`,
      ),
    ]);
    // x's when selects c, which has a when of its own, but x can't exist without c anyway.
    expect(found(schema)).toEqual([]);
  });
});

const DIR = join(import.meta.dirname, '..', 'fixtures', 'xpath-schema');
const CACHE = join(import.meta.dirname, '..', 'corpus', '.cache');
const YANGLINT = join(CACHE, 'yanglint', 'xpath-schema');
const PYANG = join(CACHE, 'pyang-xpath-schema');

/**
 * Where yanglint 2.1.30 differs. It rejects modules whose whens depend on
 * each other, where @node-net/yang warns (RFC 7950 forbids none of them). It
 * follows names after deref(), wildcards and other axes, and inside anydata,
 * where @node-net/yang gives up rather than risk a false warning.
 */
const YANGLINT_VERDICT: Record<string, string> = { 'ok-give-up': 'warn' };
/**
 * Where pyang 2.7.1 differs. It doesn't look for when cycles, doesn't warn
 * about modules that aren't implemented or about the descendant axis, and
 * rejects '..' above the root. Like yanglint, it follows paths that @node-net/yang
 * gives up on.
 */
const PYANG_VERDICT: Record<string, string> = {
  'cycle-2': 'ok',
  'cycle-3': 'ok',
  'cycle-ancestor': 'ok',
  'cycle-self': 'ok',
  'cycle-child': 'ok',
  'cycle-case': 'ok',
  'not-implemented': 'ok',
  descendant: 'ok',
  'above-root': 'error',
  'ok-give-up': 'warn',
};

const CASES = readFileSync(join(DIR, 'cases.txt'), 'utf8')
  .split('\n')
  .filter((l) => l.trim() !== '' && !l.startsWith('#'))
  .map((l) => {
    const [name, expected] = l.trim().split(/\s+/) as [string, string];
    return { name, expected };
  });

describe.each(CASES)('xpath-schema fixtures: $name', ({ name, expected }) => {
  const file = `xs-${name}.yang`;
  // yanglint rejects a when cycle and warns about the rest.
  const libyangVerdict = YANGLINT_VERDICT[name] ?? (expected === 'ok' ? 'ok' : expected === 'warning:when-cycle' ? 'error' : 'warn');
  const pyangVerdict = PYANG_VERDICT[name] ?? (expected === 'ok' ? 'ok' : 'warn');

  it(expected === 'ok' ? 'compiles without diagnostics' : `reports ${expected}`, async () => {
    const texts = [file, 'xs-base.yang', 'xs-other.yang'].map((f) => ({ text: readFileSync(join(DIR, f), 'utf8'), source: f }));
    const schema = await compileSchema({ source: chainSources(memorySource(texts), builtinSource), modules: [`xs-${name}`, 'xs-base'] });
    expect(schema.errors).toEqual([]);
    const got = [...new Set(schema.diagnostics.map((d) => `${d.severity}:${d.code}`))];
    expect(got).toEqual(expected === 'ok' ? [] : [expected]);
    // Reported at the must or when, in the fixture.
    for (const d of schema.diagnostics) {
      expect(d.location.source).toBe(file);
      expect(texts[0]!.text.split('\n')[d.location.line - 1]).toMatch(/must|when/);
    }
  });

  const libyang = ['ok', 'warn', 'error'].find((v) => existsSync(join(YANGLINT, `${name}.${v}`)));
  it.skipIf(libyang === undefined)('agrees with yanglint', () => {
    expect(libyang).toBe(libyangVerdict);
  });

  const pyang = ['ok', 'warn', 'error'].find((v) => existsSync(join(PYANG, `${name}.${v}`)));
  it.skipIf(pyang === undefined)('agrees with pyang', () => {
    expect(pyang).toBe(pyangVerdict);
  });
});

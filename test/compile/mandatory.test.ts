/**
 * Mandatory nodes in augments of another module (RFC 7950 §7.17, RFC 6020
 * §7.15) and under a choice's default case (RFC 7950 §7.9.3). The modules in
 * test/fixtures/mandatory are compiled against yanglint's and pyang's
 * verdicts when scripts/yanglint-oracle.sh and scripts/pyang-oracle.sh have
 * recorded them. @node-net/yang rejects the same modules as yanglint; where pyang
 * differs, the list below says why.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { builtinSource, chainSources, compileSchema, memorySource, type Schema } from '../../src/index.js';
import { compile, errorCodes, mod } from './support.js';

/** A target module with a config container, a choice, state data, an rpc and a notification. */
const base = mod(
  'b',
  `container c { leaf x { type string; } choice ch { case k { leaf k { type string; } } } }
  container st { config false; leaf x { type string; } }
  rpc r { input { leaf x { type string; } } }
  notification n { leaf x { type string; } }`,
);

/** Compiles module `a`, which imports `b`, with `body`. */
async function augmenting(body: string, version: '1' | '1.1' = '1.1'): Promise<Schema> {
  const a = mod('a', body, '  import b { prefix b; }').replace('yang-version 1.1;', `yang-version ${version};`);
  return compile([a, base], { implement: ['a', 'b'] });
}

/** The code, severity, line and message of each diagnostic. */
function found(schema: Schema): string[] {
  return schema.diagnostics.map((d) => `${d.severity} ${d.code} ${d.location.source ?? ''}:${d.location.line}: ${d.message}`);
}

describe('mandatory nodes added by an augment of another module', () => {
  it('reports a mandatory leaf, at the leaf, naming the augment', async () => {
    const schema = await augmenting(`augment /b:c {
    leaf m { type string; mandatory true; }
  }`);
    expect(found(schema)).toEqual([
      "error augment-adds-mandatory m0.yang:7: augment '/b:c' adds mandatory leaf 'm' to module b; make the augment conditional with 'when'",
    ]);
  });

  it('reports lists and leaf-lists with min-elements, and mandatory choices, anydata and anyxml', async () => {
    const schema = await augmenting(`augment /b:c {
    leaf-list ll { type string; min-elements 1; }
    list l { key k; leaf k { type string; } min-elements 2; }
    choice q { mandatory true; leaf q1 { type string; } leaf q2 { type string; } }
    anydata ad { mandatory true; }
    anyxml ax { mandatory true; }
    leaf-list ok1 { type string; min-elements 0; }
    list ok2 { key k; leaf k { type string; } leaf m { type string; mandatory true; } }
  }`);
    expect(schema.errors.map((e) => e.message.replace(/ to module.*/, ''))).toEqual([
      "augment '/b:c' adds leaf-list 'll' with min-elements 1",
      "augment '/b:c' adds list 'l' with min-elements 2",
      "augment '/b:c' adds mandatory choice 'q'",
      "augment '/b:c' adds mandatory anydata 'ad'",
      "augment '/b:c' adds mandatory anyxml 'ax'",
    ]);
  });

  it('looks into containers without presence, and reports the node inside', async () => {
    const schema = await augmenting(`augment /b:c {
    container n {
      container deeper {
        leaf m { type string; mandatory true; }
      }
    }
  }`);
    expect(found(schema)).toEqual([
      "error augment-adds-mandatory m0.yang:9: augment '/b:c' adds mandatory leaf 'm' (in container 'n') to module b; make the augment conditional with 'when'",
    ]);
  });

  it('stops at a container with presence', async () => {
    const schema = await augmenting('augment /b:c { container n { presence p; leaf m { type string; mandatory true; } } }');
    expect(schema.diagnostics).toEqual([]);
  });

  it('allows a new case of a choice to hold mandatory nodes, as libyang does', async () => {
    // pyang flags the shorthand form; a case isn't a mandatory node (RFC 7950 §3).
    const schema = await augmenting(`augment /b:c/b:ch {
    case z { leaf m { type string; mandatory true; } }
    leaf short { type string; mandatory true; }
  }`);
    expect(schema.diagnostics).toEqual([]);
  });

  it('allows mandatory state data, rpc input and notification nodes', async () => {
    const schema = await augmenting(`augment /b:st { leaf m { type string; mandatory true; } }
  augment /b:r/b:input { leaf m { type string; mandatory true; } }
  augment /b:n { leaf m { type string; mandatory true; } }
  augment /b:c { leaf s { type string; mandatory true; config false; } }`);
    expect(schema.diagnostics).toEqual([]);
  });

  it('allows them under a when in YANG 1.1', async () => {
    const schema = await augmenting('augment /b:c { when "b:x"; leaf m { type string; mandatory true; } }');
    expect(schema.diagnostics).toEqual([]);
  });

  it('warns under a when in YANG 1.0, which RFC 6020 forbids but libyang allows', async () => {
    const schema = await augmenting('augment /b:c { when "b:x"; leaf m { type string; mandatory true; } }', '1');
    expect(schema.errors).toEqual([]);
    expect(found(schema)).toEqual([
      "warning augment-adds-mandatory m0.yang:6: augment '/b:c' adds mandatory leaf 'm' to module b; YANG 1.0 doesn't allow it even under 'when'",
    ]);
  });

  it('reports them without a when in YANG 1.0', async () => {
    const schema = await augmenting('augment /b:c { leaf m { type string; mandatory true; } }', '1');
    expect(found(schema)).toEqual(["error augment-adds-mandatory m0.yang:6: augment '/b:c' adds mandatory leaf 'm' to module b"]);
  });

  it('allows them in an augment of the same module, or of the module a submodule belongs to', async () => {
    const same = mod('s', 'container c; augment /s:c { leaf m { type string; mandatory true; } }');
    expect((await compile([same])).diagnostics).toEqual([]);
    const main = mod('s', 'include sub; container c;');
    const sub = 'submodule sub { yang-version 1.1; belongs-to s { prefix s; } augment /s:c { leaf m { type string; mandatory true; } } }';
    expect((await compile([main, sub])).diagnostics).toEqual([]);
  });

  it('reports a node made mandatory by refine', async () => {
    const schema = await augmenting('grouping g { leaf m { type string; } } augment /b:c { uses g { refine m { mandatory true; } } }');
    expect(errorCodes(schema)).toEqual(['augment-adds-mandatory']);
  });

  it('allows a node a refine makes not mandatory', async () => {
    const schema = await augmenting('grouping g { leaf m { type string; mandatory true; } } augment /b:c { uses g { refine m { mandatory false; } } }');
    expect(schema.diagnostics).toEqual([]);
  });

  it('sees deviations: they can make an added node mandatory, or not, as libyang does', async () => {
    const on = await augmenting('augment /b:c { leaf m { type string; } } deviation /b:c/a:m { deviate add { mandatory true; } }');
    expect(errorCodes(on)).toEqual(['augment-adds-mandatory']);
    const min = await augmenting('augment /b:c { leaf-list m { type string; } } deviation /b:c/a:m { deviate add { min-elements 1; } }');
    expect(errorCodes(min)).toEqual(['augment-adds-mandatory']);
    const off = await augmenting('augment /b:c { leaf m { type string; mandatory true; } } deviation /b:c/a:m { deviate replace { mandatory false; } }');
    expect(off.diagnostics).toEqual([]);
    const gone = await augmenting('augment /b:c { leaf m { type string; mandatory true; } } deviation /b:c/a:m { deviate not-supported; }');
    expect(gone.diagnostics).toEqual([]);
  });

  it('sees a deviation from a third module', async () => {
    const x = mod('x', 'augment /b:c { leaf m { type string; } }', '  import b { prefix b; }');
    const d = mod('d', 'deviation /b:c/x:m { deviate add { mandatory true; } }', '  import b { prefix b; }\n  import x { prefix x; }');
    const schema = await compile([d, x, base], { implement: ['d', 'x', 'b'] });
    expect(errorCodes(schema)).toEqual(['augment-adds-mandatory']);
  });

  it('checks the module of the target node, not of the path: an augment of nodes another module added', async () => {
    // a adds container `inner` to b's `c`, then augments its own `inner`: same module.
    const own = await augmenting('augment /b:c { container inner { presence p; } } augment /b:c/a:inner { leaf m { type string; mandatory true; } }');
    expect(own.diagnostics).toEqual([]);
  });
});

describe('mandatory nodes under the default case', () => {
  const choice = (cases: string, extra = ''): string => mod('m', `container c { choice ch { default x; ${cases} case y { leaf y { type string; } } } } ${extra}`);

  it('reports a mandatory leaf, at the leaf, naming the case and the choice', async () => {
    const schema = await compile([
      mod(
        'm',
        `container c {
    choice ch {
      default x;
      case x { leaf m { type string; mandatory true; } }
      case y { leaf y { type string; } }
    }
  }`,
      ),
    ]);
    expect(found(schema)).toEqual(["error mandatory-in-default-case m0.yang:9: mandatory leaf 'm' is in default case 'x' of choice 'ch'"]);
  });

  it('reports a shorthand default case', async () => {
    const schema = await compile([mod('m', 'choice ch { default m; leaf m { type string; mandatory true; } leaf y { type string; } }')]);
    expect(errorCodes(schema)).toEqual(['mandatory-in-default-case']);
  });

  it('allows mandatory nodes in the other cases', async () => {
    const schema = await compile([mod('m', 'container c { choice ch { default x; case x { leaf m { type string; } } case y { leaf y { type string; mandatory true; } } } }')]);
    expect(schema.diagnostics).toEqual([]);
  });

  it('reports min-elements, and a container without presence holding a mandatory node', async () => {
    const schema = await compile([choice('case x { leaf-list l { type string; min-elements 1; } container n { leaf m { type string; mandatory true; } } }')]);
    expect(schema.errors.map((e) => e.message)).toEqual([
      "leaf-list 'l' with min-elements 1 is in default case 'x' of choice 'ch'",
      "mandatory leaf 'm' (in container 'n') is in default case 'x' of choice 'ch'",
    ]);
  });

  it('stops at a container with presence and at a nested choice that is not mandatory', async () => {
    const schema = await compile([
      choice('case x { container n { presence p; leaf m { type string; mandatory true; } } choice in { case i { leaf m2 { type string; mandatory true; } } case j { leaf j { type string; } } } }'),
    ]);
    expect(schema.diagnostics).toEqual([]);
  });

  it('reports a nested choice that is mandatory', async () => {
    const schema = await compile([choice('case x { choice in { mandatory true; leaf i { type string; } leaf j { type string; } } }')]);
    expect(schema.errors.map((e) => e.message)).toEqual(["mandatory choice 'in' is in default case 'x' of choice 'ch'"]);
  });

  it('reports a node an augment adds to the default case', async () => {
    const schema = await compile([choice('case x { leaf a { type string; } }', 'augment /m:c/m:ch/m:x { leaf m { type string; mandatory true; } }')]);
    expect(errorCodes(schema)).toEqual(['mandatory-in-default-case']);
  });

  it('sees refines: of mandatory, and of the default itself', async () => {
    const g = (leaf: string, choiceRefine = ''): string =>
      mod('m', `grouping g { choice ch { ${choiceRefine === '' ? 'default x; ' : ''}case x { ${leaf} } case y { leaf y { type string; } } } } container c { uses g { ${choiceRefine} } }`);
    expect(errorCodes(await compile([g('leaf m { type string; }').replace('uses g { ', 'uses g { refine ch/x/m { mandatory true; } ')]))).toEqual([
      'mandatory-in-default-case',
    ]);
    expect((await compile([g('leaf m { type string; mandatory true; }').replace('uses g { ', 'uses g { refine ch/x/m { mandatory false; } ')])).diagnostics).toEqual([]);
    expect(errorCodes(await compile([g('leaf m { type string; mandatory true; }', 'refine ch { default x; }')]))).toEqual(['mandatory-in-default-case']);
  });

  it('sees deviations: they can make a node mandatory, or not, or make the case the default', async () => {
    const dev = (cases: string, deviation: string): string => mod('m', `container c { choice ch { ${cases} case y { leaf y { type string; } } } } deviation ${deviation}`);
    expect(errorCodes(await compile([dev('default x; case x { leaf m { type string; } }', '/m:c/m:ch/m:x/m:m { deviate add { mandatory true; } }')]))).toEqual([
      'mandatory-in-default-case',
    ]);
    expect((await compile([dev('default x; case x { leaf m { type string; mandatory true; } }', '/m:c/m:ch/m:x/m:m { deviate replace { mandatory false; } }')])).diagnostics).toEqual([]);
    expect(errorCodes(await compile([dev('case x { leaf m { type string; mandatory true; } }', '/m:c/m:ch { deviate add { default x; } }')]))).toEqual([
      'mandatory-in-default-case',
    ]);
  });
});

const DIR = join(import.meta.dirname, '..', 'fixtures', 'mandatory');
const CACHE = join(import.meta.dirname, '..', 'corpus', '.cache');
const YANGLINT = join(CACHE, 'yanglint', 'mandatory');
const PYANG = join(CACHE, 'pyang-mandatory');

/**
 * pyang checks augments before deviations and the default case without
 * deviations, treats a shorthand case's node as added to the target, checks
 * the target's config rather than the node's, and doesn't count a mandatory
 * choice. @node-net/yang follows libyang in each.
 */
const PYANG_DIFFERENCES = new Set([
  'aug-when-1.0',
  'aug-choice',
  'aug-config-false',
  'aug-shorthand-case',
  'aug-deviation',
  'aug-deviation-off',
  'default-deviation',
  'default-deviation-off',
]);

const CASES = readFileSync(join(DIR, 'cases.txt'), 'utf8')
  .split('\n')
  .filter((l) => l.trim() !== '' && !l.startsWith('#'))
  .map((l) => {
    const [name, expected] = l.trim().split(/\s+/) as [string, string];
    return { name, expected };
  });

describe.each(CASES)('mandatory-node fixtures: $name', ({ name, expected }) => {
  const file = `mn-${name}.yang`;
  const verdict = expected === 'ok' || expected.startsWith('warning:') ? 'ok' : 'error';

  it(expected === 'ok' ? 'compiles without diagnostics' : `reports ${expected}`, async () => {
    const texts = [file, 'mn-base.yang'].map((f) => ({ text: readFileSync(join(DIR, f), 'utf8'), source: f }));
    const schema = await compileSchema({ source: chainSources(memorySource(texts), builtinSource), modules: [`mn-${name}`, 'mn-base'] });
    const got = schema.diagnostics.map((d) => (d.severity === 'warning' ? `warning:${d.code}` : d.code));
    expect(got).toEqual(expected === 'ok' ? [] : [expected]);
    // Reported at the mandatory node, in the fixture.
    for (const d of schema.diagnostics) {
      expect(d.location.source).toBe(file);
      expect(texts[0]!.text.split('\n')[d.location.line - 1]).toMatch(/mandatory true|min-elements|\bm\b/);
    }
  });

  const libyang = ['ok', 'error'].find((v) => existsSync(join(YANGLINT, `${name}.${v}`)));
  it.skipIf(libyang === undefined)('agrees with yanglint', () => {
    // A warning is no rejection: libyang allows `when` in YANG 1.0 too, which RFC 6020 §7.15 doesn't, so @node-net/yang warns.
    expect(libyang).toBe(verdict);
  });

  const pyang = ['ok', 'error'].find((v) => existsSync(join(PYANG, `${name}.${v}`)));
  it.skipIf(pyang === undefined)('agrees with pyang', () => {
    if (PYANG_DIFFERENCES.has(name)) expect(pyang).not.toBe(verdict);
    else expect(pyang).toBe(verdict);
  });
});

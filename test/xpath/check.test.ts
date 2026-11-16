/**
 * Compile-time checks of XPath in must, when and leafref paths. Each module
 * in test/fixtures/xpath has one problem; cases.txt gives the diagnostic
 * @node-net/yang must report. When scripts/pyang-oracle.sh and
 * scripts/yanglint-oracle.sh have recorded pyang's and yanglint's verdicts,
 * @node-net/yang must reject exactly the modules each rejects, apart from the
 * differences listed here.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { builtinSource, chainSources, compileSchema, memorySource } from '../../src/index.js';

const DIR = join(import.meta.dirname, '..', 'fixtures', 'xpath');
const PYANG = join(import.meta.dirname, '..', 'corpus', '.cache', 'pyang-xpath');
const YANGLINT = join(import.meta.dirname, '..', 'corpus', '.cache', 'yanglint', 'xpath');

/**
 * pyang accepts XPath variables; YANG binds none (RFC 7950 §6.4.1), so libyang and @node-net/yang refuse them.
 * pyang also accepts a leafref path naming one list key in two predicates, which libyang and @node-net/yang refuse.
 */
const DIFFERENCES = new Set(['variable', 'lr-key-twice']);

/** libyang doesn't check the prefix of an identity named in a derived-from() literal. */
const YANGLINT_DIFFERENCES = new Set(['identity-prefix']);

/** Enough of ietf-interfaces for the fixtures, so the test needs no corpus. */
const INTERFACES = `module ietf-interfaces {
  yang-version 1.1;
  namespace "urn:ietf:params:xml:ns:yang:ietf-interfaces";
  prefix if;
  container interfaces {
    list interface {
      key name;
      leaf name { type string; }
      leaf enabled { type boolean; default true; }
    }
  }
}`;

const CASES = readFileSync(join(DIR, 'cases.txt'), 'utf8')
  .split('\n')
  .filter((l) => l.trim() !== '' && !l.startsWith('#'))
  .map((l) => {
    const [name, expected] = l.trim().split(/\s+/) as [string, string];
    return { name, expected };
  });

describe.each(CASES)('XPath compile checks: $name', ({ name, expected }) => {
  const file = `xp-${name}.yang`;
  const text = readFileSync(join(DIR, file), 'utf8');

  it(expected === 'ok' ? 'compiles without errors' : `reports ${expected}`, async () => {
    const schema = await compileSchema({
      source: chainSources(memorySource([{ text, source: file }, { text: INTERFACES, source: 'ietf-interfaces.yang' }]), builtinSource),
      modules: [`xp-${name}`],
    });
    const errors = schema.errors.map((d) => ({ code: d.code, line: d.location.line, source: d.location.source }));
    if (expected === 'ok') expect(errors).toEqual([]);
    else {
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ code: expected, source: file });
      // Reported at the statement holding the expression (or the leafref's leaf).
      const lines = text.split('\n');
      expect(lines[errors[0]!.line - 1]).toMatch(expected === 'invalid-path' || expected.startsWith('leafref-') ? /leaf ref|path/ : /must|when/);
    }
  });

  const verdict = ['ok', 'error'].find((v) => existsSync(join(PYANG, `${name}.${v}`)));
  it.skipIf(verdict === undefined)('agrees with pyang', () => {
    const ours = expected === 'ok' ? 'ok' : 'error';
    if (DIFFERENCES.has(name)) expect(verdict).not.toBe(ours);
    else expect(verdict).toBe(ours);
  });

  const libyang = ['ok', 'error'].find((v) => existsSync(join(YANGLINT, `${name}.${v}`)));
  it.skipIf(libyang === undefined)('agrees with yanglint', () => {
    const ours = expected === 'ok' ? 'ok' : 'error';
    if (YANGLINT_DIFFERENCES.has(name)) expect(libyang).not.toBe(ours);
    else expect(libyang).toBe(ours);
  });
});

describe('XPath compile checks', () => {
  it('has a case for every fixture module', () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith('.yang'));
    expect(files.sort()).toEqual(CASES.map((c) => `xp-${c.name}.yang`).sort());
  });

  it('warns about YANG 1.1 functions in a YANG 1.0 module, by the file the expression is in', async () => {
    const v10 = `module v10 { namespace "urn:v10"; prefix v; import v11 { prefix x; }
      container c { uses x:g; leaf a { type string; must "re-match(., 'a')"; } } }`;
    const v11 = `module v11 { yang-version 1.1; namespace "urn:v11"; prefix x;
      grouping g { leaf b { type string; must "re-match(., 'b')"; } } }`;
    const schema = await compileSchema({ source: memorySource([{ text: v10, source: 'v10.yang' }, { text: v11, source: 'v11.yang' }]), modules: ['v10'] });
    expect(schema.errors).toEqual([]);
    expect(schema.diagnostics.filter((d) => d.code === 'xpath-yang-1.1-function').map((d) => d.location.source)).toEqual(['v10.yang']);
  });

  it('warns about identities derived-from names that do not exist', async () => {
    const m = `module m { yang-version 1.1; namespace "urn:m"; prefix m; identity a;
      leaf x { type identityref { base a; } must "derived-from(., 'm:b')"; } }`;
    const schema = await compileSchema({ source: memorySource([{ text: m, source: 'm.yang' }]), modules: ['m'] });
    expect(schema.diagnostics.map((d) => [d.severity, d.code])).toEqual([['warning', 'xpath-unknown-identity']]);
  });
});

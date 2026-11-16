/**
 * Tree diagrams (RFC 8340). scripts/pyang-oracle.sh writes pyang's -f tree
 * output for every IETF RFC module, compiled together, to the corpus cache;
 * the comparison skips when it is absent.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { builtinSource, chainSources, compileSchema, fileSource, treeDiagram, type Schema } from '../../src/index.js';
import { compile, mod } from '../compile/support.js';

const CACHE = join(import.meta.dirname, '..', 'corpus', '.cache');

function allDirs(dir: string): string[] {
  return [dir, ...readdirSync(dir).filter((e) => e !== '.git' && statSync(join(dir, e)).isDirectory()).flatMap((e) => allDirs(join(dir, e)))];
}

/** Splits diagram text into sections, one per module. */
function sections(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of text.split(/^(?=module: )/m)) {
    const name = /^module: (\S+)/.exec(part)?.[1];
    if (name !== undefined) out.set(name, part.replace(/\n+$/, '\n'));
  }
  return out;
}

/** The first line where two texts differ, for a readable failure. */
function firstDifference(ours: string, theirs: string): string {
  const a = ours.split('\n');
  const b = theirs.split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) return `line ${i + 1}:\n  ours:   ${JSON.stringify(a[i])}\n  pyang:  ${JSON.stringify(b[i])}`;
  return '';
}

describe('tree diagrams', () => {
  it('print data, augments, rpcs and notifications as RFC 8340 shows them', async () => {
    const schema = await compile(
      [
        mod('ex', `
  feature fancy;
  container top {
    leaf name { type string; mandatory true; }
    leaf-list tags { type string; }
    list item {
      key "id";
      leaf id { type uint32; }
      leaf ref { type leafref { path "/ex:top/ex:name"; } }
      choice kind {
        leaf a { type empty; }
        case b { leaf b { if-feature fancy; type string; } }
      }
      action reset { input { leaf force { type boolean; } } }
    }
    container state { config false; presence "running"; leaf up { type boolean; } }
    anydata blob;
  }
  rpc go { input { leaf speed { type uint8; } } output { leaf ok { type boolean; } } }
  notification bump { leaf by { type int8; } }`),
        mod('aug', 'augment /ex:top { leaf extra { type string; status deprecated; } }', '  import ex { prefix ex; }'),
      ],
      { implement: ['ex', 'aug'] },
    );
    // Expected outputs are pyang 2.7.1's for the same modules.
    expect(treeDiagram(schema)).toBe(`module: ex
  +--rw top
     +--rw name         string
     +--rw tags*        string
     +--rw item* [id]
     |  +--rw id         uint32
     |  +--rw ref?       -> /top/name
     |  +--rw (kind)?
     |  |  +--:(a)
     |  |  |  +--rw a?   empty
     |  |  +--:(b)
     |  |     +--rw b?   string {fancy}?
     |  +---x reset
     |     +---w input
     |        +---w force?   boolean
     +--ro state!
     |  +--ro up?   boolean
     +--rw blob?        <anydata>
     x--rw aug:extra?   string

  rpcs:
    +---x go
       +---w input
       |  +---w speed?   uint8
       +--ro output
          +--ro ok?   boolean

  notifications:
    +---n bump
       +--ro by?   int8
`);
    // Printed without the module it augments, an augment gets its own section.
    expect(treeDiagram(schema, { modules: ['aug'] })).toBe('module: aug\n\n  augment /ex:top:\n    x--rw extra?   string\n');
    expect(treeDiagram(schema, { modules: ['ex'], depth: 1 })).toBe('module: ex\n  +--rw top\n        ...\n\n  rpcs:\n    +---x go\n          ...\n\n  notifications:\n    +---n bump\n          ...\n');
    expect(treeDiagram(schema, { modules: ['ex'], path: '/top/state' })).toBe('module: ex\n  +--rw top\n     +--ro state!\n        +--ro up?   boolean\n');
  });

  it('fold long lines', async () => {
    const schema = await compile([
      mod('fold', `
  container a-rather-long-container-name {
    leaf an-even-longer-leaf-name-to-push-the-type { type string; }
    list entries-with-keys { key "first-key-leaf second-key-leaf"; leaf first-key-leaf { type string; } leaf second-key-leaf { type string; } }
  }`),
    ]);
    expect(treeDiagram(schema, { lineLength: 50 })).toBe(`module: fold
  +--rw a-rather-long-container-name
     +--rw an-even-longer-leaf-name-to-push-the-type?
     |       string
     +--rw entries-with-keys*
             [first-key-leaf second-key-leaf]
        +--rw first-key-leaf     string
        +--rw second-key-leaf    string
`);
  });
});

for (const variant of [
  { file: 'pyang-tree-ietf.txt', lineLength: undefined },
  { file: 'pyang-tree-ietf-69.txt', lineLength: 69 },
]) {
  describe(`corpus: tree diagrams match pyang (${variant.file})`, () => {
    const oracle = join(CACHE, variant.file);
    const order = join(CACHE, 'pyang-tree-ietf.json');
    let schema: Promise<Schema> | undefined;
    it.skipIf(!existsSync(oracle) || !existsSync(order))('prints every IETF RFC module as pyang -f tree does', async () => {
      const modules = Object.keys(JSON.parse(readFileSync(order, 'utf8')) as Record<string, unknown>);
      const dirs = ['yangmodels/standard/ietf/RFC', 'yangmodels/standard/iana', 'yangmodels/standard/ieee/published'].flatMap((d) => allDirs(join(CACHE, d)));
      schema ??= compileSchema({ source: chainSources(fileSource(dirs), builtinSource), modules });
      const ours = sections(treeDiagram(await schema, { modules, ...(variant.lineLength === undefined ? {} : { lineLength: variant.lineLength }) }));
      const theirs = sections(readFileSync(oracle, 'utf8'));
      const problems: string[] = [];
      for (const [name, text] of theirs) {
        const mine = ours.get(name);
        if (mine === undefined) problems.push(`${name}: not printed`);
        else if (mine !== text) problems.push(`${name}: ${firstDifference(mine, text)}`);
      }
      for (const name of ours.keys()) if (!theirs.has(name)) problems.push(`${name}: printed, but pyang prints nothing`);
      expect(problems.slice(0, 15)).toEqual([]);
      expect(theirs.size).toBeGreaterThan(100);
    }, 120_000);
  });
}

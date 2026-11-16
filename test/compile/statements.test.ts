/**
 * A compiled schema releases the parsed statements it was compiled from,
 * unless asked to keep them (COMPILE-15).
 */
import { describe, expect, it } from 'vitest';
import {
  builtinSource,
  chainSources,
  compileSchema,
  compileYangLibrary,
  decodeXml,
  toJson,
  memorySource,
  readYangLibrary,
  treeDiagram,
  type Schema,
  type SchemaNode,
  type Statement,
} from '../../src/index.js';
import { mod } from './support.js';

const TEXTS = [
  mod(
    'm',
    `  include m-sub;
  extension marker { argument text; }
  container top {
    m:marker "kept" { description "an extension with a substatement"; }
    list entry {
      key "b a";
      leaf a { type string; }
      leaf b { type string; }
    }
  }
  rpc ping {
    output { leaf ok { type boolean; } }
  }
  sx:structure book {
    container shelf {
      config false;
      leaf title { type string; }
    }
  }`,
    '  import ietf-yang-structure-ext { prefix sx; }',
  ),
  `submodule m-sub {
  yang-version 1.1;
  belongs-to m { prefix m; }
  container from-sub { leaf x { type string; } }
}
`,
  mod('aug', `  augment "/m:top" { leaf added { type string; } }`, '  import m { prefix m; }'),
];

function compile(keepStatements?: boolean): Promise<Schema> {
  return compileSchema({
    source: chainSources(memorySource(TEXTS.map((text, i) => ({ text, source: `m${i}.yang` }))), builtinSource),
    modules: ['m', 'aug'],
    ...(keepStatements === undefined ? {} : { keepStatements }),
  });
}

function isStatement(v: unknown): v is Statement {
  return typeof v === 'object' && v !== null && 'keyword' in v && 'substatements' in v && 'location' in v;
}

/** Paths to every statement reachable from the schema's modules, not looking inside statements themselves. */
function reachableStatements(schema: Schema): string[] {
  const found: string[] = [];
  const seen = new Set<object>();
  const walk = (v: unknown, path: string): void => {
    if (typeof v !== 'object' || v === null || seen.has(v)) return;
    seen.add(v);
    if (isStatement(v)) {
      found.push(path);
      return;
    }
    if (v instanceof Map) for (const [k, x] of v) walk(x, `${path}{${String(k)}}`);
    else if (v instanceof Set) for (const x of v) walk(x, `${path}<>`);
    else for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
  };
  for (const m of schema.allModules) walk(m, m.name);
  return found;
}

function allNodes(schema: Schema): SchemaNode[] {
  const out: SchemaNode[] = [];
  const visit = (nodes: readonly SchemaNode[]): void => {
    for (const n of nodes) {
      out.push(n);
      visit(n.children);
    }
  };
  for (const m of schema.allModules) {
    visit([...m.dataNodes, ...m.rpcs, ...m.notifications]);
    for (const s of m.structures.values()) visit(s.nodes);
  }
  return out;
}

describe('releasing statements (COMPILE-15)', () => {
  it('releases the statements of nodes, modules, includes, augments and structures by default', async () => {
    const schema = await compile();
    expect(schema.diagnostics).toEqual([]);
    const m = schema.module('m')!;
    expect(m.statement).toBeUndefined();
    expect(m.includes.map((i) => [i.name, i.statement])).toEqual([['m-sub', undefined]]);
    expect(m.structures.get('book')!.statement).toBeUndefined();
    expect(schema.module('aug')!.augments.map((a) => a.statement)).toEqual([undefined]);
    const nodes = allNodes(schema);
    expect(nodes.length).toBeGreaterThan(10);
    expect(nodes.filter((n) => n.statement !== undefined).map((n) => n.name)).toEqual([]);
    // Nothing else holds a statement, except extension uses.
    expect(reachableStatements(schema).every((p) => /\.extensions\.\d+\.statement$/.test(p))).toBe(true);
  });

  it('keeps extension uses with their statements and substatements either way', async () => {
    for (const keep of [false, true]) {
      const top = (await compile(keep)).find('/m:top')!;
      const ext = top.extensions.find((e) => e.name === 'marker')!;
      expect(ext.argument).toBe('kept');
      expect(ext.statement.substatements.map((s) => s.keyword)).toEqual(['description']);
    }
  });

  it('keeps every statement with keepStatements', async () => {
    const schema = await compile(true);
    const m = schema.module('m')!;
    expect(m.statement?.keyword).toBe('module');
    expect(m.includes[0]!.statement?.keyword).toBe('submodule');
    expect(m.structures.get('book')!.statement?.keyword).toBe('sx:structure');
    expect(schema.module('aug')!.augments[0]!.statement?.keyword).toBe('augment');
    for (const n of allNodes(schema)) expect(n.statement, n.name).toBeDefined();
    expect(schema.find('/m:top/m:entry')!.statement?.keyword).toBe('list');
  });

  it('prints the same tree diagram whether or not statements are kept', async () => {
    const released = await compile();
    const kept = await compile(true);
    for (const options of [{}, { modules: ['m'] }]) {
      expect(treeDiagram(released, options)).toBe(treeDiagram(kept, options));
    }
    const text = treeDiagram(released);
    expect(text).toContain('+--rw entry* [b a]');
    expect(text).toContain('+--ro shelf');
  });

  it('compiles and decodes the same whether or not statements are kept', async () => {
    const released = await compile();
    const kept = await compile(true);
    const xml = '<top xmlns="urn:m"><entry><a>1</a><b>2</b></entry><added xmlns="urn:aug">x</added></top>';
    for (const schema of [released, kept]) {
      expect(schema.diagnostics).toEqual([]);
      expect(schema.children('/m:top')!.map((n) => n.name)).toEqual(['entry', 'added']);
      expect((schema.find('/m:top/m:entry') as SchemaNode & { keys: SchemaNode[] }).keys.map((k) => k.name)).toEqual(['b', 'a']);
    }
    expect(toJson(decodeXml(released, xml))).toEqual(toJson(decodeXml(kept, xml)));
  });

  it('passes keepStatements through when compiling a YANG library', async () => {
    const library = readYangLibrary({
      'ietf-yang-library:yang-library': {
        'module-set': [{ name: 'set', module: [{ name: 'm', namespace: 'urn:m', submodule: [{ name: 'm-sub' }] }] }],
        schema: [{ name: 's', 'module-set': ['set'] }],
        datastore: [{ name: 'ietf-datastores:running', schema: 's' }],
        'content-id': '1',
      },
    });
    const source = chainSources(memorySource(TEXTS.map((text, i) => ({ text, source: `m${i}.yang` }))), builtinSource);
    const released = (await compileYangLibrary(library, { source })).datastore('running')!;
    const kept = (await compileYangLibrary(library, { source, keepStatements: true })).datastore('running')!;
    expect(released.find('/m:top')!.statement).toBeUndefined();
    expect(kept.find('/m:top')!.statement?.keyword).toBe('container');
  });
});

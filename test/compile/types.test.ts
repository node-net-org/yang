import { describe, expect, it } from 'vitest';
import type { LeafListNode, LeafNode } from '../../src/index.js';
import { compile, errorCodes, mod, node } from './support.js';

async function leafType(body: string, path = '/m:x') {
  const schema = await compile([mod('m', body)]);
  return { schema, type: node<LeafNode>(schema, path).type };
}

describe('typedef chains', () => {
  it('combine restrictions and keep the chain', async () => {
    const { schema, type } = await leafType(`
  typedef small { type int32 { range "0..100"; } }
  typedef smaller { type small { range "10..20 | 30"; } }
  leaf x { type smaller; }`);
    expect(schema.errors).toEqual([]);
    expect(type).toMatchObject({ name: 'smaller', builtin: 'int32', range: [{ min: 10n, max: 20n }, { min: 30n, max: 30n }] });
    expect(type.typedef?.type.typedef?.name).toBe('small');
  });

  it('reject a range wider than the base type', async () => {
    const { schema } = await leafType('typedef small { type uint8 { range "0..10"; } } leaf x { type small { range "5..20"; } }');
    expect(schema.errors.map((e) => e.message)).toEqual(["range: '5..20' is not within the range allowed by the base type"]);
  });

  it('resolve min and max against the base range', async () => {
    const { type } = await leafType('typedef t { type int8 { range "-10..10"; } } leaf x { type t { range "min..0 | 5..max"; } }');
    expect(type.range).toEqual([
      { min: -10n, max: 0n },
      { min: 5n, max: 10n },
    ]);
  });

  it('inherit the typedef default and units', async () => {
    const { type, schema } = await leafType('typedef t { type uint8; default 7; units "s"; } typedef u { type t; } leaf x { type u; }');
    expect(type.typedef).toMatchObject({ default: '7', units: 's' });
    expect(node<LeafNode>(schema, '/m:x')).toMatchObject({ default: '7', units: 's' });
  });

  it('report unknown types, typedef cycles and restrictions the type does not allow', async () => {
    const schema = await compile([mod('m', 'typedef a { type b; } typedef b { type a; } leaf x { type a; } leaf y { type nope; } leaf z { type boolean { length 1; } }')]);
    expect(errorCodes(schema)).toEqual(expect.arrayContaining(['typedef-cycle', 'unknown-type', 'invalid-restriction']));
  });

  it('find typedefs in enclosing scopes before the module level', async () => {
    const { type } = await leafType('typedef t { type string; } container c { typedef t { type uint8; } leaf x { type t; } }', '/m:c/x');
    expect(type.builtin).toBe('uint8');
  });
});

describe('built-in types', () => {
  it('decimal64 needs fraction-digits and scales its range', async () => {
    const { type } = await leafType('leaf x { type decimal64 { fraction-digits 2; range "-1.5..2.25"; } }');
    expect(type).toMatchObject({ fractionDigits: 2, range: [{ min: -150n, max: 225n }] });
    const missing = await compile([mod('m', 'leaf x { type decimal64; }')]);
    expect(errorCodes(missing)).toEqual(['missing-fraction-digits']);
  });

  it('string combines length and every pattern along the chain', async () => {
    const { type } = await leafType('typedef t { type string { pattern "[a-z]+"; } } leaf x { type t { length "1..5"; pattern "a.*" { modifier invert-match; } } }');
    expect(type.length).toEqual([{ min: 1n, max: 5n }]);
    expect(type.patterns.map((p) => [p.source, p.invert])).toEqual([
      ['[a-z]+', false],
      ['a.*', true],
    ]);
  });

  it('enumeration assigns values after the highest so far', async () => {
    const { type } = await leafType('leaf x { type enumeration { enum a; enum b { value 10; } enum c; enum d { value -5; } enum e; } }');
    expect(type.enums?.map((e) => [e.name, e.value])).toEqual([
      ['a', 0],
      ['b', 10],
      ['c', 11],
      ['d', -5],
      ['e', 12],
    ]);
  });

  it('a derived enumeration can keep a subset of values (YANG 1.1)', async () => {
    const { type, schema } = await leafType('typedef t { type enumeration { enum a; enum b; enum c; } } leaf x { type t { enum c; enum a; } }');
    expect(schema.errors).toEqual([]);
    expect(type.enums?.map((e) => [e.name, e.value])).toEqual([
      ['c', 2],
      ['a', 0],
    ]);
    const bad = await compile([mod('m', 'typedef t { type enumeration { enum a; } } leaf x { type t { enum z; } }')]);
    expect(errorCodes(bad)).toEqual(['invalid-restriction']);
  });

  it('bits assigns positions and reports duplicates', async () => {
    const { type } = await leafType('leaf x { type bits { bit a; bit b { position 5; } bit c; } }');
    expect(type.bits?.map((b) => [b.name, b.position])).toEqual([
      ['a', 0],
      ['b', 5],
      ['c', 6],
    ]);
    const dup = await compile([mod('m', 'leaf x { type bits { bit a { position 1; } bit b { position 1; } } }')]);
    expect(errorCodes(dup)).toEqual(['duplicate-bit-position']);
  });

  it('union resolves member types in order', async () => {
    const { type } = await leafType('leaf x { type union { type int8; type string; type boolean; } }');
    expect(type.types?.map((t) => t.builtin)).toEqual(['int8', 'string', 'boolean']);
  });

  it('identityref links its bases', async () => {
    const { type } = await leafType('identity animal; identity dog { base animal; } leaf x { type identityref { base animal; } }');
    expect(type.bases?.map((b) => b.name)).toEqual(['animal']);
    expect([...type.bases![0]!.derived].map((d) => d.name)).toEqual(['dog']);
  });

  it('reports an invalid pattern', async () => {
    const schema = await compile([mod('m', 'leaf x { type string { pattern "[a-"; } }')]);
    expect(errorCodes(schema)).toEqual(['invalid-pattern']);
  });

  it('reports a pattern too large to match safely as invalid', async () => {
    const schema = await compile([mod('m', 'leaf x { type string { pattern "(a{1000}){1000}"; } }')]);
    expect(errorCodes(schema)).toEqual(['invalid-pattern']);
    expect(schema.errors[0]!.message).toContain('too large to match safely');
  });

  it('matches values against patterns in linear time', async () => {
    const { schema, type } = await leafType('leaf x { type string { pattern "([^%]+|%[nsStTcC%])+"; } }');
    expect(schema.errors).toEqual([]);
    const started = performance.now();
    expect(type.patterns[0]!.regexp.test('a'.repeat(50_000) + '%')).toBe(false);
    expect(type.patterns[0]!.regexp.test('a'.repeat(50_000) + '%n')).toBe(true);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('identities', () => {
  it('collect transitive derivations across modules and multiple bases', async () => {
    const a = mod('a', 'identity base; identity mid { base base; }');
    const b = mod('b', 'identity other; identity leafy { base a:mid; base other; }', '  import a { prefix a; }');
    const schema = await compile([b, a]);
    const base = schema.module('a')!.identities.get('base')!;
    expect([...base.derived].map((i) => `${i.module.name}:${i.name}`).sort()).toEqual(['a:mid', 'b:leafy']);
    expect(schema.module('b')!.identities.get('leafy')!.bases.map((i) => i.name)).toEqual(['mid', 'other']);
  });

  it('report unknown bases and cycles', async () => {
    const schema = await compile([mod('m', 'identity a { base b; } identity b { base a; } identity c { base nope; }')]);
    expect(errorCodes(schema)).toEqual(expect.arrayContaining(['unknown-identity', 'identity-cycle']));
  });
});

describe('leafref', () => {
  it('resolves relative and absolute paths to their target leaf', async () => {
    const schema = await compile([
      mod('m', `
  list item { key name; leaf name { type string; } }
  container c {
    leaf rel { type leafref { path "../../item/name"; } }
    leaf abs { type leafref { path "/m:item[m:name = current()/../rel]/m:name"; } }
  }`),
    ]);
    expect(schema.errors).toEqual([]);
    const target = node(schema, '/m:item/name');
    expect(node<LeafNode>(schema, '/m:c/rel').type.target).toBe(target);
    expect(node<LeafNode>(schema, '/m:c/abs').type.target).toBe(target);
  });

  it('resolves a leafref in a grouping relative to each place it is used', async () => {
    const schema = await compile([
      mod('m', `
  grouping g { leaf ref { type leafref { path "../target"; } } }
  container a { leaf target { type string; } uses g; }
  container b { leaf target { type uint8; } uses g; }`),
    ]);
    expect(node<LeafNode>(schema, '/m:a/ref').type.target).toBe(node(schema, '/m:a/target'));
    expect(node<LeafNode>(schema, '/m:b/ref').type.target).toBe(node(schema, '/m:b/target'));
  });

  it('looks through choices and cases, and into rpc input', async () => {
    const schema = await compile([mod('m', 'container c { choice ch { leaf t { type string; } } leaf r { type leafref { path "../t"; } } } rpc go { input { leaf a { type string; } leaf b { type leafref { path "../a"; } } } }')]);
    expect(schema.errors).toEqual([]);
    expect(node<LeafNode>(schema, '/m:go/b').type.target?.name).toBe('a');
  });

  it('reports a missing target and a target that is not a leaf', async () => {
    const schema = await compile([mod('m', 'container c { leaf a { type leafref { path "../nope"; } } leaf b { type leafref { path "/c"; } } }')]);
    expect(errorCodes(schema)).toEqual(['leafref-target-not-found', 'leafref-target-not-leaf']);
  });

  describe('predicates', () => {
    const items = `
  list item {
    key "name kind";
    leaf name { type string; }
    leaf kind { type string; }
    leaf value { type string; }
    container box { leaf v { type string; } }
  }
  leaf s { type string; }`;

    it.each([
      ['two predicates, with whitespace and prefixes', '/m:item[ m:name = current() / .. / s ][kind=current()/../s]/m:value'],
      ['a current() path that climbs to the top and back down', '/item[name = current()/../c/t]/value'],
      ['steps after the predicate', '/item[name = current()/../s]/box/v'],
    ])('accepts %s', async (_, path) => {
      const schema = await compile([mod('m', `${items}\n  container c { leaf t { type string; } }\n  leaf r { type leafref { path "${path}"; } }`)]);
      expect(schema.errors).toEqual([]);
    });

    it.each([
      ['/item/box[v = current()/../s]/v', "'box' has a predicate but is a container, not a list"],
      ['/item[nope = current()/../s]/value', "'nope' in a predicate is not a child of list 'item'"],
      ['/item[value = current()/../s]/name', "'value' in a predicate is not a key of list 'item'"],
      ['/item[name = current()/../s][kind = current()/../s][name = current()/../s]/value', "key 'name' of list 'item' is in two predicates"],
      ['/item[name = current()/../../s]/value', "the predicate on 'name' climbs above the top of the tree"],
      ['/item[name = current()/../nope]/value', "'nope' in the predicate on 'name' was not found"],
      ['/item[name = current()/../item]/value', "the predicate on 'name' must lead to a leaf, not a list"],
    ])('%s', async (path, problem) => {
      const schema = await compile([mod('m', `${items}\n  leaf r { type leafref { path "${path}"; } }`)]);
      expect(schema.errors.map((e) => [e.code, e.message])).toEqual([['leafref-invalid-predicate', `leafref path ${JSON.stringify(path)} of 'r': ${problem}`]]);
    });

    it('reports a missing node after a predicate', async () => {
      const schema = await compile([mod('m', `${items}\n  leaf r { type leafref { path "/item[name = current()/../s]/box/nope"; } }`)]);
      expect(errorCodes(schema)).toEqual(['leafref-target-not-found']);
    });

    it('checks a predicate in a grouping where the grouping is used', async () => {
      const schema = await compile([
        mod('m', `
  grouping g { leaf r { type leafref { path "../item[name = current()/../s]/name"; } } }
  container a { list item { key name; leaf name { type string; } } leaf s { type string; } uses g; }
  container b { list item { key id; leaf id { type string; } leaf name { type string; } } leaf s { type string; } uses g; }`),
      ]);
      expect(schema.errors.map((e) => e.message)).toEqual([`leafref path "../item[name = current()/../s]/name" of 'r': 'name' in a predicate is not a key of list 'item'`]);
    });

    it('resolves the current() path from an rpc input leaf', async () => {
      const schema = await compile([mod('m', `${items}\n  rpc go { input { leaf s { type string; } leaf r { type leafref { path "/item[name = current()/../s]/value"; } } } }`)]);
      expect(schema.errors).toEqual([]);
    });
  });

  it('implements the module a path points into', async () => {
    const a = mod('a', 'container c { leaf t { type string; } }');
    const b = mod('b', 'leaf r { type leafref { path "/a:c/a:t"; } }', '  import a { prefix a; }');
    const schema = await compile([b, a]);
    expect(schema.module('a')!.implemented).toBe(true);
    expect(node<LeafNode>(schema, '/b:r').type.target?.name).toBe('t');
  });
});

describe('default values', () => {
  it.each([
    ['leaf x { type uint8; default 300; }', "the default of 'x': value is outside the allowed range 0..255"],
    ['leaf x { type string { pattern "[0-9]+"; } default "a1"; }', 'the default of \'x\': \'a1\' does not match the pattern "[0-9]+"'],
    ['leaf x { type enumeration { enum a; } default b; }', "the default of 'x': 'b' is not one of the enum values"],
    ['leaf x { type boolean; default yes; }', "the default of 'x': 'yes' is not 'true' or 'false'"],
    ['leaf x { type empty; default ""; }', "'x' is of type empty and can't have a default"],
    ['leaf x { type decimal64 { fraction-digits 1; } default 1.25; }', "the default of 'x': '1.25' has more than 1 fraction digits"],
    ['leaf x { type string; mandatory true; default a; }', "leaf 'x' can't be mandatory and have a default"],
    ['identity a; identity b; leaf x { type identityref { base a; } default b; }', "the default of 'x': 'b' is not derived from m:a"],
    ['leaf-list x { type int8; default 1; default 200; }', "a default of 'x': value is outside the allowed range -128..127"],
  ])('%s', async (body, message) => {
    const schema = await compile([mod('m', body)]);
    expect(schema.errors.map((e) => e.message)).toContain(message);
  });

  it.each([
    'leaf x { type uint8; default 0xff; }',
    'leaf x { type int8; default -010; }',
    'leaf x { type bits { bit a; bit b; } default "b a"; }',
    'leaf x { type union { type int8; type enumeration { enum auto; } } default auto; }',
    'identity a; identity b { base a; } leaf x { type identityref { base a; } default m:b; }',
    'leaf t { type uint8; } leaf x { type leafref { path "../t"; } default 5; }',
  ])('accepts %s', async (body) => {
    const schema = await compile([mod('m', body)]);
    expect(schema.errors).toEqual([]);
  });

  it('uses the type default for a leaf-list with no defaults of its own', async () => {
    const schema = await compile([mod('m', 'typedef t { type uint8; default 3; } leaf-list x { type t; }')]);
    expect(node<LeafListNode>(schema, '/m:x').defaults).toEqual(['3']);
  });
});

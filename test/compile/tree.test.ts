import { describe, expect, it } from 'vitest';
import type { CaseNode, ChoiceNode, ContainerNode, LeafNode, ListNode, RpcNode } from '../../src/index.js';
import { compile, errorCodes, mod, names, node } from './support.js';

describe('groupings', () => {
  it('bind nodes to the namespace of the module where uses appears', async () => {
    const a = mod('a', 'grouping g { leaf x { type string; } }');
    const b = mod('b', 'container top { uses a:g; }', '  import a { prefix a; }');
    const schema = await compile([b, a]);
    expect(schema.errors).toEqual([]);
    expect(node(schema, '/b:top/x').module.name).toBe('b');
  });

  it('resolve names inside the grouping in the grouping module', async () => {
    const a = mod('a', 'typedef t { type uint8; } grouping g { leaf x { type t; } }');
    const b = mod('b', 'typedef t { type string; } uses a:g;', '  import a { prefix a; }');
    const schema = await compile([b, a]);
    expect(node<LeafNode>(schema, '/b:x').type.builtin).toBe('uint8');
  });

  it('expand nested uses, and lexically scoped groupings', async () => {
    const schema = await compile([
      mod('m', `
  grouping inner { leaf y { type string; } }
  grouping outer { container c { grouping local { leaf z { type string; } } uses local; uses inner; } }
  uses outer;`),
    ]);
    expect(names(node<ContainerNode>(schema, '/m:c').children)).toEqual(['z', 'y']);
  });

  it('apply refine: default, mandatory, presence, description, must and config', async () => {
    const schema = await compile([
      mod('m', `
  grouping g {
    leaf a { type string; }
    leaf b { type string; }
    container c { leaf d { type string; } }
  }
  container top {
    uses g {
      refine a { default "x"; description "refined"; }
      refine b { mandatory true; must "true()"; }
      refine c { presence "on"; config false; }
    }
  }`),
    ]);
    expect(schema.errors).toEqual([]);
    expect(node<LeafNode>(schema, '/m:top/a')).toMatchObject({ default: 'x', description: 'refined' });
    expect(node<LeafNode>(schema, '/m:top/b')).toMatchObject({ mandatory: true, must: [{ text: 'true()' }] });
    expect(node<ContainerNode>(schema, '/m:top/c')).toMatchObject({ presence: 'on', config: false });
    expect(node(schema, '/m:top/c/d').config).toBe(false);
  });

  it('remove a refined node whose added if-feature is disabled', async () => {
    const schema = await compile([mod('m', 'feature f; grouping g { leaf a { type string; } leaf b { type string; } } uses g { refine a { if-feature f; } }')], {
      features: { m: [] },
    });
    expect(names(schema.module('m')!.dataNodes)).toEqual(['b']);
  });

  it('apply augment inside uses, and add the uses when to every node', async () => {
    const schema = await compile([
      mod('m', `
  grouping g { container c { leaf a { type string; } } leaf l { type string; } }
  container top { uses g { when "../x"; augment "c" { leaf b { type string; } } } }`),
    ]);
    expect(names(node<ContainerNode>(schema, '/m:top/c').children)).toEqual(['a', 'b']);
    expect(node(schema, '/m:top/l').when.map((w) => w.text)).toEqual(['../x']);
  });

  it('report unknown and self-using groupings, and bad refine targets', async () => {
    const schema = await compile([mod('m', 'grouping g { uses g; } container a { uses nope; } container b { uses g; } grouping h { leaf x { type string; } } uses h { refine y { default 1; } }')]);
    expect(errorCodes(schema)).toEqual(expect.arrayContaining(['grouping-cycle', 'unknown-grouping', 'refine-target-not-found']));
  });
});

describe('augment', () => {
  it('adds nodes in the augmenting module, after the target children', async () => {
    const a = mod('a', 'container top { leaf x { type string; } }');
    const b = mod('b', 'augment "/a:top" { leaf y { type string; } }', '  import a { prefix a; }');
    const schema = await compile([a, b], { implement: ['a', 'b'] });
    const top = node<ContainerNode>(schema, '/a:top');
    expect(top.children.map((c) => `${c.module.name}:${c.name}`)).toEqual(['a:x', 'b:y']);
    expect(node(schema, '/a:top/b:y').parent).toBe(top);
  });

  it('applies augments that target nodes added by other augments, whatever the order', async () => {
    const a = mod('a', 'container top;');
    const b = mod('b', 'augment "/a:top/c:inner" { leaf deep { type string; } }', '  import a { prefix a; }\n  import c { prefix c; }');
    const c = mod('c', 'augment "/a:top" { container inner; }', '  import a { prefix a; }');
    const schema = await compile([b, a, c], { implement: ['b', 'c', 'a'] });
    expect(schema.errors).toEqual([]);
    expect(node(schema, '/a:top/c:inner/b:deep').module.name).toBe('b');
  });

  it('implements a module that is only imported when an augment targets it', async () => {
    const a = mod('a', 'container top;');
    const b = mod('b', 'augment "/a:top" { leaf y { type string; } }', '  import a { prefix a; }');
    const schema = await compile([b, a]);
    expect(schema.module('a')!.implemented).toBe(true);
    expect(node(schema, '/a:top/b:y')).toBeDefined();
  });

  it('wraps shorthand nodes in cases when augmenting a choice', async () => {
    const schema = await compile([mod('m', 'container top { choice ch { leaf a { type string; } } } augment "/top/ch" { leaf b { type string; } case c { leaf d { type string; } } }')]);
    const choice = node<ContainerNode>(schema, '/m:top').children[0] as ChoiceNode;
    expect(choice.children.map((c) => [c.name, c.shorthand])).toEqual([
      ['a', true],
      ['b', true],
      ['c', false],
    ]);
  });

  it('inherits config from its target and adds the augment when', async () => {
    const schema = await compile([mod('m', 'container s { config false; } augment "/s" { when "x"; leaf v { type string; } }')]);
    expect(node(schema, '/m:s/v')).toMatchObject({ config: false, when: [{ text: 'x' }] });
  });

  it('reports a missing target and an invalid target kind', async () => {
    const schema = await compile([mod('m', 'leaf l { type string; } augment "/nope" { leaf a { type string; } } augment "/l" { leaf b { type string; } }')]);
    expect(errorCodes(schema)).toEqual(['invalid-augment-target', 'augment-target-not-found']);
  });
});

describe('choice and case', () => {
  it('creates shorthand cases and resolves the default case', async () => {
    const schema = await compile([mod('m', 'choice ch { default b; leaf a { type string; } case b { leaf b1 { type string; } } }')]);
    const choice = schema.module('m')!.dataNodes[0] as ChoiceNode;
    expect(choice.children.map((c: CaseNode) => c.name)).toEqual(['a', 'b']);
    expect(choice.defaultCase?.name).toBe('b');
    expect(node(schema, '/m:b1').parent?.name).toBe('b');
  });

  it('reports a mandatory choice with a default, and an unknown default case', async () => {
    const schema = await compile([mod('m', 'choice c1 { mandatory true; default a; leaf a { type string; } } choice c2 { default zz; leaf b { type string; } }')]);
    expect(errorCodes(schema)).toEqual(['mandatory-with-default', 'unknown-default-case']);
  });

  it('reports duplicate names across a choice and its siblings', async () => {
    const schema = await compile([mod('m', 'leaf a { type string; } choice ch { leaf a { type string; } }')]);
    expect(errorCodes(schema)).toContain('duplicate-node');
  });
});

describe('config', () => {
  it('is inherited, and config true under config false is an error', async () => {
    const schema = await compile([mod('m', 'container s { config false; container t { leaf x { type string; } leaf y { config true; type string; } } }')]);
    expect(node(schema, '/m:s/t/x').config).toBe(false);
    expect(errorCodes(schema)).toEqual(['config-true-under-false']);
  });
});

describe('lists', () => {
  it('resolve keys in key order and unique leaves', async () => {
    const schema = await compile([mod('m', 'list l { key "b a"; unique "c/d"; leaf a { type string; } leaf b { type string; } container c { leaf d { type string; } } }')]);
    const list = node<ListNode>(schema, '/m:l');
    expect(names(list.keys)).toEqual(['b', 'a']);
    expect(list.keys.every((k) => k.isKey)).toBe(true);
    expect(list.unique.map(names)).toEqual([['d']]);
  });

  it('report a config list without a key, an unknown key and an unknown unique', async () => {
    const schema = await compile([mod('m', 'list a { leaf x { type string; } } list b { key y; leaf x { type string; } } list c { key x; unique z; leaf x { type string; } } list d { config false; leaf x { type string; } }')]);
    expect(errorCodes(schema)).toEqual(['missing-key', 'unknown-key', 'unknown-unique']);
  });

  it('read min-elements, max-elements and ordered-by', async () => {
    const schema = await compile([mod('m', 'leaf-list l { type string; min-elements 1; max-elements 3; ordered-by user; }')]);
    expect(node(schema, '/m:l')).toMatchObject({ minElements: 1, maxElements: 3, orderedBy: 'user' });
  });
});

describe('operations and notifications', () => {
  it('give every rpc an input and output, and nothing in them is config', async () => {
    const schema = await compile([mod('m', 'rpc go { input { leaf a { type string; } } } container c { action act; notification n { leaf b { type string; } } }')]);
    const rpc = schema.module('m')!.rpcs[0] as RpcNode;
    expect(rpc.children.map((c) => c.kind)).toEqual(['input', 'output']);
    expect(names(rpc.input.children)).toEqual(['a']);
    expect(rpc.output.children).toEqual([]);
    expect(node(schema, '/m:go/a').config).toBe(false);
    expect(node(schema, '/m:c/act').kind).toBe('action');
    expect(node(schema, '/m:c/n/b').config).toBe(false);
  });

  it('do not need keys on lists inside them', async () => {
    const schema = await compile([mod('m', 'rpc r { output { list l { leaf x { type string; } } } }')]);
    expect(schema.errors).toEqual([]);
  });
});

describe('features', () => {
  it('are all enabled by default', async () => {
    const schema = await compile([mod('m', 'feature f; leaf a { if-feature f; type string; }')]);
    expect(schema.module('m')!.enabledFeatures).toEqual(new Set(['f']));
    expect(node(schema, '/m:a')).toBeDefined();
  });

  it('remove nodes, enums and identities whose if-feature is disabled', async () => {
    const schema = await compile(
      [mod('m', `
  feature f; feature g;
  identity i { if-feature f; }
  leaf a { if-feature "f or g"; type string; }
  leaf b { if-feature "f and g"; type string; }
  leaf c { type enumeration { enum x { if-feature f; } enum y; } }`)],
      { features: { m: ['g'] } },
    );
    expect(names(schema.module('m')!.dataNodes)).toEqual(['a', 'c']);
    expect(schema.module('m')!.identities.has('i')).toBe(false);
    expect(node<LeafNode>(schema, '/m:c').type.enums?.map((e) => e.name)).toEqual(['y']);
  });

  it('make refines, augments and deviations of the nodes they remove do nothing, as in libyang', async () => {
    const schema = await compile(
      [
        mod('m', `
  feature f;
  grouping g { leaf a { if-feature f; type string; } container c { leaf x { type string; } } }
  container top { uses g { refine a { description "gone"; } refine c/x { description "here"; } } }
  notification n { if-feature f; }`),
        mod('aug', `
  augment /m:n { leaf y { type string; } }
  augment /m:top/m:a { leaf z { type string; } }
  deviation /m:n { deviate not-supported; }`, '  import m { prefix m; }'),
      ],
      { features: { m: [] }, implement: ['m', 'aug'] },
    );
    expect(schema.errors).toEqual([]);
    expect(node(schema, '/m:top/c/x').description).toBe('here');
    expect(schema.find('/m:top/a')).toBeUndefined();
    // A target that never existed is still an error.
    const wrong = await compile([mod('m', 'grouping g { leaf a { type string; } } container top { uses g { refine b { description "x"; } } }')]);
    expect(errorCodes(wrong)).toEqual(['refine-target-not-found']);
  });

  it('are disabled when their own if-feature is', async () => {
    const schema = await compile([mod('m', 'feature base; feature extra { if-feature base; }')], { features: { m: ['extra'] } });
    expect(schema.module('m')!.enabledFeatures).toEqual(new Set());
  });

  it('report unknown features in if-feature, and in the options', async () => {
    const schema = await compile([mod('m', 'leaf a { if-feature nope; type string; }')], { features: { m: ['missing'] } });
    expect(schema.diagnostics.map((d) => [d.severity, d.code])).toEqual([
      ['warning', 'unknown-feature'],
      ['error', 'unknown-feature'],
    ]);
  });
});

describe('deviations', () => {
  it('apply not-supported, replace, add and delete', async () => {
    const target = mod('t', 'container c { leaf a { type string; } leaf b { type uint8; default 1; units "s"; } leaf d { type string; } }');
    const dev = mod('d', `
  deviation "/t:c/t:a" { deviate not-supported; }
  deviation "/t:c/t:b" { deviate replace { type uint16; } deviate delete { default 1; units "s"; } }
  deviation "/t:c/t:d" { deviate add { must "true()"; default "x"; } }`, '  import t { prefix t; }');
    const schema = await compile([target, dev], { implement: ['t', 'd'] });
    expect(schema.errors).toEqual([]);
    expect(names(node<ContainerNode>(schema, '/t:c').children)).toEqual(['b', 'd']);
    const b = node<LeafNode>(schema, '/t:c/b');
    expect(b.type.builtin).toBe('uint16');
    expect(b.default).toBeUndefined();
    expect(b.units).toBeUndefined();
    expect(node<LeafNode>(schema, '/t:c/d')).toMatchObject({ default: 'x', must: [{ text: 'true()' }] });
  });

  it('leave the leafrefs, keys and defaults of a removed subtree unchecked, as libyang does', async () => {
    // Nokia's SR OS deviations remove /if:interfaces, whose leafrefs point into it.
    const t = mod('t', `
  container gone {
    list e { key n; leaf n { type string; } leaf r { type leafref { path "/t:gone/t:other"; } } leaf x { type uint8; default 300; } }
    leaf other { type string; }
  }
  container kept { leaf r { type leafref { path "/t:gone/t:other"; } } }`);
    const both = mod('d', 'deviation /t:gone { deviate not-supported; } deviation /t:kept { deviate not-supported; }', '  import t { prefix t; }');
    expect((await compile([t, both], { implement: ['t', 'd'] })).errors).toEqual([]);
    // A leafref that is still in the schema, into a removed subtree, is an error (libyang: "cannot be referenced because it is disabled").
    const one = mod('d', 'deviation /t:gone { deviate not-supported; }', '  import t { prefix t; }');
    expect(errorCodes(await compile([t, one], { implement: ['t', 'd'] }))).toEqual(['leafref-target-not-found']);
  });

  it('report a target that is not in an implemented module', async () => {
    const schema = await compile([mod('d', 'deviation "/t:c" { deviate not-supported; }', '  import t { prefix t; }'), mod('t', 'container c;')]);
    expect(errorCodes(schema)).toEqual(['deviation-target-not-found']);
  });
});

describe('Schema.find', () => {
  it('follows data paths through choices, cases and operation input', async () => {
    const schema = await compile([mod('m', 'container c { choice ch { case k { leaf x { type string; } } } } rpc r { input { leaf i { type string; } } }')]);
    expect(node(schema, '/m:c/x').name).toBe('x');
    expect(node(schema, 'm:r/i').name).toBe('i');
    expect(schema.find('/m:c/ch')).toBeUndefined();
    expect(schema.find('/c/x')).toBeUndefined();
    expect(schema.find('/other:c')).toBeUndefined();
  });
});

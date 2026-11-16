import { beforeAll, describe, expect, it } from 'vitest';
import {
  compileSchema,
  decodeJson,
  evaluateXPath,
  LeafInstance,
  memorySource,
  XPathError,
  type DataTree,
  type InstanceNode,
  type Schema,
  type XNode,
  type XPathValue,
} from '../../src/index.js';

export const XP = `module xp {
  yang-version 1.1;
  namespace "urn:example:xp";
  prefix xp;
  identity animal;
  identity dog { base animal; }
  identity puppy { base dog; }
  identity cat { base animal; }
  container top {
    leaf name { type string; }
    leaf d { type decimal64 { fraction-digits 2; } }
    leaf big { type int64; }
    leaf pet { type identityref { base animal; } }
    leaf color { type enumeration { enum red { value 10; } enum blue; } }
    leaf flags { type bits { bit a; bit b; bit c; } }
    leaf ref { type leafref { path "../item/id"; } }
    leaf iid { type instance-identifier; }
    leaf-list tag { type string; }
    list item {
      key id;
      leaf id { type string; }
      leaf n { type uint32; }
      container sub { leaf x { type string; } }
      action poke { input { leaf v { type string; } } }
    }
  }
}`;

let schema: Schema;
let tree: DataTree;

const DATA = {
  'xp:top': {
    name: 'top',
    d: '1.5',
    big: '9007199254740993',
    pet: 'xp:puppy',
    color: 'red',
    flags: 'a c',
    ref: 'b',
    iid: "/xp:top/item[id='b']/n",
    tag: ['x', 'y', 'x2'],
    item: [
      { id: 'a', n: 1, sub: { x: 'ax' } },
      { id: 'b', n: 2 },
      { id: 'c', n: 3, sub: { x: 'cx' } },
    ],
  },
};

beforeAll(async () => {
  schema = await compileSchema({ source: memorySource([{ text: XP, source: 'xp.yang' }]), modules: ['xp'] });
  expect(schema.errors).toEqual([]);
  tree = decodeJson(schema, DATA);
});

const opts = { defaultModule: 'xp' };
const ev = (expr: string, more: Parameters<typeof evaluateXPath>[2] = {}): XPathValue => evaluateXPath(tree, expr, { ...opts, ...more });
/** A node-set as paths, for comparison. */
const paths = (v: XPathValue): string[] => (v as XNode[]).map((n) => ('path' in n ? n.path : '/'));
const node = (expr: string): InstanceNode => (ev(expr) as InstanceNode[])[0]!;

describe('XPath evaluation: location paths', () => {
  it('selects by name, with prefixes, module names or the default module', () => {
    expect(paths(ev('/xp:top/xp:name'))).toEqual(['/xp:top/name']);
    expect(paths(ev('/xp:top/name'))).toEqual(['/xp:top/name']);
    expect(paths(evaluateXPath(tree, '/top/item/id'))).toHaveLength(3);
    expect(paths(evaluateXPath(tree, '/xp:top/xp:item/xp:id'))).toHaveLength(3);
    expect(paths(evaluateXPath(tree, '/top/name', { defaultModule: 'other' }))).toEqual([]);
    expect(ev('/')).toEqual([tree]);
  });

  it('follows every axis, with positions counted along the axis', () => {
    expect(paths(ev("/top/item[id='c']/preceding-sibling::item[1]"))).toEqual(["/xp:top/item[id='b']"]);
    expect(paths(ev("/top/item[id='c']/preceding-sibling::item"))).toEqual(["/xp:top/item[id='a']", "/xp:top/item[id='b']"]);
    expect(paths(ev("/top/item[id='a']/following-sibling::*[2]"))).toEqual(["/xp:top/item[id='c']"]);
    expect(paths(ev("/top/item[id='c']/sub/x/ancestor::*"))).toEqual(['/xp:top', "/xp:top/item[id='c']", "/xp:top/item[id='c']/sub"]);
    expect(paths(ev("/top/item[id='c']/sub/x/ancestor::*[1]"))).toEqual(["/xp:top/item[id='c']/sub"]);
    expect(paths(ev('//x'))).toEqual(["/xp:top/item[id='a']/sub/x", "/xp:top/item[id='c']/sub/x"]);
    expect(paths(ev("/top/item[id='b']/following::x"))).toEqual(["/xp:top/item[id='c']/sub/x"]);
    expect(paths(ev("/top/item[id='b']/preceding::x"))).toEqual(["/xp:top/item[id='a']/sub/x"]);
    expect(paths(ev('/top/item[2]/..'))).toEqual(['/xp:top']);
    expect(paths(ev('/top/item[last()]'))).toEqual(["/xp:top/item[id='c']"]);
    expect(ev('/top/@*')).toEqual([]);
  });

  it('keeps node-sets in document order without duplicates', () => {
    expect(paths(ev('/top/item[3]/id | /top/item[1]/id | /top/item[1]/id'))).toEqual(["/xp:top/item[id='a']/id", "/xp:top/item[id='c']/id"]);
    expect(paths(ev('//item//x | //sub'))).toHaveLength(4);
    expect(paths(ev('(//sub | //x)[1]'))).toEqual(["/xp:top/item[id='a']/sub"]);
    expect(paths(ev('/top/descendant-or-self::node()/x'))).toEqual(["/xp:top/item[id='a']/sub/x", "/xp:top/item[id='c']/sub/x"]);
  });
});

describe('XPath evaluation: comparisons and values', () => {
  it('compares node-sets as XPath §3.4 says', () => {
    expect(ev('/top/item/n = 2')).toBe(true);
    expect(ev('/top/item/n != 2')).toBe(true);
    expect(ev('/top/item/n > 2')).toBe(true);
    expect(ev('/top/item/n > 3')).toBe(false);
    expect(ev('2 < /top/item/n')).toBe(true);
    expect(ev('/top/item/id = /top/ref')).toBe(true);
    expect(ev('/top/nothing = /top/nothing')).toBe(false);
    expect(ev('/top/nothing != 1')).toBe(false);
    expect(ev('/top/item = true()')).toBe(true);
    expect(ev("/top/tag = 'y'")).toBe(true);
  });

  it('compares a leaf with a string in the canonical form of its type', () => {
    expect(ev("/top/d = '1.50'")).toBe(true);
    expect(ev("/top/d = '01.5'")).toBe(true);
    expect(ev('string(/top/d)')).toBe('1.5');
    expect(ev("/top/pet = 'xp:puppy'")).toBe(true);
    expect(ev("/top/pet = 'puppy'")).toBe(true);
    expect(ev('string(/top/pet)')).toBe('xp:puppy');
    expect(ev("/top/flags = 'c a'")).toBe(true);
    expect(ev("/top/iid = \"/xp:top/xp:item[xp:id='b']/xp:n\"")).toBe(true);
    // Not a valid value: compared as written.
    expect(ev("/top/d = 'abc'")).toBe(false);
  });

  it('converts 64-bit values to doubles, but compares their strings exactly', () => {
    expect(ev('string(/top/big)')).toBe('9007199254740993');
    expect(ev('number(/top/big)')).toBe(9007199254740992);
    expect(ev("/top/big = '9007199254740993'")).toBe(true);
    expect(ev("/top/big = '9007199254740992'")).toBe(false);
  });

  it('converts between types', () => {
    expect(ev('string(1 div 0)')).toBe('Infinity');
    expect(ev('string(0 div 0)')).toBe('NaN');
    expect(ev('string(-0)')).toBe('0');
    expect(() => ev('string(1e3)')).toThrow(XPathError);
    expect(ev('string(100000000000000000000000)')).toBe('100000000000000000000000');
    expect(ev('string(0.000001)')).toBe('0.000001');
    expect(ev('string(0.0000001)')).toBe('0.0000001');
    expect(ev("number(' 12 ')")).toBe(12);
    expect(ev("number('1e3')")).toBeNaN();
    expect(ev('boolean(/top/nothing)')).toBe(false);
    expect(ev("boolean('false')")).toBe(true);
    expect(ev('string(/top)')).toBe("top1.59007199254740993xp:puppyreda cb/xp:top/item[id='b']/nxyx2a1axb2c3cx");
  });
});

describe('XPath evaluation: the core function library (XPath §4)', () => {
  it.each([
    ['concat("a", "b", 1)', 'ab1'],
    ['starts-with("abc", "ab")', true],
    ['contains("abc", "d")', false],
    ['substring-before("1999/04/01", "/")', '1999'],
    ['substring-after("1999/04/01", "/")', '04/01'],
    ['substring("12345", 2, 3)', '234'],
    ['substring("12345", 2)', '2345'],
    ['substring("12345", 1.5, 2.6)', '234'],
    ['substring("12345", 0, 3)', '12'],
    ['substring("12345", 0 div 0, 3)', ''],
    ['substring("12345", 1, 0 div 0)', ''],
    ['substring("12345", -42, 1 div 0)', '12345'],
    ['substring("12345", -1 div 0, 1 div 0)', ''],
    ['string-length("añ😀")', 3],
    ['normalize-space("  a \t b  ")', 'a b'],
    ['translate("bar", "abc", "ABC")', 'BAr'],
    ['translate("--aaa--", "abc-", "ABC")', 'AAA'],
    ['round(2.5)', 3],
    ['round(-2.5)', -2],
    ['floor(-1.5)', -2],
    ['ceiling(1.2)', 2],
    ['sum(/top/item/n)', 6],
    ['count(/top/item)', 3],
    ['local-name(/top/item)', 'item'],
    ['name(/top/item)', 'xp:item'],
    ['namespace-uri(/top)', 'urn:example:xp'],
    ['not(true()) or false()', false],
    ['lang("en")', false],
    ['count(id("x"))', 0],
    ['7 mod -2', 1],
    ['-7 mod 2', -1],
    ['1 div -0 < 0', true],
  ])('%s', (expr, expected) => {
    expect(ev(expr)).toEqual(expected);
  });

  it('gives round() the sign of negative halves', () => {
    expect(Object.is(ev('round(-0.4)'), -0)).toBe(true);
  });
});

describe('XPath evaluation: the YANG function library (RFC 7950 §10)', () => {
  it('current() is the initial context node', () => {
    const n = node("/top/item[id='b']/n");
    expect(evaluateXPath(tree, '../../item[n = current() + 1]/id = "c"', { ...opts, context: n })).toBe(true);
    expect(evaluateXPath(tree, 'current()', { ...opts, context: n })).toEqual([n]);
  });

  it('re-match() uses XSD regular expressions, anchored', () => {
    expect(ev('re-match("1.22.333", "\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}")')).toBe(true);
    expect(ev('re-match("a.22.333", "\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}")')).toBe(false);
    expect(ev('re-match("abc", "b")')).toBe(false);
    expect(() => ev('re-match("a", "[")')).toThrow(XPathError);
  });

  it('re-match() takes linear time on patterns that backtrack exponentially', () => {
    const started = performance.now();
    expect(ev(`re-match("${'a'.repeat(10_000)}%", "([^%]+|%[nsStTcC%])+")`)).toBe(false);
    expect(ev(`re-match("${'a'.repeat(10_000)}!", "(a|a)*")`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(() => ev('re-match("a", "a{200000}")')).toThrow(XPathError);
  });

  it('deref() follows leafrefs and instance-identifiers', () => {
    expect(paths(ev('deref(/top/ref)'))).toEqual(["/xp:top/item[id='b']/id"]);
    expect(ev('deref(/top/ref)/../n')).toEqual([node("/top/item[id='b']/n")]);
    expect(paths(ev('deref(/top/iid)'))).toEqual(["/xp:top/item[id='b']/n"]);
    expect(ev('deref(/top/name)')).toEqual([]);
  });

  it('derived-from() and derived-from-or-self() test identities', () => {
    expect(ev("derived-from(/top/pet, 'xp:animal')")).toBe(true);
    expect(ev("derived-from(/top/pet, 'dog')")).toBe(true);
    expect(ev("derived-from(/top/pet, 'xp:puppy')")).toBe(false);
    expect(ev("derived-from-or-self(/top/pet, 'xp:puppy')")).toBe(true);
    expect(ev("derived-from(/top/pet, 'xp:cat')")).toBe(false);
    expect(ev("derived-from(/top/name, 'xp:animal')")).toBe(false);
    expect(ev("derived-from(/top/pet, 'xp:nothing')")).toBe(false);
  });

  it('enum-value() and bit-is-set()', () => {
    expect(ev('enum-value(/top/color)')).toBe(10);
    expect(ev('enum-value(/top/name)')).toBeNaN();
    expect(ev("bit-is-set(/top/flags, 'c')")).toBe(true);
    expect(ev("bit-is-set(/top/flags, 'b')")).toBe(false);
  });
});

describe('XPath evaluation: errors and limits', () => {
  it('reports unknown prefixes, variables and type errors', () => {
    expect(() => ev('/nope:top')).toThrow(/prefix 'nope'/);
    expect(() => ev('$v')).toThrow(/\$v has no value/);
    expect(ev('$v + 1', { variables: { v: 2 } })).toBe(3);
    expect(() => ev('count(1)')).toThrow(/node-set/);
    expect(() => ev('1 | /top')).toThrow(XPathError);
    expect(() => ev('frob()')).toThrow(/frob/);
  });

  it('stops evaluations that visit too many nodes', () => {
    expect(() => ev('count(//*[count(//*) > 0])', { budget: 200 })).toThrow(/stopped/);
    expect(ev('count(//*[count(//*) > 0])')).toBe(25);
  });
});

describe('XPath evaluation: indexed predicates', () => {
  it('gives the same answers through the key index as by testing every entry', () => {
    const item = Array.from({ length: 500 }, (_, i) => ({ id: `k${i}`, n: i % 7 }));
    const big = decodeJson(schema, { 'xp:top': { name: 'k42', item } });
    const name = big.children[0]!;
    const run = (e: string): XPathValue => evaluateXPath(big, e, { defaultModule: 'xp', context: (name as { children: InstanceNode[] }).children.find((c) => c instanceof LeafInstance)! });
    expect(paths(run('../item[id = current()]/n'))).toEqual(["/xp:top/item[id='k42']/n"]);
    expect(paths(run("../item[id = 'k7']"))).toEqual(["/xp:top/item[id='k7']"]);
    expect(paths(run("../item['k7' = id][1]"))).toEqual(["/xp:top/item[id='k7']"]);
    expect(paths(run("../item[id = /top/item[n = 6]/id]")).length).toBe(71);
    expect(run('count(../item[id = current()/../item[n = 6]/id])')).toBe(run('count(../item[string(id) = ../item[n = 6]/id])'));
    expect(run("count(../item[id = 'nope'])")).toBe(0);
  });
});

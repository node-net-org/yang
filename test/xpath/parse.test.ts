import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MAX_XPATH_DEPTH, parseXPath, printXPath, XPathError, type XPathExpr, type XPathStep } from '../../src/index.js';

const name = (n: string, prefix?: string): XPathStep => ({ axis: 'child', test: prefix === undefined ? { kind: 'name', name: n } : { kind: 'name', prefix, name: n }, predicates: [] });
const rel = (...steps: XPathStep[]): XPathExpr => ({ type: 'path', start: 'context', steps });
const PARENT: XPathStep = { axis: 'parent', test: { kind: 'node' }, predicates: [] };
const SELF: XPathStep = { axis: 'self', test: { kind: 'node' }, predicates: [] };
const DESC: XPathStep = { axis: 'descendant-or-self', test: { kind: 'node' }, predicates: [] };

function offsetOf(text: string): number | undefined {
  try {
    parseXPath(text);
  } catch (e) {
    if (e instanceof XPathError) return e.offset;
    throw e;
  }
  return undefined;
}

describe('XPath parser (XPath 1.0 §3)', () => {
  it('parses location paths, abbreviations included', () => {
    expect(parseXPath('/if:interfaces/if:interface')).toEqual({ type: 'path', start: 'root', steps: [name('interfaces', 'if'), name('interface', 'if')] });
    expect(parseXPath('../name')).toEqual(rel(PARENT, name('name')));
    expect(parseXPath('.')).toEqual(rel(SELF));
    expect(parseXPath('/')).toEqual({ type: 'path', start: 'root', steps: [] });
    expect(parseXPath('//a')).toEqual({ type: 'path', start: 'root', steps: [DESC, name('a')] });
    expect(parseXPath('a//b')).toEqual(rel(name('a'), DESC, name('b')));
    expect(parseXPath('@x:y')).toEqual(rel({ axis: 'attribute', test: { kind: 'name', prefix: 'x', name: 'y' }, predicates: [] }));
    expect(parseXPath('ancestor-or-self :: node()')).toEqual(rel({ axis: 'ancestor-or-self', test: { kind: 'node' }, predicates: [] }));
    expect(parseXPath('ex:*')).toEqual(rel({ axis: 'child', test: { kind: 'any', prefix: 'ex' }, predicates: [] }));
    expect(parseXPath("processing-instruction('p')")).toEqual(rel({ axis: 'child', test: { kind: 'processing-instruction', target: 'p' }, predicates: [] }));
  });

  it('parses predicates, filters and paths from expressions', () => {
    expect(parseXPath("interface[name = current()/../ifname]/mtu")).toEqual(
      rel(
        {
          axis: 'child',
          test: { kind: 'name', name: 'interface' },
          predicates: [{ type: 'binary', op: '=', left: rel(name('name')), right: { type: 'path', start: { type: 'call', name: 'current', args: [] }, steps: [PARENT, name('ifname')] } }],
        },
        name('mtu'),
      ),
    );
    expect(parseXPath('(a | b)[1]')).toEqual({
      type: 'filter',
      primary: { type: 'binary', op: '|', left: rel(name('a')), right: rel(name('b')) },
      predicates: [{ type: 'number', value: 1 }],
    });
    expect(parseXPath('deref(.)/../x')).toEqual({ type: 'path', start: { type: 'call', name: 'deref', args: [rel(SELF)] }, steps: [PARENT, name('x')] });
  });

  it('applies operator precedence and left associativity', () => {
    expect(printXPath(parseXPath('1 + 2 * 3 = 7 and not(a) or b'))).toBe('1 + 2 * 3 = 7 and not(a) or b');
    expect(parseXPath('8 - 4 - 2')).toEqual({ type: 'binary', op: '-', left: { type: 'binary', op: '-', left: { type: 'number', value: 8 }, right: { type: 'number', value: 4 } }, right: { type: 'number', value: 2 } });
    expect(parseXPath('- - 1')).toEqual({ type: 'negate', operand: { type: 'negate', operand: { type: 'number', value: 1 } } });
    expect(printXPath(parseXPath('(1 + 2) * 3'))).toBe('(1 + 2) * 3');
  });

  it('tells operators from names as §3.7 says', () => {
    // After an operand, * multiplies and div, mod, and, or are operators.
    expect(parseXPath('div div div')).toEqual({ type: 'binary', op: 'div', left: rel(name('div')), right: rel(name('div')) });
    expect(parseXPath('* * *')).toEqual({ type: 'binary', op: '*', left: rel({ axis: 'child', test: { kind: 'any' }, predicates: [] }), right: rel({ axis: 'child', test: { kind: 'any' }, predicates: [] }) });
    expect(parseXPath('and')).toEqual(rel(name('and')));
    // A name may contain '-' and '.'; subtraction needs spaces.
    expect(parseXPath('a-b')).toEqual(rel(name('a-b')));
    expect(parseXPath('a - b').type).toBe('binary');
    // A function call, a node type test, and a name that is neither.
    expect(parseXPath('text()')).toEqual(rel({ axis: 'child', test: { kind: 'text' }, predicates: [] }));
    expect(parseXPath('re-match(., "a")')).toMatchObject({ type: 'call', name: 're-match' });
    expect(parseXPath('ex:f(1)')).toEqual({ type: 'call', prefix: 'ex', name: 'f', args: [{ type: 'number', value: 1 }] });
    expect(parseXPath('.5 + 1.')).toEqual({ type: 'binary', op: '+', left: { type: 'number', value: 0.5 }, right: { type: 'number', value: 1 } });
    expect(parseXPath('$x:v')).toEqual({ type: 'variable', prefix: 'x', name: 'v' });
  });

  it('reports syntax errors with their offset', () => {
    expect(offsetOf('a[')).toBe(2);
    expect(offsetOf('a = = b')).toBe(4);
    expect(offsetOf('count(a')).toBe(7);
    expect(offsetOf(')')).toBe(0);
    expect(offsetOf("'abc")).toBe(0);
    expect(offsetOf('bogus::a')).toBe(0);
    expect(offsetOf('1 2')).toBe(2);
    expect(offsetOf('a / ')).toBe(4);
    expect(offsetOf('a # b')).toBe(2);
    expect(offsetOf('a foo b')).toBe(2);
    expect(() => parseXPath('a[')).toThrow(/offset 2 of "a\["/);
  });

  it('refuses nesting that would exhaust the stack', () => {
    expect(offsetOf(`${'('.repeat(100)}1${')'.repeat(100)}`)).toBeUndefined();
    expect(offsetOf(`${'('.repeat(100_000)}1${')'.repeat(100_000)}`)).toBeDefined();
    expect(offsetOf(`${'a['.repeat(100_000)}1${']'.repeat(100_000)}`)).toBeDefined();
    expect(offsetOf(`${'-'.repeat(100_000)}1`)).toBeDefined();
    expect(offsetOf(Array(MAX_XPATH_DEPTH - 10).fill('1').join(' + '))).toBeUndefined();
    expect(offsetOf(Array(100_000).fill('1').join(' + '))).toBeDefined();
    expect(offsetOf(Array(100_000).fill('a').join('/'))).toBeUndefined();
    // Printing iterates over long chains too.
    expect(printXPath(parseXPath(Array(MAX_XPATH_DEPTH - 10).fill('1').join(' or ')))).toHaveLength((MAX_XPATH_DEPTH - 10) * 5 - 4);
  });
});

/** Random syntax trees, for parse(print(tree)) = tree. */
const ident = fc.constantFrom('a', 'b', 'if', 'name', 'and', 'div', 'node-x', 'x.y', 'text', 'child');
const prefix = fc.option(fc.constantFrom('ex', 'if'), { nil: undefined });
const axis = fc.constantFrom('child', 'parent', 'self', 'descendant', 'descendant-or-self', 'ancestor', 'attribute', 'following-sibling', 'preceding-sibling') as fc.Arbitrary<XPathStep['axis']>;
const nodeTest = fc.oneof(
  fc.tuple(prefix, ident).map(([p, n]) => (p === undefined ? { kind: 'name' as const, name: n } : { kind: 'name' as const, prefix: p, name: n })),
  prefix.map((p) => (p === undefined ? { kind: 'any' as const } : { kind: 'any' as const, prefix: p })),
  fc.constantFrom({ kind: 'node' as const }, { kind: 'text' as const }),
);
const literal = fc.string({ unit: fc.constantFrom('a', ' ', "'", '/', ']', '1'), maxLength: 5 }).filter((s) => !(s.includes("'") && s.includes('"')));
const number = fc.oneof(fc.nat({ max: 10_000 }), fc.nat({ max: 999 }).map((n) => n / 8));

const { expr } = fc.letrec<{ expr: XPathExpr; step: XPathStep; path: XPathExpr }>((tie) => ({
  expr: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    literal.map((value) => ({ type: 'literal' as const, value })),
    number.map((value) => ({ type: 'number' as const, value })),
    tie('path'),
    fc
      .tuple(fc.constantFrom('or', 'and', '=', '!=', '<', '>=', '+', '-', '*', 'div', 'mod', '|'), tie('expr'), tie('expr'))
      .map(([op, left, right]) => ({ type: 'binary' as const, op: op as 'or', left, right })),
    tie('expr').map((operand) => ({ type: 'negate' as const, operand })),
    fc.tuple(fc.constantFrom('count', 'concat', 'current', 'deref', 'not'), fc.array(tie('expr'), { maxLength: 3 })).map(([n, args]) => ({ type: 'call' as const, name: n, args })),
    fc.tuple(tie('expr'), fc.array(tie('expr'), { minLength: 1, maxLength: 2 })).map(([primary, predicates]) => ({ type: 'filter' as const, primary, predicates })),
  ),
  step: fc.tuple(axis, nodeTest, fc.array(tie('expr'), { maxLength: 2 })).map(([a, test, predicates]) => ({ axis: a, test, predicates })),
  path: fc
    .tuple(fc.constantFrom<'root' | 'context' | 'call'>('root', 'context', 'call'), fc.array(tie('step'), { minLength: 1, maxLength: 3 }))
    .map(([start, steps]) => ({ type: 'path' as const, start: start === 'call' ? { type: 'call' as const, name: 'current', args: [] } : start, steps })),
}));

/** What parsing does to a tree: a filter with no predicates is its primary, and a path's start of path-filter type is kept. */
function normalise(e: XPathExpr): XPathExpr {
  switch (e.type) {
    case 'binary':
      return { ...e, left: normalise(e.left), right: normalise(e.right) };
    case 'negate':
      return { ...e, operand: normalise(e.operand) };
    case 'call':
      return { ...e, args: e.args.map(normalise) };
    case 'filter': {
      // a[x] filtered by [y] prints as a[x][y], one filter.
      const primary = normalise(e.primary);
      const predicates = e.predicates.map(normalise);
      return primary.type === 'filter' ? { ...primary, predicates: [...primary.predicates, ...predicates] } : { ...e, primary, predicates };
    }
    case 'path':
      return { ...e, start: typeof e.start === 'object' ? normalise(e.start) : e.start, steps: e.steps.map((s) => ({ ...s, predicates: s.predicates.map(normalise) })) };
    default:
      return e;
  }
}

describe('XPath printer', () => {
  it('prints text that parses to the same tree', () => {
    fc.assert(
      fc.property(expr, (e) => {
        const text = printXPath(e);
        expect(parseXPath(text)).toEqual(normalise(e));
      }),
      { numRuns: 2000 },
    );
  });

  it('prints the expressions of real modules so that they reparse the same', () => {
    for (const text of [
      "derived-from-or-self(/if:interfaces/if:interface[if:name = current()]/if:type, 'ianaift:ethernetCsmacd')",
      "../../../../../../nacm:groups/nacm:group/nacm:name",
      "not(../ipv4-address) or ../ipv4-address/prefix-length <= 32",
      "count(/a/b[c='x' or d != 2.5]) > 1 and -x mod 2 = 0",
      "(/)",
    ]) {
      expect(parseXPath(printXPath(parseXPath(text)))).toEqual(parseXPath(text));
    }
  });
});

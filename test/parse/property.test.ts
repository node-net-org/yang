import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseModule, YangSyntaxError, type Statement } from '../../src/index.js';
import { parseStatements } from '../../src/parse/parser.js';

interface Tree {
  keyword: string;
  argument: string | undefined;
  children: Tree[];
}

const identifier = fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_.-]{0,8}$/);
const keyword = fc.oneof(identifier, fc.tuple(identifier, identifier).map(([p, n]) => `${p}:${n}`));
/** Characters that stress quoting: quotes, backslashes, whitespace, comment starts, braces, non-ASCII. */
const argument = fc.string({
  unit: fc.constantFrom('a', 'Z', '0', ' ', '\t', '\n', '"', "'", '\\', '/', '*', ';', '{', '}', '+', 'é', '😀'),
  maxLength: 12,
});

function treeOf(depth: number): fc.Arbitrary<Tree> {
  return fc.record({
    keyword,
    argument: fc.option(argument, { nil: undefined }),
    children: depth === 0 ? fc.constant([]) : fc.array(treeOf(depth - 1), { maxLength: 3 }),
  });
}
const tree = treeOf(3);

/** Writes an argument so that it parses back unchanged. */
function quote(s: string): string {
  if (!s.includes("'")) return `'${s}'`;
  // Escape everything the double-quote trimming rules could touch.
  return `"${s.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n').replaceAll('\t', '\\t')}"`;
}

function write(t: Tree, indent: string): string {
  const head = indent + t.keyword + (t.argument === undefined ? '' : ' ' + quote(t.argument));
  if (t.children.length === 0) return head + ';\n';
  return head + ' {\n' + t.children.map((c) => write(c, indent + '  ')).join('') + indent + '}\n';
}

function read(s: Statement): Tree {
  return { keyword: s.keyword, argument: s.argument, children: s.substatements.map(read) };
}

describe('parser properties', () => {
  it('parses back any statement tree written with quoted arguments', () => {
    fc.assert(
      fc.property(fc.array(tree, { minLength: 1, maxLength: 3 }), (trees) => {
        const text = trees.map((t) => write(t, '')).join('');
        expect(parseStatements(text).statements.map(read)).toEqual(trees);
      }),
      { numRuns: 300 },
    );
  });

  it('either parses or throws YangSyntaxError, whatever the input', () => {
    const chars = fc.constantFrom('m', 'o', 'd', 'u', 'l', 'e', ' ', '\n', '"', "'", '\\', '/', '*', ';', '{', '}', '+', ':', '\u0000', '\uFEFF', '\uD800');
    fc.assert(
      fc.property(fc.oneof(fc.string({ unit: chars, maxLength: 60 }), fc.string({ maxLength: 60 }).map((s) => `module m { ${s} }`)), (text) => {
        try {
          parseModule(text);
        } catch (err) {
          expect(err).toBeInstanceOf(YangSyntaxError);
        }
      }),
      { numRuns: 1000 },
    );
  });
});

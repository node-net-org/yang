import { describe, expect, it } from 'vitest';
import { parseModule, substatement, YangSyntaxError, type Statement } from '../../src/index.js';
import { trimDoubleQuoted } from '../../src/parse/lexer.js';
import { codes, moduleText, parse } from '../support.js';

/** The argument of the first `description` in the module. */
function description(body: string, version: '1' | '1.1' = '1.1'): string | undefined {
  return substatement(parse(body, version).statement, 'description')?.argument;
}

function syntaxError(text: string): YangSyntaxError {
  try {
    parseModule(text, { source: 'x.yang' });
  } catch (err) {
    if (err instanceof YangSyntaxError) return err;
    throw err;
  }
  throw new Error('expected a YangSyntaxError');
}

describe('unquoted strings', () => {
  it('end at whitespace, ; and {', () => {
    const { statement } = parseModule('module m{yang-version 1.1;namespace urn:m;prefix m;}');
    expect(statement.substatements.map((s) => [s.keyword, s.argument])).toEqual([
      ['yang-version', '1.1'],
      ['namespace', 'urn:m'],
      ['prefix', 'm'],
    ]);
  });

  it('end at the start of a comment', () => {
    expect(description('description abc// comment\n;')).toBe('abc');
    expect(description('description abc/* comment */;')).toBe('abc');
  });

  it('can contain a single slash and a plus sign', () => {
    expect(description('description a/b+c;')).toBe('a/b+c');
    expect(description('description +;')).toBe('+');
  });

  it('report a quote character inside them', () => {
    const result = parse("description it's;");
    expect(codes(result)).toEqual(['quote-in-unquoted-string']);
    expect(result.diagnostics[0]!.location).toMatchObject({ line: 5, column: 15 });
  });
});

describe('single-quoted strings', () => {
  it('are taken literally: no escapes, no trimming', () => {
    expect(description(String.raw`description 'a\nb "c"';`)).toBe(String.raw`a\nb "c"`);
    expect(description("description 'line one\n     line two  ';")).toBe('line one\n     line two  ');
  });
});

describe('double-quoted strings', () => {
  it('replace the four escapes', () => {
    expect(description(String.raw`description "a\nb\tc\"d\\e";`)).toBe('a\nb\tc"d\\e');
  });

  it('keep any other backslash, and report it: an error in YANG 1.1, a warning in 1.0', () => {
    const v11 = parse(String.raw`description "a\Sb";`);
    expect(substatement(v11.statement, 'description')?.argument).toBe(String.raw`a\Sb`);
    expect(v11.diagnostics).toMatchObject([{ code: 'illegal-escape', severity: 'error', location: { line: 5, column: 15 } }]);
    const v1 = parse(String.raw`description "a\Sb";`, '1');
    expect(v1.diagnostics).toMatchObject([{ code: 'illegal-escape', severity: 'warning' }]);
  });

  it('strip indentation up to and including the column of the opening quote (RFC 7950 §6.1.3)', () => {
    // The quote is at 0-based column 12, so up to 13 columns of indentation are removed.
    const text = 'description "first\n             second\n               third\n   short";';
    expect(description(text)).toBe('first\nsecond\n  third\nshort');
  });

  it('strip whitespace before a line break, but not before the closing quote', () => {
    expect(description('description "a   \n             b  ";')).toBe('a\nb  ');
  });

  it('keep whitespace produced by escapes', () => {
    expect(description(String.raw`description "a\t` + '\n' + String.raw`             \tb";`)).toBe('a\t\n\tb');
  });

  it('accept CRLF line breaks', () => {
    const text = moduleText('description "one\n             two";').replaceAll('\n', '\r\n');
    expect(substatement(parseModule(text).statement, 'description')?.argument).toBe('one\ntwo');
  });

  it('are concatenated with +, quoting styles mixed', () => {
    expect(description(`description "a" + 'b'\n   + "c";`)).toBe('abc');
  });

  it('are processed before concatenation, each part on its own', () => {
    expect(description(String.raw`description "x\n" + '\n';`)).toBe('x\n\\n');
  });
});

describe('trimDoubleQuoted', () => {
  it('counts a tab as 8 columns and keeps the part of a tab beyond the quote column', () => {
    // Quote at 0-based column 3: strip up to 4 columns. A tab is 8, so 4 spaces remain.
    expect(trimDoubleQuoted('a\n\tb', 3)).toBe('a\n    b');
    expect(trimDoubleQuoted('a\n\tb', 7)).toBe('a\nb');
    expect(trimDoubleQuoted('a\n  \tb', 9)).toBe('a\nb');
  });

  it('leaves single-line strings alone', () => {
    expect(trimDoubleQuoted('  a  ', 5)).toBe('  a  ');
  });
});

describe('the quote column', () => {
  it('counts tabs before the opening quote as 8 columns', () => {
    // A tab, then `description "`: the quote is at column 8 + 12 = 20, so 21 columns are stripped.
    const text = 'module m {\n  yang-version 1.1;\n  namespace "urn:m";\n  prefix m;\n\tdescription "a\n' + ' '.repeat(23) + 'b";\n}\n';
    expect(substatement(parseModule(text).statement, 'description')?.argument).toBe('a\n  b');
  });
});

describe('comments', () => {
  it('are ignored between tokens, including inside a statement', () => {
    const { statement } = parse('leaf /* a */ x // b\n { /* c */ type string; }');
    const leaf = statement.substatements.find((s) => s.keyword === 'leaf')!;
    expect(leaf.argument).toBe('x');
    expect(leaf.substatements.map((s) => s.keyword)).toEqual(['type']);
  });

  it('are not recognised inside quoted strings', () => {
    expect(description('description "a // b /* c */";')).toBe('a // b /* c */');
  });
});

describe('characters', () => {
  it('reports control characters and noncharacters', () => {
    expect(codes(parse('description "a\u0001b￾c";'))).toEqual(['illegal-character', 'illegal-character']);
  });

  it('accepts supplementary-plane characters', () => {
    expect(description('description "😀";')).toBe('😀');
  });

  it('drops a byte-order mark', () => {
    expect(parseModule('﻿' + moduleText('')).diagnostics).toEqual([]);
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(moduleText(''))]);
    expect(parseModule(bytes).diagnostics).toEqual([]);
  });

  it('rejects invalid UTF-8', () => {
    expect(() => parseModule(new Uint8Array([0x6d, 0xff]), { source: 'bad.yang' })).toThrow(/bad\.yang:1:1: the text is not valid UTF-8/);
  });
});

describe('locations', () => {
  it('give the line and column of each keyword and argument', () => {
    const { statement } = parse('  leaf x {\n    type string;\n  }');
    const leaf = statement.substatements.find((s) => s.keyword === 'leaf')!;
    expect(leaf.location).toEqual({ source: 'm.yang', line: 5, column: 3, offset: expect.any(Number) as number });
    expect(leaf.argumentLocation).toMatchObject({ line: 5, column: 8 });
    expect(leaf.substatements[0]!.location).toMatchObject({ line: 6, column: 5 });
  });
});

describe('syntax errors', () => {
  it.each([
    ['module m { description "abc; }', 'x.yang:1:24: unterminated double-quoted string'],
    ["module m { description 'abc; }", 'x.yang:1:24: unterminated single-quoted string'],
    ['module m { /* abc }', 'x.yang:1:12: unterminated comment'],
    ['module m {\n  prefix m;\n', "x.yang:1:10: 'module' block is not closed: missing '}'"],
    ['module m { prefix m }', "x.yang:1:21: expected ';' or '{' after 'prefix' and its argument, found '}'"],
    ['module m { prefix m n; }', "x.yang:1:21: expected ';' or '{' after 'prefix' and its argument, found 'n'"],
    ['module m { "prefix" m; }', 'x.yang:1:12: expected a statement keyword, found a quoted string'],
    ['module m { 1abc; }', "x.yang:1:12: '1abc' is not a valid statement keyword"],
    ['module m { description "a" + b; }', "x.yang:1:28: '+' must be followed by a quoted string"],
    ['module m { } }', "x.yang:1:14: expected a statement keyword, found '}'"],
    ['', 'x.yang:1:1: expected a module or submodule, found no statements'],
    ['  // only a comment\n', 'x.yang:2:1: expected a module or submodule, found no statements'],
    ['container c;', "x.yang:1:1: expected 'module' or 'submodule', found 'container'"],
    ['module a; module b;', "x.yang:1:11: only one module is allowed per file, found 'module' after it"],
  ])('%j', (text, message) => {
    const err = syntaxError(text);
    expect(err.message).toBe(message);
    expect(err.code).toBe('ERR_NET_YANG_SYNTAX');
  });

  it('rejects nesting deeper than MAX_DEPTH', () => {
    const deep = 'module m { ' + 'container c { '.repeat(600) + '}'.repeat(601);
    expect(syntaxError(deep).message).toMatch(/nested more than 500 deep/);
  });
});

describe('extension statements', () => {
  it('have a prefix and may have any argument', () => {
    const { statement, diagnostics } = parse('ext:thing "any thing" { ext:inner; not-a-yang-statement x; }');
    const ext = statement.substatements.find((s: Statement) => s.keyword === 'ext:thing')!;
    expect(ext).toMatchObject({ prefix: 'ext', argument: 'any thing' });
    expect(diagnostics).toEqual([]);
  });
});

/** Writing statement trees as YANG text (PARSE-07). */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseModule, parseModuleText, parseYin, writeYang, type Statement } from '../../src/index.js';

interface Tree {
  keyword: string;
  argument: string | undefined;
  children: Tree[];
}
const read = (s: Statement): Tree => ({ keyword: s.keyword, argument: s.argument, children: s.substatements.map(read) });
const roundTrip = (s: Statement): Tree => read(parseModuleText({ text: writeYang(s) }).statement);

const toStatement = (t: Tree): Statement => {
  const colon = t.keyword.indexOf(':');
  return {
    keyword: t.keyword,
    ...(colon === -1 ? {} : { prefix: t.keyword.slice(0, colon) }),
    ...(t.argument === undefined ? {} : { argument: t.argument }),
    substatements: t.children.map(toStatement),
    location: { line: 1, column: 1, offset: 0 },
  };
};

const leaf = (keyword: string, argument: string): Tree => ({ keyword, argument, children: [] });
const module = (...children: Tree[]): Tree => ({ keyword: 'module', argument: 'm', children: [leaf('yang-version', '1.1'), leaf('namespace', 'urn:m'), leaf('prefix', 'm'), ...children] });

describe('PARSE-07 writing YANG text', () => {
  it('AC1: any statement tree reads back the same, whatever its arguments hold', () => {
    const identifier = fc.stringMatching(/^[a-z][a-z0-9-]{0,6}$/);
    const text = fc.string({
      unit: fc.constantFrom('a', 'Z', '1', ' ', '  ', '\t', '\n', '"', "'", '\\', '\\n', '+', '//', '/*', '*/', ';', '{', '}', ':', 'é', '😀'),
      maxLength: 12,
    });
    const none = fc.constant<Tree[]>([]);
    const node: fc.Memo<Tree> = fc.memo((depth) =>
      fc.oneof(
        fc.record<Tree>({ keyword: fc.constantFrom('container', 'leaf', 'default', 'must', 'pattern'), argument: text, children: depth <= 1 ? none : fc.array(node(depth - 1), { maxLength: 3 }) }),
        fc.record<Tree>({ keyword: fc.constantFrom('description', 'reference', 'error-message'), argument: text, children: none }),
        fc.record<Tree>({ keyword: fc.constantFrom('x:attr', 'x:elem'), argument: text, children: depth <= 1 ? none : fc.array(node(depth - 1), { maxLength: 2 }) }),
        fc.record<Tree>({ keyword: fc.constant('input'), argument: fc.constant(undefined), children: depth <= 1 ? none : fc.array(node(depth - 1), { maxLength: 2 }) }),
      ),
    );
    fc.assert(
      fc.property(identifier, fc.array(node(3), { maxLength: 4 }), (name, children) => {
        const tree: Tree = { keyword: 'module', argument: name, children };
        expect(roundTrip(toStatement(tree))).toEqual(tree);
      }),
      { numRuns: 500 },
    );
  });

  it('AC2: identifiers stay unquoted; other text is quoted, multi-line text as an indented double-quoted string', () => {
    const text = writeYang(
      toStatement(
        module(
          leaf('description', 'First line.\n\n  An indented second paragraph\nwith "quotes" and a \\ backslash.'),
          { keyword: 'leaf', argument: 'mtu', children: [leaf('type', 'uint16'), leaf('default', '1500'), leaf('must', ". > 64 and . != 'x'")] },
          leaf('pattern', "[a-z]+\\d*'\""),
          leaf('reference', 'trailing space \nbefore a break'),
        ),
      ),
    );
    expect(text).toContain('  namespace urn:m;\n');
    expect(text).toContain('  prefix m;\n');
    expect(text).toContain('  description "First line.\n\n                 An indented second paragraph\n               with \\"quotes\\" and a \\\\ backslash.";\n');
    expect(text).toContain('    type uint16;\n    default 1500;\n');
    expect(text).toContain(`    must ". > 64 and . != 'x'";\n`);
    // Every kind of quote and a backslash: single-quoted runs joined with +.
    expect(text).toContain(`  pattern '[a-z]+\\d*' + "'" + '"';\n`);
    // Whitespace before a break would be trimmed in double quotes: single quotes keep it.
    expect(text).toContain("  reference 'trailing space \nbefore a break';\n");
    expect(roundTrip(parseModuleText({ text }).statement)).toEqual(read(parseModuleText({ text }).statement));
  });

  it('AC3: extension statements keep their prefix, and substatements nest two spaces per level', () => {
    const tree = module({ keyword: 'container', argument: 'c', children: [{ keyword: 'x:note', argument: 'hi there', children: [leaf('description', 'deep')] }] });
    const text = writeYang(toStatement(tree));
    expect(text).toBe(
      [
        'module m {',
        '  yang-version 1.1;',
        '  namespace urn:m;',
        '  prefix m;',
        '',
        '  container c {',
        '    x:note "hi there" {',
        '      description deep;',
        '    }',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    expect(roundTrip(toStatement(tree))).toEqual(tree);
  });

  const CACHE = join(import.meta.dirname, '..', 'corpus', '.cache');
  const DIRS = [
    join(CACHE, 'yangmodels', 'standard', 'ietf', 'RFC'),
    join(CACHE, 'yangmodels', 'standard', 'iana'),
    join(CACHE, 'yangmodels', 'standard', 'ieee', 'published'),
    join(CACHE, 'openconfig', 'release', 'models'),
    join(CACHE, 'nokia'),
    join(CACHE, 'netopeer2'),
  ];
  const files = (dir: string, ext: string): string[] =>
    readdirSync(dir).flatMap((e) => {
      const p = join(dir, e);
      return statSync(p).isDirectory() ? files(p, ext) : e.endsWith(ext) ? [p] : [];
    });

  it.skipIf(!DIRS.some((d) => existsSync(d)))('AC4: every corpus module, and every YIN module from pyang -f yin, round-trips to the same tree', () => {
    const failures: string[] = [];
    let count = 0;
    for (const dir of DIRS.filter((d) => existsSync(d))) {
      for (const file of files(dir, '.yang')) {
        const parsed = parseModule(readFileSync(file), { source: file });
        count++;
        const again = roundTrip(parsed.statement);
        if (JSON.stringify(again) !== JSON.stringify(read(parsed.statement))) failures.push(relative(CACHE, file));
      }
    }
    const yinDir = join(CACHE, 'pyang-yin');
    if (existsSync(yinDir)) {
      for (const file of files(yinDir, '.yin')) {
        const parsed = parseYin(readFileSync(file), { source: file });
        count++;
        if (JSON.stringify(roundTrip(parsed.statement)) !== JSON.stringify(read(parsed.statement))) failures.push(relative(CACHE, file));
      }
    }
    expect(count).toBeGreaterThan(1000);
    expect(failures).toEqual([]);
  }, 300_000);
});

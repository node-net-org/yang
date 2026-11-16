import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { builtinSource, chainSources, compileSchema, memorySource, parseModule, parseYin, writeYin, YangSyntaxError, YIN_NAMESPACE, type Statement } from '../../src/index.js';

interface Tree {
  keyword: string;
  argument: string | undefined;
  children: Tree[];
}
const read = (s: Statement): Tree => ({ keyword: s.keyword, argument: s.argument, children: s.substatements.map(read) });

const YANG = `module ex {
  yang-version 1.1;
  namespace "urn:ex";
  prefix ex;
  import ietf-yang-metadata { prefix md; }
  description "Line one
    line two & <three>";
  extension note { argument text { yin-element true; } }
  extension tag { argument name; }
  extension flag;
  md:annotation weight { type uint8; }
  container top {
    ex:note "a <note>";
    ex:tag "t1";
    ex:flag;
    leaf x { type string { pattern '[a-z]+' { error-message "only letters"; } } }
    must "x != 'y'";
  }
}
`;

const YIN = `<?xml version="1.0" encoding="UTF-8"?>
<module name="ex"
        xmlns="${YIN_NAMESPACE}"
        xmlns:ex="urn:ex"
        xmlns:md="urn:ietf:params:xml:ns:yang:ietf-yang-metadata">
  <yang-version value="1.1"/>
  <namespace uri="urn:ex"/>
  <prefix value="ex"/>
  <import module="ietf-yang-metadata">
    <prefix value="md"/>
  </import>
  <description>
    <text>Line one
line two &amp; &lt;three&gt;</text>
  </description>
  <extension name="note">
    <argument name="text">
      <yin-element value="true"/>
    </argument>
  </extension>
  <extension name="tag">
    <argument name="name"/>
  </extension>
  <extension name="flag"/>
  <md:annotation name="weight">
    <type name="uint8"/>
  </md:annotation>
  <container name="top">
    <ex:note>
      <ex:text>a &lt;note&gt;</ex:text>
    </ex:note>
    <ex:tag name="t1"/>
    <ex:flag/>
    <leaf name="x">
      <type name="string">
        <pattern value="[a-z]+">
          <error-message>
            <value>only letters</value>
          </error-message>
        </pattern>
      </type>
    </leaf>
    <must condition="x != 'y'"/>
  </container>
</module>
`;

describe('YIN (RFC 7950 §13)', () => {
  it('reads the same statement tree as the YANG text, with no diagnostics', () => {
    const yin = parseYin(YIN, { source: 'ex.yin' });
    expect(yin.diagnostics).toEqual([]);
    expect(read(yin.statement)).toEqual(read(parseModule(YANG).statement));
    expect(yin.yangVersion).toBe('1.1');
  });

  it('gives locations of statements and arguments', () => {
    const { statement } = parseYin(YIN, { source: 'ex.yin' });
    const container = statement.substatements.find((s) => s.keyword === 'container')!;
    const line = YIN.split('\n').findIndex((l) => l.includes('<container')) + 1;
    expect(container.location).toMatchObject({ source: 'ex.yin', line, column: 3 });
    expect(container.argumentLocation).toMatchObject({ line, column: 20 });
    expect(container.substatements[0]!).toMatchObject({ keyword: 'ex:note', prefix: 'ex', argument: 'a <note>' });
  });

  it('reads extensions defined elsewhere: one attribute, or a text-only child in their namespace', () => {
    const yin = `<module name="m" xmlns="${YIN_NAMESPACE}" xmlns:o="urn:other"><namespace uri="urn:m"/><prefix value="m"/>
      <import module="other"><prefix value="o"/></import>
      <o:attr thing="v"/><o:elem><o:text>words</o:text></o:elem><o:bare/><o:nested><o:attr thing="w"/></o:nested>
      <x:aliased xmlns:x="urn:other" thing="z"/></module>`;
    const exts = parseYin(yin).statement.substatements.slice(3);
    expect(exts.map((s) => [s.keyword, s.argument, s.substatements.length])).toEqual([
      ['o:attr', 'v', 0],
      ['o:elem', 'words', 0],
      ['o:bare', undefined, 0],
      ['o:nested', undefined, 1],
      ['x:aliased', 'z', 0],
    ]);
  });

  it('reports a missing argument, an unknown statement and stray text as diagnostics', () => {
    const yin = `<module name="m" xmlns="${YIN_NAMESPACE}"><namespace uri="urn:m"/><prefix value="m"/><leaf><type name="string"/></leaf><frobnicate/>stray</module>`;
    expect(parseYin(yin).diagnostics.map((d) => d.code)).toEqual(expect.arrayContaining(['missing-argument', 'unknown-statement', 'unexpected-text']));
  });

  it('throws YangSyntaxError for malformed XML, a DOCTYPE or a root that is not a module', () => {
    expect(() => parseYin('<module name="m" xmlns="urn:ietf:params:xml:ns:yang:yin:1">', { source: 'bad.yin' })).toThrow(YangSyntaxError);
    expect(() => parseYin('<!DOCTYPE x><module/>')).toThrow(/DOCTYPE/);
    expect(() => parseYin('<module name="m"/>')).toThrow(/expected a YIN module/);
    expect(() => parseYin(`<module name="m" xmlns="${YIN_NAMESPACE}"><q:x/></module>`)).toThrow(/not declared/);
  });

  it('compiles from YIN text in a source, mixed with YANG modules', async () => {
    const other = 'module other { yang-version 1.1; namespace "urn:other"; prefix o; import ex { prefix ex; } augment /ex:top { leaf y { type string; } } }';
    const schema = await compileSchema({ source: chainSources(memorySource([YIN, other]), builtinSource), modules: ['ex', 'other'] });
    expect(schema.errors).toEqual([]);
    expect(schema.find('/ex:top/other:y')).toBeDefined();
    expect(schema.module('ex')!.annotations.get('weight')).toBeDefined();
  });

  it('writes YIN that reads back as the same tree', () => {
    const { statement } = parseModule(YANG);
    const text = writeYin(statement, { namespaces: { ex: 'urn:ex', md: 'urn:ietf:params:xml:ns:yang:ietf-yang-metadata' }, extensions: { 'ex:note': { argument: 'text', yinElement: true }, 'ex:tag': { argument: 'name', yinElement: false } } });
    expect(read(parseYin(text).statement)).toEqual(read(statement));
  });

  it('round-trips any statement tree through writeYin and parseYin', () => {
    const identifier = fc.stringMatching(/^[a-z][a-z0-9-]{0,6}$/);
    const text = fc.string({ unit: fc.constantFrom('a', 'Z', ' ', '\t', '\n', '"', "'", '&', '<', '>', ']]>', 'é', '😀'), maxLength: 10 });
    // Core statements with an attribute argument, one with an element argument, and extensions both ways.
    const none = fc.constant<Tree[]>([]);
    const node: fc.Memo<Tree> = fc.memo((depth) =>
      fc.oneof(
        fc.record<Tree>({ keyword: fc.constantFrom('container', 'leaf', 'default', 'must', 'pattern'), argument: text, children: depth <= 1 ? none : fc.array(node(depth - 1), { maxLength: 3 }) }),
        fc.record<Tree>({ keyword: fc.constantFrom('description', 'error-message'), argument: text, children: none }),
        fc.record<Tree>({ keyword: fc.constantFrom('x:attr', 'x:elem'), argument: text, children: depth <= 1 ? none : fc.array(node(depth - 1), { maxLength: 2 }) }),
        fc.record<Tree>({ keyword: fc.constant('input'), argument: fc.constant(undefined), children: depth <= 1 ? none : fc.array(node(depth - 1), { maxLength: 2 }) }),
      ),
    );
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
    fc.assert(
      fc.property(identifier, fc.array(node(3), { maxLength: 4 }), (name, children) => {
        const module: Tree = { keyword: 'module', argument: name, children };
        const yin = writeYin(toStatement(module), { namespaces: { x: 'urn:x' }, extensions: { 'x:attr': { argument: 'a', yinElement: false }, 'x:elem': { argument: 'e', yinElement: true } } });
        // \r is the one character XML can't keep as written in element text without escaping; the generator leaves it out.
        expect(read(parseYin(yin).statement)).toEqual(module);
      }),
      { numRuns: 300 },
    );
  });
});

const CACHE = join(import.meta.dirname, '..', 'corpus', '.cache');
const YIN_DIR = join(CACHE, 'pyang-yin');

function yinFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...yinFiles(p));
    else if (e.endsWith('.yin')) out.push(p);
  }
  return out;
}

describe('corpus: YIN from pyang -f yin', () => {
  it.skipIf(!existsSync(YIN_DIR))('parses every module to the statement tree its YANG gives', () => {
    const files = yinFiles(YIN_DIR);
    expect(files.length).toBeGreaterThan(500);
    const mismatches: string[] = [];
    let statements = 0;
    let whitespaceOnly = 0;
    let droppedArguments = 0;
    for (const file of files) {
      const rel = relative(YIN_DIR, file);
      const yang = parseModule(readFileSync(join(CACHE, rel.replace(/\.yin$/, '.yang'))), { source: rel }).statement;
      const yin = parseYin(readFileSync(file), { source: rel });
      for (const d of yin.diagnostics.filter((d) => d.code === 'missing-argument' || d.code === 'unknown-statement' || d.code === 'unexpected-text')) {
        mismatches.push(`${rel}:${d.location.line} ${d.code} ${d.message}`);
      }
      const compare = (ours: Statement, theirs: Statement): void => {
        statements++;
        if (ours.keyword !== theirs.keyword) {
          mismatches.push(`${rel}:${theirs.location.line} keyword ${ours.keyword} vs ${theirs.keyword}`);
          return;
        }
        if (ours.argument !== theirs.argument) {
          const strip = (s: string): string => s.replace(/\n[ \t]*/g, '\n');
          if (ours.argument !== undefined && theirs.argument !== undefined && strip(ours.argument) === strip(theirs.argument)) {
            // pyang trims tab-indented double-quoted strings differently (see corpus.test.ts); its YIN carries its reading.
            whitespaceOnly++;
          } else if (ours.prefix !== undefined && theirs.argument === undefined) {
            // pyang drops the argument of an extension whose definition it couldn't resolve.
            droppedArguments++;
          } else {
            mismatches.push(`${rel}:${theirs.location.line} ${ours.keyword} ${JSON.stringify(ours.argument)} vs ${JSON.stringify(theirs.argument)}`);
          }
        }
        if (ours.substatements.length !== theirs.substatements.length) {
          mismatches.push(`${rel}:${theirs.location.line} ${ours.keyword}: ${ours.substatements.length} vs ${theirs.substatements.length} substatements`);
          return;
        }
        ours.substatements.forEach((s, i) => compare(s, theirs.substatements[i]!));
      };
      compare(yang, yin.statement);
    }
    expect(mismatches.slice(0, 20)).toEqual([]);
    expect(statements).toBeGreaterThan(100_000);
    expect(whitespaceOnly).toBeLessThan(statements / 1000);
    expect(droppedArguments).toBe(0);
  });
});

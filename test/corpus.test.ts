/**
 * Parses every module in the public corpus fetched by scripts/fetch-corpus.sh:
 * all modules published in RFCs, the IANA modules, and OpenConfig. Each set is
 * skipped when it hasn't been fetched.
 *
 * When scripts/pyang-oracle.sh has been run, every statement's keyword and
 * argument is also compared with pyang's parse of the same file, and the
 * compiled trees of each module set with pyang's.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { builtinSource, chainSources, compileSchema, fileSource, parseModule, type Diagnostic, type SchemaNode, type Statement } from '../src/index.js';

const CACHE = join(import.meta.dirname, 'corpus', '.cache');

const SETS = [
  { name: 'IETF RFC modules', dir: join(CACHE, 'yangmodels', 'standard', 'ietf', 'RFC') },
  { name: 'IANA modules', dir: join(CACHE, 'yangmodels', 'standard', 'iana') },
  { name: 'OpenConfig', dir: join(CACHE, 'openconfig', 'release', 'models') },
  { name: 'IEEE modules', dir: join(CACHE, 'yangmodels', 'standard', 'ieee', 'published') },
];

/**
 * Errors the corpus really deserves, by file name and code. ietf-template is
 * the RFC 8407 template, with placeholder revision dates. Warnings aren't
 * checked: YANG 1.0 modules such as ietf-netconf-acm@2012-02-22 use escapes
 * like `\*` that RFC 6020 left undefined, and those are warnings by design.
 */
const EXPECTED: readonly { file: RegExp; code: string }[] = [{ file: /^ietf-template(@|\.)/, code: 'invalid-argument' }];

function yangFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...yangFiles(path));
    else if (entry.endsWith('.yang')) out.push(path);
  }
  return out;
}

describe.each(SETS)('corpus: $name', ({ dir }) => {
  it.skipIf(!existsSync(dir))('parses every module without unexpected errors', () => {
    const files = yangFiles(dir);
    expect(files.length).toBeGreaterThan(10);
    const unexpected: string[] = [];
    for (const file of files) {
      const name = relative(dir, file);
      const { diagnostics } = parseModule(readFileSync(file), { source: name });
      const base = name.split('/').pop()!;
      const isExpected = (d: Diagnostic): boolean => EXPECTED.some((e) => e.file.test(base) && e.code === d.code);
      for (const d of diagnostics.filter((d) => d.severity === 'error' && !isExpected(d))) {
        unexpected.push(`${name}:${d.location.line}:${d.location.column} ${d.code} ${d.message}`);
      }
    }
    expect(unexpected).toEqual([]);
  });
});

type PyangTree = [keyword: string, argument: string | null, children: PyangTree[]];
const ORACLE = join(CACHE, 'pyang-statements.json');

/**
 * pyang counts tabs differently from RFC 7950 §6.1.3 when trimming the
 * indentation of a double-quoted string, both in the indentation it removes
 * and in the column of the opening quote. We count every tab as 8 columns, as
 * the RFC says for indentation and as libyang does for the quote column. A
 * mismatch is put down to that only when the strings differ in line-leading
 * whitespace alone and the source has tabs on the quote's line or in the
 * string's indentation.
 */
function isPyangTabDifference(ours: string, theirs: string, text: string, offset: number): boolean {
  const strip = (s: string): string => s.replace(/\n[ \t]*/g, '\n');
  if (strip(ours) !== strip(theirs)) return false;
  const lineStart = text.lastIndexOf('\n', offset) + 1;
  return text.slice(lineStart, offset).includes('\t') || /\n[ ]*\t/.test(text.slice(offset, offset + theirs.length * 2 + 200));
}

describe('corpus: pyang oracle', () => {
  it.skipIf(!existsSync(ORACLE))('gives every statement the same keyword and argument as pyang', () => {
    const oracle = JSON.parse(readFileSync(ORACLE, 'utf8')) as Record<string, PyangTree | null>;
    const mismatches: string[] = [];
    let statements = 0;
    let tabDifferences = 0;
    for (const [file, expected] of Object.entries(oracle)) {
      if (expected === null) continue;
      const text = readFileSync(join(CACHE, file), 'utf8');
      const compare = (ours: Statement, theirs: PyangTree): void => {
        statements++;
        const [keyword, argument, children] = theirs;
        const ourArgument = ours.argument ?? null;
        if (ours.keyword !== keyword) {
          mismatches.push(`${file}:${ours.location.line} keyword ${ours.keyword} vs ${keyword}`);
        } else if (ourArgument !== argument) {
          if (ourArgument !== null && argument !== null && isPyangTabDifference(ourArgument, argument, text, ours.argumentLocation!.offset)) {
            tabDifferences++;
          } else {
            mismatches.push(`${file}:${ours.location.line} ${keyword} ${JSON.stringify(ourArgument)} vs ${JSON.stringify(argument)}`);
          }
        }
        if (ours.substatements.length !== children.length) {
          mismatches.push(`${file}:${ours.location.line} ${keyword}: ${ours.substatements.length} substatements vs ${children.length}`);
          return;
        }
        ours.substatements.forEach((s, i) => compare(s, children[i]!));
      };
      compare(parseModule(text, { source: file }).statement, expected);
    }
    expect(mismatches).toEqual([]);
    expect(statements).toBeGreaterThan(100_000);
    // A sanity bound: the tab rule explains a handful of strings, not a meaningful share of them.
    expect(tabDifferences).toBeLessThan(statements / 1000);
  });
});

/**
 * pyang's compiled trees (scripts/pyang-plugin/nn_tree.py): kind, name,
 * namespace module, config, base type, keys, mandatory, children.
 */
type PyangNode = [kind: string, name: string, module: string, config: boolean | null, type: string | null, keys: string[] | null, mandatory: boolean, dflt: string | null, children: PyangNode[]];

/**
 * The must and when statements in each set whose paths match nothing in the
 * schema (xpath/schema-paths.ts), by file and line. Each is a real mistake in
 * the module, and yanglint warns about each too:
 *
 * - ietf-snmp-community: `snmp:v1 or snmp:v2c` on an augment of `target`,
 *   which has no such children (they are cases of `target-params`).
 * - ietf-netconf-notifications (RFC 6470): `../confirm-event` in a when on
 *   `uses` in a notification. The when starts at the notification, so `..`
 *   leaves it.
 * - OpenConfig gNSI modules: `../config[...]` in augments of the gRPC server.
 *   Unprefixed, `config` is in the augmenting module, not openconfig-system-grpc.
 * - SR OS 26.10's openconfig-bgp-policy: `method=REFERENCE` without quotes
 *   compares with a node named REFERENCE. Its openconfig-mpls-rsvp:
 *   `/mpls/...` is missing `network-instances/network-instance` and prefixes.
 */
const SCHEMA_PATH_WARNINGS: Record<string, readonly string[]> = {
  'IETF RFC modules': ['ietf-netconf-notifications.yang:286', 'ietf-snmp-community@2014-12-10.yang:220'],
  OpenConfig: [
    'openconfig-gnsi-acctz.yang:266',
    'openconfig-gnsi-authz.yang:205',
    'openconfig-gnsi-certz.yang:224',
    'openconfig-gnsi-certz.yang:233',
    'openconfig-gnsi-pathz.yang:315',
  ],
  'Nokia SR OS': [
    'openconfig-bgp-policy.yang:1037',
    'openconfig-bgp-policy.yang:872',
    'openconfig-mpls-rsvp.yang:510',
    'openconfig-mpls-rsvp.yang:540',
    'openconfig-mpls-rsvp.yang:558',
    'openconfig-mpls-rsvp.yang:583',
  ],
};

/** Where the schema-path warnings are, sorted, as `file:line`. */
function schemaPathWarnings(diagnostics: readonly Diagnostic[]): string[] {
  const codes = new Set(['xpath-unknown-node', 'xpath-state-from-config', 'xpath-not-implemented', 'when-cycle']);
  return [...new Set(diagnostics.filter((d) => codes.has(d.code)).map((d) => `${basename(d.location.source ?? '')}:${d.location.line}`))].sort();
}

/**
 * References to a less current definition (RFC 7950 §7.21.2), by file and
 * line, with the code. No set has one within a module, which yanglint would
 * reject. The ones into another module, which RFC 7950 allows:
 *
 * - ietf-rib-extension: `outgoing-interface` uses ietf-interfaces' deprecated
 *   typedef `interface-state-ref`, and so its leafref also points into the
 *   deprecated `interfaces-state`.
 * - OpenConfig: `esi` and macsec's `sci-tx` and `sci-rx` use
 *   openconfig-yang-types' deprecated `hex-string`.
 *
 * SR OS 26.10 and netopeer2 have none.
 */
const STATUS_WARNINGS: Record<string, readonly string[]> = {
  'IETF RFC modules': [
    'status-reference-other-module ietf-rib-extension.yang:153',
    'status-reference-other-module ietf-rib-extension.yang:154',
  ],
  OpenConfig: [
    'status-reference-other-module openconfig-evpn-types.yang:173',
    'status-reference-other-module openconfig-macsec.yang:342',
    'status-reference-other-module openconfig-macsec.yang:394',
  ],
  'Nokia SR OS': [],
};

/** The status-reference warnings, sorted, as `code file:line`. */
function statusWarnings(diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics
    .filter((d) => d.code === 'status-reference' || d.code === 'status-reference-other-module')
    .map((d) => `${d.code} ${basename(d.location.source ?? '')}:${d.location.line}`)
    .sort();
}

const TREE_SETS = [
  { name: 'IETF RFC modules', oracle: 'pyang-tree-ietf.json', dirs: ['yangmodels/standard/ietf/RFC', 'yangmodels/standard/iana', 'yangmodels/standard/ieee/published'] },
  { name: 'OpenConfig', oracle: 'pyang-tree-openconfig.json', dirs: ['openconfig/release/models', 'yangmodels/standard/ietf/RFC', 'yangmodels/standard/iana'] },
];

function allDirs(dir: string): string[] {
  return [dir, ...readdirSync(dir).filter((e) => e !== '.git' && statSync(join(dir, e)).isDirectory()).flatMap((e) => allDirs(join(dir, e)))];
}

function asPyang(n: SchemaNode): PyangNode {
  const children = n.children.map(asPyang).filter((c) => !((c[0] === 'input' || c[0] === 'output') && c[8].length === 0));
  return [
    n.kind,
    n.name,
    n.module.name,
    n.config,
    n.kind === 'leaf' || n.kind === 'leaf-list' ? n.type.builtin : null,
    n.kind === 'list' ? n.keys.map((k) => k.name) : null,
    'mandatory' in n ? n.mandatory : false,
    null,
    children,
  ];
}

describe.each(TREE_SETS)('corpus: compiled trees match pyang, $name', ({ name, oracle, dirs }) => {
  const path = join(CACHE, oracle);
  it.skipIf(!existsSync(path))('compiles every module together, with the same nodes as pyang', async () => {
    const expected = JSON.parse(readFileSync(path, 'utf8')) as Record<string, PyangNode[]>;
    const source = chainSources(fileSource(dirs.flatMap((d) => allDirs(join(CACHE, d)))), builtinSource);
    const schema = await compileSchema({ source, modules: Object.keys(expected) });
    expect(schema.errors.filter((e) => !/ietf-template/.test(e.location.source ?? ''))).toEqual([]);
    expect(schemaPathWarnings(schema.diagnostics)).toEqual(SCHEMA_PATH_WARNINGS[name]);
    expect(statusWarnings(schema.diagnostics)).toEqual(STATUS_WARNINGS[name]);

    const differences: string[] = [];
    let nodes = 0;
    const compare = (ours: PyangNode[], theirs: PyangNode[], at: string): void => {
      const key = (p: PyangNode): string => `${p[0]} ${p[2]}:${p[1]}`;
      const mine = new Map(ours.map((p) => [key(p), p]));
      const other = new Map(theirs.map((p) => [key(p), p]));
      for (const k of other.keys()) if (!mine.has(k)) differences.push(`${at}: missing ${k}`);
      for (const [k, a] of mine) {
        const b = other.get(k);
        if (b === undefined) {
          differences.push(`${at}: extra ${k}`);
          continue;
        }
        nodes++;
        if (b[3] !== null && a[3] !== b[3]) differences.push(`${at}/${a[1]}: config ${a[3]} vs ${b[3]}`);
        if (a[4] !== b[4]) differences.push(`${at}/${a[1]}: type ${a[4]} vs ${b[4]}`);
        if (JSON.stringify(a[5]) !== JSON.stringify(b[5])) differences.push(`${at}/${a[1]}: keys ${JSON.stringify(a[5])} vs ${JSON.stringify(b[5])}`);
        if (a[6] !== b[6]) differences.push(`${at}/${a[1]}: mandatory ${a[6]} vs ${b[6]}`);
        compare(a[8], b[8], `${at}/${a[1]}`);
      }
    };
    for (const [name, tree] of Object.entries(expected)) {
      const module = schema.module(name);
      if (module === undefined) {
        differences.push(`module ${name} not compiled`);
        continue;
      }
      compare([...module.dataNodes, ...module.rpcs, ...module.notifications].map(asPyang), tree, name);
    }
    expect(differences.slice(0, 50)).toEqual([]);
    expect(nodes).toBeGreaterThan(10_000);
  }, 60_000);
});

/**
 * A vendor-scale set: one Nokia SR OS release (scripts/fetch-corpus.sh), with
 * nokia-conf and nokia-state in their combined single-file form, Nokia's
 * OpenConfig and IETF modules, and its deviation modules. Every module is
 * implemented, as a server advertising all of them would have it.
 */
const NOKIA = existsSync(join(CACHE, 'nokia')) ? readdirSync(join(CACHE, 'nokia')).find((e) => e.startsWith('latest_sros_')) : undefined;

describe('corpus: Nokia SR OS', () => {
  it.skipIf(NOKIA === undefined)('compiles every module of the release together, with no diagnostics but the known path mistakes', async () => {
    const root = join(CACHE, 'nokia', NOKIA!);
    const dirs = [root, join(root, 'ietf'), join(root, 'openconfig'), join(root, 'nokia-combined')];
    const modules = dirs.flatMap((dir) =>
      readdirSync(dir)
        .filter((f) => f.endsWith('.yang'))
        // Submodules come in through their modules' includes.
        .filter((f) => /^\s*(sub)?module\s/m.exec(readFileSync(join(dir, f), 'utf8'))?.[1] === undefined)
        .map((f) => f.replace(/(@[\d-]+)?\.yang$/, '')),
    );
    const schema = await compileSchema({ source: chainSources(fileSource(dirs), builtinSource), modules: [...new Set(modules)] });
    const known = new Set(SCHEMA_PATH_WARNINGS['Nokia SR OS']);
    const others = schema.diagnostics.filter((d) => !known.has(`${basename(d.location.source ?? '')}:${d.location.line}`) || d.severity !== 'warning');
    expect(others.slice(0, 20).map((d) => `${d.location.source ?? ''}:${d.location.line} ${d.code} ${d.message}`)).toEqual([]);
    expect(schemaPathWarnings(schema.diagnostics)).toEqual(SCHEMA_PATH_WARNINGS['Nokia SR OS']);
    expect(statusWarnings(schema.diagnostics)).toEqual(STATUS_WARNINGS['Nokia SR OS']);
    expect(schema.module('nokia-conf')?.dataNodes.map((n) => n.name)).toEqual(['configure']);
  }, 60_000);
});

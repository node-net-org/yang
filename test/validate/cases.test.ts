/**
 * Validation cases in test/fixtures/validate: each breaks one rule (or
 * none). @node-net/yang must report the expected issue code at the expected path.
 * When scripts/yanglint-oracle.sh has recorded yanglint's verdicts,
 * @node-net/yang must also accept exactly what yanglint accepts, and report an
 * error at the path yanglint names.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { builtinSource, chainSources, compileSchema, decodeJson, decodeXml, fileSource, validate, type DataIssue, type DataTree, type Schema, type SchemaNode, type TreeKind } from '../../src/index.js';

const DIR = join(import.meta.dirname, '..', 'fixtures', 'validate');
const CACHE = join(import.meta.dirname, '..', 'corpus', '.cache');
const OUT = join(CACHE, 'yanglint');
const STD = join(CACHE, 'yangmodels', 'standard');

const KINDS: Record<string, TreeKind> = { data: 'data', config: 'data', rpc: 'rpc', reply: 'reply', notif: 'notification' };

const CASES = readFileSync(join(DIR, 'cases.txt'), 'utf8')
  .split('\n')
  .filter((l) => l.trim() !== '' && !l.startsWith('#'))
  .map((l) => {
    const [name, type, input, operational, code, path] = l.trim().split(/\s+/) as [string, string, string, string, string, string];
    return { name, type, input, operational: operational === '-' ? undefined : operational, code, path };
  });

/**
 * The modules a case needs: vx, or those its data/<case>.modules file lists
 * by file name (yanglint's paths: /std/ for the corpus, /vf/ for this directory).
 */
function modulesOf(name: string): { modules: string[]; corpus: boolean } {
  const file = join(DIR, 'data', `${name}.modules`);
  if (!existsSync(file)) return { modules: ['vx'], corpus: false };
  const files = readFileSync(file, 'utf8').trim().split(/\s+/);
  const modules = files.map((f) => f.split('/').pop()!.replace(/(@[0-9-]+)?\.yang$/, ''));
  return { modules, corpus: files.some((f) => f.startsWith('/std/')) };
}

const schemas = new Map<string, Promise<Schema>>();
function schemaFor(modules: string[]): Promise<Schema> {
  const key = modules.join(' ');
  let s = schemas.get(key);
  if (s === undefined) {
    s = compileSchema({ source: chainSources(fileSource([DIR, join(STD, 'ietf', 'RFC'), join(STD, 'iana')]), builtinSource), modules });
    schemas.set(key, s);
  }
  return s;
}

async function run(c: (typeof CASES)[number]): Promise<DataIssue[]> {
  const { modules } = modulesOf(c.name);
  let schema = await schemaFor(modules);
  expect(schema.errors).toEqual([]);
  if (c.type === 'config') schema = schema.forDatastore('running');
  const read = (file: string, type: TreeKind, s: Schema): DataTree => {
    const text = readFileSync(join(DIR, 'data', file), 'utf8');
    return file.endsWith('.xml') ? decodeXml(s, text, { type }) : decodeJson(s, JSON.parse(text), { type });
  };
  const tree = read(c.input, KINDS[c.type]!, schema);
  const operational = c.operational === undefined ? undefined : read(c.operational, 'data', await schemaFor(modules));
  return validate(tree, operational === undefined ? {} : { operational });
}

/**
 * A libyang "Schema location" as a data path: choice and case steps
 * dropped. For a missing choice it is the choice's parent.
 */
function dataPathOf(schema: Schema, location: string): string {
  const steps = location.replace(/^\//, '').split('/');
  let candidates: readonly SchemaNode[] = [...schema.dataNodes, ...schema.rpcs, ...schema.notifications];
  let module = '';
  const out: string[] = [];
  for (const step of steps) {
    const [m, n] = step.includes(':') ? (step.split(':') as [string, string]) : [module, step];
    const node = candidates.find((c) => c.name === n && c.module.name === m);
    if (node === undefined) return location;
    if (node.kind !== 'choice' && node.kind !== 'case') out.push(m === module ? n : `${m}:${n}`);
    module = m;
    candidates = node.children;
  }
  return `/${out.join('/')}`;
}

describe.each(CASES)('validation: $name', (c) => {
  const corpus = modulesOf(c.name).corpus;
  it.skipIf(corpus && !existsSync(STD))(c.code === 'ok' ? 'is valid' : `reports ${c.code} at ${c.path}`, async () => {
    const issues = await run(c);
    const errors = issues.filter((i) => i.severity === 'error');
    if (c.code === 'ok') expect(errors).toEqual([]);
    else expect(errors.map((i) => [i.code, i.path])).toContainEqual([c.code, c.path]);
  });

  const verdict = ['ok', 'rejected'].find((v) => existsSync(join(OUT, `validate-${c.name}.${v}`)));
  it.skipIf(verdict === undefined)('agrees with yanglint', async () => {
    const errors = (await run(c)).filter((i) => i.severity === 'error');
    expect(errors.length === 0 ? 'ok' : 'rejected').toBe(verdict);
    if (verdict !== 'rejected') return;
    const message = readFileSync(join(OUT, `validate-${c.name}.rejected`), 'utf8');
    const m = /\((Data|Schema) location "([^"]+)"/.exec(message);
    expect(m, message).not.toBeNull();
    const [, kind, where] = m!;
    const schema = await schemaFor(modulesOf(c.name).modules);
    const theirs = kind === 'Schema' ? dataPathOf(schema, where!) : where!;
    // A schema location has no list keys.
    // libyang may name either entry of a pair that breaks unique: the leaves of both are in nonUnique.
    const paths = errors.flatMap((i) => [i.path, ...(i.nonUnique ?? []).map((p) => p.slice(0, p.lastIndexOf(']') + 1))]);
    const ours = paths.map((p) => (kind === 'Schema' ? p.replace(/\[[^\]]*\]/g, '') : p));
    // libyang names the first entry beyond max-elements; we name the list.
    expect(ours.some((p) => p === theirs || theirs.startsWith(`${p}[`)), `yanglint: ${message}`).toBe(true);
  });
});

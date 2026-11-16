/**
 * Compares the XML and JSON codecs with yanglint (libyang), on the sample
 * data in test/fixtures/oracle. scripts/yanglint-oracle.sh writes yanglint's
 * conversions to test/corpus/.cache/yanglint; each case is skipped when its
 * output is absent.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  builtinSource,
  chainSources,
  compileSchema,
  decodeJson,
  decodeXml,
  encodeJson,
  fileSource,
  toXml,
  YangDataError,
  type DataIssue,
  type Schema,
  type TreeKind,
} from '../src/index.js';
import { FIXTURES } from './data/support.js';

const CACHE = join(import.meta.dirname, 'corpus', '.cache');
const OUT = join(CACHE, 'yanglint');
const STD = join(CACHE, 'yangmodels', 'standard');

const KINDS: Record<string, TreeKind> = { get: 'data', edit: 'data', rpc: 'rpc', reply: 'reply', notif: 'notification' };

const CASES = readFileSync(join(FIXTURES, 'cases.txt'), 'utf8')
  .split('\n')
  .filter((l) => l.trim() !== '' && !l.startsWith('#'))
  .map((l) => {
    const [name, type, input, ...modules] = l.trim().split(/\s+/);
    return { name: name!, kind: KINDS[type!]!, edit: type === 'edit', input: input!, modules };
  });

const schemas = new Map<string, Promise<Schema>>();
function schemaFor(modules: string[]): Promise<Schema> {
  const key = modules.join(' ');
  let s = schemas.get(key);
  if (s === undefined) {
    s = compileSchema({ source: chainSources(fileSource([FIXTURES, join(STD, 'ietf', 'RFC'), join(STD, 'iana')]), builtinSource), modules });
    schemas.set(key, s);
  }
  return s;
}

/**
 * Top-level elements as separate blocks, sorted: libyang orders top-level
 * nodes by module. Declarations of module names used as prefixes in
 * yang:key and yang:value are dropped (libyang declares prefixes by YANG
 * prefix, so it never writes these): @node-net/yang declares them so the XML is
 * namespace-well-formed, libyang writes the value alone.
 */
function blocks(xml: string): string[] {
  return xml
    .replaceAll(' xmlns:ex-ids="urn:ex-ids"', '')
    .trim()
    .split(/\n(?=<[^/])/)
    .sort();
}

const read = (file: string): string => readFileSync(file, 'utf8');

describe.each(CASES)('yanglint oracle: $name', ({ name, kind, edit, input, modules }) => {
  const opts = { type: kind, edit };
  const theirs = join(OUT, `${name}.xml`);
  const xmlInput = input.endsWith('.xml');

  it.skipIf(!existsSync(theirs) || !xmlInput)('re-prints XML as yanglint does', async () => {
    const schema = await schemaFor(modules);
    expect(schema.errors).toEqual([]);
    const tree = decodeXml(schema, read(join(FIXTURES, 'data', input)), opts);
    expect(blocks(toXml(tree, { indent: 2 }))).toEqual(blocks(read(theirs)));
  });

  it.skipIf(!existsSync(theirs))('converts the input to the same JSON as yanglint', async () => {
    const schema = await schemaFor(modules);
    const text = read(join(FIXTURES, 'data', input));
    const tree = xmlInput ? decodeXml(schema, text, opts) : decodeJson(schema, text, opts);
    expect(encodeJson(tree)).toEqual(JSON.parse(read(join(OUT, `${name}.json`))));
  });

  it.skipIf(!existsSync(theirs))("converts yanglint's JSON to the same XML as yanglint", async () => {
    const schema = await schemaFor(modules);
    const tree = decodeJson(schema, read(join(OUT, `${name}.json`)), opts);
    expect(blocks(toXml(tree, { indent: 2 }))).toEqual(blocks(read(join(OUT, `${name}.from-json.xml`))));
  });

  it.skipIf(!existsSync(theirs) || xmlInput)('reads JSON input to the same XML as yanglint', async () => {
    const schema = await schemaFor(modules);
    const tree = decodeJson(schema, read(join(FIXTURES, 'data', input)), opts);
    expect(blocks(toXml(tree, { indent: 2 }))).toEqual(blocks(read(theirs)));
  });
});

const INVALID = read(join(FIXTURES, 'invalid.txt'))
  .split('\n')
  .filter((l) => l.trim() !== '' && !l.startsWith('#'))
  .map((l) => {
    const [input, code, path] = l.trim().split(/\s+/);
    return { input: input!, code: code!, path: path! };
  });

/** yanglint parses without validating with -t get, so these it accepts; RFC 7950 forbids them. */
const ACCEPTED_BY_YANGLINT = new Set(['duplicate.xml']);

describe.each(INVALID)('yanglint oracle: invalid $input', ({ input, code, path }) => {
  const rejected = join(OUT, `invalid-${input}.rejected`);
  const accepted = join(OUT, `invalid-${input}.accepted`);

  it.skipIf(!existsSync(rejected) && !existsSync(accepted))(`is rejected, as by yanglint, with ${code}`, async () => {
    expect(existsSync(rejected)).toBe(!ACCEPTED_BY_YANGLINT.has(input));
    const schema = await schemaFor(['ietf-interfaces', 'ietf-ip', 'iana-if-type']);
    const text = read(join(FIXTURES, 'invalid', input));
    let issues: readonly DataIssue[] = [];
    try {
      if (input.endsWith('.xml')) decodeXml(schema, text);
      else decodeJson(schema, text);
    } catch (err) {
      if (!(err instanceof YangDataError)) throw err;
      issues = err.issues;
    }
    expect(issues).toContainEqual(expect.objectContaining({ code, path }));
  });
});

describe('schema queries on IETF modules', () => {
  it.skipIf(!existsSync(join(STD, 'ietf', 'RFC')))('completes and describes ietf-interfaces with ietf-ip', async () => {
    const schema = await schemaFor(['ietf-interfaces', 'ietf-ip', 'iana-if-type']);
    expect(schema.complete('/ietf-interfaces:interfaces/interface[name="eth0"]/ietf-ip:ipv4/addr').map((c) => c.text)).toEqual([
      '/ietf-interfaces:interfaces/interface[name="eth0"]/ietf-ip:ipv4/address',
    ]);
    expect(schema.complete('/if:interfaces/interface/ip').map((c) => [c.text, c.extends])).toEqual([
      ['/if:interfaces/interface/ietf-ip:ipv4', false],
      ['/if:interfaces/interface/ietf-ip:ipv6', false],
    ]);
    expect(schema.describe('/if:interfaces/interface/ip:ipv4/mtu')).toMatchObject({ type: { text: 'uint16 (68..65535)' }, units: 'octets' });
    const type = schema.describe('/ietf-interfaces:interfaces/interface/type')!.type!;
    expect(type.identities!.map((i) => i.name)).toContain('iana-if-type:ethernetCsmacd');
    expect(schema.children('/ietf-interfaces:interfaces/interface', { config: true })!.map((n) => n.name)).toEqual([
      'name', 'description', 'type', 'enabled', 'link-up-down-trap-enable', 'ipv4', 'ipv6',
    ]);
  });
});

/**
 * With-defaults (RFC 6243) on instance trees. scripts/yanglint-oracle.sh
 * writes yanglint's output for each case in test/fixtures/oracle/defaults.txt
 * to test/corpus/.cache/yanglint; the comparisons skip when it is absent.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addDefaults,
  applyWithDefaults,
  builtinSource,
  compileSchema,
  decodeJson,
  decodeXml,
  fileSource,
  chainSources,
  isDefaultValue,
  toJson,
  toXml,
  WITH_DEFAULTS_NAMESPACE,
  type ContainerInstance,
  type LeafInstance,
  type Schema,
  type WithDefaultsMode,
} from '../../src/index.js';
import { compile, mod } from '../compile/support.js';
import { FIXTURES } from './support.js';

const OUT = join(import.meta.dirname, '..', 'corpus', '.cache', 'yanglint');
const MODES: Record<string, WithDefaultsMode> = { explicit: 'explicit', all: 'report-all', 'all-tagged': 'report-all-tagged', trim: 'trim' };
const CASES = readFileSync(join(FIXTURES, 'defaults.txt'), 'utf8')
  .split('\n')
  .filter((l) => l.trim() !== '' && !l.startsWith('#'))
  .map((l) => {
    const [name, mode, input] = l.trim().split(/\s+/);
    return { name: name!, mode: MODES[mode!]!, input: input! };
  });

let wdSchema: Promise<Schema> | undefined;
const schema = (): Promise<Schema> =>
  (wdSchema ??= compileSchema({ source: chainSources(fileSource([FIXTURES]), builtinSource), modules: ['ex-wd', 'ietf-netconf-with-defaults'] }));
const read = (file: string): string => readFileSync(file, 'utf8');

/** Attributes in a start tag sorted: their order has no meaning, and libyang interleaves declarations differently. */
const sortAttributes = (xml: string): string =>
  xml.replace(/<([\w.-]+)((?:\s+[\w.:-]+="[^"]*")+)(\s*\/?)>/g, (_m, name: string, attrs: string, end: string) => `<${name} ${attrs.trim().split(/\s+(?=[\w.:-]+=")/).sort().join(' ')}${end}>`);

describe.each(CASES)('with-defaults matches yanglint: $name', ({ name, mode, input }) => {
  const theirs = join(OUT, `${name}.xml`);
  it.skipIf(!existsSync(theirs))(`gives yanglint's ${mode} output`, async () => {
    const s = await schema();
    expect(s.errors).toEqual([]);
    const tree = applyWithDefaults(decodeXml(s, read(join(FIXTURES, 'data', input))), mode);
    // libyang 2.1 writes the attribute in the module's namespace, not RFC 6243's.
    const expected = read(theirs).replaceAll('urn:ietf:params:xml:ns:yang:ietf-netconf-with-defaults', WITH_DEFAULTS_NAMESPACE).trim();
    // Top-level nodes keep the order they were added in; libyang sorts them by schema.
    const blocks = (xml: string): string[] => sortAttributes(xml).split(/\n(?=<[^/])/).sort();
    expect(blocks(toXml(tree, { indent: 2 }).trim())).toEqual(blocks(expected));
  });
});

describe('with-defaults', () => {
  it('reads the default annotation in either namespace, and in JSON, setting isDefault', async () => {
    const s = await schema();
    const tree = decodeXml(
      s,
      `<top xmlns="urn:ex-wd" xmlns:wd="${WITH_DEFAULTS_NAMESPACE}" xmlns:ly="urn:ietf:params:xml:ns:yang:ietf-netconf-with-defaults"><a wd:default="true">x</a><b ly:default="true">7</b><c wd:default="false">z</c></top>`,
    );
    const [a, b, c] = (tree.children[0] as ContainerInstance).children as LeafInstance[];
    expect([a!.isDefault, b!.isDefault, c!.isDefault]).toEqual([true, true, false]);
    expect(b!.annotations).toMatchObject([{ namespace: WITH_DEFAULTS_NAMESPACE, module: 'ietf-netconf-with-defaults', name: 'default', value: { value: true } }]);
    // JSON as RFC 8040 §4.8.9 writes it.
    expect(toJson(tree)).toBe(
      '{"ex-wd:top":{"a":"x","@a":{"ietf-netconf-with-defaults:default":true},"b":7,"@b":{"ietf-netconf-with-defaults:default":true},"c":"z","@c":{"ietf-netconf-with-defaults:default":false}}}',
    );
    const back = decodeJson(s, toJson(tree));
    expect(((back.children[0] as ContainerInstance).children as LeafInstance[]).map((l) => l.isDefault)).toEqual([true, true, false]);
    expect(() => decodeXml(s, `<top xmlns="urn:ex-wd" xmlns:wd="${WITH_DEFAULTS_NAMESPACE}"><a wd:default="yes">x</a></top>`)).toThrow(/not true or false/);
  });

  it('works without the ietf-netconf-with-defaults module, using RFC 6243 namespace in XML', async () => {
    const s = await compile([mod('m', 'leaf a { type string; default "x"; }')]);
    const tree = applyWithDefaults(decodeXml(s, ''), 'report-all-tagged');
    expect(toXml(tree)).toBe(`<a xmlns="urn:m" xmlns:wd="${WITH_DEFAULTS_NAMESPACE}" wd:default="true">x</a>`);
    expect(toJson(tree)).toBe('{"m:a":"x","@m:a":{"ietf-netconf-with-defaults:default":true}}');
    expect(toXml(decodeXml(s, toXml(tree)))).toBe(toXml(tree));
  });

  it('round-trips through explicit: added defaults go, written ones stay', async () => {
    const s = await schema();
    const tree = decodeXml(s, '<top xmlns="urn:ex-wd"><a>x</a></top>');
    addDefaults(tree);
    const b = (tree.children[0] as ContainerInstance).children.find((c) => c.schema.name === 'b') as LeafInstance;
    expect(b.isDefault).toBe(true);
    expect(isDefaultValue((tree.children[0] as ContainerInstance).children[0] as LeafInstance)).toBe(true);
    applyWithDefaults(tree, 'explicit');
    expect(toXml(tree)).toBe('<top xmlns="urn:ex-wd"><a>x</a><s>5</s></top>');
  });

  it("leave state data out of a configuration datastore's tree", async () => {
    const running = (await schema()).forDatastore('running');
    const tree = applyWithDefaults(decodeXml(running, '<top xmlns="urn:ex-wd"><c>on</c></top>'), 'report-all');
    expect((tree.children[0] as ContainerInstance).children.map((c) => c.schema.name)).not.toContain('s');
  });

  it('add the defaults of an RPC input', async () => {
    const s = await compile([mod('m', 'rpc go { input { leaf speed { type uint8; default 3; } leaf name { type string; } } }')]);
    const tree = addDefaults(decodeXml(s, '<go xmlns="urn:m"><name>n</name></go>', { type: 'rpc' }));
    expect(toXml(tree)).toBe('<go xmlns="urn:m"><speed>3</speed><name>n</name></go>');
  });

  it('add a default guarded by when only when its condition holds, from the right context node', async () => {
    const s = await compile([
      mod('m', `container c {
  leaf on { type boolean; }
  leaf w { when "../on = 'true'"; type string; default "w"; }
  container wc { when "../on = 'true'"; leaf x { type string; default "x"; } }
  uses g { when "on = 'true'"; }
  uses g2 { when "../on = 'true'"; }
}
grouping g { leaf y { type string; default "y"; } }
grouping g2 { leaf z { type string; default "z"; } }`),
    ]);
    // A uses' when is evaluated from the parent, c: there 'on' exists and '../on' doesn't.
    const on = applyWithDefaults(decodeXml(s, '<c xmlns="urn:m"><on>true</on></c>'), 'report-all');
    expect(toXml(on)).toBe('<c xmlns="urn:m"><on>true</on><w>w</w><wc><x>x</x></wc><y>y</y></c>');
    const off = applyWithDefaults(decodeXml(s, '<c xmlns="urn:m"><on>false</on></c>'), 'report-all');
    expect(toXml(off)).toBe('<c xmlns="urn:m"><on>false</on></c>');
  });

  it('resolve when conditions that depend on other defaults', async () => {
    const s = await compile([
      mod('m', `container c {
  leaf b { when "../a = 'x'"; type string; default "y"; }
  leaf a { type string; default "x"; }
  leaf d { when "../b = 'y'"; type string; default "z"; }
  leaf e { when "../f"; type string; default "e"; }
  leaf f { when "../e"; type string; default "f"; }
}`),
    ]);
    // b waits for nothing (a has no when); d waits for b. e and f depend on each other: evaluated in order, both hold.
    expect(toXml(addDefaults(decodeXml(s, '<c xmlns="urn:m"/>')))).toBe('<c xmlns="urn:m"><b>y</b><a>x</a><d>z</d><e>e</e><f>f</f></c>');
    expect(toXml(addDefaults(decodeXml(s, '<c xmlns="urn:m"><a>q</a></c>')))).toBe('<c xmlns="urn:m"><a>q</a><e>e</e><f>f</f></c>');
  });

  it('use the typed default, so identityrefs and decimals compare by value', async () => {
    const s = await schema();
    const tree = decodeXml(s, '<top xmlns="urn:ex-wd" xmlns:x="urn:ex-wd"><id>x:one</id><np><deeper><e>1.50</e></deeper></np></top>');
    applyWithDefaults(tree, 'trim');
    expect(toXml(tree)).toBe('');
  });
});

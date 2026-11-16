import { describe, expect, it } from 'vitest';
import { decodeJson, decodeXml, toJson, YangDataError, type DataIssue, type Identity, type TypedValue } from '../../src/index.js';
import { compile, mod } from '../compile/support.js';

const m = mod(
  'm',
  `container sys {
    leaf hostname { type string; }
    leaf uptime { config false; type uint32; }
    list user { key name; leaf name { type string; } leaf last-login { config false; type string; } }
  }
  rpc ping { output { leaf ok { type boolean; } } }
  identity my-dynamic { base ds:dynamic; }`,
  '  import ietf-datastores { prefix ds; }',
);

async function schema(): ReturnType<typeof compile> {
  return compile([m], { implement: ['m', 'ietf-origin'] });
}

function issues(fn: () => unknown): DataIssue[] {
  try {
    fn();
  } catch (err) {
    if (err instanceof YangDataError) return [...err.issues];
    throw err;
  }
  throw new Error('expected a YangDataError');
}

const XML = `<sys xmlns="urn:m"><hostname>r1</hostname><uptime>5</uptime><user><name>a</name><last-login>x</last-login></user></sys>`;
const JSON_DATA = { 'm:sys': { hostname: 'r1', uptime: 5, user: [{ name: 'a', 'last-login': 'x' }] } };

describe('per-datastore schemas (RFC 8342)', () => {
  it('reject state data in a configuration datastore, in both codecs', async () => {
    const running = (await schema()).forDatastore('running');
    const expected = [
      { code: 'state-data', path: '/m:sys/uptime' },
      { code: 'state-data', path: "/m:sys/user[name='a']/last-login" },
    ];
    expect(issues(() => decodeXml(running, XML))).toMatchObject(expected);
    expect(issues(() => decodeJson(running, JSON_DATA))).toMatchObject(expected);
    expect(toJson(decodeXml(running, '<sys xmlns="urn:m"><hostname>r1</hostname></sys>'))).toBe('{"m:sys":{"hostname":"r1"}}');
  });

  it('accept state data in operational, and in a schema tied to no datastore', async () => {
    const s = await schema();
    expect(s).toMatchObject({ datastore: undefined, holdsState: true });
    expect(decodeXml(s.forDatastore('operational'), XML).children).toHaveLength(1);
    expect(decodeJson(s, JSON_DATA).children).toHaveLength(1);
  });

  it('treat any other datastore as configuration, unless its identity derives from dynamic or the caller says', async () => {
    const s = await schema();
    expect(s.forDatastore('ietf-datastores:intended').holdsState).toBe(false);
    expect(s.forDatastore('ietf-system-datastore:system').holdsState).toBe(false);
    expect(s.forDatastore('m:my-dynamic').holdsState).toBe(true);
    expect(s.forDatastore('vendor:scratch', { state: true }).holdsState).toBe(true);
  });

  it('read the origin annotation in operational only', async () => {
    const s = await schema();
    const xml = `<sys xmlns="urn:m" xmlns:or="urn:ietf:params:xml:ns:yang:ietf-origin" or:origin="or:intended"><uptime or:origin="or:system">5</uptime></sys>`;
    const tree = decodeXml(s.forDatastore('operational'), xml);
    const origin = tree.children[0]!.annotation('ietf-origin', 'origin')!;
    expect(((origin.value as TypedValue).value as Identity).name).toBe('intended');
    expect(toJson(tree)).toBe('{"m:sys":{"@":{"ietf-origin:origin":"ietf-origin:intended"},"uptime":5,"@uptime":{"ietf-origin:origin":"ietf-origin:system"}}}');
    const running = s.forDatastore('running');
    expect(issues(() => decodeXml(running, '<sys xmlns="urn:m" xmlns:or="urn:ietf:params:xml:ns:yang:ietf-origin" or:origin="or:intended"/>'))).toMatchObject([
      { code: 'unexpected-annotation', path: '/m:sys' },
    ]);
    expect(issues(() => decodeJson(running, { 'm:sys': { '@': { 'ietf-origin:origin': 'ietf-origin:intended' } } }))).toMatchObject([{ code: 'unexpected-annotation' }]);
  });

  it("don't apply to operations", async () => {
    const running = (await schema()).forDatastore('running');
    expect(decodeXml(running, '<ping xmlns="urn:m"><ok>true</ok></ping>', { type: 'reply' }).operation!.children).toHaveLength(1);
  });
});

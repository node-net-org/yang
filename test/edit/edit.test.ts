import { beforeAll, describe, expect, it } from 'vitest';
import { addDefaults, applyEdit, encodeJson, toXml, type ContainerInstance, type Schema } from '../../src/index.js';
import { apply, data, edit, failure, edSchema } from './support.js';

let schema: Schema;
beforeAll(async () => {
  schema = await edSchema();
});

const NC = 'xmlns:nc="urn:ietf:params:xml:ns:netconf:base:1.0"';
const YANG = 'xmlns:yang="urn:ietf:params:xml:ns:yang:1"';

const start = {
  'ed:sys': {
    host: 'h',
    mtu: 1500,
    user: [{ name: 'a', uid: 1 }, { name: 'b' }, { name: 'c' }],
    iface: [{ name: 'eth', unit: 0, mtu: 1500 }],
    dns: ['1.1.1.1', '8.8.8.8'],
    tag: ['x'],
    'tcp-port': 22,
  },
};

describe('applyEdit: operations (RFC 6241 §7.2)', () => {
  it('merges by default: sets leaves, adds entries, keeps the rest', () => {
    expect(apply(schema, start, { 'ed:sys': { host: 'n', user: [{ name: 'a', shell: 'sh' }, { name: 'd' }], tag: ['y'] } })).toEqual({
      'ed:sys': {
        host: 'n',
        mtu: 1500,
        user: [{ name: 'a', uid: 1, shell: 'sh' }, { name: 'b' }, { name: 'c' }, { name: 'd' }],
        iface: [{ name: 'eth', unit: 0, mtu: 1500 }],
        dns: ['1.1.1.1', '8.8.8.8'],
        tag: ['x', 'y'],
        'tcp-port': 22,
      },
    });
  });

  it('leaves the target unchanged', () => {
    const target = data(schema, start);
    applyEdit(target, edit(schema, { 'ed:sys': { host: 'n' } }));
    expect(encodeJson(target)).toEqual(start);
  });

  it('matches list entries by every key', () => {
    const out = apply(schema, start, { 'ed:sys': { iface: [{ name: 'eth', unit: 1, mtu: 9000 }, { name: 'eth', unit: 0, mtu: 1400 }] } });
    expect(out).toMatchObject({ 'ed:sys': { iface: [{ name: 'eth', unit: 0, mtu: 1400 }, { name: 'eth', unit: 1, mtu: 9000 }] } });
  });

  it('replaces a node: what the edit leaves out goes', () => {
    const out = apply(schema, start, { 'ed:sys': { user: [{ name: 'a', shell: 'sh', '@': { 'ietf-netconf:operation': 'replace' } }] } });
    expect(out).toMatchObject({ 'ed:sys': { user: [{ name: 'a', shell: 'sh' }, { name: 'b' }, { name: 'c' }] } });
  });

  it('replaces a container, keeping state data', () => {
    const target = data(schema, { 'ed:sys': { host: 'h', state: { up: true } } });
    const result = applyEdit(target, edit(schema, { 'ed:sys': { mtu: 100, '@': { 'ietf-netconf:operation': 'replace' } } }));
    expect(encodeJson(result)).toEqual({ 'ed:sys': { mtu: 100, state: { up: true } } });
  });

  it('creates, and refuses to create what exists', () => {
    expect(apply(schema, start, { 'ed:sys': { pres: { need: 'n', '@': { 'ietf-netconf:operation': 'create' } } } })).toMatchObject({ 'ed:sys': { pres: { need: 'n' } } });
    expect(failure(schema, start, { 'ed:sys': { host: 'z', '@host': { 'ietf-netconf:operation': 'create' } } })).toEqual(['data-exists /ed:sys/host']);
    expect(failure(schema, start, `<sys xmlns="urn:ed" ${NC}><user nc:operation="create"><name>b</name></user></sys>`)).toEqual(["data-exists /ed:sys/user[name='b']"]);
  });

  it('deletes, and refuses to delete what is missing', () => {
    const out = apply(schema, start, `<sys xmlns="urn:ed" ${NC}><host nc:operation="delete"/><user nc:operation="delete"><name>b</name></user><dns nc:operation="delete">8.8.8.8</dns></sys>`);
    expect(out).toMatchObject({ 'ed:sys': { user: [{ name: 'a' }, { name: 'c' }], dns: ['1.1.1.1'] } });
    expect(out).not.toHaveProperty(['ed:sys', 'host']);
    expect(failure(schema, start, `<sys xmlns="urn:ed" ${NC}><user nc:operation="delete"><name>z</name></user></sys>`)).toEqual([
      "data-missing /ed:sys/user[name='z']",
    ]);
    expect(failure(schema, start, { 'ed:other': { '@': { 'ietf-netconf:operation': 'delete' } } })).toEqual(['data-missing /ed:other']);
  });

  it('removes silently when missing', () => {
    expect(apply(schema, start, { 'ed:other': { '@': { 'ietf-netconf:operation': 'remove' } }, 'ed:sys': { '@mtu': { 'ietf-netconf:operation': 'remove' }, mtu: null } })).toEqual({
      'ed:sys': { ...start['ed:sys'], mtu: undefined },
    });
  });

  it('removes a non-presence container that the edit empties', () => {
    const target = { 'ed:sys': { deep: { inner: { x: 'a' } } } };
    expect(apply(schema, target, { 'ed:sys': { deep: { inner: { '@x': { 'ietf-netconf:operation': 'delete' }, x: null } } } })).toEqual({});
  });

  it('inherits the operation of an ancestor', () => {
    expect(failure(schema, start, { 'ed:sys': { '@': { 'ietf-netconf:operation': 'create' }, host: 'z' } })).toEqual(['data-exists /ed:sys']);
    const out = apply(schema, start, `<sys xmlns="urn:ed" ${NC} nc:operation="replace"><host>z</host><user><name>c</name></user><user><name>a</name></user></sys>`);
    expect(out).toEqual({ 'ed:sys': { host: 'z', user: [{ name: 'c' }, { name: 'a' }] } });
  });

  it('refuses state data and invalid operations', () => {
    expect(failure(schema, {}, { 'ed:sys': { state: { up: true } } })).toEqual(['invalid-edit /ed:sys/state']);
  });
});

describe('applyEdit: default operation', () => {
  it('none: creates nothing on its own', () => {
    expect(apply(schema, {}, { 'ed:sys': { host: 'z' } }, { defaultOperation: 'none' })).toEqual({});
    expect(apply(schema, start, { 'ed:sys': { host: 'z', mtu: 9000, '@mtu': { 'ietf-netconf:operation': 'merge' } } }, { defaultOperation: 'none' })).toEqual({
      'ed:sys': { ...start['ed:sys'], mtu: 9000 },
    });
  });

  it('none: creates the containers and entries leading to an operation', () => {
    const out = apply(schema, {}, { 'ed:sys': { user: [{ name: 'q', uid: 5, '@uid': { 'ietf-netconf:operation': 'create' } }, { name: 'r' }] } }, { defaultOperation: 'none' });
    expect(out).toEqual({ 'ed:sys': { user: [{ name: 'q', uid: 5 }] } });
  });

  it('none: deletes need the node', () => {
    expect(failure(schema, start, { 'ed:other': { '@z': { 'ietf-netconf:operation': 'delete' }, z: null } }, { defaultOperation: 'none' })).toEqual(['data-missing /ed:other/z']);
  });

  it('replace: replaces the whole configuration', () => {
    expect(apply(schema, start, { 'ed:other': { z: '1' } }, { defaultOperation: 'replace' })).toEqual({ 'ed:other': { z: '1' } });
  });
});

describe('applyEdit: ordered-by-user entries (RFC 7950 §7.7.9, §7.8.6)', () => {
  const users = (out: object): string[] => ((out as { 'ed:sys': { user: { name: string }[] } })['ed:sys'].user ?? []).map((u) => u.name);
  const at = (insert: string, key?: string): object => ({ 'yang:insert': insert, ...(key === undefined ? {} : { 'yang:key': key }) });

  it('puts new entries last, or where yang:insert says', () => {
    expect(users(apply(schema, start, { 'ed:sys': { user: [{ name: 'd' }] } }))).toEqual(['a', 'b', 'c', 'd']);
    expect(users(apply(schema, start, { 'ed:sys': { user: [{ name: 'd', '@': at('first') }] } }))).toEqual(['d', 'a', 'b', 'c']);
    expect(users(apply(schema, start, { 'ed:sys': { user: [{ name: 'd', '@': at('before', "[ed:name='b']") }] } }))).toEqual(['a', 'd', 'b', 'c']);
    expect(users(apply(schema, start, { 'ed:sys': { user: [{ name: 'd', '@': at('after', "[name='a']") }] } }))).toEqual(['a', 'd', 'b', 'c']);
  });

  it('moves existing entries only when yang:insert says', () => {
    expect(users(apply(schema, start, { 'ed:sys': { user: [{ name: 'c' }, { name: 'a', uid: 7 }] } }))).toEqual(['a', 'b', 'c']);
    expect(users(apply(schema, start, { 'ed:sys': { user: [{ name: 'c', '@': at('first') }] } }))).toEqual(['c', 'a', 'b']);
    expect(users(apply(schema, start, { 'ed:sys': { user: [{ name: 'a', '@': at('last') }] } }))).toEqual(['b', 'c', 'a']);
    expect(users(apply(schema, start, { 'ed:sys': { user: [{ name: 'a', '@': { 'ietf-netconf:operation': 'replace', ...at('after', "[ed:name='c']") } }] } }))).toEqual(['b', 'c', 'a']);
  });

  it('reads yang:key prefixes from XML', () => {
    const xml = `<sys xmlns="urn:ed" xmlns:x="urn:ed" ${YANG}><user yang:insert="before" yang:key="[x:name='a']"><name>d</name></user></sys>`;
    expect(users(apply(schema, start, xml))).toEqual(['d', 'a', 'b', 'c']);
  });

  it('positions leaf-list entries with yang:value, identityrefs included', () => {
    const out = apply(schema, start, { 'ed:sys': { dns: ['9.9.9.9'], '@dns': [{ 'yang:insert': 'after', 'yang:value': '1.1.1.1' }] } });
    expect(out).toMatchObject({ 'ed:sys': { dns: ['1.1.1.1', '9.9.9.9', '8.8.8.8'] } });
    const target = { 'ed:sys': { kinds: ['ed:widget'] } };
    const xml = `<sys xmlns="urn:ed" xmlns:e="urn:ed" ${YANG}><kinds yang:insert="before" yang:value="e:widget">e:gadget</kinds></sys>`;
    expect(apply(schema, target, xml)).toEqual({ 'ed:sys': { kinds: ['ed:gadget', 'ed:widget'] } });
  });

  it('fails when the anchor is missing (RFC 7950 §15.7)', () => {
    expect(failure(schema, start, { 'ed:sys': { user: [{ name: 'd', '@': at('after', "[name='zz']") }] } })).toEqual(["missing-anchor /ed:sys/user[name='d']"]);
    expect(failure(schema, start, { 'ed:sys': { user: [{ name: 'a', '@': at('after', "[name='a']") }] } })).toEqual(["invalid-edit /ed:sys/user[name='a']"]);
  });

  it('keeps an edit in its order when the parent is replaced', () => {
    const out = apply(schema, start, { 'ed:sys': { '@': { 'ietf-netconf:operation': 'replace' }, user: [{ name: 'c' }, { name: 'z' }, { name: 'a' }] } });
    expect(users(out)).toEqual(['c', 'z', 'a']);
  });
});

describe('applyEdit: choices (RFC 7950 §7.9)', () => {
  it('creating a node in one case deletes the other cases', () => {
    expect(apply(schema, start, { 'ed:sys': { 'udp-port': 53 } })).not.toHaveProperty(['ed:sys', 'tcp-port']);
    expect(apply(schema, start, { 'ed:sys': { local: [null] } })).toMatchObject({ 'ed:sys': { local: [null] } });
    expect(apply(schema, start, { 'ed:sys': { keepalive: true } })).toMatchObject({ 'ed:sys': { 'tcp-port': 22, keepalive: true } });
  });

  it('refuses an edit with two cases', () => {
    expect(failure(schema, start, { 'ed:sys': { 'udp-port': 53, keepalive: true } })).toEqual(['multiple-cases /ed:sys/udp-port']);
  });
});

describe('applyEdit: defaults', () => {
  it('counts a default as missing', () => {
    const target = addDefaults(data(schema, { 'ed:sys': { host: 'h' } }));
    const result = applyEdit(target, edit(schema, { 'ed:sys': { mode: 'auto', '@mode': { 'ietf-netconf:operation': 'create' } } }));
    const mode = (result.children[0] as ContainerInstance).child('mode')!;
    expect(mode.isDefault).toBe(false);
    expect(() => applyEdit(target, edit(schema, { 'ed:sys': { mode: null, '@mode': { 'ietf-netconf:operation': 'delete' } } }))).toThrow(/doesn't exist/);
  });
});

describe('applyEdit: containers of defaults', () => {
  it('merges into a container that holds only defaults', async () => {
    const { compile, mod } = await import('../compile/support.js');
    const s = await compile([mod('dc', 'container c { leaf a { type string; default "x"; } leaf b { type string; } }')]);
    const target = addDefaults(data(s, {}));
    expect(target.children[0]!.isDefault).toBe(true);
    const result = applyEdit(target, edit(s, { 'dc:c': { b: 'y' } }));
    const c = result.children[0] as ContainerInstance;
    expect(c.isDefault).toBe(false);
    expect(c.children.map((n) => `${n.schema.name}${n.isDefault ? ' (default)' : ''}`)).toEqual(['a (default)', 'b']);
  });
});

describe('applyEdit: validation', () => {
  it('validates the result when asked', () => {
    const change = { 'ed:sys': { pres: { extra: 'e' } } };
    expect(apply(schema, {}, change)).toEqual({ 'ed:sys': { pres: { extra: 'e' } } });
    expect(failure(schema, {}, change, { validate: true })).toEqual(['missing-mandatory /ed:sys/pres/need']);
  });
});

describe('the XML edit option', () => {
  it('reads and writes edit attributes', () => {
    const xml = `<sys xmlns="urn:ed" ${NC} ${YANG}><user yang:insert="after" yang:key="[ed:name='a']" nc:operation="create"><name>d</name></user><mtu nc:operation="delete"/></sys>`;
    const tree = edit(schema, xml);
    expect(toXml(tree)).toBe(
      `<sys xmlns="urn:ed"><mtu xmlns:nc="urn:ietf:params:xml:ns:netconf:base:1.0" nc:operation="delete"/><user xmlns:yang="urn:ietf:params:xml:ns:yang:1" xmlns:nc="urn:ietf:params:xml:ns:netconf:base:1.0" yang:insert="after" yang:key="[ed:name='a']" nc:operation="create" xmlns:ed="urn:ed"><name>d</name></user></sys>`,
    );
  });

  it('checks edit attributes', () => {
    expect(() => edit(schema, `<sys xmlns="urn:ed" ${NC}><host nc:operation="frob">x</host></sys>`)).toThrow(/not merge, replace/);
    expect(() => edit(schema, `<sys xmlns="urn:ed" ${YANG}><tag yang:insert="first">x</tag></sys>`)).toThrow(/ordered-by-user/);
    expect(() => edit(schema, `<sys xmlns="urn:ed" ${YANG}><user yang:insert="after"><name>x</name></user></sys>`)).toThrow(/needs yang:key/);
  });
});

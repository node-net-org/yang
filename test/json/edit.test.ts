import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { builtinSource, chainSources, compileSchema, decodeJson, memorySource, readJsonValue, writeXmlText, encodeJson, toXml, YangDataError, type DataIssue, type Schema } from '../../src/index.js';
import { EX_IDS, FIXTURES } from '../data/support.js';

let schema: Schema;
beforeAll(async () => {
  schema = await compileSchema({
    source: chainSources(
      memorySource([
        { text: readFileSync(join(FIXTURES, 'ex-edit.yang'), 'utf8'), source: 'ex-edit.yang' },
        { text: EX_IDS, source: 'ex-ids.yang' },
      ]),
      builtinSource,
    ),
    modules: ['ex-edit'],
  });
  expect(schema.errors).toEqual([]);
});

const edit = (json: unknown): string => toXml(decodeJson(schema, json, { edit: true }));

function issues(json: unknown, edit = true): Omit<DataIssue, 'severity'>[] {
  try {
    decodeJson(schema, json, { edit });
  } catch (err) {
    if (err instanceof YangDataError) return err.issues.map(({ severity: _s, ...rest }) => rest);
    throw err;
  }
  return [];
}

describe('JSON edit content (decode option edit)', () => {
  it('writes ietf-netconf:operation as nc:operation on containers, list entries, leaves and leaf-list entries', () => {
    expect(
      edit({
        'ex-edit:sys': {
          '@': { 'ietf-netconf:operation': 'replace' },
          host: 'r1',
          '@host': { 'ietf-netconf:operation': 'merge' },
          user: [{ name: 'a', '@': { 'ietf-netconf:operation': 'delete' } }],
          dns: ['x', 'y'],
          '@dns': [null, { 'ietf-netconf:operation': 'remove' }],
        },
      }),
    ).toBe(
      '<sys xmlns="urn:ex-edit" xmlns:nc="urn:ietf:params:xml:ns:netconf:base:1.0" nc:operation="replace"><host nc:operation="merge">r1</host>' +
        '<user nc:operation="delete"><name>a</name></user><dns>x</dns><dns nc:operation="remove">y</dns></sys>',
    );
  });

  it('lets a leaf being deleted or removed be null, for an element with no value', () => {
    const json = { 'ex-edit:sys': { mtu: null, '@mtu': { 'ietf-netconf:operation': 'delete' }, kind: null, '@kind': { 'ietf-netconf:operation': 'remove' } } };
    expect(edit(json)).toBe(
      '<sys xmlns="urn:ex-edit"><mtu xmlns:nc="urn:ietf:params:xml:ns:netconf:base:1.0" nc:operation="delete"/><kind xmlns:nc="urn:ietf:params:xml:ns:netconf:base:1.0" nc:operation="remove"/></sys>',
    );
    expect(encodeJson(decodeJson(schema, json, { edit: true }))).toEqual(json);
  });

  it('refuses null for a leaf that is not being deleted, and outside edits', () => {
    expect(issues({ 'ex-edit:sys': { mtu: null } })).toEqual([expect.objectContaining({ code: 'invalid-value', path: '/ex-edit:sys/mtu' })]);
    expect(issues({ 'ex-edit:sys': { mtu: null, '@mtu': { 'ietf-netconf:operation': 'merge' } } })).toEqual([expect.objectContaining({ code: 'invalid-value', path: '/ex-edit:sys/mtu' })]);
    expect(issues({ 'ex-edit:sys': { mtu: null, '@mtu': { 'ietf-netconf:operation': 'delete' } } }, false).map((i) => i.code)).toContain('invalid-value');
  });

  it('writes yang:insert, yang:key and yang:value as written, as libyang does, declaring the module names in them', () => {
    expect(
      edit({
        'ex-edit:sys': {
          user: [{ name: 'b', '@': { 'yang:insert': 'after', 'yang:key': "[name='a']" } }],
          kinds: ['ex-ids:widget'],
          '@kinds': [{ 'yang:insert': 'before', 'yang:value': 'ex-ids:gadget' }],
        },
      }),
    ).toBe(
      '<sys xmlns="urn:ex-edit"><user xmlns:yang="urn:ietf:params:xml:ns:yang:1" yang:insert="after" yang:key="[name=\'a\']"><name>b</name></user>' +
        '<kinds xmlns:yang="urn:ietf:params:xml:ns:yang:1" yang:insert="before" yang:value="ex-ids:gadget" xmlns:ids="urn:ex-ids" xmlns:ex-ids="urn:ex-ids">ids:widget</kinds></sys>',
    );
  });

  it('checks the edit annotations', () => {
    const at = (path: string, message: RegExp): unknown => expect.objectContaining({ code: 'invalid-edit', path, message: expect.stringMatching(message) as unknown });
    expect(issues({ 'ex-edit:sys': { '@': { 'ietf-netconf:operation': 'erase' } } })).toEqual([at('/ex-edit:sys', /not merge, replace, create, delete or remove/)]);
    expect(issues({ 'ex-edit:sys': { '@': { 'ietf-netconf:op': 'merge' } } })).toEqual([at('/ex-edit:sys', /only operation/)]);
    expect(issues({ 'ex-edit:sys': { '@': { 'yang:insert': 'first' } } })).toEqual([at('/ex-edit:sys', /ordered-by-user/)]);
    expect(issues({ 'ex-edit:sys': { user: [{ name: 'b', '@': { 'yang:insert': 'after' } }] } })).toEqual([at("/ex-edit:sys/user[name='b']", /needs yang:key/)]);
    expect(issues({ 'ex-edit:sys': { user: [{ name: 'b', '@': { 'yang:key': "[name='a']" } }] } })).toEqual([at("/ex-edit:sys/user[name='b']", /needs yang:insert/)]);
    expect(issues({ 'ex-edit:sys': { user: [{ name: 'b', '@': { 'yang:insert': 'sideways' } }] } })).toEqual([at("/ex-edit:sys/user[name='b']", /not first, last, before or after/)]);
    expect(issues({ 'ex-edit:sys': { dns: ['x'], '@dns': [{ 'yang:insert': 'after', 'yang:key': "[name='a']" }] } })).toEqual([
      at("/ex-edit:sys/dns[.='x']", /ordered-by-user list$/),
      at("/ex-edit:sys/dns[.='x']", /needs yang:value/),
    ]);
    expect(issues({ 'ex-edit:sys': { '@': { 'ietf-netconf:operation': 5 } } })).toEqual([expect.objectContaining({ code: 'invalid-value' })]);
  });

  it('still refuses state data in a configuration datastore edit', () => {
    const running = schema.forDatastore('running');
    expect(() => decodeJson(running, { 'ex-edit:sys': { state: { up: true } } }, { edit: true })).toThrow(YangDataError);
  });

  it("without edit, the edit annotations need the namespaces option, as before", () => {
    expect(issues({ 'ex-edit:sys': { '@': { 'yang:insert': 'first' } } }, false).map((i) => i.code)).toEqual(['unknown-annotation']);
  });
});

describe('readJsonValue and writeXmlText', () => {
  const leaf = (name: string) => schema.find(`/ex-edit:sys/${name}`) as { type: Parameters<typeof readJsonValue>[1]; module: Parameters<typeof readJsonValue>[3] };

  it('reads RFC 7951 JSON strictly, or leniently from text, and writes canonical XML text with prefixes', () => {
    const mtu = leaf('mtu');
    expect(typeof readJsonValue(schema, mtu.type, '1500', mtu.module)).toBe('string');
    const typed = readJsonValue(schema, mtu.type, '1500', mtu.module, { lenient: true });
    expect(typeof typed === 'string' ? typed : writeXmlText(typed, () => '')).toBe('1500');
    const kind = leaf('kind');
    const id = readJsonValue(schema, kind.type, 'ex-ids:widget', kind.module);
    expect(typeof id === 'string' ? id : writeXmlText(id, (m) => m.prefix)).toBe('ids:widget');
    expect(typeof readJsonValue(schema, mtu.type, 'big', mtu.module, { lenient: true })).toBe('string');
  });
});

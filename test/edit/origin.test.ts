import { beforeAll, describe, expect, it } from 'vitest';
import {
  applyEdit,
  decodeJson,
  decodeXml,
  diffEdit,
  diffTrees,
  effectiveOrigin,
  tryApplyEdit,
  type DataChange,
  type DataTree,
  type ErrorOption,
  type InstanceNode,
  type Origin,
  type Schema,
} from '../../src/index.js';
import { compile, mod } from '../compile/support.js';

// Origins in <operational> (RFC 8342 §7.4): inherited from the parent, compared by identity.
const m = mod(
  'm',
  `identity vendor-learned { base or:learned; }
  container sys {
    leaf hostname { type string; }
    leaf uptime { config false; type uint32; }
    leaf-list dns { type string; ordered-by user; }
    container ntp {
      leaf enabled { type boolean; }
      list server {
        key name;
        leaf name { type string; }
        leaf prefer { type boolean; }
      }
    }
  }`,
  '  import ietf-origin { prefix or; }',
);

const OR = 'urn:ietf:params:xml:ns:yang:ietf-origin';
let full: Schema;
let op: Schema;
let running: Schema;
beforeAll(async () => {
  full = await compile([m], { implement: ['m', 'ietf-origin'] });
  op = full.forDatastore('operational');
  running = full.forDatastore('running');
});

/** XML for `<operational>`, with `x` bound to ietf-origin (a prefix other than `or`, on purpose). */
function xml(body: string, schema: Schema = op, edit = false): DataTree {
  return decodeXml(schema, `<sys xmlns="urn:m" xmlns:x="${OR}" xmlns:nc="urn:ietf:params:xml:ns:netconf:base:1.0">${body}</sys>`, edit ? { edit: true } : {});
}

function name(o: Origin | undefined): string | undefined {
  return o === undefined || typeof o === 'string' ? o : `${o.module.name}:${o.name}`;
}

function summary(changes: readonly DataChange[]): string[] {
  return changes.map((c) => (c.operation === 'origin' ? `origin ${c.path} ${name(c.previousOrigin) ?? '-'} -> ${name(c.origin) ?? '-'}` : `${c.operation} ${c.path}`));
}

function at(tree: DataTree, path: string): InstanceNode {
  const n = [...tree.walk()].find((x) => x.path === path);
  if (n === undefined) throw new Error(`no node at ${path}`);
  return n;
}

const origins = (n: InstanceNode): number => n.annotations.filter((a) => a.name === 'origin').length;

/** Every node's path and effective origin, for comparing trees. */
function effective(tree: DataTree): string[] {
  return [...tree.walk()].map((n) => `${n.path} ${name(effectiveOrigin(n)) ?? '-'}`);
}

describe('effectiveOrigin', () => {
  it('reads a node’s own origin, or its nearest ancestor’s, or none', () => {
    const t = xml(`<hostname>r1</hostname><ntp x:origin="x:learned"><server><name>a</name><prefer x:origin="x:system">true</prefer></server></ntp>`);
    expect(name(effectiveOrigin(at(t, '/m:sys')))).toBeUndefined();
    expect(name(effectiveOrigin(at(t, '/m:sys/ntp')))).toBe('ietf-origin:learned');
    expect(name(effectiveOrigin(at(t, "/m:sys/ntp/server[name='a']/name")))).toBe('ietf-origin:learned');
    expect(name(effectiveOrigin(at(t, "/m:sys/ntp/server[name='a']/prefer")))).toBe('ietf-origin:system');
  });

  it('is the identity, whatever prefix the XML used, and the same identity from JSON', () => {
    const fromXml = xml(`<hostname x:origin="x:intended">r1</hostname>`);
    const fromJson = decodeJson(op, { 'm:sys': { hostname: 'r1', '@hostname': { 'ietf-origin:origin': 'ietf-origin:intended' } } });
    const a = effectiveOrigin(at(fromXml, '/m:sys/hostname'));
    expect(a).toBe(effectiveOrigin(at(fromJson, '/m:sys/hostname')));
    expect(diffTrees(fromXml, fromJson)).toEqual([]);
  });
});

describe('diffTrees with origins', () => {
  it('reports a container’s origin change once, not for the children that inherit it', () => {
    const from = xml(`<hostname>r1</hostname><ntp x:origin="x:intended"><enabled>true</enabled><server><name>a</name></server></ntp>`);
    const to = xml(`<hostname>r1</hostname><ntp x:origin="x:learned"><enabled>true</enabled><server><name>a</name></server></ntp>`);
    expect(summary(diffTrees(from, to))).toEqual(['origin /m:sys/ntp ietf-origin:intended -> ietf-origin:learned']);
  });

  it('reports changes at several depths, including a child with its own origin that also changed', () => {
    const from = xml(
      `<hostname>r1</hostname><dns>a</dns><ntp><enabled x:origin="x:default">true</enabled><server x:origin="x:learned"><name>a</name><prefer>true</prefer></server></ntp>`,
    );
    const to = decodeXml(
      op,
      `<sys xmlns="urn:m" xmlns:x="${OR}" x:origin="x:intended"><hostname>r1</hostname><dns x:origin="x:system">a</dns><ntp><enabled x:origin="x:intended">true</enabled><server><name>a</name><prefer x:origin="x:default">true</prefer></server></ntp></sys>`,
    );
    expect(summary(diffTrees(from, to))).toEqual([
      'origin /m:sys - -> ietf-origin:intended',
      "origin /m:sys/dns[.='a'] - -> ietf-origin:system",
      'origin /m:sys/ntp/enabled ietf-origin:default -> ietf-origin:intended',
      "origin /m:sys/ntp/server[name='a'] ietf-origin:learned -> ietf-origin:intended",
      "origin /m:sys/ntp/server[name='a']/prefer ietf-origin:learned -> ietf-origin:default",
    ]);
  });

  it('treats making an inherited origin explicit, or the reverse, as no change', () => {
    const inherited = decodeXml(op, `<sys xmlns="urn:m" xmlns:x="${OR}" x:origin="x:intended"><hostname>r1</hostname><ntp><enabled>true</enabled></ntp></sys>`);
    const explicit = decodeXml(op, `<sys xmlns="urn:m" xmlns:x="${OR}" x:origin="x:intended"><hostname x:origin="x:intended">r1</hostname><ntp x:origin="x:intended"><enabled x:origin="x:intended">true</enabled></ntp></sys>`);
    expect(diffTrees(inherited, explicit)).toEqual([]);
    expect(diffTrees(explicit, inherited)).toEqual([]);
  });

  it('gives a leaf whose value and origin both changed a replace and then an origin change; created and deleted nodes get none', () => {
    const from = xml(`<hostname x:origin="x:intended">r1</hostname><ntp x:origin="x:learned"><enabled>true</enabled></ntp>`);
    const to = xml(`<hostname x:origin="x:learned">r2</hostname><dns x:origin="x:system">d</dns>`);
    expect(summary(diffTrees(from, to))).toEqual(['replace /m:sys/hostname', 'origin /m:sys/hostname ietf-origin:intended -> ietf-origin:learned', "create /m:sys/dns[.='d']", 'delete /m:sys/ntp']);
  });

  it('tells a vendor identity derived from or:learned from or:learned', () => {
    const from = xml(`<hostname x:origin="x:learned">r1</hostname>`);
    const to = decodeXml(op, `<sys xmlns="urn:m" xmlns:v="urn:m"><hostname xmlns:o="${OR}" o:origin="v:vendor-learned">r1</hostname></sys>`);
    const vendor = effectiveOrigin(at(to, '/m:sys/hostname'));
    expect(name(vendor)).toBe('m:vendor-learned');
    expect(summary(diffTrees(from, to))).toEqual(['origin /m:sys/hostname ietf-origin:learned -> m:vendor-learned']);
    // derived-from, as origin-filter matches it
    const learned = full.module('ietf-origin')!.identities.get('learned')!;
    expect(typeof vendor !== 'string' && learned.derived.has(vendor!)).toBe(true);
    expect(diffTrees(to, decodeJson(op, { 'm:sys': { hostname: 'r1', '@hostname': { 'ietf-origin:origin': 'm:vendor-learned' } } }))).toEqual([]);
  });

  it('compares origins only for trees that hold state, unless told', () => {
    const from = xml(`<hostname x:origin="x:intended">r1</hostname>`);
    const to = xml(`<hostname x:origin="x:learned">r1</hostname>`);
    expect(diffTrees(from, to, { origin: false })).toEqual([]);
    // A configuration datastore's tree can't carry origins from the codecs; one built by hand is ignored unless asked.
    const a = decodeXml(running, '<sys xmlns="urn:m"><hostname>r1</hostname></sys>');
    const b = decodeXml(running, '<sys xmlns="urn:m"><hostname>r1</hostname></sys>');
    b.children[0]!.annotations.push({ namespace: OR, module: 'ietf-origin', name: 'origin', value: 'ietf-origin:learned' });
    expect(diffTrees(a, b)).toEqual([]);
    expect(summary(diffTrees(a, b, { origin: true }))).toEqual(['origin /m:sys - -> ietf-origin:learned']);
  });
});

describe('diffEdit with origins', () => {
  it('writes merges with the new origin, which applyEdit turns the first tree into the second with', () => {
    const from = xml(`<hostname x:origin="x:intended">r1</hostname><dns>a</dns><ntp x:origin="x:intended"><enabled>true</enabled><server><name>a</name><prefer x:origin="x:system">true</prefer></server></ntp>`);
    const to = xml(`<hostname x:origin="x:learned">r2</hostname><dns x:origin="x:system">a</dns><ntp x:origin="x:learned"><enabled>true</enabled><server><name>a</name><prefer>true</prefer></server></ntp>`);
    const edit = diffEdit(from, to);
    const after = applyEdit(from, edit);
    expect(effective(after)).toEqual(effective(to));
    expect(diffTrees(after, to)).toEqual([]);
    expect([...after.walk()].every((n) => origins(n) <= 1)).toBe(true);
  });
});

describe('applyEdit and tryApplyEdit with origins', () => {
  const target = (): DataTree => decodeJson(op, { 'm:sys': { '@': { 'ietf-origin:origin': 'ietf-origin:intended' }, hostname: 'r1', '@hostname': { 'ietf-origin:origin': 'ietf-origin:learned' }, ntp: { enabled: true } } });

  it('replaces a node’s origin rather than adding a second, from XML onto JSON', () => {
    const after = applyEdit(target(), xml(`<hostname x:origin="x:system">r1</hostname>`, op, true));
    const hostname = at(after, '/m:sys/hostname');
    expect(origins(hostname)).toBe(1);
    expect(name(effectiveOrigin(hostname))).toBe('ietf-origin:system');
  });

  it('replaces an origin built by hand, known by its module alone', () => {
    const t = target();
    const hostname = at(t, '/m:sys/hostname');
    hostname.annotations.length = 0;
    hostname.annotations.push({ namespace: undefined, module: 'ietf-origin', name: 'origin', value: 'ietf-origin:learned' });
    const after = applyEdit(t, xml(`<hostname x:origin="x:system">r1</hostname>`, op, true));
    expect(origins(at(after, '/m:sys/hostname'))).toBe(1);
    expect(name(effectiveOrigin(at(after, '/m:sys/hostname')))).toBe('ietf-origin:system');
  });

  it('drops an origin equal to the inherited one, and lets created nodes inherit', () => {
    const after = applyEdit(target(), xml(`<hostname x:origin="x:intended">r1</hostname><ntp><server><name>a</name></server></ntp><dns x:origin="x:intended">d</dns>`, op, true));
    expect(origins(at(after, '/m:sys/hostname'))).toBe(0);
    expect(origins(at(after, "/m:sys/dns[.='d']"))).toBe(0);
    expect(name(effectiveOrigin(at(after, '/m:sys/hostname')))).toBe('ietf-origin:intended');
    expect(name(effectiveOrigin(at(after, "/m:sys/ntp/server[name='a']")))).toBe('ietf-origin:intended');
  });

  it('keeps an origin that differs from the inherited one, and leaves origins an edit node doesn’t give', () => {
    const after = applyEdit(target(), xml(`<hostname>r2</hostname><ntp x:origin="x:learned"><enabled x:origin="x:learned">false</enabled></ntp>`, op, true));
    expect(name(effectiveOrigin(at(after, '/m:sys/hostname')))).toBe('ietf-origin:learned');
    expect(origins(at(after, '/m:sys/ntp'))).toBe(1);
    // under the new learned container, an explicit learned is redundant and dropped
    expect(origins(at(after, '/m:sys/ntp/enabled'))).toBe(0);
    expect(name(effectiveOrigin(at(after, '/m:sys/ntp/enabled')))).toBe('ietf-origin:learned');
  });

  it.each<ErrorOption>(['rollback-on-error', 'stop-on-error', 'continue-on-error'])('does the same through tryApplyEdit with %s', (errorOption) => {
    const result = tryApplyEdit(target(), xml(`<hostname x:origin="x:system">r1</hostname><ntp><enabled x:origin="x:intended">true</enabled></ntp>`, op, true), { errorOption });
    expect(result).toMatchObject({ errors: [], rejected: false });
    expect(origins(at(result.tree, '/m:sys/hostname'))).toBe(1);
    expect(name(effectiveOrigin(at(result.tree, '/m:sys/hostname')))).toBe('ietf-origin:system');
    expect(origins(at(result.tree, '/m:sys/ntp/enabled'))).toBe(0);
  });

  it('applies origins up to an error under stop-on-error, and around it under continue-on-error', () => {
    const edit = xml(`<hostname x:origin="x:system">r1</hostname><ntp nc:operation="create" x:origin="x:learned"/><dns x:origin="x:system">d</dns>`, op, true);
    const stop = tryApplyEdit(target(), edit, { errorOption: 'stop-on-error' });
    expect(stop.errors.map((e) => e.code)).toEqual(['data-exists']);
    expect(name(effectiveOrigin(at(stop.tree, '/m:sys/hostname')))).toBe('ietf-origin:system');
    expect(name(effectiveOrigin(at(stop.tree, '/m:sys/ntp')))).toBe('ietf-origin:intended');
    const cont = tryApplyEdit(target(), edit, { errorOption: 'continue-on-error' });
    expect(name(effectiveOrigin(at(cont.tree, "/m:sys/dns[.='d']")))).toBe('ietf-origin:system');
  });

  it('leaves a configuration datastore’s edit as before', () => {
    // An edit decoded for <operational> applied to <running>: annotations are copied as they always were.
    const t = decodeXml(running, '<sys xmlns="urn:m"><hostname>r1</hostname></sys>');
    const after = applyEdit(t, xml(`<hostname x:origin="x:system">r2</hostname>`, op, true));
    expect(origins(at(after, '/m:sys/hostname'))).toBe(1);
  });
});

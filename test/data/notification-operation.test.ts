// CODEC-21: a notification's bare content, named by its path with the operation option.

import { beforeAll, describe, expect, it } from 'vitest';
import {
  builtinSource,
  chainSources,
  compileSchema,
  decodeJson,
  decodeXml,
  encodeJson,
  ListEntry,
  memorySource,
  toXml,
  validate,
  YangDataError,
  type Schema,
} from '../../src/index.js';

const MOD = `module nt {
  yang-version 1.1;
  namespace "urn:nt";
  prefix nt;
  container servers {
    list server {
      key "name port";
      leaf name { type string; }
      leaf port { type uint16; }
      notification restarted { leaf reason { type string; } }
    }
    notification all-restarted { leaf count { type uint32; } }
  }
  rpc ping { input { leaf to { type string; } } }
  notification alarm { leaf severity { type string; mandatory true; } }
}`;

let schema: Schema;
beforeAll(async () => {
  schema = await compileSchema({ source: chainSources(memorySource([{ text: MOD, source: 'nt.yang' }]), builtinSource), modules: ['nt'] });
  expect(schema.errors).toEqual([]);
});

function codes(f: () => unknown): string[] {
  try {
    f();
  } catch (err) {
    if (err instanceof YangDataError) return err.issues.map((i) => `${i.code} ${i.path}`);
    throw err;
  }
  return [];
}

describe('CODEC-21: a notification named by its path', () => {
  it('AC1: names a top-level notification, or a nested one by its parent instance', () => {
    const top = decodeJson(schema, { severity: 'major' }, { type: 'notification', operation: '/nt:alarm' });
    expect(top.operation!.path).toBe('/nt:alarm');
    const inContainer = decodeXml(schema, '<count xmlns="urn:nt">3</count>', { type: 'notification', operation: '/nt:servers/all-restarted' });
    expect(inContainer.operation!.path).toBe('/nt:servers/all-restarted');
    const inEntry = decodeJson(schema, { reason: 'upgrade' }, { type: 'notification', operation: "/nt:servers/server[name='a'][port='80']/restarted" });
    expect(inEntry.operation!.path).toBe("/nt:servers/server[name='a'][port='80']/restarted");
  });

  it('AC2: reads the bare content in XML or JSON and builds keyed ancestors', () => {
    const xml = decodeXml(schema, '<reason xmlns="urn:nt">upgrade</reason>', { type: 'notification', operation: "/nt:servers/server[name='a'][port='080']/restarted" });
    expect(xml.operation!.parent).toBeInstanceOf(ListEntry);
    expect(toXml(xml)).toBe('<servers xmlns="urn:nt"><server><name>a</name><port>80</port><restarted><reason>upgrade</reason></restarted></server></servers>');
    const json = decodeJson(schema, { reason: 'upgrade' }, { type: 'notification', operation: "/nt:servers/server[name='a'][port='80']/restarted" });
    expect(toXml(json)).toBe(toXml(xml));
  });

  it('AC3: a path naming no notification, or an RPC, is invalid-operation', () => {
    expect(codes(() => decodeJson(schema, {}, { type: 'notification', operation: '/nt:nope' }))).toEqual(['invalid-operation /nt:nope']);
    expect(codes(() => decodeJson(schema, {}, { type: 'notification', operation: '/nt:ping' }))).toEqual(['invalid-operation /nt:ping']);
    expect(codes(() => decodeJson(schema, {}, { type: 'notification', operation: "/nt:servers/server[name='a']/restarted" }))).toEqual([
      "invalid-operation /nt:servers/server[name='a']/restarted",
    ]);
    expect(codes(() => decodeJson(schema, {}, { type: 'data', operation: '/nt:alarm' }))[0]).toMatch(/^invalid-operation/);
  });

  it('AC4: validating with operational data checks the parent instance exists', () => {
    const notif = decodeJson(schema, { reason: 'x' }, { type: 'notification', operation: "/nt:servers/server[name='a'][port='80']/restarted" });
    const none = decodeJson(schema, {});
    expect(validate(notif, { operational: none }).map((i) => i.code)).toContain('missing-parent');
    const present = decodeJson(schema, { 'nt:servers': { server: [{ name: 'a', port: 80 }] } });
    expect(validate(notif, { operational: present }).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('AC5: encodes like the notification written with its ancestors', () => {
    const bare = decodeJson(schema, { reason: 'r' }, { type: 'notification', operation: "/nt:servers/server[name='b'][port='1']/restarted" });
    const whole = decodeJson(schema, { 'nt:servers': { server: [{ name: 'b', port: 1, restarted: { reason: 'r' } }] } }, { type: 'notification' });
    expect(encodeJson(bare)).toEqual(encodeJson(whole));
    expect(toXml(bare)).toBe(toXml(whole));
  });

  it('AC6: rpc and reply decoding is unchanged', () => {
    const rpc = decodeJson(schema, { to: 'x' }, { type: 'rpc', operation: '/nt:ping' });
    expect(rpc.operation!.path).toBe('/nt:ping');
    expect(codes(() => decodeJson(schema, {}, { type: 'rpc', operation: '/nt:alarm' }))).toEqual(['invalid-operation /nt:alarm']);
    // RESTCONF's input wrapper is still read for RPCs.
    expect(toXml(decodeJson(schema, { 'nt:input': { to: 'y' } }, { type: 'rpc', operation: '/nt:ping' }))).toBe('<ping xmlns="urn:nt"><to>y</to></ping>');
  });
});

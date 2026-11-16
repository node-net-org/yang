import { beforeAll, describe, expect, it } from 'vitest';
import { applyEdit, encodeJson, tryApplyEdit, YangDataError, type ErrorOption, type Schema, type TryEditOptions } from '../../src/index.js';
import { data, edit, edSchema } from './support.js';

let schema: Schema;
beforeAll(async () => {
  schema = await edSchema();
});

const NC = 'xmlns:nc="urn:ietf:params:xml:ns:netconf:base:1.0"';

const start = {
  'ed:sys': {
    host: 'h',
    mtu: 1500,
    user: [{ name: 'a', uid: 1 }, { name: 'b' }, { name: 'c' }],
    dns: ['1.1.1.1'],
    tag: ['x'],
    'tcp-port': 22,
  },
};

interface Outcome {
  readonly tree: object;
  readonly errors: string[];
  readonly rejected: boolean;
  readonly same: boolean;
}

/** Applies an edit with an error option; `same` says whether the target itself came back. */
function run(target: object, change: object | string, errorOption?: ErrorOption, options: TryEditOptions = {}): Outcome {
  const t = data(schema, target);
  const before = encodeJson(t);
  const r = tryApplyEdit(t, edit(schema, change), errorOption === undefined ? options : { ...options, errorOption });
  expect(encodeJson(t)).toEqual(before);
  return { tree: encodeJson(r.tree), errors: r.errors.map((i) => `${i.code} ${i.path}`), rejected: r.rejected, same: r.tree === t };
}

const users = (tree: object): unknown => (tree as { 'ed:sys': { user?: unknown } })['ed:sys'].user;

describe('tryApplyEdit: create and delete conflicts', () => {
  const change = `<sys xmlns="urn:ed" ${NC}><host>n</host><mtu>1400</mtu><user nc:operation="create"><name>b</name></user><user nc:operation="delete"><name>z</name></user><tag>y</tag></sys>`;
  const both = ["data-exists /ed:sys/user[name='b']", "data-missing /ed:sys/user[name='z']"];

  it('rollback-on-error, the default: applies nothing and reports every error', () => {
    for (const option of [undefined, 'rollback-on-error'] as const) {
      expect(run(start, change, option)).toEqual({ tree: start, errors: both, rejected: true, same: true });
    }
  });

  it('stop-on-error: keeps what came before the first error, and nothing after it', () => {
    const out = run(start, change, 'stop-on-error');
    expect(out.errors).toEqual(both.slice(0, 1));
    expect(out.rejected).toBe(false);
    expect(out.tree).toEqual({ 'ed:sys': { ...start['ed:sys'], host: 'n', mtu: 1400 } });
  });

  it('continue-on-error: skips each failing node and applies the rest', () => {
    const out = run(start, change, 'continue-on-error');
    expect(out.errors).toEqual(both);
    expect(out.rejected).toBe(false);
    expect(out.tree).toEqual({ 'ed:sys': { ...start['ed:sys'], host: 'n', mtu: 1400, tag: ['x', 'y'] } });
  });

  it('a whole edit that applies has no errors under any option', () => {
    for (const option of ['rollback-on-error', 'stop-on-error', 'continue-on-error'] as const) {
      expect(run(start, { 'ed:sys': { host: 'n' } }, option)).toEqual({ tree: { 'ed:sys': { ...start['ed:sys'], host: 'n' } }, errors: [], rejected: false, same: false });
    }
  });

  it('skips a failing node with its subtree', () => {
    const change = { 'ed:sys': { '@': { 'ietf-netconf:operation': 'create' }, host: 'z' }, 'ed:other': { z: '1' } };
    expect(run(start, change, 'continue-on-error')).toMatchObject({ tree: { ...start, 'ed:other': { z: '1' } }, errors: ['data-exists /ed:sys'] });
  });
});

describe('tryApplyEdit: yang:insert anchors (RFC 7950 §7.8.6)', () => {
  const after = (key: string): object => ({ 'yang:insert': 'after', 'yang:key': key });
  const change = { 'ed:sys': { user: [{ name: 'a', uid: 9, '@': after("[name='zz']") }, { name: 'd', '@': after("[name='zz']") }, { name: 'e', '@': after("[name='d']") }, { name: 'f' }] } };

  it('rollback-on-error reports what applyEdit reports', () => {
    // d is created before its anchor is found missing, so e finds d: the same two errors as applyEdit.
    const out = run(start, change);
    expect(out.errors).toEqual(["missing-anchor /ed:sys/user[name='a']", "missing-anchor /ed:sys/user[name='d']"]);
    expect(out.rejected).toBe(true);
  });

  it('stop-on-error: stops at the first missing anchor, leaving the entry as it was', () => {
    const out = run(start, change, 'stop-on-error');
    expect(out.errors).toEqual(["missing-anchor /ed:sys/user[name='a']"]);
    expect(users(out.tree)).toEqual(start['ed:sys'].user);
  });

  it('continue-on-error: an anchor that a skipped entry would have created is missing too', () => {
    const out = run(start, change, 'continue-on-error');
    expect(out.errors).toEqual(["missing-anchor /ed:sys/user[name='a']", "missing-anchor /ed:sys/user[name='d']", "missing-anchor /ed:sys/user[name='e']"]);
    // a keeps uid 1: a skipped entry isn't merged into either.
    expect(users(out.tree)).toEqual([{ name: 'a', uid: 1 }, { name: 'b' }, { name: 'c' }, { name: 'f' }]);
  });

  it('continue-on-error: skips a leaf-list entry with a missing anchor', () => {
    const out = run(start, { 'ed:sys': { dns: ['9.9.9.9', '8.8.8.8'], '@dns': [{ 'yang:insert': 'before', 'yang:value': '2.2.2.2' }, {}] } }, 'continue-on-error');
    expect(out.errors).toEqual(["missing-anchor /ed:sys/dns[.='9.9.9.9']"]);
    expect(out.tree).toMatchObject({ 'ed:sys': { dns: ['1.1.1.1', '8.8.8.8'] } });
  });

  it('continue-on-error: an entry anchored to itself is invalid-edit and skipped', () => {
    const out = run(start, { 'ed:sys': { user: [{ name: 'a', uid: 9, '@': after("[name='a']") }] } }, 'continue-on-error');
    expect(out.errors).toEqual(["invalid-edit /ed:sys/user[name='a']"]);
    expect(out.tree).toEqual(start);
  });
});

describe('tryApplyEdit: choices (RFC 7950 §7.9)', () => {
  // keepalive (case tcp) comes before udp-port (case udp) in the edit.
  const change = { 'ed:sys': { 'udp-port': 53, keepalive: true } };

  it('rollback-on-error refuses two cases', () => {
    expect(run(start, change)).toMatchObject({ errors: ['multiple-cases /ed:sys/udp-port'], rejected: true, same: true });
  });

  it('stop-on-error and continue-on-error keep the first case and skip the second', () => {
    for (const option of ['stop-on-error', 'continue-on-error'] as const) {
      const out = run(start, change, option);
      expect(out.errors).toEqual(['multiple-cases /ed:sys/udp-port']);
      expect(out.tree).toEqual({ 'ed:sys': { ...start['ed:sys'], keepalive: true } });
    }
  });

  it('a node in another case than a skipped one is no conflict, and replaces the old case', () => {
    const target = { 'ed:sys': { 'tcp-port': 22, keepalive: true } };
    const out = run(target, { 'ed:sys': { keepalive: true, '@keepalive': { 'ietf-netconf:operation': 'create' }, 'udp-port': 53 } }, 'continue-on-error');
    expect(out.errors).toEqual(['data-exists /ed:sys/keepalive']);
    expect(out.tree).toEqual({ 'ed:sys': { 'udp-port': 53 } });
  });
});

describe('tryApplyEdit: replace', () => {
  const change = `<sys xmlns="urn:ed" ${NC} nc:operation="replace"><host>z</host><user nc:operation="create"><name>b</name></user><user><name>q</name></user></sys>`;

  it('continue-on-error: a skipped child of a replaced node is kept as it was', () => {
    const out = run(start, change, 'continue-on-error');
    expect(out.errors).toEqual(["data-exists /ed:sys/user[name='b']"]);
    expect(out.tree).toEqual({ 'ed:sys': { host: 'z', user: [{ name: 'b' }, { name: 'q' }] } });
  });

  it("stop-on-error: a replace cut short doesn't remove what it didn't name", () => {
    const out = run(start, change, 'stop-on-error');
    expect(out.errors).toEqual(["data-exists /ed:sys/user[name='b']"]);
    expect(out.tree).toEqual({ 'ed:sys': { ...start['ed:sys'], host: 'z' } });
  });

  it('the replace default operation, cut short or not', () => {
    const change = { 'ed:other': { z: '1' }, 'ed:sys': { host: 'n', '@host': { 'ietf-netconf:operation': 'create' } } };
    const options = { defaultOperation: 'replace' } as const;
    expect(run(start, change, 'stop-on-error', options)).toMatchObject({ tree: { ...start, 'ed:other': { z: '1' } }, errors: ['data-exists /ed:sys/host'] });
    expect(run(start, change, 'continue-on-error', options)).toMatchObject({ tree: { 'ed:sys': { host: 'h' }, 'ed:other': { z: '1' } }, errors: ['data-exists /ed:sys/host'] });
  });
});

describe('tryApplyEdit: validation', () => {
  it('validates the partial result, and a validation error rejects the whole edit', () => {
    // need's delete fails and is skipped, so pres is created without its mandatory leaf.
    const change = `<sys xmlns="urn:ed" ${NC}><host>n</host><pres><need nc:operation="delete"/><extra>e</extra></pres></sys>`;
    expect(run(start, change, 'continue-on-error', { validate: true })).toEqual({
      tree: start,
      errors: ['data-missing /ed:sys/pres/need', 'missing-mandatory /ed:sys/pres/need'],
      rejected: true,
      same: true,
    });
    expect(run(start, change, 'continue-on-error')).toMatchObject({ errors: ['data-missing /ed:sys/pres/need'], rejected: false, tree: { 'ed:sys': { host: 'n', pres: { extra: 'e' } } } });
  });

  it('a partial result that validates is kept, with the edit errors', () => {
    const change = `<sys xmlns="urn:ed" ${NC}><host nc:operation="create">n</host><pres><need>n</need></pres></sys>`;
    expect(run(start, change, 'continue-on-error', { validate: true })).toMatchObject({ errors: ['data-exists /ed:sys/host'], rejected: false, tree: { 'ed:sys': { host: 'h', pres: { need: 'n' } } } });
    // stop-on-error stops at host, before pres; what applied (nothing) is valid.
    expect(run(start, change, 'stop-on-error', { validate: true })).toMatchObject({ errors: ['data-exists /ed:sys/host'], rejected: false, tree: start });
  });

  it('rollback-on-error rejects on edit errors without validating, as applyEdit does', () => {
    const change = `<sys xmlns="urn:ed" ${NC}><host nc:operation="create">n</host><pres><extra>e</extra></pres></sys>`;
    expect(run(start, change, 'rollback-on-error', { validate: true })).toMatchObject({ errors: ['data-exists /ed:sys/host'], rejected: true });
    expect(run(start, { 'ed:sys': { pres: { extra: 'e' } } }, 'rollback-on-error', { validate: true })).toMatchObject({ errors: ['missing-mandatory /ed:sys/pres/need'], rejected: true });
  });
});

describe('applyEdit and tryApplyEdit', () => {
  it('applyEdit throws what tryApplyEdit returns under rollback-on-error', () => {
    const changes: (object | string)[] = [
      `<sys xmlns="urn:ed" ${NC}><user nc:operation="create"><name>b</name></user><user nc:operation="delete"><name>z</name></user></sys>`,
      { 'ed:sys': { 'udp-port': 53, keepalive: true } },
      { 'ed:sys': { user: [{ name: 'd', '@': { 'yang:insert': 'after', 'yang:key': "[name='zz']" } }] } },
      { 'ed:sys': { pres: { extra: 'e' } } },
    ];
    for (const change of changes) {
      const target = data(schema, start);
      const e = edit(schema, change);
      const outcome = tryApplyEdit(target, e, { validate: true });
      let thrown: unknown;
      try {
        applyEdit(target, e, { validate: true });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(YangDataError);
      expect((thrown as YangDataError).issues).toEqual(outcome.errors);
    }
  });

  it('applyEdit ignores an errorOption it is given', () => {
    const options = { errorOption: 'continue-on-error' } as TryEditOptions;
    expect(() => applyEdit(data(schema, start), edit(schema, { 'ed:other': { '@': { 'ietf-netconf:operation': 'delete' } } }), options)).toThrow(YangDataError);
  });

  it('refuses an unknown error option', () => {
    expect(() => tryApplyEdit(data(schema, start), edit(schema, {}), { errorOption: 'ignore-errors' as ErrorOption })).toThrow(TypeError);
  });
});

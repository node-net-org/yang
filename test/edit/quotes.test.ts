/**
 * Key and leaf-list values holding both quote characters: XPath 1.0 has no
 * escapes, so data paths write them as concat(), and diffEdit refuses to put
 * one in yang:key, whose grammar has quoted strings only (RFC 7950 §7.8.6).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { applyEdit, decodeJson, decodeXml, diffEdit, encodeJson, evaluateXPath, parseXPath, toXml, YangDataError, type Schema } from '../../src/index.js';
import { xpathLiteral } from '../../src/xpath/literal.js';
import { data, edSchema } from './support.js';

let schema: Schema;
beforeAll(async () => {
  schema = await edSchema();
});

const BOTH = `it's "x"`;
const BOTH_LITERAL = `concat('it', "'", 's "x"')`;

describe('xpathLiteral', () => {
  it('quotes a value as before when it holds at most one kind of quote', () => {
    expect(xpathLiteral('eth0')).toBe("'eth0'");
    expect(xpathLiteral('')).toBe("''");
    expect(xpathLiteral(`say "hi"`)).toBe(`'say "hi"'`);
    expect(xpathLiteral("it's")).toBe(`"it's"`);
  });

  it('writes concat() for a value holding both, dropping empty pieces', () => {
    expect(xpathLiteral(BOTH)).toBe(BOTH_LITERAL);
    expect(xpathLiteral(`'"`)).toBe(`concat("'", '"')`);
    expect(xpathLiteral(`"''"`)).toBe(`concat('"', "'", "'", '"')`);
  });

  it('gives an expression that evaluates to the value', () => {
    const tree = decodeJson(schema, {});
    for (const s of [BOTH, `'"`, `"''"`, `a'b"c'd`, "it's", 'plain']) {
      const v = evaluateXPath(tree, `string(${xpathLiteral(s)})`);
      expect(v).toBe(s);
      // And it parses: a literal or a concat() call.
      expect(['literal', 'call']).toContain(parseXPath(xpathLiteral(s)).type);
    }
  });
});

describe('data paths', () => {
  it('write a list key holding both quotes as concat(), and leave others as they were', () => {
    const tree = decodeJson(schema, { 'ed:sys': { user: [{ name: BOTH }, { name: "o'neil" }, { name: 'a' }], dns: [BOTH] } });
    const sys = tree.child('sys')!;
    const paths = 'children' in sys ? sys.children.map((c) => c.path) : [];
    expect(paths).toEqual([`/ed:sys/user[name=${BOTH_LITERAL}]`, `/ed:sys/user[name="o'neil"]`, "/ed:sys/user[name='a']", `/ed:sys/dns[.=${BOTH_LITERAL}]`]);
  });

  it('read back as XPath, selecting the node they name', () => {
    const tree = decodeJson(schema, { 'ed:sys': { user: [{ name: 'a' }, { name: BOTH, uid: 7 }], dns: ['x', BOTH] } });
    const sys = tree.child('sys')!;
    for (const n of 'children' in sys ? sys.children : []) {
      expect(evaluateXPath(tree, n.path)).toEqual([n]);
    }
  });

  it('are reported in issues', () => {
    try {
      decodeJson(schema, { 'ed:sys': { user: [{ name: BOTH, uid: 'x' }] } });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(YangDataError);
      expect((e as YangDataError).issues.map((i) => i.path)).toEqual([`/ed:sys/user[name=${BOTH_LITERAL}]/uid`]);
    }
  });

  it('are read past by schema queries', () => {
    expect(schema.describe(`/ed:sys/user[name=${BOTH_LITERAL}]/uid`)?.name).toBe('uid');
    expect(schema.describe(`/ed:sys/dns[.=${BOTH_LITERAL}]`)?.name).toBe('dns');
    expect(schema.children(`/ed:sys/user[name=${BOTH_LITERAL}]`)?.map((n) => n.name)).toEqual(['name', 'uid', 'shell']);
    expect(schema.complete(`/ed:sys/user[name=${BOTH_LITERAL}]/u`).map((c) => c.text)).toEqual([`/ed:sys/user[name=${BOTH_LITERAL}]/uid`]);
  });
});

describe('yang:key and yang:value in edits made from diffs', () => {
  const users = (...names: string[]): object => ({ 'ed:sys': { user: names.map((name) => ({ name })) } });

  it('refuses to anchor an entry after one whose key holds both quotes', () => {
    const from = data(schema, users(BOTH, 'b'));
    const to = data(schema, users(BOTH, 'c', 'b'));
    try {
      diffEdit(from, to);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(YangDataError);
      const issues = (e as YangDataError).issues;
      expect(issues.map((i) => `${i.code} ${i.path}`)).toEqual([`unwritable-anchor /ed:sys/user[name=${BOTH_LITERAL}]`]);
      expect(issues[0]!.message).toContain(`both ' and "`);
    }
  });

  it('moves and creates entries whose own keys hold both quotes, applied back through XML', () => {
    // Last in the result, so no entry is placed after it.
    const from = data(schema, users('a', BOTH, "o'neil", 'b'));
    const to = data(schema, users('b', `n"q`, 'a', "o'neil", BOTH));
    const edit = diffEdit(from, to);
    const reread = decodeXml(schema, toXml(edit), { edit: true });
    expect(encodeJson(applyEdit(from, reread))).toEqual(encodeJson(to));
    expect(toXml(edit)).toContain('yang:key=');
  });

  it('writes a yang:value holding both quotes bare', () => {
    const from = data(schema, { 'ed:sys': { dns: [BOTH, 'b'] } });
    const to = data(schema, { 'ed:sys': { dns: ['b', BOTH, 'c'] } });
    const edit = diffEdit(from, to);
    expect(JSON.stringify(encodeJson(edit))).toContain(JSON.stringify(BOTH));
    const reread = decodeXml(schema, toXml(edit), { edit: true });
    expect(encodeJson(applyEdit(from, reread))).toEqual(encodeJson(to));
  });
});

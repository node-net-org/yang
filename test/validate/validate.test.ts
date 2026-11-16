import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { assertValid, decodeJson, encodeJson, validate, YangDataError, type DataIssue, type Schema } from '../../src/index.js';
import { compile, mod } from '../compile/support.js';

const DIR = join(import.meta.dirname, '..', 'fixtures', 'validate');
const VX = readFileSync(join(DIR, 'vx.yang'), 'utf8');
const json = (name: string): unknown => JSON.parse(readFileSync(join(DIR, 'data', `${name}.json`), 'utf8'));

let vx: Schema;
beforeAll(async () => {
  vx = await compile([VX]);
  expect(vx.errors).toEqual([]);
});

const codes = (issues: readonly DataIssue[]): string[][] => issues.map((i) => [i.code, i.path]);

describe('validate()', () => {
  it('leaves the tree as it was given, unless asked to keep defaults', () => {
    const tree = decodeJson(vx, json('valid'));
    const before = encodeJson(tree);
    expect(validate(tree)).toEqual([]);
    expect(encodeJson(tree)).toEqual(before);
    expect(validate(tree, { keepDefaults: true })).toEqual([]);
    const after = encodeJson(tree) as { 'vx:c': Record<string, unknown> };
    // The default was added; the empty non-presence containers made for validation were not kept.
    expect(after['vx:c']['mode']).toBe('simple');
    expect(Object.keys(after['vx:c'])).toEqual(Object.keys((before as { 'vx:c': object })['vx:c']).concat('mode').sort((a, b) => order(a) - order(b)));
  });

  it('reports must details: message, error-app-tag, expression and where it is defined', () => {
    const [issue] = validate(decodeJson(vx, json('must')));
    expect(issue).toMatchObject({
      code: 'must-violation',
      message: 'ratio is a percentage',
      path: '/vx:c/ratio',
      severity: 'error',
      appTag: 'too-big',
      expression: '. <= 100',
      location: { source: 'm0.yang', line: 9 },
    });
    expect(validate(decodeJson(vx, json('list-must')))[0]).toMatchObject({ appTag: 'must-violation', message: 'value too large' });
  });

  it('reports what RFC 7950 §15 asks for unique and missing choices', () => {
    expect(validate(decodeJson(vx, json('unique')))).toEqual([
      expect.objectContaining({ code: 'not-unique', appTag: 'data-not-unique', nonUnique: ["/vx:c/item[name='a']/value", "/vx:c/item[name='a']/sub/x", "/vx:c/item[name='b']/value", "/vx:c/item[name='b']/sub/x"] }),
    ]);
    expect(validate(decodeJson(vx, json('choice')))).toEqual([expect.objectContaining({ code: 'missing-choice', appTag: 'missing-choice', missingChoice: 'how', path: '/vx:c' })]);
    expect(validate(decodeJson(vx, json('leafref')))[0]).toMatchObject({ code: 'missing-instance', appTag: 'instance-required' });
  });

  it('reports semantic constraints in <operational> as warnings (RFC 8342 §5.3)', () => {
    const operational = vx.forDatastore('operational');
    expect(validate(decodeJson(operational, json('must'))).map((i) => i.severity)).toEqual(['warning']);
    expect(validate(decodeJson(operational, json('must')), { semantics: 'error' }).map((i) => i.severity)).toEqual(['error']);
    // Data from two cases breaks the tree's structure, which no datastore may.
    expect(validate(decodeJson(operational, json('two-cases'))).map((i) => [i.code, i.severity])).toEqual([['multiple-cases', 'error']]);
    // Running is a configuration datastore: errors.
    expect(validate(decodeJson(vx.forDatastore('running'), json('config')))).toEqual([]);
  });

  it('skips completeness checks for partial data (RFC 9195)', () => {
    for (const name of ['mandatory-np', 'choice', 'min-elements', 'leafref', 'iid']) expect(validate(decodeJson(vx, json(name)), { partial: true }), name).toEqual([]);
    expect(codes(validate(decodeJson(vx, json('must')), { partial: true }))).toEqual([['must-violation', '/vx:c/ratio']]);
  });

  it('throws only for errors with assertValid', () => {
    expect(() => assertValid(decodeJson(vx, json('valid')))).not.toThrow();
    expect(() => assertValid(decodeJson(vx.forDatastore('operational'), json('must')))).not.toThrow();
    let error: unknown;
    try {
      assertValid(decodeJson(vx, json('must')));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(YangDataError);
    expect((error as YangDataError).issues).toHaveLength(1);
  });
});

describe('validate(): when', () => {
  let schema: Schema;
  beforeAll(async () => {
    schema = await compile([
      mod(
        'w',
        `container c {
  leaf on { type boolean; }
  leaf m { when "../on = 'true'"; type string; mandatory true; }
  choice ch {
    case a { when "on = 'true'"; leaf a1 { type string; } leaf a2 { type string; mandatory true; } }
    case b { leaf b1 { type string; } }
  }
  uses g { when "on = 'true'"; }
  list l { key k; leaf k { type string; } leaf v { when "../../on = 'true'"; type string; } }
}
grouping g { leaf-list gl { type string; min-elements 1; } }`,
      ),
    ]);
    expect(schema.errors).toEqual([]);
  });
  const run = (c: object): string[][] => codes(validate(decodeJson(schema, { 'w:c': c })));

  it('requires mandatory nodes only where their when holds, evaluating their own with a stand-in', () => {
    expect(run({ on: false })).toEqual([]);
    expect(run({ on: true, gl: ['x'] })).toEqual([['missing-mandatory', '/w:c/m']]);
    expect(run({ on: true, m: 'm' })).toEqual([['too-few-elements', '/w:c/gl']]);
  });

  it('reports present nodes whose when is false, including through cases and uses', () => {
    expect(run({ on: false, m: 'm' })).toEqual([['when-false', '/w:c/m']]);
    expect(run({ on: false, a1: 'x', a2: 'y' })).toEqual([
      ['when-false', '/w:c/a1'],
      ['when-false', '/w:c/a2'],
    ]);
    expect(run({ on: false, gl: ['x'] })).toEqual([["when-false", "/w:c/gl[.='x']"]]);
    expect(run({ on: false, l: [{ k: '1', v: 'x' }] })).toEqual([["when-false", "/w:c/l[k='1']/v"]]);
  });

  it('checks the mandatory nodes of the active case only', () => {
    expect(run({ on: true, m: 'm', gl: ['x'], a1: 'x' })).toEqual([['missing-mandatory', '/w:c/a2']]);
    expect(run({ on: true, m: 'm', gl: ['x'], b1: 'x' })).toEqual([]);
  });
});

describe('validate(): operations against datastore data', () => {
  let schema: Schema;
  beforeAll(async () => {
    schema = await compile([
      mod(
        's',
        `container srv {
  list server {
    key name;
    leaf name { type string; }
    leaf enabled { type boolean; default true; }
    action restart {
      input { leaf delay { type uint8; must "../../enabled = 'true'"; } }
    }
    notification restarted { leaf by { type leafref { path "/s:srv/s:server/s:name"; } } }
  }
}`,
      ),
    ]);
  });
  const data = (enabled: boolean): ReturnType<typeof decodeJson> => decodeJson(schema, { 's:srv': { server: [{ name: 'a', enabled }, { name: 'b' }] } });
  const action = (name: string): ReturnType<typeof decodeJson> => decodeJson(schema, { 's:srv': { server: [{ name, restart: { delay: 1 } }] } }, { type: 'rpc' });

  it("sees the action's parent in the datastore data", () => {
    expect(validate(action('a'), { operational: data(true) })).toEqual([]);
    expect(codes(validate(action('a'), { operational: data(false) }))).toEqual([['must-violation', "/s:srv/server[name='a']/restart/delay"]]);
    // The default of enabled applies in the datastore data too.
    expect(validate(action('b'), { operational: data(false) })).toEqual([]);
  });

  it('needs the parent to exist there', () => {
    expect(codes(validate(action('zz'), { operational: data(true) }))).toContainEqual(['missing-parent', "/s:srv/server[name='zz']"]);
  });

  it('checks nested notifications the same way', () => {
    const notif = (by: string): ReturnType<typeof decodeJson> => decodeJson(schema, { 's:srv': { server: [{ name: 'a', restarted: { by } }] } }, { type: 'notification' });
    expect(validate(notif('b'), { operational: data(true) })).toEqual([]);
    expect(codes(validate(notif('c'), { operational: data(true) }))).toEqual([['missing-instance', "/s:srv/server[name='a']/restarted/by"]]);
  });
});

describe('validate(): structures (RFC 8791)', () => {
  it('make the structure the document, for absolute paths', async () => {
    const schema = await compile([
      mod(
        'book',
        `sx:structure address-book {
    leaf owner { type string; mandatory true; }
    list address {
      key name;
      leaf name { type string; }
      leaf friend { type leafref { path "/book:address/book:name"; } }
      must "count(/book:address) < 3";
    }
  }`,
        '  import ietf-yang-structure-ext { prefix sx; }',
      ),
    ]);
    expect(schema.errors).toEqual([]);
    const read = (v: object): ReturnType<typeof decodeJson> => decodeJson(schema, { 'book:address-book': v }, { type: 'structure' });
    expect(validate(read({ owner: 'o', address: [{ name: 'a', friend: 'b' }, { name: 'b' }] }))).toEqual([]);
    expect(codes(validate(read({ address: [{ name: 'a', friend: 'c' }] })))).toEqual([
      ['missing-mandatory', '/book:address-book/owner'],
      ['missing-instance', "/book:address-book/address[name='a']/friend"],
    ]);
    expect(codes(validate(read({ owner: 'o', address: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] }))).map((c) => c[0])).toEqual(['must-violation', 'must-violation', 'must-violation']);
  });
});

describe('validate(): XPath evaluation problems', () => {
  it('reports expressions that fail to evaluate, and stops runaway ones', async () => {
    const schema = await compile([mod('x', `container c { leaf a { type string; must "re-match(., '[')"; } list l { key k; leaf k { type string; } must "count(//*[count(//*) > 0]) > 0"; } }`)]);
    const tree = decodeJson(schema, { 'x:c': { a: 'v', l: Array.from({ length: 50 }, (_, i) => ({ k: `${i}` })) } });
    const issues = validate(tree, { budget: 1000 });
    expect(issues[0]).toMatchObject({ code: 'xpath-error', path: '/x:c/a', expression: "re-match(., '[')" });
    expect(issues.slice(1).every((i) => i.code === 'xpath-error' && /stopped/.test(i.message))).toBe(true);
  });
});

/** Member order of vx:c in schema order, for comparing encodings. */
function order(name: string): number {
  return ['ratio', 'mode', 'advanced-x', 'ref', 'loose', 'val', 'iid', 'tag', 'item', 'np', 'pres', 'one-a', 'one-b', 'two-a', 'st'].indexOf(name);
}

describe('decoding with validate', () => {
  it('throws validation errors with the decoding ones, and only for a tree that decoded', () => {
    expect(() => decodeJson(vx, json('valid'), { validate: true })).not.toThrow();
    let error: unknown;
    try {
      decodeJson(vx, json('must'), { validate: true });
    } catch (e) {
      error = e;
    }
    expect((error as YangDataError).issues.map((i) => i.code)).toEqual(['must-violation']);
    // Warnings don't throw.
    expect(() => decodeJson(vx.forDatastore('operational'), json('must'), { validate: true })).not.toThrow();
    expect(() => decodeJson(vx, json('mandatory-np'), { validate: { partial: true } })).not.toThrow();
  });
});

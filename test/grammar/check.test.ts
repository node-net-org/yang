import { describe, expect, it } from 'vitest';
import { parseModule } from '../../src/index.js';
import { codes, parse } from '../support.js';

describe('a valid module', () => {
  it('has no diagnostics', () => {
    const result = parse(`
  import ietf-yang-types { prefix yang; revision-date 2013-07-15; }
  organization "Example";
  revision 2026-11-08 { description "Initial."; }
  feature f;
  identity base-id;
  identity derived { base base-id; }
  typedef percent { type uint8 { range "0..100"; } }
  grouping g { leaf name { type string; } }
  container top {
    presence "enables top";
    list item {
      key "name";
      unique "value";
      ordered-by user;
      max-elements unbounded;
      uses g;
      leaf value { type percent; default 5; }
      leaf-list tag { type string; min-elements 0; }
      choice kind { case a { leaf a { type empty; } } leaf b { type boolean; } }
      anydata extra;
      action reset { input { leaf why { type string; } } }
    }
  }
  augment "/m:top" { if-feature "f and not m:f"; leaf more { type yang:counter32; } }
  rpc go { output { anyxml result; } }
  notification event { leaf severity { type enumeration { enum low { value 1; } enum high; } } }
  deviation "/m:top/m:item" { deviate add { must "true()"; } }
  extension ext { argument name { yin-element false; } }`);
    expect(result.diagnostics).toEqual([]);
    expect(result.yangVersion).toBe('1.1');
  });
});

describe('versions', () => {
  it('defaults to YANG 1 when there is no yang-version', () => {
    expect(parseModule('module m { namespace "urn:m"; prefix m; }')).toMatchObject({ yangVersion: '1', diagnostics: [] });
  });

  it('reports YANG 1.1 statements in a YANG 1 module', () => {
    const result = parse('anydata a; container c { action x; notification n; }', '1');
    expect(result.diagnostics.map((d) => [d.code, d.message])).toEqual([
      ['requires-yang-1.1', "'anydata' in 'module' needs yang-version 1.1"],
      ['requires-yang-1.1', "'action' in 'container' needs yang-version 1.1"],
      ['requires-yang-1.1', "'notification' in 'container' needs yang-version 1.1"],
    ]);
  });

  it('applies cardinalities that differ by version', () => {
    const body = 'identity a; identity b; identity c { base a; base b; }';
    expect(codes(parse(body, '1.1'))).toEqual([]);
    expect(codes(parse(body, '1'))).toEqual(['too-many-substatements']);
  });

  it('accepts if-feature expressions only in YANG 1.1', () => {
    expect(codes(parse('feature a; feature b; leaf x { if-feature "a or (b and not a)"; type string; }', '1.1'))).toEqual([]);
    expect(parse('feature a; feature b; leaf x { if-feature "a or b"; type string; }', '1').diagnostics).toMatchObject([
      { code: 'invalid-argument', message: "if-feature: 'a or b' is not a feature name (if-feature expressions need YANG 1.1)" },
    ]);
  });

  it('requires yang-version in a YANG 1.1 submodule header too', () => {
    const result = parseModule('submodule s { yang-version 1.1; belongs-to m { prefix m; } }');
    expect(result.diagnostics).toEqual([]);
  });
});

describe('statements and substatements', () => {
  it('reports unknown statements', () => {
    expect(parse('contianer c;').diagnostics).toMatchObject([
      { code: 'unknown-statement', message: "'contianer' is not a YANG statement", location: { line: 5, column: 1 } },
    ]);
  });

  it('reports a known statement in the wrong place', () => {
    expect(parse('leaf x { type string; key x; }').diagnostics).toMatchObject([
      { code: 'unexpected-substatement', message: "'key' is not allowed in 'leaf'" },
    ]);
  });

  it('reports a missing mandatory substatement, at the parent', () => {
    expect(parse('leaf x;').diagnostics).toMatchObject([
      { code: 'missing-substatement', message: "'leaf' needs a 'type' substatement", location: { line: 5, column: 1 } },
    ]);
    expect(codes(parseModule('module m { yang-version 1.1; prefix m; }'))).toEqual(['missing-substatement']);
  });

  it('reports a repeated single substatement, at the second one', () => {
    expect(parse('leaf x {\n type string;\n type int8; }').diagnostics).toMatchObject([
      { code: 'too-many-substatements', message: "'leaf' can have only one 'type'", location: { line: 7 } },
    ]);
  });

  it('ignores the contents of extension statements', () => {
    expect(codes(parse('leaf x { type string; vendor:hint "x" { leaf nonsense; key 1; } }'))).toEqual([]);
  });
});

describe('arguments', () => {
  it.each([
    ['leaf;', 'missing-argument', "'leaf' needs an argument"],
    ['rpc r { input x; }', 'unexpected-argument', "'input' takes no argument"],
    ['leaf 1x { type string; }', 'invalid-argument', "leaf: '1x' is not a valid identifier"],
    ['leaf x { type "a b"; }', 'invalid-argument', "type: 'a b' is not a valid identifier or prefixed identifier"],
    ['revision 2026-02-30;', 'invalid-argument', "revision: '2026-02-30' is not a valid date (YYYY-MM-DD)"],
    ['leaf x { type string; config yes; }', 'invalid-argument', "config: 'yes' must be one of 'true', 'false'"],
    ['leaf x { type string; status gone; }', 'invalid-argument', "status: 'gone' must be one of 'current', 'deprecated', 'obsolete'"],
    ['list l { key k; max-elements 0; leaf k { type string; } }', 'invalid-argument', "max-elements: '0' is not a positive integer or 'unbounded'"],
    ['leaf-list l { type string; min-elements -1; }', 'invalid-argument', "min-elements: '-1' is not a non-negative integer"],
    ['leaf x { type decimal64 { fraction-digits 19; } }', 'invalid-argument', "fraction-digits: fraction-digits must be an integer from 1 to 18, not '19'"],
    ['leaf x { type enumeration { enum a { value 2147483648; } } }', 'invalid-argument', "value: '2147483648' is not a valid enum value (-2147483648 to 2147483647)"],
    ['leaf x { type bits { bit a { position -1; } } }', 'invalid-argument', "position: '-1' is not a valid bit position (0 to 4294967295)"],
    ['list l { key "a,b"; }', 'invalid-argument', "key: 'a,b' is not a list of key leaf names"],
    ['augment "m:top" { leaf x { type string; } }', 'invalid-argument', "augment: a top-level augment needs an absolute schema node identifier, not 'm:top'"],
    ['grouping g; uses g { augment "/top" { leaf x { type string; } } }', 'invalid-argument', "augment: an augment inside uses needs a descendant schema node identifier, not '/top'"],
    ['deviation "top" { deviate not-supported; }', 'invalid-argument', "deviation: 'top' is not an absolute schema node identifier"],
    ['deviation "/top" { deviate remove; }', 'invalid-argument', "deviate: 'remove' must be one of 'not-supported', 'add', 'replace', 'delete'"],
    ['leaf x { type string { pattern "a"; } if-feature "a and"; }', 'invalid-argument', "if-feature: invalid if-feature expression 'a and': expected a feature name, found end of expression"],
  ])('%s', (body, code, message) => {
    expect(parse(body).diagnostics.map((d) => [d.code, d.message])).toContainEqual([code, message]);
  });

  it('accepts multi-line key and unique lists', () => {
    expect(codes(parse('list l { key "a\n  b"; unique "c/d e"; leaf a { type string; } leaf b { type string; } }'))).toEqual([]);
  });

  it('accepts namespace URIs of any scheme', () => {
    expect(codes(parseModule('module m { yang-version 1.1; namespace "http://example.com/m"; prefix m; }'))).toEqual([]);
    expect(codes(parseModule('module m { yang-version 1.1; namespace "not a uri"; prefix m; }'))).toEqual(['invalid-argument']);
  });
});

describe('module section order', () => {
  it('reports a header statement after the body has started', () => {
    expect(parseModule('module m { yang-version 1.1; namespace "urn:m"; leaf x { type string; } prefix m; }').diagnostics).toMatchObject([
      { code: 'statement-out-of-order', message: "'prefix' belongs in the header statements, which come before the body statements" },
    ]);
  });

  it('reports a revision after the body, and an import after the meta statements', () => {
    const result = parseModule('module m { yang-version 1.1; namespace "urn:m"; prefix m; description "d"; import a { prefix a; } feature f; revision 2026-01-01; }');
    expect(result.diagnostics.map((d) => d.message)).toEqual([
      "'import' belongs in the linkage statements, which come before the meta statements",
      "'revision' belongs in the revision statements, which come before the body statements",
    ]);
  });

  it('allows header statements in any order, and extension statements anywhere', () => {
    expect(codes(parseModule('module m { prefix m; ext:x; yang-version 1.1; namespace "urn:m"; leaf x { type string; } ext:y; }'))).toEqual([]);
  });
});

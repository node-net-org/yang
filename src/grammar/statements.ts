/**
 * The YANG statement grammar as data: every core statement, the kind of
 * argument it takes, and which substatements it allows, how often.
 *
 * Source: the substatement tables in RFC 7950 §7 (YANG 1.1) and RFC 6020 §7
 * (YANG 1.0). Where the versions differ, an entry gives both. This is data,
 * not code: YANG 2.0 (draft-ietf-netmod-yang2) should only need new entries.
 */

export type YangVersion = '1' | '1.1';

/** How many times a substatement may appear. */
export type Cardinality = '0..1' | '1' | '0..n' | '1..n';

/** A cardinality that differs by version. `null` means "not allowed in that version". */
export interface VersionedCardinality {
  readonly '1': Cardinality | null;
  readonly '1.1': Cardinality;
}

export type SubstatementRule = Cardinality | VersionedCardinality;

/** The argument syntaxes of RFC 7950 §14, as far as they can be checked without compiling. */
export type ArgumentKind =
  | 'none'
  | 'string'
  | 'identifier'
  | 'identifier-ref'
  | 'yang-version'
  | 'date'
  | 'uri'
  | 'boolean'
  | 'status'
  | 'ordered-by'
  | 'deviate'
  | 'modifier'
  | 'min-elements'
  | 'max-elements'
  | 'fraction-digits'
  | 'position'
  | 'enum-value'
  | 'key'
  | 'unique'
  | 'if-feature'
  | 'absolute-schema-nodeid'
  | 'descendant-schema-nodeid'
  /** Absolute at the top level of a module, descendant inside `uses` (RFC 7950 §7.17). */
  | 'augment-target';

export interface StatementRule {
  readonly argument: ArgumentKind;
  /** The first version with this statement. Absent: every version. */
  readonly since?: YangVersion;
  readonly substatements: Readonly<Record<string, SubstatementRule>>;
}

/** Only in YANG 1.1. */
const N11: VersionedCardinality = { '1': null, '1.1': '0..n' };
const ONE11: VersionedCardinality = { '1': null, '1.1': '0..1' };

/** RFC 7950 §14 `data-def-stmt`. */
const DATA_DEF = {
  anydata: N11,
  anyxml: '0..n',
  choice: '0..n',
  container: '0..n',
  leaf: '0..n',
  'leaf-list': '0..n',
  list: '0..n',
  uses: '0..n',
} as const satisfies Record<string, SubstatementRule>;

/** `module` and `submodule` body statements other than data definitions. */
const BODY = {
  ...DATA_DEF,
  augment: '0..n',
  deviation: '0..n',
  extension: '0..n',
  feature: '0..n',
  grouping: '0..n',
  identity: '0..n',
  notification: '0..n',
  rpc: '0..n',
  typedef: '0..n',
} as const satisfies Record<string, SubstatementRule>;

const META = { contact: '0..1', description: '0..1', organization: '0..1', reference: '0..1' } as const;
const DOC = { description: '0..1', reference: '0..1' } as const;
const DOC_STATUS = { ...DOC, status: '0..1' } as const;
const ERROR_INFO = { ...DOC, 'error-app-tag': '0..1', 'error-message': '0..1' } as const;
const LEAF_OF = (argument: ArgumentKind): StatementRule => ({ argument, substatements: {} });

export const STATEMENTS: Readonly<Record<string, StatementRule>> = {
  module: {
    argument: 'identifier',
    substatements: {
      ...BODY,
      ...META,
      'yang-version': { '1': '0..1', '1.1': '1' },
      namespace: '1',
      prefix: '1',
      import: '0..n',
      include: '0..n',
      revision: '0..n',
    },
  },
  submodule: {
    argument: 'identifier',
    substatements: {
      ...BODY,
      ...META,
      'yang-version': { '1': '0..1', '1.1': '1' },
      'belongs-to': '1',
      import: '0..n',
      include: '0..n',
      revision: '0..n',
    },
  },

  // Linkage and header (RFC 7950 §7.1)
  'yang-version': LEAF_OF('yang-version'),
  namespace: LEAF_OF('uri'),
  prefix: LEAF_OF('identifier'),
  import: { argument: 'identifier', substatements: { prefix: '1', 'revision-date': '0..1', description: ONE11, reference: ONE11 } },
  include: { argument: 'identifier', substatements: { 'revision-date': '0..1', description: ONE11, reference: ONE11 } },
  'belongs-to': { argument: 'identifier', substatements: { prefix: '1' } },
  'revision-date': LEAF_OF('date'),
  revision: { argument: 'date', substatements: DOC },
  organization: LEAF_OF('string'),
  contact: LEAF_OF('string'),
  description: LEAF_OF('string'),
  reference: LEAF_OF('string'),
  units: LEAF_OF('string'),

  // Types (RFC 7950 §7.3, §9)
  typedef: { argument: 'identifier', substatements: { ...DOC_STATUS, default: '0..1', type: '1', units: '0..1' } },
  type: {
    argument: 'identifier-ref',
    substatements: {
      base: { '1': '0..1', '1.1': '0..n' },
      bit: '0..n',
      enum: '0..n',
      'fraction-digits': '0..1',
      length: '0..1',
      path: '0..1',
      pattern: '0..n',
      range: '0..1',
      'require-instance': '0..1',
      type: '0..n',
    },
  },
  length: { argument: 'string', substatements: ERROR_INFO },
  range: { argument: 'string', substatements: ERROR_INFO },
  pattern: { argument: 'string', substatements: { ...ERROR_INFO, modifier: ONE11 } },
  modifier: { argument: 'modifier', since: '1.1', substatements: {} },
  'fraction-digits': LEAF_OF('fraction-digits'),
  path: LEAF_OF('string'),
  'require-instance': LEAF_OF('boolean'),
  enum: { argument: 'string', substatements: { ...DOC_STATUS, 'if-feature': N11, value: '0..1' } },
  value: LEAF_OF('enum-value'),
  bit: { argument: 'identifier', substatements: { ...DOC_STATUS, 'if-feature': N11, position: '0..1' } },
  position: LEAF_OF('position'),
  base: LEAF_OF('identifier-ref'),

  // Data definitions (RFC 7950 §7.5–§7.11)
  container: {
    argument: 'identifier',
    substatements: {
      ...DATA_DEF,
      ...DOC_STATUS,
      action: N11,
      config: '0..1',
      grouping: '0..n',
      'if-feature': '0..n',
      must: '0..n',
      notification: N11,
      presence: '0..1',
      typedef: '0..n',
      when: '0..1',
    },
  },
  leaf: {
    argument: 'identifier',
    substatements: {
      ...DOC_STATUS,
      config: '0..1',
      default: '0..1',
      'if-feature': '0..n',
      mandatory: '0..1',
      must: '0..n',
      type: '1',
      units: '0..1',
      when: '0..1',
    },
  },
  'leaf-list': {
    argument: 'identifier',
    substatements: {
      ...DOC_STATUS,
      config: '0..1',
      default: N11,
      'if-feature': '0..n',
      'max-elements': '0..1',
      'min-elements': '0..1',
      must: '0..n',
      'ordered-by': '0..1',
      type: '1',
      units: '0..1',
      when: '0..1',
    },
  },
  list: {
    argument: 'identifier',
    substatements: {
      ...DATA_DEF,
      ...DOC_STATUS,
      action: N11,
      config: '0..1',
      grouping: '0..n',
      'if-feature': '0..n',
      key: '0..1',
      'max-elements': '0..1',
      'min-elements': '0..1',
      must: '0..n',
      notification: N11,
      'ordered-by': '0..1',
      typedef: '0..n',
      unique: '0..n',
      when: '0..1',
    },
  },
  choice: {
    argument: 'identifier',
    substatements: {
      ...DOC_STATUS,
      anydata: N11,
      anyxml: '0..n',
      case: '0..n',
      choice: N11,
      config: '0..1',
      container: '0..n',
      default: '0..1',
      'if-feature': '0..n',
      leaf: '0..n',
      'leaf-list': '0..n',
      list: '0..n',
      mandatory: '0..1',
      when: '0..1',
    },
  },
  case: {
    argument: 'identifier',
    substatements: { ...DATA_DEF, ...DOC_STATUS, 'if-feature': '0..n', when: '0..1' },
  },
  anydata: {
    argument: 'identifier',
    since: '1.1',
    substatements: { ...DOC_STATUS, config: '0..1', 'if-feature': '0..n', mandatory: '0..1', must: '0..n', when: '0..1' },
  },
  anyxml: {
    argument: 'identifier',
    substatements: { ...DOC_STATUS, config: '0..1', 'if-feature': '0..n', mandatory: '0..1', must: '0..n', when: '0..1' },
  },
  grouping: {
    argument: 'identifier',
    substatements: { ...DATA_DEF, ...DOC_STATUS, action: N11, grouping: '0..n', notification: N11, typedef: '0..n' },
  },
  uses: {
    argument: 'identifier-ref',
    substatements: { ...DOC_STATUS, augment: '0..n', 'if-feature': '0..n', refine: '0..n', when: '0..1' },
  },
  refine: {
    argument: 'descendant-schema-nodeid',
    substatements: {
      ...DOC,
      config: '0..1',
      default: { '1': '0..1', '1.1': '0..n' },
      'if-feature': N11,
      mandatory: '0..1',
      'max-elements': '0..1',
      'min-elements': '0..1',
      must: '0..n',
      presence: '0..1',
    },
  },
  augment: {
    argument: 'augment-target',
    substatements: {
      ...DATA_DEF,
      ...DOC_STATUS,
      action: N11,
      case: '0..n',
      'if-feature': '0..n',
      notification: N11,
      when: '0..1',
    },
  },
  config: LEAF_OF('boolean'),
  default: LEAF_OF('string'),
  mandatory: LEAF_OF('boolean'),
  presence: LEAF_OF('string'),
  key: LEAF_OF('key'),
  unique: LEAF_OF('unique'),
  'min-elements': LEAF_OF('min-elements'),
  'max-elements': LEAF_OF('max-elements'),
  'ordered-by': LEAF_OF('ordered-by'),
  must: { argument: 'string', substatements: ERROR_INFO },
  'error-message': LEAF_OF('string'),
  'error-app-tag': LEAF_OF('string'),
  when: { argument: 'string', substatements: DOC },

  // Operations and notifications (RFC 7950 §7.14–§7.16)
  rpc: {
    argument: 'identifier',
    substatements: { ...DOC_STATUS, grouping: '0..n', 'if-feature': '0..n', input: '0..1', output: '0..1', typedef: '0..n' },
  },
  action: {
    argument: 'identifier',
    since: '1.1',
    substatements: { ...DOC_STATUS, grouping: '0..n', 'if-feature': '0..n', input: '0..1', output: '0..1', typedef: '0..n' },
  },
  input: { argument: 'none', substatements: { ...DATA_DEF, grouping: '0..n', must: N11, typedef: '0..n' } },
  output: { argument: 'none', substatements: { ...DATA_DEF, grouping: '0..n', must: N11, typedef: '0..n' } },
  notification: {
    argument: 'identifier',
    substatements: { ...DATA_DEF, ...DOC_STATUS, grouping: '0..n', 'if-feature': '0..n', must: N11, typedef: '0..n' },
  },

  // Extensions, features, identities, deviations (RFC 7950 §7.18–§7.20)
  extension: { argument: 'identifier', substatements: { ...DOC_STATUS, argument: '0..1' } },
  argument: { argument: 'identifier', substatements: { 'yin-element': '0..1' } },
  'yin-element': LEAF_OF('boolean'),
  feature: { argument: 'identifier', substatements: { ...DOC_STATUS, 'if-feature': '0..n' } },
  'if-feature': LEAF_OF('if-feature'),
  identity: { argument: 'identifier', substatements: { ...DOC_STATUS, base: { '1': '0..1', '1.1': '0..n' }, 'if-feature': N11 } },
  deviation: { argument: 'absolute-schema-nodeid', substatements: { ...DOC, deviate: '1..n' } },
  deviate: {
    argument: 'deviate',
    substatements: {
      config: '0..1',
      default: { '1': '0..1', '1.1': '0..n' },
      mandatory: '0..1',
      'max-elements': '0..1',
      'min-elements': '0..1',
      must: '0..n',
      type: '0..1',
      unique: '0..n',
      units: '0..1',
    },
  },
  status: LEAF_OF('status'),
};

/**
 * RFC 7950 §7.1 / §7.2: the substatements of `module` and `submodule` come in
 * this order of groups: header, linkage, meta, revisions, body. Statements
 * within a group may appear in any order.
 */
export const MODULE_SECTIONS: Readonly<Record<string, number>> = {
  'yang-version': 0,
  namespace: 0,
  prefix: 0,
  'belongs-to': 0,
  import: 1,
  include: 1,
  organization: 2,
  contact: 2,
  description: 2,
  reference: 2,
  revision: 3,
};

/** The section number of any statement not listed in {@link MODULE_SECTIONS}. */
export const BODY_SECTION = 4;

export const SECTION_NAMES = ['header', 'linkage', 'meta', 'revision', 'body'] as const;

/** The cardinality of a substatement rule in one version, or `null` when it isn't allowed there. */
export function cardinalityIn(rule: SubstatementRule, version: YangVersion): Cardinality | null {
  return typeof rule === 'string' ? rule : rule[version];
}

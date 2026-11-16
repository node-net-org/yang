/**
 * Argument syntax checks (RFC 7950 §14) for the {@link ArgumentKind}s that
 * can be checked without compiling. Each check returns `undefined` when the
 * argument is valid, or a message saying what is wrong.
 *
 * Arguments whose syntax needs more context (`range`, `length`, `pattern`,
 * XPath in `must`, `when` and `path`, typed `default` values) are checked by
 * the compiler.
 */

import { parseIfFeature } from './if-feature.js';
import type { ArgumentKind, YangVersion } from './statements.js';

const IDENT = '[A-Za-z_][A-Za-z0-9_.-]*';
const NODE_ID = `(?:${IDENT}:)?${IDENT}`;
const IDENTIFIER = new RegExp(`^${IDENT}$`);
const IDENTIFIER_REF = new RegExp(`^${NODE_ID}$`);
const ABSOLUTE = new RegExp(`^(?:/${NODE_ID})+$`);
const DESCENDANT = new RegExp(`^${NODE_ID}(?:/${NODE_ID})*$`);
const SEP_LIST = (item: string): RegExp => new RegExp(`^${item}(?:[ \\t\\r\\n]+${item})*$`);
const KEY = SEP_LIST(NODE_ID);
const UNIQUE = SEP_LIST(`${NODE_ID}(?:/${NODE_ID})*`);
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NON_NEGATIVE = /^(?:0|[1-9][0-9]*)$/;
const INTEGER = /^-?(?:0|[1-9][0-9]*)$/;
const URI = /^[A-Za-z][A-Za-z0-9+.-]*:\S+$/;

export interface ArgumentContext {
  readonly version: YangVersion;
  /** The keyword of the parent statement, for arguments whose syntax depends on it. */
  readonly parentKeyword: string | undefined;
}

export function checkArgument(kind: ArgumentKind, value: string, context: ArgumentContext): string | undefined {
  switch (kind) {
    case 'none':
    case 'string':
      return undefined;
    case 'identifier':
      return IDENTIFIER.test(value) ? undefined : `'${value}' is not a valid identifier`;
    case 'identifier-ref':
      return IDENTIFIER_REF.test(value) ? undefined : `'${value}' is not a valid identifier or prefixed identifier`;
    case 'yang-version':
      return value === '1' || value === '1.1' ? undefined : `yang-version must be '1' or '1.1', not '${value}'`;
    case 'date':
      return checkDate(value);
    case 'uri':
      return URI.test(value) ? undefined : `'${value}' is not a URI`;
    case 'boolean':
      return oneOf(value, ['true', 'false']);
    case 'status':
      return oneOf(value, ['current', 'deprecated', 'obsolete']);
    case 'ordered-by':
      return oneOf(value, ['system', 'user']);
    case 'deviate':
      return oneOf(value, ['not-supported', 'add', 'replace', 'delete']);
    case 'modifier':
      return oneOf(value, ['invert-match']);
    case 'min-elements':
      return NON_NEGATIVE.test(value) ? undefined : `'${value}' is not a non-negative integer`;
    case 'max-elements':
      return value === 'unbounded' || (NON_NEGATIVE.test(value) && value !== '0')
        ? undefined
        : `'${value}' is not a positive integer or 'unbounded'`;
    case 'fraction-digits':
      return NON_NEGATIVE.test(value) && Number(value) >= 1 && Number(value) <= 18
        ? undefined
        : `fraction-digits must be an integer from 1 to 18, not '${value}'`;
    case 'position':
      return NON_NEGATIVE.test(value) && Number(value) <= 4294967295
        ? undefined
        : `'${value}' is not a valid bit position (0 to 4294967295)`;
    case 'enum-value':
      return INTEGER.test(value) && Number(value) >= -2147483648 && Number(value) <= 2147483647
        ? undefined
        : `'${value}' is not a valid enum value (-2147483648 to 2147483647)`;
    case 'key':
      return KEY.test(value) ? undefined : `'${value}' is not a list of key leaf names`;
    case 'unique':
      return UNIQUE.test(value) ? undefined : `'${value}' is not a list of descendant schema node identifiers`;
    case 'if-feature':
      return checkIfFeature(value, context.version);
    case 'absolute-schema-nodeid':
      return ABSOLUTE.test(value) ? undefined : `'${value}' is not an absolute schema node identifier`;
    case 'descendant-schema-nodeid':
      return DESCENDANT.test(value) ? undefined : `'${value}' is not a descendant schema node identifier`;
    case 'augment-target':
      return context.parentKeyword === 'uses'
        ? DESCENDANT.test(value)
          ? undefined
          : `an augment inside uses needs a descendant schema node identifier, not '${value}'`
        : ABSOLUTE.test(value)
          ? undefined
          : `a top-level augment needs an absolute schema node identifier, not '${value}'`;
  }
}

function oneOf(value: string, allowed: readonly string[]): string | undefined {
  return allowed.includes(value) ? undefined : `'${value}' must be one of ${allowed.map((a) => `'${a}'`).join(', ')}`;
}

function checkDate(value: string): string | undefined {
  const match = DATE.exec(value);
  if (match !== null) {
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (month >= 1 && month <= 12 && day >= 1 && day <= days) return undefined;
  }
  return `'${value}' is not a valid date (YYYY-MM-DD)`;
}

function checkIfFeature(value: string, version: YangVersion): string | undefined {
  if (version === '1') {
    return IDENTIFIER_REF.test(value) ? undefined : `'${value}' is not a feature name (if-feature expressions need YANG 1.1)`;
  }
  const result = parseIfFeature(value);
  return typeof result === 'string' ? `invalid if-feature expression '${value}': ${result}` : undefined;
}

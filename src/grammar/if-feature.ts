/**
 * `if-feature` expressions (RFC 7950 §7.20.2, §14):
 *
 *   if-feature-expr   = if-feature-term [sep "or" sep if-feature-expr]
 *   if-feature-term   = if-feature-factor [sep "and" sep if-feature-term]
 *   if-feature-factor = "not" sep if-feature-factor
 *                     / "(" optsep if-feature-expr optsep ")"
 *                     / identifier-ref-arg
 *
 * `not` binds tightest, then `and`, then `or`. YANG 1.0 allows only a single
 * feature name.
 */

export type IfFeatureExpression =
  | { readonly kind: 'feature'; readonly prefix?: string; readonly name: string }
  | { readonly kind: 'not'; readonly operand: IfFeatureExpression }
  | { readonly kind: 'and' | 'or'; readonly left: IfFeatureExpression; readonly right: IfFeatureExpression };

const IDENTIFIER_REF = /^(?:([A-Za-z_][A-Za-z0-9_.-]*):)?([A-Za-z_][A-Za-z0-9_.-]*)$/;

/**
 * Parses an `if-feature` argument. Returns the expression tree, or a string
 * describing the syntax error.
 */
export function parseIfFeature(text: string): IfFeatureExpression | string {
  const tokens = text.match(/\(|\)|[^\s()]+/g) ?? [];
  let pos = 0;

  const expr = (): IfFeatureExpression | string => {
    const left = term();
    if (typeof left === 'string') return left;
    if (tokens[pos] !== 'or') return left;
    pos++;
    const right = expr();
    return typeof right === 'string' ? right : { kind: 'or', left, right };
  };
  const term = (): IfFeatureExpression | string => {
    const left = factor();
    if (typeof left === 'string') return left;
    if (tokens[pos] !== 'and') return left;
    pos++;
    const right = term();
    return typeof right === 'string' ? right : { kind: 'and', left, right };
  };
  const factor = (): IfFeatureExpression | string => {
    const token = tokens[pos++];
    if (token === undefined) return 'expected a feature name, found end of expression';
    if (token === 'not') {
      const operand = factor();
      return typeof operand === 'string' ? operand : { kind: 'not', operand };
    }
    if (token === '(') {
      const inner = expr();
      if (typeof inner === 'string') return inner;
      if (tokens[pos++] !== ')') return "missing ')'";
      return inner;
    }
    if (token === 'and' || token === 'or' || token === ')') return `expected a feature name, found '${token}'`;
    const match = IDENTIFIER_REF.exec(token);
    if (match === null) return `'${token}' is not a valid feature name`;
    return match[1] === undefined ? { kind: 'feature', name: match[2]! } : { kind: 'feature', prefix: match[1], name: match[2]! };
  };

  const result = expr();
  if (typeof result === 'string') return result;
  if (pos < tokens.length) return `unexpected '${tokens[pos]}'`;
  return result;
}

import { describe, expect, it } from 'vitest';
import { parseIfFeature, type IfFeatureExpression } from '../../src/index.js';

/** Renders an expression fully parenthesised, to make precedence visible. */
function show(e: IfFeatureExpression | string): string {
  if (typeof e === 'string') return `error: ${e}`;
  switch (e.kind) {
    case 'feature':
      return e.prefix === undefined ? e.name : `${e.prefix}:${e.name}`;
    case 'not':
      return `!${show(e.operand)}`;
    case 'and':
    case 'or':
      return `(${show(e.left)} ${e.kind} ${show(e.right)})`;
  }
}

describe('parseIfFeature', () => {
  it.each([
    ['a', 'a'],
    ['p:a', 'p:a'],
    ['not a', '!a'],
    ['not not a', '!!a'],
    ['a and b', '(a and b)'],
    ['a or b and c', '(a or (b and c))'],
    ['a and b or c', '((a and b) or c)'],
    ['not a and b', '(!a and b)'],
    ['not (a or b)', '!(a or b)'],
    ['( a )', 'a'],
    ['(a or b) and c', '((a or b) and c)'],
    ['a or b or c', '(a or (b or c))'],
    ['a\n  and\tb', '(a and b)'],
  ])('%j → %s', (text, expected) => {
    expect(show(parseIfFeature(text))).toBe(expected);
  });

  it.each([
    ['', 'expected a feature name, found end of expression'],
    ['a and', 'expected a feature name, found end of expression'],
    ['and a', "expected a feature name, found 'and'"],
    ['(a', "missing ')'"],
    ['a)', "unexpected ')'"],
    ['a b', "unexpected 'b'"],
    ['a:b:c', "'a:b:c' is not a valid feature name"],
    ['not', 'expected a feature name, found end of expression'],
  ])('%j is an error', (text, message) => {
    expect(parseIfFeature(text)).toBe(message);
  });
});

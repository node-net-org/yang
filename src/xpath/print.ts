/**
 * Writes an XPath syntax tree back as text that parses to the same tree,
 * with the parentheses precedence needs and no others.
 */

import type { Expr, NodeTest, Step } from './ast.js';
import { xpathLiteral } from './literal.js';

const PRECEDENCE: Record<string, number> = { or: 1, and: 2, '=': 3, '!=': 3, '<': 4, '>': 4, '<=': 4, '>=': 4, '+': 5, '-': 5, '*': 6, div: 6, mod: 6, '|': 8 };
const UNARY = 7;
const PATH = 9;
const PRIMARY = 10;

/** The text of an expression. Iterates over operator chains, so long ones don't deepen the stack. */
export function printXPath(expr: Expr): string {
  return print(expr, 0);
}

function print(e: Expr, context: number): string {
  switch (e.type) {
    case 'binary': {
      const p = PRECEDENCE[e.op]!;
      // Walk down the left spine iteratively.
      const rights: string[] = [];
      let left: Expr = e;
      while (left.type === 'binary' && PRECEDENCE[left.op] === p) {
        rights.push(`${left.op === '|' ? '|' : ` ${left.op} `}${print(left.right, p + 1)}`);
        left = left.left;
      }
      const s = print(left, p) + rights.reverse().join('');
      return p < context ? `(${s})` : s;
    }
    case 'negate': {
      const s = `-${print(e.operand, UNARY)}`;
      return UNARY < context ? `(${s})` : s;
    }
    case 'literal':
      return xpathLiteral(e.value);
    case 'number':
      return numberText(e.value);
    case 'variable':
      return `$${e.prefix === undefined ? '' : `${e.prefix}:`}${e.name}`;
    case 'call':
      return `${e.prefix === undefined ? '' : `${e.prefix}:`}${e.name}(${e.args.map((a) => print(a, 0)).join(', ')})`;
    case 'filter':
      return `${print(e.primary, PRIMARY)}${e.predicates.map(predicate).join('')}`;
    case 'path': {
      const steps = e.steps.map(step).join('/');
      let s: string;
      if (e.start === 'root') s = steps === '' ? '(/)' : `/${steps}`;
      else if (e.start === 'context') s = steps;
      else s = `${print(e.start, PRIMARY)}/${steps}`;
      return PATH < context ? `(${s})` : s;
    }
  }
}

function predicate(p: Expr): string {
  return `[${print(p, 0)}]`;
}

function step(s: Step): string {
  if (s.predicates.length === 0 && s.test.kind === 'node') {
    if (s.axis === 'self') return '.';
    if (s.axis === 'parent') return '..';
  }
  const axis = s.axis === 'child' ? '' : s.axis === 'attribute' ? '@' : `${s.axis}::`;
  return `${axis}${test(s.test)}${s.predicates.map(predicate).join('')}`;
}

function test(t: NodeTest): string {
  switch (t.kind) {
    case 'name':
      return `${t.prefix === undefined ? '' : `${t.prefix}:`}${t.name}`;
    case 'any':
      return t.prefix === undefined ? '*' : `${t.prefix}:*`;
    case 'processing-instruction':
      return t.target === undefined ? 'processing-instruction()' : `processing-instruction('${t.target}')`;
    default:
      return `${t.kind}()`;
  }
}

/** A number as an XPath Number token: digits, optionally a point and more digits, never an exponent. */
function numberText(n: number): string {
  if (Number.isNaN(n)) return '(0 div 0)';
  if (n === Infinity) return '(1 div 0)';
  const s = String(n);
  if (!s.includes('e')) return s;
  // Large or tiny: write it out in full.
  return n >= 1 ? BigInt(Math.round(n)).toString() : n.toFixed(20).replace(/0+$/, '');
}

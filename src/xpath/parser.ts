/**
 * XPath 1.0 lexer and parser (W3C XPath 1.0 §3, with the lexical rules of
 * §3.7). The grammar is parsed by recursive descent, with operator chains
 * read in loops; nesting deeper than {@link MAX_XPATH_DEPTH} is refused so
 * that neither parsing nor evaluation can exhaust the stack.
 */

import { XPathError } from '../errors.js';
import { AXES, type Axis, type BinaryOperator, type Expr, type NodeTest, type Step } from './ast.js';

/** How deeply expressions may nest: parentheses, predicates, arguments and operator chains together. */
export const MAX_XPATH_DEPTH = 128;
/** The longest expression text accepted. */
export const MAX_XPATH_LENGTH = 1 << 20;

type Token =
  | { kind: '(' | ')' | '[' | ']' | '.' | '..' | '@' | ',' | '::' | 'eof'; pos: number }
  | { kind: 'name'; prefix: string | undefined; name: string; pos: number }
  | { kind: 'any'; prefix: string | undefined; pos: number }
  | { kind: 'node-type'; name: 'comment' | 'text' | 'processing-instruction' | 'node'; pos: number }
  | { kind: 'operator'; op: BinaryOperator | '/' | '//'; pos: number }
  | { kind: 'function'; prefix: string | undefined; name: string; pos: number }
  | { kind: 'axis'; name: Axis; pos: number }
  | { kind: 'literal'; value: string; pos: number }
  | { kind: 'number'; value: number; pos: number }
  | { kind: 'variable'; prefix: string | undefined; name: string; pos: number };

const NCNAME = /[\p{L}_][\p{L}\p{N}\p{M}_.\-·‿⁀]*/uy;
const NUMBER = /[0-9]+(?:\.[0-9]*)?|\.[0-9]+/y;
const SPACE = /[ \t\r\n]*/y;
const NODE_TYPES = new Set(['comment', 'text', 'processing-instruction', 'node']);
const OPERATOR_NAMES = new Set(['and', 'or', 'mod', 'div']);

/** Splits an expression into tokens. */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  const fail = (message: string, at = pos): never => {
    throw new XPathError(message, text, at);
  };
  const skip = (): void => {
    SPACE.lastIndex = pos;
    SPACE.exec(text);
    pos = SPACE.lastIndex;
  };
  const ncname = (): string | undefined => {
    NCNAME.lastIndex = pos;
    const m = NCNAME.exec(text);
    if (m === null) return undefined;
    pos = NCNAME.lastIndex;
    return m[0];
  };
  /** §3.7: after these, `*` and names are operands; after anything else, operators. */
  const operandExpected = (): boolean => {
    const last = tokens[tokens.length - 1];
    if (last === undefined) return true;
    return last.kind === '@' || last.kind === '::' || last.kind === '(' || last.kind === '[' || last.kind === ',' || last.kind === 'operator';
  };
  /** The next non-space character from `at`. */
  const peekChar = (at: number): string | undefined => {
    SPACE.lastIndex = at;
    SPACE.exec(text);
    return text[SPACE.lastIndex];
  };

  for (;;) {
    skip();
    if (pos >= text.length) break;
    const start = pos;
    const c = text[pos]!;
    const two = text.slice(pos, pos + 2);
    if (c === '(' || c === ')' || c === '[' || c === ']' || c === '@' || c === ',') {
      pos++;
      tokens.push({ kind: c, pos: start });
    } else if (two === '::') {
      pos += 2;
      tokens.push({ kind: '::', pos: start });
    } else if (two === '..') {
      pos += 2;
      tokens.push({ kind: '..', pos: start });
    } else if (c === '.' && !/[0-9]/.test(text[pos + 1] ?? '')) {
      pos++;
      tokens.push({ kind: '.', pos: start });
    } else if (c === '"' || c === "'") {
      const end = text.indexOf(c, pos + 1);
      if (end === -1) fail('unterminated string literal');
      tokens.push({ kind: 'literal', value: text.slice(pos + 1, end), pos: start });
      pos = end + 1;
    } else if (/[0-9.]/.test(c)) {
      NUMBER.lastIndex = pos;
      const m = NUMBER.exec(text)!;
      pos = NUMBER.lastIndex;
      tokens.push({ kind: 'number', value: Number(m[0]), pos: start });
    } else if (two === '//') {
      pos += 2;
      tokens.push({ kind: 'operator', op: '//', pos: start });
    } else if (two === '!=' || two === '<=' || two === '>=') {
      pos += 2;
      tokens.push({ kind: 'operator', op: two, pos: start });
    } else if (c === '/' || c === '|' || c === '+' || c === '-' || c === '=' || c === '<' || c === '>') {
      pos++;
      tokens.push({ kind: 'operator', op: c, pos: start });
    } else if (c === '*') {
      pos++;
      if (operandExpected()) tokens.push({ kind: 'any', prefix: undefined, pos: start });
      else tokens.push({ kind: 'operator', op: '*', pos: start });
    } else if (c === '$') {
      pos++;
      const first = ncname() ?? fail("a variable name is missing after '$'");
      if (text[pos] === ':' && text[pos + 1] !== ':') {
        pos++;
        const second = ncname() ?? fail('a name is missing after the prefix');
        tokens.push({ kind: 'variable', prefix: first, name: second, pos: start });
      } else tokens.push({ kind: 'variable', prefix: undefined, name: first, pos: start });
    } else {
      const first = ncname();
      if (first === undefined) fail(`unexpected character '${c}'`);
      const name = first!;
      if (!operandExpected()) {
        if (!OPERATOR_NAMES.has(name)) fail(`'${name}' is not an operator; an operator is expected here`, start);
        tokens.push({ kind: 'operator', op: name as BinaryOperator, pos: start });
        continue;
      }
      let prefix: string | undefined;
      let local = name;
      if (text[pos] === ':' && text[pos + 1] !== ':') {
        pos++;
        if (text[pos] === '*') {
          pos++;
          tokens.push({ kind: 'any', prefix: name, pos: start });
          continue;
        }
        prefix = name;
        local = ncname() ?? fail(`a name is missing after '${name}:'`);
      }
      const next = peekChar(pos);
      if (prefix === undefined && text.startsWith('::', SPACE.lastIndex)) {
        if (!AXES.has(name)) fail(`'${name}' is not an axis name`, start);
        tokens.push({ kind: 'axis', name: name as Axis, pos: start });
      } else if (next === '(') {
        if (prefix === undefined && NODE_TYPES.has(local)) tokens.push({ kind: 'node-type', name: local as 'node', pos: start });
        else tokens.push({ kind: 'function', prefix, name: local, pos: start });
      } else tokens.push({ kind: 'name', prefix, name: local, pos: start });
    }
  }
  tokens.push({ kind: 'eof', pos: text.length });
  return tokens;
}

/** Binary operator precedence, loosest first (XPath §3.4, §3.5). Union binds tighter than unary minus and is read separately. */
const LEVEL: Partial<Record<string, number>> = { or: 1, and: 2, '=': 3, '!=': 3, '<': 4, '>': 4, '<=': 4, '>=': 4, '+': 5, '-': 5, '*': 6, div: 6, mod: 6 };
const MULTIPLICATIVE_LEVEL = 6;

/** Where each name test (`name`, `prefix:name`, `prefix:*`, `*`) starts in the text it was parsed from. */
const NAME_OFFSETS = new WeakMap<NodeTest, number>();

/**
 * The offset in the expression text at which a name test parsed by
 * {@link parseXPath} starts: its prefix, if it has one, or its name. Undefined
 * for node tests that aren't name tests, or weren't parsed.
 */
export function nameTestOffset(test: NodeTest): number | undefined {
  return NAME_OFFSETS.get(test);
}

class Parser {
  #i = 0;
  #depth = 0;
  constructor(
    private readonly text: string,
    private readonly tokens: Token[],
  ) {}

  #peek(): Token {
    return this.tokens[this.#i]!;
  }
  #next(): Token {
    return this.tokens[this.#i++]!;
  }
  #fail(message: string, token = this.#peek()): never {
    throw new XPathError(message, this.text, token.pos);
  }
  #describe(t: Token): string {
    if (t.kind === 'eof') return 'the end of the expression';
    return `'${this.text.slice(t.pos, this.tokens[this.tokens.indexOf(t) + 1]?.pos ?? this.text.length).trim()}'`;
  }
  #expect(kind: Token['kind']): Token {
    const t = this.#peek();
    if (t.kind !== kind) this.#fail(`expected '${kind}', found ${this.#describe(t)}`);
    return this.#next();
  }
  #isOp(op: string): boolean {
    const t = this.#peek();
    return t.kind === 'operator' && t.op === op;
  }
  #enter(): void {
    if (++this.#depth > MAX_XPATH_DEPTH) this.#fail(`the expression nests more than ${MAX_XPATH_DEPTH} levels deep`);
  }
  #leave(): void {
    this.#depth--;
  }

  parse(): Expr {
    const e = this.#expr();
    const t = this.#peek();
    if (t.kind !== 'eof') this.#fail(`unexpected ${this.#describe(t)}`);
    return e;
  }

  #expr(): Expr {
    this.#enter();
    const e = this.#binary(1);
    this.#leave();
    return e;
  }

  /**
   * Operators of precedence `min` and above, by precedence climbing: chains
   * of one precedence are read in a loop, left-associative.
   */
  #binary(min: number): Expr {
    let left = min > MULTIPLICATIVE_LEVEL ? this.#unary() : this.#binary(min + 1);
    if (min > MULTIPLICATIVE_LEVEL) return left;
    let links = 0;
    for (;;) {
      const t = this.#peek();
      if (t.kind !== 'operator' || LEVEL[t.op] !== min) return left;
      this.#next();
      if (++links + this.#depth > MAX_XPATH_DEPTH) this.#fail(`the expression nests more than ${MAX_XPATH_DEPTH} levels deep`, t);
      left = { type: 'binary', op: t.op as BinaryOperator, left, right: this.#binary(min + 1) };
    }
  }

  /** A left-associative chain of operators of one precedence. */
  #chain(op: string, operand: () => Expr): Expr {
    let left = operand();
    let links = 0;
    for (;;) {
      const t = this.#peek();
      if (t.kind !== 'operator' || t.op !== op) break;
      this.#next();
      if (++links + this.#depth > MAX_XPATH_DEPTH) this.#fail(`the expression nests more than ${MAX_XPATH_DEPTH} levels deep`, t);
      left = { type: 'binary', op: t.op as BinaryOperator, left, right: operand() };
    }
    return left;
  }

  #unary(): Expr {
    if (this.#isOp('-')) {
      let count = 0;
      while (this.#isOp('-')) {
        this.#next();
        count++;
      }
      if (count + this.#depth > MAX_XPATH_DEPTH) this.#fail(`the expression nests more than ${MAX_XPATH_DEPTH} levels deep`);
      let e = this.#union();
      for (let i = 0; i < count; i++) e = { type: 'negate', operand: e };
      return e;
    }
    return this.#union();
  }

  #union(): Expr {
    return this.#chain('|', () => this.#pathExpr());
  }

  #pathExpr(): Expr {
    const t = this.#peek();
    const startsFilter = t.kind === '(' || t.kind === 'literal' || t.kind === 'number' || t.kind === 'variable' || t.kind === 'function';
    if (!startsFilter) return this.#locationPath();
    const primary = this.#primary();
    const predicates = this.#predicates();
    const filter: Expr = predicates.length === 0 ? primary : { type: 'filter', primary, predicates };
    if (this.#isOp('/') || this.#isOp('//')) {
      const steps: Step[] = [];
      this.#relativeSteps(steps, true);
      return { type: 'path', start: filter, steps };
    }
    return filter;
  }

  #primary(): Expr {
    const t = this.#next();
    switch (t.kind) {
      case '(': {
        const e = this.#expr();
        this.#expect(')');
        return e;
      }
      case 'literal':
        return { type: 'literal', value: t.value };
      case 'number':
        return { type: 'number', value: t.value };
      case 'variable':
        return t.prefix === undefined ? { type: 'variable', name: t.name } : { type: 'variable', prefix: t.prefix, name: t.name };
      case 'function': {
        this.#expect('(');
        this.#enter();
        const args: Expr[] = [];
        if (this.#peek().kind !== ')') {
          args.push(this.#expr());
          while (this.#peek().kind === ',') {
            this.#next();
            args.push(this.#expr());
          }
        }
        this.#expect(')');
        this.#leave();
        return t.prefix === undefined ? { type: 'call', name: t.name, args } : { type: 'call', prefix: t.prefix, name: t.name, args };
      }
      default:
        return this.#fail(`unexpected ${this.#describe(t)}`, t);
    }
  }

  #predicates(): Expr[] {
    const out: Expr[] = [];
    while (this.#peek().kind === '[') {
      this.#next();
      this.#enter();
      out.push(this.#expr());
      this.#leave();
      this.#expect(']');
    }
    return out;
  }

  #locationPath(): Expr {
    const steps: Step[] = [];
    if (this.#isOp('/')) {
      this.#next();
      if (this.#startsStep()) this.#relativeSteps(steps, false);
      return { type: 'path', start: 'root', steps };
    }
    if (this.#isOp('//')) {
      this.#relativeSteps(steps, true);
      return { type: 'path', start: 'root', steps };
    }
    if (!this.#startsStep()) this.#fail(`unexpected ${this.#describe(this.#peek())}`);
    this.#relativeSteps(steps, false);
    return { type: 'path', start: 'context', steps };
  }

  #startsStep(): boolean {
    const k = this.#peek().kind;
    return k === 'name' || k === 'any' || k === '.' || k === '..' || k === '@' || k === 'axis' || k === 'node-type';
  }

  /**
   * Steps separated by `/` or `//`. With `leadingSeparator`, the first step
   * is preceded by one (the current token).
   */
  #relativeSteps(steps: Step[], leadingSeparator: boolean): void {
    let separator = leadingSeparator;
    for (;;) {
      if (separator) {
        const t = this.#next();
        if (t.kind === 'operator' && t.op === '//') steps.push({ axis: 'descendant-or-self', test: { kind: 'node' }, predicates: [] });
      }
      steps.push(this.#step());
      if (!(this.#isOp('/') || this.#isOp('//'))) return;
      separator = true;
    }
  }

  #step(): Step {
    const t = this.#peek();
    if (t.kind === '.') {
      this.#next();
      return { axis: 'self', test: { kind: 'node' }, predicates: [] };
    }
    if (t.kind === '..') {
      this.#next();
      return { axis: 'parent', test: { kind: 'node' }, predicates: [] };
    }
    let axis: Axis = 'child';
    if (t.kind === '@') {
      this.#next();
      axis = 'attribute';
    } else if (t.kind === 'axis') {
      this.#next();
      this.#expect('::');
      axis = t.name;
    }
    const test = this.#nodeTest();
    return { axis, test, predicates: this.#predicates() };
  }

  #nodeTest(): NodeTest {
    const t = this.#next();
    if (t.kind === 'name' || t.kind === 'any') {
      let test: NodeTest;
      if (t.kind === 'name') test = t.prefix === undefined ? { kind: 'name', name: t.name } : { kind: 'name', prefix: t.prefix, name: t.name };
      else test = t.prefix === undefined ? { kind: 'any' } : { kind: 'any', prefix: t.prefix };
      NAME_OFFSETS.set(test, t.pos);
      return test;
    }
    if (t.kind === 'node-type') {
      this.#expect('(');
      let target: string | undefined;
      if (t.name === 'processing-instruction' && this.#peek().kind === 'literal') {
        const lit = this.#next();
        target = lit.kind === 'literal' ? lit.value : undefined;
      }
      this.#expect(')');
      if (t.name === 'processing-instruction') return target === undefined ? { kind: 'processing-instruction' } : { kind: 'processing-instruction', target };
      return { kind: t.name };
    }
    return this.#fail(`expected a node test, found ${this.#describe(t)}`, t);
  }
}

/** Parses an XPath 1.0 expression. Throws {@link XPathError} with the offset of the problem. */
export function parseXPath(text: string): Expr {
  if (text.length > MAX_XPATH_LENGTH) throw new XPathError(`the expression is longer than ${MAX_XPATH_LENGTH} characters`, text.slice(0, 100), 0);
  return new Parser(text, tokenize(text)).parse();
}

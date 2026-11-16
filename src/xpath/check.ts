/**
 * Compile-time checks of the XPath in `must`, `when` and leafref `path`
 * statements: syntax, prefixes, functions and their argument counts, and the
 * restricted grammar of a leafref path (RFC 7950 §9.9.2, §14). Evaluation
 * comes later, against instance data.
 */

import { XPathError } from '../errors.js';
import type { CompiledModule } from '../schema/model.js';
import { walkExpr, type Expr, type Step } from './ast.js';
import { FUNCTIONS } from './functions.js';
import { parseXPath } from './parser.js';

/** A problem with an expression, for the compiler to report at the statement's location. */
export interface XPathProblem {
  readonly severity: 'error' | 'warning';
  readonly code: string;
  readonly message: string;
}

const CACHE = new WeakMap<object, Expr | XPathError>();

/**
 * The parsed form of an expression object (an `XPathExpression`, a
 * `LeafrefPath`), parsed once and cached. Throws {@link XPathError} when it
 * doesn't parse.
 */
export function compiledXPath(x: { readonly text: string }): Expr {
  const r = tryCompile(x);
  if (r instanceof XPathError) throw r;
  return r;
}

function tryCompile(x: { readonly text: string }): Expr | XPathError {
  let r = CACHE.get(x);
  if (r === undefined) {
    try {
      r = parseXPath(x.text);
    } catch (e) {
      if (!(e instanceof XPathError)) throw e;
      r = e;
    }
    CACHE.set(x, r);
  }
  return r;
}

export interface CheckScope {
  /** Prefix → module name, from the file the expression is written in. */
  readonly prefixes: ReadonlyMap<string, string>;
  /** The YANG version of the module the expression is written in. */
  readonly yangVersion: '1' | '1.1';
  /** A loaded module by name. */
  module(name: string): CompiledModule | undefined;
}

/** Checks a `must` or `when` expression. */
export function checkXPath(x: { readonly text: string }, scope: CheckScope): XPathProblem[] {
  const ast = tryCompile(x);
  if (ast instanceof XPathError) return [{ severity: 'error', code: 'xpath-syntax', message: `invalid XPath: ${ast.message}` }];
  return checkNames(ast, x.text, scope);
}

/** Checks a leafref path: its XPath, and that it keeps to the path grammar. */
export function checkLeafrefPath(x: { readonly text: string }, scope: CheckScope): XPathProblem[] {
  const ast = tryCompile(x);
  if (ast instanceof XPathError) return [{ severity: 'error', code: 'invalid-path', message: `invalid leafref path: ${ast.message}` }];
  const problems = checkNames(ast, x.text, scope);
  const grammar = pathGrammar(ast);
  if (grammar !== undefined) problems.push({ severity: 'error', code: 'invalid-path', message: `leafref path ${JSON.stringify(x.text)}: ${grammar}` });
  return problems;
}

function checkNames(ast: Expr, text: string, scope: CheckScope): XPathProblem[] {
  const identity = (ref: string, add: (p: XPathProblem) => void): void => {
    const colon = ref.indexOf(':');
    if (colon === -1) return;
    const p = ref.slice(0, colon);
    const name = ref.slice(colon + 1);
    const moduleName = scope.prefixes.get(p);
    if (moduleName === undefined) {
      add({ severity: 'error', code: 'xpath-unknown-prefix', message: `prefix '${p}' of identity '${ref}' in ${JSON.stringify(text)} is not the module's or an imported one` });
      return;
    }
    const m = scope.module(moduleName);
    if (m !== undefined && !m.identities.has(name)) add({ severity: 'warning', code: 'xpath-unknown-identity', message: `module ${moduleName} has no identity '${name}' (in ${JSON.stringify(text)})` });
  };
  return checkExpr(ast, text, {
    prefix: (p) => (scope.prefixes.has(p) ? undefined : `prefix '${p}' in ${JSON.stringify(text)} is not the module's or an imported one`),
    variables: false,
    yangVersion: scope.yangVersion,
    identity,
  });
}

/** What {@link checkExpr} checks names against. */
interface NameRules {
  /** Why a name-test prefix doesn't resolve, or undefined when it does. */
  prefix(prefix: string): string | undefined;
  /** Whether variable references are allowed: YANG defines none, but XPath-valued data may (NACM's $USER). */
  readonly variables: boolean;
  /** Warns about YANG 1.1 functions in a YANG 1.0 module. */
  readonly yangVersion?: '1' | '1.1';
  /** Checks the identity named by a literal second argument of derived-from() or derived-from-or-self(). */
  identity?(ref: string, add: (p: XPathProblem) => void): void;
}

/**
 * Checks an expression's names: name-test prefixes, variables, and that
 * functions exist and get an allowed number of arguments.
 */
function checkExpr(ast: Expr, text: string, rules: NameRules): XPathProblem[] {
  const problems: XPathProblem[] = [];
  const seen = new Set<string>();
  const add = (p: XPathProblem): void => {
    const key = `${p.code} ${p.message}`;
    if (!seen.has(key)) problems.push(p);
    seen.add(key);
  };
  const steps = (list: readonly Step[]): void => {
    for (const s of list) {
      if ((s.test.kind !== 'name' && s.test.kind !== 'any') || s.test.prefix === undefined) continue;
      const message = rules.prefix(s.test.prefix);
      if (message !== undefined) add({ severity: 'error', code: 'xpath-unknown-prefix', message });
    }
  };
  walkExpr(ast, (e) => {
    switch (e.type) {
      case 'path':
        steps(e.steps);
        break;
      case 'variable':
        if (!rules.variables) add({ severity: 'error', code: 'xpath-unknown-variable', message: `YANG defines no variables, so $${e.name} in ${JSON.stringify(text)} has no value` });
        break;
      case 'call': {
        const f = e.prefix === undefined ? FUNCTIONS.get(e.name) : undefined;
        const name = `${e.prefix === undefined ? '' : `${e.prefix}:`}${e.name}`;
        if (f === undefined) {
          add({ severity: 'error', code: 'xpath-unknown-function', message: `${name}() in ${JSON.stringify(text)} is not an XPath or YANG function` });
          break;
        }
        if (e.args.length < f.min || e.args.length > f.max) {
          const count = f.min === f.max ? `${f.min}` : f.max === Infinity ? `at least ${f.min}` : `${f.min} or ${f.max}`;
          add({ severity: 'error', code: 'xpath-arguments', message: `${name}() takes ${count} argument${count === '1' ? '' : 's'}, not ${e.args.length}, in ${JSON.stringify(text)}` });
        }
        if (f.yang11 === true && rules.yangVersion === '1') add({ severity: 'warning', code: 'xpath-yang-1.1-function', message: `${name}() is a YANG 1.1 function, but the module is YANG 1.0` });
        if ((e.name === 'derived-from' || e.name === 'derived-from-or-self') && e.args[1]?.type === 'literal') rules.identity?.(e.args[1].value, add);
        break;
      }
      default:
        break;
    }
  });
  return problems;
}

/**
 * Checks an expression held as a data value (a `yang:xpath1.0`): it parses,
 * and the name checks pass, with variables allowed. Returns the parsed
 * expression, or why it is invalid. `prefix` says why a name-test prefix
 * doesn't resolve, or gives undefined when it does.
 */
export function checkXPathValue(text: string, prefix: (prefix: string) => string | undefined): Expr | string {
  let ast: Expr;
  try {
    ast = parseXPath(text);
  } catch (e) {
    if (!(e instanceof XPathError)) throw e;
    return `invalid XPath: ${e.message}`;
  }
  const error = checkExpr(ast, text, { prefix, variables: true }).find((p) => p.severity === 'error');
  return error === undefined ? ast : `invalid XPath: ${error.message}`;
}

/**
 * Why a parsed leafref path breaks the path grammar, or undefined if it
 * keeps to it:
 *
 *   path-arg       = absolute-path / relative-path
 *   absolute-path  = 1*("/" (node-identifier *path-predicate))
 *   relative-path  = 1*("../") descendant-path
 *   path-predicate = "[" path-equality-expr "]"
 *   path-equality-expr = node-identifier "=" path-key-expr
 *   path-key-expr  = current() "/" 1*(".." "/") *(node-identifier "/") node-identifier
 */
function pathGrammar(ast: Expr): string | undefined {
  if (ast.type !== 'path' || typeof ast.start === 'object') return 'it is not a location path';
  let i = 0;
  if (ast.start === 'context') {
    while (ast.steps[i]?.axis === 'parent' && ast.steps[i]!.test.kind === 'node' && ast.steps[i]!.predicates.length === 0) i++;
    if (i === 0) return "a relative path must start with '../'";
  }
  if (i === ast.steps.length) return 'it names no node';
  for (; i < ast.steps.length; i++) {
    const s = ast.steps[i]!;
    if (s.axis !== 'child' || s.test.kind !== 'name') return "only node names may follow the leading '../' steps";
    for (const p of s.predicates) {
      const problem = predicateGrammar(p);
      if (problem !== undefined) return problem;
    }
  }
  return undefined;
}

function predicateGrammar(p: Expr): string | undefined {
  const bad = "a predicate must have the form [name = current()/../path]";
  if (p.type !== 'binary' || p.op !== '=') return bad;
  const { left, right } = p;
  if (left.type !== 'path' || left.start !== 'context' || left.steps.length !== 1) return bad;
  const key = left.steps[0]!;
  if (key.axis !== 'child' || key.test.kind !== 'name' || key.predicates.length > 0) return bad;
  if (right.type !== 'path' || typeof right.start !== 'object') return bad;
  const call = right.start;
  if (call.type !== 'call' || call.name !== 'current' || call.prefix !== undefined || call.args.length > 0) return bad;
  let i = 0;
  while (right.steps[i]?.axis === 'parent' && right.steps[i]!.test.kind === 'node' && right.steps[i]!.predicates.length === 0) i++;
  if (i === 0 || i === right.steps.length) return bad;
  for (; i < right.steps.length; i++) {
    const s = right.steps[i]!;
    if (s.axis !== 'child' || s.test.kind !== 'name' || s.predicates.length > 0) return bad;
  }
  return undefined;
}

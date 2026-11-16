/**
 * Values of type `yang:xpath1.0` (RFC 6991 §3), and of every typedef derived
 * from it, such as NACM's `node-instance-identifier` (RFC 8341 §3.5.2):
 * strings holding an XPath 1.0 expression.
 *
 * Reading one checks the expression: it parses, every prefix on a node name
 * resolves, and functions exist and get an allowed number of arguments.
 * Variables are allowed (NACM defines `$USER`). Node names aren't looked up
 * in the schema, as the expression may name modules the schema doesn't have
 * nodes from.
 *
 * Prefixes mean different things in the two encodings: XML namespace
 * prefixes in scope at the element, module names in JSON. The value is held
 * in its JSON form, as libyang writes it and as RFC 7951 §6.11 writes an
 * instance-identifier: a node name carries its module's name at the start of
 * a location path and where its module differs from the previous step's,
 * and the steps of a path inside a predicate continue from the step the
 * predicate is on. In XML, an unprefixed name is taken to be in the previous
 * step's module, as @node-net/yang reads an instance-identifier. Prefixes are
 * rewritten in place, so the rest of the expression keeps the text it was
 * written with. Prefixes inside string literals, such as an identity named
 * in `derived-from()`, are left as written.
 */

import type { CompiledModule, YangType } from '../schema/model.js';
import type { Schema } from '../schema/schema.js';
import type { Expr, NodeTest } from '../xpath/ast.js';
import { checkXPathValue } from '../xpath/check.js';
import { nameTestOffset, parseXPath } from '../xpath/parser.js';

/** True when `type` is ietf-yang-types' `xpath1.0`, or a typedef derived from it. Union and leafref types are not. */
export function isXPath10(type: YangType): boolean {
  for (let t: YangType | undefined = type; t?.typedef !== undefined; t = t.typedef.type) {
    if (t.typedef.name === 'xpath1.0' && t.typedef.module.name === 'ietf-yang-types') return true;
  }
  return false;
}

/** A name test in an expression, with the module its name resolves to. */
interface ResolvedName {
  readonly test: NodeTest & { readonly kind: 'name' | 'any' };
  /** The module the name is in, or undefined for an unprefixed name with nothing to inherit. */
  readonly module: CompiledModule | undefined;
  /** The module of the previous step, which an unprefixed name inherits in JSON. */
  readonly context: CompiledModule | undefined;
}

/**
 * Reads an expression's names. `module` resolves a prefix (an XML namespace
 * prefix, or a JSON module name); it has already been checked to resolve.
 */
function resolveNames(ast: Expr, module: (prefix: string) => CompiledModule | undefined): ResolvedName[] {
  const out: ResolvedName[] = [];
  const visit = (e: Expr, context: CompiledModule | undefined): void => {
    switch (e.type) {
      case 'binary':
        visit(e.left, context);
        visit(e.right, context);
        break;
      case 'negate':
        visit(e.operand, context);
        break;
      case 'call':
        for (const a of e.args) visit(a, context);
        break;
      case 'filter':
        visit(e.primary, context);
        for (const p of e.predicates) visit(p, context);
        break;
      case 'path': {
        let current: CompiledModule | undefined;
        if (e.start === 'context') current = context;
        else if (e.start !== 'root') visit(e.start, context);
        for (const step of e.steps) {
          const test = step.test;
          if (test.kind === 'name' || test.kind === 'any') {
            // An unprefixed `*` matches any name, whatever its module: it inherits nothing.
            const m = test.prefix !== undefined ? module(test.prefix) : test.kind === 'name' ? current : undefined;
            out.push({ test, module: m, context: current });
            current = m;
          }
          for (const p of step.predicates) visit(p, current);
        }
        break;
      }
      default:
        break;
    }
  };
  visit(ast, undefined);
  return out;
}

/** Rewrites each name test's prefix: `write` gives the new prefix, or undefined for none. */
function rewrite(text: string, names: readonly ResolvedName[], write: (n: ResolvedName) => string | undefined): string {
  const edits = names
    .map((n) => {
      const at = nameTestOffset(n.test)!;
      const old = n.test.prefix === undefined ? 0 : n.test.prefix.length + 1;
      const p = write(n);
      return { at, old, text: p === undefined ? '' : `${p}:` };
    })
    .sort((a, b) => b.at - a.at);
  let out = text;
  for (const e of edits) out = out.slice(0, e.at) + e.text + out.slice(e.at + e.old);
  return out;
}

/** JSON form: a module name where the module differs from the previous step's. */
function jsonPrefix(n: ResolvedName): string | undefined {
  return n.module === undefined || n.module === n.context ? undefined : n.module.name;
}

/**
 * Reads an expression written in XML (`format` 'xml', prefixes bound by
 * `module`) or JSON (module names). Returns it in JSON form, or why it is
 * invalid.
 */
export function readXPathValue(text: string, format: 'xml' | 'json', module: (prefix: string) => CompiledModule | undefined): { readonly json: string } | string {
  const checked = checkXPathValue(text, (p) => {
    if (module(p) !== undefined) return undefined;
    return format === 'xml' ? `prefix '${p}' in '${text}' is not a namespace prefix of a known module` : `'${p}' in '${text}' is not a known module`;
  });
  if (typeof checked === 'string') return checked;
  return { json: rewrite(text, resolveNames(checked, module), jsonPrefix) };
}

/**
 * Writes an expression held in JSON form for XML, with `prefix` giving each
 * module's namespace prefix. An expression that doesn't parse, or names a
 * module the schema doesn't have (a value built in code, not read), is
 * written as it is.
 */
export function writeXPathXml(json: string, schema: Schema, prefix: (module: CompiledModule) => string): string {
  let ast: Expr;
  try {
    ast = parseXPath(json);
  } catch {
    return json;
  }
  const names = resolveNames(ast, (p) => schema.module(p));
  if (names.some((n) => n.test.prefix !== undefined && schema.module(n.test.prefix) === undefined)) return json;
  return rewrite(json, names, (n) => (n.module === undefined ? undefined : prefix(n.module)));
}

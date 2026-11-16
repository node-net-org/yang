/**
 * The syntax tree of an XPath 1.0 expression (W3C XPath 1.0 §3).
 *
 * `//` is expanded into a `descendant-or-self::node()` step, `.` into
 * `self::node()` and `..` into `parent::node()`, as §2.5 defines them, and
 * `@name` into the attribute axis. Parentheses leave no trace unless the
 * parenthesised expression is filtered or followed by a path.
 */

export type Axis =
  | 'ancestor'
  | 'ancestor-or-self'
  | 'attribute'
  | 'child'
  | 'descendant'
  | 'descendant-or-self'
  | 'following'
  | 'following-sibling'
  | 'namespace'
  | 'parent'
  | 'preceding'
  | 'preceding-sibling'
  | 'self';

export const AXES: ReadonlySet<string> = new Set<Axis>([
  'ancestor',
  'ancestor-or-self',
  'attribute',
  'child',
  'descendant',
  'descendant-or-self',
  'following',
  'following-sibling',
  'namespace',
  'parent',
  'preceding',
  'preceding-sibling',
  'self',
]);

/** A name test (`name`, `prefix:name`, `prefix:*`, `*`) or a node type test. */
export type NodeTest =
  | { readonly kind: 'name'; readonly prefix?: string; readonly name: string }
  | { readonly kind: 'any'; readonly prefix?: string }
  | { readonly kind: 'node' }
  | { readonly kind: 'text' }
  | { readonly kind: 'comment' }
  | { readonly kind: 'processing-instruction'; readonly target?: string };

export interface Step {
  readonly axis: Axis;
  readonly test: NodeTest;
  readonly predicates: readonly Expr[];
}

export type BinaryOperator = 'or' | 'and' | '=' | '!=' | '<' | '>' | '<=' | '>=' | '+' | '-' | '*' | 'div' | 'mod' | '|';

export type Expr =
  | { readonly type: 'binary'; readonly op: BinaryOperator; readonly left: Expr; readonly right: Expr }
  | { readonly type: 'negate'; readonly operand: Expr }
  | { readonly type: 'literal'; readonly value: string }
  | { readonly type: 'number'; readonly value: number }
  | { readonly type: 'variable'; readonly prefix?: string; readonly name: string }
  | { readonly type: 'call'; readonly prefix?: string; readonly name: string; readonly args: readonly Expr[] }
  /** A primary expression with predicates: `(a | b)[1]`, `deref(x)[2]`. */
  | { readonly type: 'filter'; readonly primary: Expr; readonly predicates: readonly Expr[] }
  /**
   * A location path. `start` is where it begins: the root (`/a`), the
   * context node (`a/b`), or the node-set an expression gives (`deref(.)/../b`).
   */
  | { readonly type: 'path'; readonly start: 'root' | 'context' | Expr; readonly steps: readonly Step[] };

/** Calls `visit` for every expression in the tree, depth first, parents before children. */
export function walkExpr(expr: Expr, visit: (e: Expr) => void): void {
  const stack: Expr[] = [expr];
  while (stack.length > 0) {
    const e = stack.pop()!;
    visit(e);
    switch (e.type) {
      case 'binary':
        stack.push(e.right, e.left);
        break;
      case 'negate':
        stack.push(e.operand);
        break;
      case 'call':
        stack.push(...[...e.args].reverse());
        break;
      case 'filter':
        stack.push(...[...e.predicates].reverse(), e.primary);
        break;
      case 'path':
        for (const s of [...e.steps].reverse()) stack.push(...[...s.predicates].reverse());
        if (typeof e.start === 'object') stack.push(e.start);
        break;
      default:
        break;
    }
  }
}

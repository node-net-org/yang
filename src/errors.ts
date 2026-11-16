/**
 * Error hierarchy shared by every part of @node-net/yang.
 *
 * This module is a leaf apart from the location types: it imports nothing
 * else from the package.
 */

import { formatLocation, type SourceLocation } from './location.js';

export interface NetYangErrorOptions {
  readonly cause?: unknown;
}

/** Base class of every error raised by @node-net/yang. */
export class NetYangError extends Error {
  override name = 'NetYangError';
  /** Stable, machine-readable error code. */
  readonly code: string = 'ERR_NET_YANG';

  constructor(message: string, options?: NetYangErrorOptions) {
    super(message, options);
  }
}

/**
 * The text can't be read as YANG statements at all: an unterminated string or
 * comment, unbalanced braces, a missing `;`, invalid UTF-8. Problems that
 * still leave a usable statement tree are reported as diagnostics instead.
 */
export class YangSyntaxError extends NetYangError {
  override name = 'YangSyntaxError';
  override readonly code = 'ERR_NET_YANG_SYNTAX';
  /** Where the problem was found. */
  readonly location: SourceLocation;

  constructor(message: string, location: SourceLocation, options?: NetYangErrorOptions) {
    super(`${formatLocation(location)}: ${message}`, options);
    this.location = location;
  }
}

/** One problem found in instance data, with where it is. */
export interface DataIssue {
  /**
   * Stable, machine-readable code. Reading data: `unknown-node`,
   * `wrong-namespace`, `invalid-value`, `missing-key`, `duplicate-node`,
   * `duplicate-entry`, `unexpected-content`, `unknown-annotation`,
   * `xml-syntax`, `json-syntax`, and so on. Validating it: `when-false`,
   * `must-violation`, `missing-instance`, `not-unique`, `too-few-elements`,
   * `too-many-elements`, `missing-mandatory`, `missing-choice`,
   * `multiple-cases`, `duplicate-entry`, `missing-parent`, `xpath-error`.
   */
  readonly code: string;
  readonly message: string;
  /**
   * The data path of the node the problem is on, RFC 7951 style
   * (`/ietf-interfaces:interfaces/interface[name='eth0']/mtu`), or `/` for
   * the document as a whole. For a missing node, the path it would have.
   */
  readonly path: string;
  /**
   * Where the problem is in the data text, when it was decoded with the
   * `positions` option: the start of the node's XML element or JSON member,
   * or of the parent's for a node that is missing. Absent for trees built in
   * code, for already-parsed input, and for a problem with the document as a
   * whole. (`location` is where a constraint is defined in a module.)
   */
  readonly position?: SourceLocation;
  /**
   * `warning` for a constraint the data may break: semantic constraints in
   * `<operational>` (RFC 8342 §5.3). Everything else is an `error`.
   */
  readonly severity: 'error' | 'warning';
  /**
   * The error-app-tag a protocol would report: the `must`'s own, or the one
   * RFC 7950 §15 defines (`must-violation`, `instance-required`,
   * `data-not-unique`, `too-many-elements`, `too-few-elements`,
   * `missing-choice`).
   */
  readonly appTag?: string;
  /** The `must` or `when` expression that failed. */
  readonly expression?: string;
  /** Where that expression, or the constraint, is defined. */
  readonly location?: SourceLocation;
  /** For `not-unique`: the paths of the leaves whose values repeat another entry's (RFC 7950 §15.1 `non-unique`). */
  readonly nonUnique?: readonly string[];
  /** For `missing-choice`: the choice's name (RFC 7950 §15.6). */
  readonly missingChoice?: string;
}

/**
 * Instance data that can't be read or written: malformed XML or JSON, nodes
 * the schema doesn't have, invalid values, missing list keys. `issues` lists
 * every problem found, not only the first.
 */
export class YangDataError extends NetYangError {
  override name = 'YangDataError';
  override readonly code = 'ERR_NET_YANG_DATA';
  readonly issues: readonly DataIssue[];

  /** @param issues every problem found; warnings may be among them */
  constructor(issues: readonly DataIssue[], options?: NetYangErrorOptions) {
    const first = issues[0];
    const more = issues.length > 1 ? ` (and ${issues.length - 1} more)` : '';
    super(first === undefined ? 'invalid data' : `${first.path}: ${first.message}${more}`, options);
    this.issues = issues;
  }
}

/**
 * An XPath expression that can't be parsed, or one whose evaluation failed:
 * an unknown function, prefix or variable, or a budget exceeded.
 */
export class XPathError extends NetYangError {
  override name = 'XPathError';
  override readonly code = 'ERR_NET_YANG_XPATH';
  /** The expression. */
  readonly expression: string;
  /** Where in the expression the problem is, 0-based, when known. */
  readonly offset: number | undefined;

  constructor(message: string, expression: string, offset?: number, options?: NetYangErrorOptions) {
    super(offset === undefined ? message : `${message} (at offset ${offset} of ${JSON.stringify(expression.length > 120 ? `${expression.slice(0, 117)}...` : expression)})`, options);
    this.expression = expression;
    this.offset = offset;
    this.reason = message;
  }

  /** The message without the expression. */
  readonly reason: string;
}

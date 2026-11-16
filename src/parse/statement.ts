/**
 * The statement tree: YANG source as parsed, before any compilation.
 */

import type { SourceLocation } from '../location.js';

/**
 * One YANG statement (RFC 7950 §6.3): a keyword, an optional argument, and
 * its substatements, in source order.
 */
export interface Statement {
  /** The keyword as written: `container`, or `prefix:name` for an extension statement. */
  readonly keyword: string;
  /** The prefix of an extension keyword. Absent for core YANG statements. */
  readonly prefix?: string;
  /**
   * The argument with quoting resolved: escapes replaced, double-quoted
   * indentation trimmed and `+` concatenation applied. Absent when the
   * statement has no argument.
   */
  readonly argument?: string;
  readonly substatements: readonly Statement[];
  /** Where the keyword starts. */
  readonly location: SourceLocation;
  /** Where the argument starts. Absent when the statement has no argument. */
  readonly argumentLocation?: SourceLocation;
}

/** True for an extension statement (`prefix:name`), false for a core YANG statement. */
export function isExtension(statement: Statement): boolean {
  return statement.prefix !== undefined;
}

/** The first substatement with this keyword, if any. */
export function substatement(statement: Statement, keyword: string): Statement | undefined {
  return statement.substatements.find((s) => s.keyword === keyword);
}

/** Every substatement with this keyword. */
export function substatements(statement: Statement, keyword: string): Statement[] {
  return statement.substatements.filter((s) => s.keyword === keyword);
}

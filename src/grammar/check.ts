/**
 * Checks a parsed module against the grammar table: known keywords, allowed
 * substatements and their cardinality, argument presence and syntax, the
 * order of module sections, and the version-dependent lexical rules.
 *
 * Extension statements (`prefix:name`) and everything inside them are left
 * alone: their grammar is defined by the extension, not by YANG.
 */

import type { LexicalNote } from '../parse/lexer.js';
import type { Diagnostic, LineIndex, Severity, SourceLocation } from '../location.js';
import { isExtension, type Statement } from '../parse/statement.js';
import { checkArgument } from './arguments.js';
import {
  BODY_SECTION,
  cardinalityIn,
  MODULE_SECTIONS,
  SECTION_NAMES,
  STATEMENTS,
  type Cardinality,
  type StatementRule,
  type YangVersion,
} from './statements.js';

/** The version a module declares with `yang-version`, or 1 when it declares none (RFC 7950 §7.1.2). */
export function declaredVersion(module: Statement): YangVersion {
  const value = module.substatements.find((s) => s.keyword === 'yang-version')?.argument;
  return value === '1.1' ? '1.1' : '1';
}

export function checkModule(module: Statement, notes: readonly LexicalNote[], lines: LineIndex): Diagnostic[] {
  const version = declaredVersion(module);
  const diagnostics: Diagnostic[] = [];
  const report = (severity: Severity, code: string, message: string, location: SourceLocation): void => {
    diagnostics.push({ severity, code, message, location });
  };

  for (const note of notes) {
    const location = lines.locate(note.offset);
    switch (note.code) {
      case 'illegal-escape':
        // RFC 7950 §6.1.3 makes any other escape an error; RFC 6020 left it undefined.
        report(
          version === '1.1' ? 'error' : 'warning',
          note.code,
          `'\\${note.detail}' is not a valid escape in a double-quoted string (only \\n, \\t, \\" and \\\\ are)`,
          location,
        );
        break;
      case 'quote-in-unquoted-string':
        report('error', note.code, `an unquoted string can't contain ${note.detail}; quote the whole argument`, location);
        break;
      case 'illegal-character':
        report('error', note.code, `${note.detail} is not allowed in YANG text`, location);
        break;
    }
  }

  checkStatement(module, undefined, version, report);
  checkModuleOrder(module, report);
  return diagnostics;
}

type Report = (severity: Severity, code: string, message: string, location: SourceLocation) => void;

function checkStatement(statement: Statement, parent: Statement | undefined, version: YangVersion, report: Report): void {
  const rule = STATEMENTS[statement.keyword];
  if (rule === undefined) {
    report('error', 'unknown-statement', `'${statement.keyword}' is not a YANG statement`, statement.location);
    return;
  }
  if (rule.since === '1.1' && version === '1') {
    report('error', 'requires-yang-1.1', `'${statement.keyword}' needs yang-version 1.1`, statement.location);
  }
  checkStatementArgument(statement, rule, parent, version, report);

  const counts = new Map<string, Statement[]>();
  for (const sub of statement.substatements) {
    if (isExtension(sub)) continue;
    const allowed = rule.substatements[sub.keyword];
    if (allowed === undefined) {
      if (STATEMENTS[sub.keyword] !== undefined) {
        report('error', 'unexpected-substatement', `'${sub.keyword}' is not allowed in '${statement.keyword}'`, sub.location);
      } else {
        report('error', 'unknown-statement', `'${sub.keyword}' is not a YANG statement`, sub.location);
      }
      continue;
    }
    if (cardinalityIn(allowed, version) === null) {
      report('error', 'requires-yang-1.1', `'${sub.keyword}' in '${statement.keyword}' needs yang-version 1.1`, sub.location);
      continue;
    }
    const list = counts.get(sub.keyword);
    if (list === undefined) counts.set(sub.keyword, [sub]);
    else list.push(sub);
    checkStatement(sub, statement, version, report);
  }

  // Only the required substatements and those present can break a cardinality, so the rest of the rule isn't walked.
  const { required, order } = cardinalityChecks(rule, version);
  let problems: { at: number; report: () => void }[] | undefined;
  const problem = (keyword: string, report: () => void): void => {
    (problems ??= []).push({ at: order.get(keyword)!, report });
  };
  for (const keyword of required) {
    if (!counts.has(keyword)) problem(keyword, () => report('error', 'missing-substatement', `'${statement.keyword}' needs a '${keyword}' substatement`, statement.location));
  }
  for (const [keyword, found] of counts) {
    if (found.length > 1 && !isMultiple(cardinalityIn(rule.substatements[keyword]!, version)!)) {
      problem(keyword, () => report('error', 'too-many-substatements', `'${statement.keyword}' can have only one '${keyword}'`, found[1]!.location));
    }
  }
  // In the rule's order, as they always have been.
  if (problems !== undefined) for (const p of problems.sort((a, b) => a.at - b.at)) p.report();
}

const CHECKS = new WeakMap<StatementRule, Partial<Record<YangVersion, { required: string[]; order: Map<string, number> }>>>();

/** A rule's required substatements in a version, and the position of each substatement in the rule. */
function cardinalityChecks(rule: StatementRule, version: YangVersion): { required: string[]; order: Map<string, number> } {
  let byVersion = CHECKS.get(rule);
  if (byVersion === undefined) CHECKS.set(rule, (byVersion = {}));
  let checks = byVersion[version];
  if (checks === undefined) {
    const keywords = Object.keys(rule.substatements);
    checks = {
      required: keywords.filter((k) => {
        const c = cardinalityIn(rule.substatements[k]!, version);
        return c !== null && isRequired(c);
      }),
      order: new Map(keywords.map((k, i) => [k, i])),
    };
    byVersion[version] = checks;
  }
  return checks;
}

function checkStatementArgument(
  statement: Statement,
  rule: StatementRule,
  parent: Statement | undefined,
  version: YangVersion,
  report: Report,
): void {
  if (rule.argument === 'none') {
    if (statement.argument !== undefined) {
      report('error', 'unexpected-argument', `'${statement.keyword}' takes no argument`, statement.argumentLocation ?? statement.location);
    }
    return;
  }
  if (statement.argument === undefined) {
    report('error', 'missing-argument', `'${statement.keyword}' needs an argument`, statement.location);
    return;
  }
  const problem = checkArgument(rule.argument, statement.argument, { version, parentKeyword: parent?.keyword });
  if (problem !== undefined) {
    report('error', 'invalid-argument', `${statement.keyword}: ${problem}`, statement.argumentLocation ?? statement.location);
  }
}

function checkModuleOrder(module: Statement, report: Report): void {
  let section = 0;
  for (const sub of module.substatements) {
    if (isExtension(sub)) continue;
    const s = MODULE_SECTIONS[sub.keyword] ?? BODY_SECTION;
    if (s < section) {
      report(
        'error',
        'statement-out-of-order',
        `'${sub.keyword}' belongs in the ${SECTION_NAMES[s]} statements, which come before the ${SECTION_NAMES[section]} statements`,
        sub.location,
      );
    } else {
      section = s;
    }
  }
}

function isRequired(c: Cardinality): boolean {
  return c === '1' || c === '1..n';
}

function isMultiple(c: Cardinality): boolean {
  return c === '0..n' || c === '1..n';
}

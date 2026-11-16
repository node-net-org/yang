/**
 * Statement tree → YANG text: the counterpart of writeYin, for modules read
 * from YIN (or built in code) that must be shown or served as YANG.
 *
 * The contract is the round trip: parsing the text gives back the same
 * keywords and arguments. Comments are not kept, since the tree has none.
 */

import type { Statement } from './statement.js';

const INDENT = '  ';
/** Arguments written without quotes: names, prefixed names, numbers, dates. */
const UNQUOTED = /^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/;

/**
 * Writes a statement tree, usually a `module` or `submodule`, as YANG text:
 * two spaces per level, and each argument quoted as RFC 7950 §6.1.3 needs
 * so that it reads back exactly as it is.
 */
export function writeYang(statement: Statement): string {
  const out: string[] = [];
  write(statement, '', out);
  return out.join('');
}

function write(s: Statement, indent: string, out: string[]): void {
  const head = `${indent}${s.keyword}`;
  const arg = s.argument === undefined ? '' : ` ${quote(s.argument, head.length + 1)}`;
  if (s.substatements.length === 0) {
    out.push(`${head}${arg};\n`);
    return;
  }
  out.push(`${head}${arg} {\n`);
  const inner = indent + INDENT;
  const top = indent === '';
  s.substatements.forEach((c, i) => {
    // At the top level, a blank line around every statement with a body.
    if (top && i > 0 && (c.substatements.length > 0 || s.substatements[i - 1]!.substatements.length > 0)) out.push('\n');
    write(c, inner, out);
  });
  out.push(`${indent}}\n`);
}

/** An argument written so that it reads back unchanged; `column` is where its first character goes (0-based). */
function quote(text: string, column: number): string {
  if (UNQUOTED.test(text)) return text;
  if (text.includes('\n') && multiLineSafe(text)) {
    // Continuation lines start one past the opening quote: the indentation the parser trims.
    const pad = ' '.repeat(column + 1);
    const lines = escapeDouble(text).split('\n');
    return `"${lines.map((l, i) => (i === 0 || l === '' ? l : pad + l)).join('\n')}"`;
  }
  if (!text.includes('\n')) {
    if (!text.includes('"') && !text.includes('\\')) return `"${text}"`;
    if (!text.includes("'")) return `'${text}'`;
  } else if (!text.includes("'")) {
    return `'${text}'`;
  }
  // Single-quoted runs, with each ' in double quotes: nothing is processed, so it is exact.
  return text
    .split(/(')/)
    .filter((p) => p !== '')
    .map((p) => (p === "'" ? `"'"` : `'${p}'`))
    .join(' + ');
}

/** Whether multi-line text survives double quoting: the parser strips whitespace before a line break, and tabs and CRs change indentation. */
function multiLineSafe(text: string): boolean {
  return !/[\t\r]/.test(text) && !/ \n/.test(text);
}

function escapeDouble(text: string): string {
  return text.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

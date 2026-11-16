/**
 * Writing a string as an XPath 1.0 literal (W3C XPath 1.0 §3.7). A Literal is
 * a run of characters in single or double quotes, with no escapes, so a
 * string holding both quote characters can't be one: it is written as a
 * `concat()` of literals instead, which is an expression, not a Literal.
 */

/**
 * The string in single quotes, or in double quotes when it holds `'`. When it
 * holds both, a `concat()` of quoted pieces: `concat('it', "'", 's "x"')`.
 */
export function xpathLiteral(s: string): string {
  if (!s.includes("'")) return `'${s}'`;
  if (!s.includes('"')) return `"${s}"`;
  // Split at each `'`: the pieces between hold no `'`, so single quotes suit them.
  const args: string[] = [];
  s.split("'").forEach((piece, i) => {
    if (i > 0) args.push(`"'"`);
    if (piece !== '') args.push(`'${piece}'`);
  });
  return `concat(${args.join(', ')})`;
}

/** True when the string can be written as one XPath 1.0 literal: it doesn't hold both quote characters. */
export function isXPathLiteral(s: string): boolean {
  return !(s.includes("'") && s.includes('"'));
}

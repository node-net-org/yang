/**
 * Translates XSD regular expressions (W3C XML Schema Part 2, Appendix F;
 * required by RFC 7950 §9.4.5 for `pattern`) into JavaScript regular
 * expressions with the `v` flag.
 *
 * The two languages look alike but differ in ways that matter:
 * - XSD patterns are implicitly anchored at both ends.
 * - `^` and `$` are ordinary characters in XSD.
 * - `.` excludes only `\n` and `\r`; `\s` is just space, tab, CR and LF.
 * - `\d` is any Unicode decimal digit (`\p{Nd}`), not just 0–9, and `\w` is
 *   everything except punctuation, separators and "other" characters.
 * - `\i` and `\c` are XML name characters.
 * - Character classes can be subtracted: `[a-z-[aeiou]]`.
 * - There are no anchors, backreferences, lookaround or lazy quantifiers.
 *
 * Every character inside a class is emitted as a `\u{…}` escape, so the
 * output never trips over the `v` flag's reserved class syntax.
 *
 * Patterns are matched by {@link XsdRegex}, not by the translated RegExp:
 * a backtracking engine can take exponential time on some patterns.
 */

import { XsdRegex } from './xsd-match.js';
import { XsdRegexError } from './xsd-regex-error.js';

export { XsdRegexError };

/** XML 1.0 (5th edition) NameStartChar, which XSD 1.1 uses for `\i`. */
const NAME_START = '\\u{3A}A-Z\\u{5F}a-z\\u{C0}-\\u{D6}\\u{D8}-\\u{F6}\\u{F8}-\\u{2FF}\\u{370}-\\u{37D}\\u{37F}-\\u{1FFF}\\u{200C}-\\u{200D}\\u{2070}-\\u{218F}\\u{2C00}-\\u{2FEF}\\u{3001}-\\u{D7FF}\\u{F900}-\\u{FDCF}\\u{FDF0}-\\u{FFFD}\\u{10000}-\\u{EFFFF}';
/** NameChar: NameStartChar plus `-`, `.`, digits, U+B7 and two combining ranges. */
const NAME_CHAR = `${NAME_START}\\u{2D}\\u{2E}0-9\\u{B7}\\u{300}-\\u{36F}\\u{203F}-\\u{2040}`;

/** Multi-character escapes, as JavaScript `v`-flag class expressions. */
const MULTI: Readonly<Record<string, string>> = {
  s: '[\\u{20}\\u{9}\\u{A}\\u{D}]',
  S: '[^\\u{20}\\u{9}\\u{A}\\u{D}]',
  i: `[${NAME_START}]`,
  I: `[^${NAME_START}]`,
  c: `[${NAME_CHAR}]`,
  C: `[^${NAME_CHAR}]`,
  d: '[\\p{Nd}]',
  D: '[^\\p{Nd}]',
  w: '[^\\p{P}\\p{Z}\\p{C}]',
  W: '[\\p{P}\\p{Z}\\p{C}]',
};

/** Single-character escapes and the characters they stand for. */
const SINGLE: Readonly<Record<string, string>> = {
  n: '\n',
  r: '\r',
  t: '\t',
  '\\': '\\',
  '|': '|',
  '.': '.',
  '-': '-',
  '^': '^',
  '?': '?',
  '*': '*',
  '+': '+',
  '{': '{',
  '}': '}',
  '(': '(',
  ')': ')',
  '[': '[',
  ']': ']',
};

/** Unicode general categories allowed in `\p{…}` (XSD F.1.1). */
const CATEGORIES = new Set([
  'L', 'Lu', 'Ll', 'Lt', 'Lm', 'Lo',
  'M', 'Mn', 'Mc', 'Me',
  'N', 'Nd', 'Nl', 'No',
  'P', 'Pc', 'Pd', 'Ps', 'Pe', 'Pi', 'Pf', 'Po',
  'Z', 'Zs', 'Zl', 'Zp',
  'S', 'Sm', 'Sc', 'Sk', 'So',
  'C', 'Cc', 'Cf', 'Co', 'Cn',
]);

const lit = (cp: number): string => `\\u{${cp.toString(16).toUpperCase()}}`;

/**
 * A parsed XSD pattern. Character classes keep their JavaScript `v`-flag
 * source, so the translation and the matcher share one definition of what a
 * class contains.
 */
export type XsdRegexNode =
  | { readonly kind: 'char'; readonly cp: number }
  /** A class, `.` or multi-character escape, as a bracketed `v`-flag class. */
  | { readonly kind: 'set'; readonly source: string }
  | { readonly kind: 'seq'; readonly items: readonly XsdRegexNode[] }
  | { readonly kind: 'alt'; readonly branches: readonly XsdRegexNode[] }
  | { readonly kind: 'group'; readonly inner: XsdRegexNode }
  /** `max` is undefined when unbounded. `text` is the quantifier as written. */
  | { readonly kind: 'repeat'; readonly atom: XsdRegexNode; readonly min: number; readonly max: number | undefined; readonly text: string };

/** Translates an XSD pattern to JavaScript `v`-flag source, anchored. Throws {@link XsdRegexError}. */
export function translateXsdRegex(pattern: string): string {
  return toSource(parseXsdRegex(pattern));
}

/** The anchored JavaScript `v`-flag source for a parsed pattern. */
function toSource(root: XsdRegexNode): string {
  const emit = (n: XsdRegexNode): string => {
    switch (n.kind) {
      case 'char':
        return lit(n.cp);
      case 'set':
        return n.source;
      case 'seq':
        return n.items.map(emit).join('');
      case 'alt':
        return n.branches.map(emit).join('|');
      case 'group':
        return `(?:${emit(n.inner)})`;
      case 'repeat':
        return emit(n.atom) + n.text;
    }
  };
  return `^(?:${emit(root)})$`;
}

/** Parses an XSD pattern (XSD 1.1 Part 2, Appendix F). Throws {@link XsdRegexError}. */
export function parseXsdRegex(pattern: string): XsdRegexNode {
  const chars = Array.from(pattern);
  let pos = 0;

  const fail = (message: string): never => {
    throw new XsdRegexError(`${message} at position ${pos} in pattern ${JSON.stringify(pattern)}`);
  };
  const peek = (): string | undefined => chars[pos];

  // regExp ::= branch ( '|' branch )*
  const regExp = (): XsdRegexNode => {
    const branches = [branch()];
    while (peek() === '|') {
      pos++;
      branches.push(branch());
    }
    return branches.length === 1 ? branches[0]! : { kind: 'alt', branches };
  };

  // branch ::= piece*
  const branch = (): XsdRegexNode => {
    const items: XsdRegexNode[] = [];
    while (pos < chars.length && peek() !== '|' && peek() !== ')') items.push(piece());
    return { kind: 'seq', items };
  };

  // piece ::= atom quantifier?
  const piece = (): XsdRegexNode => {
    const a = atom();
    const c = peek();
    if (c === '?' || c === '*' || c === '+') {
      pos++;
      return { kind: 'repeat', atom: a, min: c === '+' ? 1 : 0, max: c === '?' ? 1 : undefined, text: c };
    }
    if (c === '{') return { kind: 'repeat', atom: a, ...quantity() };
    return a;
  };

  /** Bounds beyond Number's safe range stay huge, which the matcher's size limit rejects. */
  const quantity = (): { min: number; max: number | undefined; text: string } => {
    pos++; // {
    let min = '';
    while (/[0-9]/.test(peek() ?? '')) min += chars[pos++]!;
    if (min === '') fail("a quantifier needs a minimum, as in '{2,}'");
    let text = `{${min}`;
    let max: string | undefined = min;
    if (peek() === ',') {
      pos++;
      max = '';
      while (/[0-9]/.test(peek() ?? '')) max += chars[pos++]!;
      if (max !== '' && BigInt(max) < BigInt(min)) fail('a quantifier maximum is less than its minimum');
      text += `,${max}`;
      if (max === '') max = undefined;
    }
    if (peek() !== '}') fail("unterminated quantifier: missing '}'");
    pos++;
    return { min: Number(min), max: max === undefined ? undefined : Number(max), text: text + '}' };
  };

  // atom ::= Char | charClass | '(' regExp ')'
  const atom = (): XsdRegexNode => {
    const c = chars[pos];
    if (c === undefined) return fail('unexpected end of pattern');
    switch (c) {
      case '(': {
        pos++;
        const inner = regExp();
        if (peek() !== ')') fail("missing ')'");
        pos++;
        return { kind: 'group', inner };
      }
      case '[':
        return { kind: 'set', source: charClassExpr() };
      case '\\':
        return escapeOutsideClass();
      case '.':
        pos++;
        return { kind: 'set', source: '[^\\u{A}\\u{D}]' };
      case '?':
      case '*':
      case '+':
      case '{':
        return fail(`'${c}' has nothing to repeat`);
      case ')':
      case ']':
      case '}':
        return fail(`unexpected '${c}'`);
      default:
        pos++;
        return { kind: 'char', cp: c.codePointAt(0)! };
    }
  };

  const escapeOutsideClass = (): XsdRegexNode => {
    const e = escape();
    return e.kind === 'char' ? { kind: 'char', cp: e.cp } : { kind: 'set', source: e.cls };
  };

  type Escape = { kind: 'char'; cp: number } | { kind: 'class'; cls: string };

  /** Reads `\x` at pos. */
  const escape = (): Escape => {
    pos++; // backslash
    const c = chars[pos++];
    if (c === undefined) return fail('pattern ends with a backslash');
    const single = SINGLE[c];
    if (single !== undefined) return { kind: 'char', cp: single.codePointAt(0)! };
    const multi = MULTI[c];
    if (multi !== undefined) return { kind: 'class', cls: multi };
    if (c === 'p' || c === 'P') {
      if (chars[pos] !== '{') fail(`'\\${c}' must be followed by '{'`);
      const end = chars.indexOf('}', pos);
      if (end === -1) fail(`unterminated '\\${c}{'`);
      const name = chars.slice(pos + 1, end).join('');
      pos = end + 1;
      if (name.startsWith('Is')) {
        return fail(`Unicode block escapes such as '\\${c}{${name}}' are not supported yet`);
      }
      if (!CATEGORIES.has(name)) fail(`'${name}' is not a Unicode category`);
      return { kind: 'class', cls: c === 'p' ? `[\\p{${name}}]` : `[^\\p{${name}}]` };
    }
    return fail(`'\\${c}' is not a valid escape`);
  };

  // charClassExpr ::= '[' ( '^'? charGroupContent ) ( '-' charClassExpr )? ']'
  const charClassExpr = (): string => {
    pos++; // [
    let negated = false;
    if (peek() === '^') {
      negated = true;
      pos++;
    }
    const items: string[] = [];
    let subtraction: string | undefined;
    let first = true;
    for (;;) {
      const c = peek();
      if (c === undefined) fail("unterminated character class: missing ']'");
      if (c === ']' && !first) {
        pos++;
        break;
      }
      if (c === '-' && chars[pos + 1] === '[' && !first) {
        pos++;
        subtraction = charClassExpr();
        if (peek() !== ']') fail("a class subtraction must end its character class");
        pos++;
        break;
      }
      if (c === '[') fail("'[' must be escaped inside a character class");
      items.push(classItem(first));
      first = false;
    }
    if (items.length === 0) fail('empty character class');
    let body = items.join('');
    if (subtraction !== undefined) body = `[${body}]--${subtraction}`;
    return negated ? `[^${body}]` : `[${body}]`;
  };

  /** One character, range or escape inside a class. */
  const classItem = (first: boolean): string => {
    const start = classChar(first);
    if (start.kind === 'class') return start.cls;
    // A range, unless '-' is the last character before ']' or starts a subtraction.
    if (peek() === '-' && chars[pos + 1] !== ']' && chars[pos + 1] !== '[' && chars[pos + 1] !== undefined) {
      pos++;
      const end = classChar(false);
      if (end.kind === 'class') return fail('a range cannot end in a multi-character escape');
      if (end.cp < start.cp) fail('a range is out of order');
      return `${lit(start.cp)}-${lit(end.cp)}`;
    }
    return lit(start.cp);
  };

  const classChar = (first: boolean): Escape => {
    const c = chars[pos]!;
    if (c === '\\') return escape();
    if (chars[pos + 1] === undefined) fail("unterminated character class: missing ']'");
    if (c === '-' && !first && chars[pos + 1] !== ']') {
      // XSD allows '-' unescaped only at the start or end of a class.
      return fail("'-' must be escaped in the middle of a character class");
    }
    pos++;
    return { kind: 'char', cp: c.codePointAt(0)! };
  };

  const root = regExp();
  if (pos < chars.length) fail(`unexpected '${chars[pos]}'`);
  return root;
}

/**
 * Compiles an XSD pattern to a matcher whose time is linear in the length of
 * the value (see {@link XsdRegex}). Throws {@link XsdRegexError} for an
 * invalid pattern, or one whose automaton would exceed `MAX_PATTERN_SIZE`.
 */
export function compileXsdRegex(pattern: string): XsdRegex {
  const root = parseXsdRegex(pattern);
  try {
    // Validates the classes exactly as before; the matcher tests them one code point at a time.
    new RegExp(toSource(root), 'v');
  } catch (err) {
    throw new XsdRegexError(`pattern ${JSON.stringify(pattern)} could not be compiled: ${(err as Error).message}`);
  }
  return new XsdRegex(pattern, root);
}

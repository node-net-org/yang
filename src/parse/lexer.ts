/**
 * YANG tokenizer (RFC 7950 §6.1, §14).
 *
 * Tokens are unquoted strings ("words"), quoted strings, `+` between quoted
 * strings, `;`, `{` and `}`. Whitespace and comments separate tokens.
 *
 * Some lexical rules differ between YANG versions, and the version is only
 * known once the `yang-version` statement has been parsed. Those problems are
 * recorded as {@link LexicalNote}s and turned into diagnostics later, at the
 * severity the module's version calls for.
 */

import { YangSyntaxError } from '../errors.js';
import type { LineIndex } from '../location.js';

export type TokenKind = 'word' | 'quoted' | 'plus' | 'semicolon' | 'lbrace' | 'rbrace' | 'eof';

export interface Token {
  readonly kind: TokenKind;
  /** The text of a word, or the processed value of a quoted string. */
  readonly value: string;
  readonly offset: number;
}

export type LexicalNoteCode = 'illegal-escape' | 'quote-in-unquoted-string' | 'illegal-character';

export interface LexicalNote {
  readonly code: LexicalNoteCode;
  readonly offset: number;
  readonly detail: string;
}

/** Tabs count as 8 columns when trimming double-quoted strings (RFC 7950 §6.1.3). */
const TAB_WIDTH = 8;

export class Lexer {
  readonly #text: string;
  readonly #lines: LineIndex;
  readonly #notes: LexicalNote[];
  #pos = 0;
  #lastKind: TokenKind | undefined;
  #peeked: Token | undefined;

  constructor(text: string, lines: LineIndex, notes: LexicalNote[]) {
    this.#text = text;
    this.#lines = lines;
    this.#notes = notes;
    checkCharacters(text, notes);
  }

  peek(): Token {
    this.#peeked ??= this.#read();
    return this.#peeked;
  }

  next(): Token {
    const token = this.peek();
    this.#peeked = undefined;
    return token;
  }

  error(message: string, offset: number): YangSyntaxError {
    return new YangSyntaxError(message, this.#lines.locate(offset));
  }

  #read(): Token {
    this.#skipSpaceAndComments();
    const text = this.#text;
    const start = this.#pos;
    if (start >= text.length) return this.#token('eof', '', start);
    const c = text[start]!;
    switch (c) {
      case ';':
        this.#pos++;
        return this.#token('semicolon', c, start);
      case '{':
        this.#pos++;
        return this.#token('lbrace', c, start);
      case '}':
        this.#pos++;
        return this.#token('rbrace', c, start);
      case '"':
        return this.#token('quoted', this.#doubleQuoted(start), start);
      case "'":
        return this.#token('quoted', this.#singleQuoted(start), start);
      case '+':
        if (this.#lastKind === 'quoted') {
          this.#pos++;
          return this.#token('plus', c, start);
        }
        break;
      default:
        break;
    }
    return this.#token('word', this.#word(start), start);
  }

  #token(kind: TokenKind, value: string, offset: number): Token {
    this.#lastKind = kind;
    return { kind, value, offset };
  }

  #skipSpaceAndComments(): void {
    const text = this.#text;
    for (;;) {
      const c = text[this.#pos];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
        this.#pos++;
      } else if (c === '/' && text[this.#pos + 1] === '/') {
        const end = text.indexOf('\n', this.#pos);
        this.#pos = end === -1 ? text.length : end + 1;
      } else if (c === '/' && text[this.#pos + 1] === '*') {
        const end = text.indexOf('*/', this.#pos + 2);
        if (end === -1) throw this.error('unterminated comment', this.#pos);
        this.#pos = end + 2;
      } else {
        return;
      }
    }
  }

  /** An unquoted string runs until whitespace, `;`, `{`, `}` or the start of a comment. */
  #word(start: number): string {
    const text = this.#text;
    let i = start;
    for (; i < text.length; i++) {
      const c = text[i]!;
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ';' || c === '{' || c === '}') break;
      if (c === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) break;
      if (c === '"' || c === "'") {
        this.#notes.push({ code: 'quote-in-unquoted-string', offset: i, detail: c });
      }
    }
    this.#pos = i;
    return text.slice(start, i);
  }

  #singleQuoted(start: number): string {
    const end = this.#text.indexOf("'", start + 1);
    if (end === -1) throw this.error('unterminated single-quoted string', start);
    this.#pos = end + 1;
    return normaliseLineBreaks(this.#text.slice(start + 1, end));
  }

  #doubleQuoted(start: number): string {
    const text = this.#text;
    let i = start + 1;
    for (; i < text.length; i++) {
      const c = text[i];
      if (c === '\\') {
        const next = text[i + 1];
        if (next !== 'n' && next !== 't' && next !== '"' && next !== '\\') {
          this.#notes.push({ code: 'illegal-escape', offset: i, detail: next === undefined ? '' : next });
        }
        i++;
      } else if (c === '"') {
        break;
      }
    }
    if (i >= text.length) throw this.error('unterminated double-quoted string', start);
    this.#pos = i + 1;
    const raw = normaliseLineBreaks(text.slice(start + 1, i));
    return unescape(trimDoubleQuoted(raw, quoteColumn(text, start)));
  }
}

/** The column of the opening quote, 0-based, with tabs counted as 8 columns. */
function quoteColumn(text: string, quoteOffset: number): number {
  let column = 0;
  for (let i = text.lastIndexOf('\n', quoteOffset - 1) + 1; i < quoteOffset; i++) {
    column += text[i] === '\t' ? TAB_WIDTH : 1;
  }
  return column;
}

function normaliseLineBreaks(s: string): string {
  return s.includes('\r\n') ? s.replaceAll('\r\n', '\n') : s;
}

/**
 * RFC 7950 §6.1.3: whitespace before a line break is removed, and on each
 * following line, indentation is removed up to and including the column of
 * the opening quote. A tab examined for removal counts as 8 spaces, and any
 * part of it beyond that column is kept as spaces.
 */
export function trimDoubleQuoted(raw: string, quoteCol: number): string {
  if (!raw.includes('\n')) return raw;
  const lines = raw.split('\n');
  const limit = quoteCol + 1;
  for (let n = 0; n < lines.length; n++) {
    let line = lines[n]!;
    if (n < lines.length - 1) line = line.replace(/[ \t]+$/, '');
    if (n > 0) {
      let removed = 0;
      let i = 0;
      let kept = '';
      while (i < line.length && removed < limit) {
        const c = line[i];
        if (c === ' ') {
          removed++;
        } else if (c === '\t') {
          if (removed + TAB_WIDTH > limit) kept = ' '.repeat(removed + TAB_WIDTH - limit);
          removed += TAB_WIDTH;
        } else {
          break;
        }
        i++;
      }
      line = kept + line.slice(i);
    }
    lines[n] = line;
  }
  return lines.join('\n');
}

/** Replaces `\n`, `\t`, `\"` and `\\`. Any other backslash is kept as it is (and noted by the lexer). */
function unescape(s: string): string {
  if (!s.includes('\\')) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c !== '\\' || i + 1 >= s.length) {
      out += c;
      continue;
    }
    const next = s[i + 1]!;
    if (next === 'n') out += '\n';
    else if (next === 't') out += '\t';
    else if (next === '"' || next === '\\') out += next;
    else {
      out += c;
      continue;
    }
    i++;
  }
  return out;
}

/**
 * RFC 7950 §14 `yang-char`: tab, LF, CR, and Unicode scalar values from
 * U+0020 up, except the surrogate range, U+FDD0–U+FDEF and the two
 * noncharacters at the end of each plane.
 */
function checkCharacters(text: string, notes: LexicalNote[]): void {
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i)!;
    if (cp > 0xffff) i++;
    const ok =
      cp === 0x09 ||
      cp === 0x0a ||
      cp === 0x0d ||
      (cp >= 0x20 && cp <= 0xd7ff) ||
      (cp >= 0xe000 && cp <= 0xfdcf) ||
      (cp >= 0xfdf0 && cp <= 0xfffd) ||
      (cp >= 0x10000 && (cp & 0xfffe) !== 0xfffe);
    if (!ok) notes.push({ code: 'illegal-character', offset: i, detail: `U+${cp.toString(16).toUpperCase().padStart(4, '0')}` });
  }
}

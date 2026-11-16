/**
 * Statement parser (RFC 7950 §6.3):
 *
 *   statement = keyword [argument] (";" / "{" *statement "}")
 *   argument  = unquoted-string / quoted-string *("+" quoted-string)
 *
 * The parser knows nothing about which statements exist or where they may
 * appear. That is the grammar check's job (see ../grammar).
 */

import { YangSyntaxError } from '../errors.js';
import { LineIndex } from '../location.js';
import { Lexer, type LexicalNote, type Token } from './lexer.js';
import type { Statement } from './statement.js';

export interface ParseOptions {
  /** A name for the text, usually its file path. It appears in locations and error messages. */
  readonly source?: string;
}

export interface ParsedStatements {
  readonly statements: Statement[];
  /** Version-dependent lexical problems, for the grammar check to report. */
  readonly notes: LexicalNote[];
  readonly lines: LineIndex;
}

/** Deeper nesting than this is rejected, so hostile input can't exhaust the stack. Real modules stay well under 50. */
export const MAX_DEPTH = 500;

const KEYWORD = /^(?:([A-Za-z_][A-Za-z0-9_.-]*):)?[A-Za-z_][A-Za-z0-9_.-]*$/;

/** Decodes UTF-8 bytes, rejecting invalid sequences, and drops a byte-order mark. */
export function decodeText(input: string | Uint8Array, source?: string): string {
  if (typeof input === 'string') return input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(input);
  } catch (err) {
    const location = source === undefined ? { line: 1, column: 1, offset: 0 } : { source, line: 1, column: 1, offset: 0 };
    throw new YangSyntaxError('the text is not valid UTF-8', location, { cause: err });
  }
}

/** Parses every top-level statement in the text. Throws {@link YangSyntaxError} on unrecoverable syntax. */
export function parseStatements(text: string, options: ParseOptions = {}): ParsedStatements {
  const lines = new LineIndex(text, options.source);
  const notes: LexicalNote[] = [];
  const lexer = new Lexer(text, lines, notes);
  const statements: Statement[] = [];
  for (;;) {
    const token = lexer.next();
    if (token.kind === 'eof') break;
    statements.push(parseStatement(lexer, lines, token, 1));
  }
  return { statements, notes, lines };
}

function parseStatement(lexer: Lexer, lines: LineIndex, first: Token, depth: number): Statement {
  if (first.kind !== 'word') {
    throw lexer.error(first.kind === 'eof' ? 'unexpected end of input' : `expected a statement keyword, found ${describe(first)}`, first.offset);
  }
  const match = KEYWORD.exec(first.value);
  if (match === null) throw lexer.error(`'${first.value}' is not a valid statement keyword`, first.offset);

  let argument: string | undefined;
  let argumentOffset: number | undefined;
  let token = lexer.next();
  if (token.kind === 'word' || token.kind === 'quoted') {
    argument = token.value;
    argumentOffset = token.offset;
    if (token.kind === 'quoted') {
      while (lexer.peek().kind === 'plus') {
        const plus = lexer.next();
        const part = lexer.next();
        if (part.kind !== 'quoted') throw lexer.error("'+' must be followed by a quoted string", plus.offset);
        argument += part.value;
      }
    }
    token = lexer.next();
  }

  const substatements: Statement[] = [];
  if (token.kind === 'lbrace') {
    if (depth >= MAX_DEPTH) throw lexer.error(`statements are nested more than ${MAX_DEPTH} deep`, token.offset);
    for (;;) {
      const next = lexer.next();
      if (next.kind === 'rbrace') break;
      if (next.kind === 'eof') throw lexer.error(`'${first.value}' block is not closed: missing '}'`, token.offset);
      substatements.push(parseStatement(lexer, lines, next, depth + 1));
    }
  } else if (token.kind !== 'semicolon') {
    throw lexer.error(`expected ';' or '{' after '${first.value}'${argument === undefined ? '' : ' and its argument'}, found ${describe(token)}`, token.offset);
  }

  return {
    keyword: first.value,
    ...(match[1] === undefined ? {} : { prefix: match[1] }),
    ...(argument === undefined ? {} : { argument, argumentLocation: lines.locate(argumentOffset!) }),
    substatements,
    location: lines.locate(first.offset),
  };
}

function describe(token: Token): string {
  switch (token.kind) {
    case 'eof':
      return 'end of input';
    case 'word':
      return `'${token.value}'`;
    case 'quoted':
      return 'a quoted string';
    case 'plus':
    case 'semicolon':
    case 'lbrace':
    case 'rbrace':
      return `'${token.value}'`;
  }
}

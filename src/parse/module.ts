/**
 * The entry point for reading one YANG file: parse, then check the grammar.
 */

import { YangSyntaxError } from '../errors.js';
import { checkModule, declaredVersion } from '../grammar/check.js';
import type { YangVersion } from '../grammar/statements.js';
import type { Diagnostic } from '../location.js';
import { decodeText, parseStatements, type ParseOptions } from './parser.js';
import type { Statement } from './statement.js';
import { parseYin } from './yin.js';

export interface ParsedModule {
  /** The `module` or `submodule` statement. */
  readonly statement: Statement;
  /** The version the module declares; 1 when it has no `yang-version`. */
  readonly yangVersion: YangVersion;
  /**
   * Grammar problems: unknown or misplaced statements, wrong cardinality,
   * invalid arguments, version-dependent lexical errors. The statement tree
   * is complete whatever these say.
   */
  readonly diagnostics: Diagnostic[];
}

/**
 * Parses one YANG module or submodule file and checks it against the YANG
 * grammar for the version it declares.
 *
 * Throws {@link YangSyntaxError} when the text can't be read as statements
 * at all, or doesn't hold exactly one `module` or `submodule`. Everything
 * else is reported in {@link ParsedModule.diagnostics}.
 */
export function parseModule(input: string | Uint8Array, options: ParseOptions = {}): ParsedModule {
  const text = decodeText(input, options.source);
  const { statements, notes, lines } = parseStatements(text, options);
  const [first, second] = statements;
  if (first === undefined) {
    throw new YangSyntaxError('expected a module or submodule, found no statements', lines.locate(text.length));
  }
  if (first.keyword !== 'module' && first.keyword !== 'submodule') {
    throw new YangSyntaxError(`expected 'module' or 'submodule', found '${first.keyword}'`, first.location);
  }
  if (second !== undefined) {
    throw new YangSyntaxError(`only one ${first.keyword} is allowed per file, found '${second.keyword}' after it`, second.location);
  }
  return { statement: first, yangVersion: declaredVersion(first), diagnostics: checkModule(first, notes, lines) };
}

/** Module text as a {@link ModuleSource} returns it. */
export interface ModuleTextLike {
  readonly text: string | Uint8Array;
  readonly source?: string;
  readonly format?: 'yang' | 'yin';
}

/**
 * Parses module text in either syntax: YANG, or YIN (RFC 7950 §13) when the
 * format says so or the text starts with `<`.
 */
export function parseModuleText(text: ModuleTextLike): ParsedModule {
  const options = text.source === undefined ? {} : { source: text.source };
  return isYin(text) ? parseYin(text.text, options) : parseModule(text.text, options);
}

function isYin(text: ModuleTextLike): boolean {
  if (text.format !== undefined) return text.format === 'yin';
  const t = text.text;
  for (let i = 0; i < Math.min(t.length, 64); i++) {
    const c = typeof t === 'string' ? t.charCodeAt(i) : t[i]!;
    if (c === 0x3c) return true; // <
    if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d && c !== 0xfeff && c !== 0xef && c !== 0xbb && c !== 0xbf) return false;
  }
  return false;
}

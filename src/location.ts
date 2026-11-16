/**
 * Source positions and diagnostics. A leaf module: imports nothing.
 */

/** A position in a YANG source text. */
export interface SourceLocation {
  /** The name given to the text, usually a file path. Absent when none was given. */
  readonly source?: string;
  /** 1-based line number. CRLF and LF both end a line. */
  readonly line: number;
  /** 1-based column, counted in UTF-16 code units (as editors and LSP count them). */
  readonly column: number;
  /** 0-based offset into the text, in UTF-16 code units. */
  readonly offset: number;
}

export type Severity = 'error' | 'warning';

/** A problem found in a module that doesn't stop processing. */
export interface Diagnostic {
  readonly severity: Severity;
  /** Stable, machine-readable code, such as `unexpected-substatement`. */
  readonly code: string;
  readonly message: string;
  readonly location: SourceLocation;
}

/** Maps offsets to line and column. Built once per text. */
export class LineIndex {
  readonly #starts: number[] = [0];
  readonly #source: string | undefined;

  constructor(text: string, source?: string) {
    this.#source = source;
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 0x0a) this.#starts.push(i + 1);
    }
  }

  locate(offset: number): SourceLocation {
    let lo = 0;
    let hi = this.#starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.#starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    const loc = { line: lo + 1, column: offset - this.#starts[lo]! + 1, offset };
    return this.#source === undefined ? loc : { source: this.#source, ...loc };
  }
}

/** Formats a location as `source:line:column`, the form compilers and editors recognise. */
export function formatLocation(location: SourceLocation): string {
  return `${location.source ?? '<input>'}:${location.line}:${location.column}`;
}

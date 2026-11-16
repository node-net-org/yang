/**
 * Where decoded nodes are in the text they were read from, for the decoders'
 * `positions` option.
 *
 * A tree decoded with positions has a table of node → offset, and the text's
 * line starts. Line and column are worked out only when asked for. Offsets
 * are small integers in a Map, so trees decoded without positions pay
 * nothing, and trees built in code have no table at all.
 */

import { LineIndex, type SourceLocation } from '../location.js';
import type { DataTree, InstanceNode } from './tree.js';

/** Node offsets in one decoded text. */
export class PositionTable {
  readonly #offsets = new Map<InstanceNode, number>();
  readonly #lines: LineIndex;

  constructor(text: string) {
    this.#lines = new LineIndex(text);
  }

  set(node: InstanceNode, offset: number): void {
    this.#offsets.set(node, offset);
  }

  /** The position of an offset into the text. */
  at(offset: number): SourceLocation {
    return this.#lines.locate(offset);
  }

  /** The position of a node, or undefined if it wasn't read from the text. */
  of(node: InstanceNode): SourceLocation | undefined {
    const offset = this.#offsets.get(node);
    return offset === undefined ? undefined : this.#lines.locate(offset);
  }
}

const tables = new WeakMap<DataTree, PositionTable>();

/** Attaches a table to a tree being decoded. */
export function attachPositions(tree: DataTree, table: PositionTable): void {
  tables.set(tree, table);
}

/** The position table of a decoded tree, if it was decoded with positions. */
export function positionsOf(tree: DataTree): PositionTable | undefined {
  return tables.get(tree);
}

/**
 * Converts a code-point index into `text` to a UTF-16 index. parse-xml counts
 * error positions in code points; everything else here counts UTF-16 units.
 */
export function codePointToUtf16(text: string, index: number): number {
  let i = 0;
  for (let cp = 0; cp < index && i < text.length; cp++) {
    const c = text.charCodeAt(i);
    i += c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00 ? 2 : 1;
  }
  return i;
}

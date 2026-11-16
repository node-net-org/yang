/**
 * What a few schema nodes' statements said, kept for tree diagrams after a
 * compiled schema releases its statements. Internal: not exported from the
 * package.
 */

import type { SchemaNode } from './model.js';

export interface Written {
  /** A list's `key` argument, as written. */
  readonly key?: string;
  /** The `input` and `output` written in an rpc or action, in source order. */
  readonly io?: readonly ('input' | 'output')[];
  /** A `config` argument written on the node. */
  readonly config?: string;
}

/** Filled by the compiler for every schema it compiles, whether or not it keeps statements. */
export const written = new WeakMap<SchemaNode, Written>();

/**
 * Status references (RFC 7950 §7.21.2): a definition referring to one that
 * is less current than itself. Within a module a `current` definition MUST
 * NOT refer to a `deprecated` or `obsolete` one, and a `deprecated` one MUST
 * NOT refer to an `obsolete` one. Across modules it is allowed.
 *
 * A definition's effective status is the least current `status` written on
 * it or on any statement enclosing it, as libyang has it (RFC 7950 gives no
 * inheritance rule; pyang compares only the statuses written on the two
 * definitions).
 */

import type { Status } from './model.js';

const RANK: Readonly<Record<Status, number>> = { current: 0, deprecated: 1, obsolete: 2 };

/** The less current of two statuses. */
export function lessCurrent(a: Status, b: Status): Status {
  return RANK[a] >= RANK[b] ? a : b;
}

/** A schema node's effective status: the least current of its own and its ancestors'. */
export function nodeStatus(node: { readonly status: Status; readonly parent?: { readonly status: Status; readonly parent?: unknown } | undefined }): Status {
  let status: Status = 'current';
  for (let n: typeof node | undefined = node; n !== undefined; n = n.parent as typeof node | undefined) {
    status = lessCurrent(status, n.status);
    if (status === 'obsolete') break;
  }
  return status;
}

/** One side of a status reference. */
export interface StatusParty {
  readonly status: Status;
  /** The name of the module it belongs to (a submodule counts as its module). */
  readonly module: string;
  /** What it is, for messages: `leaf 'a'`, `typedef 'dt'`. */
  readonly describe: string;
}

export type StatusReferenceCode = 'status-reference' | 'status-reference-other-module';

/**
 * The warning for `from` referring to `to`, or undefined when `to` is at
 * least as current as `from`. `status-reference` is a reference within one
 * module, which RFC 7950 forbids; `status-reference-other-module` is one
 * into another module, which it allows.
 */
export function statusReference(from: StatusParty, to: StatusParty): { code: StatusReferenceCode; message: string } | undefined {
  if (RANK[to.status] <= RANK[from.status]) return undefined;
  const what = `${from.status} ${from.describe} refers to ${to.status} ${to.describe}`;
  return from.module === to.module
    ? { code: 'status-reference', message: `${what} of the same module, ${to.module}, which RFC 7950 §7.21.2 forbids` }
    : { code: 'status-reference-other-module', message: `${what} of module ${to.module}` };
}

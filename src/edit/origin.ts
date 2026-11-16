/**
 * The NMDA `origin` annotation (RFC 8342 §7.4, module ietf-origin): where
 * a configuration node in `<operational>` came from. A node without one of
 * its own has its parent's.
 */

import { ORIGIN_NS } from '../data/build.js';
import { formatJson, scalarText } from '../data/lexical.js';
import { DataTree, type Annotation, type InstanceNode } from '../data/tree.js';
import type { Identity } from '../schema/model.js';

/** An origin: the identity when the schema defines the annotation, the text as written otherwise. */
export type Origin = Identity | string;

/** Whether an annotation is `or:origin`, known by its namespace or, built by hand or from JSON without one, its module. */
export function isOriginAnnotation(a: Annotation): boolean {
  return a.name === 'origin' && (a.namespace === ORIGIN_NS || (a.namespace === undefined && a.module === 'ietf-origin'));
}

/** The node's own origin annotation, if it has one. */
export function ownOrigin(node: InstanceNode): Annotation | undefined {
  return node.annotations.find(isOriginAnnotation);
}

/** The origin annotation that applies to a node: its own, or its nearest ancestor's. */
export function originSource(node: InstanceNode): Annotation | undefined {
  for (let n: InstanceNode | undefined = node; n !== undefined; n = n.parent === undefined || n.parent instanceof DataTree ? undefined : n.parent) {
    const own = ownOrigin(n);
    if (own !== undefined) return own;
  }
  return undefined;
}

/** An origin annotation's value. */
export function originValue(a: Annotation): Origin {
  if (typeof a.value === 'string') return a.value;
  if (a.value.type.builtin === 'identityref') return a.value.value as Identity;
  return scalarText(formatJson(a.value));
}

/**
 * A node's effective origin in `<operational>` (RFC 8342 §7.4): its own
 * `or:origin`, otherwise its nearest ancestor's, otherwise undefined.
 * The identity when the schema has the ietf-origin module, so the
 * annotation is typed; the text as written otherwise.
 *
 * For `<get-data>`'s `origin-filter` (RFC 8526 §3.1.1), a node matches a
 * filter identity `f` when its origin `o` is `f` or derived from it:
 * `o === f || f.derived.has(o)`. RFC 8526 treats a configuration node
 * with no origin as `or:unknown`.
 */
export function effectiveOrigin(node: InstanceNode): Origin | undefined {
  const source = originSource(node);
  return source === undefined ? undefined : originValue(source);
}

/**
 * Whether two origins are the same identity: compared by module and
 * identity name, not by the prefix written, so trees decoded with separate
 * compiles compare equal. Text (an untyped annotation) is compared with an
 * identity's `module:name` form.
 */
export function sameOrigin(a: Origin | undefined, b: Origin | undefined): boolean {
  return originKey(a) === originKey(b);
}

function originKey(o: Origin | undefined): string | undefined {
  if (o === undefined || typeof o === 'string') return o;
  return `${o.module.name}:${o.name}`;
}
